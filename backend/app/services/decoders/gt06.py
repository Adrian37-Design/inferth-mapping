from app.services.decoders.base import BaseDecoder
from typing import Dict, Any, Tuple
import struct
from datetime import datetime

def crc16_itu_t(data: bytes) -> int:
    """CRC-ITU-T implementation for GT06 protocol."""
    crc = 0xFFFF
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            if crc & 0x8000:
                crc = (crc << 1) ^ 0x1021
            else:
                crc = (crc << 1)
            crc &= 0xFFFF
    return crc ^ 0x0000

class GT06Decoder(BaseDecoder):
    """
    Decodes the binary GT06 protocol (Concox, TK series, etc.)
    Standard Header: 0x78 0x78
    """
    async def decode(self, raw: bytes) -> Dict[str, Any]:
        if len(raw) < 5:
            return {"raw_text": raw.hex()}

        # GT06 Header check (0x78 0x78)
        if raw[:2] != b'\x78\x78':
            return {"raw_text": raw.hex()}

        try:
            length = raw[2]
            protocol_number = raw[3]
            
            # 0x01: Login Message (IMEI)
            if protocol_number == 0x01:
                # IMEI is 8 bytes BCD starting at offset 4
                imei_bytes = raw[4:12]
                imei = "".join([f"{b:02x}" for b in imei_bytes])[1:] # GT06 IMEI is usually 15 digits
                
                # Extract Serial Number for ACK (usually at the end before CRC/Stop)
                # Packet: Header(2) | Len(1) | Prot(1) | IMEI(8) | Type(2) | Timezone(2) | Serial(2) | CRC(2) | Stop(2)
                # Total length for 0x01 is often 0x0D or similar
                serial_num = raw[-6:-4] 
                
                # Generate ACK
                # Header(2) | Len(1) | Prot(1) | Serial(2) | CRC(2) | Stop(2)
                ack_payload = b'\x05\x01' + serial_num
                ack_crc = crc16_itu_t(ack_payload)
                ack = b'\x78\x78' + ack_payload + struct.pack('!H', ack_crc) + b'\x0d\x0a'
                
                return {
                    "imei": imei, 
                    "type": "login", 
                    "response": ack,
                    "raw_text": raw.hex()
                }

            # 0x12, 0x22, 0x13, 0x23: Location Data / Heartbeat
            if protocol_number in [0x12, 0x22, 0x13, 0x23]:
                # 0x13/0x23 Heartbeat ACK: Header(2) | Len(1) | Prot(1) | Serial(2) | CRC(2) | Stop(2)
                if protocol_number in [0x13, 0x23]:
                    serial_num = raw[-6:-4]
                    ack_payload = struct.pack('!BB', 0x05, protocol_number) + serial_num
                    ack_crc = crc16_itu_t(ack_payload)
                    ack = b'\x78\x78' + ack_payload + struct.pack('!H', ack_crc) + b'\x0d\x0a'
                    return {"type": "heartbeat", "response": ack, "raw_text": raw.hex()}

                # Location parsing (0x12/0x22)
                # Placeholder for robust parsing - using basic coordinates extraction
                data = raw[4:]
                lat_int = struct.unpack('!I', data[7:11])[0]
                lon_int = struct.unpack('!I', data[11:15])[0]
                
                lat = lat_int / 1800000.0
                lon = lon_int / 1800000.0
                
                # Latitude/Longitude Direction flags in Course byte
                # ... (omitted for brevity, assume positive for now or add bitwise checks)
                
                return {
                    "latitude": lat,
                    "longitude": lon,
                    "speed": data[15],
                    "type": "location",
                    "raw_text": raw.hex()
                }

            return {"raw_text": raw.hex(), "protocol_number": hex(protocol_number)}

        except Exception as e:
            return {"raw_text": raw.hex(), "error": str(e)}
