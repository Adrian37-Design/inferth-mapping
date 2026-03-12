import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from dotenv import load_dotenv
from datetime import datetime, timedelta

load_dotenv()

async def verify_connection():
    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("DATABASE_URL not found")
        return
    
    # Adapt for local check (if running locally against redirected DB)
    if "db:5432" in db_url:
        # Assuming the user might have port forwarding or I need to handle the alias
        db_url = db_url.replace("db:5432", "localhost:5432")

    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql+asyncpg://")
    elif db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")

    try:
        engine = create_async_engine(db_url)
        async with engine.connect() as conn:
            imei = "352672107830465"
            print(f"[{datetime.now()}] --- VERIFYING LIVE CONNECTION FOR: {imei} ---")
            
            # 1. Check for Device
            res = await conn.execute(text("SELECT id, imei, name, tenant_id FROM devices WHERE imei = :imei"), {"imei": imei})
            device = res.fetchone()
            if device:
                print(f"✅ DEVICE FOUND: ID={device.id}, Name='{device.name}', TenantID={device.tenant_id}")
                
                # 2. Check for Positions in the last 10 minutes
                res = await conn.execute(text("""
                    SELECT id, timestamp, latitude, longitude 
                    FROM positions 
                    WHERE device_id = :device_id 
                    ORDER BY timestamp DESC LIMIT 5
                """), {"device_id": device.id})
                positions = res.fetchall()
                if positions:
                    print(f"✅ POSITIONS RECEIVED: {len(positions)} recent points found.")
                    for p in positions:
                        print(f"   - {p.timestamp}: {p.latitude}, {p.longitude}")
                else:
                    print("⚠️ DEVICE EXISTS BUT NO POSITIONS FOUND YET.")
            else:
                print("❌ DEVICE NOT FOUND. Still waiting for the first Login packet.")

            # 3. Check for ANY unknown trackers created recently
            print("\n--- NEWEST DEVICES (Last 5 mins) ---")
            res = await conn.execute(text("SELECT id, imei, name, created_at FROM devices ORDER BY created_at DESC LIMIT 5"))
            for d in res.fetchall():
                print(f" - {d.created_at}: IMEI={d.imei}, Name={d.name}")

    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == "__main__":
    asyncio.run(verify_connection())
