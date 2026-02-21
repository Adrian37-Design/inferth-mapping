
import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
from app.config import settings

async def check_state():
    engine = create_async_engine(settings.DATABASE_URL)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    async with async_session() as session:
        # Check tenants
        result = await session.execute(text("SELECT id, name, logo_url FROM tenants"))
        tenants = result.mappings().all()
        print("\n--- TENANTS IN DB ---")
        for t in tenants:
            print(f"ID: {t['id']}, Name: {t['name']}, Logo: {t['logo_url']}")
            
    # Check static files
    print("\n--- STATIC FILES ON DISK ---")
    static_paths = ["static", "/app/static", "/app/frontend/static", "../../static"]
    found = False
    for p in static_paths:
        if os.path.exists(p):
            print(f"Found static dir: {p}")
            files = os.listdir(p)
            for f in files:
                if "logo" in f.lower():
                    print(f"  - {f}")
            found = True
    if not found:
        print("Static directory not found in common locations.")

if __name__ == "__main__":
    asyncio.run(check_state())
