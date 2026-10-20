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
from datetime import datetime
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
from app.models import Alert, Device, Position, Tenant, User
from app.main import app
from app.security import create_access_token
from app.auth_middleware import require_super_admin
from app.routers.controller import _tracker_signed, get_commands, handle_sos_alerts, handle_violations, upsert_tracking_data

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


async def make_user(tenant_id, active=True):
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    async with AsyncSessionLocal() as db:
        user = User(email=email, role="admin", is_active=active, tenant_id=tenant_id)
        db.add(user)
        await db.commit()
        return create_access_token({"sub": email, "user_id": user.id})


async def make_device(tenant_id, company=None):
    imei = f"ws-{uuid.uuid4().hex[:10]}"
    async with AsyncSessionLocal() as db:
        db.add(Device(imei=imei, name=f"Test {imei[-4:]}", tenant_id=tenant_id, company=company, device_metadata={}))
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
