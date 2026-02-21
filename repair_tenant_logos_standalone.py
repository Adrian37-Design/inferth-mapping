
import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text

# Standalone repair script - no dependency on app package
DATABASE_URL = "postgresql+asyncpg://postgres:takudzwa99@localhost:5432/inferth_mapping"

# Try to get from env if available
if os.environ.get("DATABASE_URL"):
    DATABASE_URL = os.environ.get("DATABASE_URL").replace("postgres://", "postgresql+asyncpg://")

async def repair_tenants():
    print(f"Connecting to database...")
    engine = create_async_engine(DATABASE_URL)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    async with async_session() as session:
        # 1. Fetch all tenants
        result = await session.execute(text("SELECT id, name, logo_url FROM tenants"))
        tenants = result.mappings().all()
        
        for t in tenants:
            old_url = t['logo_url']
            if not old_url:
                continue
                
            # Sanitize: lowercase and underscores
            new_url = old_url.lower().replace(' ', '_')
            
            if new_url != old_url:
                print(f"Updating Tenant {t['id']} ('{t['name']}'):")
                print(f"  Old: {old_url}")
                print(f"  New: {new_url}")
                await session.execute(
                    text("UPDATE tenants SET logo_url = :url WHERE id = :id"),
                    {"url": new_url, "id": t['id']}
                )
        
        await session.commit()
        print("REPAIR COMPLETE.")

if __name__ == "__main__":
    asyncio.run(repair_tenants())
