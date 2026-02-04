import asyncio
import os
import logging
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

# Targets to forward to (Host, Port)
# You can add as many as you want here.
# Example: [('localhost', 8000), ('legacy-platform.com', 5000)]
TARGETS = []

# Parse Secondary Target from Env
sec_dest = os.getenv('SECONDARY_DESTINATION')
if sec_dest:
    try:
        parts = sec_dest.split(':')
        host = parts[0]
        port = int(parts[1])
        TARGETS.append((host, port))
        logger.info(f"Target Configured: {host}:{port}")
    except Exception as e:
        logger.error(f"Invalid SECONDARY_DESTINATION format: {sec_dest}. Use HOST:PORT")

class ProxyClient:
    """Manages the connection to a single target destination."""
    def __init__(self, target_host, target_port):
        self.host = target_host
        self.port = target_port
        self.reader = None
        self.writer = None

    async def connect(self):
        try:
            self.reader, self.writer = await asyncio.open_connection(self.host, self.port)
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
        except Exception as e:
            logger.error(f"Error sending to {self.host}:{self.port} - {e}")
            # Try reconnecting once
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

async def handle_tracker(reader, writer):
    """Handles incoming connection from a GPS Tracker."""
    addr = writer.get_extra_info('peername')
    logger.info(f"New Connection from Tracker: {addr}")

    # Initialize connections to upstream targets
    upstream_clients = []
    for t_host, t_port in TARGETS:
        client = ProxyClient(t_host, t_port)
        await client.connect()
        upstream_clients.append(client)

    try:
        while True:
            # Read Raw Data
            data = await reader.read(4096) # Standard buffer size
            if not data:
                break # Connection closed

            logger.info(f"Received {len(data)} bytes from {addr} | Hex: {data.hex()}")

            # 1. Forward to Internal Parser (Placeholder Logic)
            # In a real deployment, we might push to Redis or call a function directly.
            # For now, we assume the internal platform picks it up via the Secondary target 
            # OR we process it here if this script merges with the parser.

            # 2. Forward to Upstream Targets (The "Duplicate" Step)
            for client in upstream_clients:
                asyncio.create_task(client.send(data))

            # 3. Handle Response (Optional)
            # Some protocols require an ACK. 
            # If the Primary Target sends an ACK, we should forward it back to the device.
            # This is complex in a raw proxy. Simplest approach for "Universal" listening:
            # We don't interfere. We let the device send.
            
            # FUTURE TODO: Implement specific ACK logic per protocol if devices stop sending
            # because they didn't get a reply.

    except ConnectionResetError:
        logger.warning(f"Connection reset by tracker {addr}")
    except Exception as e:
        logger.error(f"Error handling tracker {addr}: {e}")
    finally:
        logger.info(f"Closing connection from {addr}")
        writer.close()
        for client in upstream_clients:
            await client.close()

async def main():
    server = await asyncio.start_server(
        handle_tracker, LISTEN_HOST, LISTEN_PORT
    )

    addr = server.sockets[0].getsockname()
    logger.info(f"Universal Gateway Listening on {addr}")

    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Gateway stopped by user.")
