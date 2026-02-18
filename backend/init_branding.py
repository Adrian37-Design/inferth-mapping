import asyncio
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy import select

# Load env vars
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(env_path)

# Override DB host for local execution
if os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["DATABASE_URL"].replace("@db:", "@localhost:")

from app.db import AsyncSessionLocal
from app.models import Tenant

async def init_branding():
    async with AsyncSessionLocal() as db:
        print("Initializing Branding...")
        
        # 1. Inferth Mapping (Default)
        result = await db.execute(select(Tenant).where(Tenant.name == "Inferth Mapping"))
        inferth = result.scalars().first()
        
        if not inferth:
            print("Creating Inferth Mapping tenant...")
            inferth = Tenant(name="Inferth Mapping")
            db.add(inferth)
        
        inferth.primary_color = "#2D5F6D"
        inferth.secondary_color = "#EF4835"
        inferth.logo_url = "/static/logo.png"
        
        # 2. Console Telematics
        result = await db.execute(select(Tenant).where(Tenant.name == "Console Telematics"))
        console = result.scalars().first()
        
        if not console:
            print("Creating Console Telematics tenant...")
            console = Tenant(name="Console Telematics")
            db.add(console)
            
        console.primary_color = "#10b981" # Green
        console.secondary_color = "#94a3b8" # Silver
        console.logo_url = "/static/logo.png" # Using same logo for now as requested, or placeholder
        
        await db.commit()
        print("Branding initialization complete!")
        print(f"Inferth Mapping: ID={inferth.id}")
        print(f"Console Telematics: ID={console.id}")

if __name__ == "__main__":
    asyncio.run(init_branding())
