"""
Inferth Mapping — Dedicated Standalone TCP Ingestion Worker
Addresses Risk 4 (Decoupling Tracker Ingestion from Web API).

Run as an independent Railway service or background process:
    python run_tcp_server.py

Keeps thousands of persistent GPS tracker sockets alive without
being disrupted by web traffic, PDF exports, or web worker restarts.
"""

import asyncio
import os
import signal
import sys

# Ensure backend package is in python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.config import settings
from app.services.tcp_server import TCPTrackerProtocol
from app.database import engine, Base


async def run_standalone_tcp():
    print("=" * 60)
    print("  Inferth Mapping — Dedicated TCP Telematics Ingestion Server")
    print(f"  Listening on: 0.0.0.0:{settings.TCP_PORT}")
    print("  Protocols: GT06, Sinotrack, Teltonika AVL, H02, GPS103")
    print("=" * 60)

    # Initialize tables if necessary
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    loop = asyncio.get_running_loop()
    server = None
    max_retries = 5
    retry_count = 0

    while retry_count < max_retries:
        try:
            server = await loop.create_server(
                lambda: TCPTrackerProtocol(),
                '0.0.0.0',
                settings.TCP_PORT
            )
            print(f"[TCP Server Worker] Bound and listening successfully on port {settings.TCP_PORT}")
            break
        except Exception as e:
            retry_count += 1
            print(f"[TCP Server Worker] Bind failed ({retry_count}/{max_retries}): {e}")
            if retry_count < max_retries:
                await asyncio.sleep(2)
            else:
                print("[TCP Server Worker] CRITICAL: Failed to bind TCP port after max retries.")
                sys.exit(1)

    # Graceful shutdown handler
    stop_event = asyncio.Event()

    def handle_exit():
        print("\n[TCP Server Worker] Shutdown signal received. Closing tracker sockets...")
        if server:
            server.close()
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_exit)
        except NotImplementedError:
            pass

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(run_standalone_tcp())
    except (KeyboardInterrupt, SystemExit):
        print("[TCP Server Worker] Stopped.")
