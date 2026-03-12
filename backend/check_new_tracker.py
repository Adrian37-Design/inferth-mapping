import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from dotenv import load_dotenv

load_dotenv()

async def check():
    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("DATABASE_URL not found in .env")
        return
    
    # Ensure async driver is used
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql+asyncpg://")
    elif db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")

    engine = create_async_engine(db_url)
    
    async with engine.connect() as conn:
        print("--- RECENT POSITIONS ---")
        try:
            res = await conn.execute(text("SELECT id, imei, timestamp, raw_text FROM positions ORDER BY id DESC LIMIT 10"))
            rows = res.fetchall()
            for row in rows:
                print(row)
        except Exception as e:
            print(f"Error fetching positions: {e}")

        print("\n--- RECENT DEVICES ---")
        try:
            res = await conn.execute(text("SELECT id, imei, name, tenant_id FROM devices ORDER BY id DESC LIMIT 10"))
            rows = res.fetchall()
            for row in rows:
                print(row)
        except Exception as e:
            print(f"Error fetching devices: {e}")

if __name__ == "__main__":
    asyncio.run(check())
