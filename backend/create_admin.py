import asyncio
import sys
sys.path.insert(0, '/app')

from app.db import AsyncSessionLocal
from app.models import User, Tenant
from app.security import hash_password
from sqlalchemy import select

async def create_admin():
    async with AsyncSessionLocal() as db:
        # Get or create tenant
        result = await db.execute(select(Tenant).filter(Tenant.name == "Inferth Mapping"))
        tenant = result.scalars().first()
        
        if not tenant:
            tenant = Tenant(name="Inferth Mapping")
            db.add(tenant)
            await db.commit()
            await db.refresh(tenant)
        
        print(f"Tenant ID: {tenant.id}")
        
        import os
        admin_password = os.getenv("ADMIN_PASSWORD", "changeme")
        
        # Create admin user
        admin = User(
            email="adriankwaramba@gmail.com",
            hashed_password=hash_password(admin_password),
            is_admin=True,
            is_active=True,
            tenant_id=tenant.id
        )
        
        db.add(admin)
        await db.commit()
        
        print("✅ Admin user created successfully!")
        print(f"Email: {admin.email}")
        print(f"Active: {admin.is_active}")
        print(f"Admin: {admin.is_admin}")

if __name__ == "__main__":
    asyncio.run(create_admin())
