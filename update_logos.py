import sys
import os
import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select, update

# Add backend directory to path so we can import app
sys.path.append(os.path.join(os.getcwd(), 'backend'))

from app.models import Tenant

# DB URL from .env but replacing 'db' with 'localhost' assuming port 5432 is exposed
DB_URL = "postgresql+asyncpg://postgres:kwaramba1@localhost:5432/inferth"

engine = create_async_engine(DB_URL)
async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def update_logos():
    try:
        async with async_session() as session:
            # Update Inferth Mapping (ID 1)
            stmt1 = update(Tenant).where(Tenant.id == 1).values(logo_url='/static/Inferth_Mapping_Logo.png')
            await session.execute(stmt1)
            print("Updated Inferth Mapping logo.")

            # Update Console Telematics (ID 2)
            stmt2 = update(Tenant).where(Tenant.id == 2).values(logo_url='/static/console_telematics_logo.png')
            await session.execute(stmt2)
            print("Updated Console Telematics logo.")
            
            await session.commit()
            print("Changes committed.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(update_logos())
