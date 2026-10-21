from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import AuditLog, Device, FuelCalibration, Tenant, User
from app.auth_middleware import require_admin, require_manager, get_current_user, is_platform_admin, may_set_company
from pydantic import BaseModel, Field
from sqlalchemy.future import select
from sqlalchemy import func
from typing import Literal

router = APIRouter(prefix="/devices")

class DeviceCreate(BaseModel):
    imei: str
    name: str | None = None
    driver_name: str | None = None
    company: str | None = None
    tenant_name: str | None = None

class FuelCalibrationIn(BaseModel):
    empty_adc: float = Field(ge=0, le=4095)
    full_adc: float = Field(ge=0, le=4095)
    capacity_l: float | None = Field(default=None, gt=0)

def fuel_calibration_out(cal):
    return None if cal is None else {"empty_adc": cal.empty_adc, "full_adc": cal.full_adc, "capacity_l": cal.capacity_l}

@router.post("/")
async def create_device(
    payload: DeviceCreate, 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    # Enforce tenant isolation on creation
    target_tenant_id = None

    if not await may_set_company(db, current_user, payload.company):
        raise HTTPException(status_code=403, detail="Only the platform administrator can assign a tracker to another company")

    # If company matches an existing tenant name, assign device to that tenant
    if payload.company:
        q = await db.execute(select(Tenant).where(func.lower(Tenant.name) == payload.company.strip().lower()))
        tenant = q.scalars().first()
        if tenant:
            target_tenant_id = tenant.id

    # Global admins can also specify a tenant name explicitly
    if target_tenant_id is None and is_platform_admin(current_user) and payload.tenant_name:
        q = await db.execute(select(Tenant).where(func.lower(Tenant.name) == payload.tenant_name.strip().lower()))
        tenant = q.scalars().first()
        if not tenant:
            tenant = Tenant(name=payload.tenant_name.strip())
            db.add(tenant)
            await db.commit()
            await db.refresh(tenant)
        target_tenant_id = tenant.id

    # Default: create for the current user's tenant
    if target_tenant_id is None:
        target_tenant_id = current_user.tenant_id

    device = Device(
        imei=payload.imei, 
        name=payload.name, 
        driver_name=payload.driver_name,
        company=payload.company,
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
    # Platform admin (tenant 1, admin role) sees ALL devices including unassigned ones (NULL tenant_id)
    # Everyone else only sees their own tenant's devices (or devices whose company name matches their tenant)
    if not is_platform_admin(current_user):
        # Query tenant name explicitly (tenant relationship not eagerly loaded)
        t_res = await db.execute(select(Tenant.name).where(Tenant.id == current_user.tenant_id))
        user_tenant_name = t_res.scalar()
        if user_tenant_name:
            stmt = stmt.where(
                (Device.tenant_id == current_user.tenant_id) | 
                (func.lower(Device.company) == user_tenant_name.lower().strip())
            )
        else:
            stmt = stmt.where(Device.tenant_id == current_user.tenant_id)
    # For admin, no filter — see everything including NULL tenant_id devices
        
    result = await db.execute(stmt)
    devices = result.scalars().all()
    
    cal_rows = (await db.execute(select(FuelCalibration).where(FuelCalibration.device_id.in_([d.id for d in devices])))).scalars().all()
    cals = {c.device_id: c for c in cal_rows}

    # Robust serialization
    output = []
    for d in devices:
        output.append({
            "id": getattr(d, 'id', None),
            "imei": getattr(d, 'imei', 'N/A'),
            "name": getattr(d, 'name', None) or f"Device {getattr(d, 'imei', 'Unknown')}",
            "driver_name": getattr(d, 'driver_name', None),
            "company": getattr(d, 'company', None),
            "tenant_id": getattr(d, 'tenant_id', None),
            "device_metadata": getattr(d, 'device_metadata', {}),
            "fuel_calibration": fuel_calibration_out(cals.get(d.id))
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
    if not is_platform_admin(current_user) and device.tenant_id != current_user.tenant_id:
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

@router.put("/{device_id}/fuel-calibration")
async def set_fuel_calibration(
    device_id: int,
    payload: FuelCalibrationIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    if payload.empty_adc == payload.full_adc:
        raise HTTPException(status_code=400, detail="Empty and full readings must be different")
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalars().first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if not is_platform_admin(current_user) and device.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Not authorized to calibrate this device")

    cal = (await db.execute(select(FuelCalibration).where(FuelCalibration.device_id == device_id))).scalars().first()
    if cal is None:
        cal = FuelCalibration(device_id=device_id)
        db.add(cal)
    cal.empty_adc, cal.full_adc, cal.capacity_l, cal.updated_by = payload.empty_adc, payload.full_adc, payload.capacity_l, current_user.id
    out = fuel_calibration_out(cal)
    db.add(AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="SET_FUEL_CALIBRATION",
        details={"device_id": device_id, **out}
    ))
    await db.commit()
    return {"id": device_id, "fuel_calibration": out}

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
    if not is_platform_admin(current_user) and device.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Not authorized to update this device")
    
    device.imei = payload.imei
    if payload.name is not None:
        device.name = payload.name
    if payload.driver_name is not None:
        device.driver_name = payload.driver_name
    if payload.company is not None:
        if not await may_set_company(db, current_user, payload.company, device.company):
            raise HTTPException(status_code=403, detail="Only the platform administrator can assign a tracker to another company")
        device.company = payload.company
        # Synchronize device.tenant_id with company name if company matches a Tenant
        if is_platform_admin(current_user) and payload.company and payload.company.strip():
            t_q = await db.execute(select(Tenant).where(func.lower(Tenant.name) == payload.company.strip().lower()))
            matching_tenant = t_q.scalars().first()
            if matching_tenant:
                device.tenant_id = matching_tenant.id
        elif is_platform_admin(current_user) and payload.company.lower() in ["", "none", "unassigned", "default"]:
            device.tenant_id = 1
        
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
    
    return {"id": device.id, "imei": device.imei, "name": device.name, "driver_name": device.driver_name, "company": device.company, "device_metadata": device.device_metadata}


import datetime

class CommandPayload(BaseModel):
    action: Literal["shutdown", "sleep", "lock", "restore", "unlock"]

@router.post("/{device_id}/command")
async def send_device_command(
    device_id: int,
    payload: CommandPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalars().first()
    
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
        
    # Enforce tenant isolation
    if not is_platform_admin(current_user) and device.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Not authorized to control this device")

    action_lower = payload.action.lower()
    is_shutdown = action_lower in ["shutdown", "sleep", "lock"]
    
    # Update device metadata with command details and shutdown status
    meta = dict(device.device_metadata or {})
    meta["is_shutdown"] = is_shutdown
    meta["shutdown_status"] = "SHUTDOWN" if is_shutdown else "ACTIVE"
    meta["last_command"] = payload.action.upper()
    meta["pending_command"] = payload.action.upper()
    meta["last_command_at"] = datetime.datetime.utcnow().isoformat()
    meta["last_command_by"] = current_user.email
    device.device_metadata = meta

    # Record in AuditLog for security compliance
    from app.models import AuditLog
    audit = AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="REMOTE_TRACKER_SHUTDOWN" if is_shutdown else "REMOTE_TRACKER_RESTORE",
        details={
            "device_id": device_id,
            "imei": device.imei,
            "vehicle_name": device.name,
            "command": payload.action.upper()
        },
        ip_address="127.0.0.1"
    )
    db.add(audit)
    
    await db.commit()
    await db.refresh(device)

    action_text = "ENGINE_LOCK" if is_shutdown else "ENGINE_UN_LOCK"
    return {
        "success": True,
        "message": f"{action_text} queued for '{device.name or device.imei}'. Delivery and physical execution are not confirmed. This is not a tracker sleep command.",
        "command_status": "queued",
        "is_shutdown": is_shutdown,
        "device_metadata": device.device_metadata
    }
