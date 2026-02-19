from sqlalchemy import select
from .db import AsyncSessionLocal
from .models import Tenant

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
        inferth.logo_url = "/static/inferth_mapping_logo.png"
        
        # 2. Console Telematics
        result = await db.execute(select(Tenant).where(Tenant.name == "Console Telematics"))
        console = result.scalars().first()
        
        if not console:
            print("Creating Console Telematics tenant...")
            console = Tenant(name="Console Telematics")
            db.add(console)
            
        console.primary_color = "#10b981" # Green
        console.secondary_color = "#94a3b8" # Silver
        console.logo_url = "/static/console_telematics_logo.png"
        
        await db.commit()
        print("Branding initialization complete!")
        if inferth: print(f"Inferth Mapping: ID={inferth.id}")
        if console: print(f"Console Telematics: ID={console.id}")
