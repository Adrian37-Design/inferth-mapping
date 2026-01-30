from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, ForeignKey, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import datetime

# IMPORTANT: use Base from db.py
from app.db import Base


class DeviceData(Base):
    __tablename__ = "device_data"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(String, index=True)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)
    latitude = Column(Float)
    longitude = Column(Float)
    speed = Column(Float)
    status = Column(String)


class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=True)  # Nullable for new users
    role = Column(String, default="admin") # admin, manager, viewer
    is_admin = Column(Boolean, default=False) # Keep for backward compat, but rely on role
    is_active = Column(Boolean, default=False)  # False until password is set
    setup_token = Column(String, nullable=True, unique=True)  # For first-time setup
    tenant_id = Column(Integer, ForeignKey("tenants.id"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    tenant = relationship("Tenant")


class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    imei = Column(String, unique=True, index=True, nullable=False)
    name = Column(String)
    driver_name = Column(String, nullable=True) # Added driver name
    tenant_id = Column(Integer, ForeignKey("tenants.id"))
    device_metadata = Column(JSON, default={})
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    tenant = relationship("Tenant")


class Position(Base):
    __tablename__ = "positions"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"))
    latitude = Column(Float)
    longitude = Column(Float)
    altitude = Column(Float, nullable=True)
    speed = Column(Float, nullable=True)
    course = Column(Float, nullable=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    raw = Column(JSON, nullable=True)
    device = relationship("Device")
