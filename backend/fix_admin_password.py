import asyncio
from app.db import AsyncSessionLocal
from app.models import User
from app.utils import hash_password
from sqlalchemy import select

async def fix_admin_password():
    async with AsyncSessionLocal() as db:
        # Get admin user
        result = await db.execute(select(User).filter(User.email == "adriankwaramba@gmail.com"))
        admin = result.scalars().first()
        
        if admin:
            # Hash the password properly
            admin.hashed_password = hash_password("Kingcarter@1")
            admin.is_active = True
            admin.is_admin = True
            
            await db.commit()
            
            print("✅ Admin password updated successfully!")
            print(f"Email: {admin.email}")
            print(f"Status: Active")
            print(f"Role: Administrator")
        else:
            print("❌ Admin user not found!")

if __name__ == "__main__":
    asyncio.run(fix_admin_password())
