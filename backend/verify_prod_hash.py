import asyncio
import asyncpg
import bcrypt
import sys

# Configuration
USER = "postgres"
PASSWORD = "XooBUVGWZimrgPLZwmsMUScEPSDcdUiw"
HOST = "switchback.proxy.rlwy.net"
PORT = 30894
DATABASE = "railway"
TARGET_EMAIL = "adriantakudzwa7337@gmail.com"
EXPECTED_PW = "Inferth2024!"

async def verify_hash():
    print(f"Connecting to {HOST}...", file=sys.stderr, flush=True)
    try:
        import ssl
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        conn = await asyncpg.connect(user=USER, password=PASSWORD,
                                     host=HOST, port=PORT, database=DATABASE,
                                     ssl=ssl_ctx)
        
        row = await conn.fetchrow("SELECT hashed_password FROM users WHERE email = $1", TARGET_EMAIL)
        
        if row:
            stored_hash = row['hashed_password']
            print(f"Retrieved Hash: {stored_hash[:10]}...", file=sys.stderr, flush=True)
            
            # Verify
            if bcrypt.checkpw(EXPECTED_PW.encode('utf-8'), stored_hash.encode('utf-8')):
                print("SUCCESS: Database hash MATCHES 'Inferth2024!'", file=sys.stderr, flush=True)
            else:
                print("FAILURE: Database hash DOES NOT match 'Inferth2024!'", file=sys.stderr, flush=True)
        else:
            print("User not found!", file=sys.stderr, flush=True)
            
        await conn.close()
        
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(verify_hash())
