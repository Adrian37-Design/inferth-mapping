from fastapi import WebSocket
from jose import jwt
from sqlalchemy import select
from sqlalchemy.orm import joinedload
import json
import asyncio
from app.config import settings
from app.db import AsyncSessionLocal
from app.models import User
from app.auth_middleware import is_platform_admin

WS_AUTH_TIMEOUT_SECONDS = 10

class Viewer:
    def __init__(self, user, tenant_name):
        self.tenant_id = user.tenant_id
        self.tenant_name = (tenant_name or "").strip().lower()
        self.is_super = is_platform_admin(user)

    def can_see(self, position: dict) -> bool:
        if self.is_super:
            return True
        if position.get("tenant_id") is None:
            return False
        return position["tenant_id"] == self.tenant_id or (
            bool(self.tenant_name) and str(position.get("company") or "").lower() == self.tenant_name
        )

class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[WebSocket, Viewer] = {}

    def connect(self, websocket: WebSocket, viewer: Viewer):
        self.active_connections[websocket] = viewer

    def disconnect(self, websocket: WebSocket):
        self.active_connections.pop(websocket, None)

    async def broadcast(self, position: dict):
        message = json.dumps({k: v for k, v in position.items() if k not in ("tenant_id", "company")})
        # iterate over copy to avoid modification during iteration issues
        for connection, viewer in list(self.active_connections.items()):
            if not viewer.can_see(position):
                continue
            try:
                await connection.send_text(message)
            except Exception:
                self.disconnect(connection)

manager = ConnectionManager()

async def authenticate(websocket: WebSocket):
    try:
        message = await asyncio.wait_for(websocket.receive_json(), timeout=WS_AUTH_TIMEOUT_SECONDS)
        if message.get("type") != "auth":
            return None
        payload = jwt.decode(message["token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(User).options(joinedload(User.tenant)).where(User.id == payload["user_id"]))
            user = result.scalars().first()
    except Exception:
        return None
    if user is None or not user.is_active:
        return None
    return Viewer(user, user.tenant.name if user.tenant else None)

async def ws_listener(websocket: WebSocket):
    await websocket.accept()
    viewer = await authenticate(websocket)
    if viewer is None:
        await websocket.close(code=1008)
        return
    manager.connect(websocket, viewer)
    try:
        await websocket.send_json({"type": "auth_ok"})
        while True:
            # Use receive() (not receive_text()) so binary browser ping frames
            # don't raise an exception and close the connection.
            await websocket.receive()
    except Exception:
        manager.disconnect(websocket)

async def publish_position(position_dict: dict):
    await manager.broadcast(position_dict)
