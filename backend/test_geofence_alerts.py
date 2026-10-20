"""
Geofence alert checks against a real PostgreSQL database.

Run: TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/inferth_alerts_test python test_geofence_alerts.py

The database must be on localhost and its name must end in _test. The checks drop and
recreate every table in it, so the URL is validated before anything is imported or connected.
"""
import asyncio
import base64
import json
import os
import sys
import uuid
from datetime import datetime, timedelta
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
from app.models import Alert, Device, Geofence, Position, Rule, Tenant
from app.services.alerts import AlertService
from app.routers.controller import handle_violations, upsert_tracking_data

assert TEST_PARTS.path in DATABASE_URL, "app.db is not using TEST_DATABASE_URL"

LAT, LNG = -17.8250, 31.0500
POS = {"in": (LAT, LNG), "out": (LAT + 0.01, LNG + 0.01)}
ENTRY = {"entry": True, "exit": False}
EXIT = {"entry": False, "exit": True}
BOTH = {"entry": True, "exit": True}
OFF = {"entry": False, "exit": False}
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


async def add_device(tenant_id):
    tag = uuid.uuid4().hex[:10]
    async with AsyncSessionLocal() as db:
        device = Device(imei=f"imei-{tag}", name=f"Truck {tag}", tenant_id=tenant_id, device_metadata={})
        db.add(device)
        await db.commit()
        return device.id


async def add_zone(tenant_id, assets, flags, geojson):
    async with AsyncSessionLocal() as db:
        zone = Geofence(name="Depot", color="#10b981", assets=assets, alert_rules=flags,
                        notification={"channel": "system", "contact": ""}, geojson=geojson, tenant_id=tenant_id)
        db.add(zone)
        await db.commit()
        return zone.id


async def add_rule(tenant_id, event_type, channel="system", contact=None):
    async with AsyncSessionLocal() as db:
        db.add(Rule(tenant_id=tenant_id, device_id=None, event_type=event_type, channel=channel,
                    contact=contact, is_active=True))
        await db.commit()


async def send(device_id, where):
    lat, lng = POS[where]
    await AlertService.evaluate_rules(None, device_id, {"latitude": lat, "longitude": lng, "speed": 0, "raw": {}})


async def count(tenant_id, kind, device_id=None):
    async with AsyncSessionLocal() as db:
        query = select(func.count(Alert.id)).where(Alert.tenant_id == tenant_id, Alert.type == f"geofence_{kind}")
        if device_id is not None:
            query = query.where(Alert.device_id == device_id)
        return (await db.execute(query)).scalar()


async def triggered(zone_id):
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(Geofence.triggered_at).where(Geofence.id == zone_id))).scalar() is not None


async def run_sequence(name, seq, flags, rules, expect_entry, expect_exit, expect_triggered,
                       assets=None, geojson=None, other_tenant=False, as_strings=False):
    tenant, other, dev = await new_device()
    ids = [str(dev)] if as_strings else [dev]
    zone_id = await add_zone(other if other_tenant else tenant, assets if assets is not None else ids, flags, geojson or polygon())
    for event_type in rules:
        await add_rule(tenant, event_type)
    entry, leave = [], []
    try:
        for where in seq:
            await send(dev, where)
            entry.append(await count(tenant, "entry", dev))
            leave.append(await count(tenant, "exit", dev))
        done = await triggered(zone_id)
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    record(f"{name} [entry]", entry == expect_entry, f"got {entry}, expected {expect_entry}")
    record(f"{name} [exit]", leave == expect_exit, f"got {leave}, expected {expect_exit}")
    record(f"{name} [triggered]", done == expect_triggered, f"got {done}, expected {expect_triggered}")


async def run_concurrent(name):
    tenant, other, dev = await new_device()
    zone_id = await add_zone(tenant, [dev], BOTH, polygon())
    await add_rule(tenant, "geofence_entry")
    await add_rule(tenant, "geofence_exit")
    try:
        await asyncio.gather(*(send(dev, where) for where in ["out", "in", "out", "in"]))
        done = await triggered(zone_id)
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    entries, exits = await count(tenant, "entry", dev), await count(tenant, "exit", dev)
    record(name, (entries, exits, done) == (1, 0, True), f"entries={entries} exits={exits} triggered={done}")


async def run_shared_zone(name):
    tenant, other, dev_a = await new_device()
    dev_b = await add_device(tenant)
    zone_id = await add_zone(tenant, [dev_a, dev_b], ENTRY, polygon())
    await send(dev_a, "out")
    await send(dev_b, "out")
    try:
        await asyncio.gather(send(dev_a, "in"), send(dev_b, "in"))
        done = await triggered(zone_id)
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    total = await count(tenant, "entry")
    record(name, (total, done) == (1, True), f"entry violations={total} triggered={done}")


async def run_rule_notification(name, flags, expect_entries, expect_sent):
    tenant, other, dev = await new_device()
    await add_zone(tenant, [dev], flags, polygon())
    await add_rule(tenant, "geofence_entry", channel="email", contact="ops@example.com")
    sent = []

    async def fake_email(to, subject, html):
        sent.append(to)

    original = AlertService._send_email_async
    AlertService._send_email_async = staticmethod(fake_email)
    try:
        await send(dev, "out")
        await send(dev, "in")
        await asyncio.sleep(0.05)
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    finally:
        AlertService._send_email_async = original
    entries = await count(tenant, "entry", dev)
    record(name, (entries, len(sent)) == (expect_entries, expect_sent), f"entries={entries} emails={len(sent)}")


class FakeRequest:
    def __init__(self, body):
        self._body = body
        self.cookies = {}
        self.headers = {}

    async def json(self):
        return self._body


async def drain_tasks():
    current = asyncio.current_task()
    pending = [task for task in asyncio.all_tasks() if task is not current]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


async def new_tracker(tenant_id):
    imei = f"imei-{uuid.uuid4().hex[:10]}"
    async with AsyncSessionLocal() as db:
        device = Device(imei=imei, name=f"Xcela {imei[-4:]}", tenant_id=tenant_id, device_metadata={})
        db.add(device)
        await db.commit()
        return device.id, imei


async def post_telemetry(imei, lat, lng, minutes_ago):
    stamp = (datetime.utcnow() - timedelta(minutes=minutes_ago)).strftime("%m/%d/%Y %H:%M:%S GMT")
    row = {"lat": lat, "lon": lng, "speed": 0, "satellites": 8, "time_to": stamp}
    async with AsyncSessionLocal() as db:
        await upsert_tracking_data(request=FakeRequest({"imei": imei, "data": [row]}), db=db)
    await drain_tasks()


async def run_http_ingest(name):
    tenant, other, _ = await new_device()
    dev, imei = await new_tracker(tenant)
    zone_id = await add_zone(other, [dev], ENTRY, polygon())
    try:
        await post_telemetry(imei, *POS["out"], minutes_ago=2)
        await post_telemetry(imei, *POS["in"], minutes_ago=1)
        done = await triggered(zone_id)
        entries = await count(tenant, "entry", dev)
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    record(name, (entries, done) == (1, True), f"entries={entries} triggered={done}")


def fake_token(payload):
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"header.{body}.signature"


async def run_tracker_violations(name):
    tenant, other, _ = await new_device()
    dev, imei = await new_tracker(tenant)
    token = fake_token({"number_plate": imei})
    body = {"violations": [{"type": "GEOFENCE", "data": {"lat": LAT, "lon": LNG, "speed": 0}},
                           {"type": "OVERSPEED", "data": {"speed": 112}}]}
    try:
        async with AsyncSessionLocal() as db:
            request = FakeRequest(body)
            request.cookies = {"token": token}
            await handle_violations(request=request, db=db)
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(select(Alert.type, Alert.message, Alert.device_id, Alert.tenant_id)
                                     .where(Alert.device_id == dev))).all()
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    kinds = sorted(row.type for row in rows)
    named = all(f"[Xcela {imei[-4:]}]" in row.message for row in rows)
    owned = all(row.tenant_id == tenant for row in rows)
    record(name, kinds == ["speeding", "tracker_geofence"] and named and owned,
           f"rows={[(row.type, row.message) for row in rows]}")


async def run_parked_exit(name):
    tenant, other, _ = await new_device()
    dev, imei = await new_tracker(tenant)
    async with AsyncSessionLocal() as db:
        db.add(Position(device_id=dev, latitude=POS["in"][0], longitude=POS["in"][1], speed=0,
                        timestamp=datetime.utcnow() - timedelta(minutes=30)))
        await db.commit()
    zone_id = await add_zone(tenant, [dev], EXIT, polygon())
    try:
        await post_telemetry(imei, *POS["out"], minutes_ago=0)
        exits = await count(tenant, "exit", dev)
        done = await triggered(zone_id)
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
        return
    record(name, (exits, done) == (1, True), f"exits={exits} triggered={done}")


async def run_checks():
    await ensure_database()
    await reset_schema()
    await run_sequence("entry only: out,in,out,in", ["out", "in", "out", "in"], ENTRY, ["geofence_entry"],
                       expect_entry=[0, 1, 1, 1], expect_exit=[0, 0, 0, 0], expect_triggered=True)
    await run_sequence("exit only: in,out,in,out", ["in", "out", "in", "out"], EXIT, ["geofence_exit"],
                       expect_entry=[0, 0, 0, 0], expect_exit=[0, 1, 1, 1], expect_triggered=True)
    await run_sequence("both: out,in,out,in,out", ["out", "in", "out", "in", "out"], BOTH,
                       ["geofence_entry", "geofence_exit"],
                       expect_entry=[0, 1, 1, 1, 1], expect_exit=[0, 0, 0, 0, 0], expect_triggered=True)
    await run_sequence("both: in,out,in (exit comes first)", ["in", "out", "in"], BOTH,
                       ["geofence_entry", "geofence_exit"],
                       expect_entry=[0, 0, 0], expect_exit=[0, 1, 1], expect_triggered=True)
    await run_sequence("no rules: the zone alone records the violation", ["out", "in", "out"], ENTRY, [],
                       expect_entry=[0, 1, 1], expect_exit=[0, 0, 0], expect_triggered=True)
    await run_sequence("entry flag off: nothing is watched", ["out", "in", "out"], OFF, ["geofence_entry"],
                       expect_entry=[0, 0, 0], expect_exit=[0, 0, 0], expect_triggered=False)
    await run_sequence("starts inside: first entry triggers, exits are not watched", ["in", "out", "in"], ENTRY,
                       ["geofence_entry"], expect_entry=[0, 0, 1], expect_exit=[0, 0, 0], expect_triggered=True)
    await run_sequence("device not assigned to zone", ["out", "in"], ENTRY, ["geofence_entry"], assets=[999999],
                       expect_entry=[0, 0], expect_exit=[0, 0], expect_triggered=False)
    await run_sequence("zone from another tenant still watches its listed tracker", ["out", "in"], ENTRY, ["geofence_entry"], other_tenant=True,
                       expect_entry=[0, 1], expect_exit=[0, 0], expect_triggered=True)
    await run_sequence("asset ids stored as strings", ["out", "in"], ENTRY, [], as_strings=True,
                       expect_entry=[0, 1], expect_exit=[0, 0], expect_triggered=True)
    await run_sequence("zone saved as Feature", ["out", "in"], ENTRY, [], geojson=feature(),
                       expect_entry=[0, 1], expect_exit=[0, 0], expect_triggered=True)
    await run_sequence("repeated inside positions", ["out", "in", "in", "in"], ENTRY, [],
                       expect_entry=[0, 1, 1, 1], expect_exit=[0, 0, 0, 0], expect_triggered=True)
    await run_concurrent("concurrent positions: one violation, in arrival order")
    await run_shared_zone("two trackers share one zone: one violation")
    await run_rule_notification("rule emails once, no duplicate violation", ENTRY, expect_entries=1, expect_sent=1)
    await run_rule_notification("zone not watching entry: no violation, no email", EXIT, expect_entries=0, expect_sent=0)
    await run_http_ingest("HTTP telemetry (Xcela upsert) triggers a geofence drawn by another tenant")
    await run_tracker_violations("tracker violations attach to the vehicle that sent them")
    await run_parked_exit("zone drawn while the tracker is parked inside: leaving records an exit")
    await engine.dispose()


def test_geofence_alerts():
    asyncio.run(run_checks())
    assert not failures, failures


if __name__ == "__main__":
    test_geofence_alerts()
    print("\nALL GEOFENCE ALERT CHECKS PASSED")
