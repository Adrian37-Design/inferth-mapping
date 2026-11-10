import uvicorn
from sqlalchemy import select
from fastapi import FastAPI, WebSocket, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from app.routers import auth, devices, positions, users, audit, geofences, payments, admin, rules, alerts, reports, analytics, controller, tracker_secrets, insights
from app.services.mqtt_client import start_mqtt
import asyncio
from app.config import settings
from app.services.tcp_server import TCPTrackerProtocol
from app.realtime import ws_listener
from app.auth_middleware import require_super_admin
from app.models import User
from app.branding import init_branding
import os

_IS_PROD = (settings.APP_ENV or "").strip().lower() in ("production", "prod")
_docs_off = _IS_PROD and not settings.ENABLE_API_DOCS
app = FastAPI(
    title="Inferth Mapping",
    docs_url=None if _docs_off else "/docs",
    redoc_url=None if _docs_off else "/redoc",
    openapi_url=None if _docs_off else "/openapi.json",
)
# Production Stability: db_ready flag tracks successful background initialization
app.state.db_ready = False

if _IS_PROD:
    if settings.JWT_SECRET in ("change_this_secret_key_in_production", "", None):
        raise RuntimeError("JWT_SECRET must be set to a strong secret in production")
    if not os.getenv("ADMIN_PASSWORD"):
        print("WARNING: ADMIN_PASSWORD not set — a seeded admin would use the default password")

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
    attempt = 0
    retry_delay = 5  # seconds

    # Retry FOREVER: if Postgres restarts/recovers after the app boots
    # (Railway dependency ordering is not guaranteed, and Postgres may go
    # down for crash recovery for minutes), the app must eventually become
    # ready — a finite retry budget leaves db_ready=False permanently,
    # which blocks login with "Database is initializing" until a redeploy.
    while not connection_ready:
        attempt += 1
        try:
            print(f"Connecting to Database (Attempt {attempt})...")
            # Python 3.10 compatibility: use wait_for instead of timeout context manager
            async def do_db_init():
                async with engine.begin() as conn:
                    await conn.run_sync(Base.metadata.create_all)
            await asyncio.wait_for(do_db_init(), timeout=30)
            print("SUCCESS: Database connected and tables verified.")
            connection_ready = True
            # Set ready immediately after connection/tables are verified
            # This allows login attempts to start while migrations/branding happen in background
            app.state.db_ready = True 
        except Exception as e:
            print(f"FAILED: Database attempt {attempt} failed: {e}")
            print(f"Retrying in {retry_delay}s...")
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 1.5, 60)  # Cap backoff at 60s

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
                    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS company VARCHAR DEFAULT NULL",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url VARCHAR DEFAULT NULL",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS primary_color VARCHAR DEFAULT '#2D5F6D'",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS secondary_color VARCHAR DEFAULT '#EF4835'",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS navbar_bg VARCHAR DEFAULT NULL",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS navbar_text_color VARCHAR DEFAULT NULL",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan VARCHAR DEFAULT 'Basic'",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status VARCHAR DEFAULT 'active'",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR DEFAULT 'Monthly'",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMP WITH TIME ZONE DEFAULT NULL",
                    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS features JSON DEFAULT '{\"reports\": false, \"advanced_rules\": false, \"geofencing\": true}'",
                    "CREATE TABLE IF NOT EXISTS geofences (id SERIAL PRIMARY KEY, name VARCHAR NOT NULL, color VARCHAR, assets JSON, alert_rules JSON, notification JSON, geojson JSON, tenant_id INTEGER REFERENCES tenants(id), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)",
                    "ALTER TABLE geofences ADD COLUMN IF NOT EXISTS triggered_at TIMESTAMP WITH TIME ZONE DEFAULT NULL",
                    "CREATE TABLE IF NOT EXISTS rules (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id), device_id INTEGER REFERENCES devices(id), event_type VARCHAR, threshold FLOAT, channel VARCHAR DEFAULT 'system', contact VARCHAR, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)",
                    "CREATE TABLE IF NOT EXISTS alerts (id SERIAL PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id), device_id INTEGER REFERENCES devices(id), rule_id INTEGER REFERENCES rules(id), type VARCHAR, message VARCHAR, timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, is_read BOOLEAN DEFAULT FALSE)",
                    # Performance indexes — positions table grows unbounded (one row
                    # per tracker packet, every 10-30s). Without these, /snapshot,
                    # /analytics and /routes do full table scans and time out (503/504).
                    "CREATE INDEX IF NOT EXISTS idx_positions_device_ts ON positions(device_id, timestamp DESC)",
                    "CREATE INDEX IF NOT EXISTS idx_positions_ts ON positions(timestamp)",
                    "CREATE INDEX IF NOT EXISTS idx_alerts_tenant_ts ON alerts(tenant_id, timestamp DESC)",
                    "CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id)",
                    # Dedicated CAN / OBD-II Telemetry Column Migrations
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS fuel_level FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS rpm INTEGER DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS engine_temp FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS battery_voltage FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS odometer FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS ignition BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS dtc_fault_codes JSON DEFAULT NULL",
                    # Universal CAN Auto-Detection & Telemetry
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS can_make VARCHAR DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS can_baud INTEGER DEFAULT NULL",
                    # Honda Fit GP1 Hybrid Extended CAN & OBD-II Telemetry
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS gear VARCHAR DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS pedal_pct INTEGER DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS steering_deg FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS obd_speed INTEGER DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS ws_fl FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS ws_fr FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS ws_rl FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS ws_rr FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS traction_loss BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS brake_pressed BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS brake_bar FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS abs_active BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS lateral_g FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS yaw_rate FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS crash_flag BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS hybrid_soc INTEGER DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS motor_kw FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS inverter_temp FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS battery_temp FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS hybrid_auto_stop BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS cvt_fluid_temp FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS engine_load FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS map_kpa INTEGER DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS timing_advance FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS intake_temp FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS maf_gps FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS runtime_sec INTEGER DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS throttle_pct FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS battery_12v FLOAT DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS oil_life_pct INTEGER DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS door_driver BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS door_passenger BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS door_rear BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS trunk BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS seatbelt_unbuckled BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS handbrake BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS check_engine_mil BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS tpms_warning BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS ac_on BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS headlights BOOLEAN DEFAULT NULL",
                    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS low_fuel BOOLEAN DEFAULT NULL",
                    # Performance Partial Indexes (only index valid non-zero GPS coordinates)
                    "CREATE INDEX IF NOT EXISTS idx_positions_valid_coords ON positions(device_id, timestamp DESC) WHERE latitude IS NOT NULL AND latitude != 0.0",
                    "CREATE INDEX IF NOT EXISTS idx_positions_routes ON positions(device_id, timestamp ASC) WHERE latitude IS NOT NULL AND latitude != 0.0",
                    "CREATE INDEX IF NOT EXISTS idx_positions_fuel ON positions(device_id, timestamp DESC) WHERE fuel_level IS NOT NULL",
                    "CREATE INDEX IF NOT EXISTS idx_positions_engine ON positions(device_id, timestamp DESC) WHERE rpm IS NOT NULL",
                    # Auth hardening: token revocation + setup link expiry
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0",
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_token_expires TIMESTAMP WITH TIME ZONE DEFAULT NULL",
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR DEFAULT NULL",
                    # Road-matched route geometry cache (one row per device trip window)
                    "CREATE TABLE IF NOT EXISTS matched_routes (id SERIAL PRIMARY KEY, device_id INTEGER REFERENCES devices(id), start_ts TIMESTAMP WITH TIME ZONE NOT NULL, end_ts TIMESTAMP WITH TIME ZONE NOT NULL, fingerprint VARCHAR NOT NULL, segments JSON NOT NULL, engine VARCHAR NOT NULL DEFAULT 'valhalla', created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)",
                    "CREATE INDEX IF NOT EXISTS idx_matched_routes_lookup ON matched_routes(device_id, start_ts, end_ts)"
                ]
                
                for stmt in migration_statements:
                    try:
                        await db.execute(text(stmt))
                        await db.commit()
                    except Exception as inner_e:
                        print(f"Skipping migration step: {inner_e}")
                        await db.rollback()
                
                print("Schema migrations complete.")

                # Ensure Xcela Tracker (YZ4321) has CAN bus & Honda Fit GP1 metadata
                try:
                    from app.models import Device
                    x_res = await db.execute(select(Device).where(
                        (Device.name.ilike("%YZ4321%")) | (Device.name.ilike("%Xcela Tracker%")) | (Device.imei.in_(["XYZ4321", "YZ4321"]))
                    ))
                    x_devs = x_res.scalars().all()
                    for xd in x_devs:
                        dmeta = dict(xd.device_metadata or {})
                        changed = False
                        if not dmeta.get("model") or dmeta.get("model") == "--":
                            dmeta["model"] = "Honda Fit GP1 Hybrid"
                            changed = True
                        if not dmeta.get("can_bus"):
                            dmeta["can_bus"] = True
                            changed = True
                        if changed:
                            xd.device_metadata = dmeta
                    if x_devs:
                        await db.commit()
                        print("Synced Xcela Tracker (YZ4321) metadata.")
                except Exception as ex:
                    print(f"Xcela metadata check note: {ex}")

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
                        email="***REMOVED***",
                        hashed_password=hash_password(admin_pwd),
                        role="admin",
                        is_admin=True,
                        is_active=True,
                        tenant_id=tenant.id
                    )
                    db.add(new_admin)
                    await db.commit()
                    print(f"SUCCESS: Created admin ***REMOVED*** (Tenant: {tenant.name})")

                # SET READY AGAIN just in case
                app.state.db_ready = True
            except Exception as e:
                print(f"Initialization core error: {e}")
                app.state.db_ready = True

    print("="*50)
    print("BACKGROUND INITIALIZATION FINISHED")
    print("="*50 + "\n")



async def _whatsapp_keepalive_loop():
    """
    WhatsApp keepalive loop (every 2 minutes):
    Pings Evolution API /instance/connectionState to keep the container awake.
    If the state ever drops to 'close', triggers /instance/connect to re-establish the socket.
    Also self-pings /health every 2 minutes to keep FastAPI service warm.
    """
    import httpx

    await asyncio.sleep(60)  # Let the app fully boot before first ping

    while True:
        if not (settings.WHATSAPP_ENABLED and settings.WHATSAPP_API_URL):
            await asyncio.sleep(120)
            continue

        base = settings.WHATSAPP_API_URL.strip().rstrip("/")
        if "://" not in base:
            base = "https://" + base
        session = settings.WHATSAPP_SESSION
        headers = {"apikey": settings.WHATSAPP_API_KEY or ""}

        # Ping WhatsApp gateway to keep container and socket awake
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                if settings.WHATSAPP_PROVIDER == "waha":
                    r = await client.get(f"{base}/api/health",
                                         headers={"X-Api-Key": settings.WHATSAPP_API_KEY or ""})
                else:
                    r = await client.get(f"{base}/instance/connectionState/{session}",
                                         headers=headers)
                    if r.status_code == 200:
                        try:
                            state = r.json().get("instance", {}).get("state")
                            if state == "close":
                                print(f"[WA-ping] State is 'close' — auto-reconnecting...")
                                await client.get(f"{base}/instance/connect/{session}", headers=headers)
                        except Exception:
                            pass
                print(f"[WA-ping] connectionState -> {r.status_code}")
        except Exception as e:
            print(f"[WA-ping] failed: {e}")

        # Self-ping /health to keep FastAPI service warm
        try:
            self_base = settings.APP_BASE_URL.rstrip("/")
            async with httpx.AsyncClient(timeout=10) as client:
                await client.get(f"{self_base}/health")
        except Exception as e:
            print(f"[self-keepalive] ping failed: {e}")

        await asyncio.sleep(120)  # 2-minute cycle


@app.on_event("startup")
async def startup_event():
    # 1. Start Heavy Logic in Background to avoid 502 Gateway Timeouts during boot
    asyncio.create_task(run_migrations_and_branding())
    asyncio.create_task(_whatsapp_keepalive_loop())

    # 2. Start Immediate Services
    print("Starting background services...")
    
    # MQTT Client
    try:
        start_mqtt()
        print("MQTT client started successfully")
    except Exception as e:
        print(f"Warning: MQTT client not available: {e}")
    
    # TCP Tracker Server (GPS) - Started in background with retry logic
    async def start_tcp_server():
        # Defensive check: Ensure we don't bind to the same port as the web server
        # Railway assigns PORT for the web server. 
        main_port = int(os.getenv("PORT", 8000))
        if settings.TCP_PORT == main_port:
             print(f"ERROR: TCP_PORT ({settings.TCP_PORT}) matches web PORT. Changing to {settings.TCP_PORT + 1}")
             settings.TCP_PORT += 1

        retry_count = 0
        max_retries = 5
        while retry_count < max_retries:
            try:
                loop = asyncio.get_running_loop()
                # reuse_port=True allows multiple workers to share the port on many Linux systems
                # reuse_address=True helps with lingering sockets in TIME_WAIT state
                server = await loop.create_server(
                    lambda: TCPTrackerProtocol(app), 
                    host=settings.TCP_LISTEN_ADDR, 
                    port=settings.TCP_PORT,
                    reuse_address=True,
                    reuse_port=True if hasattr(asyncio, 'SO_REUSEPORT') or os.name != 'nt' else False
                )
                print(f"SUCCESS: TCP tracker server listening on {settings.TCP_LISTEN_ADDR}:{settings.TCP_PORT}")
                app.state.tcp_server_ready = True
                return # Successfully started
            except Exception as e:
                retry_count += 1
                print(f"Warning: TCP bind attempt {retry_count}/{max_retries} failed on {settings.TCP_PORT}: {e}")
                if retry_count < max_retries:
                    await asyncio.sleep(5) # Wait for port to clear
        
        print(f"CRITICAL: Failed to start TCP tracker server after {max_retries} attempts.")

    # Run the TCP server startup in the background
    asyncio.create_task(start_tcp_server())

from fastapi import Request
from fastapi.responses import JSONResponse

@app.exception_handler(Exception)
async def debug_exception_handler(request: Request, exc: Exception):
    # Never leak internals (paths, SQL, stack details) to clients.
    print(f"Unhandled error on {request.method} {request.url.path}: {exc}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

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
    # Static Files (UI and Uploads)
    app.mount("/static", StaticFiles(directory=frontend_path, html=True), name="static")
    print(f"Mounted static files from: {frontend_path}")
else:
    print(f"Warning: Frontend not found. Checked: {possible_paths}")

from fastapi.responses import RedirectResponse, HTMLResponse

@app.get("/")
async def root():
    return RedirectResponse(url="/static/login.html")

@app.get("/health")
async def health_check():
    # Minimal public probe — no counts, ports or error strings.
    return {"status": "ok"}


@app.get("/admin/health")
async def admin_health_check(current_user: User = Depends(require_super_admin)):
    """Detailed platform health for the super-admin only."""
    from app.db import AsyncSessionLocal
    from app.models import Tenant, User
    from sqlalchemy import func

    status = {
        "db_ready": getattr(app.state, "db_ready", False),
        "tcp_server_active": getattr(app.state, "tcp_server_ready", False),
        "tcp_port": settings.TCP_PORT,
        "tenants_count": 0,
        "users_count": 0,
        "database_connected": False
    }

    try:
        async with AsyncSessionLocal() as db:
            t_count = await db.execute(select(func.count()).select_from(Tenant))
            u_count = await db.execute(select(func.count()).select_from(User))
            status["tenants_count"] = t_count.scalar()
            status["users_count"] = u_count.scalar()
            status["database_connected"] = True
    except Exception as e:
        status["database_connected"] = False

    return status

@app.get("/version")
async def version():
    """Which commit this instance is running and safe WhatsApp diagnostics."""
    import httpx
    wa_url = settings.WHATSAPP_API_URL or ""
    wa_masked = f"{wa_url[:12]}...{wa_url[-8:]}" if len(wa_url) > 20 else wa_url

    gateway_status = None
    instance_state = None
    evolution_restart_test = None
    if settings.WHATSAPP_ENABLED and settings.WHATSAPP_API_URL:
        base = settings.WHATSAPP_API_URL.strip().rstrip("/")
        if "://" not in base:
            base = "https://" + base
        headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                if settings.WHATSAPP_PROVIDER == "evolution":
                    inst_url = f"{base}/instance/connectionState/{settings.WHATSAPP_SESSION}"
                    r = await client.get(inst_url, headers=headers)
                    gateway_status = r.status_code
                    if r.status_code == 200:
                        instance_state = r.json()
                    else:
                        instance_state = {"error_status": r.status_code, "body": r.text[:150]}
                else:
                    r = await client.get(f"{base}/api/health", headers={"X-Api-Key": settings.WHATSAPP_API_KEY or ""})
                    gateway_status = r.status_code
        except Exception as e:
            instance_state = {"network_exception": str(e)}

    from app.services.whatsapp import last_send_log
    return {
        "commit": os.environ.get("GIT_COMMIT") or os.environ.get("RAILWAY_GIT_COMMIT_SHA") or "unknown",
        "whatsapp_enabled": bool(settings.WHATSAPP_ENABLED),
        "whatsapp_provider": settings.WHATSAPP_PROVIDER,
        "whatsapp_api_url_set": bool(settings.WHATSAPP_API_URL),
        "whatsapp_api_url_preview": wa_masked,
        "whatsapp_session": settings.WHATSAPP_SESSION,
        "gateway_http_status": gateway_status,
        "gateway_instance_state": instance_state,
        "last_whatsapp_dispatch": last_send_log
    }

@app.get("/admin/whatsapp-reconnect")
async def admin_whatsapp_reconnect():
    """Test and trigger instance reconnect/restart on Evolution API directly."""
    import httpx
    if not settings.WHATSAPP_ENABLED or not settings.WHATSAPP_API_URL:
        return {"error": "WhatsApp not enabled"}
    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
    results = {}
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            r = await client.post(f"{base}/instance/restart/{settings.WHATSAPP_SESSION}", headers=headers)
            results["restart_post"] = {"status": r.status_code, "body": r.text[:150]}
        except Exception as e:
            results["restart_post_err"] = str(e)
        try:
            r = await client.get(f"{base}/instance/connect/{settings.WHATSAPP_SESSION}", headers=headers)
            results["connect_get"] = {"status": r.status_code, "body": r.text[:150]}
        except Exception as e:
            results["connect_get_err"] = str(e)
    return results



@app.get("/admin/whatsapp-reset")
async def admin_whatsapp_reset(session: str = ""):
    """Smart WhatsApp session reset.
    Root cause: Evolution API caches 'open' state even after device is unlinked.
    Fix: restart the instance, wait 12s for WhatsApp to REJECT the invalid credentials,
    then call /instance/connect which will now return a QR (since state flips to 'close').
    After this endpoint returns, immediately call /admin/whatsapp-qr."""
    import httpx, asyncio
    if not settings.WHATSAPP_ENABLED or not settings.WHATSAPP_API_URL:
        return {"error": "WhatsApp not enabled"}
    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
    session = session.strip() or settings.WHATSAPP_SESSION
    result = {}

    async with httpx.AsyncClient(timeout=40.0) as client:
        # Step 1: Try force-delete with ?force=true param (some Evolution API versions support this)
        deleted = False
        try:
            r = await client.delete(f"{base}/instance/delete/{session}", headers=headers, params={"force": "true"})
            result["delete_force"] = {"status": r.status_code, "body": r.text[:200]}
            if r.status_code in (200, 201):
                deleted = True
        except Exception as e:
            result["delete_force_err"] = str(e)

        if deleted:
            await asyncio.sleep(2)
            try:
                r = await client.post(f"{base}/instance/create", headers=headers, json={
                    "instanceName": session, "qrcode": True, "integration": "WHATSAPP-BAILEYS"
                })
                result["create"] = {"status": r.status_code, "body": r.text[:400]}
                result["strategy"] = "A: deleted+recreated — call /admin/whatsapp-qr now"
            except Exception as e:
                result["create_err"] = str(e)
            return result

        # Step 2: Restart and wait for WhatsApp to REJECT the dead credentials
        # (Evolution API sets state='open' immediately on restart, but WhatsApp
        #  rejects unlinked credentials within ~10s, flipping state to 'close')
        try:
            r = await client.post(f"{base}/instance/restart/{session}", headers=headers)
            result["restart"] = {"status": r.status_code, "body": r.text[:200]}
        except Exception as e:
            result["restart_err"] = str(e)

        result["waiting"] = "Waiting 15s for WhatsApp to reject dead credentials..."
        await asyncio.sleep(15)

        # Step 3: Check state — should now be 'close' after WhatsApp rejection
        try:
            r = await client.get(f"{base}/instance/connectionState/{session}", headers=headers)
            result["state_after_wait"] = {"status": r.status_code, "body": r.text[:200]}
        except Exception as e:
            result["state_after_wait_err"] = str(e)

        # Step 4: Connect — if state flipped to close/refused, this returns QR
        try:
            r = await client.get(f"{base}/instance/connect/{session}", headers=headers)
            data = r.json() if r.status_code == 200 else {}
            result["connect"] = {"status": r.status_code, "body": r.text[:400]}

            if r.status_code == 404:
                # Instance was deleted externally — create it fresh now
                r2 = await client.post(f"{base}/instance/create", headers=headers, json={
                    "instanceName": session,
                    "qrcode": True,
                    "integration": "WHATSAPP-BAILEYS"
                })
                result["auto_create"] = {"status": r2.status_code, "body": r2.text[:400]}
                result["strategy"] = "CREATED: instance was missing, recreated fresh — call /admin/whatsapp-qr now"
            else:
                state = (data.get("instance") or {}).get("state", "") if isinstance(data, dict) else ""
                if state == "open":
                    result["strategy"] = "STUCK: still open after 15s wait — try /admin/whatsapp-new-instance"
                else:
                    result["strategy"] = "B: restarted+waited — call /admin/whatsapp-qr now"
        except Exception as e:
            result["connect_err"] = str(e)

    return result


@app.get("/admin/whatsapp-pairing-code")
async def admin_whatsapp_pairing_code(phone: str = "", session: str = ""):
    """Alternative to QR code: request a pairing code for the bot phone number.
    Pass ?phone= the BOT phone number (e.g. 263783009275).
    User then enters the code on WhatsApp -> Settings -> Linked Devices -> Link a Device
    -> 'Link with phone number instead'."""
    import httpx, asyncio
    if not settings.WHATSAPP_ENABLED or not settings.WHATSAPP_API_URL:
        return {"error": "WhatsApp not enabled"}
    if not phone:
        return {"error": "Pass ?phone=263783009275 (the BOT phone number)"}
    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
    session = session.strip() or settings.WHATSAPP_SESSION

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Must restart first so instance is in 'connecting' (not 'open') state
        try:
            r = await client.post(f"{base}/instance/restart/{session}", headers=headers)
            restart_body = r.text[:100]
        except Exception as e:
            restart_body = str(e)

        await asyncio.sleep(8)  # Let restart settle into 'connecting' state

        try:
            # Evolution API v2 pairing code endpoint
            r = await client.post(
                f"{base}/instance/pairing-code/{session}",
                headers=headers,
                json={"number": phone}
            )
            return {
                "restart": restart_body,
                "pairing_status": r.status_code,
                "pairing_response": r.json() if r.status_code in (200, 201) else r.text[:300],
                "instructions": (
                    "If you got a code above: on the BOT phone, go to "
                    "WhatsApp -> Settings -> Linked Devices -> Link a Device "
                    "-> 'Link with phone number instead' -> enter the code shown above."
                )
            }
        except Exception as e:
            return {"restart": restart_body, "pairing_error": str(e)}


@app.get("/admin/whatsapp-view", response_class=HTMLResponse)
async def admin_whatsapp_view(session: str = "inferth2"):
    """Visual page to scan the WhatsApp QR code, view connection state, or request a pairing code."""
    import httpx
    target_session = session.strip() or "inferth2"
    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}

    qr_img = ""
    instance_state = "unknown"
    error_msg = ""
    instances_list = []

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                r_inst = await client.get(f"{base}/instance/fetchInstances", headers=headers)
                if r_inst.status_code == 200:
                    data_inst = r_inst.json()
                    if isinstance(data_inst, list):
                        instances_list = [i.get("name") for i in data_inst if i.get("name")]
            except Exception:
                pass

            r = await client.get(f"{base}/instance/connect/{target_session}", headers=headers)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict):
                    instance_state = (data.get("instance") or {}).get("state") or data.get("state") or "unknown"
                    qr_raw = (
                        data.get("base64")
                        or (data.get("qrcode") or {}).get("base64")
                        or (data.get("instance") or {}).get("qrcode")
                    )
                    if qr_raw:
                        qr_img = qr_raw if qr_raw.startswith("data:image") else f"data:image/png;base64,{qr_raw}"
            else:
                error_msg = f"HTTP {r.status_code}: {r.text[:200]}"
    except Exception as e:
        error_msg = str(e)

    instances_html = "".join([
        f'<a href="/admin/whatsapp-view?session={name}" style="padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; background: {("#ff8c00; color: #fff") if name == target_session else "#f1f5f9; color: #334155"}">{name}</a> '
        for name in (instances_list or ["inferth", "inferth2"])
    ])

    qr_section = ""
    if qr_img:
        qr_section = f"""
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0; display: inline-block; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.08); margin: 20px 0;">
            <img src="{qr_img}" alt="WhatsApp QR Code" style="width: 280px; height: 280px; display: block; border-radius: 8px; margin: 0 auto;" />
            <div style="margin-top: 16px; font-size: 14px; font-weight: 600; color: #1e293b;">
                Scan with WhatsApp
            </div>
            <div style="font-size: 12px; color: #64748b; margin-top: 4px;">
                Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
            </div>
        </div>
        """
    elif instance_state == "open":
        qr_section = """
        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 12px; padding: 24px; color: #15803d; max-width: 480px; margin: 20px auto;">
            <div style="font-size: 24px; margin-bottom: 8px;">✅ Connected &amp; Active</div>
            <div style="font-size: 14px;">This WhatsApp instance is currently linked and ready to send OTP messages.</div>
        </div>
        """
    else:
        qr_section = f"""
        <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 24px; color: #b45309; max-width: 480px; margin: 20px auto;">
            <div style="font-size: 20px; font-weight: 700; margin-bottom: 8px;">Status: {instance_state}</div>
            <div style="font-size: 13px;">QR Code not ready yet or loading. Click Refresh below.</div>
            {f'<div style="font-size:12px; color:#ef4444; margin-top:8px;">{error_msg}</div>' if error_msg else ''}
        </div>
        """

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Inferth WhatsApp Gateway Linker</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body {{{{ font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 32px 16px; text-align: center; }}}}
        .card {{{{ background: #1e293b; max-width: 580px; margin: 0 auto; border-radius: 20px; padding: 32px 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); }}}}
        .btn {{{{ display: inline-block; background: #ff8c00; color: #fff; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin: 6px; cursor: pointer; border: none; }}}}
        .btn-outline {{{{ background: transparent; border: 1px solid #475569; color: #cbd5e1; }}}}
        .btn:hover {{{{ opacity: 0.9; }}}}
    </style>
</head>
<body>
    <div class="card">
        <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 6px;">WhatsApp Bot Gateway</h1>
        <p style="color: #94a3b8; font-size: 13px; margin-top: 0;">Instance: <strong style="color: #f1f5f9;">{target_session}</strong> (Status: <strong style="color: {'#22c55e' if instance_state == 'open' else '#f59e0b'}">{instance_state}</strong>)</p>
        
        <div style="margin: 16px 0;">
            <span style="font-size: 12px; color: #94a3b8; margin-right: 8px;">Select Instance:</span>
            {instances_html}
        </div>

        {qr_section}

        <div style="margin-top: 20px; display: flex; justify-content: center; gap: 8px; flex-wrap: wrap;">
            <a href="/admin/whatsapp-view?session={target_session}" class="btn">🔄 Refresh QR</a>
            <a href="/auth/latest-otp" target="_blank" class="btn btn-outline">🔑 View Latest OTP Codes</a>
            <a href="/admin/test-whatsapp-send?phone=263713150172" target="_blank" class="btn btn-outline">✉️ Test Send to Admin</a>
        </div>

        <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.08); text-align: left;">
            <div style="font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 8px;">Option B: Link with 8-Digit Pairing Code</div>
            <form action="/admin/whatsapp-pairing-code" method="get" target="_blank" style="display: flex; gap: 8px;">
                <input type="hidden" name="session" value="{target_session}" />
                <input type="text" name="phone" value="263783009275" placeholder="Bot Phone (e.g. 263783009275)" style="flex: 1; padding: 8px 12px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 13px;" />
                <button type="submit" class="btn" style="margin: 0;">Get Pairing Code</button>
            </form>
            <div style="font-size: 11px; color: #64748b; margin-top: 6px;">WhatsApp &rarr; Linked Devices &rarr; Link with phone number instead.</div>
        </div>
    </div>
</body>
</html>"""


@app.get("/admin/whatsapp-new-instance")
async def admin_whatsapp_new_instance(name: str = "inferth_new"):
    """Create a BRAND NEW WhatsApp instance under a fresh name (default: inferth_new).
    Use this when the old instance is stuck and cannot be deleted.
    After creating, call /admin/whatsapp-qr?session=inferth_new to get the QR code.
    After scanning, update WHATSAPP_SESSION env var in Railway to the new name and redeploy."""
    import httpx
    if not settings.WHATSAPP_ENABLED or not settings.WHATSAPP_API_URL:
        return {"error": "WhatsApp not enabled"}
    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.post(f"{base}/instance/create", headers=headers, json={
                "instanceName": name,
                "qrcode": True,
                "integration": "WHATSAPP-BAILEYS"
            })
            data = r.json() if r.status_code in (200, 201) else {}
            return {
                "status": r.status_code,
                "body": r.text[:500],
                "next_step": (
                    f"If status=200/201, call: /admin/whatsapp-qr?session={name} "
                    f"to get the QR code. Scan it on the bot phone. "
                    f"Then set WHATSAPP_SESSION={name} in Railway env vars and redeploy."
                )
            }
        except Exception as e:
            return {"error": str(e)}


@app.get("/admin/whatsapp-qr")
async def admin_whatsapp_qr(session: str = ""):
    """Get the QR code for any WhatsApp instance.
    Pass ?session=inferth_new to get QR for a different instance (e.g. after /admin/whatsapp-new-instance).
    Default: uses WHATSAPP_SESSION env var."""
    import httpx
    if not settings.WHATSAPP_ENABLED or not settings.WHATSAPP_API_URL:
        return {"error": "WhatsApp not enabled"}
    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
    target_session = session.strip() or settings.WHATSAPP_SESSION
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.get(f"{base}/instance/connect/{target_session}", headers=headers)
            data = r.json() if r.status_code == 200 else {}
            # Extract QR from various response shapes (v1 vs v2)
            qr_base64 = None
            if isinstance(data, dict):
                qr_base64 = (
                    data.get("base64")
                    or (data.get("qrcode") or {}).get("base64")
                    or (data.get("instance") or {}).get("qrcode")
                )
            state = (data.get("instance") or {}).get("state", "unknown") if isinstance(data, dict) else "unknown"
            return {
                "session": target_session,
                "http_status": r.status_code,
                "instance_state": state,
                "qr_base64": qr_base64,
                "raw": data,
                "instructions": (
                    "If qr_base64 is NOT null: copy it and go to "
                    "https://onlinepngtools.com/convert-base64-to-png — paste the base64 to see the QR image. "
                    "Scan it on the BOT phone: WhatsApp -> Settings -> Linked Devices -> Link a Device. "
                    "If instance_state is 'open' and qr_base64 is null: "
                    "try /admin/whatsapp-reset first to force a disconnect."
                )
            }
        except Exception as e:
            return {"error": str(e)}


@app.get("/admin/test-whatsapp-send")
async def test_whatsapp_send(phone: str = "263713150172", session: str = ""):
    """Inspect Evolution API instance state, QR / logout, and payload variants."""
    import httpx
    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
    session = session.strip() or settings.WHATSAPP_SESSION
    
    report = {}
    async with httpx.AsyncClient(timeout=20.0) as client:
        # 1. Fetch instance detailed state
        try:
            r = await client.get(f"{base}/instance/fetchInstances", headers=headers)
            report["instances"] = r.json() if r.status_code == 200 else r.text[:200]
        except Exception as e:
            report["instances_err"] = str(e)

        # 2. Send plain digits number (clean E.164, no @s.whatsapp.net)
        url = f"{base}/message/sendText/{session}"
        clean_phone = "".join(c for c in phone if c.isdigit())
        try:
            p = {"number": clean_phone, "text": "Test OTP from Inferth Mapping"}
            r = await client.post(url, json=p, headers=headers)
            report["send_test"] = {"status": r.status_code, "response": r.text[:250]}
        except Exception as e:
            report["send_test_err"] = str(e)

    return report

@app.get("/admin/repair-production")
async def repair_production_state(current_user: User = Depends(require_super_admin)):
    """Diagnostic and Repair endpoint to fix DB state remotely"""
    from app.db import AsyncSessionLocal
    from app.models import Tenant, User
    from sqlalchemy import select, update, text
    import os
    
    results = {"steps": [], "diagnostics": {}}
    
    async with AsyncSessionLocal() as db:
        # 0. Structural Migration (Auto-add new columns)
        try:
            await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS navbar_bg VARCHAR"))
            await db.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS navbar_text_color VARCHAR"))
            await db.commit()
            results["steps"].append("Database structural migration complete (Navbar columns added)")
        except Exception as e:
            results["errors"].append(f"Migration error: {str(e)}")
            await db.rollback()

        # 1. Fix Logos
        try:
            # Point all Console Telematics variations to logo.png and set colors (Pure Neon Green #00FF00 / Dark Navbar)
            await db.execute(
                text("UPDATE tenants SET logo_url = :url, primary_color = :p, secondary_color = :s, navbar_bg = :nb, navbar_text_color = :nt WHERE TRIM(LOWER(name)) = LOWER(:name)"),
                {"url": "/static/logo.png", "p": "#00FF00", "s": "#ADFF2F", "nb": "linear-gradient(to right, #1a1c23, #2d3139)", "nt": "#00FF00", "name": "Console Telematics"}
            )
            # Ensure Inferth Mapping is correct (White Navbar)
            await db.execute(
                text("UPDATE tenants SET logo_url = :url, primary_color = :p, secondary_color = :s, navbar_bg = :nb, navbar_text_color = :nt WHERE TRIM(LOWER(name)) = LOWER(:name)"),
                {"url": "/static/inferth_mapping_logo.png", "p": "#ff8c00", "s": "#ef4835", "nb": "#ffffff", "nt": "#ff8c00", "name": "Inferth Mapping"}
            )
            # Guarantee companies using default logo (including NetroZim) use Inferth Mapping theme colors
            await db.execute(
                text("UPDATE tenants SET logo_url = NULL, primary_color = '#ff8c00', secondary_color = '#ef4835', navbar_bg = '#ffffff', navbar_text_color = '#ff8c00' WHERE logo_url IS NULL OR logo_url = '/static/inferth_mapping_logo.png' OR TRIM(LOWER(name)) = 'netrozim'")
            )
            await db.commit()
            results["steps"].append("Standardized all organization logo paths and colors in DB")
        except Exception as e:
            results["steps"].append(f"Logo repair failed: {str(e)}")

        # 2. Fix User Tenant Assignments
        try:
            # Fix Admin
            await db.execute(
                text("UPDATE users SET tenant_id = 1 WHERE email = :email"),
                {"email": "***REMOVED***"}
            )
            # Fix Manager (from screenshot)
            await db.execute(
                text("UPDATE users SET tenant_id = (SELECT id FROM tenants WHERE name = 'Console Telematics' LIMIT 1) WHERE email = :email"),
                {"email": "***REMOVED***"}
            )
            await db.commit()
            results["steps"].append("Ensured users are assigned to correct Tenants")
        except Exception as e:
            results["steps"].append(f"Admin assignment repair failed: {str(e)}")

        # 3. Diagnostics
        try:
            t_res = await db.execute(select(Tenant))
            tenants = t_res.scalars().all()
            results["diagnostics"]["tenants"] = [
                {"id": t.id, "name": t.name, "logo": t.logo_url} for t in tenants
            ]
            
            # Check static files
            check_paths = ["frontend/logo.png", "/app/frontend/logo.png", "static/logo.png"]
            found_files = []
            for p in check_paths:
                if os.path.exists(p):
                    found_files.append(p)
            results["diagnostics"]["files_found"] = found_files
            
        except Exception as e:
            results["diagnostics"]["error"] = str(e)

    return results


# CORS: exact-origin allowlist only — never wildcard with credentials.
_allowed_origins = [o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Optional Host allowlist (deploy-time opt-in via ALLOWED_HOSTS).
_allowed_hosts = [h.strip() for h in settings.ALLOWED_HOSTS.split(",") if h.strip()]
if _allowed_hosts:
    from fastapi.middleware.trustedhost import TrustedHostMiddleware
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts)

# Security headers on every response. CSP applies to HTML pages served from
# /static (API JSON ignores it harmlessly).
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com; "
    "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://server.arcgisonline.com "
    "https://*.tile.opentopomap.org https://unpkg.com https://*.basemaps.cartocdn.com; "
    "connect-src 'self' https: wss:; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(self)"
    response.headers["Content-Security-Policy"] = _CSP
    if request.url.path.endswith(".html") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    forwarded = request.headers.get("x-forwarded-proto", request.url.scheme)
    if forwarded.split(",")[0].strip() == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

@app.middleware("http")
async def redirect_bare_domain(request: Request, call_next):
    hosts = {request.headers.get(name, "").split(",")[0].split(":")[0].strip().lower() for name in ("host", "x-forwarded-host")}
    if "inferthmapping.co.zw" in hosts:
        return RedirectResponse(str(request.url.replace(scheme="https", netloc="www.inferthmapping.co.zw")), status_code=301)
    return await call_next(request)

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(positions.router)
app.include_router(users.router)
app.include_router(audit.router)
app.include_router(geofences.router)
app.include_router(payments.router)
app.include_router(admin.router)
app.include_router(rules.router)
app.include_router(alerts.router)
app.include_router(reports.router)
app.include_router(analytics.router)
app.include_router(controller.router)
app.include_router(tracker_secrets.router)
app.include_router(insights.router)

@app.websocket("/ws/positions")
async def websocket_endpoint(websocket: WebSocket):
    await ws_listener(websocket)
    
if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
