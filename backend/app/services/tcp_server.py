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
from app.realtime import publish_position

def sanitize_for_json(data):
    """Recursively convert bytes to hex strings for JSON serialization."""
    if isinstance(data, dict):
        return {k: sanitize_for_json(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [sanitize_for_json(i) for i in data]
    elif isinstance(data, bytes):
        return data.hex()
    return data

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
        self.is_sinotrack = False # Identification flag
        self.buffer = b"" # Splitting buffer

    def connection_made(self, transport):
        self.transport = transport
        self.peer = transport.get_extra_info('peername')
        print(f"[{datetime.now()}] --- NEW CONNECTION: {self.peer} ---")

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
            print(f"[{datetime.now()}] FORWARDING ERROR: {e}")

    def data_received(self, data):
        self.buffer += data
        
        while len(self.buffer) >= 5:
            # GT06 frames start with 0x7878 or 0x7979
            if self.buffer.startswith(b'\x78\x78'):
                length = self.buffer[2]
                total_len = length + 5 # Header(2) + Len(1) + Stop(2) = 5. Length field is Data+Serial+CRC
                if len(self.buffer) < total_len:
                    break
                packet = self.buffer[:total_len]
                self.buffer = self.buffer[total_len:]
                self._process_packet(packet)
            elif self.buffer.startswith(b'\x79\x79'):
                import struct
                length = struct.unpack('!H', self.buffer[2:4])[0]
                total_len = length + 6 # Header(2) + Len(2) + Stop(2) = 6
                if len(self.buffer) < total_len:
                    break
                packet = self.buffer[:total_len]
                self.buffer = self.buffer[total_len:]
                self._process_packet(packet)
            else:
                # Seek for next potential header
                self.buffer = self.buffer[1:]

    def _process_packet(self, data):
        print(f"[{datetime.now()}] RECV hex: {data.hex()}")
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.handle(data))
            
            # Mirror data ONLY if this session is identified as Sinotrack
            if self.is_sinotrack and settings.SECONDARY_DESTINATION:
                loop.create_task(self._forward_data(data))
                
        except Exception as e:
            print(f"[{datetime.now()}] ERROR creating task: {e}")

    async def handle(self, data: bytes):
        try:
            # Try each decoder in sequence; use the first one that returns a full result
            decoded = {"raw_text": data.decode(errors="ignore").strip()}
            for dec in decoders:
                result = await dec.decode(data)
                
                # If decoder produced a RESPONSE (ACK), send it back IMMEDIATELY
                if result.get("response"):
                    self.transport.write(result["response"])
                    print(f"[{datetime.now()}] SENT hex: {result['response'].hex()}")

                # Persistence Logic:
                # 1. If decoder found a NEW IMEI, update session
                if result.get("imei"):
                    self.imei = result["imei"]
                
                # 2. If decoder didn't find IMEI but we HAVE ONE in session, inject it
                if not result.get("imei") and self.imei:
                    result["imei"] = self.imei

                if result.get("imei") and (result.get("latitude") or result.get("type") in ["login", "obd", "heartbeat"]):
                    decoded = result
                    # Identify session type for selective mirroring
                    if isinstance(dec, SinotrackDecoder):
                        if not self.is_sinotrack:
                            self.is_sinotrack = True
                            # Forward the identifying packet (login or first location)
                            if settings.SECONDARY_DESTINATION:
                                asyncio.create_task(self._forward_data(data))
                    break
            
            print(f"[{datetime.now()}] DECODED: {decoded.get('imei')} - {decoded.get('type')} ({decoded.get('latitude')}, {decoded.get('longitude')})")
            
            # if we have an imei: create a position (coords might be null for pure OBD)
            if decoded.get("imei"):
                async with AsyncSessionLocal() as db:
                    try:
                        # Find or create device
                        result = await db.execute(select(Device).filter(Device.imei == decoded["imei"]))
                        device = result.scalars().first()
                        
                        if not device:
                            print(f"[{datetime.now()}] AUTO-CREATING device {decoded['imei']} for Tenant 1")
                            device = Device(imei=decoded['imei'], name=f"Tracker {decoded['imei']}", tenant_id=1)
                            db.add(device)
                            await db.commit()
                            await db.refresh(device)
                        
                        # Create position
                        timestamp = datetime.utcnow()
                        # Sanitize decoded dict for JSON storage
                        sanitized_decoded = sanitize_for_json(decoded)
                        
                        position = Position(
                            device_id=device.id,
                            latitude=decoded.get("latitude"),
                            longitude=decoded.get("longitude"),
                            speed=decoded.get("speed", 0.0),
                            timestamp=timestamp,
                            raw=sanitized_decoded
                        )
                        db.add(position)
                        await db.commit()
                        print(f"SUCCESS: Saved data for device {device.imei}")

                        # REALTIME BROADCAST
                        await publish_position({
                            "id": position.id,
                            "imei": device.imei,
                            "latitude": decoded.get("latitude"),
                            "longitude": decoded.get("longitude"),
                            "speed": decoded.get("speed", 0.0),
                            "timestamp": timestamp.isoformat(),
                            "raw": sanitized_decoded
                        })
                    except Exception as e:
                        print(f"[{datetime.now()}] ERROR saving position: {e}")
            else:
                if decoded.get("type") != "unknown":
                    print(f"[{datetime.now()}] IGNORED packet (No IMEI): {decoded.get('type')} | Hex: {data.hex()[:50]}...")

        except Exception as e:
            print(f"[{datetime.now()}] ERROR in handle: {e}")
