from pydantic import BaseModel, EmailStr
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
    latitude: float
    longitude: float
    speed: Optional[float]
    course: Optional[float]
    timestamp: datetime

    class Config:
        orm_mode = True

class UserBase(BaseModel):
    email: EmailStr

class UserOut(UserBase):
    id: int
    is_active: bool
    is_admin: bool
    role: str
    tenant_id: int | None = None

    class Config:
        orm_mode = True

