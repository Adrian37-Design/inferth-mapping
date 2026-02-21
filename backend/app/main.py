import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.routers import auth, devices, positions, users, audit
from app.services.mqtt_client import start_mqtt
import asyncio
from app.config import settings
from app.services.tcp_server import TCPTrackerProtocol
from app.services.tcp_server import TCPTrackerProtocol
from app.realtime import ws_listener
from app.branding import init_branding
import os

app = FastAPI(title="Inferth Mapping")
# Production Stability: db_ready flag tracks successful background initialization
app.state.db_ready = False

async def run_migrations_and_branding():
    print("\n" + "="*50)
    print("BACKGROUND INITIALIZATION STARTED")
    print("="*50)

    from app.db import engine, Base, AsyncSessionLocal
    from app.models import Tenant
    from sqlalchemy.future import select
    from sqlalchemy import text
    import time

    connection_ready = False
    max_retries = 10
    retry_delay = 5 # seconds

    for attempt in range(1, max_retries + 1):
        try:
            print(f"Connecting to Database (Attempt {attempt}/{max_retries})...")
            # Set a timeout for the actual connection attempt
            async with asyncio.timeout(30):
                async with engine.begin() as conn:
                    await conn.run_sync(Base.metadata.create_all)
            print("SUCCESS: Database connected and tables verified.")
            connection_ready = True
            break
        except Exception as e:
            print(f"FAILED: Database attempt {attempt} failed: {e}")
            if attempt < max_retries:
                print(f"Retrying in {retry_delay}s...")
                await asyncio.sleep(retry_delay)
            else:
                print("CRITICAL ERROR: Database unreachable after maximum retries.")

    if connection_ready:
        async with AsyncSessionLocal() as db:
            try:
                print("Checking schema integrity & performing auto-migrations...")
                # Run these sequentially and commit each to avoid lock issues
                migration_statements = [
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR DEFAULT 'admin'",
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE DEFAULT NULL",
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS accessible_assets JSON DEFAULT '[\"*\"]'",
                    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS driver_name VARCHAR DEFAULT NULL",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url VARCHAR DEFAULT NULL",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS primary_color VARCHAR DEFAULT '#2D5F6D'",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS secondary_color VARCHAR DEFAULT '#EF4835'"
                ]
                
                for stmt in migration_statements:
                    try:
                        await db.execute(text(stmt))
                        await db.commit()
                    except Exception as inner_e:
                        print(f"Skipping migration step: {inner_e}")
                        await db.rollback()
                
                print("Schema migrations complete.")

                # Initialize Branding
                try:
                    await init_branding()
                    print("Branding initialization complete.")
                except Exception as e:
                    print(f"Branding Init Warning: {e}")

                # 3. Ensure Default Tenant & First Admin
                from app.models import User
                from app.security import hash_password
                
                res = await db.execute(select(Tenant).where(Tenant.name == "Inferth Mapping"))
                tenant = res.scalars().first()
                if not tenant:
                    print("Seeding 'Inferth Mapping' tenant...")
                    tenant = Tenant(name="Inferth Mapping")
                    db.add(tenant)
                    await db.commit()
                    await db.refresh(tenant)

                # Check if any users exist
                user_res = await db.execute(select(User))
                if not user_res.scalars().first():
                    print("No users found. Seeding first administrator...")
                    admin_pwd = os.getenv("ADMIN_PASSWORD", "changeme")
                    new_admin = User(
                        email="adriankwaramba@gmail.com",
                        hashed_password=hash_password(admin_pwd),
                        role="admin",
                        is_admin=True,
                        is_active=True,
                        tenant_id=tenant.id
                    )
                    db.add(new_admin)
                    await db.commit()
                    print(f"SUCCESS: Created admin adriankwaramba@gmail.com (Tenant: {tenant.name})")

                # SET READY ONLY NOW
                app.state.db_ready = True
            except Exception as e:
                print(f"Initialization task error: {e}")
                # Even if some seed fails, if we got this far, the core is likely ready
                app.state.db_ready = True

    print("="*50)
    print("BACKGROUND INITIALIZATION FINISHED")
    print("="*50 + "\n")

@app.on_event("startup")
async def startup_event():
    # 1. Start Heavy Logic in Background to avoid 502 Gateway Timeouts during boot
    asyncio.create_task(run_migrations_and_branding())

    # 2. Start Immediate Services
    print("Starting background services...")
    
    # MQTT Client
    try:
        start_mqtt()
        print("MQTT client started successfully")
    except Exception as e:
        print(f"Warning: MQTT client not available: {e}")
    
    # TCP Tracker Server
    try:
        loop = asyncio.get_running_loop()
        server = await loop.create_server(lambda: TCPTrackerProtocol(app), host=settings.TCP_LISTEN_ADDR, port=settings.TCP_PORT)
        print(f"TCP server listening on {settings.TCP_LISTEN_ADDR}:{settings.TCP_PORT}")
    except Exception as e:
        print(f"Warning: TCP server not available: {e}")

from fastapi import Request
from fastapi.responses import JSONResponse

@app.exception_handler(Exception)
async def debug_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal Server Error: {str(exc)}", "type": type(exc).__name__}
    )

# Mount static files (frontend)
current_dir = os.path.dirname(os.path.abspath(__file__))

# Potential paths for frontend directory
possible_paths = [
    # Local: backend/app/main.py -> backend/app -> backend -> Root -> frontend
    os.path.join(os.path.dirname(os.path.dirname(current_dir)), "frontend"),
    # Docker: /app/app/main.py -> /app/app -> /app -> frontend
    os.path.join(os.path.dirname(current_dir), "frontend"),
    # Docker Absolute Fallback
    "/app/frontend",
    # Relative Fallback
    "frontend"
]

frontend_path = None
for path in possible_paths:
    if os.path.exists(path) and os.path.isdir(path):
        frontend_path = path
        break

if frontend_path:
    app.mount("/static", StaticFiles(directory=frontend_path, html=True), name="static")
    print(f"Mounted static files from: {frontend_path}")
else:
    print(f"Warning: Frontend not found. Checked: {possible_paths}")

from fastapi.responses import RedirectResponse

@app.get("/")
async def root():
    return RedirectResponse(url="/static/login.html")

# Add CORS middleware for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add explicit CORS headers middleware
@app.middleware("http")
async def add_cors_headers(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    response.headers["Access-Control-Allow-Methods"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(positions.router)
app.include_router(users.router)
app.include_router(audit.router)
    
if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
