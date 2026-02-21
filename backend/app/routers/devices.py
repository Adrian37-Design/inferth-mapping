from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import Device, Tenant, User
from app.auth_middleware import require_admin, require_manager, get_current_user
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
    # Enforce tenant isolation on creation
    target_tenant_id = None
    if current_user.tenant_id == 1 and payload.tenant_name:
        # Global admins can specify a tenant name
        q = await db.execute(select(Tenant).where(Tenant.name == payload.tenant_name))
        tenant = q.scalars().first()
        if not tenant:
            tenant = Tenant(name=payload.tenant_name)
            db.add(tenant)
            await db.commit()
            await db.refresh(tenant)
        target_tenant_id = tenant.id
    else:
        # Everyone else creates for their own tenant
        target_tenant_id = current_user.tenant_id

    device = Device(
        imei=payload.imei, 
        name=payload.name, 
        driver_name=payload.driver_name,
        tenant_id=target_tenant_id
    )
    db.add(device)
    
    # Audit Log
    from app.models import AuditLog
    audit = AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="CREATE_DEVICE",
        details={"imei": device.imei, "tenant_id": target_tenant_id},
        ip_address="127.0.0.1"
    )
    db.add(audit)
    
    await db.commit()
    await db.refresh(device)
    return {"id": device.id, "imei": device.imei}

@router.get("/")
async def list_devices(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    stmt = select(Device)
    # Filter by tenant unless global admin
    if current_user.tenant_id != 1:
        stmt = stmt.where(Device.tenant_id == current_user.tenant_id)
        
    result = await db.execute(stmt)
    devices = result.scalars().all()
    
    # Robust serialization
    output = []
    for d in devices:
        output.append({
            "id": getattr(d, 'id', None),
            "imei": getattr(d, 'imei', 'N/A'),
            "name": getattr(d, 'name', None) or f"Device {getattr(d, 'imei', 'Unknown')}",
            "driver_name": getattr(d, 'driver_name', None),
            "tenant_id": getattr(d, 'tenant_id', None)
        })
    return output

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
        
    # Enforce tenant isolation
    if current_user.tenant_id != 1 and device.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this device")
    
    # Audit Log
    from app.models import AuditLog
    audit = AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="DELETE_DEVICE",
        details={"imei": device.imei, "id": device_id},
        ip_address="127.0.0.1"
    )
    db.add(audit)
    
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
        
    # Enforce tenant isolation
    if current_user.tenant_id != 1 and device.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Not authorized to update this device")
    
    device.imei = payload.imei
    if payload.name is not None:
        device.name = payload.name
    if payload.driver_name is not None:
        device.driver_name = payload.driver_name
        
    # Audit Log
    from app.models import AuditLog
    audit = AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="UPDATE_DEVICE",
        details={"id": device_id, "imei": device.imei},
        ip_address="127.0.0.1"
    )
    db.add(audit)
        
    await db.commit()
    await db.refresh(device)
    
    return {"id": device.id, "imei": device.imei, "name": device.name, "driver_name": device.driver_name}
