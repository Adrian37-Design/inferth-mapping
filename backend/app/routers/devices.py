from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import Device, Tenant, User
from app.auth_middleware import require_admin, require_manager
from pydantic import BaseModel
from sqlalchemy.future import select

router = APIRouter(prefix="/devices")

class DeviceCreate(BaseModel):
    imei: str
    name: str | None = None
    driver_name: str | None = None
    tenant_name: str | None = None

@router.post("/")
async def create_device(
    payload: DeviceCreate, 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    # simple tenant lookup / create for dev
    tenant = None
    if payload.tenant_name:
        q = await db.execute(select(Tenant).where(Tenant.name == payload.tenant_name))
        tenant = q.scalars().first()
        if not tenant:
            tenant = Tenant(name=payload.tenant_name)
            db.add(tenant)
            await db.commit()
            await db.refresh(tenant)
    device = Device(imei=payload.imei, name=payload.name, tenant_id=tenant.id if tenant else None)
    db.add(device)
    await db.commit()
    await db.refresh(device)
    return {"id": device.id, "imei": device.imei}

@router.get("/")
async def list_devices(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Device))
    devices = result.scalars().all()
    return [{"id": d.id, "imei": d.imei, "name": d.name or f"Device {d.imei}", "driver_name": d.driver_name} for d in devices]

@router.delete("/{device_id}")
async def delete_device(
    device_id: int, 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalars().first()
    
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    
    await db.delete(device)
    await db.commit()
    
    
    return {"message": f"Device {device.imei} deleted successfully"}

@router.put("/{device_id}")
async def update_device(
    device_id: int, 
    payload: DeviceCreate, 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalars().first()
    
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    
    device.imei = payload.imei
    if payload.name is not None:
        device.name = payload.name
    if payload.driver_name is not None:
        device.driver_name = payload.driver_name
        
    await db.commit()
    await db.refresh(device)
    
    return {"id": device.id, "imei": device.imei, "name": device.name, "driver_name": device.driver_name}
