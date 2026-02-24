import asyncio
import os
import sys

# Add the backend directory to sys.path
sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))

from sqlalchemy.future import select
from app.db import AsyncSessionLocal
from app.models import Device, Tenant

async def check_devices():
    async with AsyncSessionLocal() as db:
        try:
            # Check tenants
            result = await db.execute(select(Tenant))
            tenants = result.scalars().all()
            print(f"Tenants: {[t.name for t in tenants]}")
            
            # Check devices
            result = await db.execute(select(Device))
            devices = result.scalars().all()
            print(f"Devices found: {len(devices)}")
            for d in devices:
                print(f"Device: ID={d.id}, IMEI={d.imei}, TenantID={d.tenant_id}")
        except Exception as e:
            print(f"Error checking devices: {e}")

if __name__ == "__main__":
    asyncio.run(check_devices())
