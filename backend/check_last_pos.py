import asyncio
from app.db import AsyncSessionLocal
from app.models import Position, Device
from sqlalchemy import select

async def check_last_pos():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Device).where(Device.imei == '352672107830465'))
        device = res.scalars().first()
        if not device:
            print("Device not found")
            return
        
        res = await db.execute(select(Position).where(Position.device_id == device.id).order_by(Position.created_at.desc()).limit(1))
        pos = res.scalars().first()
        if not pos:
            print("No position found")
            return
            
        print(f"Latest Position for {device.imei}:")
        print(f"ID: {pos.id}")
        print(f"Lat: {pos.latitude}")
        print(f"Lon: {pos.longitude}")
        print(f"Created At: {pos.created_at}")

if __name__ == "__main__":
    asyncio.run(check_last_pos())
