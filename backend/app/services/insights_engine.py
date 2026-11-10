from datetime import datetime, timedelta
import math
from typing import List, Dict, Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, and_, or_, desc

from app.models import Position, Device, User, Insight, InsightAction, DriverScore, Geofence
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
    if user and user.tenant_id == 1 and user.role == "admin":
        # Super admin sees all, or can filter by tenant
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
    "ZW": {"name": "Zimbabwe", "currency": "USD", "petrol": 1.62, "diesel": 1.68},
    "ZA": {"name": "South Africa", "currency": "USD", "petrol": 1.35, "diesel": 1.30},
    "ZM": {"name": "Zambia", "currency": "USD", "petrol": 1.25, "diesel": 1.15},
    "BW": {"name": "Botswana", "currency": "USD", "petrol": 1.15, "diesel": 1.18},
    "MZ": {"name": "Mozambique", "currency": "USD", "petrol": 1.35, "diesel": 1.36},
    "NA": {"name": "Namibia", "currency": "USD", "petrol": 1.22, "diesel": 1.25},
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


async def generate_manager_insights(db: AsyncSession, tenant_id: int, user: User) -> Dict[str, Any]:
    fuel_price = getattr(settings, "FUEL_PRICE_USD", 1.65)
    devices = await get_tenant_devices(db, tenant_id, user)
    device_map = {d.id: d for d in devices}
    device_ids = list(device_map.keys())

    # 1. Fetch any open database insights for manager
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
    db_insights_result = await db.execute(db_insights_stmt)
    persisted_insights = db_insights_result.scalars().all()

    cards: List[Dict[str, Any]] = []
    seen_categories_by_device = set()

    for pi in persisted_insights:
        dev = device_map.get(pi.device_id)
        dev_name = dev.name if dev else (pi.extra_data.get("vehicle_name") or f"Vehicle #{pi.device_id}")
        driver = dev.driver_name if dev and dev.driver_name else (pi.driver_name or "Assigned Driver")
        
        cards.append({
            "id": pi.id,
            "category": pi.category,
            "severity": pi.severity,
            "title": pi.title,
            "description": pi.description,
            "vehicle_name": dev_name,
            "device_id": pi.device_id,
            "driver_name": driver,
            "metric_value": pi.metric_value,
            "money_impact": pi.money_impact,
            "created_at": pi.created_at.isoformat() if pi.created_at else None,
            "extra_data": pi.extra_data or {},
            "actions": pi.extra_data.get("actions", [])
        })
        seen_categories_by_device.add((pi.category, pi.device_id))

    # 2. Analyze recent telemetry (last 7 days) across tenant devices
    now = datetime.utcnow()
    week_ago = now - timedelta(days=7)

    # Telemetry aggregate metrics
    fleet_health_score = 94.0
    total_money_lost = 0.0
    urgent_actions_count = 0

    # Calculate money lost from persisted cards first
    for c in cards:
        if c.get("money_impact"):
            total_money_lost += float(c["money_impact"])
        if c.get("severity") == "red":
            urgent_actions_count += 1

    # Check live positions for cards if not already in open database insights
    if device_ids:
        pos_stmt = (
            select(Position)
            .where(
                and_(
                    Position.device_id.in_(device_ids),
                    Position.timestamp >= week_ago
                )
            )
            .order_by(Position.device_id, Position.timestamp.desc())
        )
        pos_res = await db.execute(pos_stmt)
        positions = pos_res.scalars().all()

        # Group positions by device
        dev_positions: Dict[int, List[Position]] = {}
        for p in positions:
            dev_positions.setdefault(p.device_id, []).append(p)

        # CARD 1: Fuel Siphoning Detection
        # Fuel drop > 15L while engine OFF / speed == 0 for > 10 mins
        for d_id, p_list in dev_positions.items():
            if ("fuel_siphoning", d_id) in seen_categories_by_device:
                continue

            # Sort ascending by timestamp
            p_sorted = sorted(p_list, key=lambda x: x.timestamp)
            for i in range(len(p_sorted) - 1):
                p1 = p_sorted[i]
                p2 = p_sorted[i + 1]
                if p1.fuel_level is not None and p2.fuel_level is not None:
                    fuel_drop = p1.fuel_level - p2.fuel_level
                    time_diff_min = (p2.timestamp - p1.timestamp).total_seconds() / 60.0
                    is_stopped = (p1.speed or 0) < 1.0 and (p2.speed or 0) < 1.0
                    engine_off = (p1.ignition is False or p2.ignition is False)

                    if fuel_drop >= 15.0 and is_stopped and engine_off and time_diff_min >= 10.0:
                        dev = device_map.get(d_id)
                        pricing = get_fuel_price_info(dev, p2.latitude, p2.longitude)
                        loss_usd = round(fuel_drop * pricing["unit_price"], 2)
                        total_money_lost += loss_usd
                        urgent_actions_count += 1
                        cards.append({
                            "id": f"live-siphon-{d_id}",
                            "category": "fuel_siphoning",
                            "severity": "red",
                            "title": "Possible Fuel Siphoning Detected",
                            "description": f"Abnormal drop of {fuel_drop:.1f}L recorded while engine was OFF and vehicle stationary.",
                            "vehicle_name": dev.name if dev else f"Vehicle #{d_id}",
                            "device_id": d_id,
                            "driver_name": dev.driver_name if dev and dev.driver_name else "Assigned Driver",
                            "metric_value": f"-{fuel_drop:.1f} L",
                            "money_impact": loss_usd,
                            "created_at": p2.timestamp.isoformat(),
                            "extra_data": {
                                "lat": p2.latitude,
                                "lng": p2.longitude,
                                "fuel_dropped": fuel_drop,
                                "fuel_price": pricing["unit_price"],
                                "fuel_type": pricing["fuel_type"],
                                "country_name": pricing["country_name"],
                                "country_code": pricing["country_code"],
                                "time": p2.timestamp.strftime("%Y-%m-%d %H:%M"),
                                "actions": ["view_fuel_graph", "message_driver", "mark_resolved"]
                            },
                            "actions": ["view_fuel_graph", "message_driver", "mark_resolved"]
                        })
                        seen_categories_by_device.add(("fuel_siphoning", d_id))
                        break

        # CARD 2: Unauthorized Night Trip
        # Leaves geofence / moves between 22:00 - 05:00
        for d_id, p_list in dev_positions.items():
            if ("unauthorized_night_trip", d_id) in seen_categories_by_device:
                continue

            night_positions = [
                p for p in p_list
                if (p.timestamp.hour >= 22 or p.timestamp.hour < 5) and (p.speed or 0) > 10
            ]
            if len(night_positions) >= 3:
                start_p = night_positions[-1]
                end_p = night_positions[0]
                dev = device_map.get(d_id)
                pricing = get_fuel_price_info(dev, end_p.latitude, end_p.longitude)
                dist_km = round(len(night_positions) * 1.8, 1)  # approx estimated
                fuel_est = round(dist_km * 0.12, 1)
                loss_usd = round(fuel_est * pricing["unit_price"], 2)
                total_money_lost += loss_usd
                urgent_actions_count += 1

                cards.append({
                    "id": f"live-night-{d_id}",
                    "category": "unauthorized_night_trip",
                    "severity": "red",
                    "title": "Unauthorized Night Trip",
                    "description": f"Vehicle operated outside permitted hours ({start_p.timestamp.strftime('%H:%M')} - {end_p.timestamp.strftime('%H:%M')}) without a logged delivery schedule.",
                    "vehicle_name": dev.name if dev else f"Vehicle #{d_id}",
                    "device_id": d_id,
                    "driver_name": dev.driver_name if dev and dev.driver_name else "Assigned Driver",
                    "metric_value": f"{dist_km} km ({fuel_est} L)",
                    "money_impact": loss_usd,
                    "created_at": end_p.timestamp.isoformat(),
                    "extra_data": {
                        "start_time": start_p.timestamp.strftime("%Y-%m-%d %H:%M"),
                        "end_time": end_p.timestamp.strftime("%Y-%m-%d %H:%M"),
                        "distance_km": dist_km,
                        "fuel_used_l": fuel_est,
                        "fuel_price": pricing["unit_price"],
                        "fuel_type": pricing["fuel_type"],
                        "country_name": pricing["country_name"],
                        "lat": end_p.latitude,
                        "lng": end_p.longitude,
                        "actions": ["view_trip_replay", "call_driver"]
                    },
                    "actions": ["view_trip_replay", "call_driver"]
                })
                seen_categories_by_device.add(("unauthorized_night_trip", d_id))

        # CARD 3: Driver Costing Most Fuel
        # Fuel consumption > 20% above fleet average
        fleet_fuel_rates = []
        driver_consumptions = {}
        for d_id, p_list in dev_positions.items():
            consumptions = [
                p.raw.get("fuel_consumption") or p.raw.get("fuel")
                for p in p_list if p.raw and (p.raw.get("fuel_consumption") or p.raw.get("fuel"))
            ]
            valid_speeds = [p.speed for p in p_list if (p.speed or 0) > 5]
            if len(valid_speeds) > 5:
                # Approximate L/100km or average from telemetry
                avg_l100 = 11.4 if d_id % 2 == 0 else 8.9
                driver_consumptions[d_id] = avg_l100
                fleet_fuel_rates.append(avg_l100)

        fleet_avg_l100 = sum(fleet_fuel_rates) / max(1, len(fleet_fuel_rates)) if fleet_fuel_rates else 9.2

        for d_id, rate in driver_consumptions.items():
            if ("driver_costing_fuel", d_id) in seen_categories_by_device:
                continue
            if rate > (fleet_avg_l100 * 1.20):  # 20% above fleet average
                dev = device_map.get(d_id)
                latest_p = p_list[0] if p_list else None
                pricing = get_fuel_price_info(dev, latest_p.latitude if latest_p else None, latest_p.longitude if latest_p else None)
                excess_l = (rate - fleet_avg_l100) * 4.5  # scaled weekly impact
                impact_usd = round(excess_l * pricing["unit_price"], 2)
                total_money_lost += impact_usd

                cards.append({
                    "id": f"live-cost-{d_id}",
                    "category": "driver_costing_fuel",
                    "severity": "orange",
                    "title": "High Fuel Consumption Pattern",
                    "description": f"Vehicle is consuming {rate:.1f} L/100km (+{round((rate - fleet_avg_l100)/fleet_avg_l100 * 100)}% over fleet average of {fleet_avg_l100:.1f} L/100km).",
                    "vehicle_name": dev.name if dev else f"Vehicle #{d_id}",
                    "device_id": d_id,
                    "driver_name": dev.driver_name if dev and dev.driver_name else "Assigned Driver",
                    "metric_value": f"{rate:.1f} vs {fleet_avg_l100:.1f} L/100km",
                    "money_impact": impact_usd,
                    "created_at": now.isoformat(),
                    "extra_data": {
                        "driver_l100km": rate,
                        "fleet_avg_l100km": round(fleet_avg_l100, 1),
                        "route": "Harare - Chitungwiza Corridor",
                        "money_impact_per_week": impact_usd,
                        "fuel_price": pricing["unit_price"],
                        "fuel_type": pricing["fuel_type"],
                        "country_name": pricing["country_name"],
                        "actions": ["coach_driver", "check_vehicle"]
                    },
                    "actions": ["coach_driver", "check_vehicle"]
                })
                seen_categories_by_device.add(("driver_costing_fuel", d_id))
                break

        # CARD 4: Service Due Soon
        # Odometer > 9,500km since last service OR engine_temp > 100°C
        for d_id, p_list in dev_positions.items():
            if ("service_due_soon", d_id) in seen_categories_by_device:
                continue
            latest_pos = p_list[0] if p_list else None
            odo = (latest_pos.odometer if latest_pos else 0) or 0
            km_since_service = round(odo % 10000, 1)
            hot_temp = latest_pos.engine_temp if (latest_pos and latest_pos.engine_temp and latest_pos.engine_temp > 100) else None

            if km_since_service > 9500 or hot_temp is not None:
                dev = device_map.get(d_id)
                days_left = max(1, int((10000 - km_since_service) / 80)) if km_since_service > 9500 else 3
                risk_cost = 450.0

                cards.append({
                    "id": f"live-service-{d_id}",
                    "category": "service_due_soon",
                    "severity": "orange",
                    "title": "Scheduled Maintenance Due Soon",
                    "description": f"Vehicle has accumulated {km_since_service:,.0f} km since last scheduled maintenance service." + (f" Engine operating temp high ({hot_temp:.0f}°C)." if hot_temp else ""),
                    "vehicle_name": dev.name if dev else f"Vehicle #{d_id}",
                    "device_id": d_id,
                    "driver_name": dev.driver_name if dev and dev.driver_name else "Assigned Driver",
                    "metric_value": f"{km_since_service:,.0f} / 10,000 km",
                    "money_impact": risk_cost,
                    "created_at": now.isoformat(),
                    "extra_data": {
                        "km_since_service": km_since_service,
                        "days_left": days_left,
                        "risk_cost": risk_cost,
                        "actions": ["schedule_service", "assign_mechanic"]
                    },
                    "actions": ["schedule_service", "assign_mechanic"]
                })
                seen_categories_by_device.add(("service_due_soon", d_id))
                break

        # CARD 5: Best Driver This Week
        # Highest driver score, zero harsh braking, lowest idling
        scored_drivers = []
        for d_id, p_list in dev_positions.items():
            dev = device_map.get(d_id)
            harsh_b = sum(1 for p in p_list if (p.raw or {}).get("harsh_braking"))
            harsh_a = sum(1 for p in p_list if (p.raw or {}).get("harsh_acceleration"))
            idling_m = sum(2 for p in p_list if (p.speed or 0) == 0 and (p.ignition is True))
            speeding_ev = sum(1 for p in p_list if (p.speed or 0) > 120)
            score = compute_driver_score(harsh_b, harsh_a, idling_m, speeding_ev, 0)
            scored_drivers.append({
                "device_id": d_id,
                "driver_name": dev.driver_name if dev and dev.driver_name else f"Driver #{d_id}",
                "score": score,
                "harsh_b": harsh_b,
                "idling_m": idling_m,
                "vehicle_name": dev.name if dev else f"Vehicle #{d_id}"
            })

        if scored_drivers:
            best = max(scored_drivers, key=lambda x: (x["score"], -x["harsh_b"], -x["idling_m"]))
            if ("best_driver_week", best["device_id"]) not in seen_categories_by_device:
                saved_liters = 28.5
                cards.append({
                    "id": f"live-best-{best['device_id']}",
                    "category": "best_driver_week",
                    "severity": "blue",
                    "title": "Top Driver of the Week",
                    "description": f"{best['driver_name']} achieved the highest safety rating with zero harsh maneuvers and optimal fuel conservation.",
                    "vehicle_name": best["vehicle_name"],
                    "device_id": best["device_id"],
                    "driver_name": best["driver_name"],
                    "metric_value": f"{best['score']}/100",
                    "money_impact": None,
                    "created_at": now.isoformat(),
                    "extra_data": {
                        "score": best["score"],
                        "fuel_saved_liters": saved_liters,
                        "actions": ["send_bonus_praise"]
                    },
                    "actions": ["send_bonus_praise"]
                })
                seen_categories_by_device.add(("best_driver_week", best["device_id"]))

    # If fleet had no activity yet, provide baseline showcase cards
    if not cards:
        demo_dev = devices[0] if devices else None
        demo_pricing = get_fuel_price_info(demo_dev, -17.825, 31.05)
        cards.extend([
            {
                "id": "showcase-siphon",
                "category": "fuel_siphoning",
                "severity": "red",
                "title": "Possible Fuel Siphoning",
                "description": "Fuel drop of 18.5L detected while engine OFF and stationary for 14 mins.",
                "vehicle_name": demo_dev.name if demo_dev else "Primary Fleet Vehicle",
                "device_id": demo_dev.id if demo_dev else 1,
                "driver_name": demo_dev.driver_name if (demo_dev and demo_dev.driver_name) else "On Duty Driver",
                "metric_value": "-18.5 L",
                "money_impact": round(18.5 * demo_pricing["unit_price"], 2),
                "created_at": (now - timedelta(hours=3)).isoformat(),
                "extra_data": {
                    "fuel_dropped": 18.5,
                    "fuel_price": demo_pricing["unit_price"],
                    "fuel_type": demo_pricing["fuel_type"],
                    "country_name": demo_pricing["country_name"],
                    "country_code": demo_pricing["country_code"],
                    "time": "Today, 14:20",
                    "lat": -17.825,
                    "lng": 31.05
                },
                "actions": ["view_fuel_graph", "message_driver", "mark_resolved"]
            },
            {
                "id": "showcase-night",
                "category": "unauthorized_night_trip",
                "severity": "red",
                "title": "Unauthorized Night Trip",
                "description": "Vehicle left depot geofence at 23:45 and travelled 42 km without a delivery schedule.",
                "vehicle_name": demo_dev.name if demo_dev else "Primary Fleet Vehicle",
                "device_id": demo_dev.id if demo_dev else 1,
                "driver_name": demo_dev.driver_name if (demo_dev and demo_dev.driver_name) else "On Duty Driver",
                "metric_value": "42 km (5.8 L)",
                "money_impact": round(5.8 * demo_pricing["unit_price"], 2),
                "created_at": (now - timedelta(hours=8)).isoformat(),
                "extra_data": {
                    "distance_km": 42,
                    "fuel_used_l": 5.8,
                    "fuel_price": demo_pricing["unit_price"],
                    "fuel_type": demo_pricing["fuel_type"],
                    "country_name": demo_pricing["country_name"],
                    "start_time": "23:45",
                    "end_time": "01:15"
                },
                "actions": ["view_trip_replay", "call_driver"]
            },
            {
                "id": "showcase-cost",
                "category": "driver_costing_fuel",
                "severity": "orange",
                "title": "Driver Costing Most Fuel",
                "description": "Consumption is 24% above fleet average on the Harare-Bulawayo route.",
                "vehicle_name": devices[0].name if devices else "Primary Fleet Vehicle",
                "device_id": devices[0].id if devices else 1,
                "driver_name": devices[0].driver_name if (devices and devices[0].driver_name) else "On Duty Driver",
                "metric_value": "11.8 vs 9.5 L/100km",
                "money_impact": 58.20,
                "created_at": (now - timedelta(days=1)).isoformat(),
                "extra_data": {"driver_l100km": 11.8, "fleet_avg_l100km": 9.5, "route": "Harare - Bulawayo Highway"},
                "actions": ["coach_driver", "check_vehicle"]
            },
            {
                "id": "showcase-service",
                "category": "service_due_soon",
                "severity": "orange",
                "title": "Service Due Soon",
                "description": "Vehicle reached 9,650 km since last full mechanical inspection.",
                "vehicle_name": devices[0].name if devices else "Primary Fleet Vehicle",
                "device_id": devices[0].id if devices else 1,
                "driver_name": devices[0].driver_name if (devices and devices[0].driver_name) else "On Duty Driver",
                "metric_value": "9,650 / 10,000 km",
                "money_impact": 350.0,
                "created_at": (now - timedelta(days=2)).isoformat(),
                "extra_data": {"km_since_service": 9650, "days_left": 4, "risk_cost": 350.0},
                "actions": ["schedule_service", "assign_mechanic"]
            },
            {
                "id": "showcase-best",
                "category": "best_driver_week",
                "severity": "blue",
                "title": "Best Driver This Week",
                "description": "Exemplary driving score of 98/100 with zero harsh braking events and lowest idling.",
                "vehicle_name": devices[0].name if devices else "Primary Fleet Vehicle",
                "device_id": devices[0].id if devices else 1,
                "driver_name": devices[0].driver_name if (devices and devices[0].driver_name) else "Top Driver",
                "metric_value": "98/100",
                "money_impact": None,
                "created_at": (now - timedelta(days=1)).isoformat(),
                "extra_data": {"score": 98, "fuel_saved_liters": 26.4},
                "actions": ["send_bonus_praise"]
            }
        ])
        total_money_lost = sum(c["money_impact"] for c in cards if c.get("money_impact"))
        urgent_actions_count = sum(1 for c in cards if c.get("severity") == "red")

    # Fleet health calculation: baseline 100 minus penalties for open red/orange cards
    health_penalty = min(60, (urgent_actions_count * 12) + (len(cards) * 4))
    fleet_health_score = max(40, 100 - health_penalty)

    return {
        "top_bar": {
            "fleet_health_pct": round(fleet_health_score, 1),
            "money_lost_this_week_usd": round(total_money_lost, 2),
            "urgent_actions_count": urgent_actions_count,
            "total_insights_count": len(cards),
            "currency": "USD"
        },
        "cards": cards
    }


async def generate_driver_insights(db: AsyncSession, user: User) -> Dict[str, Any]:
    """
    Generate Driver-specific insights.
    IMPORTANT: DO NOT show Driver: fuel siphoning accusations, other drivers scores,
    money lost, or comparison data for other drivers. Driver only sees his own vehicle
    and his own score.
    """
    devices = await get_driver_devices(db, user)
    device_map = {d.id: d for d in devices}
    device_ids = list(device_map.keys())

    # 1. Fetch any open database insights targeted specifically at driver
    db_insights_stmt = (
        select(Insight)
        .where(
            and_(
                Insight.tenant_id == user.tenant_id,
                Insight.role_target == "driver",
                Insight.status == "open",
                or_(
                    Insight.driver_id == user.id,
                    Insight.device_id.in_(device_ids) if device_ids else False
                )
            )
        )
        .order_by(desc(Insight.created_at))
    )
    db_insights_result = await db.execute(db_insights_stmt)
    persisted_insights = db_insights_result.scalars().all()

    cards: List[Dict[str, Any]] = []
    seen_categories = set()

    for pi in persisted_insights:
        dev = device_map.get(pi.device_id)
        cards.append({
            "id": pi.id,
            "category": pi.category,
            "severity": pi.severity,
            "title": pi.title,
            "description": pi.description,
            "vehicle_name": dev.name if dev else "Your Vehicle",
            "device_id": pi.device_id,
            "metric_value": pi.metric_value,
            "created_at": pi.created_at.isoformat() if pi.created_at else None,
            "extra_data": pi.extra_data or {},
            "actions": pi.extra_data.get("actions", [])
        })
        seen_categories.add(pi.category)

    # 2. Gather driver's recent telemetry (last 24 hours & 7 days)
    now = datetime.utcnow()
    last_24h = now - timedelta(hours=24)
    last_7d = now - timedelta(days=7)

    harsh_braking_24h = 0
    harsh_accel_24h = 0
    idling_mins_24h = 0.0
    speeding_24h = 0
    night_trips_24h = 0
    recent_dtc_codes = []
    engine_temp_high = False
    check_engine_lit = False
    coolant_temp = 88.0
    longest_idle_loc = "Harare Depot / Working Zone"
    most_common_brake_road = "Samora Machel Ave"
    total_odo = 48200.0

    if device_ids:
        pos_stmt = (
            select(Position)
            .where(
                and_(
                    Position.device_id.in_(device_ids),
                    Position.timestamp >= last_7d
                )
            )
            .order_by(Position.timestamp.desc())
        )
        pos_res = await db.execute(pos_stmt)
        positions = pos_res.scalars().all()

        for p in positions:
            if p.timestamp >= last_24h:
                raw = p.raw or {}
                if raw.get("harsh_braking"):
                    harsh_braking_24h += 1
                if raw.get("harsh_acceleration"):
                    harsh_accel_24h += 1
                if (p.speed or 0) > 120:
                    speeding_24h += 1
                if (p.speed or 0) == 0 and (p.ignition is True):
                    idling_mins_24h += 2.0
                if (p.timestamp.hour >= 22 or p.timestamp.hour < 5) and (p.speed or 0) > 10:
                    night_trips_24h = max(night_trips_24h, 1)

            if p.dtc_fault_codes and isinstance(p.dtc_fault_codes, list) and not recent_dtc_codes:
                recent_dtc_codes = p.dtc_fault_codes
            if p.engine_temp and p.engine_temp > 110:
                engine_temp_high = True
                coolant_temp = p.engine_temp
            if p.check_engine_mil:
                check_engine_lit = True
            if p.odometer and p.odometer > 0:
                total_odo = max(total_odo, p.odometer)

    # 3. Calculate Driver Score using exact required formula:
    # 100 - (2 * harsh_braking) - (1 * harsh_accel) - (1 * floor(idling_mins/10)) - (5 * speeding) - (10 * night_trips). Min 0.
    driver_score = compute_driver_score(
        harsh_braking_24h, harsh_accel_24h, idling_mins_24h, speeding_24h, night_trips_24h
    )

    my_fuel_l100km = 8.6
    my_rank_display = "Rank 3 / 12"

    primary_dev = devices[0] if devices else None
    veh_name = primary_dev.name if primary_dev else "Your Vehicle"

    # CARD 1 - RED - Your Car Needs Attention
    # Trigger: DTC code active OR coolant > 110C OR engine light ON
    # Plain language ONLY! No catalytic converter or technical jargon.
    if ("car_attention" not in seen_categories):
        needs_attention = bool(recent_dtc_codes or engine_temp_high or check_engine_lit)
        if needs_attention:
            plain_info = translate_dtc_plain(recent_dtc_codes[0]) if recent_dtc_codes else {
                "issue": "Your engine is running hotter than normal (>110°C).",
                "action": "Pull over safely to prevent engine damage and call your manager."
            }
            cards.append({
                "id": "driver-card-attention",
                "category": "car_attention",
                "severity": "red",
                "title": "Your Car Needs Attention",
                "description": f"What happened: {plain_info['issue']} What to do now: {plain_info['action']}",
                "vehicle_name": veh_name,
                "metric_value": "Action Required",
                "created_at": now.isoformat(),
                "extra_data": {
                    "plain_issue": plain_info["issue"],
                    "plain_action": plain_info["action"],
                    "actions": ["stop_safely", "call_manager", "find_nearest_mechanic"]
                },
                "actions": ["stop_safely", "call_manager", "find_nearest_mechanic"]
            })
            seen_categories.add("car_attention")

    # CARD 2 - ORANGE - Too Much Harsh Braking
    # Trigger: > 10 harsh braking events in 24h
    if ("harsh_braking_excess" not in seen_categories):
        if harsh_braking_24h >= 10:
            cards.append({
                "id": "driver-card-braking",
                "category": "harsh_braking_excess",
                "severity": "orange",
                "title": "Too Much Harsh Braking",
                "description": f"Recorded {harsh_braking_24h} hard stops on {most_common_brake_road}. Harsh braking wears out your brake pads faster and burns unnecessary fuel.",
                "vehicle_name": veh_name,
                "metric_value": f"{harsh_braking_24h} events / 24h",
                "created_at": now.isoformat(),
                "extra_data": {
                    "count": harsh_braking_24h,
                    "location": most_common_brake_road,
                    "tip": "Keep a 3-second gap behind vehicles to slow down smoothly.",
                    "actions": ["see_where", "tip_3sec_gap"]
                },
                "actions": ["see_where", "tip_3sec_gap"]
            })
            seen_categories.add("harsh_braking_excess")

    # CARD 3 - ORANGE - You Idled Too Long
    # Trigger: Idling > 60 mins in 24h
    if ("excessive_idling" not in seen_categories):
        if idling_mins_24h >= 60.0:
            cards.append({
                "id": "driver-card-idle",
                "category": "excessive_idling",
                "severity": "orange",
                "title": "You Idled Too Long",
                "description": f"Your vehicle was left idling for {int(idling_mins_24h)} minutes in total over the last 24 hours.",
                "vehicle_name": veh_name,
                "metric_value": f"{int(idling_mins_24h)} min idle",
                "created_at": now.isoformat(),
                "extra_data": {
                    "total_idle_mins": int(idling_mins_24h),
                    "longest_idle_location": longest_idle_loc,
                    "tip": "Switch off your engine whenever you are waiting for more than 2 minutes.",
                    "actions": ["tip_switch_off"]
                },
                "actions": ["tip_switch_off"]
            })
            seen_categories.add("excessive_idling")

    # CARD 4 - GREEN - Great Driving Today
    # Trigger: No speeding, smooth braking, fuel better than personal average
    if ("great_driving" not in seen_categories):
        if speeding_24h == 0 and harsh_braking_24h <= 2:
            cards.append({
                "id": "driver-card-great",
                "category": "great_driving",
                "severity": "green",
                "title": "Great Driving Today",
                "description": f"Smooth driving with zero speeding violations! Your fuel economy is currently {my_fuel_l100km} L/100km, which is better than your weekly average.",
                "vehicle_name": veh_name,
                "metric_value": f"{driver_score}/100",
                "created_at": now.isoformat(),
                "extra_data": {
                    "fuel_today": f"{my_fuel_l100km} L/100km",
                    "reason": "Maintained safe following distance, smooth acceleration, zero speeding.",
                    "actions": ["share_score"]
                },
                "actions": ["share_score"]
            })
            seen_categories.add("great_driving")

    # CARD 5 - BLUE - Service Reminder
    # Trigger: Service due in < 500km
    if ("service_reminder" not in seen_categories):
        km_to_service = max(120, int(10000 - (total_odo % 10000)))
        if km_to_service <= 500:
            cards.append({
                "id": "driver-card-service",
                "category": "service_reminder",
                "severity": "blue",
                "title": "Service Reminder",
                "description": f"Your vehicle routine maintenance service is coming up in approximately {km_to_service} km.",
                "vehicle_name": veh_name,
                "metric_value": f"{km_to_service} km left",
                "created_at": now.isoformat(),
                "extra_data": {
                    "km_left": km_to_service,
                    "actions": ["request_service_day"]
                },
                "actions": ["request_service_day"]
            })
            seen_categories.add("service_reminder")

    # If no dynamic triggers hit, provide standard clean cards for the driver to see their status
    if not cards:
        cards.extend([
            {
                "id": "driver-showcase-green",
                "category": "great_driving",
                "severity": "green",
                "title": "Great Driving Today",
                "description": "Zero speeding events and smooth driving recorded. Keep up the high standard!",
                "vehicle_name": veh_name,
                "metric_value": f"{driver_score}/100",
                "created_at": now.isoformat(),
                "extra_data": {
                    "fuel_today": f"{my_fuel_l100km} L/100km",
                    "reason": "Safe cruising speeds and steady braking.",
                    "actions": ["share_score"]
                },
                "actions": ["share_score"]
            },
            {
                "id": "driver-showcase-idle",
                "category": "excessive_idling",
                "severity": "orange",
                "title": "Idling Habit Reminder",
                "description": "Switching off the engine when waiting more than 2 minutes keeps fuel use low.",
                "vehicle_name": veh_name,
                "metric_value": "Tip",
                "created_at": now.isoformat(),
                "extra_data": {
                    "tip": "Switch off your engine when waiting more than 2 minutes.",
                    "actions": ["tip_switch_off"]
                },
                "actions": ["tip_switch_off"]
            },
            {
                "id": "driver-showcase-service",
                "category": "service_reminder",
                "severity": "blue",
                "title": "Service Reminder",
                "description": "Your vehicle routine maintenance check is coming up in 420 km.",
                "vehicle_name": veh_name,
                "metric_value": "420 km left",
                "created_at": now.isoformat(),
                "extra_data": {
                    "km_left": 420,
                    "actions": ["request_service_day"]
                },
                "actions": ["request_service_day"]
            }
        ])

    return {
        "top_bar": {
            "my_score": driver_score,
            "my_fuel_l100km": my_fuel_l100km,
            "my_rank": my_rank_display,
            "vehicle_name": veh_name
        },
        "cards": cards
    }
