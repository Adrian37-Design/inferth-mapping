import asyncio
import os
import logging
import httpx # Changed from none to httpx
from dotenv import load_dotenv

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [GATEWAY] - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load Environment
load_dotenv()

# Configuration
LISTEN_HOST = '0.0.0.0'
LISTEN_PORT = int(os.getenv('GATEWAY_PORT', 9000))
PRIMARY_DESTINATION = os.getenv('PRIMARY_DESTINATION', 'http://localhost:8000') # Defaults to local
SECONDARY_DESTINATION = os.getenv('SECONDARY_DESTINATION')

# TCP Targets (Secondary)
TARGETS = []
if SECONDARY_DESTINATION:
    try:
        parts = SECONDARY_DESTINATION.split(':')
        host = parts[0]
        port = int(parts[1])
        TARGETS.append((host, port))
        logger.info(f"Secondary Target Configured: {host}:{port}")
    except Exception as e:
        logger.error(f"Invalid SECONDARY_DESTINATION format: {SECONDARY_DESTINATION}. Use HOST:PORT")

class ProxyClient:
    """Manages the connection to a single TCP target destination."""
    def __init__(self, target_host, target_port):
        self.host = target_host
        self.port = target_port
        self.writer = None

    async def connect(self):
        try:
            _, self.writer = await asyncio.open_connection(self.host, self.port)
            return True
        except Exception as e:
            logger.error(f"Failed to connect to target {self.host}:{self.port} - {e}")
            return False

    async def send(self, data):
        if not self.writer:
            if not await self.connect():
                return
        try:
            self.writer.write(data)
            await self.writer.drain()
        except:
            # Simple retry logic
            self.writer = None
            if await self.connect():
               try:
                   self.writer.write(data)
                   await self.writer.drain()
               except:
                   pass

    async def close(self):
        if self.writer:
            try:
                self.writer.close()
                await self.writer.wait_closed()
            except:
                pass

async def forward_to_primary(data: bytes, source_ip: str):
    """Forwards data to the Primary Backend (HTTP API)"""
    url = f"{PRIMARY_DESTINATION}/positions/ingest"
    payload = {
        "raw_hex": data.hex(),
        "source_ip": source_ip
    }
    
    async with httpx.AsyncClient() as client:
        try:
            # We fire and forget mostly, but logging errors is good
            resp = await client.post(url, json=payload, timeout=5.0)
            if resp.status_code != 200:
                logger.warning(f"Primary Ingest Failed: {resp.status_code} - {resp.text}")
        except Exception as e:
            logger.error(f"Error forwarding to Primary ({url}): {e}")

async def handle_tracker(reader, writer):
    """Handles incoming connection from a GPS Tracker."""
    addr = writer.get_extra_info('peername')
    source_ip = addr[0]
    logger.info(f"New Connection: {addr}")

    # Initialize Upstream TCP Clients
    upstream_clients = []
    for t_host, t_port in TARGETS:
        client = ProxyClient(t_host, t_port)
        await client.connect()
        upstream_clients.append(client)

    try:
        while True:
            data = await reader.read(4096)
            if not data:
                break 

            logger.info(f"Recv {len(data)}B from {source_ip} | {data.hex()[:20]}...")

            # 1. Forward to Primary (Inferth Mapping API)
            asyncio.create_task(forward_to_primary(data, source_ip))

            # 2. Forward to Secondary (Legacy TCP)
            for client in upstream_clients:
                asyncio.create_task(client.send(data))

    except Exception as e:
        logger.error(f"Error handling {addr}: {e}")
    finally:
        logger.info(f"Closed {addr}")
        writer.close()
        for client in upstream_clients:
            await client.close()

async def main():
    server = await asyncio.start_server(
        handle_tracker, LISTEN_HOST, LISTEN_PORT
    )
    logger.info(f"Universal Gateway Listening on {LISTEN_HOST}:{LISTEN_PORT}")
    logger.info(f"Primary Destination: {PRIMARY_DESTINATION}")

    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
