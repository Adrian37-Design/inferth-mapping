from sqlalchemy.orm import Session
from sqlalchemy import select
from app.models import Rule, Alert, Device, User
from app.services.email import send_email
from datetime import datetime
import asyncio

class AlertService:
    @staticmethod
    async def evaluate_rules(db: Session, device_id: int, position_data: dict):
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

            if triggered:
                # 3. Create Alert Record
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
                    # Placeholder for SMS Gateway (e.g. Twilio/Infobip)
                    print(f"SMS ALERT TRIGGERED for {rule.contact}: {message}")
                    # asyncio.create_task(AlertService._send_sms_async(rule.contact, message))

    @staticmethod
    async def _send_email_async(to, subject, html):
        try:
            send_email(to, subject, html)
        except Exception as e:
            print(f"FAILED to send alert email: {e}")
