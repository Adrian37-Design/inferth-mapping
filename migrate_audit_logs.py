"""
Migration script: Add tenant_id column to audit_logs table.
This fixes the "column tenant_id of relation audit_logs does not exist" error.

Usage:
  python migrate_audit_logs.py
  (Paste your Railway DATABASE_URL when prompted)
"""
import asyncpg
import asyncio

async def migrate():
    print("\n--- Inferth Mapping Database Migration ---")
    db_url = input("Paste Railway DATABASE_URL: ").strip()
    
    # Simple fix for SQLAlchemy URL to asyncpg URL
    if "+asyncpg" in db_url:
        db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
    elif db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://")

    try:
        conn = await asyncpg.connect(db_url)
        print("✅ Connected to database.")
        
        # Check if column exists
        exists = await conn.fetchval("""
            SELECT count(*) FROM information_schema.columns 
            WHERE table_name='audit_logs' AND column_name='tenant_id'
        """)
        
        if exists > 0:
            print("✅ 'tenant_id' column already exists in 'audit_logs'.")
        else:
            print("⚠️ 'tenant_id' column missing. Adding it now...")
            # Add the column as a foreign key
            # We don't set NOT NULL yet to avoid issues with existing data if any
            await conn.execute("""
                ALTER TABLE audit_logs 
                ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)
            """)
            print("✅ Column 'tenant_id' added successfully.")

        # Optional: Backfill tenant_id from users if possible
        # Since audit_logs has user_id, we can link them
        print("🔄 Backfilling tenant_id for existing logs...")
        await conn.execute("""
            UPDATE audit_logs
            SET tenant_id = users.tenant_id
            FROM users
            WHERE audit_logs.user_id = users.id
            AND audit_logs.tenant_id IS NULL
        """)
        print("✅ Backfill complete.")

    except Exception as e:
        print(f"❌ Error: {e}")
    finally:
        if 'conn' in locals():
            await conn.close()
            print("👋 Database connection closed.")

if __name__ == "__main__":
    asyncio.run(migrate())
