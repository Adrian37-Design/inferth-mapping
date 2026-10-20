from sqlalchemy.orm import Session
from sqlalchemy import select, update, func
from app.models import Rule, Alert, Device, User, Geofence
from app.services.email import send_email
from app.services.sms import SMSService
from app.db import AsyncSessionLocal
from datetime import datetime, timedelta
import asyncio
import json

_device_locks = {}


def _device_lock(device_id):
    return _device_locks.setdefault(device_id, asyncio.Lock())


class AlertService:
    @staticmethod
    async def evaluate_rules(db: Session, device_id: int, position_data: dict):
        """
        Public entrypoint. This is typically launched as a fire-and-forget
        background task (asyncio.create_task), which means the caller's `db`
        session is usually closed (via its own `async with`) before this code
        runs. Using that closed session raises
        "'NoneType' object has no attribute 'twophase'". To be safe we always
        run against a fresh, dedicated session here and ignore the passed-in one.
        """
        async with _device_lock(device_id):
            async with AsyncSessionLocal() as session:
                await AlertService._evaluate_rules(session, device_id, position_data)

    @staticmethod
    async def _evaluate_rules(db: Session, device_id: int, position_data: dict):
        """
        Evaluates active rules for a given device and position.
        position_data: dict containing latitude, longitude, speed, and raw (which has alarm flags)
        """
        # 1. Fetch the device to get tenant_id
        res = await db.execute(select(Device).where(Device.id == device_id))
        device = res.scalars().first()
        if not device:
            return

        # 2. Fetch active rules for this tenant (either specific to this device or global)
        rule_res = await db.execute(
            select(Rule).where(
                Rule.tenant_id == device.tenant_id,
                Rule.is_active == True,
                (Rule.device_id == device_id) | (Rule.device_id == None)
            )
        )
        rules = rule_res.scalars().all()
        
        raw_data = position_data.get("raw", {})
        speed = position_data.get("speed", 0)
        lat = position_data.get("latitude")
        lng = position_data.get("longitude")
        geofence_events = await AlertService._check_geofence(db, device, lat, lng) if lat and lng else []

        for rule in rules:
            triggered = False
            message = ""

            if rule.event_type == "speeding":
                if speed > (rule.threshold or 120):
                    triggered = True
                    message = f"Speeding alert: {device.name} is travelling at {speed:.1f} km/h (Limit: {rule.threshold} km/h)"
            
            elif rule.event_type == "power_alarm":
                if raw_data.get("main_power_cut"):
                    triggered = True
                    message = f"Power Alarm: External power disconnected from {device.name}"
            
            elif rule.event_type == "sensor_alarm":
                if raw_data.get("vibration"):
                    triggered = True
                    message = f"Sensor Alarm: Vibration/Shock detected on {device.name}"
            
            elif rule.event_type == "low_battery":
                if raw_data.get("low_battery"):
                    triggered = True
                    message = f"Battery Warning: {device.name} internal battery is low"
            
            elif rule.event_type in ("geofence_entry", "geofence_exit"):
                kind = "entry" if rule.event_type == "geofence_entry" else "exit"
                message = "; ".join(text for event, text in geofence_events if event == kind)
                triggered = bool(message)
            
            elif rule.event_type == "device_offline":
                triggered, message = await AlertService._check_offline(db, device, rule.threshold or 30)
            
            elif rule.event_type == "harsh_braking":
                if raw_data.get("harsh_braking"):
                    triggered = True
                    message = f"Harsh Braking: {device.name} detected harsh braking event"
            
            elif rule.event_type == "harsh_acceleration":
                if raw_data.get("harsh_acceleration"):
                    triggered = True
                    message = f"Harsh Acceleration: {device.name} detected harsh acceleration event"
            
            elif rule.event_type == "excessive_idling":
                triggered, message = await AlertService._check_excessive_idling(db, device, rule.threshold or 15)

            if triggered:
                # 3. Create Alert Record
                if rule.event_type not in ("geofence_entry", "geofence_exit"):
                    new_alert = Alert(
                        tenant_id=device.tenant_id,
                        device_id=device.id,
                        rule_id=rule.id,
                        type=rule.event_type,
                        message=message
                    )
                    db.add(new_alert)
                    await db.commit()

                # 4. Handle Notifications
                if rule.channel == "email" and rule.contact:
                    # Async email sending
                    subject = f"Alert: {rule.event_type.replace('_', ' ').title()} - {device.name}"
                    html = f"""
                    <h3>Inferth Mapping Alert</h3>
                    <p><strong>Vehicle:</strong> {device.name}</p>
                    <p><strong>Event:</strong> {rule.event_type.replace('_', ' ').title()}</p>
                    <p><strong>Message:</strong> {message}</p>
                    <p><strong>Time:</strong> {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC</p>
                    <hr>
                    <p>Log in to your portal to view live tracking.</p>
                    """
                    # We use asyncio.create_task to not block the TCP server
                    asyncio.create_task(AlertService._send_email_async(rule.contact, subject, html))
                
                elif rule.channel == "sms" and rule.contact:
                    # Trigger actual SMS via configured provider
                    asyncio.create_task(SMSService.send_sms_async(rule.contact, message))

    @staticmethod
    async def _send_email_async(to, subject, html):
        try:
            send_email(to, subject, html)
        except Exception as e:
            print(f"FAILED to send alert email: {e}")

    @staticmethod
    async def _check_geofence(db: Session, device: Device, lat: float, lng: float):
        """Check if device has entered or exited a geofence."""
        # Fetch geofences that have not triggered yet; each zone belongs to one tracker
        geo_res = await db.execute(select(Geofence).where(Geofence.triggered_at.is_(None)))
        state = dict(device.device_metadata or {})
        events, changed = [], False
        for geofence in geo_res.scalars().all():
            ring = AlertService._polygon_ring(geofence.geojson)
            if ring is None or str(device.id) not in {str(asset) for asset in (geofence.assets or [])}:
                continue
            key = f"geofence_{geofence.id}"
            # Check if point is inside geofence (simple bounding box check for polygons)
            inside = AlertService._point_in_polygon(lat, lng, ring)
            # Check if we were outside before (store last state in device metadata)
            previous, current = state.get(key), "inside" if inside else "outside"
            if previous == current:
                continue
            # Update state
            state[key] = current
            changed = True
            kind = "entry" if inside else "exit"
            if previous is not None and (geofence.alert_rules or {}).get(kind):
                claimed = await db.execute(
                    update(Geofence.__table__)
                    .where(Geofence.__table__.c.id == geofence.id, Geofence.__table__.c.triggered_at.is_(None))
                    .values(triggered_at=func.now())
                    .returning(Geofence.__table__.c.id)
                )
                if claimed.scalar() is not None:
                    verb = "entered" if inside else "exited"
                    message = f"Geofence {kind.title()}: {device.name} {verb} {geofence.name}"
                    db.add(Alert(tenant_id=device.tenant_id, device_id=device.id, type=f"geofence_{kind}", message=message))
                    events.append((kind, message))
        if changed:
            device.device_metadata = state
            await db.commit()
        return events

    @staticmethod
    def _polygon_ring(geojson):
        geometry = geojson.get("geometry", geojson) if isinstance(geojson, dict) else None
        if not geometry or geometry.get("type") != "Polygon":
            return None
        rings = geometry.get("coordinates") or []
        ring = rings[0] if rings else []
        return ring if len(ring) >= 3 else None

    @staticmethod
    def _point_in_polygon(lat: float, lng: float, polygon: list) -> bool:
        """Ray casting algorithm to check if point is inside polygon."""
        x, y = lng, lat  # GeoJSON uses [lng, lat]
        n = len(polygon)
        inside = False
        p1x, p1y = polygon[0]
        for i in range(n + 1):
            p2x, p2y = polygon[i % n]
            if y > min(p1y, p2y):
                if y <= max(p1y, p2y):
                    if x <= max(p1x, p2x):
                        if p1y != p2y:
                            xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                        if p1x == p2x or x <= xinters:
                            inside = not inside
            p1x, p1y = p2x, p2y
        return inside

    @staticmethod
    async def _check_offline(db: Session, device: Device, threshold_minutes: int):
        """Check if device has been offline for longer than threshold."""
        # Get last position timestamp
        from app.models import Position
        pos_res = await db.execute(
            select(Position).where(Position.device_id == device.id).order_by(Position.timestamp.desc()).limit(1)
        )
        last_pos = pos_res.scalars().first()
        
        if not last_pos:
            return False, ""
        
        offline_duration = datetime.utcnow() - last_pos.timestamp
        if offline_duration > timedelta(minutes=threshold_minutes):
            # Check if we already alerted for this offline period
            last_state = device.device_metadata or {}
            last_offline_alert = last_state.get("last_offline_alert")
            if last_offline_alert:
                last_alert_time = datetime.fromisoformat(last_offline_alert)
                if datetime.utcnow() - last_alert_time < timedelta(hours=1):  # Don't alert more than once per hour
                    return False, ""
            
            # Update state
            device.device_metadata = {**last_state, "last_offline_alert": datetime.utcnow().isoformat()}
            await db.commit()
            return True, f"Device Offline: {device.name} has been offline for {offline_duration.total_seconds() / 60:.0f} minutes"
        
        return False, ""

    @staticmethod
    async def _check_excessive_idling(db: Session, device: Device, threshold_minutes: int):
        """Check if device has been idling for longer than threshold."""
        from app.models import Position
        
        # Get recent positions to check for idle state
        idle_start_time = None
        pos_res = await db.execute(
            select(Position).where(
                Position.device_id == device.id,
                Position.timestamp > datetime.utcnow() - timedelta(hours=1)
            ).order_by(Position.timestamp.asc())
        )
        positions = pos_res.scalars().all()
        
        for pos in positions:
            if pos.speed is not None and pos.speed < 2:  # Speed < 2 km/h considered idle
                if idle_start_time is None:
                    idle_start_time = pos.timestamp
            else:
                idle_start_time = None
        
        if idle_start_time:
            idle_duration = datetime.utcnow() - idle_start_time
            if idle_duration > timedelta(minutes=threshold_minutes):
                # Check if we already alerted for this idle period
                last_state = device.device_metadata or {}
                last_idle_alert = last_state.get("last_idle_alert")
                if last_idle_alert:
                    last_alert_time = datetime.fromisoformat(last_idle_alert)
                    if datetime.utcnow() - last_alert_time < timedelta(hours=1):
                        return False, ""
                
                # Update state
                device.device_metadata = {**last_state, "last_idle_alert": datetime.utcnow().isoformat()}
                await db.commit()
                return True, f"Excessive Idling: {device.name} has been idling for {idle_duration.total_seconds() / 60:.0f} minutes"
        
        return False, ""
