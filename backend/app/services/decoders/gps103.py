from app.services.decoders.base import BaseDecoder
from typing import Dict, Any
import re

class GPS103Decoder(BaseDecoder):
    async def decode(self, raw: bytes) -> Dict[str, Any]:
        with open("/app/debug.log", "a") as f:
            f.write(f"DEBUG: GPS103Decoder decoding: {raw}\n")
        text = raw.decode(errors="ignore").strip()
        # Example: "+RESP:GTFRI,imei:359710048216253,tracker,120101,120002,A,12.3456,N,34.5678,E,0.0,0.0"
        # This parser is illustrative. Real decoders must be adjusted per device protocol.
        imei_match = re.search(r'imei[:=]?(\d{5,20})', text)
        lat_lon = re.search(r'([+-]?\d+\.\d+).*?([NS])[,; ]+([+-]?\d+\.\d+).*?([EW])', text)
        if imei_match and lat_lon:
            imei = imei_match.group(1)
            lat = float(lat_lon.group(1))
            if lat_lon.group(2).upper() == 'S':
                lat = -lat
            lon = float(lat_lon.group(3))
            if lat_lon.group(4).upper() == 'W':
                lon = -lon
            return {"imei": imei, "latitude": lat, "longitude": lon, "raw_text": text}
        # fallback: try to find two floats
        parts = re.findall(r'[-+]?\d+\.\d+', text)
        if len(parts) >= 2 and imei_match:
            return {"imei": imei_match.group(1), "latitude": float(parts[0]), "longitude": float(parts[1]), "raw_text": text}
        return {"raw_text": text}
