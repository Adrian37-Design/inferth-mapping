import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.routers import auth, devices, positions, users, audit
from app.services.mqtt_client import start_mqtt
import asyncio
from app.config import settings
from app.services.tcp_server import TCPTrackerProtocol
from app.realtime import ws_listener
import os

app = FastAPI(title="Inferth Mapping")

from fastapi import Request
from fastapi.responses import JSONResponse

@app.exception_handler(Exception)
async def debug_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal Server Error: {str(exc)}", "type": type(exc).__name__}
    )

# Mount static files (frontend)
# Resolve project root from backend/app/main.py
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
frontend_path = os.path.join(project_root, "frontend")

if os.path.exists(frontend_path):
    app.mount("/static", StaticFiles(directory=frontend_path, html=True), name="static")
    print(f"Mounted static files from: {frontend_path}")
else:
    print(f"Warning: Frontend not found at {frontend_path}")

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

from app.db import engine, Base

@app.on_event("startup")
async def startup_event():
    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Initialize/Reset Admin User (Auto-fix for Invalid Credentials)
    from app.db import AsyncSessionLocal
    from app.models import User, Tenant
    from app.utils import hash_password
    from sqlalchemy.future import select
    from sqlalchemy import text
    
    async with AsyncSessionLocal() as db:
        try:
            # 0. Auto-Migration: Ensure 'role' and 'driver_name' columns exist
            try:
                await db.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR DEFAULT 'admin'"))
                await db.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE DEFAULT NULL"))
                await db.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS accessible_assets JSON DEFAULT '[\"*\"]'"))
                await db.execute(text("ALTER TABLE devices ADD COLUMN IF NOT EXISTS driver_name VARCHAR DEFAULT NULL"))
                
                # Tenant Branding Migration
                await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url VARCHAR DEFAULT NULL"))
                await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS primary_color VARCHAR DEFAULT '#2D5F6D'"))
                await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS secondary_color VARCHAR DEFAULT '#EF4835'"))
                
                await db.commit()
                print("Schema migration: Columns checked/added.")
            except Exception as e:
                print(f"Schema migration skipped or failed: {e}")
                await db.rollback()

            # 1. Ensure Tenant 1 (Inferth Mapping) exists
            res = await db.execute(select(Tenant).where(Tenant.name == "Inferth Mapping"))
            tenant = res.scalars().first()
            if not tenant:
                tenant = Tenant(name="Inferth Mapping")
                db.add(tenant)
                await db.commit()
            # 3. Ensure Admin User exists ONLY if no users exist at all (First Run)
            # This prevents "Ghost Admin" from reappearing after deletion
            res = await db.execute(select(User))
            any_user = res.scalars().first()
            
            if not any_user:
                print("First run detected: Creating initial admin user...")
                # Get ID of Inferth Mapping
                res = await db.execute(select(Tenant).where(Tenant.name == "Inferth Mapping"))
                inferth = res.scalars().first()
                
                admin = User(
                    email="admin@inferth.com",
                    hashed_password=hash_password("admin123"),
                    is_active=True,
                    is_admin=True,
                    role="admin",
                    tenant_id=inferth.id if inferth else 1
                )
                db.add(admin)
                await db.commit()
                print("Initial admin user created: admin@inferth.com")
            else:
                print("Users already exist. Skipping initial admin creation.")
        except Exception as e:
            print(f"Error initializing users: {e}")
    
    # start MQTT client (optional - for device tracking)
    try:
        start_mqtt()
        print("MQTT client started successfully")
    except Exception as e:
        print(f"Warning: MQTT client not available: {e}")
    
    # start TCP server for tracker devices (optional)
    try:
        loop = asyncio.get_running_loop()
        server = await loop.create_server(lambda: TCPTrackerProtocol(app), host=settings.TCP_LISTEN_ADDR, port=settings.TCP_PORT)
        print(f"TCP server listening on {settings.TCP_LISTEN_ADDR}:{settings.TCP_PORT}")
    except Exception as e:
        print(f"Warning: TCP server not available: {e}")
    
@app.websocket("/ws/positions")
async def ws_positions(websocket: WebSocket):
    await ws_listener(websocket)

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
