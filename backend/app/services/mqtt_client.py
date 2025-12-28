import paho.mqtt.client as mqtt
import json
from app.config import settings

TOPIC = "ble/gateway/+/advert"

def on_connect(client, userdata, flags, rc):
    print("MQTT connected", rc)
    client.subscribe("ble/gateway/+/advert")

def on_message(client, userdata, msg):
    try:
        payload = msg.payload.decode()
        data = json.loads(payload)
        # expected: {"gateway_id":"g1", "tag_id":"AA:BB:CC:DD", "rssi":-60, "lat":..., "lon":...}
        print("MQTT message", data)
        # push to Redis or call DB worker
    except Exception as e:
        print("mqtt parse err", e)

def start_mqtt():
    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(settings.MQTT_BROKER, 1883, 60)
    client.loop_start()
    return client
