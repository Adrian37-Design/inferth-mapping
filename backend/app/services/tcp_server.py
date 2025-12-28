import asyncio
from app.config import settings
from app.services.decoders.gps103 import GPS103Decoder
from app.routers.positions import create_position
import json
from datetime import datetime
from app.db import AsyncSessionLocal
from app.models import Position, Device
from sqlalchemy import select
import sys

decoder = GPS103Decoder()

class TCPTrackerProtocol(asyncio.Protocol):
    def __init__(self, app_state):
        self.app_state = app_state
        self.transport = None
        self.peer = None

    def connection_made(self, transport):
        self.transport = transport
        self.peer = transport.get_extra_info('peername')
        with open("/app/debug.log", "a") as f:
            f.write(f"DEBUG: Connection made from {self.peer}\n")

    def data_received(self, data):
        with open("/app/debug.log", "a") as f:
            f.write(f"DEBUG: Data received: {data}\n")
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.handle(data))
            with open("/app/debug.log", "a") as f:
                f.write("DEBUG: Task created\n")
        except Exception as e:
            with open("/app/debug.log", "a") as f:
                f.write(f"ERROR creating task: {e}\n")

    async def handle(self, data: bytes):
        with open("/app/debug.log", "a") as f:
            f.write("DEBUG: Inside handle\n")
        try:
            # decode using pluggable decoder
            decoded = await decoder.decode(data)
            with open("/app/debug.log", "a") as f:
                f.write(f"DEBUG: Decoded data: {decoded}\n")
            
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
                            with open("/app/debug.log", "a") as f:
                                f.write(f"DEBUG: Creating new device {decoded['imei']}\n")
                            device = Device(imei=decoded['imei'], name=f"Tracker {decoded['imei']}")
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
                        with open("/app/debug.log", "a") as f:
                            f.write(f"ERROR saving position: {e}\n")
            else:
                with open("/app/debug.log", "a") as f:
                    f.write(f"DEBUG: Missing required fields in decoded data: {decoded}\n")

        except Exception as e:
             with open("/app/debug.log", "a") as f:
                f.write(f"ERROR in handle: {e}\n")
