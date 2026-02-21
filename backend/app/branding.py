from sqlalchemy import select
from .db import AsyncSessionLocal
from .models import Tenant

async def init_branding():
    async with AsyncSessionLocal() as db:
        print("Initializing Branding...")
        
        # 1. Inferth Mapping (Default) — only create if missing
        result = await db.execute(select(Tenant).where(Tenant.name == "Inferth Mapping"))
        inferth = result.scalars().first()
        
        if not inferth:
            print("Creating Inferth Mapping tenant...")
            inferth = Tenant(name="Inferth Mapping")
            db.add(inferth)
        
        # Only set defaults if not already set — never overwrite user-uploaded values
        if not inferth.primary_color:
            inferth.primary_color = "#2D5F6D"
        if not inferth.secondary_color:
            inferth.secondary_color = "#EF4835"
        if not inferth.logo_url:
            inferth.logo_url = "/static/inferth_mapping_logo.png"
        
        # 2. For ALL other tenants: only fill in missing color defaults
        #    NEVER touch logo_url — it was set when the company was created via the UI
        result = await db.execute(select(Tenant).where(Tenant.name != "Inferth Mapping"))
        other_tenants = result.scalars().all()
        for tenant in other_tenants:
            if not tenant.primary_color:
                tenant.primary_color = "#2D5F6D"
            if not tenant.secondary_color:
                tenant.secondary_color = "#EF4835"
            # logo_url is intentionally never touched here
        
        await db.commit()
        print("Branding initialization complete!")
        if inferth:
            print(f"Inferth Mapping: ID={inferth.id}")
