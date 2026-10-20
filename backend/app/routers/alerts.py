from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import select, update, or_
from typing import List, Optional
from app.db import AsyncSessionLocal
from app.models import Alert, User, Device
from app.routers.auth import get_current_user
from app.auth_middleware import is_platform_admin, tenant_name, tracker_visibility
from pydantic import BaseModel
from datetime import datetime

router = APIRouter(prefix="/alerts", tags=["alerts"])

class AlertOut(BaseModel):
    id: int
    type: str
    message: str
    timestamp: datetime
    is_read: bool
    device_id: int
    device_name: Optional[str] = None

    class Config:
        from_attributes = True

@router.get("/", response_model=List[AlertOut])
async def get_alerts(current_user: User = Depends(get_current_user), limit: int = 50, types: Optional[str] = None):
    async with AsyncSessionLocal() as db:
        # Join with Device to get the name
        stmt = select(Alert, Device.name).join(Device, Alert.device_id == Device.id)
        if not is_platform_admin(current_user):
            stmt = stmt.where(or_(Alert.tenant_id == current_user.tenant_id, tracker_visibility(current_user, await tenant_name(db, current_user))))
        names = [t for t in (types or "").split(",") if t]
        if names:
            stmt = stmt.where(Alert.type.in_(names))
        stmt = stmt.order_by(Alert.timestamp.desc()).limit(limit)
        
        results = await db.execute(stmt)
        alerts_out = []
        for alert, device_name in results:
            alert_dict = AlertOut.from_orm(alert)
            alert_dict.device_name = device_name
            alerts_out.append(alert_dict)
            
        return alerts_out

@router.post("/mark-read")
async def mark_read(current_user: User = Depends(get_current_user)):
    async with AsyncSessionLocal() as db:
        stmt = update(Alert).values(is_read=True)
        if not is_platform_admin(current_user):
            visible = select(Device.id).where(tracker_visibility(current_user, await tenant_name(db, current_user)))
            stmt = stmt.where(or_(Alert.tenant_id == current_user.tenant_id, Alert.device_id.in_(visible)))
        await db.execute(stmt)
        await db.commit()
        return {"message": "All alerts marked as read"}
