import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.routers import auth, devices, positions
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
frontend_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.exists(frontend_path):
    app.mount("/static", StaticFiles(directory=frontend_path, html=True), name="static")

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
                await db.execute(text("ALTER TABLE devices ADD COLUMN IF NOT EXISTS driver_name VARCHAR DEFAULT NULL"))
                await db.commit()
                print("Schema migration: Columns checked/added.")
            except Exception as e:
                print(f"Schema migration skipped or failed: {e}")
                await db.rollback()

            # 1. Ensure Tenant exists
            res = await db.execute(select(Tenant).where(Tenant.id == 1))
            tenant = res.scalars().first()
            if not tenant:
                tenant = Tenant(id=1, name="Default Organization")
                db.add(tenant)
                await db.commit()
            
            # 2. Ensure User exists or Update Password
            res = await db.execute(select(User).where(User.email == "adriankwaramba@gmail.com"))
            user = res.scalars().first()
            
            new_hash = hash_password("Kingcarter@1")
            
            if not user:
                print("Creating admin user...")
                user = User(
                    email="adriankwaramba@gmail.com", 
                    hashed_password=new_hash, 
                    is_active=True, 
                    is_admin=True, 
                    role="admin",
                    tenant_id=1
                )
                db.add(user)
            else:
                print("Updating admin user password & role...")
                user.hashed_password = new_hash
                user.is_active = True
                user.is_admin = True
                user.role = "admin"
            
            await db.commit()
            # 3. Create/Update Test Users from User Request
            test_users = [
                {"email": "adriantakudzwa7337@gmail.com", "role": "manager", "name": "Test Manager"},
                {"email": "adriantakudzwa3773@gmail.com", "role": "viewer", "name": "Test Viewer"}
            ]

            for t_user in test_users:
                res = await db.execute(select(User).where(User.email == t_user["email"]))
                existing = res.scalars().first()
                if not existing:
                    print(f"Creating {t_user['role']} user: {t_user['email']}")
                    new_user = User(
                        email=t_user["email"],
                        hashed_password=new_hash, # Same default password
                        is_active=True,
                        is_admin=False,
                        role=t_user["role"],
                        tenant_id=1
                    )
                    db.add(new_user)
                else:
                    print(f"Updating {t_user['role']} user role...")
                    existing.role = t_user["role"]
                    existing.hashed_password = new_hash
            
            await db.commit()
            print("Admin user and test accounts initialized successfully")
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
