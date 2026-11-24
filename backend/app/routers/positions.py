from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import Position, Device, User
from app.schemas import PositionCreate, PositionOut
from app.auth_middleware import get_current_user, can_see_device, scope_devices
from sqlalchemy.future import select
from datetime import datetime
from typing import List, Optional
import asyncio
from pydantic import BaseModel
from app.realtime import publish_position
from app.services.device_resolver import resolve_device
from app.services.track import analyze_track, TRACK_MAX_KMH
from app.services.data_guardrails import (
    haversine_distance_km,
    validate_coordinates,
    validate_and_sanitize_speed,
    validate_timestamp,
    is_teleportation_jump,
    is_duplicate_ping
)

router = APIRouter(prefix="/positions")

# A parked tracker keeps reporting fixes and its coordinates wander by a few
# metres each time. That wander is not travel: distance is only banked once the
# unit has left the fix where it stopped by this radius, otherwise "Today" km
# climbed all day on vehicles whose card read "Parked"/"Stationary".
PARKED_NOISE_KM = 0.10

# --- Track integrity rules ---------------------------------------------------
# ONE definition of "no drive could have joined these two fixes", shared by
# /routes, /daily, /trips and /match. These used to be four separate, slightly
# different copies, which is how one day could read 157.7 km on the Route
# History strip while its own trip cards added up to a fraction of that.
TRACK_GAP_MINUTES = 15        # a longer silence ends a continuous track
TRACK_GAP_KM = 1.0            # ... and it must have covered real ground
TRACK_JUMP_KM = 2.0           # a single hop this long is a gap, not a road
TRACK_MAX_KMH = 200.0         # beyond this the pair is a teleport, not travel
TRACK_STOP_KMH = 3.0          # at or below this the unit reports stationary
TRACK_NOISE_KM = 0.03         # sub-30 m creep between minute fixes is GPS jitter


def _seconds_between(a, b) -> float:
    """Elapsed seconds between two datetimes (or epoch values), tz-safe."""
    try:
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            return abs(float(b) - float(a))
        if a.tzinfo is None and b.tzinfo is not None:
            a = a.replace(tzinfo=b.tzinfo)
        elif b.tzinfo is None and a.tzinfo is not None:
            b = b.replace(tzinfo=a.tzinfo)
        return abs((b - a).total_seconds())
    except Exception:
        return 0.0


def _is_track_gap(prev_ts, prev_lat, prev_lng, ts, lat, lng) -> bool:
    """True when two consecutive fixes cannot be joined by a drive.

    A gap banks no distance, and /routes flags it so the client breaks the
    drawn line instead of drawing a chord across the missing hours.
    """
    if None in (prev_lat, prev_lng, lat, lng):
        return True
    km = haversine_distance_km(prev_lat, prev_lng, lat, lng)
    dt = _seconds_between(prev_ts, ts)
    if dt <= 0:
        # Collapsed receipt timestamps (buffered dump): real breadcrumbs, so
        # only an impossible hop is a gap. A time-bearing pair is judged by
        # implied speed instead: a tracker that uploads every 3 minutes really
        # does cover several kilometres between fixes, and calling that a gap
        # would zero a highway's whole distance.
        return km > TRACK_JUMP_KM
    # Only a silence is a gap. A hop too fast to be true is a bad fix, which
    # analyze_track drops while keeping the line continuous: calling it a gap
    # is what broke one continuous track into hundreds of false breaks.
    return dt >= TRACK_GAP_MINUTES * 60 and km >= TRACK_GAP_KM


def _iso_utc(dt):
    """Serialize a datetime for the frontend with an explicit UTC marker.
    Naive datetimes are UTC by convention ('Z' appended); aware datetimes
    (e.g. timestamptz reads) already carry a numeric offset — appending 'Z'
    would produce an invalid '...T...+00:00Z' string that JS cannot parse."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.isoformat() + "Z"
    return dt.isoformat()


def _is_coarse_lbs_row(raw) -> bool:
    """True when Xcela R19 firmware encoded a coarse cell-tower LBS fallback
    (satellites >= 200) or an unfixed/zero-satellite row (satellites == 0).
    In R19 (GPS.ino:2846), `sendSatellites = 200 + reportedSatellites` marks
    AT+CLBS cell-tower coordinates which can be 500m-8km off the true GPS spot."""
    if not isinstance(raw, dict) or "satellites" not in raw:
        return False
    try:
        sats = int(raw.get("satellites") or 0)
        return sats == 0 or sats >= 200
    except (ValueError, TypeError):
        return False


def _is_coarse_sats(sats) -> bool:
    """Same LBS/no-fix test as _is_coarse_lbs_row but on the projected
    raw->>'satellites' value (int/str/NULL) returned by _route_rows."""
    try:
        s = int(sats)
        return s == 0 or s >= 200
    except (ValueError, TypeError):
        return False


@router.post("/", response_model=PositionOut)
async def create_position(payload: PositionCreate, request: Request, db: AsyncSession = Depends(get_db)):
    # Tracker-facing write: verify the request carries a valid signature for
    # this IMEI's secret when TRACKER_AUTH_MODE=enforce (monitor logs only).
    from app.routers.controller import check_tracker
    await check_tracker(request, payload.imei, db)

    # find device via the shared resolver (exact, suffix, name, aliases)
    device = await resolve_device(db, payload.imei)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    clean_lat, clean_lon, _ = validate_coordinates(payload.latitude, payload.longitude)
    clean_speed = validate_and_sanitize_speed(payload.speed)
    clean_ts = validate_timestamp(payload.timestamp, fallback_now=datetime.utcnow())

    raw_dict = payload.raw if isinstance(payload.raw, dict) else {}
    fuel_val = raw_dict.get("fuel_level") or raw_dict.get("fuel_consumption") or raw_dict.get("fuel")
    rpm_val = raw_dict.get("rpm")
    temp_val = raw_dict.get("engine_temp") or raw_dict.get("coolant")
    batt_val = raw_dict.get("battery_voltage") or raw_dict.get("battery") or raw_dict.get("voltage")
    odo_val = raw_dict.get("odometer") or raw_dict.get("mileage")
    ign_val = raw_dict.get("ignition") if "ignition" in raw_dict else (clean_speed > 3.0 if clean_speed is not None else None)
    dtc_val = raw_dict.get("dtc_fault_codes") or raw_dict.get("dtc")

    pos = Position(
        device_id=device.id,
        latitude=clean_lat,
        longitude=clean_lon,
        speed=clean_speed,
        course=payload.course,
        timestamp=clean_ts,
        fuel_level=float(fuel_val) if fuel_val is not None else None,
        rpm=int(rpm_val) if rpm_val is not None else None,
        engine_temp=float(temp_val) if temp_val is not None else None,
        battery_voltage=float(batt_val) if batt_val is not None else None,
        odometer=float(odo_val) if odo_val is not None else None,
        ignition=bool(ign_val) if ign_val is not None else None,
        dtc_fault_codes=dtc_val,
        raw=payload.raw
    )
    db.add(pos)
    await db.commit()
    await db.refresh(pos)
    return pos

@router.post("/ingest")
async def ingest_position(payload: dict, request: Request, db: AsyncSession = Depends(get_db)):
    """
    Ingest Raw Data from Gateway
    Payload: {"raw_hex": "...", "source_ip": "..."}
    """
    import codecs
    from app.services.decoders.gps103 import GPS103Decoder # For now just hardcoded or iterated
    
    raw_hex = payload.get("raw_hex")
    if not raw_hex:
        raise HTTPException(400, "Missing raw_hex")
    
    try:
        raw_bytes = codecs.decode(raw_hex, "hex")
    except:
        raise HTTPException(400, "Invalid hex")
        
    # Attempt Decode (Multi-Protocol support)
    from app.services.decoders.sinotrack import SinotrackDecoder
    from app.services.decoders.gt06 import GT06Decoder
    
    decoders = [SinotrackDecoder(), GPS103Decoder(), GT06Decoder()]
    data = {"raw_text": raw_hex} # default
    
    for dec in decoders:
        try:
            result = await dec.decode(raw_bytes)
            if "imei" in result and ("latitude" in result or result.get("type") == "login"):
                data = result
                break
        except:
            continue
    
    # Handle Login packets (GT06)
    if data.get("type") == "login" and "imei" in data:
        print(f"Login received for device: {data['imei']}")
        return {"status": "login_ok", "imei": data["imei"]}

    # Handle Location AND OBD packets
    if "imei" in data and ("latitude" in data or data.get("type") == "obd"):
        # Tracker-facing write: enforce mode requires a valid signature for
        # this IMEI's secret before anything is written or provisioned.
        from app.routers.controller import check_tracker
        await check_tracker(request, data["imei"], db)

        # Save to DB
        # Find Device via the shared resolver so alternate identities bind
        # to the existing row instead of auto-creating a duplicate.
        device = await resolve_device(db, data["imei"])

        if not device:
            # Auto-create for Tenant 1
            print(f"AUTO-CREATING device {data['imei']} for Tenant 1")
            device = Device(imei=data["imei"], name=f"Tracker {data['imei']}", tenant_id=1)
            db.add(device)
            await db.commit()
            await db.refresh(device)
            
        # Guardrails on ingested packet
        clean_lat, clean_lon, has_coords = validate_coordinates(data.get("latitude"), data.get("longitude"))
        clean_speed = validate_and_sanitize_speed(data.get("speed", 0))
        clean_ts = validate_timestamp(data.get("gps_timestamp"), fallback_now=datetime.utcnow())

        # Sanitize for JSON
        from app.services.tcp_server import sanitize_for_json
        sanitized_data = sanitize_for_json(data)
        
        # Extract Dedicated CAN / OBD Telemetry
        fuel_val = data.get("fuel_level") or data.get("fuel_consumption") or data.get("fuel")
        rpm_val = data.get("rpm")
        temp_val = data.get("engine_temp") or data.get("coolant")
        batt_val = data.get("battery_voltage") or data.get("battery") or data.get("voltage")
        odo_val = data.get("odometer") or data.get("mileage")
        ign_val = data.get("ignition") if "ignition" in data else (clean_speed > 3.0 if clean_speed is not None else None)
        dtc_val = data.get("dtc_fault_codes") or data.get("dtc")

        pos = Position(
            device_id=device.id,
            latitude=clean_lat,
            longitude=clean_lon,
            speed=clean_speed,
            course=data.get("course", 0),
            timestamp=clean_ts,
            fuel_level=float(fuel_val) if fuel_val is not None else None,
            rpm=int(rpm_val) if rpm_val is not None else None,
            engine_temp=float(temp_val) if temp_val is not None else None,
            battery_voltage=float(batt_val) if batt_val is not None else None,
            odometer=float(odo_val) if odo_val is not None else None,
            ignition=bool(ign_val) if ign_val is not None else None,
            dtc_fault_codes=dtc_val,
            raw=sanitized_data # Store sanitized dict
        )
        db.add(pos)
        await db.commit()
        await db.refresh(pos)

        # REALTIME BROADCAST (broadcast valid coordinates or OBD updates)
        if clean_lat is not None and clean_lon is not None:
            await publish_position({
                "id": pos.id,
                "imei": device.imei,
                "tenant_id": device.tenant_id,
                "company": device.company,
                "latitude": clean_lat,
                "longitude": clean_lon,
                "speed": clean_speed,
                "timestamp": clean_ts.isoformat() + "Z",
                "raw": sanitized_data
            })

        return {"status": "ok", "id": pos.id}
        
    return {"status": "ignored", "reason": "no_gps_or_obd_data"}

@router.get("/latest/{imei}", response_model=PositionOut)
async def latest_position(
    imei: str, 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    stmt = (
        select(Position)
        .join(Device)
        .where(
            Device.imei == imei,
            Position.latitude.is_not(None),
            Position.longitude.is_not(None),
            Position.latitude != 0.0,
            Position.longitude != 0.0,
            Position.latitude.between(-90.0, 90.0),
            Position.longitude.between(-180.0, 180.0)
        )
    )
    
    # Filter by tenant unless global admin
    stmt = await scope_devices(db, current_user, stmt)
        
    q = await db.execute(stmt.order_by(Position.timestamp.desc()).limit(1))
    pos = q.scalars().first()
    if not pos:
        raise HTTPException(404, "No positions")
    return pos

@router.get("/snapshot")
async def get_fleet_snapshot(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get the latest position for ALL devices in one query.
    Enforces Guardrail 1: Strictly ignores null, (0,0) Null Island, and out-of-range coordinates."""
    from sqlalchemy import func

    # Subquery to find max timestamp per device (strictly valid coordinate rows only)
    subq = (
        select(Position.device_id, func.max(Position.timestamp).label("max_ts"))
        .where(
            Position.latitude.is_not(None),
            Position.longitude.is_not(None),
            Position.latitude != 0.0,
            Position.longitude != 0.0,
            Position.latitude.between(-90.0, 90.0),
            Position.longitude.between(-180.0, 180.0)
        )
        .group_by(Position.device_id)
        .subquery()
    )

    # Join to get full position details
    query = select(Position).join(Device).join(
        subq,
        (Position.device_id == subq.c.device_id) & (Position.timestamp == subq.c.max_ts)
    ).where(
        Position.latitude.is_not(None),
        Position.longitude.is_not(None),
        Position.latitude != 0.0,
        Position.longitude != 0.0,
        Position.latitude.between(-90.0, 90.0),
        Position.longitude.between(-180.0, 180.0)
    )
    
    # Filter by tenant unless global admin
    query = await scope_devices(db, current_user, query)
    
    result = await db.execute(query)
    positions = result.scalars().all()

    device_ids = {p.device_id for p in positions}
    last_seen_by_device = {}
    if device_ids:
        meta_rows = await db.execute(select(Device.id, Device.device_metadata).where(Device.id.in_(device_ids)))
        last_seen_by_device = {row.id: (row.device_metadata or {}).get("last_seen") for row in meta_rows}

    out = []
    for p in positions:
        lat = p.latitude
        lon = p.longitude
        course = p.course
        # If the latest row is a coarse cell-tower LBS fallback (satellites >= 200
        # or 0), pin the map coordinates to the device's most recent real GNSS
        # satellite fix so the marker never jumps to a cell tower on the highway.
        if _is_coarse_lbs_row(p.raw):
            recent_q = await db.execute(
                select(Position)
                .where(
                    Position.device_id == p.device_id,
                    Position.latitude.is_not(None),
                    Position.longitude.is_not(None),
                    Position.latitude != 0.0,
                    Position.longitude != 0.0
                )
                .order_by(Position.timestamp.desc())
                .limit(50)
            )
            for cand in recent_q.scalars().all():
                if not _is_coarse_lbs_row(cand.raw):
                    lat = cand.latitude
                    lon = cand.longitude
                    course = cand.course
                    break

        out.append({
            "id": p.id,
            "device_id": p.device_id,
            "latitude": lat,
            "longitude": lon,
            "speed": min(max(0.0, p.speed or 0.0), 200.0),
            "timestamp": _iso_utc(p.timestamp),
            "course": course,
            "raw": p.raw,
            "last_seen": last_seen_by_device.get(p.device_id)
        })
    return out

@router.get("/")
async def list_positions(
    device_id: int = None, 
    limit: int = 10, 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    query = select(Position).join(Device)
    
    # Filter by tenant unless global admin
    query = await scope_devices(db, current_user, query)
    
    if device_id:
        query = query.where(Position.device_id == device_id)
    
    query = query.order_by(Position.timestamp.desc()).limit(limit)
    
    result = await db.execute(query)
    positions = result.scalars().all()
    
    return [
        {
            "id": p.id,
            "device_id": p.device_id,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "speed": p.speed,
            "timestamp": _iso_utc(p.timestamp),
            "raw": p.raw
        }
        for p in positions
    ]

async def _route_rows(device_id: int, start_dt, end_dt, db: AsyncSession):
    """Valid GPS rows for a device in a time window, oldest first.

    Projects only raw->>'satellites' instead of the full raw JSON blob —
    on multi-day windows (10k+ rows) the raw column is the bulk of the
    query cost, and only the satellite count is consumed downstream."""
    query = select(Position.latitude, Position.longitude, Position.speed, Position.timestamp,
                   Position.raw["satellites"].as_string().label("sats")).where(
        Position.device_id == device_id,
        Position.latitude.is_not(None),
        Position.longitude.is_not(None),
        Position.latitude != 0.0,
        Position.longitude != 0.0,
        Position.latitude.between(-90.0, 90.0),
        Position.longitude.between(-180.0, 180.0)
    )
    if start_dt:
        query = query.where(Position.timestamp >= start_dt)
    if end_dt:
        query = query.where(Position.timestamp <= end_dt)
    query = query.order_by(Position.timestamp.asc())
    result = await db.execute(query)
    return result.all()


class TripMatchRequest(BaseModel):
    start: str
    end: str
    before: Optional[List[float]] = None
    after: Optional[List[float]] = None


_match_inflight: dict = {}


@router.post("/match/{device_id}")
async def match_device_trip(
    device_id: int,
    body: TripMatchRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Road-matched geometry for one trip window of a device.

    The frontend asks for one trip at a time; results are cached in
    matched_routes so a trip is only sent to the matching engine once
    (recomputed only when the underlying points change)."""
    from app.services import mapmatch
    from app.models import MatchedRoute

    device_q = await db.execute(select(Device).where(Device.id == device_id))
    device = device_q.scalars().first()
    if not device:
        raise HTTPException(404, "Device not found")
    if not await can_see_device(db, current_user, device):
        raise HTTPException(403, "Not authorized to view this device's route")

    try:
        start_dt = datetime.fromisoformat(body.start.replace('Z', '+00:00'))
        end_dt = datetime.fromisoformat(body.end.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        raise HTTPException(400, "Invalid start/end timestamps")
    if (end_dt - start_dt).total_seconds() < 0 or (end_dt - start_dt).total_seconds() > 8 * 3600:
        raise HTTPException(400, "Invalid trip window")

    rows = await _route_rows(device_id, start_dt, end_dt, db)
    points = [
        {"lat": r.latitude, "lng": r.longitude, "t": r.timestamp.timestamp()}
        for r in rows
        if r.timestamp is not None and not _is_coarse_sats(r.sats)
    ]
    # Never road-match across a data gap: the matcher would invent a road
    # between two fixes the vehicle did not drive between, and the client draws
    # that invented road as a long straight line across the country.
    for i in range(1, len(points)):
        if _is_track_gap(points[i - 1]["t"], points[i - 1]["lat"], points[i - 1]["lng"],
                         points[i]["t"], points[i]["lat"], points[i]["lng"]):
            return {"segments": [], "matched": False, "engine": "gap"}

    if len(points) < 2:
        return {"segments": [], "matched": False, "engine": "none"}

    fingerprint = mapmatch.trip_fingerprint(points, mapmatch.engine_params_version())
    key = (device_id, start_dt, end_dt)

    cached = await db.execute(
        select(MatchedRoute).where(
            MatchedRoute.device_id == device_id,
            MatchedRoute.start_ts == start_dt,
            MatchedRoute.end_ts == end_dt
        )
    )
    row = cached.scalars().first()
    if row and row.fingerprint == fingerprint:
        return {"segments": row.segments, "matched": True, "engine": row.engine, "cached": True}

    if key not in _match_inflight:
        async def _do_match():
            try:
                return await mapmatch.match_trip_shape(points, before=body.before, after=body.after)
            finally:
                _match_inflight.pop(key, None)
        _match_inflight[key] = asyncio.ensure_future(_do_match())

    result = await _match_inflight[key]
    if result is None:
        return {"segments": [], "matched": False, "engine": "unavailable"}

    if row:
        row.fingerprint = fingerprint
        row.segments = result["segments"]
        row.engine = "valhalla"
    else:
        db.add(MatchedRoute(
            device_id=device_id, start_ts=start_dt, end_ts=end_dt,
            fingerprint=fingerprint, segments=result["segments"], engine="valhalla"
        ))
    await db.commit()

    return {"segments": result["segments"], "matched": result["matched"], "engine": "valhalla"}


@router.get("/routes/{device_id}")
async def get_device_route(
    device_id: int,
    start_date: str = None,
    end_date: str = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get route data for a device with optional date filtering"""
    # Verify access to device
    device_q = await db.execute(select(Device).where(Device.id == device_id))
    device = device_q.scalars().first()
    if not device:
        raise HTTPException(404, "Device not found")
        
    if not await can_see_device(db, current_user, device):
        raise HTTPException(403, "Not authorized to view this device's route")

    from datetime import datetime
    from app.services.data_guardrails import haversine_distance_km
    
    start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00')) if start_date else None
    end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00')) if end_date else None
    positions = await _route_rows(device_id, start_dt, end_dt, db)

    # Coarse LBS rows are cell-tower guesses 500 m - 8 km off the real fix, so
    # they are pinned to the last real GNSS position instead of being drawn.
    fixes = []
    last_gnss = None
    for p in positions:
        if _is_coarse_sats(p.sats):
            if last_gnss is None:
                continue
            lat, lng, speed = last_gnss[0], last_gnss[1], 0.0
        else:
            lat, lng = p.latitude, p.longitude
            last_gnss = (lat, lng)
            speed = min(max(0.0, p.speed or 0.0), TRACK_MAX_KMH)
        fixes.append({"lat": lat, "lng": lng, "timestamp": p.timestamp, "speed": speed})

    # One shared scan builds the whole day: it drops impossible fixes, banks
    # distance only where the vehicle provably moved, ends the track at a real
    # silence and returns the segments the client renders. The strip total, the
    # trip cards and the max speed all come from this one result, which is why
    # they can no longer disagree with each other or with the marker popup.
    track = analyze_track(fixes)

    def _out(q, with_break=False):
        item = {
            "lat": q["lat"],
            "lng": q["lng"],
            "timestamp": _iso_utc(q["timestamp"]),
            "speed": q["speed"],
        }
        if with_break and q.get("break"):
            item["break"] = True
        return item

    return {
        "device_id": device_id,
        "points": [_out(q, True) for q in track["points"]],
        "segments": [
            {
                "kind": seg["kind"],
                "distance_km": seg["distance_km"],
                "max_speed_kmh": seg["max_speed_kmh"],
                "points": [_out(q) for q in seg["points"]],
            }
            for seg in track["segments"]
        ],
        "total_distance_km": track["distance_km"],
        "max_speed_kmh": track["max_speed_kmh"],
        "total_points": len(track["points"]),
    }

@router.get("/trips/{device_id}")
async def get_device_trips(
    device_id: int,
    days: int = 7,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get trip summary for last N days"""
    # Verify access to device
    device_q = await db.execute(select(Device).where(Device.id == device_id))
    device = device_q.scalars().first()
    if not device:
        raise HTTPException(404, "Device not found")
        
    if not await can_see_device(db, current_user, device):
        raise HTTPException(403, "Not authorized to view this device's trips")

    from datetime import datetime, timedelta
    
    start_date = datetime.utcnow() - timedelta(days=days)
    
    query = select(Position).where(
        Position.device_id == device_id,
        Position.timestamp >= start_date
    ).order_by(Position.timestamp.asc())
    
    result = await db.execute(query)
    positions = result.scalars().all()
    
    if not positions:
        return {"device_id": device_id, "trips": [], "total_trips": 0}
    
    # Group positions into trips (simple: gap > 30 min = new trip)
    trips = []
    current_trip = []
    
    for i, pos in enumerate(positions):
        if i == 0:
            current_trip.append(pos)
        else:
            time_gap = (pos.timestamp - positions[i-1].timestamp).total_seconds() / 60
            if time_gap > 30:  # 30 minute gap = new trip
                if current_trip:
                    trips.append(current_trip)
                current_trip = [pos]
            else:
                current_trip.append(pos)
    
    if current_trip:
        trips.append(current_trip)
    
    # Calculate trip summaries
    trip_summaries = []
    for trip_positions in trips:
        if len(trip_positions) < 2:
            continue
            
        start_pos = trip_positions[0]
        end_pos = trip_positions[-1]
        duration = (end_pos.timestamp - start_pos.timestamp).total_seconds() / 60  # minutes
        
        # Calculate distance and harsh events
        total_distance = 0
        harsh_events = []
        for i in range(1, len(trip_positions)):
            from math import radians, cos, sin, asin, sqrt
            prev = trip_positions[i-1]
            curr = trip_positions[i]

            if None in (prev.latitude, prev.longitude, curr.latitude, curr.longitude):
                continue
            if _is_track_gap(prev.timestamp, prev.latitude, prev.longitude,
                             curr.timestamp, curr.latitude, curr.longitude):
                continue
            
            # Distance
            lon1, lat1, lon2, lat2 = map(radians, [prev.longitude, prev.latitude, curr.longitude, curr.latitude])
            dlon = lon2 - lon1
            dlat = lat2 - lat1
            a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
            c = 2 * asin(sqrt(max(0, min(1, a))))
            km = 6371 * c
            total_distance += km

            # Harsh Driving Detection
            delta_speed = (curr.speed or 0) - (prev.speed or 0)
            delta_time = (curr.timestamp - prev.timestamp).total_seconds()
            
            if 0 < delta_time <= 15: # 15s window
                accel = delta_speed / delta_time
                if accel > 10: # >10 km/h per sec
                    harsh_events.append({"type": "Harsh Accel", "value": round(accel, 1), "time": curr.timestamp.isoformat()})
                elif accel < -12: # <-12 km/h per sec
                    harsh_events.append({"type": "Harsh Braking", "value": round(accel, 1), "time": curr.timestamp.isoformat()})
        
        trip_summaries.append({
            "start_time": start_pos.timestamp.isoformat(),
            "end_time": end_pos.timestamp.isoformat(),
            "duration_minutes": round(duration, 1),
            "distance_km": round(total_distance, 2),
            "harsh_events_count": len(harsh_events),
            "harsh_events": harsh_events,
            "start_location": {"lat": start_pos.latitude, "lng": start_pos.longitude},
            "end_location": {"lat": end_pos.latitude, "lng": end_pos.longitude},
            "points_count": len(trip_positions)
        })
    
    return {
        "device_id": device_id,
        "trips": trip_summaries,
        "total_trips": len(trip_summaries),
        "period_days": days
    }

# --- Fleet performance analytics -------------------------------------------
# These series feed the Fleet Performance tab. They used to count a hop only
# when the device claimed more than 3 km/h, drop every leg longer than 5 km
# and never measure idling or speeding at all, so the tab's distance
# disagreed with Route History and its "Safety Rating" was a default string.
# They now run the same analyze_track the strip draws and report per-bucket
# figures plus the measurements the metric cards quote.
PERF_SPEED_LIMIT_KMH = 120.0
PERF_MAX_LEG_SECONDS = 600.0

async def _perf_rows(device_ids, fetch_start, db, current_user):
    """Only the columns the aggregation reads.

    The `raw` JSON blob is the bulk of a position row; a week of a truck
    reporting every three seconds is ~80k rows, and loading the whole ORM row
    for each one is what made this endpoint time out.
    """
    stmt = (
        select(
            Position.device_id,
            Position.latitude,
            Position.longitude,
            Position.speed,
            Position.timestamp,
            Position.ignition,
            Position.raw["satellites"].as_string().label("sats"),
            Position.raw["fuel_consumption"].as_string().label("fuel_rate"),
        )
        .join(Device)
        .where(Position.timestamp >= fetch_start)
    )
    if device_ids is not None:
        stmt = stmt.where(Position.device_id.in_(device_ids))
    stmt = await scope_devices(db, current_user, stmt)
    stmt = stmt.order_by(Position.device_id, Position.timestamp.asc())
    return (await db.execute(stmt)).all()


def _perf_buckets(rows, bucket_of, tz_offset):
    """Bank each device-day's cleaned track into the chart buckets.

    Distance, moving time, idling and speeding all come from `analyze_track`,
    the same scan Route History draws, so this tab and the map quote one set
    of numbers instead of two that disagree.
    """
    by_day = {}
    for r in rows:
        if r.timestamp is None or r.latitude is None or r.longitude is None:
            continue
        if abs(r.latitude) < 0.0001 or abs(r.longitude) < 0.0001:
            continue
        by_day.setdefault((r.device_id, (r.timestamp + tz_offset).date()), []).append(r)

    totals = {"km": 0.0, "drive_s": 0.0, "idle_s": 0.0, "speeding_s": 0.0,
              "speeding": 0, "fuel": 0.0}
    fuel_reported = False
    buckets = {}

    for (_device_id, _day), day_rows in by_day.items():
        fixes = []
        ign = {}
        last_gnss = None
        rates = []
        for r in day_rows:
            ign[r.timestamp] = r.ignition
            try:
                rate = float(r.fuel_rate)
                if 0.0 < rate < 100.0:
                    rates.append(rate)
            except (TypeError, ValueError, AttributeError):
                pass
            if _is_coarse_sats(r.sats):
                if last_gnss is None:
                    continue
                lat, lng, speed = last_gnss[0], last_gnss[1], 0.0
            else:
                last_gnss = (r.latitude, r.longitude)
                lat, lng = r.latitude, r.longitude
                speed = min(max(0.0, r.speed or 0.0), TRACK_MAX_KMH)
            fixes.append({"lat": lat, "lng": lng, "timestamp": r.timestamp, "speed": speed})

        track = analyze_track(fixes)
        rate = (sum(rates) / len(rates)) if rates else None
        if rate is not None:
            fuel_reported = True

        prev = None
        over = False
        for p in track["points"]:
            b = bucket_of(p["timestamp"])
            in_range = b is not None
            if in_range and b not in buckets:
                buckets[b] = {"km": 0.0, "drive_s": 0.0, "idle_s": 0.0,
                              "speeding_s": 0.0, "speeding": 0, "fuel": 0.0}
            if prev is not None and not p["break"]:
                dt = _seconds_between(prev["timestamp"], p["timestamp"])
                km = haversine_distance_km(prev["lat"], prev["lng"], p["lat"], p["lng"])
                if 0 < dt <= PERF_MAX_LEG_SECONDS:
                    if p["speed"] > TRACK_STOP_KMH:
                        totals["drive_s"] += dt
                        if in_range:
                            buckets[b]["drive_s"] += dt
                    elif ign.get(p["timestamp"]):
                        totals["idle_s"] += dt
                        if in_range:
                            buckets[b]["idle_s"] += dt
                    if p["speed"] > PERF_SPEED_LIMIT_KMH:
                        totals["speeding_s"] += dt
                        if in_range:
                            buckets[b]["speeding_s"] += dt
                if km > 0:
                    totals["km"] += km
                    if in_range:
                        buckets[b]["km"] += km
                    if rate is not None:
                        litres = km * rate / 100.0
                        totals["fuel"] += litres
                        if in_range:
                            buckets[b]["fuel"] += litres
            if p["break"]:
                over = False
            elif p["speed"] > PERF_SPEED_LIMIT_KMH:
                if not over:
                    totals["speeding"] += 1
                    if in_range:
                        buckets[b]["speeding"] += 1
                over = True
            else:
                over = False
            prev = p

    return buckets, totals, fuel_reported


def _perf_series(buckets, keys, field):
    return [round(buckets.get(k, {}).get(field, 0.0), 2) for k in keys]


def _perf_payload(labels, keys, buckets, totals, fuel_reported, device_count):
    drive_hours = totals["drive_s"] / 3600.0
    avg_speed = round(totals["km"] / drive_hours, 1) if drive_hours > 0 else 0.0
    if totals["drive_s"] > 0:
        # Share of driving time spent at or below the limit — a measured
        # figure, not a default string shown while there is no data.
        safety = max(0.0, min(100.0, round(100.0 * (1.0 - totals["speeding_s"] / totals["drive_s"]), 1)))
    else:
        safety = None

    return {
        "labels": labels,
        "distance_series": _perf_series(buckets, keys, "km"),
        "drive_hours_series": [round(buckets.get(k, {}).get("drive_s", 0.0) / 3600.0, 2) for k in keys],
        "idle_hours_series": [round(buckets.get(k, {}).get("idle_s", 0.0) / 3600.0, 2) for k in keys],
        "speeding_events_series": [buckets.get(k, {}).get("speeding", 0) for k in keys],
        "fuel_liters_series": _perf_series(buckets, keys, "fuel") if fuel_reported else None,
        "total_km": round(totals["km"], 1),
        "drive_hours": round(drive_hours, 1),
        "idle_hours": round(totals["idle_s"] / 3600.0, 1),
        "avg_speed": avg_speed,
        "max_speed": 0,
        "speeding_events": totals["speeding"],
        "fuel_liters": round(totals["fuel"], 1) if fuel_reported else None,
        "safety_score": safety,
        "speed_limit_kmh": PERF_SPEED_LIMIT_KMH,
        "devices_count": device_count,
    }


async def _perf_response(period, start, end, device_ids, db, current_user):
    tz_offset = timedelta(hours=2)
    now_zim = datetime.utcnow() + tz_offset
    today = now_zim.date()

    if period == "custom" and start and end:
        try:
            d0 = datetime.strptime(start, "%Y-%m-%d").date()
            d1 = datetime.strptime(end, "%Y-%m-%d").date()
        except Exception:
            d0 = d1 = today
        if d1 < d0:
            d0, d1 = d1, d0
        if (d1 - d0).days > 89:
            d0 = d1 - timedelta(days=89)
        days = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]
    elif period == "weekly":
        days = [today - timedelta(days=i) for i in range(6, -1, -1)]
    elif period == "monthly":
        days = [today - timedelta(days=i) for i in range(29, -1, -1)]
    else:
        days = [today]

    fetch_start = datetime.combine(days[0], datetime.min.time()) - tz_offset
    rows = await _perf_rows(device_ids, fetch_start, db, current_user)

    if len(days) == 1 and days[0] == today:
        current = (now_zim.hour * 2) + (1 if now_zim.minute >= 30 else 0)
        keys = list(range(current + 1))
        labels = ["{:02d}:{}".format(k // 2, "30" if k % 2 else "00") for k in keys]

        def bucket_of(ts):
            z = ts + tz_offset
            if z.date() != today:
                return None
            idx = (z.hour * 2) + (1 if z.minute >= 30 else 0)
            return idx if idx <= current else None
    else:
        day_index = {d: i for i, d in enumerate(days)}
        keys = list(range(len(days)))
        labels = [d.strftime("%b %d") for d in days]

        def bucket_of(ts):
            return day_index.get((ts + tz_offset).date())

    buckets, totals, fuel_reported = _perf_buckets(rows, bucket_of, tz_offset)
    device_count = len({r.device_id for r in rows}) if device_ids is None else 1
    return _perf_payload(labels, keys, buckets, totals, fuel_reported, device_count)


@router.get("/analytics/fleet")
async def get_fleet_analytics(
    period: str = "daily",
    start: str = None,
    end: str = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Mileage, moving/idle hours, speeding and fuel across the whole fleet."""
    return await _perf_response(period, start, end, None, db, current_user)


@router.get("/analytics/device/{device_id}/chart")
async def get_device_chart_analytics(
    device_id: int,
    period: str = "daily",
    start: str = None,
    end: str = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """The same performance series for one device."""
    device_q = await db.execute(select(Device).where(Device.id == device_id))
    device = device_q.scalars().first()
    if not device:
        raise HTTPException(404, "Device not found")
    if not await can_see_device(db, current_user, device):
        raise HTTPException(403, "Not authorized to view this device's performance")
    return await _perf_response(period, start, end, [device_id], db, current_user)


@router.get("/analytics/device/{device_id}/daily")
async def get_device_daily_mileage(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get today's mileage and all-time total mileage for a device (Zimbabwean Time)"""
    from sqlalchemy import select
    from datetime import datetime, timedelta

    # Zimbabwe is UTC+2
    tz_offset = timedelta(hours=2)
    now_zim = datetime.utcnow() + tz_offset

    # Single ordered scan of the device's full position history — the same row
    # set feeds both the all-time total and today's subset so the numbers can
    # never disagree with each other or with Route History.
    stmt = (
        select(Position)
        .join(Device)
        .where(Position.device_id == device_id)
        .order_by(Position.timestamp.asc())
    )

    stmt = await scope_devices(db, current_user, stmt)

    result = await db.execute(stmt)
    positions = result.scalars().all()

    from app.services.data_guardrails import haversine_distance_km

    valid_all = [
        p for p in positions
        if p.latitude is not None and p.longitude is not None
        and abs(p.latitude) > 0.0001 and abs(p.longitude) > 0.0001
    ]

    def _accumulate_distance(rows):
        """Same clean-up and banking as get_device_route. The popup's 'Today'
        figure and Route History's distance therefore come from one scan with
        one set of rules, instead of two that disagreed by tens of kilometres."""
        fixes = []
        last = None
        for p in rows:
            if _is_coarse_lbs_row(p.raw):
                if last is None:
                    continue
                lat, lng, speed = last[0], last[1], 0.0
            else:
                lat, lng = p.latitude, p.longitude
                last = (lat, lng)
                speed = p.speed or 0.0
            fixes.append({"lat": lat, "lng": lng, "timestamp": p.timestamp, "speed": speed})
        return analyze_track(fixes)["distance_km"]

    total_mileage = _accumulate_distance(valid_all)

    today_rows = [
        p for p in valid_all
        if (p.timestamp + tz_offset).date() == now_zim.date()
    ]
    daily_mileage = _accumulate_distance(today_rows)

    return {
        "device_id": device_id,
        "daily_mileage": round(daily_mileage, 1),
        "total_mileage": round(total_mileage, 1)
    }
