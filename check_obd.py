
import asyncio
from sqlalchemy import select, desc
from app.db import AsyncSessionLocal
from app.models import Position
import json

async def check_obd():
    async with AsyncSessionLocal() as db:
        # Look for the last 1000 positions that have 'obd' in their raw JSON
        stmt = select(Position).where(Position.raw.contains({"type": "obd"})).order_by(desc(Position.timestamp)).limit(10)
        result = await db.execute(stmt)
        positions = result.scalars().all()
        
        if not positions:
            print("No OBD data found in the last records.")
            return

        print(f"Found {len(positions)} recent OBD records:")
        for p in positions:
            print(f"ID: {p.id} | Device: {p.device_id} | Time: {p.timestamp}")
            print(f"Data: {json.dumps(p.raw, indent=2)}")
            print("-" * 30)

if __name__ == "__main__":
    asyncio.run(check_obd())
