from fastapi import WebSocket
import json
import asyncio

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        # iterate over copy to avoid modification during iteration issues
        for connection in self.active_connections[:]:
            try:
                await connection.send_text(message)
            except Exception:
                self.disconnect(connection)

manager = ConnectionManager()

async def ws_listener(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Just keep the connection open and wait for disconnect
            # We don't expect client messages for now, but we await receive to keep socket alive
            await websocket.receive_text()
    except Exception:
        manager.disconnect(websocket)

async def publish_position(position_dict):
    await manager.broadcast(json.dumps(position_dict))

