
import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text, select
from app.models import Device, Tenant, User # Import actual models
from app.db import Base

# Production DB URL
DATABASE_URL = "postgresql+asyncpg://postgres:XooBUVGWZimrgPLZwmsMUScEPSDcdUiw@switchback.proxy.rlwy.net:30894/railway"

async def debug_orm():
    engine = create_async_engine(DATABASE_URL, echo=True)
    AsyncSessionLocal = sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    
    async with AsyncSessionLocal() as db:
        print("--- Testing ORM Query (simulating API) ---")
        try:
            # Replicate list_devices logic
            result = await db.execute(select(Device))
            devices = result.scalars().all()
            print(f"Successfully fetched {len(devices)} devices via ORM.")
            for d in devices:
                print(f" - ID: {d.id}, IMEI: {d.imei}, Driver: {d.driver_name}")
                
        except Exception as e:
            print(f"ORM Query FAILED: {e}")
            import traceback
            traceback.print_exc()
        finally:
            await engine.dispose()

if __name__ == "__main__":
    asyncio.run(debug_orm())
