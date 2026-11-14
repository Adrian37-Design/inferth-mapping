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


@router.post("/{alert_id}/read")
async def mark_alert_read(alert_id: int, current_user: User = Depends(get_current_user)):
    async with AsyncSessionLocal() as db:
        stmt = update(Alert).where(Alert.id == alert_id).values(is_read=True)
        if not is_platform_admin(current_user):
            visible = select(Device.id).where(tracker_visibility(current_user, await tenant_name(db, current_user)))
            stmt = stmt.where(or_(Alert.tenant_id == current_user.tenant_id, Alert.device_id.in_(visible)))
        await db.execute(stmt)
        await db.commit()
        return {"message": "Alert marked as read"}



# ══════════════════════════════════════════════════════════════════
# AUTOMATED WHATSAPP ALERT DISPATCH CONFIGURATION & TEST
# ══════════════════════════════════════════════════════════════════

import json
import os

ALERTS_AUTOMATION_STORE_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "alerts_automation.json")

def _load_alerts_automation_store() -> dict:
    if os.path.exists(ALERTS_AUTOMATION_STORE_PATH):
        try:
            with open(ALERTS_AUTOMATION_STORE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def _save_alerts_automation_store(data: dict):
    try:
        with open(ALERTS_AUTOMATION_STORE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"Failed to save alerts automation store: {e}")

class AlertAutomationConfig(BaseModel):
    enabled: bool = True
    priority: str = "critical"      # critical, high_critical, all
    interval: str = "instant"       # instant, hourly_digest, daily_digest
    whatsapp_number: Optional[str] = None

@router.get("/automation/config")
async def get_alert_automation(current_user: User = Depends(get_current_user)):
    """Retrieve saved alert automation preferences for current tenant."""
    store = _load_alerts_automation_store()
    tenant_key = str(current_user.tenant_id)
    default_cfg = {
        "enabled": True,
        "priority": "critical",
        "interval": "instant",
        "whatsapp_number": current_user.phone or "+263783009275"
    }
    return store.get(tenant_key, default_cfg)

@router.post("/automation/config")
async def save_alert_automation(cfg: AlertAutomationConfig, current_user: User = Depends(get_current_user)):
    """Save alert priority and dispatch interval preferences."""
    store = _load_alerts_automation_store()
    tenant_key = str(current_user.tenant_id)
    phone = cfg.whatsapp_number or current_user.phone
    if phone:
        from app.services.whatsapp import normalize_msisdn
        normalized = normalize_msisdn(phone)
        if normalized:
            phone = normalized

    cfg_dict = cfg.dict()
    cfg_dict["whatsapp_number"] = phone
    cfg_dict["updated_at"] = datetime.utcnow().isoformat()
    store[tenant_key] = cfg_dict
    _save_alerts_automation_store(store)
    return {"message": "Alert dispatch automation preferences saved successfully", "config": cfg_dict}

@router.post("/automation/send-test")
async def send_test_alert_whatsapp(
    cfg: Optional[AlertAutomationConfig] = None,
    current_user: User = Depends(get_current_user)
):
    """
    Sends a test automated alert dispatch message via WhatsApp bot.
    """
    from app.services.whatsapp import send_whatsapp, normalize_msisdn

    store = _load_alerts_automation_store()
    tenant_key = str(current_user.tenant_id)
    saved_cfg = store.get(tenant_key, {})

    phone = (cfg and cfg.whatsapp_number) or saved_cfg.get("whatsapp_number") or current_user.phone
    phone = normalize_msisdn(phone)
    if not phone:
        raise HTTPException(400, "Valid WhatsApp phone number required (e.g. +263 78 300 9275)")

    priority_label = {
        "critical": "CRITICAL (Panic, Power Cut, Geofence Breach)",
        "high_critical": "HIGH & CRITICAL (Safety & Security Events)",
        "all": "ALL PRIORITIES (Full Fleet Stream)"
    }.get((cfg and cfg.priority) or saved_cfg.get("priority", "critical"), "CRITICAL")

    interval_label = {
        "instant": "Real-Time Instant (< 2 seconds)",
        "hourly_digest": "Hourly Digest Summary",
        "daily_digest": "Daily Morning Summary (08:00)"
    }.get((cfg and cfg.interval) or saved_cfg.get("interval", "instant"), "Real-Time Instant")

    test_msg = (
        f"🚨 *INFERTH MAPPING — AUTOMATED ALERT DISPATCH*\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"⚠️ *Priority Filter:* {priority_label}\n"
        f"⏱️ *Dispatch Cadence:* {interval_label}\n"
        f"🚗 *Vehicle:* Test Asset (Harare Fleet)\n"
        f"⚡ *Event:* Main Power Disconnected / Geofence Breach\n"
        f"📍 *Location:* Samora Machel Ave, Harare\n"
        f"🕒 *Timestamp:* {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC\n\n"
        f"✅ *Automation Verified:* The WhatsApp bot will automatically dispatch alerts matching this criteria.\n"
        f"🔗 Portal: https://inferth-mapping.up.railway.app"
    )

    success = await send_whatsapp(phone, test_msg)
    return {
        "status": "success" if success else "sent_simulated",
        "recipient": phone,
        "priority": priority_label,
        "interval": interval_label
    }
