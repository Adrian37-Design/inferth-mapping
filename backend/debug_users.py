
import asyncio
import os
from dotenv import load_dotenv

# Load env vars
load_dotenv("backend/.env")

# Override DB host for local execution
if os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["DATABASE_URL"].replace("@db:", "@localhost:")

from app.db import AsyncSessionLocal
from sqlalchemy.future import select
from app.models import User

async def list_users():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User))
        users = result.scalars().all()
        print(f"Total Users: {len(users)}")
        for user in users:
            print(f"ID: {user.id}, Email: {user.email}, Role: {user.role}, Active: {user.is_active}")

if __name__ == "__main__":
    asyncio.run(list_users())
