import asyncio
import sys
import os

# Ensure backend directory is in python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.db import AsyncSessionLocal
from app.models import User
from sqlalchemy.future import select
from dotenv import load_dotenv

load_dotenv() # Load .env explicitly

async def list_users():
    print("Connecting to database...", file=sys.stderr)
    try:
        async with AsyncSessionLocal() as db:
            print("Session created...", file=sys.stderr)
            result = await db.execute(select(User))
            users = result.scalars().all()
            print(f"Total Users: {len(users)}")
            for u in users:
                print(f"ID: {u.id} | Email: {u.email} | Role: {u.role} | Active: {u.is_active}")
    except Exception as e:
        print(f"CRITICAL ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    try:
        loop = asyncio.get_event_loop_policy().get_event_loop()
        loop.run_until_complete(list_users())
    except Exception as e:
        print(f"LOOP ERROR: {e}", file=sys.stderr)
