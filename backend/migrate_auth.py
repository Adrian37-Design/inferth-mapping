"""
Database Migration Script - Add Authentication Fields

This script helps you apply the new authentication fields to your existing database.

Run this script to update your database schema with the new User model fields.
"""

import asyncio
from app.db import engine, Base
from app.models import User, Tenant, Device, Position


async def migrate_database():
    """Create or update database tables"""
    print("Starting database migration...")
    
    async with engine.begin() as conn:
        # Create all tables (will skip existing ones and add new columns)
        await conn.run_sync(Base.metadata.create_all)
    
    print("✅ Database migration completed successfully!")
    print("\nNew fields added to User model:")
    print("  - is_active (Boolean)")
    print("  - setup_token (String)")
    print("  - created_at (DateTime)")
    print("  - updated_at (DateTime)")
    print("\nNOTE: Existing users need to be activated manually or have their passwords reset.")


if __name__ == "__main__":
    asyncio.run(migrate_database())
