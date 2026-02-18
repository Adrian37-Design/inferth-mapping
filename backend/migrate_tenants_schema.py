import asyncio
import os
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy import text

# Load env vars
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(env_path)

# Override DB host for local execution
if os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["DATABASE_URL"].replace("@db:", "@localhost:")

from app.db import AsyncSessionLocal

async def migrate():
    async with AsyncSessionLocal() as db:
        print("Starting manual migration for Tenant branding...")
        try:
            await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url VARCHAR DEFAULT NULL"))
            await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS primary_color VARCHAR DEFAULT '#2D5F6D'"))
            await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS secondary_color VARCHAR DEFAULT '#EF4835'"))
            await db.commit()
            print("Migration successful: Added branding columns to tenants table.")
        except Exception as e:
            print(f"Migration failed: {e}")
            await db.rollback()

if __name__ == "__main__":
    asyncio.run(migrate())
