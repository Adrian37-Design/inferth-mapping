from pydantic import BaseModel, EmailStr, field_serializer
from typing import Optional
from datetime import datetime

class PositionCreate(BaseModel):
    imei: str
    latitude: float
    longitude: float
    speed: Optional[float] = None
    course: Optional[float] = None
    timestamp: Optional[datetime] = None
    raw: Optional[dict] = None

class PositionOut(BaseModel):
    id: int
    device_id: int
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    speed: Optional[float] = None
    course: Optional[float] = None
    timestamp: Optional[datetime] = None
    raw: Optional[dict] = None

    class Config:
        from_attributes = True

    @field_serializer('timestamp')
    def serialize_timestamp(self, dt: Optional[datetime], _info):
        if dt is None:
            return None
        if dt.tzinfo is None:
            return dt.isoformat() + "Z"
        return dt.isoformat()

class UserBase(BaseModel):
    email: EmailStr

class UserOut(UserBase):
    id: int
    is_active: bool
    is_admin: bool
    role: str
    tenant_id: int | None = None

    class Config:
        from_attributes = True

class DeviceBase(BaseModel):
    imei: str
    name: Optional[str] = None
    driver_name: Optional[str] = None

class DeviceCreate(DeviceBase):
    pass

class DeviceOut(DeviceBase):
    id: int
    tenant_id: int | None = None
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True
