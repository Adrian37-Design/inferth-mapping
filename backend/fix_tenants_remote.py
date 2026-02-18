import asyncio
import sys
import os

# Ensure app module is found
sys.path.append(os.getcwd())

from app.db import AsyncSessionLocal
from app.models import Tenant, User
from sqlalchemy import select, update, delete

async def fix_tenants():
    async with AsyncSessionLocal() as db:
        print("Fixing Tenants...")
        
        # 1. Find "Default Organization"
        res = await db.execute(select(Tenant).where(Tenant.name == "Default Organization"))
        default_org = res.scalars().first()
        
        # 2. Find "Inferth Mapping"
        res = await db.execute(select(Tenant).where(Tenant.name == "Inferth Mapping"))
        inferth = res.scalars().first()
        
        if default_org and inferth:
            print(f"Found both Default (ID {default_org.id}) and Inferth (ID {inferth.id}). Merging...")
            
            # Move users from Default to Inferth
            await db.execute(
                update(User)
                .where(User.tenant_id == default_org.id)
                .values(tenant_id=inferth.id)
            )
            
            # Delete Default Organization
            await db.delete(default_org)
            await db.commit()
            print("Merged Default users to Inferth and deleted Default Organization.")
            
        elif default_org and not inferth:
            print(f"Renaming Default Organization (ID {default_org.id}) to Inferth Mapping...")
            default_org.name = "Inferth Mapping"
            default_org.primary_color = "#2D5F6D"
            default_org.secondary_color = "#EF4835"
            default_org.logo_url = "/static/logo.png"
            await db.commit()
            print("Renamed and branded successfully.")
            
        else:
            print("No duplicate 'Default Organization' found. Inferth Mapping exists correctly.")

if __name__ == "__main__":
    asyncio.run(fix_tenants())
