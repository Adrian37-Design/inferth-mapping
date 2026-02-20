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

@app.on_event("startup")
async def startup_event():
    # Initialize Branding (Logos)
    try:
        await init_branding()
    except Exception as e:
        print(f"Branding Init Failed: {e}")

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

from app.db import engine, Base

@app.on_event("startup")
async def startup_event():
    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Initialize/Reset Admin User (Auto-fix for Invalid Credentials)
    from app.db import AsyncSessionLocal
    from app.models import User, Tenant
    from app.security import hash_password
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
    
# === ONE-TIME FIX: Reassign Console Telematics from ID #4 → #2 ===
# Remove this endpoint after running it once on production
from app.db import AsyncSessionLocal
from sqlalchemy import text as sql_text

@app.get("/admin/fix-tenant-ids")
async def fix_tenant_ids(secret: str = ""):
    if secret != "inferth-fix-2024":
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Forbidden")
    async with AsyncSessionLocal() as db:
        try:
            # Check current state
            rows = await db.execute(sql_text("SELECT id, name FROM tenants ORDER BY id"))
            before = [dict(r) for r in rows.mappings()]

            # Update users pointing to old id
            await db.execute(sql_text("UPDATE users SET tenant_id = 2 WHERE tenant_id = 4"))
            # Rename Console Telematics id
            await db.execute(sql_text("UPDATE tenants SET id = 2 WHERE id = 4"))
            # Reset sequence
            await db.execute(sql_text("SELECT setval('tenants_id_seq', 2, true)"))
            await db.commit()

            rows = await db.execute(sql_text("SELECT id, name FROM tenants ORDER BY id"))
            after = [dict(r) for r in rows.mappings()]
            return {"status": "done", "before": before, "after": after}
        except Exception as e:
            await db.rollback()
            return {"status": "error", "detail": str(e)}
# === END ONE-TIME FIX ===

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)

