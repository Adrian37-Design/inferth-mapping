from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from app.config import settings

# -----------------------------------------
# DATABASE CONNECTION (PostgreSQL + Async)
# -----------------------------------------

# We use the DATABASE_URL from your .env via settings
# We use the DATABASE_URL from your .env via settings
DATABASE_URL = settings.DATABASE_URL

# Fix for Railway/Heroku: Ensure we use the async driver
if DATABASE_URL and DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
elif DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)

# --- DEBUGGING: Print the URL (Redacted) ---
import sys
try:
    if DATABASE_URL:
        # Basic redaction to hide password
        safe_url = DATABASE_URL
        if "@" in safe_url and ":" in safe_url.split("@")[0]:
            # Split into credentials and host
            creds, host = safe_url.split("@", 1)
            # Split credentials into proto://user and password
            # Find the LAST colon in the credentials part (separator between user and pass)
            if ":" in creds:
                prefix, _ = creds.rsplit(":", 1)
                safe_url = f"{prefix}:******@{host}"
        
        print(f"\n[DEBUG] ------------------------------------------------")
        print(f"[DEBUG] DB CONNECTION ATTEMPT: {safe_url}")
        print(f"[DEBUG] ------------------------------------------------\n")
        sys.stdout.flush()
except Exception as e:
    print(f"[DEBUG] Error printing URL: {e}")
# -------------------------------------------

# Create async engine with robust connection pooling
engine = create_async_engine(
    DATABASE_URL,
    echo=True,  # Logs SQL statements — good for debugging
    future=True,
    pool_pre_ping=True,  # Check connection liveness before using
    pool_recycle=300,    # Recycle connections every 5 minutes (prevents stale connections)
    pool_size=5,         # Baseline number of connections
    max_overflow=10      # How many extra connections can be created during spikes
)

# Create async session factory
AsyncSessionLocal = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# Base class for ORM models
Base = declarative_base()

# Dependency for FastAPI routes
async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
