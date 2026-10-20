"""
Geofence alert checks against a real PostgreSQL database.

Run: TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/inferth_alerts_test python test_geofence_alerts.py

The database must be on localhost and its name must end in _test. The checks drop and
recreate every table in it, so the URL is validated before anything is imported or connected.
"""
import asyncio
import os
import sys
import uuid
from urllib.parse import urlparse

TEST_URL = os.environ.get("TEST_DATABASE_URL", "")
TEST_PARTS = urlparse(TEST_URL)
if not TEST_URL or TEST_PARTS.hostname not in ("localhost", "127.0.0.1") or not TEST_PARTS.path.endswith("_test"):
    sys.exit("Set TEST_DATABASE_URL to a localhost PostgreSQL database whose name ends in _test.")
os.environ["DATABASE_URL"] = TEST_URL

import asyncpg
from sqlalchemy import func, select

from app.db import AsyncSessionLocal, Base, DATABASE_URL, engine
import app.models
from app.models import Alert, Device, Geofence, Rule, Tenant
from app.services.alerts import AlertService

assert TEST_PARTS.path in DATABASE_URL, "app.db is not using TEST_DATABASE_URL"

LAT, LNG = -17.8250, 31.0500
POS = {"in": (LAT, LNG), "out": (LAT + 0.01, LNG + 0.01)}
ENTRY = {"entry": True, "exit": False}
EXIT = {"entry": False, "exit": True}
BOTH = {"entry": True, "exit": True}
failures = []


def square(d=0.002):
    return [[LNG - d, LAT - d], [LNG + d, LAT - d], [LNG + d, LAT + d], [LNG - d, LAT + d], [LNG - d, LAT - d]]


def polygon():
    return {"type": "Polygon", "coordinates": [square()]}


def feature():
    return {"type": "Feature", "properties": {}, "geometry": polygon()}


def record(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f" -> {detail}"))
    if not ok:
        failures.append(name)


async def ensure_database():
    name = TEST_PARTS.path.lstrip("/")
    conn = await asyncpg.connect(TEST_URL.replace(TEST_PARTS.path, "/postgres", 1))
    try:
        if not await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name):
            await conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await conn.close()


async def reset_schema():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


async def new_device():
    tag = uuid.uuid4().hex[:10]
    async with AsyncSessionLocal() as db:
        tenant, other = Tenant(name=f"t-{tag}"), Tenant(name=f"o-{tag}")
        db.add_all([tenant, other])
        await db.flush()
        device = Device(imei=f"imei-{tag}", name=f"Truck {tag}", tenant_id=tenant.id, device_metadata={})
        db.add(device)
        await db.commit()
        return tenant.id, other.id, device.id


async def add_zone(tenant_id, assets, flags, geojson):
    async with AsyncSessionLocal() as db:
        db.add(Geofence(name="Depot", color="#10b981", assets=assets, alert_rules=flags,
                        notification={"channel": "system", "contact": ""}, geojson=geojson, tenant_id=tenant_id))
        await db.commit()


async def add_rule(tenant_id, event_type):
    async with AsyncSessionLocal() as db:
        db.add(Rule(tenant_id=tenant_id, device_id=None, event_type=event_type, channel="system", is_active=True))
        await db.commit()


async def send(device_id, where):
    lat, lng = POS[where]
    await AlertService.evaluate_rules(None, device_id, {"latitude": lat, "longitude": lng, "speed": 0, "raw": {}})


async def count(device_id, kind):
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(func.count(Alert.id)).where(
            Alert.device_id == device_id, Alert.type == f"geofence_{kind}"))
        return res.scalar()


async def run_sequence(name, seq, flags, rules, expect_entry=None, expect_exit=None,
                       assets=None, geojson=None, other_tenant=False, as_strings=False):
    tenant, other, dev = await new_device()
    ids = [str(dev)] if as_strings else [dev]
    await add_zone(other if other_tenant else tenant, assets if assets is not None else ids, flags, geojson or polygon())
    for event_type in rules:
        await add_rule(tenant, event_type)
    entry, leave = [], []
    try:
        for where in seq:
            await send(dev, where)
            entry.append(await count(dev, "entry"))
            leave.append(await count(dev, "exit"))
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    if expect_entry is not None:
        record(f"{name} [entry]", entry == expect_entry, f"got {entry}, expected {expect_entry}")
    if expect_exit is not None:
        record(f"{name} [exit]", leave == expect_exit, f"got {leave}, expected {expect_exit}")


async def run_concurrent(name):
    tenant, other, dev = await new_device()
    await add_zone(tenant, [dev], BOTH, polygon())
    await add_rule(tenant, "geofence_entry")
    await add_rule(tenant, "geofence_exit")
    try:
        await asyncio.gather(*(send(dev, where) for where in ["out", "in", "out", "in"]))
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    entries, exits = await count(dev, "entry"), await count(dev, "exit")
    record(name, (entries, exits) == (2, 1), f"entries={entries} exits={exits}, expected entries=2 exits=1")


async def run_checks():
    await ensure_database()
    await reset_schema()
    await run_sequence("exit rule, device inside", ["in"], EXIT, ["geofence_exit"], expect_exit=[0])
    await run_sequence("entry only: out,in,out,in", ["out", "in", "out", "in"], ENTRY, ["geofence_entry"], expect_entry=[0, 1, 1, 2])
    await run_sequence("exit only: in,out,in,out", ["in", "out", "in", "out"], EXIT, ["geofence_exit"], expect_exit=[0, 1, 1, 2])
    await run_sequence("both rules, full cycle", ["out", "in", "out", "in", "out"], BOTH,
                       ["geofence_entry", "geofence_exit"], expect_entry=[0, 1, 1, 2, 2], expect_exit=[0, 0, 1, 1, 2])
    await run_sequence("zone entry flag off", ["out", "in", "out"], {"entry": False, "exit": False},
                       ["geofence_entry"], expect_entry=[0, 0, 0])
    await run_sequence("starts inside: no false entry", ["in", "out", "in"], ENTRY, ["geofence_entry"], expect_entry=[0, 0, 1])
    await run_sequence("device not assigned to zone", ["out", "in"], ENTRY, ["geofence_entry"], assets=[999999], expect_entry=[0, 0])
    await run_sequence("zone belongs to another tenant", ["out", "in"], ENTRY, ["geofence_entry"], other_tenant=True, expect_entry=[0, 0])
    await run_sequence("asset ids stored as strings", ["out", "in"], ENTRY, ["geofence_entry"], as_strings=True, expect_entry=[0, 1])
    await run_sequence("zone saved as Feature", ["out", "in"], ENTRY, ["geofence_entry"], geojson=feature(), expect_entry=[0, 1])
    await run_sequence("repeated inside positions", ["out", "in", "in", "in"], ENTRY, ["geofence_entry"], expect_entry=[0, 1, 1, 1])
    await run_concurrent("concurrent positions keep arrival order")
    await engine.dispose()


def test_geofence_alerts():
    asyncio.run(run_checks())
    assert not failures, failures


if __name__ == "__main__":
    test_geofence_alerts()
    print("\nALL GEOFENCE ALERT CHECKS PASSED")
