import asyncio
import asyncpg
import sys

# DB_URL = "postgresql://postgres:XooBUVGWZimrgPLZwmsMUScEPSDcdUiw@switchback.proxy.rlwy.net:30894/railway"

USER = "postgres"
PASSWORD = "XooBUVGWZimrgPLZwmsMUScEPSDcdUiw"
HOST = "switchback.proxy.rlwy.net"
PORT = 30894
DATABASE = "railway"

async def check_users():
    print("Attempting to connect via asyncpg...", file=sys.stderr, flush=True)
    try:
        # Create a default SSL context
        import ssl
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        conn = await asyncpg.connect(user=USER, password=PASSWORD,
                                     host=HOST, port=PORT, database=DATABASE,
                                     ssl=ssl_ctx)
        print("Connected successfully!", file=sys.stderr, flush=True)
        
        rows = await conn.fetch("SELECT id, email, role, is_active, hashed_password FROM users")
        
        print(f"Found {len(rows)} users:", flush=True)
        for row in rows:
            uid = row['id']
            email = row['email']
            role = row['role']
            active = row['is_active']
            has_pw = "YES" if row['hashed_password'] else "NO"
            print(f"ID: {uid} | Email: {email} | Role: {role} | Active: {active} | HasPassword: {has_pw}", flush=True)
            
        await conn.close()
        print("Finished.", flush=True)
        
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(check_users())
