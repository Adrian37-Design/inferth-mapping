import sys
import os
import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select

# Add backend directory to path so we can import app
sys.path.append(os.path.join(os.getcwd(), 'backend'))

# Import model after path setup
# We need to bypass app.db get_db dependency if it relies on env vars being loaded differently
# So we'll create a direct engine here

from app.models import Tenant

# DB URL from .env but replacing 'db' with 'localhost' assuming port 5432 is exposed
DB_URL = "postgresql+asyncpg://postgres:kwaramba1@localhost:5432/inferth"

engine = create_async_engine(DB_URL)
async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def check_tenants():
    try:
        async with async_session() as session:
            result = await session.execute(select(Tenant))
            tenants = result.scalars().all()
            for t in tenants:
                print(f"ID: {t.id}, Name: {t.name}, Logo URL: {t.logo_url}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(check_tenants())
