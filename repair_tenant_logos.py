
import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
from app.config import settings

async def repair_tenants():
    print(f"Connecting to {settings.DATABASE_URL}...")
    engine = create_async_engine(settings.DATABASE_URL)
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
    import sys
    import os
    # Add backend to path so we can import app.config
    sys.path.append(os.path.join(os.getcwd(), 'backend'))
    asyncio.run(repair_tenants())
