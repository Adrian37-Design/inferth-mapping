import asyncio
import asyncpg
import bcrypt
import sys
# ...

# Configuration
USER = "postgres"
PASSWORD = "XooBUVGWZimrgPLZwmsMUScEPSDcdUiw"
HOST = "switchback.proxy.rlwy.net"
PORT = 30894
DATABASE = "railway"
TARGET_EMAIL = "adriantakudzwa7337@gmail.com"
NEW_PASSWORD = "Inferth2024!"

# pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

async def fix_user():
    print(f"Connecting to {HOST}...", file=sys.stderr, flush=True)
    try:
        import ssl
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        conn = await asyncpg.connect(user=USER, password=PASSWORD,
                                     host=HOST, port=PORT, database=DATABASE,
                                     ssl=ssl_ctx)
        print("Connected! Checking user...", file=sys.stderr, flush=True)
        
        # Check if user exists
        row = await conn.fetchrow("SELECT id, email FROM users WHERE email = $1", TARGET_EMAIL)
        
        # Use bcrypt directly to avoid passlib compatibility issues
        salt = bcrypt.gensalt()
        hashed_bytes = bcrypt.hashpw(NEW_PASSWORD.encode('utf-8'), salt)
        hashed_pw = hashed_bytes.decode('utf-8')
        
        if row:
            print(f"User {TARGET_EMAIL} found (ID: {row['id']}). Updating password...", file=sys.stderr, flush=True)
            await conn.execute("UPDATE users SET hashed_password = $1, is_active = TRUE WHERE email = $2", 
                               hashed_pw, TARGET_EMAIL)
            print("Password UPDATED successfully.", file=sys.stderr, flush=True)
        else:
            print(f"User {TARGET_EMAIL} NOT found. Creating...", file=sys.stderr, flush=True)
            # Create user (assuming tenant_id=1 exists, defaulting to role='admin')
            # Check for a tenant first
            tenant = await conn.fetchrow("SELECT id FROM tenants LIMIT 1")
            if not tenant:
                 print("No tenants found! Creating default tenant...", file=sys.stderr, flush=True)
                 tenant_id = await conn.fetchval("INSERT INTO tenants (name, subscription_plan) VALUES ('Default', 'basic') RETURNING id")
            else:
                 tenant_id = tenant['id']
            
            await conn.execute("""
                INSERT INTO users (email, hashed_password, role, is_active, is_admin, tenant_id, created_at)
                VALUES ($1, $2, 'admin', TRUE, TRUE, $3, NOW())
            """, TARGET_EMAIL, hashed_pw, tenant_id)
            print("User CREATED successfully.", file=sys.stderr, flush=True)
            
        await conn.close()
        print("Done.", flush=True)
        
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(fix_user())
