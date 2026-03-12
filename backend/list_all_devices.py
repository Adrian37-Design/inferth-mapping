import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from dotenv import load_dotenv

load_dotenv()

async def list_devices():
    db_url = os.getenv('DATABASE_URL')
    if not db_url: return
    if "db:5432" in db_url: db_url = db_url.replace("db:5432", "localhost:5432")
    if db_url.startswith("postgres://"): db_url = db_url.replace("postgres://", "postgresql+asyncpg://")
    elif db_url.startswith("postgresql://"): db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")

    try:
        engine = create_async_engine(db_url)
        async with engine.connect() as conn:
            res = await conn.execute(text("SELECT id, imei, name, created_at FROM devices ORDER BY id DESC LIMIT 20"))
            print(f"--- DEVICES LIST ---")
            for row in res.fetchall():
                print(row)
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(list_devices())
