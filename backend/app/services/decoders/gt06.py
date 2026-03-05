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
                # Packet: Date(6) | Sat(1) | Lat(4) | Lon(4) | Speed(1) | Course/Status(2) | ...
                data = raw[4:]
                lat_int = struct.unpack('!I', data[7:11])[0]
                lon_int = struct.unpack('!I', data[11:15])[0]
                
                lat = lat_int / 1800000.0
                lon = lon_int / 1800000.0
                
                # Course/Status byte (offset 16 from raw[4:])
                # Bit 10 (0x0400): Latitude N/S (1=North, 0=South)
                # Bit 11 (0x0800): Longitude E/W (0=East, 1=West)
                # Bit 12 (0x1000): ACC/Ignition (1=On, 0=Off)
                # Bit 13 (0x2000): Vehicle motion (1=Moving, 0=Stationary)
                course_status = struct.unpack('!H', data[16:18])[0]
                
                # Apply signs
                if not (course_status & 0x0400): # 0 = South
                    lat = -lat
                if (course_status & 0x0800): # 1 = West
                    lon = -lon
                
                ignition = bool(course_status & 0x1000)  # ACC bit
                in_motion = bool(course_status & 0x2000)  # Motion bit
                
                return {
                    "latitude": lat,
                    "longitude": lon,
                    "speed": data[15],
                    "ignition": ignition,
                    "in_motion": in_motion,
                    "type": "location",
                    "raw_text": raw.hex()
                }

            # 0x8A: OBD Data
            if protocol_number == 0x8A:
                # Packet: Header(2) | Len(1) | Prot(1) | Data(...) | Serial(2) | CRC(2) | Stop(2)
                # OBD Body often starts after offset 4
                obd_data = raw[4:-6]
                serial_num = raw[-6:-4]
                
                # Common GT06 0x8A Mapping (Standard OBD block length ~15-20 bytes)
                # Offset 0 (4 bytes): Accumulated Fuel Consumption
                # Offset 4 (2 bytes): Engine RPM
                # Offset 6 (1 byte): Coolant Temperature (often offset by 40, though sometimes raw)
                # Offset 7 (1 byte): Battery Voltage (often x 0.1V)
                # Offset 8 (1 byte): Throttle Position (%)
                # Offset 9 (1 byte): Engine Load (%)
                # Offset 10 (4 bytes): Mileage (Accumulative)
                
                res = {
                    "type": "obd",
                    "fuel_consumption": struct.unpack('!I', obd_data[0:4])[0] if len(obd_data) >= 4 else 0,
                    "rpm": struct.unpack('!H', obd_data[4:6])[0] if len(obd_data) >= 6 else 0,
                    "coolant": obd_data[6] if len(obd_data) > 6 else 0,
                    "battery": obd_data[7] * 0.1 if len(obd_data) > 7 else 0.0,
                    "throttle": obd_data[8] if len(obd_data) > 8 else 0,
                    "engine_load": obd_data[9] if len(obd_data) > 9 else 0,
                    "mileage": struct.unpack('!I', obd_data[10:14])[0] if len(obd_data) >= 14 else 0,
                    "raw_text": raw.hex()
                }
                
                # Add ACK for 0x8A
                ack_payload = struct.pack('!BB', 0x05, 0x8A) + serial_num
                ack_crc = crc16_itu_t(ack_payload)
                ack = b'\x78\x78' + ack_payload + struct.pack('!H', ack_crc) + b'\x0d\x0a'
                res["response"] = ack
                
                return res

            return {"raw_text": raw.hex(), "protocol_number": hex(protocol_number)}

        except Exception as e:
            return {"raw_text": raw.hex(), "error": str(e)}
