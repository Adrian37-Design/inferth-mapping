import asyncio
from app.config import settings
from app.services.decoders.gps103 import GPS103Decoder
from app.services.decoders.sinotrack import SinotrackDecoder
from app.routers.positions import create_position
import json
from datetime import datetime
from app.db import AsyncSessionLocal
from app.models import Position, Device
from sqlalchemy import select
import sys

from app.services.decoders.gt06 import GT06Decoder

# Initialize multiple decoders for broad compatibility
decoders = [
    SinotrackDecoder(),
    GPS103Decoder(),
    GT06Decoder()
]

class TCPTrackerProtocol(asyncio.Protocol):
    def __init__(self, app_state):
        self.app_state = app_state
        self.transport = None
        self.peer = None

    def connection_made(self, transport):
        self.transport = transport
        self.peer = transport.get_extra_info('peername')
        # Robust Logging to a local file for the USER to see
        with open("tracker_debug.log", "a") as f:
            f.write(f"\n[{datetime.now()}] --- NEW CONNECTION: {self.peer} ---\n")

    def data_received(self, data):
        with open("tracker_debug.log", "a") as f:
            f.write(f"[{datetime.now()}] RECV hex: {data.hex()}\n")
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.handle(data))
        except Exception as e:
            with open("tracker_debug.log", "a") as f:
                f.write(f"[{datetime.now()}] ERROR creating task: {e}\n")

    async def handle(self, data: bytes):
        try:
            # Try each decoder in sequence; use the first one that returns a full result
            decoded = {"raw_text": data.decode(errors="ignore").strip()}
            for dec in decoders:
                result = await dec.decode(data)
                
                # If decoder produced a RESPONSE (ACK), send it back IMMEDIATELY
                if result.get("response"):
                    self.transport.write(result["response"])
                    with open("tracker_debug.log", "a") as f:
                        f.write(f"[{datetime.now()}] SENT hex: {result['response'].hex()}\n")

                if result.get("imei") and (result.get("latitude") or result.get("type") == "login"):
                    decoded = result
                    break
            
            with open("tracker_debug.log", "a") as f:
                f.write(f"[{datetime.now()}] DECODED: {decoded.get('imei')} - {decoded.get('type')}\n")
            
            # if we find coordinates and imei: create a position
            if decoded.get("imei") and decoded.get("latitude") and decoded.get("longitude"):
                payload = {
                    "imei": decoded["imei"],
                    "latitude": decoded["latitude"],
                    "longitude": decoded["longitude"],
                    "raw": {"text": decoded.get("raw_text")}
                }
                
                async with AsyncSessionLocal() as db:
                    try:
                        # Find or create device
                        result = await db.execute(select(Device).filter(Device.imei == decoded["imei"]))
                        device = result.scalars().first()
                        
                        if not device:
                            with open("tracker_debug.log", "a") as f:
                                f.write(f"[{datetime.now()}] AUTO-CREATING device {decoded['imei']} for Tenant 1\n")
                            device = Device(imei=decoded['imei'], name=f"Tracker {decoded['imei']}", tenant_id=1)
                            db.add(device)
                            await db.commit()
                            await db.refresh(device)
                        
                        # Create position
                        position = Position(
                            device_id=device.id,
                            latitude=decoded["latitude"],
                            longitude=decoded["longitude"],
                            speed=0.0, # Default or extract if available
                            timestamp=datetime.utcnow(),
                            raw=payload["raw"]
                        )
                        db.add(position)
                        await db.commit()
                        with open("/app/debug.log", "a") as f:
                            f.write(f"SUCCESS: Saved position for device {device.imei}\n")
                    except Exception as e:
                        with open("tracker_debug.log", "a") as f:
                            f.write(f"[{datetime.now()}] ERROR saving position: {e}\n")
            else:
                pass # Already logged missing fields in DECODED line

        except Exception as e:
             with open("tracker_debug.log", "a") as f:
                f.write(f"[{datetime.now()}] ERROR in handle: {e}\n")
