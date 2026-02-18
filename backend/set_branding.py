import asyncio
import sys
import os
from pathlib import Path
from dotenv import load_dotenv

# Load env vars
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(env_path)

# Override DB host for local execution
if os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["DATABASE_URL"].replace("@db:", "@localhost:")

from sqlalchemy import select, update
from app.db import AsyncSessionLocal
from app.models import Tenant

async def set_branding(tenant_id, primary, secondary, logo=None):
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
        tenant = result.scalars().first()
        
        if not tenant:
            print(f"Error: Tenant ID {tenant_id} not found.")
            return

        print(f"Updating Tenant: {tenant.name}")
        print(f"  Old: Primary={tenant.primary_color}, Secondary={tenant.secondary_color}, Logo={tenant.logo_url}")
        
        tenant.primary_color = primary
        tenant.secondary_color = secondary
        if logo:
            tenant.logo_url = logo
            
        await db.commit()
        print(f"  New: Primary={tenant.primary_color}, Secondary={tenant.secondary_color}, Logo={tenant.logo_url}")
        print("Branding updated successfully!")

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python set_branding.py <tenant_id> <primary_hex> <secondary_hex> [logo_url]")
        print("Example: python set_branding.py 1 #2D5F6D #EF4835")
        sys.exit(1)
        
    t_id = int(sys.argv[1])
    p_color = sys.argv[2]
    s_color = sys.argv[3]
    l_url = sys.argv[4] if len(sys.argv) > 4 else None
    
    asyncio.run(set_branding(t_id, p_color, s_color, l_url))
