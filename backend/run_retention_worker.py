"""
Manual retention worker entry point.

    python run_retention_worker.py             # dry run (default)
    python run_retention_worker.py --apply     # perform deletions (needs RETENTION_ENABLED=true)
    python run_retention_worker.py --tenant 7

Environment:
    RETENTION_ENABLED=true      allows deletions
    RETENTION_DRY_RUN=false     required together with the flag above
    RETENTION_BATCH_SIZE=2000
"""

import argparse
import asyncio
import json
import os
import sys

from app.db import AsyncSessionLocal
from app.services.retention_worker import run_cleanup


async def main() -> int:
    parser = argparse.ArgumentParser(description="Inferth GPS retention worker")
    parser.add_argument("--apply", action="store_true", help="delete expired rows (requires RETENTION_ENABLED=true)")
    parser.add_argument("--tenant", type=int, default=None)
    args = parser.parse_args()

    if not os.getenv("DATABASE_URL"):
        print("DATABASE_URL is not set.", file=sys.stderr)
        return 2

    async with AsyncSessionLocal() as db:
        report = await run_cleanup(db, dry_run=not args.apply, tenant_id=args.tenant)

    print(json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
