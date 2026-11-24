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

@router.get("/analytics/fleet")
async def get_fleet_analytics(
    period: str = "daily",
    start: str = None,
    end: str = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get aggregated mileage and active hours for the entire fleet (Daily/Weekly/Monthly/Custom)"""
    from sqlalchemy import select
    from datetime import datetime, timedelta
    
    # Zimbabwe is UTC+2
    tz_offset = timedelta(hours=2)
    now_zim = datetime.utcnow() + tz_offset
    
    if period == "weekly":
        days_to_fetch = 7
        zim_start = (now_zim - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "monthly":
        days_to_fetch = 30
        zim_start = (now_zim - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "custom" and start and end:
        try:
            zim_start = datetime.strptime(start, "%Y-%m-%d").replace(hour=0, minute=0, second=0, microsecond=0)
            zim_end = datetime.strptime(end, "%Y-%m-%d").replace(hour=23, minute=59, second=59, microsecond=999999)
            if zim_end < zim_start:
                zim_start, zim_end = zim_end, zim_start
            days_to_fetch = (zim_end.date() - zim_start.date()).days + 1
            if days_to_fetch > 90: # Cap at 90 days for performance
                days_to_fetch = 90
        except:
            days_to_fetch = 1
            zim_start = now_zim.replace(hour=0, minute=0, second=0, microsecond=0)
    else: # daily
        days_to_fetch = 1
        zim_start = now_zim.replace(hour=0, minute=0, second=0, microsecond=0)
    
    # Query all positions for the range (fetch wide to cover Zim transition)
    # Only fetch the columns we actually need — the `raw` JSON column is large
    # and loading full ORM rows for thousands of positions caused timeouts.
    fetch_start = zim_start - tz_offset

    stmt = (
        select(
            Position.device_id,
            Position.latitude,
            Position.longitude,
            Position.speed,
            Position.timestamp
        )
        .join(Device)
        .where(Position.timestamp >= fetch_start)
    )

    stmt = await scope_devices(db, current_user, stmt)

    stmt = stmt.order_by(Position.timestamp.asc())

    result = await db.execute(stmt)
    positions = result.all()
    
    labels = []
    mileage_data = []
    hours_data = []
    
    if period == "daily":
        # 30-min buckets for today
        buckets = {i: {"distance": 0, "active_seconds": 0} for i in range(48)}
        last_positions = {}
        
        for p in positions:
            if p.latitude is None or p.longitude is None: continue
            p_zim = p.timestamp + tz_offset
            if p_zim.date() != now_zim.date(): continue
            
            bucket_idx = (p_zim.hour * 2) + (1 if p_zim.minute >= 30 else 0)
            
            if p.device_id in last_positions:
                prev = last_positions[p.device_id]
                # Haversine distance
                from math import radians, cos, sin, asin, sqrt
                lon1, lat1, lon2, lat2 = map(radians, [prev.longitude, prev.latitude, p.longitude, p.latitude])
                a = sin((lat2-lat1)/2)**2 + cos(lat1) * cos(lat2) * sin((lon2-lon1)/2)**2
                c = 2 * asin(sqrt(max(0, min(1, a))))
                km = 6371 * c
                
                if 0 < km < 5 and p.speed is not None and p.speed > 3:
                    buckets[bucket_idx]["distance"] += km
                
                if p.speed is not None and p.speed > 3: # Check for None before comparison
                    gap = (p.timestamp - prev.timestamp).total_seconds()
                    if 0 < gap < 600: buckets[bucket_idx]["active_seconds"] += gap
            
            last_positions[p.device_id] = p

        cum_mileage = 0
        cum_active_seconds = 0
        current_zim_bucket = (now_zim.hour * 2) + (1 if now_zim.minute >= 30 else 0)
        
        for i in range(current_zim_bucket + 1):
            h = i // 2
            m = "30" if i % 2 else "00"
            labels.append(f"{h:02d}:{m}")
            cum_mileage += buckets[i]["distance"]
            cum_active_seconds += buckets[i]["active_seconds"]
            mileage_data.append(round(cum_mileage, 1))
            hours_data.append(round(cum_active_seconds / 3600, 1))
            
    else:
        # Daily buckets for Weekly/Monthly
        buckets = {}
        for i in range(days_to_fetch):
            day = (zim_start + timedelta(days=i)).date()
            buckets[day] = {"distance": 0, "active_seconds": 0}
            
        last_positions = {}
        for p in positions:
            if p.latitude is None or p.longitude is None: continue
            p_zim = (p.timestamp + tz_offset)
            p_date = p_zim.date()
            
            if p_date not in buckets: continue
            
            if p.device_id in last_positions:
                prev = last_positions[p.device_id]
                if (p.timestamp + tz_offset).date() == (prev.timestamp + tz_offset).date():
                    from math import radians, cos, sin, asin, sqrt
                    lon1, lat1, lon2, lat2 = map(radians, [prev.longitude, prev.latitude, p.longitude, p.latitude])
                    a = sin((lat2-lat1)/2)**2 + cos(lat1) * cos(lat2) * sin((lon2-lon1)/2)**2
                    c = 2 * asin(sqrt(max(0, min(1, a))))
                    km = 6371 * c
                    
                    if 0 < km < 10 and p.speed is not None and p.speed > 3:
                        buckets[p_date]["distance"] += km
                    
                    if p.speed is not None and p.speed > 3: # Check for None before comparison
                        gap = (p.timestamp - prev.timestamp).total_seconds()
                        if 0 < gap < 600: buckets[p_date]["active_seconds"] += gap
            
            last_positions[p.device_id] = p
            
        # Cumulative transform
        cum_mileage = 0
        cum_active_seconds = 0
        # Sort buckets by date to ensure correct cumulative calculation
        sorted_dates = sorted(buckets.keys())
        for date in sorted_dates:
            val = buckets[date]
            labels.append(date.strftime("%b %d"))
            cum_mileage += val["distance"]
            cum_active_seconds += val["active_seconds"]
            mileage_data.append(round(cum_mileage, 1))
            hours_data.append(round(cum_active_seconds / 3600, 1))

    return {
        "labels": labels,
        "mileage": mileage_data,
        "hours": hours_data
    }

@router.get("/analytics/device/{device_id}/chart")
async def get_device_chart_analytics(
    device_id: int,
    period: str = "daily",
    start: str = None,
    end: str = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get mileage and active hours chart data for a single device (Daily/Weekly/Monthly/Custom)."""
    from sqlalchemy import select
    from datetime import datetime, timedelta
    from math import radians, cos, sin, asin, sqrt

    tz_offset = timedelta(hours=2)
    now_zim = datetime.utcnow() + tz_offset

    if period == "weekly":
        days_to_fetch = 7
        zim_start = (now_zim - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "monthly":
        days_to_fetch = 30
        zim_start = (now_zim - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "custom" and start and end:
        try:
            zim_start = datetime.strptime(start, "%Y-%m-%d").replace(hour=0, minute=0, second=0, microsecond=0)
            zim_end = datetime.strptime(end, "%Y-%m-%d").replace(hour=23, minute=59, second=59, microsecond=999999)
            if zim_end < zim_start:
                zim_start, zim_end = zim_end, zim_start
            days_to_fetch = (zim_end.date() - zim_start.date()).days + 1
            if days_to_fetch > 90:
                days_to_fetch = 90
        except Exception:
            days_to_fetch = 1
            zim_start = now_zim.replace(hour=0, minute=0, second=0, microsecond=0)
    else:  # daily
        days_to_fetch = 1
        zim_start = now_zim.replace(hour=0, minute=0, second=0, microsecond=0)

    fetch_start = zim_start - tz_offset

    stmt = (
        select(
            Position.device_id,
            Position.latitude,
            Position.longitude,
            Position.speed,
            Position.timestamp
        )
        .join(Device)
        .where(Position.device_id == device_id)
        .where(Position.timestamp >= fetch_start)
    )

    stmt = await scope_devices(db, current_user, stmt)

    stmt = stmt.order_by(Position.timestamp.asc())
    result = await db.execute(stmt)
    positions = result.all()

    labels = []
    mileage_data = []
    hours_data = []

    if period == "daily":
        buckets = {i: {"distance": 0, "active_seconds": 0} for i in range(48)}
        last_pos = None

        for p in positions:
            if p.latitude is None or p.longitude is None:
                continue
            p_zim = p.timestamp + tz_offset
            if p_zim.date() != now_zim.date():
                continue
            bucket_idx = (p_zim.hour * 2) + (1 if p_zim.minute >= 30 else 0)

            if last_pos:
                lon1, lat1, lon2, lat2 = map(radians, [last_pos.longitude, last_pos.latitude, p.longitude, p.latitude])
                a = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
                km = 6371 * 2 * asin(sqrt(max(0, min(1, a))))
                if 0 < km < 5 and p.speed is not None and p.speed > 3:
                    buckets[bucket_idx]["distance"] += km
                if p.speed is not None and p.speed > 3:
                    gap = (p.timestamp - last_pos.timestamp).total_seconds()
                    if 0 < gap < 600:
                        buckets[bucket_idx]["active_seconds"] += gap
            last_pos = p

        cum_mileage = 0
        cum_active_seconds = 0
        current_bucket = (now_zim.hour * 2) + (1 if now_zim.minute >= 30 else 0)
        for i in range(current_bucket + 1):
            h = i // 2
            m = "30" if i % 2 else "00"
            labels.append(f"{h:02d}:{m}")
            cum_mileage += buckets[i]["distance"]
            cum_active_seconds += buckets[i]["active_seconds"]
            mileage_data.append(round(cum_mileage, 1))
            hours_data.append(round(cum_active_seconds / 3600, 1))
    else:
        buckets = {}
        for i in range(days_to_fetch):
            day = (zim_start + timedelta(days=i)).date()
            buckets[day] = {"distance": 0, "active_seconds": 0}

        last_pos = None
        for p in positions:
            if p.latitude is None or p.longitude is None:
                continue
            p_zim = p.timestamp + tz_offset
            p_date = p_zim.date()
            if p_date not in buckets:
                continue
            if last_pos and (last_pos.timestamp + tz_offset).date() == p_date:
                lon1, lat1, lon2, lat2 = map(radians, [last_pos.longitude, last_pos.latitude, p.longitude, p.latitude])
                a = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
                km = 6371 * 2 * asin(sqrt(max(0, min(1, a))))
                if 0 < km < 10 and p.speed is not None and p.speed > 3:
                    buckets[p_date]["distance"] += km
                if p.speed is not None and p.speed > 3:
                    gap = (p.timestamp - last_pos.timestamp).total_seconds()
                    if 0 < gap < 600:
                        buckets[p_date]["active_seconds"] += gap
            last_pos = p

        cum_mileage = 0
        cum_active_seconds = 0
        for date in sorted(buckets.keys()):
            val = buckets[date]
            labels.append(date.strftime("%b %d"))
            cum_mileage += val["distance"]
            cum_active_seconds += val["active_seconds"]
            mileage_data.append(round(cum_mileage, 1))
            hours_data.append(round(cum_active_seconds / 3600, 1))

    return {"labels": labels, "mileage": mileage_data, "hours": hours_data}


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
