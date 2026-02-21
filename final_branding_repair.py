
import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text

DATABASE_URL = "postgresql+asyncpg://postgres:kwaramba1@localhost:5432/inferth"
ENV_URL = os.environ.get("DATABASE_URL")
if ENV_URL:
    DATABASE_URL = ENV_URL.replace("postgres://", "postgresql+asyncpg://")

async def final_repair():
    print(f"Connecting to DB...")
    engine = create_async_engine(DATABASE_URL)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    async with async_session() as session:
        # 1. Update BOTH Console Telematics to use the correct logo.png
        # The user confirmed they uploaded it and I see it in frontend/logo.png
        print("Standardizing Console Telematics logo to /static/logo.png...")
        await session.execute(
            text("UPDATE tenants SET logo_url = :url WHERE name = :name"),
            {"url": "/static/logo.png", "name": "Console Telematics"}
        )
        
        # 2. Fix Inferth Mapping logo path
        await session.execute(
            text("UPDATE tenants SET logo_url = :url WHERE name = :name"),
            {"url": "/static/inferth_mapping_logo.png", "name": "Inferth Mapping"}
        )
        
        # 3. Final Audit
        await session.commit()
        print("\n--- FINAL STATE ---")
        result = await session.execute(text("SELECT id, name, logo_url FROM tenants ORDER BY id ASC"))
        for t in result.mappings().all():
            print(f"ID: {t['id']}, Name: {t['name']}, Logo: {t['logo_url']}")

if __name__ == "__main__":
    asyncio.run(final_repair())
