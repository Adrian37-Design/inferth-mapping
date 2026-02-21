import asyncio
import os
import sys

# Ensure backend is in path
sys.path.append(os.path.join(os.getcwd(), 'backend'))

from backend.app.db import AsyncSessionLocal
from backend.app.models import Tenant
from sqlalchemy import select

async def repair_branding():
    async with AsyncSessionLocal() as db:
        print("Repairing production branding case-sensitivity...")
        
        # 1. Fix Inferth Mapping (force lowercase)
        result = await db.execute(select(Tenant).where(Tenant.name == "Inferth Mapping"))
        tenant = result.scalars().first()
        
        if tenant:
            print(f"Found tenant: {tenant.name}")
            tenant.logo_url = "/static/inferth_mapping_logo.png"
            # Ensure colors are set too
            tenant.primary_color = "#2D5F6D"
            tenant.secondary_color = "#EF4835"
            await db.commit()
            print("Production branding REPAIRED (forced lowercase).")
        else:
            print("Tenant 'Inferth Mapping' not found.")

if __name__ == "__main__":
    asyncio.run(repair_branding())
