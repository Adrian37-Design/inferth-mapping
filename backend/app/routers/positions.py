from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import Position, Device, User
from app.schemas import PositionCreate, PositionOut
from app.auth_middleware import get_current_user
from sqlalchemy.future import select
from datetime import datetime
from app.realtime import publish_position

router = APIRouter(prefix="/positions")

@router.post("/", response_model=PositionOut)
async def create_position(payload: PositionCreate, db: AsyncSession = Depends(get_db)):
    # find device by IMEI
    q = await db.execute(select(Device).where(Device.imei == payload.imei))
    device = q.scalars().first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    pos = Position(
        device_id=device.id,
        latitude=payload.latitude,
        longitude=payload.longitude,
        speed=payload.speed,
        course=payload.course,
        timestamp=payload.timestamp or datetime.utcnow(),
        raw=payload.raw
    )
    db.add(pos)
    await db.commit()
    await db.refresh(pos)
    db.add(pos)
    await db.commit()
    await db.refresh(pos)
    # publish to redis (realtime) - omitted here; call publish_position(pos)
    return pos

@router.post("/ingest")
async def ingest_position(payload: dict, db: AsyncSession = Depends(get_db)):
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
        # Save to DB
        # Find Device
        device_q = await db.execute(select(Device).where(Device.imei == data["imei"]))
        device = device_q.scalars().first()
        
        if not device:
            # Auto-create for Tenant 1
            print(f"AUTO-CREATING device {data['imei']} for Tenant 1")
            device = Device(imei=data["imei"], name=f"Tracker {data['imei']}", tenant_id=1)
            db.add(device)
            await db.commit()
            await db.refresh(device)
            
        # Sanitize for JSON
        from app.services.tcp_server import sanitize_for_json
        sanitized_data = sanitize_for_json(data)
        
        pos = Position(
            device_id=device.id,
            latitude=data.get("latitude"),
            longitude=data.get("longitude"),
            speed=data.get("speed", 0),
            course=data.get("course", 0),
            timestamp=datetime.utcnow(),
            raw=sanitized_data # Store sanitized dict
        )
        db.add(pos)
        await db.commit()
        await db.refresh(pos)

        # REALTIME BROADCAST
        await publish_position({
            "id": pos.id,
            "imei": device.imei,
            "latitude": pos.latitude,
            "longitude": pos.longitude,
            "speed": pos.speed,
            "timestamp": pos.timestamp.isoformat() + "Z",
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
    stmt = select(Position).join(Device).where(Device.imei == imei)
    
    # Filter by tenant unless global admin
    if current_user.tenant_id != 1:
        stmt = stmt.where(Device.tenant_id == current_user.tenant_id)
        
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
    """Get the latest position for ALL devices in one query"""
    from sqlalchemy import func
    
    # Subquery to find max timestamp per device
    subq = (
        select(Position.device_id, func.max(Position.timestamp).label("max_ts"))
        .group_by(Position.device_id)
        .subquery()
    )
    
    # Join to get full position details
    query = select(Position).join(Device).join(
        subq, 
        (Position.device_id == subq.c.device_id) & (Position.timestamp == subq.c.max_ts)
    )
    
    # Filter by tenant unless global admin
    if current_user.tenant_id != 1:
        query = query.where(Device.tenant_id == current_user.tenant_id)
    
    result = await db.execute(query)
    positions = result.scalars().all()
    
    return [
        {
            "id": p.id,
            "device_id": p.device_id,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "speed": p.speed,
            "timestamp": p.timestamp,
            "course": p.course,
            "raw": p.raw
        }
        for p in positions
    ]

@router.get("/")
async def list_positions(
    device_id: int = None, 
    limit: int = 10, 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    query = select(Position).join(Device)
    
    # Filter by tenant unless global admin
    if current_user.tenant_id != 1:
        query = query.where(Device.tenant_id == current_user.tenant_id)
    
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
            "timestamp": p.timestamp,
            "raw": p.raw
        }
        for p in positions
    ]

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
        
    if current_user.tenant_id != 1 and device.tenant_id != current_user.tenant_id:
        raise HTTPException(403, "Not authorized to view this device's route")

    from datetime import datetime
    
    query = select(Position).where(
        Position.device_id == device_id,
        Position.latitude.is_not(None),
        Position.longitude.is_not(None)
    )
    
    # Add date filtering
    if start_date:
        start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00'))
        query = query.where(Position.timestamp >= start_dt)
    
    if end_date:
        end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00'))
        query = query.where(Position.timestamp <= end_dt)
    
    query = query.order_by(Position.timestamp.asc())
    
    result = await db.execute(query)
    positions = result.scalars().all()
    
    # Calculate route with distance
    route_points = []
    total_distance = 0
    
    for i, p in enumerate(positions):
        point = {
            "lat": p.latitude,
            "lng": p.longitude,
            "timestamp": p.timestamp.isoformat(),
            "speed": p.speed or 0
        }
        
        # Calculate distance from previous point
        if i > 0:
            from math import radians, cos, sin, asin, sqrt
            prev = positions[i-1]
            
            # Haversine formula for distance
            lon1, lat1, lon2, lat2 = map(radians, [prev.longitude, prev.latitude, p.longitude, p.latitude])
            dlon = lon2 - lon1
            dlat = lat2 - lat1
            a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
            c = 2 * asin(sqrt(a))
            km = 6371 * c  # Radius of earth in kilometers
            total_distance += km
        
        route_points.append(point)
    
    return {
        "device_id": device_id,
        "points": route_points,
        "total_distance_km": round(total_distance, 2),
        "total_points": len(route_points)
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
        
    if current_user.tenant_id != 1 and device.tenant_id != current_user.tenant_id:
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
        
        # Calculate distance
        total_distance = 0
        for i in range(1, len(trip_positions)):
            from math import radians, cos, sin, asin, sqrt
            prev = trip_positions[i-1]
            curr = trip_positions[i]
            
            lon1, lat1, lon2, lat2 = map(radians, [prev.longitude, prev.latitude, curr.longitude, curr.latitude])
            dlon = lon2 - lon1
            dlat = lat2 - lat1
            a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
            c = 2 * asin(sqrt(a))
            km = 6371 * c
            total_distance += km
        
        trip_summaries.append({
            "start_time": start_pos.timestamp.isoformat(),
            "end_time": end_pos.timestamp.isoformat(),
            "duration_minutes": round(duration, 1),
            "distance_km": round(total_distance, 2),
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
    fetch_start = zim_start - tz_offset
    
    stmt = (
        select(Position)
        .join(Device)
        .where(Position.timestamp >= fetch_start)
    )
    
    if current_user.tenant_id != 1:
        stmt = stmt.where(Device.tenant_id == current_user.tenant_id)
        
    stmt = stmt.order_by(Position.timestamp.asc())
    
    result = await db.execute(stmt)
    positions = result.scalars().all()
    
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
                
                if 0 < km < 5: buckets[bucket_idx]["distance"] += km
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
                    
                    if 0 < km < 10: buckets[p_date]["distance"] += km
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

@router.get("/analytics/device/{device_id}/daily")
async def get_device_daily_mileage(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get the total mileage for a specific device today (Zimbabwean Time)"""
    from sqlalchemy import select
    from datetime import datetime, timedelta
    from math import radians, cos, sin, asin, sqrt
    
    # Zimbabwe is UTC+2
    tz_offset = timedelta(hours=2)
    now_zim = datetime.utcnow() + tz_offset
    zim_today_start = now_zim.replace(hour=0, minute=0, second=0, microsecond=0)
    
    # Fetch start in UTC
    fetch_start = zim_today_start - tz_offset
    
    # Query positions
    stmt = (
        select(Position)
        .join(Device)
        .where(Position.device_id == device_id)
        .where(Position.timestamp >= fetch_start)
    )
    
    if current_user.tenant_id != 1:
        stmt = stmt.where(Device.tenant_id == current_user.tenant_id)
        
    stmt = stmt.order_by(Position.timestamp.asc())
    
    result = await db.execute(stmt)
    positions = result.scalars().all()
    
    total_distance = 0
    last_p = None
    
    for p in positions:
        if p.latitude is None or p.longitude is None:
            continue
            
        p_zim = p.timestamp + tz_offset
        if p_zim.date() != now_zim.date():
            continue
            
        if last_p:
            lon1, lat1, lon2, lat2 = map(radians, [last_p.longitude, last_p.latitude, p.longitude, p.latitude])
            dlon = lon2 - lon1
            dlat = lat2 - lat1
            a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
            c = 2 * asin(sqrt(max(0, min(1, a))))
            km = 6371 * c
            
            if 0 < km < 5:
                total_distance += km
                
        last_p = p
        
    return {"device_id": device_id, "daily_mileage": round(total_distance, 2)}
