"""
Authentication checks for the live WebSocket feed and the tracker controller endpoints.

Run: TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/inferth_auth_test python verify_auth.py

The database must be on localhost and its name must end in _test. The checks drop and
recreate every table in it, so the URL is validated before anything is imported or connected.
"""
import asyncio
import base64
import hashlib
import hmac
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
import httpx
import uvicorn
import websockets
from fastapi import HTTPException
from sqlalchemy import select

from app.db import AsyncSessionLocal, Base, DATABASE_URL, engine
import app.models
from app.config import settings
from app.models import Alert, AuditLog, Device, Position, Tenant, User
from app.main import app
from app.security import create_access_token
from app.auth_middleware import require_super_admin
from app.routers.controller import _tracker_signed, get_commands, handle_sos_alerts, handle_violations, upsert_tracking_data
from app.routers.alerts import get_alerts
from app.routers.geofences import create_geofence, delete_geofence, get_geofences
from app.services.alerts import AlertService
from app.routers.analytics import get_maintenance_status
from app.routers.audit import get_audit_logs
from app.routers.devices import CommandPayload, list_devices, send_device_command
from app.routers.positions import get_device_route, get_fleet_snapshot
from app.routers.reports import get_device_check

assert TEST_PARTS.path in DATABASE_URL, "app.db is not using TEST_DATABASE_URL"

PORT = 8765
WS_URL = f"ws://127.0.0.1:{PORT}/ws/positions"
LAT, LNG = -17.8250, 31.0500
failures = []
step_counter = 0


def record(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f" -> {detail}"))
    if not ok:
        failures.append(name)


class FakeRequest:
    def __init__(self, body=None, cookies=None, headers=None):
        self._body = body or {}
        self.cookies = cookies or {}
        self.headers = headers or {}

    async def json(self):
        return self._body


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


async def make_tenants():
    async with AsyncSessionLocal() as db:
        db.add_all([Tenant(id=1, name="Inferth Projects"), Tenant(id=2, name="Acme"), Tenant(id=3, name="Other Co")])
        await db.commit()


async def make_actor(tenant_id, role="admin", active=True):
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    async with AsyncSessionLocal() as db:
        user = User(email=email, role=role, is_active=active, tenant_id=tenant_id)
        db.add(user)
        await db.commit()
        uid = user.id
    return create_access_token({"sub": email, "user_id": uid}), User(id=uid, email=email, role=role, is_active=active, tenant_id=tenant_id, is_admin=False)


async def make_user(tenant_id, active=True, role="admin"):
    return (await make_actor(tenant_id, role, active))[0]


async def make_device(tenant_id, company=None):
    imei = f"ws-{uuid.uuid4().hex[:10]}"
    async with AsyncSessionLocal() as db:
        db.add(Device(imei=imei, name=f"Test {imei}", tenant_id=tenant_id, company=company, device_metadata={}))
        await db.commit()
    return imei


async def publish_round(imeis):
    global step_counter
    step_counter += 1
    stamp = datetime.utcnow().strftime("%m/%d/%Y %H:%M:%S GMT")
    for imei in imeis:
        row = {"lat": LAT + step_counter * 0.0002, "lon": LNG, "speed": 10, "satellites": 8, "time_to": stamp}
        async with AsyncSessionLocal() as db:
            await upsert_tracking_data(request=FakeRequest({"imei": imei, "data": [row]}), db=db)


async def read_messages(ws, seconds):
    messages = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while (remaining := deadline - loop.time()) > 0:
        try:
            messages.append(json.loads(await asyncio.wait_for(ws.recv(), remaining)))
        except asyncio.TimeoutError:
            break
    return messages


async def close_code(ws, seconds):
    try:
        while True:
            await asyncio.wait_for(ws.recv(), seconds)
    except websockets.exceptions.ConnectionClosed as exc:
        return exc.rcvd.code if exc.rcvd else None
    except asyncio.TimeoutError:
        return "still open"


async def check_silent_connection(imeis):
    async with websockets.connect(WS_URL) as ws:
        await asyncio.sleep(0.5)
        await publish_round(imeis)
        leaked = [m for m in await read_messages(ws, 1.0) if m.get("type") != "auth_ok"]
        code = await close_code(ws, 15)
    record("no auth message: no positions are streamed", not leaked, f"received {len(leaked)} positions")
    record("no auth message: connection closed with 1008", code == 1008, f"close code {code}")


async def check_rejected(name, token):
    try:
        async with websockets.connect(WS_URL) as ws:
            await ws.send(json.dumps({"type": "auth", "token": token}))
            code = await close_code(ws, 5)
    except Exception as exc:
        code = type(exc).__name__
    record(name, code == 1008, f"close code {code}")


async def check_viewer(name, token, imeis, expected):
    try:
        async with websockets.connect(WS_URL) as ws:
            await ws.send(json.dumps({"type": "auth", "token": token}))
            await asyncio.sleep(1.0)
            await publish_round(imeis)
            messages = await read_messages(ws, 1.5)
    except Exception as exc:
        record(name, False, f"{type(exc).__name__}: {exc}")
        return
    auth_ok = any(m.get("type") == "auth_ok" for m in messages)
    positions = [m for m in messages if m.get("type") != "auth_ok"]
    seen = {m.get("imei") for m in positions}
    internal_fields = any("tenant_id" in m or "company" in m for m in positions)
    record(name, auth_ok and seen == set(expected), f"auth_ok={auth_ok} saw={sorted(seen)}")
    record(f"{name} (wire format)", not internal_fields, "tenant_id or company leaked to the browser")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def make_token(payload: dict, secret: str) -> str:
    head = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64url(json.dumps(payload).encode())
    signature = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64url(signature)}"


class TrackerSettings:
    def __init__(self, mode, secrets):
        self.mode, self.secrets, self.saved = mode, secrets, None

    def __enter__(self):
        self.saved = (settings.TRACKER_AUTH_MODE, settings.TRACKER_JWT_SECRETS)
        settings.TRACKER_AUTH_MODE, settings.TRACKER_JWT_SECRETS = self.mode, self.secrets

    def __exit__(self, *exc_info):
        settings.TRACKER_AUTH_MODE, settings.TRACKER_JWT_SECRETS = self.saved


def next_step():
    global step_counter
    step_counter += 1
    return step_counter


async def upsert_as(imei, token=None, headers=None):
    row = {"lat": LAT + next_step() * 0.0002, "lon": LNG, "speed": 10, "satellites": 8,
           "time_to": datetime.utcnow().strftime("%m/%d/%Y %H:%M:%S GMT")}
    request = FakeRequest({"imei": imei, "data": [row]}, cookies={"token": token} if token else {}, headers=headers)
    async with AsyncSessionLocal() as db:
        return await upsert_tracking_data(request=request, db=db)


async def poll_commands(imei, token=None):
    async with AsyncSessionLocal() as db:
        return await get_commands(request=FakeRequest({}, cookies={"token": token} if token else {}), imei=imei, db=db)


async def post_violation(body, token=None):
    async with AsyncSessionLocal() as db:
        return await handle_violations(request=FakeRequest(body, cookies={"token": token} if token else {}), db=db)


async def post_sos(body, token=None):
    async with AsyncSessionLocal() as db:
        return await handle_sos_alerts(request=FakeRequest(body, cookies={"token": token} if token else {}), db=db)


async def status_of(call):
    try:
        await call
    except HTTPException as exc:
        return exc.status_code
    return 200


async def positions_stored(imei):
    async with AsyncSessionLocal() as db:
        device = (await db.execute(select(Device).where(Device.imei == imei))).scalars().first()
        if device is None:
            return 0
        return len((await db.execute(select(Position).where(Position.device_id == device.id))).scalars().all())


async def alerts_for(imei):
    async with AsyncSessionLocal() as db:
        device = (await db.execute(select(Device).where(Device.imei == imei))).scalars().first()
        if device is None:
            return 0
        return len((await db.execute(select(Alert).where(Alert.device_id == device.id))).scalars().all())


async def device_exists(imei):
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(Device).where(Device.imei == imei))).scalars().first() is not None


async def pending_command(imei):
    async with AsyncSessionLocal() as db:
        device = (await db.execute(select(Device).where(Device.imei == imei))).scalars().first()
        return (device.device_metadata or {}).get("pending_command")


async def check_tracker_signatures():
    secret = "s" * 72
    token = make_token({"number_plate": "YZ4321"}, secret)
    head, _, signature = token.split(".")
    forged = f"{head}.{b64url(json.dumps({'number_plate': 'ZZ9999'}).encode())}.{signature}"
    record("tracker signature: the device's own secret verifies", _tracker_signed(token, secret))
    record("tracker signature: another secret is rejected", not _tracker_signed(token, "t" * 72))
    record("tracker signature: an edited payload is rejected", not _tracker_signed(forged, secret))
    record("tracker signature: malformed tokens are rejected", not _tracker_signed("abc", secret) and not _tracker_signed("a.b", secret))


async def check_monitor_mode():
    secret = "m" * 72
    imei = await make_device(2)
    with TrackerSettings("monitor", {imei: secret}):
        before = await positions_stored(imei)
        await upsert_as(imei)
        await upsert_as(imei, token=make_token({"number_plate": "X"}, "w" * 72))
        stored = await positions_stored(imei) - before
    record("monitor mode: unsigned and wrongly signed uploads are still stored", stored == 2, f"stored {stored} of 2")


async def check_enforce_mode():
    secret = "e" * 72
    imei = await make_device(2)
    stranger = f"ws-new-{uuid.uuid4().hex[:8]}"
    good = make_token({"number_plate": imei}, secret)
    with TrackerSettings("enforce", {imei: secret}):
        before = await positions_stored(imei)
        missing = await status_of(upsert_as(imei))
        wrong = await status_of(upsert_as(imei, token=make_token({"number_plate": "X"}, "w" * 72)))
        record("enforce: an unsigned tracker upload gets 401", missing == 401, f"status {missing}")
        record("enforce: a wrongly signed upload gets 401", wrong == 401, f"status {wrong}")
        record("enforce: rejected uploads store nothing", await positions_stored(imei) == before)
        accepted = await status_of(upsert_as(imei, token=good))
        record("enforce: a correctly signed upload is stored",
               accepted == 200 and await positions_stored(imei) == before + 1, f"status {accepted}")
        bearer = await status_of(upsert_as(imei, headers={"authorization": f"Bearer {good}"}))
        record("enforce: a Bearer header is accepted too", bearer == 200, f"status {bearer}")
        unknown = await status_of(upsert_as(stranger))
        record("enforce: an unknown tracker is rejected and no device is created",
               unknown == 401 and not await device_exists(stranger), f"status {unknown}")


async def check_enforce_commands_and_alerts():
    secret = "c" * 72
    imei = await make_device(2)
    good = make_token({"number_plate": imei}, secret)
    with TrackerSettings("enforce", {imei: secret}):
        async with AsyncSessionLocal() as db:
            device = (await db.execute(select(Device).where(Device.imei == imei))).scalars().first()
            device.device_metadata = {"pending_command": "SHUTDOWN"}
            await db.commit()
        denied = await status_of(poll_commands(imei))
        record("enforce: an unsigned command poll gets 401 and the lock stays queued",
               denied == 401 and await pending_command(imei) == "SHUTDOWN", f"status {denied}")
        commands = (await poll_commands(imei, good))["data"]["controller_commands"]
        record("enforce: a signed command poll receives the queued lock",
               commands == [{"code": "ENGINE_LOCK"}] and await pending_command(imei) is None, f"commands {commands}")

        violation = {"imei": imei, "violations": [{"type": "GEOFENCE", "data": {}}]}
        before = await alerts_for(imei)
        denied = await status_of(post_violation(violation))
        record("enforce: an unsigned violation report gets 401 and creates no alert",
               denied == 401 and await alerts_for(imei) == before, f"status {denied}")
        accepted = await status_of(post_violation(violation, good))
        record("enforce: a signed violation report is recorded", accepted == 200 and await alerts_for(imei) == before + 1)

        sos = {"imei": imei, "type": "SOS_PANIC", "message": "test"}
        before = await alerts_for(imei)
        denied = await status_of(post_sos(sos))
        record("enforce: an unsigned SOS report gets 401 and creates no alert",
               denied == 401 and await alerts_for(imei) == before, f"status {denied}")
        accepted = await status_of(post_sos(sos, good))
        record("enforce: a signed SOS report is recorded", accepted == 200 and await alerts_for(imei) == before + 1)


def fake_user(tenant_id, role="admin"):
    return User(email=f"x{tenant_id}-{role}@test.local", tenant_id=tenant_id, role=role, is_admin=False, is_active=True)


async def check_platform_gate(acme_token, super_token):
    record("platform gate: tenant 1 admin passes", await status_of(require_super_admin(fake_user(1))) == 200)
    record("platform gate: tenant 1 manager is refused", await status_of(require_super_admin(fake_user(1, "manager"))) == 403)
    record("platform gate: another tenant's admin is refused", await status_of(require_super_admin(fake_user(2))) == 403)
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{PORT}", timeout=30) as client:
        anonymous = await client.get("/api/controller/cleanup-phantoms")
        acme = await client.get("/api/controller/cleanup-phantoms", headers={"Authorization": f"Bearer {acme_token}"})
        platform = await client.get("/api/controller/cleanup-phantoms", headers={"Authorization": f"Bearer {super_token}"})
        repair = await client.get("/admin/repair-production")
    record("cleanup-phantoms: anonymous request gets 401", anonymous.status_code == 401, str(anonymous.status_code))
    record("cleanup-phantoms: another tenant's admin gets 403", acme.status_code == 403, str(acme.status_code))
    record("cleanup-phantoms: platform admin gets 200", platform.status_code == 200, str(platform.status_code))
    record("repair-production: anonymous request gets 401", repair.status_code == 401, str(repair.status_code))


def zone_around(center, d=0.002):
    lat, lng = center
    return {"type": "Polygon", "coordinates": [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]]}


async def device_id_of(imei):
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(Device.id).where(Device.imei == imei))).scalar()


async def draw_zone(user, device_id, center, name):
    async with AsyncSessionLocal() as db:
        created = await create_geofence(zone_data={"name": name, "geoJSON": zone_around(center), "assets": [device_id],
                                                  "alertRules": {"entry": False, "exit": True},
                                                  "notification": {"channel": "system", "contact": ""}},
                                        db=db, current_user=user)
    return created["id"]


async def zone_names_seen(user):
    async with AsyncSessionLocal() as db:
        return {zone["name"] for zone in await get_geofences(db=db, current_user=user)}


async def delete_zone(zone_id, user):
    async with AsyncSessionLocal() as db:
        return await delete_geofence(zone_id=zone_id, db=db, current_user=user)


async def violation_device_ids_seen(user):
    return {alert.device_id for alert in await get_alerts(current_user=user, limit=200, types=None)}


async def trigger_exit(device_id, center):
    lat, lng = center
    await AlertService.evaluate_rules(None, device_id, {"latitude": lat, "longitude": lng, "speed": 0, "raw": {},
                                                        "timestamp": datetime.utcnow() - timedelta(minutes=5)})
    await AlertService.evaluate_rules(None, device_id, {"latitude": lat + 0.01, "longitude": lng + 0.01, "speed": 30,
                                                        "raw": {}, "timestamp": datetime.utcnow()})


async def check_visibility_rules():
    platform, acme, other = fake_user(1), fake_user(2), fake_user(3)
    own = await device_id_of(await make_device(2))
    listed = await device_id_of(await make_device(3, company="Acme"))
    own_center, listed_center = (-17.9, 31.1), (-18.0, 31.2)
    await draw_zone(platform, own, own_center, "Vis own")
    await draw_zone(platform, listed, listed_center, "Vis listed")
    record("zones: the platform admin sees every zone", {"Vis own", "Vis listed"} <= await zone_names_seen(platform))
    record("zones: a company sees a zone on its own tracker", "Vis own" in await zone_names_seen(acme))
    record("zones: a company sees a zone on a tracker listed under its name", "Vis listed" in await zone_names_seen(acme))
    record("zones: another company does not see a zone on someone else's tracker", "Vis own" not in await zone_names_seen(other))
    await trigger_exit(own, own_center)
    await trigger_exit(listed, listed_center)
    record("violations: the platform admin sees every company's violations", {own, listed} <= await violation_device_ids_seen(platform))
    record("violations: a company sees its own tracker's violation", own in await violation_device_ids_seen(acme))
    record("violations: a company sees a violation on a tracker listed under its name", listed in await violation_device_ids_seen(acme))
    record("violations: another company does not see them", own not in await violation_device_ids_seen(other))
    record("zones: a triggered zone leaves every list", not ({"Vis own", "Vis listed"} & await zone_names_seen(platform)))
    company_zone = await draw_zone(acme, own, (-17.7, 31.3), "Vis company")
    platform_zone = await draw_zone(platform, own, (-17.6, 31.4), "Vis platform")
    async with AsyncSessionLocal() as db:
        flags = {zone["name"]: zone["canDelete"] for zone in await get_geofences(db=db, current_user=acme)}
    record("zones: a company's list marks only the zones it drew as deletable",
           flags.get("Vis company") is True and flags.get("Vis platform") is False, str(flags))
    record("zones: a company can delete a zone it drew", await status_of(delete_zone(company_zone, acme)) == 200)
    record("zones: a company cannot delete a zone the platform admin drew", await status_of(delete_zone(platform_zone, acme)) == 404)
    record("zones: the platform admin can delete it", await status_of(delete_zone(platform_zone, platform)) == 200)


async def zone_status(user, device_id):
    async with AsyncSessionLocal() as db:
        return await status_of(create_geofence(zone_data={"name": f"Scope {uuid.uuid4().hex[:6]}", "geoJSON": zone_around((-17.9, 31.1)), "assets": [device_id], "alertRules": {"entry": False, "exit": True}, "notification": {"channel": "system", "contact": ""}}, db=db, current_user=user))


async def check_company_scope():
    tag = uuid.uuid4().hex[:8]
    manager_token, manager = await make_actor(1, "manager")
    platform_token, platform = await make_actor(1, "admin")
    acme_token, acme = await make_actor(2, "admin")
    imeis = [await make_device(1), await make_device(2), await make_device(3, company="Acme"), await make_device(3, company="Other Co")]
    own_imei, acme_owned_imei, acme_listed_imei, other_imei = imeis
    own, acme_owned, acme_listed, other = [await device_id_of(i) for i in imeis]
    scope = {own, acme_owned, acme_listed, other}
    names = {f"Test {i}" for i in imeis}
    await publish_round(imeis)
    async with AsyncSessionLocal() as db:
        db.add_all([AuditLog(user_id=manager.id, tenant_id=1, action=f"SCOPE_T1_{tag}", details={}), AuditLog(user_id=acme.id, tenant_id=2, action=f"SCOPE_T2_{tag}", details={})])
        await db.commit()
    async with AsyncSessionLocal() as db:
        devices_manager = {row["id"] for row in await list_devices(db=db, current_user=manager)} & scope
        devices_platform = {row["id"] for row in await list_devices(db=db, current_user=platform)} & scope
        devices_acme = {row["id"] for row in await list_devices(db=db, current_user=acme)} & scope
        snapshot_manager = {row["device_id"] for row in await get_fleet_snapshot(db=db, current_user=manager)} & scope
        snapshot_platform = {row["device_id"] for row in await get_fleet_snapshot(db=db, current_user=platform)} & scope
        maintenance_manager = {row["device_name"] for row in await get_maintenance_status(db=db, current_user=manager)} & names
        maintenance_acme = {row["device_name"] for row in await get_maintenance_status(db=db, current_user=acme)} & names
        maintenance_platform = {row["device_name"] for row in await get_maintenance_status(db=db, current_user=platform)} & names
        logs_manager = {row["action"] for row in await get_audit_logs(skip=0, limit=1000, current_user=manager, db=db)}
        logs_acme = {row["action"] for row in await get_audit_logs(skip=0, limit=1000, current_user=acme, db=db)}
        logs_platform = {row["action"] for row in await get_audit_logs(skip=0, limit=1000, current_user=platform, db=db)}
        report_other = await status_of(get_device_check(acme_owned, manager, db))
        report_own = await status_of(get_device_check(own, manager, db))
        route_other = await status_of(get_device_route(device_id=acme_owned, db=db, current_user=manager))
        denied_command = await status_of(send_device_command(device_id=acme_owned, payload=CommandPayload(action="lock"), db=db, current_user=manager))
        allowed_command = await status_of(send_device_command(device_id=own, payload=CommandPayload(action="lock"), db=db, current_user=manager))
    zone_other = await zone_status(manager, acme_owned)
    zone_own = await zone_status(manager, own)
    record("devices list: a tenant 1 manager sees only its own company's trackers", devices_manager == {own}, f"saw {sorted(devices_manager)}")
    record("devices list: the platform admin sees every company's trackers", devices_platform == scope, f"saw {sorted(devices_platform)}")
    record("devices list: a company sees its own tracker and one listed under its name", devices_acme == {acme_owned, acme_listed}, f"saw {sorted(devices_acme)}")
    record("map snapshot: a tenant 1 manager sees only its own company's trackers", snapshot_manager == {own}, f"saw {sorted(snapshot_manager)}")
    record("map snapshot: the platform admin sees every tracker", snapshot_platform == scope, f"saw {sorted(snapshot_platform)}")
    record("analytics: a tenant 1 manager sees only its own company's trackers", maintenance_manager == {f"Test {own_imei}"}, f"saw {sorted(maintenance_manager)}")
    record("analytics: a company sees its own tracker and one listed under its name", maintenance_acme == {f"Test {acme_owned_imei}", f"Test {acme_listed_imei}"}, f"saw {sorted(maintenance_acme)}")
    record("analytics: the platform admin sees every tracker", maintenance_platform == names, f"saw {sorted(maintenance_platform)}")
    record("audit log: a tenant 1 manager sees its own company's entries only", f"SCOPE_T1_{tag}" in logs_manager and f"SCOPE_T2_{tag}" not in logs_manager)
    record("audit log: a company sees its own entries only", f"SCOPE_T2_{tag}" in logs_acme and f"SCOPE_T1_{tag}" not in logs_acme)
    record("audit log: the platform admin sees every company's entries", {f"SCOPE_T1_{tag}", f"SCOPE_T2_{tag}"} <= logs_platform)
    record("reports: a tenant 1 manager is refused another company's tracker", report_other == 403, str(report_other))
    record("reports: a tenant 1 manager can open its own tracker", report_own == 200, str(report_own))
    record("route history: a tenant 1 manager is refused another company's tracker", route_other == 403, str(route_other))
    record("commands: a tenant 1 manager cannot lock another company's tracker", denied_command == 403, str(denied_command))
    record("commands: a tenant 1 manager can lock its own tracker", allowed_command == 200, str(allowed_command))
    record("zones: a tenant 1 manager cannot draw a zone on another company's tracker", zone_other == 404, str(zone_other))
    record("zones: a tenant 1 manager can draw a zone on its own tracker", zone_own == 200, str(zone_own))
    await check_viewer("tenant 1 manager's live feed carries only its own company's trackers", manager_token, imeis, {own_imei})
    await check_viewer("platform admin's live feed carries every tracker", platform_token, imeis, set(imeis))
    await check_viewer("company's live feed carries its own tracker and one listed under its name", acme_token, imeis, {acme_owned_imei, acme_listed_imei})


async def run_checks():
    await ensure_database()
    await reset_schema()
    await make_tenants()
    acme_token = await make_user(2)
    other_token = await make_user(3)
    super_token = await make_user(1)
    inactive_token = await make_user(2, active=False)
    tracker_a = await make_device(2)
    tracker_b = await make_device(3, company="Acme")
    tracker_c = await make_device(3, company="Other Co")
    trackers = [tracker_a, tracker_b, tracker_c]

    await check_silent_connection(trackers)
    await check_rejected("bogus token is rejected with 1008", "not-a-token")
    await check_rejected("token of a deactivated user is rejected with 1008", inactive_token)
    await check_viewer("Acme admin sees its tracker and the one listed under company Acme",
                       acme_token, trackers, {tracker_a, tracker_b})
    await check_viewer("Other Co admin sees only its own trackers", other_token, trackers, {tracker_b, tracker_c})
    await check_viewer("platform admin sees every tracker", super_token, trackers, set(trackers))
    app.state.db_ready = True
    await check_tracker_signatures()
    await check_monitor_mode()
    await check_enforce_mode()
    await check_enforce_commands_and_alerts()
    await check_platform_gate(acme_token, super_token)
    await check_visibility_rules()
    await check_company_scope()


async def main():
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, lifespan="off", log_level="warning")
    server = uvicorn.Server(config)
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.1)
    try:
        await run_checks()
    finally:
        server.should_exit = True
        await serving
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
    print("ALL AUTH CHECKS PASSED" if not failures else f"{len(failures)} AUTH CHECKS FAILED")
    sys.exit(1 if failures else 0)
