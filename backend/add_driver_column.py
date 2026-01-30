import asyncio
from sqlalchemy import text
from app.db import engine

async def add_column():
    async with engine.begin() as conn:
        print("Adding driver_name column to devices table...")
        try:
            await conn.execute(text("ALTER TABLE devices ADD COLUMN IF NOT EXISTS driver_name VARCHAR;"))
            print("Column added successfully!")
        except Exception as e:
            print(f"Error adding column: {e}")
        finally:
            await engine.dispose()

if __name__ == "__main__":
    asyncio.run(add_column())
