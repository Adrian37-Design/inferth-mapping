"""
Authentication checks for the live WebSocket feed and the tracker controller endpoints.

Run: TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/inferth_auth_test python verify_auth.py

The database must be on localhost and its name must end in _test. The checks drop and
recreate every table in it, so the URL is validated before anything is imported or connected.
"""
import asyncio
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
import uvicorn
import websockets
from sqlalchemy import select

from app.db import AsyncSessionLocal, Base, DATABASE_URL, engine
import app.models
from app.models import Device, Tenant, User
from app.main import app
from app.security import create_access_token
from app.routers.controller import upsert_tracking_data

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
