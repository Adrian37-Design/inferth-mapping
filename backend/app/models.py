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
    logo_url = Column(String, nullable=True)
    primary_color = Column(String, default="#2D5F6D") # Default Inferth Teal
    secondary_color = Column(String, default="#EF4835") # Default Inferth Orange
    navbar_bg = Column(String, nullable=True) # Will match logo background
    navbar_text_color = Column(String, nullable=True)
    
    # Subscription & Billing (Step 10)
    plan = Column(String, default="Basic") # Basic, Pro, Enterprise
    subscription_status = Column(String, default="active") # active, past_due, canceled
    billing_cycle = Column(String, default="Monthly")
    next_billing_date = Column(DateTime(timezone=True), nullable=True)
    features = Column(JSON, default={"reports": False, "advanced_rules": False, "geofencing": True})
    
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
    last_login = Column(DateTime(timezone=True), nullable=True)
    accessible_assets = Column(JSON, default=["*"]) # Default to all, or list of IDs
    tenant = relationship("Tenant")


class AuditLog(Base) :
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index = True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable = True)  # Nullable for system actions
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable = True) # Context for the action
    action = Column(String, index = True, nullable = False)  # LOGIN, LOGOUT, CREATE, UPDATE, DELETE
    details = Column(JSON, default = {})
    ip_address = Column(String, nullable = True)
    timestamp = Column(DateTime(timezone = True), server_default = func.now())

    user = relationship("User")
    tenant = relationship("Tenant")


class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    imei = Column(String, unique=True, index=True, nullable=False)
    name = Column(String)
    driver_name = Column(String, nullable=True) # Added driver name
    company = Column(String, nullable=True) # Company/operator name for this tracker
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


class Geofence(Base):
    __tablename__ = "geofences"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    color = Column(String, default="#2D5F6D")
    assets = Column(JSON, default=[]) # List of device IDs
    alert_rules = Column(JSON, default={"entry": True, "exit": False})
    notification = Column(JSON, default={"channel": "system", "contact": ""})
    geojson = Column(JSON, nullable=False)
    tenant_id = Column(Integer, ForeignKey("tenants.id"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    tenant = relationship("Tenant")
class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"))
    amount_usd = Column(Float, nullable=False)
    
    payment_method = Column(String) # paynow, mobile_money, bank_transfer
    status = Column(String, default="pending") # pending, paid, failed, approval_pending, rejected
    
    # Paynow specific
    paynow_reference = Column(String, nullable=True) # Poll URL or merchant reference
    paynow_status = Column(String, nullable=True) # RAW status from Paynow
    
    # Manual Fallback
    proof_url = Column(String, nullable=True) # Path to uploaded screnshot
    rejection_reason = Column(String, nullable=True)
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    tenant = relationship("Tenant", backref="transactions")
    
class Rule(Base):
    __tablename__ = "rules"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"))
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=True) # If null, applies to all
    event_type = Column(String, index=True) # speeding, geofence_exit, power_alarm, sensor_alarm, offline, harsh_braking
    threshold = Column(Float, nullable=True) # For speeding (km/h)
    channel = Column(String, default="system") # system, email, sms
    contact = Column(String, nullable=True) # email address or phone number
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    tenant = relationship("Tenant")
    device = relationship("Device")

class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"))
    device_id = Column(Integer, ForeignKey("devices.id"))
    rule_id = Column(Integer, ForeignKey("rules.id"), nullable=True)
    type = Column(String, index=True) # speeding, power_alarm, etc.
    message = Column(String)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    is_read = Column(Boolean, default=False)

    tenant = relationship("Tenant")
    device = relationship("Device")
    rule = relationship("Rule")
