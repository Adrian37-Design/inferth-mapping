
import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text, select
from app.models import Device, Tenant, User # Import actual models
from app.db import Base

# Production DB URL
DATABASE_URL = "postgresql+asyncpg://postgres:XooBUVGWZimrgPLZwmsMUScEPSDcdUiw@switchback.proxy.rlwy.net:30894/railway"

async def debug_orm():
    print(f"Connecting to: {DATABASE_URL}")
    engine = create_async_engine(DATABASE_URL, echo=False)  # Turn off echo for cleaner output
    AsyncSessionLocal = sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    
    try:
        async with AsyncSessionLocal() as db:
            print("--- Checking Users in Production DB ---")
            result = await db.execute(select(User))
            users = result.scalars().all()
            print(f"Found {len(users)} users.")
            
            for u in users:
                has_pw = "YES" if u.hashed_password else "NO"
                print(f"ID: {u.id} | Email: {u.email} | Role: {u.role} | Active: {u.is_active} | Has PW: {has_pw}")
                
            # Specifically check for adriantakudzwa7337@gmail.com
            target_email = "adriantakudzwa7337@gmail.com"
            result = await db.execute(select(User).where(User.email == target_email))
            target_user = result.scalars().first()
            
            if target_user:
                print(f"\n--- Specfic Check for {target_email} ---")
                print(f"Status: Found. Active: {target_user.is_active}. PW Hash: {target_user.hashed_password[:10]}...")
            else:
                print(f"\n--- Specfic Check for {target_email} ---")
                print("Status: NOT FOUND. This user does not exist in production.")

    except Exception as e:
        print(f"Query FAILED: {e}")
        import traceback
        traceback.print_exc()
    finally:
        await engine.dispose()

if __name__ == "__main__":
    import sys
    print("SCRIPT STARTING...", file=sys.stderr)
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(debug_orm())
