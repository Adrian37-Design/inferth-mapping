import asyncpg
import asyncio
import sys

async def fix_user():
    if len(sys.argv) < 2:
        print("Usage: python fix_user_assignment.py <DATABASE_URL>")
        return
        
    db_url = sys.argv[1]
    if "+asyncpg" in db_url:
        db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
        
    # Railway proxy often requires SSL
    print(f"Connecting to database...")
    try:
        conn = await asyncpg.connect(db_url, ssl='require')
    except Exception as e:
        print(f"Connection failed with ssl='require': {e}")
        print("Retrying without explicit SSL...")
        try:
            conn = await asyncpg.connect(db_url)
        except Exception as e2:
            print(f"❌ Connection failed: {e2}")
            return

    try:
        user_email = "Inferth2026@gmail.com"
        
        # 1. Check current state
        user = await conn.fetchrow("SELECT id, email, tenant_id, role FROM users WHERE email = $1", user_email)
        if not user:
            print(f"❌ User {user_email} not found!")
            return
            
        print(f"\n[CURRENT STATE] for {user_email}:")
        print(f"  User ID:   {user['id']}")
        print(f"  Tenant ID: {user['tenant_id']} (1=Inferth Mapping, 2=Console Telematics)")
        print(f"  Role:      {user['role']}")
        
        tenants = await conn.fetch("SELECT id, name FROM tenants ORDER BY id")
        print("\n[AVAILABLE COMPANIES] in Database:")
        for t in tenants:
            print(f"  ID: {t['id']} | Name: {t['name']}")
            
        # 2. Fix if needed
        if user['tenant_id'] == 1:
            print(f"\n⚠️ User is currently assigned to Inferth Mapping (#1).")
            print(f"Updating {user_email} to Console Telematics (#2) as requested...")
            
            # Note: We must also change role if they are 'admin' because Tenant 2 only supports 'manager'/'viewer' in our code logic
            new_role = "manager" if user['role'] == "admin" else user['role']
            
            await conn.execute(
                "UPDATE users SET tenant_id = 2, role = $1 WHERE email = $2", 
                new_role, user_email
            )
            print("✅ UPDATE SUCCESSFUL!")
            print(f"   New Company ID: 2")
            print(f"   New Role: {new_role}")
            print("\nAction: Please Logout and Login again to see the changes.")
        else:
            print(f"\n✅ {user_email} is already assigned to Company ID {user['tenant_id']}.")
            
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(fix_user())
