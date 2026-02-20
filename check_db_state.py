import asyncpg
import asyncio
import os

async def check_db():
    # Use the DATABASE_URL from common knowledge if possible, 
    # but since I don't have it in env, I'll ask the user to run this or use a known one if I can find it.
    # Wait, I can try to find it in the logs or config.
    pass

if __name__ == "__main__":
    # I'll actually just use the run_command with a psql-like approach if possible, 
    # but I don't have psql. I'll use a python script that takes the URL.
    import sys
    db_url = sys.argv[1] if len(sys.argv) > 1 else ""
    if not db_url:
        print("Usage: python check_db.py <DATABASE_URL>")
        sys.exit(1)
        
    async def run():
        if "+asyncpg" in db_url:
            cleaned_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
        else:
            cleaned_url = db_url
            
        conn = await asyncpg.connect(cleaned_url)
        try:
            print("--- Users ---")
            users = await conn.fetch("SELECT id, email, tenant_id, role, is_admin FROM users")
            for u in users:
                print(u)
                
            print("\n--- Tenants ---")
            tenants = await conn.fetch("SELECT id, name FROM tenants")
            for t in tenants:
                print(t)
                
        finally:
            await conn.close()
            
    asyncio.run(run())
