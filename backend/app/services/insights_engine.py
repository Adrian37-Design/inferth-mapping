from datetime import datetime, timedelta
import math
from typing import List, Dict, Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, and_, or_, desc

from app.models import Position, Device, User, Insight, InsightAction, DriverScore, Geofence
from app.services.track import analyze_track, TRACK_STOP_KMH
from app.services.data_guardrails import haversine_distance_km
from app.config import settings

# Plain language map for common DTC codes (No technical jargon for drivers)
DTC_PLAIN_LANGUAGE = {
    "P0300": {"issue": "The engine is misfiring or sputtering.", "action": "Avoid accelerating hard and have the spark plugs or ignition coils checked."},
    "P0301": {"issue": "Cylinder 1 is misfiring.", "action": "Drive gently to a safe place and schedule a mechanic inspection."},
    "P0302": {"issue": "Cylinder 2 is misfiring.", "action": "Drive gently to a safe place and schedule a mechanic inspection."},
    "P0303": {"issue": "Cylinder 3 is misfiring.", "action": "Drive gently to a safe place and schedule a mechanic inspection."},
    "P0304": {"issue": "Cylinder 4 is misfiring.", "action": "Drive gently to a safe place and schedule a mechanic inspection."},
    "P0420": {"issue": "The exhaust emissions system is running below normal efficiency.", "action": "You can finish your trip, but notify maintenance today."},
    "P0171": {"issue": "The engine is getting too much air or not enough fuel.", "action": "Check that the fuel cap is tight and report to your manager."},
    "P0115": {"issue": "The engine temperature sensor is reporting abnormal readings.", "action": "Keep an eye on the temperature gauge and do not let the engine overheat."},
    "P0500": {"issue": "Vehicle speed sensor issue detected.", "action": "Drive cautiously and have the wheel sensors inspected."},
    "DEFAULT": {"issue": "An engine diagnostic warning has been flagged.", "action": "Pull over when safe, check dashboard lights, and notify your manager."}
}

def translate_dtc_plain(code: str) -> Dict[str, str]:
    clean = str(code).upper().strip()
    return DTC_PLAIN_LANGUAGE.get(clean, DTC_PLAIN_LANGUAGE["DEFAULT"])

def compute_driver_score(harsh_braking: int, harsh_accel: int, idling_minutes: float, speeding: int, night_trips: int) -> int:
    """
    Driver score formula: Start at 100, minus 2 per harsh brake,
    minus 1 per harsh accel, minus 1 per 10 mins idling,
    minus 5 per speeding event, minus 10 per night trip. Minimum 0.
    """
    idle_penalty = math.floor(idling_minutes / 10.0)
    deductions = (2 * harsh_braking) + (1 * harsh_accel) + (1 * idle_penalty) + (5 * speeding) + (10 * night_trips)
    score = 100 - deductions
    return max(0, min(100, score))


async def get_tenant_devices(db: AsyncSession, tenant_id: int, user: Optional[User] = None) -> List[Device]:
    stmt = select(Device)
    if user and (user.role == "super_admin" or (user.tenant_id == 1 and user.role == "admin")):
        # The platform administrator sees all, or can filter by one tenant
        if tenant_id and tenant_id != 1:
            stmt = stmt.where(Device.tenant_id == tenant_id)
    else:
        stmt = stmt.where(Device.tenant_id == tenant_id)
    result = await db.execute(stmt)
    return result.scalars().all()


async def get_driver_devices(db: AsyncSession, user: User) -> List[Device]:
    """Find device(s) assigned to a driver."""
    stmt = select(Device).where(Device.tenant_id == user.tenant_id)
    result = await db.execute(stmt)
    all_devs = result.scalars().all()
    
    assigned = []
    # Check accessible_assets in user profile
    assets = user.accessible_assets or []
    if "*" in assets:
        return all_devs
    
    asset_ids = {str(a) for a in assets}
    for d in all_devs:
        if str(d.id) in asset_ids or (d.driver_name and user.email and d.driver_name.lower().strip() == user.email.lower().strip()):
            assigned.append(d)
        elif d.driver_name and getattr(user, 'phone', None) and d.driver_name.strip() == user.phone.strip():
            assigned.append(d)
            
    # Fallback: if driver has no explicit match but devices exist, assign first device so they can view their card
    if not assigned and all_devs:
        assigned = [all_devs[0]]
        
    return assigned


# -------------------------------------------------------------------------
# Dynamic Country Fuel Pricing Engine (Southern Africa Telematics Benchmark)
# -------------------------------------------------------------------------

COUNTRY_FUEL_DATA: Dict[str, Dict[str, Any]] = {
    "ZW": {"name": "Zimbabwe", "currency": "USD", "petrol": 2.05, "diesel": 2.04},      # ZERA official maximum ceiling
    "ZA": {"name": "South Africa", "currency": "USD", "petrol": 1.66, "diesel": 1.76},  # CEF / DMPR inland benchmark (R30.24 & R32.09)
    "ZM": {"name": "Zambia", "currency": "USD", "petrol": 1.25, "diesel": 1.30},        # ERB national uniform pump benchmark (K33.06 & K34.45)
    "BW": {"name": "Botswana", "currency": "USD", "petrol": 1.45, "diesel": 1.75},      # BERA regulated retail benchmark (P19.75 & P23.76)
    "MZ": {"name": "Mozambique", "currency": "USD", "petrol": 1.47, "diesel": 1.82},    # ARENE regulated benchmark (93.69 MZN & 116.25 MZN)
    "NA": {"name": "Namibia", "currency": "USD", "petrol": 1.28, "diesel": 1.31},       # MME national benchmark
}

def detect_country_from_coords(lat: Optional[float], lng: Optional[float]) -> str:
    """
    Detect country ISO code from tracker coordinates using regional bounding boxes.
    Defaults to 'ZW' (Zimbabwe) if coordinates are outside or not yet available.
    """
    if lat is None or lng is None:
        return "ZW"
    
    # Zimbabwe: lat [-22.5, -15.5], lng [25.0, 33.5]
    if -22.5 <= lat <= -15.5 and 25.0 <= lng <= 33.5:
        return "ZW"
    
    # South Africa: lat [-35.0, -22.0], lng [16.0, 33.0]
    if -35.0 <= lat <= -22.0 and 16.0 <= lng <= 33.0:
        return "ZA"
        
    # Zambia: lat [-18.1, -8.0], lng [22.0, 33.7]
    if -18.1 <= lat <= -8.0 and 22.0 <= lng <= 33.7:
        return "ZM"

    # Botswana: lat [-27.0, -17.5], lng [20.0, 29.5]
    if -27.0 <= lat <= -17.5 and 20.0 <= lng <= 29.5:
        return "BW"

    # Mozambique: lat [-27.0, -10.5], lng [30.0, 41.0]
    if -27.0 <= lat <= -10.5 and 30.0 <= lng <= 41.0:
        return "MZ"

    # Namibia: lat [-29.0, -17.0], lng [11.5, 25.5]
    if -29.0 <= lat <= -17.0 and 11.5 <= lng <= 25.5:
        return "NA"

    return "ZW"

def get_fuel_price_info(dev: Optional[Any], lat: Optional[float] = None, lng: Optional[float] = None) -> Dict[str, Any]:
    """
    Returns fuel pricing based on vehicle's selected fuel type (petrol or diesel)
    and the country detected from the tracker's current coordinates.
    """
    country_code = detect_country_from_coords(lat, lng)
    country_info = COUNTRY_FUEL_DATA.get(country_code, COUNTRY_FUEL_DATA["ZW"])
    
    # Vehicle fuel type selected by manager/viewer: 'petrol' or 'diesel' (default 'diesel')
    fuel_type = "diesel"
    if dev:
        meta = getattr(dev, "device_metadata", {}) or {}
        fuel_type = (meta.get("fuel_type") or getattr(dev, "fuel_type", "diesel") or "diesel").lower().strip()
        if fuel_type not in ["petrol", "diesel"]:
            fuel_type = "diesel"
            
    unit_price = country_info["petrol"] if fuel_type == "petrol" else country_info["diesel"]
    
    return {
        "country_code": country_code,
        "country_name": country_info["name"],
        "currency": country_info["currency"],
        "fuel_type": fuel_type,
        "unit_price": unit_price,
        "petrol_price": country_info["petrol"],
        "diesel_price": country_info["diesel"]
    }


# ---------------------------------------------------------------------------
# Real telemetry analysis
# ---------------------------------------------------------------------------
# Every number below comes from the same cleaned track the Route History strip
# draws (app.services.track.analyze_track), so the Insights tab can never quote
# a distance, a speed or a moving time the map would contradict. Nothing is
# clamped to a baseline: when the fixes carry no evidence for a metric it is
# None, and the UI shows a dash instead of an invented figure.

SPEED_LIMIT_KMH = 120.0                 # highway ceiling used for speeding
NIGHT_START_HOUR = 22
NIGHT_END_HOUR = 5
LOCAL_TZ_OFFSET = timedelta(hours=2)    # Zimbabwe (CAT), same as Route History
PERF_MAX_LEG_SECONDS = 600.0            # a longer hop proves nothing about time
ONLINE_WINDOW_HOURS = 48                # "monitored" = reported this recently


async def load_telemetry(db: AsyncSession, device_ids, start) -> List[Any]:
    """Positions for the window, projected to the columns the engine reads.

    The `raw` JSON blob is the bulk of a position row and a truck reporting
    every three seconds produces ~80k rows a week. Loading the full ORM row for
    each one is what made this endpoint time out for real fleets; only the two
    raw keys the analysis consumes are projected instead.
    """
    stmt = (
        select(
            Position.device_id,
            Position.latitude,
            Position.longitude,
            Position.speed,
            Position.timestamp,
            Position.ignition,
            Position.fuel_level,
            Position.odometer,
            Position.engine_temp,
            Position.check_engine_mil,
            Position.dtc_fault_codes,
            Position.raw["satellites"].as_string().label("sats"),
            Position.raw["fuel_consumption"].as_string().label("fuel_rate"),
        )
        .where(Position.device_id.in_(device_ids), Position.timestamp >= start)
        .order_by(Position.device_id, Position.timestamp.asc())
    )
    result = await db.execute(stmt)
    return result.all()


def _is_coarse_fix(sats) -> bool:
    """Cell-tower / no-fix rows (satellites 0 or 200+) are 500 m - 8 km off and
    must never be read as travel."""
    try:
        s = int(sats)
    except (TypeError, ValueError):
        return False
    return s == 0 or s >= 200


def _secs(a, b) -> float:
    try:
        return (b - a).total_seconds()
    except Exception:
        return 0.0


def _day_metrics(rows) -> Dict[str, Any]:
    """Analyse one device's rows for one local day."""
    fixes = []
    ign = {}
    fuel_rate = None
    last_gnss = None
    last_lat = last_lng = None

    for r in rows:
        ign[r.timestamp] = r.ignition
        try:
            rate = float(r.fuel_rate)
            if 0.0 < rate < 100.0:
                fuel_rate = rate
        except (TypeError, ValueError, AttributeError):
            pass
        if r.latitude is None or r.longitude is None:
            continue
        if abs(r.latitude) < 0.0001 or abs(r.longitude) < 0.0001:
            continue
        last_lat, last_lng = r.latitude, r.longitude
        if _is_coarse_fix(r.sats):
            if last_gnss is None:
                continue
            fixes.append({"lat": last_gnss[0], "lng": last_gnss[1],
                          "timestamp": r.timestamp, "speed": 0.0})
        else:
            last_gnss = (r.latitude, r.longitude)
            fixes.append({"lat": r.latitude, "lng": r.longitude,
                          "timestamp": r.timestamp,
                          "speed": min(max(0.0, r.speed or 0.0), 200.0)})

    track = analyze_track(fixes)
    pts = track["points"]

    drive_s = idle_s = speeding_s = 0.0
    speeding = harsh = 0
    over = False
    prev = None
    for p in pts:
        if prev is not None and not p["break"]:
            dt = _secs(prev["timestamp"], p["timestamp"])
            if 0 < dt <= PERF_MAX_LEG_SECONDS:
                if p["speed"] > TRACK_STOP_KMH:
                    drive_s += dt
                elif ign.get(p["timestamp"]):
                    idle_s += dt
                if p["speed"] > SPEED_LIMIT_KMH:
                    speeding_s += dt
            if 0 < dt <= 15:
                dv = (p["speed"] or 0.0) - (prev["speed"] or 0.0)
                if dv / dt <= -12.0:
                    harsh += 1
        if p["break"]:
            over = False
        elif p["speed"] > SPEED_LIMIT_KMH:
            if not over:
                speeding += 1
            over = True
        else:
            over = False
        prev = p

    night_trips = 0
    night_km = 0.0
    night_start = night_end = None
    for seg in track["segments"]:
        if seg["kind"] != "trip" or not seg["points"]:
            continue
        ts = seg["points"][0]["timestamp"]
        if ts.hour >= NIGHT_START_HOUR or ts.hour < NIGHT_END_HOUR:
            night_trips += 1
            night_km += seg["distance_km"]
            if night_start is None:
                night_start = ts
            night_end = seg["points"][-1]["timestamp"]

    # Fuel level only exists on vehicles that report a probe. A drop is real
    # only when the unit was stationary, the engine was off and it happened
    # slowly enough to be a siphon rather than a sender glitch.
    drops = []
    prev_fuel = None
    for r in rows:
        if r.fuel_level is None:
            continue
        if prev_fuel is not None:
            f0, t0, ign0 = prev_fuel
            drop = f0 - r.fuel_level
            dt_min = _secs(t0, r.timestamp) / 60.0
            stopped = (r.speed or 0.0) < 1.0
            engine_off = (ign0 is False) or (r.ignition is False)
            if drop >= 15.0 and stopped and engine_off and dt_min >= 10.0:
                drops.append({"liters": round(drop, 1), "at": r.timestamp,
                              "lat": r.latitude, "lng": r.longitude})
        prev_fuel = (r.fuel_level, r.timestamp, r.ignition)

    return {
        "distance_km": track["distance_km"],
        "drive_s": drive_s,
        "idle_s": idle_s,
        "speeding_events": speeding,
        "speeding_s": speeding_s,
        "harsh_brakes": harsh,
        "max_speed_kmh": track["max_speed_kmh"],
        "night_trips": night_trips,
        "night_km": round(night_km, 1),
        "night_start": night_start,
        "night_end": night_end,
        "fuel_rate": fuel_rate,
        "fuel_drops": drops,
        "first_ts": rows[0].timestamp if rows else None,
        "last_ts": rows[-1].timestamp if rows else None,
        "last_lat": last_lat,
        "last_lng": last_lng,
    }


def _blank_metrics() -> Dict[str, Any]:
    return {
        "distance_km": 0.0, "drive_s": 0.0, "idle_s": 0.0,
        "speeding_events": 0, "speeding_s": 0.0, "harsh_brakes": 0,
        "max_speed_kmh": 0, "night_trips": 0, "night_km": 0.0,
        "night_start": None, "night_end": None,
        "fuel_rate": None, "fuel_drops": [],
        "first_ts": None, "last_ts": None, "last_lat": None, "last_lng": None,
        "odometer": None, "engine_temp": None, "dtc": None, "mil": False,
        "days_active": 0, "drive_hours": 0.0, "idle_minutes": 0.0,
    }


def analyse_devices(rows) -> Dict[int, Dict[str, Any]]:
    """device_id -> metrics for the whole window, built day by day.

    Analysing per local day keeps each day's totals identical to what Route
    History shows for that day, instead of a week-long scan smoothing two
    days' fixes into one track.
    """
    by_day: Dict[Any, List[Any]] = {}
    odometers: Dict[int, float] = {}
    temps: Dict[int, float] = {}
    dtcs: Dict[int, Any] = {}
    mildren: Dict[int, bool] = {}

    for r in rows:
        if r.timestamp is None:
            continue
        day = (r.timestamp + LOCAL_TZ_OFFSET).date()
        by_day.setdefault((r.device_id, day), []).append(r)
        if r.odometer is not None and r.odometer > 0:
            odometers[r.device_id] = max(odometers.get(r.device_id, 0.0), r.odometer)
        if r.engine_temp is not None:
            temps[r.device_id] = max(temps.get(r.device_id, 0.0), r.engine_temp)
        if r.dtc_fault_codes:
            dtcs[r.device_id] = r.dtc_fault_codes
        if r.check_engine_mil:
            mildren[r.device_id] = True

    out: Dict[int, Dict[str, Any]] = {}
    for (device_id, _day), day_rows in by_day.items():
        m = _day_metrics(day_rows)
        agg = out.setdefault(device_id, _blank_metrics())
        agg["days_active"] += 1
        agg["distance_km"] = round(agg["distance_km"] + m["distance_km"], 3)
        agg["drive_s"] += m["drive_s"]
        agg["idle_s"] += m["idle_s"]
        agg["speeding_events"] += m["speeding_events"]
        agg["speeding_s"] += m["speeding_s"]
        agg["harsh_brakes"] += m["harsh_brakes"]
        agg["max_speed_kmh"] = max(agg["max_speed_kmh"], m["max_speed_kmh"])
        agg["night_trips"] += m["night_trips"]
        agg["night_km"] = round(agg["night_km"] + m["night_km"], 1)
        if m["night_start"] and (agg["night_start"] is None or m["night_start"] < agg["night_start"]):
            agg["night_start"] = m["night_start"]
        if m["night_end"] and (agg["night_end"] is None or m["night_end"] > agg["night_end"]):
            agg["night_end"] = m["night_end"]
        if m["fuel_rate"] is not None:
            rates = agg.setdefault("_fuel_rates", [])
            rates.append(m["fuel_rate"])
        agg["fuel_drops"] = agg["fuel_drops"] + m["fuel_drops"]
        if agg["first_ts"] is None or (m["first_ts"] and m["first_ts"] < agg["first_ts"]):
            agg["first_ts"] = m["first_ts"]
        if m["last_ts"] and (agg["last_ts"] is None or m["last_ts"] > agg["last_ts"]):
            agg["last_ts"] = m["last_ts"]
            agg["last_lat"] = m["last_lat"]
            agg["last_lng"] = m["last_lng"]

    for device_id, agg in out.items():
        agg["odometer"] = odometers.get(device_id)
        agg["engine_temp"] = temps.get(device_id)
        agg["dtc"] = dtcs.get(device_id)
        agg["mil"] = mildren.get(device_id, False)
        rates = agg.pop("_fuel_rates", [])
        agg["fuel_rate"] = round(sum(rates) / len(rates), 1) if rates else None
        agg["drive_hours"] = round(agg["drive_s"] / 3600.0, 2)
        agg["idle_minutes"] = round(agg["idle_s"] / 60.0, 1)
    return out


def _device_score(m: Dict[str, Any]) -> int:
    return compute_driver_score(
        m["harsh_brakes"], 0, m["idle_s"] / 60.0,
        m["speeding_events"], m["night_trips"],
    )


def _utcnow():
    return datetime.utcnow()


async def generate_manager_insights(db: AsyncSession, tenant_id: int, user: User) -> Dict[str, Any]:
    fuel_price = getattr(settings, "FUEL_PRICE_USD", 2.04)
    devices = await get_tenant_devices(db, tenant_id, user)
    device_map = {d.id: d for d in devices}
    device_ids = list(device_map.keys())
    now = _utcnow()

    metrics: Dict[int, Dict[str, Any]] = {}
    if device_ids:
        metrics = analyse_devices(await load_telemetry(db, device_ids, now - timedelta(days=7)))

    # 1. Insights already raised and persisted for this company
    db_insights_stmt = (
        select(Insight)
        .where(
            and_(
                Insight.tenant_id == tenant_id,
                Insight.role_target == "manager",
                Insight.status == "open"
            )
        )
        .order_by(desc(Insight.created_at))
    )
    persisted_insights = (await db.execute(db_insights_stmt)).scalars().all()

    cards: List[Dict[str, Any]] = []
    seen: set = set()
    current_utc = _utcnow()

    for pi in persisted_insights:
        extra = pi.extra_data or {}
        expires = extra.get("expires_at")
        if expires:
            try:
                exp_dt = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
                if exp_dt.tzinfo is None:
                    if current_utc >= exp_dt:
                        continue
                else:
                    from datetime import timezone
                    if datetime.now(timezone.utc) >= exp_dt:
                        continue
            except Exception:
                pass

        dev = device_map.get(pi.device_id)
        cards.append({
            "id": pi.id,
            "category": pi.category,
            "severity": pi.severity,
            "title": pi.title,
            "description": pi.description,
            "vehicle_name": dev.name if dev else (extra.get("vehicle_name") or f"Vehicle #{pi.device_id}"),
            "device_id": pi.device_id,
            "driver_name": (dev.driver_name if dev and dev.driver_name else None) or pi.driver_name or "Assigned Driver",
            "metric_value": pi.metric_value,
            "money_impact": pi.money_impact,
            "created_at": pi.created_at.isoformat() if pi.created_at else None,
            "extra_data": extra,
            "actions": extra.get("actions", []),
            "source": "persisted",
        })
        seen.add((pi.category, pi.device_id))

    total_money_lost = 0.0
    urgent_actions = 0
    for c in cards:
        if c.get("money_impact"):
            total_money_lost += float(c["money_impact"])
        if c.get("severity") == "red":
            urgent_actions += 1
    red_devices = {c["device_id"] for c in cards if c.get("severity") == "red"}

    # 2. Live evidence from the last seven days of fixes
    fleet_rates = [m["fuel_rate"] for m in metrics.values() if m["fuel_rate"]]
    fleet_avg_rate = round(sum(fleet_rates) / len(fleet_rates), 1) if fleet_rates else None
    scored = []

    for d_id, m in metrics.items():
        dev = device_map.get(d_id)
        dev_name = dev.name if dev else f"Vehicle #{d_id}"
        driver = (dev.driver_name if dev and dev.driver_name else None) or "Assigned Driver"
        pricing_default = get_fuel_price_info(dev, m["last_lat"], m["last_lng"])

        # Fuel level dropped 15 L+ while stationary with the engine off
        if ("fuel_siphoning", d_id) not in seen and m["fuel_drops"]:
            drop = max(m["fuel_drops"], key=lambda x: x["liters"])
            pricing = get_fuel_price_info(dev, drop["lat"], drop["lng"])
            loss = round(drop["liters"] * pricing["unit_price"], 2)
            total_money_lost += loss
            urgent_actions += 1
            red_devices.add(d_id)
            cards.append({
                "id": f"live-siphon-{d_id}",
                "category": "fuel_siphoning",
                "severity": "red",
                "title": "Possible Fuel Siphoning Detected",
                "description": (
                    f"Measured fuel level fell {drop['liters']:.1f} L while the engine was off "
                    f"and the vehicle was stationary on {drop['at'].strftime('%d %b %H:%M')}."
                ),
                "vehicle_name": dev_name,
                "device_id": d_id,
                "driver_name": driver,
                "metric_value": f"-{drop['liters']:.1f} L",
                "money_impact": loss,
                "created_at": drop["at"].isoformat(),
                "extra_data": {
                    "lat": drop["lat"],
                    "lng": drop["lng"],
                    "fuel_dropped": drop["liters"],
                    "fuel_price": pricing["unit_price"],
                    "fuel_type": pricing["fuel_type"],
                    "country_name": pricing["country_name"],
                    "country_code": pricing["country_code"],
                    "time": drop["at"].strftime("%Y-%m-%d %H:%M"),
                    "actions": ["view_fuel_graph", "message_driver", "mark_resolved"],
                },
                "actions": ["view_fuel_graph", "message_driver", "mark_resolved"],
                "source": "live",
            })
            seen.add(("fuel_siphoning", d_id))

        # Vehicle drove outside permitted hours
        if ("unauthorized_night_trip", d_id) not in seen and m["night_trips"] > 0 and m["night_km"] >= 1.0:
            fuel_est = round(m["night_km"] * 0.12, 1)
            loss = round(fuel_est * pricing_default["unit_price"], 2)
            total_money_lost += loss
            urgent_actions += 1
            red_devices.add(d_id)
            start_txt = m["night_start"].strftime("%d %b %H:%M") if m["night_start"] else "outside hours"
            end_txt = m["night_end"].strftime("%H:%M") if m["night_end"] else ""
            cards.append({
                "id": f"live-night-{d_id}",
                "category": "unauthorized_night_trip",
                "severity": "red",
                "title": "Unauthorized Night Trip",
                "description": (
                    f"{m['night_km']:.1f} km over {m['night_trips']} trip(s) recorded between "
                    f"{start_txt} and {end_txt}, outside permitted operating hours."
                ),
                "vehicle_name": dev_name,
                "device_id": d_id,
                "driver_name": driver,
                "metric_value": f"{m['night_km']:.1f} km ({fuel_est} L est.)",
                "money_impact": loss,
                "created_at": m["night_start"].isoformat() if m["night_start"] else now.isoformat(),
                "extra_data": {
                    "start_time": start_txt,
                    "end_time": end_txt,
                    "distance_km": m["night_km"],
                    "fuel_used_l": fuel_est,
                    "fuel_price": pricing_default["unit_price"],
                    "fuel_type": pricing_default["fuel_type"],
                    "country_name": pricing_default["country_name"],
                    "lat": m["last_lat"],
                    "lng": m["last_lng"],
                    "actions": ["view_trip_replay", "call_driver"],
                },
                "actions": ["view_trip_replay", "call_driver"],
                "source": "live",
            })
            seen.add(("unauthorized_night_trip", d_id))

        # Telemetry-reported fuel economy far above the fleet's average
        if ("driver_costing_fuel", d_id) not in seen and m["fuel_rate"] and fleet_avg_rate and m["distance_km"] > 0:
            if m["fuel_rate"] > fleet_avg_rate * 1.20:
                excess_l = round((m["fuel_rate"] - fleet_avg_rate) * m["distance_km"] / 100.0, 1)
                impact = round(excess_l * pricing_default["unit_price"], 2)
                total_money_lost += impact
                cards.append({
                    "id": f"live-cost-{d_id}",
                    "category": "driver_costing_fuel",
                    "severity": "orange",
                    "title": "High Fuel Consumption Pattern",
                    "description": (
                        f"Telemetry reports {m['fuel_rate']:.1f} L/100km over {m['distance_km']:.1f} km, "
                        f"{round((m['fuel_rate'] - fleet_avg_rate) / fleet_avg_rate * 100)}% above the "
                        f"fleet average of {fleet_avg_rate:.1f} L/100km."
                    ),
                    "vehicle_name": dev_name,
                    "device_id": d_id,
                    "driver_name": driver,
                    "metric_value": f"{m['fuel_rate']:.1f} vs {fleet_avg_rate:.1f} L/100km",
                    "money_impact": impact,
                    "created_at": now.isoformat(),
                    "extra_data": {
                        "driver_l100km": m["fuel_rate"],
                        "fleet_avg_l100km": fleet_avg_rate,
                        "excess_litres": excess_l,
                        "distance_km": m["distance_km"],
                        "fuel_price": pricing_default["unit_price"],
                        "fuel_type": pricing_default["fuel_type"],
                        "country_name": pricing_default["country_name"],
                        "actions": ["coach_driver", "check_vehicle"],
                    },
                    "actions": ["coach_driver", "check_vehicle"],
                    "source": "live",
                })
                seen.add(("driver_costing_fuel", d_id))

        # Scheduled maintenance, from the odometer the unit actually reports
        if ("service_due_soon", d_id) not in seen and m["odometer"]:
            km_since = round(m["odometer"] % 10000, 1)
            hot = m["engine_temp"] if m["engine_temp"] and m["engine_temp"] > 100 else None
            if km_since > 9500 or hot:
                per_day = m["distance_km"] / m["days_active"] if m["days_active"] else 0.0
                days_left = int(math.ceil((10000 - km_since) / per_day)) if per_day > 0 and km_since <= 10000 else None
                cards.append({
                    "id": f"live-service-{d_id}",
                    "category": "service_due_soon",
                    "severity": "orange",
                    "title": "Scheduled Maintenance Due Soon",
                    "description": (
                        f"{km_since:,.0f} of the 10,000 km service interval used"
                        + (f"; engine temperature {hot:.0f}°C." if hot else ".")
                    ),
                    "vehicle_name": dev_name,
                    "device_id": d_id,
                    "driver_name": driver,
                    "metric_value": f"{km_since:,.0f} / 10,000 km",
                    "money_impact": None,
                    "created_at": now.isoformat(),
                    "extra_data": {
                        "km_since_service": km_since,
                        "odometer_km": m["odometer"],
                        "days_left": days_left,
                        "actions": ["schedule_service", "assign_mechanic"],
                    },
                    "actions": ["schedule_service", "assign_mechanic"],
                    "source": "live",
                })
                seen.add(("service_due_soon", d_id))

        if m["distance_km"] > 0:
            scored.append({
                "device_id": d_id,
                "vehicle_name": dev_name,
                "driver_name": driver,
                "score": _device_score(m),
                "distance_km": m["distance_km"],
                "speeding_events": m["speeding_events"],
                "harsh_brakes": m["harsh_brakes"],
            })

    if scored and ("best_driver_week", 0) not in seen:
        best = max(scored, key=lambda x: (x["score"], x["distance_km"]))
        cards.append({
            "id": f"live-best-{best['device_id']}",
            "category": "best_driver_week",
            "severity": "blue",
            "title": "Top Driver of the Week",
            "description": (
                f"{best['driver_name']} scored {best['score']}/100 over {best['distance_km']:.1f} km "
                f"with {best['speeding_events']} speeding and {best['harsh_brakes']} harsh-brake event(s)."
            ),
            "vehicle_name": best["vehicle_name"],
            "device_id": best["device_id"],
            "driver_name": best["driver_name"],
            "metric_value": f"{best['score']}/100",
            "money_impact": None,
            "created_at": now.isoformat(),
            "extra_data": {
                "score": best["score"],
                "distance_km": best["distance_km"],
                "actions": ["send_bonus_praise"],
            },
            "actions": ["send_bonus_praise"],
            "source": "live",
        })

    # Fleet health = share of vehicles that reported in the last 48h and have
    # no open red exception. No devices reporting means no figure at all.
    monitored = [
        d_id for d_id, m in metrics.items()
        if m["last_ts"] is not None and _secs(m["last_ts"], now) <= ONLINE_WINDOW_HOURS * 3600
    ]
    if monitored:
        healthy = [d for d in monitored if d not in red_devices]
        fleet_health = round(100.0 * len(healthy) / len(monitored), 1)
    else:
        fleet_health = None

    primary_country = "ZW"
    primary_fuel_type = "diesel"
    regions = set()
    for d in devices:
        m = metrics.get(d.id) or {}
        info = get_fuel_price_info(d, m.get("last_lat"), m.get("last_lng"))
        primary_country = info["country_code"]
        primary_fuel_type = info["fuel_type"]
        regions.add(info["country_name"])

    c_info = COUNTRY_FUEL_DATA.get(primary_country, COUNTRY_FUEL_DATA["ZW"])
    benchmark_unit_price = c_info["diesel"] if primary_fuel_type == "diesel" else c_info["petrol"]
    country_display = ", ".join(sorted(regions)) if regions else c_info["name"]

    return {
        "top_bar": {
            "fleet_health_pct": fleet_health,
            "money_lost_this_week_usd": round(total_money_lost, 2),
            "urgent_actions_count": urgent_actions,
            "total_insights_count": len(cards),
            "vehicles_monitored": len(metrics),
            "currency": "USD",
            "fuel_benchmark": {
                "unit_price": benchmark_unit_price,
                "fuel_type": primary_fuel_type,
                "country_name": country_display,
                "country_code": primary_country,
                "petrol_price": c_info["petrol"],
                "diesel_price": c_info["diesel"],
            },
        },
        "cards": cards,
    }


async def generate_driver_insights(db: AsyncSession, user: User) -> Dict[str, Any]:
    """
    Driver Insights. Shows only the driver's own vehicle: no fuel-siphoning
    accusations, no money loss, no other driver's figures. Every value is
    measured from that vehicle's fixes; a metric the tracker does not report
    is None rather than a placeholder.
    """
    devices = await get_driver_devices(db, user)
    device_map = {d.id: d for d in devices}
    device_ids = list(device_map.keys())
    now = _utcnow()
    last_24h = now - timedelta(hours=24)

    metrics: Dict[int, Dict[str, Any]] = {}
    matrix_24h: Dict[int, Dict[str, Any]] = {}
    rows = []
    if device_ids:
        rows = await load_telemetry(db, device_ids, last_24h - timedelta(days=6))
        metrics = analyse_devices(rows)
        matrix_24h = analyse_devices([
            r for r in rows
            if r.timestamp and (r.timestamp.replace(tzinfo=None) if r.timestamp.tzinfo else r.timestamp) >= last_24h
        ])

    primary_dev = devices[0] if devices else None
    veh_name = primary_dev.name if primary_dev else "Your Vehicle"

    # Persisted insights addressed to this driver
    db_insights_stmt = (
        select(Insight)
        .where(
            and_(
                Insight.tenant_id == user.tenant_id,
                Insight.role_target == "driver",
                Insight.status == "open",
                or_(
                    Insight.driver_id == user.id,
                    Insight.device_id.in_(device_ids) if device_ids else False,
                )
            )
        )
        .order_by(desc(Insight.created_at))
    )
    persisted = (await db.execute(db_insights_stmt)).scalars().all()

    cards: List[Dict[str, Any]] = []
    seen: set = set()
    for pi in persisted:
        extra = pi.extra_data or {}
        expires = extra.get("expires_at")
        if expires:
            try:
                exp_dt = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
                if exp_dt.tzinfo is None:
                    if _utcnow() >= exp_dt:
                        continue
                else:
                    from datetime import timezone
                    if datetime.now(timezone.utc) >= exp_dt:
                        continue
            except Exception:
                pass
        dev = device_map.get(pi.device_id)
        cards.append({
            "id": pi.id,
            "category": pi.category,
            "severity": pi.severity,
            "title": pi.title,
            "description": pi.description,
            "vehicle_name": dev.name if dev else veh_name,
            "device_id": pi.device_id,
            "metric_value": pi.metric_value,
            "created_at": pi.created_at.isoformat() if pi.created_at else None,
            "extra_data": extra,
            "actions": extra.get("actions", []),
            "source": "persisted",
        })
        seen.add(pi.category)

    today = matrix_24h.get(primary_dev.id) if primary_dev else None
    week = metrics.get(primary_dev.id) if primary_dev else None
    if today is None:
        today = _blank_metrics()
    if week is None:
        week = _blank_metrics()

    driver_score = _device_score(today)
    night_trips = today["night_trips"]
    dtcs = today.get("dtc") or week.get("dtc")
    engine_temp = max(today.get("engine_temp") or 0, week.get("engine_temp") or 0)
    mil = bool(today.get("mil") or week.get("mil"))

    # CARD 1 - RED - the vehicle reported a real fault condition
    if "car_attention" not in seen:
        if dtcs or engine_temp > 110 or mil:
            plain = translate_dtc_plain(dtcs[0]) if dtcs else {
                "issue": f"The engine reported {engine_temp:.0f}°C, above the 110°C limit.",
                "action": "Pull over safely to prevent engine damage and call your manager.",
            }
            cards.append({
                "id": "driver-card-attention",
                "category": "car_attention",
                "severity": "red",
                "title": "Your Car Needs Attention",
                "description": f"What happened: {plain['issue']} What to do now: {plain['action']}",
                "vehicle_name": veh_name,
                "metric_value": "Action Required",
                "created_at": now.isoformat(),
                "extra_data": {
                    "plain_issue": plain["issue"],
                    "plain_action": plain["action"],
                    "actions": ["stop_safely", "call_manager", "find_nearest_mechanic"],
                },
                "actions": ["stop_safely", "call_manager", "find_nearest_mechanic"],
                "source": "live",
            })
            seen.add("car_attention")

    # CARD 2 - ORANGE - ten or more hard stops in 24 hours
    if "harsh_braking_excess" not in seen and today["harsh_brakes"] >= 10:
        cards.append({
            "id": "driver-card-braking",
            "category": "harsh_braking_excess",
            "severity": "orange",
            "title": "Too Much Harsh Braking",
            "description": (
                f"{today['harsh_brakes']} hard stops measured in the last 24 hours. Harsh braking "
                f"wears brake pads faster and burns unnecessary fuel."
            ),
            "vehicle_name": veh_name,
            "metric_value": f"{today['harsh_brakes']} events / 24h",
            "created_at": now.isoformat(),
            "extra_data": {
                "count": today["harsh_brakes"],
                "tip": "Keep a 3-second gap behind vehicles to slow down smoothly.",
                "actions": ["see_where", "tip_3sec_gap"],
            },
            "actions": ["see_where", "tip_3sec_gap"],
            "source": "live",
        })
        seen.add("harsh_braking_excess")

    # CARD 3 - ORANGE - engine left running while stationary
    if "excessive_idling" not in seen and today["idle_minutes"] >= 60:
        cards.append({
            "id": "driver-card-idle",
            "category": "excessive_idling",
            "severity": "orange",
            "title": "You Idled Too Long",
            "description": (
                f"The vehicle was stationary with the ignition on for {int(today['idle_minutes'])} "
                f"minutes in the last 24 hours."
            ),
            "vehicle_name": veh_name,
            "metric_value": f"{int(today['idle_minutes'])} min idle",
            "created_at": now.isoformat(),
            "extra_data": {
                "total_idle_mins": int(today["idle_minutes"]),
                "tip": "Switch off your engine whenever you are waiting for more than 2 minutes.",
                "actions": ["tip_switch_off"],
            },
            "actions": ["tip_switch_off"],
            "source": "live",
        })
        seen.add("excessive_idling")

    # CARD 4 - GREEN - only when a real drive was recorded and it was clean
    if "great_driving" not in seen:
        if today["distance_km"] > 0 and today["speeding_events"] == 0 and today["harsh_brakes"] <= 2:
            cards.append({
                "id": "driver-card-great",
                "category": "great_driving",
                "severity": "green",
                "title": "Great Driving Today",
                "description": (
                    f"{today['distance_km']:.1f} km driven today with no speeding events and "
                    f"{today['harsh_brakes']} harsh-brake event(s)."
                ),
                "vehicle_name": veh_name,
                "metric_value": f"{driver_score}/100",
                "created_at": now.isoformat(),
                "extra_data": {
                    "distance_km": today["distance_km"],
                    "speeding_events": 0,
                    "harsh_brakes": today["harsh_brakes"],
                    "actions": ["share_score"],
                },
                "actions": ["share_score"],
                "source": "live",
            })
            seen.add("great_driving")

    # CARD 5 - BLUE - service interval, from a real odometer reading
    if "service_reminder" not in seen and week.get("odometer"):
        km_left = round(10000 - (week["odometer"] % 10000))
        if 0 < km_left <= 500:
            cards.append({
                "id": "driver-card-service",
                "category": "service_reminder",
                "severity": "blue",
                "title": "Service Reminder",
                "description": f"Routine maintenance is due in approximately {km_left} km.",
                "vehicle_name": veh_name,
                "metric_value": f"{km_left} km left",
                "created_at": now.isoformat(),
                "extra_data": {
                    "km_left": km_left,
                    "odometer_km": week["odometer"],
                    "actions": ["request_service_day"],
                },
                "actions": ["request_service_day"],
                "source": "live",
            })
            seen.add("service_reminder")

    # Fuel economy and standing come from measurement, not a placeholder.
    my_fuel = week["fuel_rate"]
    my_rank = None
    tenant_devices = await get_tenant_devices(db, user.tenant_id, user)
    if 0 < len(tenant_devices) <= 25 and primary_dev:
        crew_rows = await load_telemetry(db, [d.id for d in tenant_devices], last_24h)
        crew = analyse_devices(crew_rows)
        board = sorted(
            ((d_id, _device_score(m)) for d_id, m in crew.items() if m["distance_km"] > 0),
            key=lambda x: x[1], reverse=True,
        )
        for idx, (d_id, _score) in enumerate(board):
            if d_id == primary_dev.id:
                my_rank = f"{idx + 1} of {len(board)}"
                break

    return {
        "top_bar": {
            "my_score": driver_score,
            "my_fuel_l100km": my_fuel,
            "my_rank": my_rank,
            "vehicle_name": veh_name,
            "distance_today_km": today["distance_km"],
            "night_trips_24h": night_trips,
        },
        "cards": cards,
    }
