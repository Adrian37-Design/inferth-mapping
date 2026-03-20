
import asyncio
from app.db import AsyncSessionLocal
from app.models import Device
from sqlalchemy import select
import json

async def check_metadata():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Device).limit(5))
        devices = res.scalars().all()
        for d in devices:
            print(f"ID: {d.id}, IMEI: {d.imei}, Name: {d.name}, Metadata: {json.dumps(d.device_metadata)}")

if __name__ == "__main__":
    asyncio.run(check_metadata())
