from app.routers.rules import RuleCreate
from app.routers.alerts import AlertOut
from datetime import datetime
import json

def test_rule_schema():
    print("Testing RuleCreate schema...")
    # Test case: Any Vehicle (device_id=None) and No threshold (threshold=None)
    data = {
        "device_id": None,
        "event_type": "offline",
        "threshold": None,
        "channel": "sms",
        "contact": "+263783009275",
        "is_active": True
    }
    try:
        rule = RuleCreate(**data)
        print("✅ RuleCreate accepted null device_id and threshold")
        print(rule.model_dump_json(indent=2))
    except Exception as e:
        print(f"❌ RuleCreate FAILED: {e}")

def test_alert_schema():
    print("\nTesting AlertOut schema...")
    data = {
        "id": 1,
        "type": "power_alarm",
        "message": "Power Cut",
        "timestamp": datetime.now(),
        "is_read": False,
        "device_id": 101,
        "device_name": None # Test null device_name
    }
    try:
        alert = AlertOut(**data)
        print("✅ AlertOut accepted null device_name")
        print(alert.model_dump_json(indent=2))
    except Exception as e:
        print(f"❌ AlertOut FAILED: {e}")

if __name__ == "__main__":
    test_rule_schema()
    test_alert_schema()
