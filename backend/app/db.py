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

# Create async engine with robust connection pooling and strict timeouts
engine = create_async_engine(
    DATABASE_URL,
    echo=False,  # Set to False in production for better performance
    future=True,
    pool_pre_ping=True,  # Check connection liveness before using
    pool_recycle=300,    # Recycle connections every 5 minutes
    pool_size=10,        # Increased baseline connections
    max_overflow=20,     # Allow more extra connections during spikes
    connect_args={
        "timeout": 10,           # 10s timeout for initial connection
        "command_timeout": 10   # 10s timeout for every individual query
    }
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
