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
            "timestamp": pos.timestamp.isoformat(),
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
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get aggregated mileage and active hours for the entire fleet (Last 7 Days)"""
    from sqlalchemy import func, cast, Date
    from datetime import datetime, timedelta
    
    seven_days_ago = datetime.utcnow() - timedelta(days=7)
    
    # Query all positions for the last 7 days
    stmt = (
        select(Position)
        .join(Device)
        .where(Position.timestamp >= seven_days_ago)
    )
    
    # Filter by tenant
    if current_user.tenant_id != 1:
        stmt = stmt.where(Device.tenant_id == current_user.tenant_id)
        
    stmt = stmt.order_by(Position.timestamp.asc())
    
    result = await db.execute(stmt)
    positions = result.scalars().all()
    
    if not positions:
        return {"labels": [], "mileage": [], "hours": []}
        
    # Process analytics in memory (group by day)
    daily_stats = {} # { "YYYY-MM-DD": { "distance": 0, "active_seconds": 0, "last_pos": {device_id: pos} } }
    
    for p in positions:
        day_str = p.timestamp.date().isoformat()
        if day_str not in daily_stats:
            daily_stats[day_str] = {"distance": 0, "active_seconds": 0, "last_positions": {}}
        
        # Calculate distance if we have a previous position for this device ON THIS DAY
        if p.device_id in daily_stats[day_str]["last_positions"]:
            prev = daily_stats[day_str]["last_positions"][p.device_id]
            
            # Simple Haversine
            from math import radians, cos, sin, asin, sqrt
            lon1, lat1, lon2, lat2 = map(radians, [prev.longitude, prev.latitude, p.longitude, p.latitude])
            dlon = lon2 - lon1
            dlat = lat2 - lat1
            a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
            c = 2 * asin(sqrt(a))
            km = 6371 * c
            
            if km < 5: # Filter out GPS jumps (> 300km/h average if points are 1 min apart)
                daily_stats[day_str]["distance"] += km
            
            # Active time: if speed > 3 km/h, add the gap
            if p.speed and p.speed > 3:
                gap = (p.timestamp - prev.timestamp).total_seconds()
                if gap < 600: # Max 10 mins gap to count as continuous activity
                    daily_stats[day_str]["active_seconds"] += gap
                    
        daily_stats[day_str]["last_positions"][p.device_id] = p
        
    # Sort days and format for Chart.js
    sorted_days = sorted(daily_stats.keys())
    labels = []
    mileage_data = []
    hours_data = []
    
    for day in sorted_days:
        # Convert date to Day Name (e.g. "Mon")
        dt = datetime.fromisoformat(day)
        labels.append(dt.strftime("%a"))
        mileage_data.append(round(daily_stats[day]["distance"], 1))
        hours_data.append(round(daily_stats[day]["active_seconds"] / 3600, 1))
        
    return {
        "labels": labels,
        "mileage": mileage_data,
        "hours": hours_data
    }
