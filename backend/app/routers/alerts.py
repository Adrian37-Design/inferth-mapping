from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import select, update
from typing import List
from app.db import AsyncSessionLocal
from app.models import Alert, User, Device
from app.routers.auth import get_current_user
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
    device_name: str = None

    class Config:
        from_attributes = True

@router.get("/", response_model=List[AlertOut])
async def get_alerts(current_user: User = Depends(get_current_user), limit: int = 50):
    async with AsyncSessionLocal() as db:
        # Join with Device to get the name
        stmt = select(Alert, Device.name).join(Device, Alert.device_id == Device.id).where(
            Alert.tenant_id == current_user.tenant_id
        ).order_by(Alert.timestamp.desc()).limit(limit)
        
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
        await db.execute(
            update(Alert).where(Alert.tenant_id == current_user.tenant_id).values(is_read=True)
        )
        await db.commit()
        return {"message": "All alerts marked as read"}
