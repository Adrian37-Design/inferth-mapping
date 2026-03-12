import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from dotenv import load_dotenv

load_dotenv()

async def check_imei(imei):
    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("DATABASE_URL not found")
        return
    
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql+asyncpg://")
    elif db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")

    try:
        engine = create_async_engine(db_url)
        async with engine.connect() as conn:
            print(f"--- SEARCHING FOR IMEI: {imei} ---")
            
            # Check Devices
            res = await conn.execute(text("SELECT * FROM devices WHERE imei = :imei"), {"imei": imei})
            device = res.fetchone()
            if device:
                print(f"FOUND DEVICE: {device}")
            else:
                print("DEVICE NOT FOUND IN 'devices' TABLE")

            # Check Recent Positions (Raw text search if needed)
            print("\n--- CHECKING RECENT POSITIONS (IMEI OR RAW SEARCH) ---")
            res = await conn.execute(text("SELECT id, device_id, timestamp, raw FROM positions ORDER BY id DESC LIMIT 20"))
            rows = res.fetchall()
            found_in_pos = False
            for row in rows:
                if str(imei) in str(row):
                    print(f"MATCH IN POSITIONS: {row}")
                    found_in_pos = True
            
            if not found_in_pos:
                print("IMEI NOT FOUND IN RECENT POSITIONS")

    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == "__main__":
    imei = "352672107830465"
    asyncio.run(check_imei(imei))
