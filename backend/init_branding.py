import asyncio
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load env vars
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(env_path)

# Override DB host for local execution
if os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["DATABASE_URL"].replace("@db:", "@localhost:")

from app.branding import init_branding

if __name__ == "__main__":
    asyncio.run(init_branding())
