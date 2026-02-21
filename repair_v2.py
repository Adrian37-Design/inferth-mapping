
import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text

DATABASE_URL = "postgresql+asyncpg://postgres:kwaramba1@localhost:5432/inferth"
ENV_URL = os.environ.get("DATABASE_URL")
if ENV_URL:
    DATABASE_URL = ENV_URL.replace("postgres://", "postgresql+asyncpg://")

async def deep_repair():
    print(f"Connecting to DB...")
    engine = create_async_engine(DATABASE_URL)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    async with async_session() as session:
        # 1. Fetch all tenants
        result = await session.execute(text("SELECT id, name, logo_url FROM tenants ORDER BY id ASC"))
        tenants = result.mappings().all()
        
        print("\n--- TENANT AUDIT ---")
        for t in tenants:
            tid = t['id']
            name = t['name']
            old_url = t['logo_url'] or ""
            
            # STANDARD FOR FILENAME: lowercase_name_logo.png
            standard_filename = f"{name.lower().replace(' ', '_')}_logo.png"
            standard_url = f"/static/{standard_filename}"
            
            # If the user literally uploaded "logo.png" and it's there, we might want to keep it
            # But the system expectation is the standardized name.
            
            # FIX: If it has spaces, fix it.
            if " " in old_url or old_url.lower() != old_url:
                new_url = old_url.lower().replace(" ", "_")
                if not new_url.startswith("/static/"):
                    new_url = f"/static/{new_url.lstrip('/')}"
                
                print(f"Repairing ID {tid} ('{name}'): '{old_url}' -> '{new_url}'")
                await session.execute(
                    text("UPDATE tenants SET logo_url = :url WHERE id = :id"),
                    {"url": new_url, "id": tid}
                )
            elif not old_url.startswith("/static/"):
                new_url = f"/static/{old_url.lstrip('/')}"
                print(f"Adding prefix to ID {tid}: '{old_url}' -> '{new_url}'")
                await session.execute(
                    text("UPDATE tenants SET logo_url = :url WHERE id = :id"),
                    {"url": new_url, "id": tid}
                )

        await session.commit()
        print("\n--- FINAL STATE ---")
        result = await session.execute(text("SELECT id, name, logo_url FROM tenants ORDER BY id ASC"))
        for t in result.mappings().all():
            print(f"ID: {t['id']}, Name: {t['name']}, Logo: {t['logo_url']}")

if __name__ == "__main__":
    asyncio.run(deep_repair())
