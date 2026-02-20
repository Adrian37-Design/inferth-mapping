"""
Fix tenant IDs: reassign Console Telematics from ID #4 → #2
and reset the sequence so next company gets ID #3.

Run with:
  python fix_tenant_ids.py
  (paste your Railway DATABASE_URL when prompted)
"""
import asyncpg
import asyncio


async def fix():
    db_url = input("Paste Railway DATABASE_URL (from backend variables): ").strip()
    if "+asyncpg" in db_url:
        db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")

    conn = await asyncpg.connect(db_url)
    try:
        # 1. Show current state
        rows = await conn.fetch("SELECT id, name FROM tenants ORDER BY id")
        print("\nCurrent tenants:")
        for r in rows:
            print(f"  ID={r['id']}  Name={r['name']}")

        # 2. Confirm Console Telematics is ID 4
        ct = await conn.fetchrow("SELECT id FROM tenants WHERE name = 'Console Telematics'")
        if not ct:
            print("\n❌ Console Telematics not found.")
            return
        if ct['id'] == 2:
            print("\n✅ Console Telematics is already ID #2. Nothing to do.")
            return

        old_id = ct['id']
        print(f"\nReassigning Console Telematics: ID {old_id} → 2")

        # 3. Update foreign keys (users) first
        await conn.execute(
            "UPDATE users SET tenant_id = 2 WHERE tenant_id = $1", old_id
        )
        print("  ✅ Updated users.tenant_id")

        # 4. Update the tenant ID itself
        await conn.execute(
            "UPDATE tenants SET id = 2 WHERE id = $1", old_id
        )
        print("  ✅ Updated tenants.id")

        # 5. Reset the sequence so next INSERT gets id=3
        await conn.execute("SELECT setval('tenants_id_seq', 2, true)")
        print("  ✅ Reset tenants_id_seq to 2 (next will be 3)")

        # 6. Show final state
        rows = await conn.fetch("SELECT id, name FROM tenants ORDER BY id")
        print("\nFinal tenants:")
        for r in rows:
            print(f"  ID={r['id']}  Name={r['name']}")

        print("\n✅ Done! Console Telematics is now #2.")
    except Exception as e:
        print(f"\n❌ Error: {e}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(fix())
