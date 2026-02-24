from app.services.decoders.base import BaseDecoder
from typing import Dict, Any
import re

class SinotrackDecoder(BaseDecoder):
    async def decode(self, raw: bytes) -> Dict[str, Any]:
        """
        Decodes Sinotrack / Micodus protocol messages.
        Supports text-based patterns like ID:..., imei:..., and $$ binary/text hybrids.
        """
        text = raw.decode(errors="ignore").strip()
        
        # 1. Try to find IMEI or ID (Sinotrack uses ID: for ST-901 usually)
        # Format: ID:3009217647 or imei:359...
        imei_match = re.search(r'(?:imei|ID)[:=]?(\d{5,20})', text)
        
        # 2. Try to find Latitude/Longitude
        # Format: 17.828554,S,31.051837,E (Common GPRS text)
        # OR: 1815.2146,S,03039.9207,E (NMEA style)
        
        # Pattern A: Decimal Degrees (17.828554,S,31.051837,E)
        lat_lon_dec = re.search(r'([-+]?\d+\.\d+).*?([NS])[,; ]+([-+]?\d+\.\d+).*?([EW])', text)
        
        # Pattern B: NMEA Style (1815.2146,S,03039.9207,E)
        # 1815.2146 -> 18 degrees, 15.2146 minutes
        lat_lon_nmea = re.search(r'(\d{2,4})(\d{2}\.\d+),([NS]),(\d{3,5})(\d{2}\.\d+),([EW])', text)

        if imei_match:
            imei = imei_match.group(1)
            lat, lon = None, None

            if lat_lon_dec:
                lat = float(lat_lon_dec.group(1))
                if lat_lon_dec.group(2).upper() == 'S': lat = -lat
                lon = float(lat_lon_dec.group(3))
                if lat_lon_dec.group(4).upper() == 'W': lon = -lon
            
            elif lat_lon_nmea:
                # Convert NMEA to Decimal Degrees
                lat_deg = float(lat_lon_nmea.group(1).zfill(4)[:2])
                lat_min = float(lat_lon_nmea.group(2))
                lat = lat_deg + (lat_min / 60.0)
                if lat_lon_nmea.group(3).upper() == 'S': lat = -lat
                
                lon_deg = float(lat_lon_nmea.group(4).zfill(5)[:3])
                lon_min = float(lat_lon_nmea.group(5))
                lon = lon_deg + (lon_min / 60.0)
                if lat_lon_nmea.group(6).upper() == 'W': lon = -lon

            if lat is not None and lon is not None:
                return {
                    "imei": imei,
                    "latitude": lat,
                    "longitude": lon,
                    "raw_text": text
                }

        # Fallback for binary header Format 1: $$<length>|<imei>|<command>|...
        if text.startswith("$$"):
            parts = text.split("|")
            if len(parts) >= 8:
                try:
                    imei = parts[1]
                    lat = float(parts[4])
                    if parts[5].upper() == 'S': lat = -lat
                    lon = float(parts[6])
                    if parts[7].upper() == 'W': lon = -lon
                    return {"imei": imei, "latitude": lat, "longitude": lon, "raw_text": text}
                except (ValueError, IndexError):
                    pass

        return {"raw_text": text}
