"""
Quick diagnostic: Show the last 20 position records with their raw OBD data.
Run with: python check_recent_data.py
"""
import psycopg2
import json
import os
from datetime import datetime

DATABASE_URL = os.getenv("DATABASE_URL", "")

if not DATABASE_URL:
    print("ERROR: Set DATABASE_URL env variable first.")
    print("   e.g.  $env:DATABASE_URL='postgresql://...'  (PowerShell)")
    exit(1)

conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

print("=" * 70)
print("LAST 20 POSITION RECORDS (newest first)")
print("=" * 70)

cur.execute("""
    SELECT p.id, p.timestamp, p.latitude, p.longitude, p.speed, p.raw,
           d.imei, d.name
    FROM positions p
    JOIN devices d ON p.device_id = d.id
    ORDER BY p.timestamp DESC
    LIMIT 100
""")

rows = cur.fetchall()

for row in rows:
    pid, ts, lat, lon, speed, raw, imei, name = row
    raw_dict = raw or {}
    obd_keys = [k for k in raw_dict.keys() if k not in ('raw_text', 'type', 'error')]
    
    print(f"\n[{ts}]  Device: {name or imei}  Speed: {speed} km/h  Lat: {lat}  Lon: {lon}")
    print(f"  Packet type : {raw_dict.get('type', 'unknown')}")
    
    if obd_keys:
        print(f"  OBD Keys    : {', '.join(obd_keys)}")
        for key in obd_keys:
            print(f"    |- {key}: {raw_dict[key]}")
    else:
        print(f"  No OBD data in this record.")

cur.close()
conn.close()
print("\n" + "=" * 70)
