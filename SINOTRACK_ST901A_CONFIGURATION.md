# Sinotrack ST 901A Configuration Guide for Inferth Mapping

## Overview
This guide will help you configure your Sinotrack ST 901A GPS tracker to send location data to your Inferth Mapping system.

---

## Current System Configuration

Your Inferth Mapping system is configured to:
- **TCP Server Address**: `0.0.0.0` (listening on all network interfaces)
- **TCP Server Port**: `9000`
- **Protocol Decoder**: GPS103 (currently configured)

---

## Configuration Steps

### 1. Prerequisites

Before configuring your tracker, ensure:
- [ ] Your Inferth Mapping backend server is running and accessible
- [ ] You know your server's public IP address or domain name
- [ ] Port `9000` is open in your firewall (incoming TCP connections)
- [ ] You have the tracker's phone number (SIM card installed)
- [ ] The tracker is powered on and has GSM signal

### 2. Important Sinotrack ST 901A Information

**Default Settings:**
- Admin password: `123456` (change this for security)
- Default APN: varies by carrier
- Communication: TCP or UDP
- GPS update intervals: configurable

**SMS Command Format:**
All commands are sent via SMS to the tracker's SIM card number.

---

## SMS Configuration Commands

### Step 1: Set Admin Password (Recommended)
```
password123456 new_password
```
Replace `new_password` with your desired password. Default is `123456`.

### Step 2: Set APN for Your Mobile Carrier
```
apn123456 your_apn_name
```

**Common APNs by Carrier:**
- **Econet (Zimbabwe)**: `internet`
- **NetOne (Zimbabwe)**: `internet`
- **Telecel (Zimbabwe)**: `internet`
- **MTN**: `internet` or `mtn`
- **Vodacom**: `internet`
- **T-Mobile**: `epc.tmobile.com`
- **AT&T**: `phone`
- **Verizon**: `vzwinternet`

Example:
```
apn123456 internet
```

### Step 3: Configure Server IP and Port
```
adminip123456 YOUR_SERVER_IP 9000
```

Replace `YOUR_SERVER_IP` with your server's public IP address or domain name.

**Examples:**
```
adminip123456 203.0.113.45 9000
```
Or if using a domain:
```
adminip123456 tracking.yourdomain.com 9000
```

### Step 4: Set GPS Update Interval
```
fix030s***n123456
```
This sets the tracker to send GPS data every 30 seconds.

**Available intervals:**
- `fix010s***n123456` - Every 10 seconds
- `fix030s***n123456` - Every 30 seconds
- `fix060s***n123456` - Every 60 seconds (1 minute)
- `fix300s***n123456` - Every 5 minutes

### Step 5: Enable GPRS/GPS Mode
```
GPRS123456
```

### Step 6: Check Device Status
```
STATUS123456
```
This will return the current configuration via SMS.

---

## Protocol Implementation

### Understanding the Sinotrack ST 901A Protocol

The Sinotrack ST 901A typically sends data in one of these formats:

**Format 1 (Common):**
```
$$<length>|<imei>|<command>|<data>|<checksum>
```

**Format 2 (Alternative):**
```
imei:<imei_number>,tracker,<datetime>,<gps_data>
```

**Example Data Packet:**
```
$$0098|353588888888888|AAA|01|18.123456|N|72.987654|E|21.05.2023|14:30:45|A|0.00|0|0|0|100|
```

### Current Decoder Limitation

> [!WARNING]
> Your system currently uses the **GPS103 decoder** which may not be fully compatible with the Sinotrack ST 901A protocol. You need to create a dedicated Sinotrack decoder.

---

## Creating a Sinotrack Decoder

Create a new decoder file for the ST 901A:

**File:** `backend/app/services/decoders/sinotrack.py`

```python
from app.services.decoders.base import BaseDecoder
from typing import Dict, Any
import re

class SinotrackDecoder(BaseDecoder):
    async def decode(self, raw: bytes) -> Dict[str, Any]:
        with open("/app/debug.log", "a") as f:
            f.write(f"DEBUG: SinotrackDecoder decoding: {raw}\n")
        
        try:
            text = raw.decode(errors="ignore").strip()
            
            # Format 1: $$<length>|<imei>|<command>|...
            if text.startswith("$$"):
                parts = text.split("|")
                if len(parts) >= 8:
                    imei = parts[1]
                    lat_str = parts[4]
                    lat_dir = parts[5]  # N or S
                    lon_str = parts[6]
                    lon_dir = parts[7]  # E or W
                    
                    lat = float(lat_str)
                    if lat_dir == 'S':
                        lat = -lat
                    
                    lon = float(lon_str)
                    if lon_dir == 'W':
                        lon = -lon
                    
                    return {
                        "imei": imei,
                        "latitude": lat,
                        "longitude": lon,
                        "raw_text": text
                    }
            
            # Format 2: imei:XXXXXXX,tracker,...
            imei_match = re.search(r'imei[:=]?(\d{15})', text)
            if imei_match:
                imei = imei_match.group(1)
                
                # Try to extract coordinates
                # Pattern: latitude,N/S,longitude,E/W
                coords = re.search(r'(\d+\.\d+),([NS]),(\d+\.\d+),([EW])', text)
                if coords:
                    lat = float(coords.group(1))
                    if coords.group(2) == 'S':
                        lat = -lat
                    
                    lon = float(coords.group(3))
                    if coords.group(4) == 'W':
                        lon = -lon
                    
                    return {
                        "imei": imei,
                        "latitude": lat,
                        "longitude": lon,
                        "raw_text": text
                    }
            
            # Fallback
            return {"raw_text": text}
            
        except Exception as e:
            with open("/app/debug.log", "a") as f:
                f.write(f"ERROR in SinotrackDecoder: {e}\n")
            return {"raw_text": str(raw)}
```

### Update TCP Server to Use Sinotrack Decoder

**File:** `backend/app/services/tcp_server.py`

Change line 3 from:
```python
from app.services.decoders.gps103 import GPS103Decoder
```

To:
```python
from app.services.decoders.sinotrack import SinotrackDecoder
```

And change line 12 from:
```python
decoder = GPS103Decoder()
```

To:
```python
decoder = SinotrackDecoder()
```

---

## Testing the Configuration

### 1. Check Server Logs

Monitor the debug log to see incoming data:
```bash
tail -f backend/debug.log
```

Or if using Docker:
```bash
docker logs -f inferth-backend
```

### 2. Verify TCP Connection

Check if the tracker can connect to your server:
```bash
netstat -an | grep 9000
```

Or using Docker:
```bash
docker exec -it inferth-backend netstat -an | grep 9000
```

### 3. Test with Telnet (Optional)

You can simulate a tracker connection:
```bash
telnet YOUR_SERVER_IP 9000
```

Then send a test packet (adjust the IMEI and coordinates):
```
$$0098|353588888888888|AAA|01|18.123456|N|72.987654|E|21.05.2023|14:30:45|A|0.00|0|0|0|100|
```

### 4. Check Database

Verify that positions are being saved:
```sql
SELECT * FROM devices ORDER BY created_at DESC LIMIT 5;
SELECT * FROM positions ORDER BY timestamp DESC LIMIT 10;
```

---

## Troubleshooting

### Issue: Tracker not connecting

**Possible causes:**
1. Incorrect server IP or port
2. Firewall blocking port 9000
3. No internet connection on tracker (check APN)
4. SIM card has no data plan

**Solutions:**
- Send `STATUS123456` SMS to check configuration
- Verify public IP: `curl ifconfig.me`
- Check firewall: `sudo ufw status` or Windows Firewall
- Ensure port forwarding is configured on your router

### Issue: Data received but not parsed

**Symptoms:** You see data in logs but no positions in database

**Solutions:**
1. Check the raw data format in `debug.log`
2. Adjust the decoder regex patterns to match your tracker's format
3. Add more detailed logging to see where parsing fails

### Issue: Wrong coordinates

**Possible causes:**
- Incorrect coordinate format parsing
- GPS not locked (tracker indoors or poor signal)

**Solutions:**
- Verify GPS signal (move tracker outdoors)
- Check the coordinate direction (N/S, E/W)
- Compare raw data with expected format

### Issue: Connection drops frequently

**Solutions:**
- Increase heartbeat interval
- Check mobile data stability
- Send: `fix060s***n123456` for less frequent updates

---

## Advanced Configuration

### Set Timezone
```
timezone123456 +2
```
(For Zimbabwe, use +2)

### Enable Sleep Mode (Power Saving)
```
sleep123456 on
```

### Set Speed Alarm
```
speed123456 100
```
(Alerts when speed exceeds 100 km/h)

### Set Geo-fence (Circular)
```
stockade123456 lat,lon,radius
```
Example:
```
stockade123456 -17.8252,31.0335,500
```
(500 meters radius around Harare coordinates)

### Get Current Location
```
G123456#
```

### Reset to Factory Settings
```
RRRRRR
```

---

## Security Best Practices

1. **Change default password immediately**
   ```
   password123456 your_strong_password
   ```

2. **Use HTTPS/TLS** if your system supports it (consider upgrading)

3. **Restrict firewall access** to only known IP ranges if possible

4. **Regularly update** device firmware

5. **Monitor logs** for suspicious activity

---

## Network Requirements

### Firewall Configuration

**Linux (UFW):**
```bash
sudo ufw allow 9000/tcp
```

**Linux (iptables):**
```bash
sudo iptables -A INPUT -p tcp --dport 9000 -j ACCEPT
```

**Windows Firewall:**
1. Open Windows Defender Firewall
2. Click "Advanced settings"
3. Click "Inbound Rules" → "New Rule"
4. Select "Port" → Next
5. Select "TCP" and enter "9000" → Next
6. Allow the connection → Finish

### Router Port Forwarding

If your server is behind a router:
1. Log into your router admin panel
2. Find "Port Forwarding" or "Virtual Server"
3. Add rule:
   - External Port: 9000
   - Internal Port: 9000
   - Internal IP: Your server's local IP
   - Protocol: TCP

---

## Quick Reference SMS Commands

| Command | Description | Example |
|---------|-------------|---------|
| `password123456 newpass` | Change password | `password123456 mypass` |
| `apn123456 apn_name` | Set APN | `apn123456 internet` |
| `adminip123456 ip port` | Set server | `adminip123456 1.2.3.4 9000` |
| `fix030s***n123456` | Update interval | `fix030s***n123456` |
| `STATUS123456` | Check status | `STATUS123456` |
| `GPRS123456` | Enable GPRS | `GPRS123456` |
| `G123456#` | Get location now | `G123456#` |
| `RRRRRR` | Factory reset | `RRRRRR` |

---

## Support

If you encounter issues:
1. Check `debug.log` for raw data
2. Verify network connectivity
3. Test with different update intervals
4. Ensure proper decoder implementation

**Note:** Replace `123456` with your actual password in all commands.
