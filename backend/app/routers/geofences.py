from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.future import select
from typing import List
from app.db import AsyncSessionLocal
from app.models import Geofence, User, Device, Tenant
from app.routers.auth import get_current_user
from app.auth_middleware import is_platform_admin, can_see_device, tenant_name, tracker_visibility
import json

router = APIRouter(prefix="/geofences", tags=["geofences"])

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

async def _zones_visible_to(db: Session, current_user: User, zones: list) -> list:
    asset_ids = list({int(a) for z in zones for a in (z.assets or []) if str(a).isdigit()})
    visible = set()
    if asset_ids:
        company = await tenant_name(db, current_user)
        visible = {str(i) for i in (await db.execute(select(Device.id).where(Device.id.in_(asset_ids), tracker_visibility(current_user, company)))).scalars().all()}
    return [z for z in zones if any(str(a) in visible for a in (z.assets or []))]

@router.get("/", response_model=List[dict])
async def get_geofences(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Only the platform super-admin (tenant 1, admin role) sees every tenant's geofences
    query = select(Geofence).where(Geofence.triggered_at.is_(None))
        
    result = await db.execute(query)
    zones = result.scalars().all()
    if not is_platform_admin(current_user):
        zones = await _zones_visible_to(db, current_user, zones)
    
    return [
        {
            "id": z.id,
            "name": z.name,
            "color": z.color,
            "assets": z.assets,
            "alertRules": z.alert_rules,
            "notification": z.notification,
            "geoJSON": z.geojson,
            "canDelete": is_platform_admin(current_user) or z.tenant_id == current_user.tenant_id
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
    if not device or not await can_see_device(db, current_user, device):
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
    if not is_platform_admin(current_user):
        query = query.where(Geofence.tenant_id == current_user.tenant_id)
        
    result = await db.execute(query)
    zone = result.scalars().first()
    
    if not zone:
        raise HTTPException(status_code=404, detail="Geofence not found")
        
    await db.delete(zone)
    await db.commit()
    
    return {"status": "deleted"}
