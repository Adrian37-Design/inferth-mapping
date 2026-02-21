import asyncio
from sqlalchemy import text
from app.db import AsyncSessionLocal

async def migrate_tenants():
    print("🚀 Starting Tenant Branding Migration...")
    async with AsyncSessionLocal() as db:
        try:
            # Add navbar_bg column
            await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS navbar_bg VARCHAR"))
            # Add navbar_text_color column
            await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS navbar_text_color VARCHAR"))
            
            await db.commit()
            print("✅ Migration successful: Added navbar_bg and navbar_text_color pillars.")
        except Exception as e:
            print(f"❌ Migration failed: {str(e)}")
            await db.rollback()

if __name__ == "__main__":
    asyncio.run(migrate_tenants())
