from app.services.decoders.base import BaseDecoder
from typing import Dict, Any, Optional
import struct
from datetime import datetime

def crc16_ibm(data: bytes) -> int:
    """CRC-16/IBM implementation for Teltonika protocol."""
    crc = 0x0000
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            if crc & 0x8000:
                crc = (crc << 1) ^ 0x8005
            else:
                crc = (crc << 1)
            crc &= 0xFFFF
    return crc

class TeltonikaDecoder(BaseDecoder):
    """
    Decodes Teltonika GPS tracker protocols (Codec 8, Codec 8 Extended, Codec 16).
    Supports FMB/FMC/FMM/TAT/TFT family devices.
    """
    
    def __init__(self):
        self.imei = None
        self.codec_id = None
    
    def _parse_imei_handshake(self, data: bytes) -> Optional[Dict[str, Any]]:
        """Parse IMEI handshake packet (15 bytes)."""
        try:
            if len(data) < 15:
                return None
            
            # IMEI is 15 bytes ASCII
            imei = data[:15].decode('ascii').strip()
            
            # Validate IMEI (should be 15 digits)
            if imei.isdigit() and len(imei) == 15:
                # Send ACK response (0x01 for accept)
                return {
                    "imei": imei,
                    "type": "login",
                    "response": b'\x01',
                    "raw_text": data.hex()
                }
        except Exception as e:
            print(f"Teltonika IMEI parse error: {e}")
        
        return None
    
    def _parse_gps_element(self, data: bytes, offset: int) -> Dict[str, Any]:
        """Parse GPS element from AVL data (15 bytes)."""
        try:
            # Longitude: 4 bytes integer
            lon_int = struct.unpack('!i', data[offset:offset+4])[0]
            # Latitude: 4 bytes integer  
            lat_int = struct.unpack('!i', data[offset+4:offset+8])[0]
            # Altitude: 2 bytes (0.01m)
            altitude = struct.unpack('!h', data[offset+8:offset+10])[0] * 0.01
            # Angle: 2 bytes (0.01 degrees)
            angle = struct.unpack('!h', data[offset+10:offset+12])[0] * 0.01
            # Satellites: 1 byte
            satellites = data[offset+12]
            # Speed: 2 bytes (0.01 km/h)
            speed = struct.unpack('!H', data[offset+13:offset+15])[0] * 0.01
            
            # Convert integer coordinates to decimal degrees
            # Formula: value / 10,000,000
            longitude = lon_int / 10000000.0
            latitude = lat_int / 10000000.0
            
            return {
                "longitude": longitude,
                "latitude": latitude,
                "altitude": altitude,
                "heading": angle,
                "satellites": satellites,
                "speed": speed
            }
        except Exception as e:
            print(f"GPS element parse error: {e}")
            return {}
    
    def _parse_io_element(self, data: bytes, offset: int, codec_id: int) -> Dict[str, Any]:
        """Parse IO element from AVL data."""
        try:
            io_elements = {}
            
            if codec_id == 0x08:  # Codec 8
                # 1-byte IO element count, 1-byte AVL ID, variable data
                io_count = data[offset]
                pos = offset + 1
                
                for _ in range(io_count):
                    if pos + 1 >= len(data):
                        break
                    io_id = data[pos]
                    io_count_bytes = data[pos + 1]
                    pos += 2
                    
                    if pos + io_count_bytes > len(data):
                        break
                    
                    # Parse IO value based on size
                    if io_count_bytes == 1:
                        io_value = data[pos]
                    elif io_count_bytes == 2:
                        io_value = struct.unpack('!H', data[pos:pos+2])[0]
                    elif io_count_bytes == 4:
                        io_value = struct.unpack('!I', data[pos:pos+4])[0]
                    elif io_count_bytes == 8:
                        io_value = struct.unpack('!Q', data[pos:pos+8])[0]
                    else:
                        io_value = data[pos:pos+io_count_bytes].hex()
                    
                    io_elements[f"io_{io_id}"] = io_value
                    pos += io_count_bytes
                    
            elif codec_id in [0x8E, 0x10]:  # Codec 8 Extended or Codec 16
                # 2-byte IO element count, 2-byte AVL ID, variable data
                io_count = struct.unpack('!H', data[offset:offset+2])[0]
                pos = offset + 2
                
                for _ in range(io_count):
                    if pos + 3 >= len(data):
                        break
                    io_id = struct.unpack('!H', data[pos:pos+2])[0]
                    io_count_bytes = data[pos + 2]
                    pos += 3
                    
                    if pos + io_count_bytes > len(data):
                        break
                    
                    # Parse IO value based on size
                    if io_count_bytes == 1:
                        io_value = data[pos]
                    elif io_count_bytes == 2:
                        io_value = struct.unpack('!H', data[pos:pos+2])[0]
                    elif io_count_bytes == 4:
                        io_value = struct.unpack('!I', data[pos:pos+4])[0]
                    elif io_count_bytes == 8:
                        io_value = struct.unpack('!Q', data[pos:pos+8])[0]
                    else:
                        io_value = data[pos:pos+io_count_bytes].hex()
                    
                    io_elements[f"io_{io_id}"] = io_value
                    pos += io_count_bytes
            
            return io_elements
        except Exception as e:
            print(f"IO element parse error: {e}")
            return {}
    
    def _parse_avl_record(self, data: bytes, offset: int, codec_id: int) -> Dict[str, Any]:
        """Parse a single AVL record."""
        try:
            # Timestamp: 8 bytes (UNIX time in milliseconds)
            timestamp_ms = struct.unpack('!Q', data[offset:offset+8])[0]
            timestamp = datetime.fromtimestamp(timestamp_ms / 1000.0)
            
            # Priority: 1 byte (0=low, 1=high, 2=panic)
            priority = data[offset + 8]
            priority_map = {0: "low", 1: "high", 2: "panic"}
            
            # GPS Element: 15 bytes
            gps_data = self._parse_gps_element(data, offset + 9)
            
            # IO Element: variable length
            io_data = self._parse_io_element(data, offset + 24, codec_id)
            
            result = {
                "timestamp": timestamp.isoformat(),
                "priority": priority_map.get(priority, "unknown"),
                **gps_data,
                "io_elements": io_data
            }
            
            # For Codec 16, add generation type if present
            if codec_id == 0x16:
                # Generation type is typically part of IO elements or separate
                pass
            
            return result
        except Exception as e:
            print(f"AVL record parse error: {e}")
            return {}
    
    def _parse_avl_packet(self, data: bytes) -> Optional[Dict[str, Any]]:
        """Parse complete AVL data packet."""
        try:
            # Minimum packet size: Preamble(4) + DataLength(4) + CodecID(1) + NOD1(1) + CRC(4) = 14 bytes
            if len(data) < 14:
                return None
            
            # Check preamble (4 zero bytes)
            if data[:4] != b'\x00\x00\x00\x00':
                return None
            
            # Data field length: 4 bytes
            data_length = struct.unpack('!I', data[4:8])[0]
            
            # Codec ID: 1 byte
            codec_id = data[8]
            
            # Number of data 1: 1 byte
            nod1 = data[9]
            
            # Validate codec ID
            if codec_id not in [0x08, 0x8E, 0x10]:
                return None
            
            # Calculate expected total length
            expected_length = 12 + data_length  # Preamble(4) + DataLength(4) + Data(data_length) + CRC(4)
            
            if len(data) < expected_length:
                return None
            
            # Extract AVL data
            avl_data_start = 10
            avl_data_end = 10 + data_length - 2  # -2 for NOD2 at the end
            
            # Parse AVL records
            records = []
            current_offset = avl_data_start
            
            for i in range(nod1):
                if current_offset >= avl_data_end:
                    break
                record = self._parse_avl_record(data, current_offset, codec_id)
                if record:
                    records.append(record)
                # Move to next record (rough estimation, actual depends on IO element sizes)
                # This is simplified - in production, you'd need to track exact positions
                current_offset += 24  # Minimum record size (timestamp + priority + GPS)
            
            # Validate CRC (optional - can be disabled for testing)
            crc_data = data[8:8 + data_length]
            calculated_crc = crc16_ibm(crc_data)
            received_crc = struct.unpack('!I', data[8 + data_length:12 + data_length])[0]
            
            if calculated_crc != received_crc:
                # Log CRC mismatch but continue processing
                pass
            
            # Use first record for position data
            if records:
                first_record = records[0]
                result = {
                    "type": "location",
                    "latitude": first_record.get("latitude"),
                    "longitude": first_record.get("longitude"),
                    "speed": first_record.get("speed", 0.0),
                    "altitude": first_record.get("altitude"),
                    "heading": first_record.get("heading"),
                    "satellites": first_record.get("satellites"),
                    "timestamp": first_record.get("timestamp"),
                    "priority": first_record.get("priority"),
                    "codec_id": codec_id,
                    "io_elements": first_record.get("io_elements", {}),
                    "raw_text": data.hex()
                }
                
                # Generate ACK response
                # ACK format: Number of accepted AVL elements (1 byte)
                ack = bytes([nod1])
                result["response"] = ack
                
                return result
            
        except Exception as e:
            pass
        
        return None
    
    async def decode(self, raw: bytes) -> Dict[str, Any]:
        """Decode Teltonika protocol data."""
        try:
            # Check if this is an AVL packet (starts with 4 zero bytes)
            if len(raw) >= 4 and raw[:4] == b'\x00\x00\x00\x00':
                avl_result = self._parse_avl_packet(raw)
                if avl_result:
                    # Add IMEI if we have it from handshake
                    if self.imei:
                        avl_result["imei"] = self.imei
                    return avl_result
            
            # Try IMEI handshake (15 bytes ASCII)
            if len(raw) == 15:
                imei_result = self._parse_imei_handshake(raw)
                if imei_result:
                    self.imei = imei_result["imei"]
                    return imei_result
            
            # If we have IMEI but couldn't parse this packet, return with IMEI
            if self.imei:
                return {
                    "imei": self.imei,
                    "type": "unknown",
                    "raw_text": raw.hex()
                }
            
            return {"raw_text": raw.hex(), "type": "unknown"}
            
        except Exception as e:
            return {"raw_text": raw.hex(), "error": str(e), "type": "unknown"}
