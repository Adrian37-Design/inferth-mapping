import asyncio
import os
from pathlib import Path
from dotenv import load_dotenv

# Load env vars from the same directory as this script
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(env_path)

import logging
logging.basicConfig()
logging.getLogger('sqlalchemy.engine').setLevel(logging.WARNING)

# Override DB host for local execution
if os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["DATABASE_URL"].replace("@db:", "@localhost:")

from sqlalchemy import select
from app.db import AsyncSessionLocal
from app.models import Tenant

async def list_tenants():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Tenant))
        tenants = result.scalars().all()
        print(f"{'ID':<5} {'Name':<30} {'Logo':<30} {'Primary':<10} {'Secondary':<10}")
        print("-" * 90)
        for t in tenants:
            print(f"{t.id:<5} {t.name:<30} {str(t.logo_url):<30} {t.primary_color:<10} {t.secondary_color:<10}")

if __name__ == "__main__":
    asyncio.run(list_tenants())
