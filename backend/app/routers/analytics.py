from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.future import select
from sqlalchemy import func, and_
from datetime import datetime, timedelta
from typing import List, Optional
from app.db import AsyncSessionLocal
from app.models import Position, Device, User
from app.routers.auth import get_current_user

router = APIRouter(prefix="/analytics", tags=["analytics"])

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

@router.get("/driver-performance")
async def get_driver_performance(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get driver performance metrics including harsh events and speeding."""
    if not start_date:
        start_date = (datetime.utcnow() - timedelta(days=7)).isoformat()
    if not end_date:
        end_date = datetime.utcnow().isoformat()
    
    start_dt = datetime.fromisoformat(start_date)
    end_dt = datetime.fromisoformat(end_date)
    
    # Get devices for tenant
    device_query = select(Device).where(Device.tenant_id == current_user.tenant_id)
    device_result = await db.execute(device_query)
    devices = device_result.scalars().all()
    device_ids = [d.id for d in devices]
    
    if not device_ids:
        return []
    
    # Query positions with harsh events and speeding
    query = select(Position).where(
        and_(
            Position.device_id.in_(device_ids),
            Position.timestamp >= start_dt,
            Position.timestamp <= end_dt
        )
    )
    result = await db.execute(query)
    positions = result.scalars().all()
    
    # Aggregate by device (driver)
    driver_stats = {}
    for pos in positions:
        device_id = pos.device_id
        device = next((d for d in devices if d.id == device_id), None)
        driver_name = device.driver_name if device else "Unknown"
        
        if device_id not in driver_stats:
            driver_stats[device_id] = {
                "driver_name": driver_name,
                "device_name": device.name if device else "Unknown",
                "harsh_braking": 0,
                "harsh_acceleration": 0,
                "speeding_events": 0,
                "max_speed": 0,
                "total_distance": 0
            }
        
        raw = pos.raw or {}
        if raw.get("harsh_braking"):
            driver_stats[device_id]["harsh_braking"] += 1
        if raw.get("harsh_acceleration"):
            driver_stats[device_id]["harsh_acceleration"] += 1
        if pos.speed and pos.speed > 120:  # Speeding threshold
            driver_stats[device_id]["speeding_events"] += 1
        if pos.speed and pos.speed > driver_stats[device_id]["max_speed"]:
            driver_stats[device_id]["max_speed"] = pos.speed
    
    return list(driver_stats.values())

@router.get("/fuel-efficiency")
async def get_fuel_efficiency(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get fuel efficiency metrics including km/L and cost estimates."""
    if not start_date:
        start_date = (datetime.utcnow() - timedelta(days=30)).isoformat()
    if not end_date:
        end_date = datetime.utcnow().isoformat()
    
    start_dt = datetime.fromisoformat(start_date)
    end_dt = datetime.fromisoformat(end_date)
    
    # Get devices for tenant
    device_query = select(Device).where(Device.tenant_id == current_user.tenant_id)
    device_result = await db.execute(device_query)
    devices = device_result.scalars().all()
    device_ids = [d.id for d in devices]
    
    if not device_ids:
        return []
    
    # Query positions with fuel consumption data
    query = select(Position).where(
        and_(
            Position.device_id.in_(device_ids),
            Position.timestamp >= start_dt,
            Position.timestamp <= end_dt
        )
    )
    result = await db.execute(query)
    positions = result.scalars().all()
    
    # Aggregate by device
    fuel_stats = {}
    for pos in positions:
        device_id = pos.device_id
        device = next((d for d in devices if d.id == device_id), None)
        
        if device_id not in fuel_stats:
            fuel_stats[device_id] = {
                "device_name": device.name if device else "Unknown",
                "total_distance": 0,
                "total_fuel": 0,
                "total_consumption": 0
            }
        
        raw = pos.raw or {}
        fuel_consumption = raw.get("fuel_consumption") or raw.get("fuel")
        if fuel_consumption:
            fuel_stats[device_id]["total_consumption"] += float(fuel_consumption)
        
        # Estimate distance from speed (simplified)
        if pos.speed:
            fuel_stats[device_id]["total_distance"] += pos.speed / 60  # km per minute
    
    # Calculate efficiency
    fuel_price = 1.65  # USD per liter
    for device_id, stats in fuel_stats.items():
        if stats["total_distance"] > 0:
            stats["efficiency_kml"] = stats["total_distance"] / max(stats["total_consumption"], 1)
            stats["cost_per_km"] = (stats["total_consumption"] * fuel_price) / stats["total_distance"]
            stats["total_cost"] = stats["total_consumption"] * fuel_price
        else:
            stats["efficiency_kml"] = 0
            stats["cost_per_km"] = 0
            stats["total_cost"] = 0
    
    return list(fuel_stats.values())

@router.get("/vehicle-utilization")
async def get_vehicle_utilization(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get vehicle utilization metrics including active vs idle time."""
    if not start_date:
        start_date = (datetime.utcnow() - timedelta(days=30)).isoformat()
    if not end_date:
        end_date = datetime.utcnow().isoformat()
    
    start_dt = datetime.fromisoformat(start_date)
    end_dt = datetime.fromisoformat(end_date)
    
    # Get devices for tenant
    device_query = select(Device).where(Device.tenant_id == current_user.tenant_id)
    device_result = await db.execute(device_query)
    devices = device_result.scalars().all()
    device_ids = [d.id for d in devices]
    
    if not device_ids:
        return []
    
    # Query positions
    query = select(Position).where(
        and_(
            Position.device_id.in_(device_ids),
            Position.timestamp >= start_dt,
            Position.timestamp <= end_dt
        )
    ).order_by(Position.timestamp)
    result = await db.execute(query)
    positions = result.scalars().all()
    
    # Calculate utilization by device
    utilization_stats = {}
    for device in devices:
        device_positions = [p for p in positions if p.device_id == device.id]
        
        if not device_positions:
            continue
        
        moving_time = 0
        idle_time = 0
        offline_time = 0
        
        for i, pos in enumerate(device_positions):
            if i == 0:
                continue
            
            prev = device_positions[i - 1]
            time_diff = (pos.timestamp - prev.timestamp).total_seconds() / 60  # minutes
            
            if prev.speed and prev.speed > 3:
                moving_time += time_diff
            elif prev.speed and prev.speed <= 3:
                idle_time += time_diff
            else:
                offline_time += time_diff
        
        total_time = moving_time + idle_time + offline_time
        utilization_rate = (moving_time / total_time * 100) if total_time > 0 else 0
        
        utilization_stats[device.id] = {
            "device_name": device.name,
            "moving_minutes": round(moving_time, 2),
            "idle_minutes": round(idle_time, 2),
            "offline_minutes": round(offline_time, 2),
            "total_minutes": round(total_time, 2),
            "utilization_rate": round(utilization_rate, 2)
        }
    
    return list(utilization_stats.values())

@router.get("/maintenance-status")
async def get_maintenance_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get maintenance status based on odometer and engine hours."""
    # Get devices for tenant
    device_query = select(Device).where(Device.tenant_id == current_user.tenant_id)
    device_result = await db.execute(device_query)
    devices = device_result.scalars().all()
    device_ids = [d.id for d in devices]
    
    if not device_ids:
        return []
    
    # Get latest position for each device to get odometer
    maintenance_status = []
    for device in devices:
        # Get latest position
        query = select(Position).where(
            Position.device_id == device.id
        ).order_by(Position.timestamp.desc()).limit(1)
        result = await db.execute(query)
        latest_pos = result.scalars().first()
        
        odometer = 0
        engine_hours = 0
        if latest_pos:
            raw = latest_pos.raw or {}
            odometer = raw.get("mileage") or raw.get("odometer") or 0
            engine_hours = raw.get("engine_hours") or 0
        
        # Calculate maintenance status (simplified)
        # Service every 10,000 km or 500 engine hours
        next_service_km = ((odometer // 10000) + 1) * 10000
        km_until_service = next_service_km - odometer
        service_progress = (odometer % 10000) / 10000 * 100
        
        status = "Good"
        if km_until_service < 1000:
            status = "Due Soon"
        if km_until_service < 0:
            status = "Overdue"
        
        maintenance_status.append({
            "device_name": device.name,
            "odometer": odometer,
            "engine_hours": engine_hours,
            "next_service_km": next_service_km,
            "km_until_service": km_until_service,
            "service_progress": round(service_progress, 2),
            "status": status
        })
    
    return maintenance_status
