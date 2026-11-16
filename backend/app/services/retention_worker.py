"""
Tenant-aware GPS retention cleanup worker.

Safety model:
  * disabled unless RETENTION_ENABLED=true
  * DRY RUN unless RETENTION_DRY_RUN=false
  * skips tenants whose policy cannot be resolved (Enterprise without override)
  * only touches devices with a real tenant_id
  * keeps the newest N fixes per device
  * never deletes anything newer than MIN_RETENTION_DAYS
  * batches deletes so live ingest is not starved
  * single-run advisory lock (safe with multiple web replicas)
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.retention import (
    KEEP_LATEST_PER_DEVICE,
    MIN_RETENTION_DAYS,
    dry_run_report,
    resolve_policy,
)

BATCH_SIZE = int(os.getenv("RETENTION_BATCH_SIZE", "2000"))
ADVISORY_LOCK_KEY = 918273645
MAX_BATCHES_PER_TENANT = int(os.getenv("RETENTION_MAX_BATCHES", "500"))


_DELETE_SQL = text(
    """
    WITH ranked AS (
        SELECT p.id,
               p.timestamp,
               row_number() OVER (
                   PARTITION BY p.device_id ORDER BY p.timestamp DESC
               ) AS rn
        FROM positions p
        JOIN devices d ON d.id = p.device_id
        WHERE d.tenant_id = :tenant_id
    ),
    doomed AS (
        SELECT id
        FROM ranked
        WHERE timestamp < :cutoff AND rn > :keep
        LIMIT :batch
    )
    DELETE FROM positions p
    USING doomed
    WHERE p.id = doomed.id
    """
)


def retention_enabled() -> bool:
    return os.getenv("RETENTION_ENABLED", "false").strip().lower() == "true"


def dry_run_default() -> bool:
    return os.getenv("RETENTION_DRY_RUN", "true").strip().lower() != "false"


async def _try_lock(db: AsyncSession) -> bool:
    try:
        got = (await db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": ADVISORY_LOCK_KEY})).scalar()
        return bool(got)
    except Exception:
        return False


async def _unlock(db: AsyncSession) -> None:
    try:
        await db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": ADVISORY_LOCK_KEY})
    except Exception:
        pass


async def run_cleanup(
    db: AsyncSession,
    dry_run: Optional[bool] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Run one cleanup pass. Returns a per-tenant result. Never raises for a single
    tenant failure; the failure is reported and the rest continue.
    """
    if dry_run is None:
        dry_run = dry_run_default()

    started = dt.datetime.now(dt.timezone.utc)
    summary: Dict[str, Any] = {
        "started_at": started.isoformat(),
        "dry_run": bool(dry_run),
        "enabled": retention_enabled(),
        "batch_size": BATCH_SIZE,
        "tenants": [],
    }

    if not dry_run and not retention_enabled():
        summary["skipped"] = "RETENTION_ENABLED is not true"
        return summary

    locked = await _try_lock(db)
    if not locked:
        summary["skipped"] = "another retention run holds the advisory lock"
        return summary

    try:
        if dry_run:
            report = await dry_run_report(db, tenant_id=tenant_id)
            summary["report"] = report["summary"]
            summary["tenants"] = [
                {
                    "tenant_id": t["tenant_id"],
                    "tenant": t["tenant_name"],
                    "tier": t["tier"],
                    "retention_days": t["retention_days"],
                    "eligible": t["eligible"],
                    "would_delete_rows": t.get("would_delete_rows", 0),
                    "reason": t["reason"],
                }
                for t in report["tenants"]
            ]
            return summary

        tenants_sql = "SELECT id, name, plan, billing_cycle, retention_days FROM tenants"
        params: Dict[str, Any] = {}
        if tenant_id is not None:
            tenants_sql += " WHERE id = :tid"
            params["tid"] = tenant_id
        tenants_sql += " ORDER BY id"
        rows = (await db.execute(text(tenants_sql), params)).mappings().all()

        for row in rows:
            policy = resolve_policy(row)
            entry: Dict[str, Any] = {
                "tenant_id": policy.tenant_id,
                "tenant": policy.tenant_name,
                "tier": policy.tier,
                "retention_days": policy.retention_days,
            }
            if not policy.eligible or not policy.retention_days:
                entry.update({"deleted": 0, "skipped": True, "reason": policy.reason})
                summary["tenants"].append(entry)
                continue

            days = max(int(policy.retention_days), MIN_RETENTION_DAYS)
            cutoff = started - dt.timedelta(days=days)
            deleted_total = 0
            batches = 0
            try:
                while batches < MAX_BATCHES_PER_TENANT:
                    result = await db.execute(
                        _DELETE_SQL,
                        {
                            "tenant_id": policy.tenant_id,
                            "cutoff": cutoff,
                            "keep": KEEP_LATEST_PER_DEVICE,
                            "batch": BATCH_SIZE,
                        },
                    )
                    await db.commit()
                    count = result.rowcount or 0
                    deleted_total += count
                    batches += 1
                    if count < BATCH_SIZE:
                        break
                    await asyncio.sleep(0.2)
            except Exception as exc:
                await db.rollback()
                entry.update({"deleted": deleted_total, "error": str(exc)})
                summary["tenants"].append(entry)
                continue

            entry.update({"deleted": deleted_total, "cutoff": cutoff.isoformat(), "batches": batches})
            summary["tenants"].append(entry)

        summary["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        return summary
    finally:
        await _unlock(db)
