import asyncio
from app.config import settings
from app.services.decoders.gps103 import GPS103Decoder
from app.services.decoders.sinotrack import SinotrackDecoder
from app.services.decoders.teltonika import TeltonikaDecoder
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
    GT06Decoder(),
    TeltonikaDecoder()
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

    # Bytes that indicate the start of a known BINARY protocol frame.
    _BINARY_HEADERS = (b'\x00\x00\x00\x00', b'\x78\x78', b'\x79\x79')
    # Terminators used by TEXT protocols (Sinotrack / GPS103 / TK103).
    _TEXT_TERMINATORS = (b'\r\n', b'\n', b';', b'#', b')')

    def data_received(self, data):
        import struct
        self.buffer += data

        # Keep processing complete frames/messages out of the buffer.
        while self.buffer:
            # --- BINARY: Teltonika frames start with 0x00000000 (4 zero bytes) ---
            if self.buffer.startswith(b'\x00\x00\x00\x00'):
                if len(self.buffer) < 12:
                    break  # need full preamble + length
                data_length = struct.unpack('!I', self.buffer[4:8])[0]
                total_len = 12 + data_length  # Preamble(4) + DataLength(4) + Data + CRC(4)
                if len(self.buffer) < total_len:
                    break
                packet = self.buffer[:total_len]
                self.buffer = self.buffer[total_len:]
                self._process_packet(packet)

            # --- BINARY: GT06 frames start with 0x7878 ---
            elif self.buffer.startswith(b'\x78\x78'):
                if len(self.buffer) < 5:
                    break
                length = self.buffer[2]
                total_len = length + 5  # Header(2) + Len(1) + Stop(2)
                if len(self.buffer) < total_len:
                    break
                packet = self.buffer[:total_len]
                self.buffer = self.buffer[total_len:]
                self._process_packet(packet)

            # --- BINARY: GT06 extended frames start with 0x7979 ---
            elif self.buffer.startswith(b'\x79\x79'):
                if len(self.buffer) < 6:
                    break
                length = struct.unpack('!H', self.buffer[2:4])[0]
                total_len = length + 6  # Header(2) + Len(2) + Stop(2)
                if len(self.buffer) < total_len:
                    break
                packet = self.buffer[:total_len]
                self.buffer = self.buffer[total_len:]
                self._process_packet(packet)

            # --- TEXT: Sinotrack / GPS103 / TK103 (e.g. "imei:8040000,...;") ---
            else:
                # Find the earliest message terminator in the buffer.
                end_idx = -1
                term_len = 0
                for term in self._TEXT_TERMINATORS:
                    idx = self.buffer.find(term)
                    if idx != -1 and (end_idx == -1 or idx < end_idx):
                        end_idx = idx
                        term_len = len(term)

                if end_idx == -1:
                    # No complete text message yet. If a binary header appears
                    # later in the buffer, drop the leading garbage up to it so
                    # we don't stall. Otherwise wait for more data (cap growth).
                    next_bin = -1
                    for hdr in self._BINARY_HEADERS:
                        idx = self.buffer.find(hdr)
                        if idx > 0 and (next_bin == -1 or idx < next_bin):
                            next_bin = idx
                    if next_bin > 0:
                        self.buffer = self.buffer[next_bin:]
                        continue
                    if len(self.buffer) > 4096:
                        # Prevent unbounded buffering from a misbehaving client.
                        self.buffer = b""
                    break

                # Extract the complete text message (including terminator).
                packet = self.buffer[:end_idx + term_len]
                self.buffer = self.buffer[end_idx + term_len:]
                # Ignore empty/whitespace-only fragments left between messages.
                if packet.strip():
                    self._process_packet(packet)

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
                        if position and decoded.get("type") not in ["heartbeat", "login"]:
                            await publish_position({
                                "id": position.id,
                                "imei": device.imei,
                                "latitude": decoded.get("latitude"),
                                "longitude": decoded.get("longitude"),
                                "speed": decoded.get("speed", 0.0),
                                "timestamp": timestamp.isoformat() + "Z",
                                "raw": sanitized_decoded
                            })

                        # 5. ALERT EVALUATION (Persistent Rules)
                        from app.services.alerts import AlertService
                        try:
                            # Run in background to not block the receiver
                            asyncio.create_task(AlertService.evaluate_rules(db, device.id, {
                                "latitude": decoded.get("latitude"),
                                "longitude": decoded.get("longitude"),
                                "speed": decoded.get("speed", 0.0),
                                "raw": sanitized_decoded
                            }))
                        except Exception as alert_err:
                            print(f"[{datetime.now()}] ALERT EVALUATION ERROR: {alert_err}")

                    except Exception as e:
                        print(f"[{datetime.now()}] ERROR saving position: {e}")
            else:
                if decoded.get("type") != "unknown":
                    print(f"[{datetime.now()}] IGNORED packet (No IMEI): {decoded.get('type')} | Hex: {data.hex()[:50]}...")

        except Exception as e:
            print(f"[{datetime.now()}] ERROR in handle: {e}")
