from fastapi import WebSocket
import aioredis
from app.config import settings
import asyncio
import json

redis = None

async def get_redis():
    global redis
    if not redis:
        redis = await aioredis.from_url(settings.REDIS_URL)
    return redis

async def publish_position(position_dict):
    r = await get_redis()
    await r.publish("positions", json.dumps(position_dict))

async def ws_listener(websocket: WebSocket):
    await websocket.accept()
    r = await get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe("positions")
    try:
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message:
                await websocket.send_text(message['data'].decode())
            await asyncio.sleep(0.01)
    finally:
        await pubsub.unsubscribe("positions")
        await websocket.close()
