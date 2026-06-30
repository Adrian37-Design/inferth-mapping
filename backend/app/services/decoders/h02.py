from app.services.decoders.base import BaseDecoder
from typing import Dict, Any, Optional


class H02Decoder(BaseDecoder):
    """
    Decodes the H02 / "HQ" text protocol used by Sinotrack ST-901A and similar
    devices when uploading over GPRS.

    Example frame:
        *HQ,3009295338,V6,092429,A,1743.8525,S,3057.0645,E,0.00,0,300626,FFFFF9FF,...#

    Field layout (comma separated, after stripping the leading '*' and trailing '#'):
        0: HQ            - protocol marker
        1: 3009295338    - device ID (used as IMEI)
        2: V6            - message/command type
        3: 092429        - UTC time (HHMMSS)
        4: A             - fix validity (A = valid, V = invalid)
        5: 1743.8525     - latitude  (ddmm.mmmm)
        6: S             - N/S hemisphere
        7: 3057.0645     - longitude (dd[d]mm.mmmm, degrees may be unpadded)
        8: E             - E/W hemisphere
        9: 0.00          - speed (knots)
       10: 0             - course/heading (degrees)
       11: 300626        - UTC date (DDMMYY)
       12+               - status bits / cell info / ICCID (ignored)
    """

    @staticmethod
    def _parse_coord(value: str, hemisphere: str) -> Optional[float]:
        """
        Convert an NMEA-style ddmm.mmmm (or dddmm.mmmm) coordinate to decimal
        degrees. The minutes are always the last two integer digits before the
        decimal point, so this works whether or not the degrees are zero-padded.
        """
        try:
            value = value.strip()
            if "." not in value:
                return None
            int_part, frac_part = value.split(".", 1)
            if len(int_part) < 3:
                # Not enough digits for degrees + 2-digit minutes.
                return None
            deg = int(int_part[:-2])
            minutes = float(f"{int_part[-2:]}.{frac_part}")
            decimal = deg + (minutes / 60.0)
            if hemisphere.upper() in ("S", "W"):
                decimal = -decimal
            return decimal
        except (ValueError, IndexError):
            return None

    async def decode(self, raw: bytes) -> Dict[str, Any]:
        text = raw.decode(errors="ignore").strip()

        # Must be an H02/HQ frame.
        if "*HQ" not in text:
            return {"raw_text": text}

        # Trim everything before the marker, then strip framing chars.
        body = text[text.index("*HQ") + 1:]
        body = body.strip().strip("*#")
        parts = body.split(",")

        # Need at least up to longitude hemisphere to be useful.
        if len(parts) < 9 or parts[0].upper() != "HQ":
            return {"raw_text": text}

        imei = parts[1].strip()
        if not imei:
            return {"raw_text": text}

        msg_type = parts[2].strip() if len(parts) > 2 else ""
        validity = parts[4].strip().upper() if len(parts) > 4 else ""

        lat = self._parse_coord(parts[5], parts[6]) if len(parts) > 6 else None
        lon = self._parse_coord(parts[7], parts[8]) if len(parts) > 8 else None

        # Speed: H02 reports knots; convert to km/h for consistency.
        speed_kmh = 0.0
        if len(parts) > 9:
            try:
                speed_kmh = round(float(parts[9]) * 1.852, 2)
            except ValueError:
                speed_kmh = 0.0

        result: Dict[str, Any] = {
            "imei": imei,
            "type": "location",
            "speed": speed_kmh,
            "raw_text": text,
        }

        # Only attach coordinates when the fix is valid and parsed correctly.
        if validity == "A" and lat is not None and lon is not None:
            result["latitude"] = lat
            result["longitude"] = lon
        else:
            # Keep IMEI so the device is still registered/seen, but mark as
            # a heartbeat-style update when there is no valid fix.
            result["type"] = "heartbeat"

        return result
