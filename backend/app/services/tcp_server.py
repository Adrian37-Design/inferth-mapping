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
        self.imei = None # Session IMEI persistence

    def connection_made(self, transport):
        self.transport = transport
        self.peer = transport.get_extra_info('peername')
        # Robust Logging to a local file for the USER to see
        with open("tracker_debug.log", "a") as f:
            f.write(f"\n[{datetime.now()}] --- NEW CONNECTION: {self.peer} ---\n")

    async def _forward_data(self, data: bytes):
        """Asynchronously forward data to secondary destination (Sinotrack)."""
        if not settings.SECONDARY_DESTINATION:
            return
            
        try:
            host, port = settings.SECONDARY_DESTINATION.split(":")
            # Use a short timeout to avoid hanging if Sinotrack is slow/down
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, int(port)), 
                timeout=3.0
            )
            writer.write(data)
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        except Exception as e:
            with open("tracker_debug.log", "a") as f:
                f.write(f"[{datetime.now()}] FORWARDING ERROR: {e}\n")

    def data_received(self, data):
        with open("tracker_debug.log", "a") as f:
            f.write(f"[{datetime.now()}] RECV hex: {data.hex()}\n")
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.handle(data))
            
            # Mirror data to secondary destination (Sinotrack)
            if settings.SECONDARY_DESTINATION:
                loop.create_task(self._forward_data(data))
                
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

                # Persistence Logic:
                # 1. If decoder found a NEW IMEI, update session
                if result.get("imei"):
                    self.imei = result["imei"]
                
                # 2. If decoder didn't find IMEI but we HAVE ONE in session, inject it
                if not result.get("imei") and self.imei:
                    result["imei"] = self.imei

                if result.get("imei") and (result.get("latitude") or result.get("type") in ["login", "obd"]):
                    decoded = result
                    break
            
            with open("tracker_debug.log", "a") as f:
                f.write(f"[{datetime.now()}] DECODED: {decoded.get('imei')} - {decoded.get('type')} ({decoded.get('latitude')}, {decoded.get('longitude')})\n")
            
            # if we have an imei: create a position (coords might be null for pure OBD)
            if decoded.get("imei"):
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
                            latitude=decoded.get("latitude"),
                            longitude=decoded.get("longitude"),
                            speed=decoded.get("speed", 0.0),
                            timestamp=datetime.utcnow(),
                            raw=decoded
                        )
                        db.add(position)
                        await db.commit()
                        with open("debug.log", "a") as f:
                            f.write(f"SUCCESS: Saved data for device {device.imei}\n")
                    except Exception as e:
                        with open("tracker_debug.log", "a") as f:
                            f.write(f"[{datetime.now()}] ERROR saving position: {e}\n")
            else:
                pass # Already logged missing fields in DECODED line

        except Exception as e:
            with open("tracker_debug.log", "a") as f:
                f.write(f"[{datetime.now()}] ERROR in handle: {e}\n")
