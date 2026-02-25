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

# Global HTTP Client for efficient reuse
http_client = httpx.AsyncClient(timeout=5.0)

# Queues for background processing
primary_queue = asyncio.Queue(maxsize=1000)
secondary_queues = [] # List of tuples (Queue, ProxyClient)

async def primary_worker():
    """Background worker to forward data to the primary backend."""
    url = f"{PRIMARY_DESTINATION}/positions/ingest"
    logger.info(f"Primary worker started for {url}")
    while True:
        data, source_ip = await primary_queue.get()
        try:
            payload = {"raw_hex": data.hex(), "source_ip": source_ip}
            resp = await http_client.post(url, json=payload)
            if resp.status_code != 200:
                logger.warning(f"Primary Ingest Failed: {resp.status_code}")
        except Exception as e:
            logger.error(f"Error in primary worker: {e}")
        finally:
            primary_queue.task_done()

async def secondary_worker(queue, client):
    """Background worker for legacy TCP forwarding."""
    logger.info(f"Secondary worker started for {client.host}:{client.port}")
    while True:
        data = await queue.get()
        try:
            await client.send(data)
        except Exception as e:
            logger.error(f"Error in secondary worker ({client.host}): {e}")
        finally:
            queue.task_done()

async def handle_tracker(reader, writer):
    """Handles incoming connection from a GPS Tracker - TRUE FIRE AND FORGET."""
    addr = writer.get_extra_info('peername')
    source_ip = addr[0]
    logger.info(f"New Connection: {addr}")

    try:
        while True:
            data = await reader.read(4096)
            if not data:
                break 
            
            # Fire and Forget: Put in queues and immediately continue listening
            if not primary_queue.full():
                primary_queue.put_nowait((data, source_ip))
            
            for q, _ in secondary_queues:
                if not q.full():
                    q.put_nowait(data)

    except Exception as e:
        logger.error(f"Error handling {addr}: {e}")
    finally:
        logger.info(f"Closed {addr}")
        writer.close()

async def health_server(reader, writer):
    """Minimal HTTP health endpoint so Railway considers the service healthy."""
    try:
        await reader.read(1024)
        response = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nOK"
        writer.write(response)
        await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()

async def keep_alive_ping():
    """Pings the health endpoint every 4 minutes."""
    health_url = os.getenv('HEALTH_PING_URL', 'http://localhost:8080/health')
    while True:
        await asyncio.sleep(240)
        try:
            await http_client.get(health_url)
            logger.info("Keep-alive ping sent")
        except Exception as e:
            logger.warning(f"Keep-alive ping failed: {e}")

async def main():
    # Initialize Secondary Clients and Workers
    for t_host, t_port in TARGETS:
        client = ProxyClient(t_host, t_port)
        await client.connect()
        q = asyncio.Queue(maxsize=1000)
        secondary_queues.append((q, client))
        asyncio.create_task(secondary_worker(q, client))

    # Start Primary Worker
    asyncio.create_task(primary_worker())

    # Start Servers
    tcp_server = await asyncio.start_server(handle_tracker, LISTEN_HOST, LISTEN_PORT)
    http_port = int(os.getenv('HEALTH_PORT', 8080))
    http_server = await asyncio.start_server(health_server, '0.0.0.0', http_port)
    
    logger.info(f"Gateway Up | TCP: {LISTEN_PORT} | Health: {http_port}")
    asyncio.create_task(keep_alive_ping())

    async with tcp_server, http_server:
        await asyncio.gather(tcp_server.serve_forever(), http_server.serve_forever())

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    finally:
        asyncio.run(http_client.aclose())

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
