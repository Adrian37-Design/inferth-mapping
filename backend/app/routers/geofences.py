from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.future import select
from typing import List
from app.db import AsyncSessionLocal
from app.models import Geofence, User, Device, Tenant
from app.routers.auth import get_current_user
import json

router = APIRouter(prefix="/geofences", tags=["geofences"])

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

async def _can_see_device(db: Session, current_user: User, device: Device) -> bool:
    if current_user.tenant_id == 1 or device.tenant_id == current_user.tenant_id:
        return True
    tenant_name = (await db.execute(select(Tenant.name).where(Tenant.id == current_user.tenant_id))).scalar()
    return bool(tenant_name) and (device.company or "").lower() == tenant_name.lower().strip()

@router.get("/", response_model=List[dict])
async def get_geofences(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Only the platform super-admin (tenant 1, admin role) sees every tenant's geofences
    query = select(Geofence).where(Geofence.triggered_at.is_(None))
    if current_user.tenant_id != 1 or current_user.role != "admin":
        query = query.where(Geofence.tenant_id == current_user.tenant_id)
        
    result = await db.execute(query)
    zones = result.scalars().all()
    
    return [
        {
            "id": z.id,
            "name": z.name,
            "color": z.color,
            "assets": z.assets,
            "alertRules": z.alert_rules,
            "notification": z.notification,
            "geoJSON": z.geojson
        } for z in zones
    ]

@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_geofence(
    zone_data: dict, 
    db: Session = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    # Ensure mandatory fields
    if "name" not in zone_data or "geoJSON" not in zone_data:
        raise HTTPException(status_code=400, detail="Name and geoJSON are required")

    assets = zone_data.get("assets") or []
    if len(assets) != 1 or not str(assets[0]).isdigit():
        raise HTTPException(status_code=400, detail="A geofence belongs to exactly one tracker")
    device = (await db.execute(select(Device).where(Device.id == int(assets[0])))).scalars().first()
    if not device or not await _can_see_device(db, current_user, device):
        raise HTTPException(status_code=404, detail="Tracker not found")

    new_zone = Geofence(
        name=zone_data["name"],
        color=zone_data.get("color", "#2D5F6D"),
        assets=[device.id],
        alert_rules=zone_data.get("alertRules", {"entry": True, "exit": False}),
        notification=zone_data.get("notification", {"channel": "system", "contact": ""}),
        geojson=zone_data["geoJSON"],
        tenant_id=current_user.tenant_id
    )
    
    db.add(new_zone)
    await db.commit()
    await db.refresh(new_zone)
    
    return {"id": new_zone.id, "status": "created"}

@router.delete("/{zone_id}")
async def delete_geofence(
    zone_id: int, 
    db: Session = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    query = select(Geofence).where(Geofence.id == zone_id)
    if current_user.tenant_id != 1 or current_user.role != "admin":
        query = query.where(Geofence.tenant_id == current_user.tenant_id)
        
    result = await db.execute(query)
    zone = result.scalars().first()
    
    if not zone:
        raise HTTPException(status_code=404, detail="Geofence not found")
        
    await db.delete(zone)
    await db.commit()
    
    return {"status": "deleted"}
