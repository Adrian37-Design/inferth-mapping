"""
Diagnostic for the Sinotrack ST-901A (configured ID: 8040000).

Run this ON THE VPS (where DATABASE_URL resolves the 'db' host), e.g.:
    docker exec -it inferth-app python backend/check_sinotrack_8040000.py

It checks:
  1. Whether a device matching 8040000 (or its full IMEI) exists.
  2. The most recent positions for that device.
  3. Any recently created devices (in case it auto-registered under a different id).
  4. A raw scan of recent positions for the string '8040000'.
"""
import asyncio
import os
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from dotenv import load_dotenv

load_dotenv()

TARGET_ID = "3009295338"


def _normalize_url(db_url: str) -> str:
    # Allow running locally against a forwarded port
    if "db:5432" in db_url and os.getenv("USE_LOCALHOST_DB") == "1":
        db_url = db_url.replace("db:5432", "localhost:5432")
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql+asyncpg://")
    elif db_url.startswith("postgresql://") and "+asyncpg" not in db_url:
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
    return db_url


async def main():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set.")
        return

    engine = create_async_engine(_normalize_url(db_url))

    async with engine.connect() as conn:
        print("=" * 60)
        print(f"SINOTRACK ST-901A DIAGNOSTIC - target id: {TARGET_ID}")
        print(f"Time (UTC): {datetime.utcnow()}")
        print("=" * 60)

        # 1. Device match (exact or contains)
        print("\n[1] DEVICE LOOKUP")
        res = await conn.execute(
            text("SELECT id, imei, name, tenant_id, created_at FROM devices "
                 "WHERE imei = :exact OR imei LIKE :like ORDER BY created_at DESC"),
            {"exact": TARGET_ID, "like": f"%{TARGET_ID}%"},
        )
        devices = res.fetchall()
        if devices:
            for d in devices:
                print(f"  FOUND: id={d.id} imei={d.imei} name='{d.name}' "
                      f"tenant={d.tenant_id} created={d.created_at}")
        else:
            print(f"  No device whose IMEI matches '{TARGET_ID}'.")

        # 2. Recent positions for matched devices
        if devices:
            print("\n[2] RECENT POSITIONS (matched devices)")
            for d in devices:
                res = await conn.execute(
                    text("SELECT id, timestamp, latitude, longitude, speed "
                         "FROM positions WHERE device_id = :did "
                         "ORDER BY timestamp DESC LIMIT 5"),
                    {"did": d.id},
                )
                rows = res.fetchall()
                print(f"  Device {d.imei} (id={d.id}): {len(rows)} recent points")
                for p in rows:
                    print(f"    - {p.timestamp}: lat={p.latitude} lon={p.longitude} "
                          f"speed={p.speed}")
                if not rows:
                    print("    (device exists but no positions stored yet)")

        # 3. Newest devices overall (last 30 min)
        print("\n[3] NEWEST DEVICES (last 10)")
        res = await conn.execute(
            text("SELECT id, imei, name, created_at FROM devices "
                 "ORDER BY created_at DESC LIMIT 10")
        )
        for d in res.fetchall():
            print(f"  - {d.created_at}: imei={d.imei} name='{d.name}'")

        # 4. Raw scan of recent positions for the id string
        print("\n[4] RAW SCAN of last 50 positions for '8040000'")
        res = await conn.execute(
            text("SELECT id, device_id, timestamp, raw FROM positions "
                 "ORDER BY id DESC LIMIT 50")
        )
        hits = 0
        for row in res.fetchall():
            if TARGET_ID in str(row.raw):
                hits += 1
                print(f"  MATCH pos id={row.id} device_id={row.device_id} "
                      f"ts={row.timestamp}")
        if hits == 0:
            print("  No raw payloads in the last 50 positions contain '8040000'.")

        print("\n" + "=" * 60)
        print("DONE")
        print("=" * 60)

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
