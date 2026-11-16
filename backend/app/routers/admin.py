from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession
import os
from sqlalchemy.future import select
from typing import Optional
from app.db import get_db
from app.models import Tenant, Transaction, User
from app.auth_middleware import get_current_user, require_admin, require_super_admin
import datetime

router = APIRouter(prefix="/admin", tags=["admin"])

@router.patch("/payments/{txn_id}/approve")
async def approve_payment(
    txn_id: int, 
    db: AsyncSession = Depends(get_db), 
    current_user: User = Depends(require_admin)
):
    result = await db.execute(select(Transaction).where(Transaction.id == txn_id))
    txn = result.scalars().first()
    if not txn: raise HTTPException(status_code=404, detail="Transaction not found")
    
    if txn.status == "paid":
        return {"message": "Transaction already approved"}

    # Update Transaction Status
    txn.status = "paid"
    
    # Update Tenant Subscription
    result = await db.execute(select(Tenant).where(Tenant.id == txn.tenant_id))
    tenant = result.scalars().first()
    if tenant:
        tenant.subscription_status = "active"
        # Set next billing to 30 days from now
        now = datetime.datetime.now(datetime.timezone.utc)
        tenant.next_billing_date = now + datetime.timedelta(days=30)
    
    await db.commit()
    return {"message": f"Payment approved for {tenant.name}. Subscription active until {tenant.next_billing_date}"}

@router.get("/payments/pending")
async def list_pending_payments(
    db: AsyncSession = Depends(get_db), 
    current_user: User = Depends(require_admin)
):
    result = await db.execute(select(Transaction).where(Transaction.status == "approval_pending"))
    return result.scalars().all()

@router.get("/debug-logs", response_class=PlainTextResponse)
async def get_tracker_debug_logs(current_user: User = Depends(require_admin)):
    """Returns the last 16KB of the tracker debug log efficiently."""
    log_path = "tracker_debug.log"
    if not os.path.exists(log_path):
        return f"Log file '{log_path}' not found. No tracker has connected yet."
    
    try:
        # Memory-efficient read of the end of the file
        file_size = os.path.getsize(log_path)
        read_size = 16384 # 16KB is enough for a quick debug view
        
        with open(log_path, "rb") as f:
            if file_size > read_size:
                f.seek(file_size - read_size)
            content = f.read().decode(errors="ignore")
            # If we skipped part of the file, add a header
            prefix = f"--- Showing last {read_size/1024}KB of {file_size/1024:.2f}KB log ---\n\n" if file_size > read_size else ""
            return prefix + content
    except Exception as e:
        return f"Error reading logs: {str(e)}"

# --- DATABASE OPTIMIZATION & STORAGE MAINTENANCE ---
from app.services.db_maintenance import get_storage_stats, optimize_database_indexes, prune_old_heartbeats
from app.models import AuditLog

@router.get("/storage/stats")
async def storage_statistics(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Returns total rows, valid coordinates, CAN/OBD diagnostic telemetry count, and table size."""
    stats = await get_storage_stats(db)
    return stats

@router.post("/storage/optimize")
async def optimize_storage(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Refreshes query planner statistics and optimizes partial/composite indexes."""
    result = await optimize_database_indexes(db)
    
    # Audit log
    audit = AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="DATABASE_OPTIMIZE_INDEXES",
        details={"result": result},
        ip_address="127.0.0.1"
    )
    db.add(audit)
    await db.commit()
    
    return result

from app.services.maintenance import prune_stationary_telemetry

@router.post("/storage/prune-telemetry")
async def prune_telemetry_endpoint(
    days: int = 90,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Safely prunes stationary telemetry records older than N days (Risk 2 Founder Fix)."""
    result = await prune_stationary_telemetry(db, retention_days=days)
    audit = AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="DATABASE_PRUNE_TELEMETRY",
        details=result,
        ip_address="127.0.0.1"
    )
    db.add(audit)
    await db.commit()
    return result

@router.post("/storage/prune-heartbeats")
async def prune_heartbeats(
    days: int = 30,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Safely prunes empty heartbeat records with no GPS and no CAN/OBD diagnostics older than N days."""
    deleted_count = await prune_old_heartbeats(db, days=days)
    
    # Audit log
    audit = AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="PRUNE_OLD_HEARTBEATS",
        details={"days_cutoff": days, "deleted_rows": deleted_count},
        ip_address="127.0.0.1"
    )
    db.add(audit)
    await db.commit()
    
    return {
        "success": True,
        "message": f"Successfully pruned {deleted_count} empty heartbeat records older than {days} days.",
        "deleted_count": deleted_count
    }


# --- TENANT-AWARE GPS RETENTION (READ-ONLY) ---
from app.services.retention import dry_run_report, resolve_policy

@router.get("/retention/policies")
async def list_retention_policies(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin)
):
    """Resolved retention entitlement for every tenant. Reads only."""
    rows = (
        await db.execute(
            select(Tenant.id, Tenant.name, Tenant.plan, Tenant.billing_cycle, Tenant.retention_days).order_by(Tenant.id)
        )
    ).mappings().all()
    policies = [resolve_policy(row).as_dict() for row in rows]
    return {
        "tenants": policies,
        "summary": {
            "total": len(policies),
            "eligible": sum(1 for p in policies if p["eligible"]),
            "needs_configuration": [p["tenant_name"] for p in policies if not p["eligible"]],
        },
    }


@router.patch("/retention/{tenant_id}")
async def set_tenant_retention(
    tenant_id: int,
    retention_days: Optional[int] = Body(None, embed=True),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin)
):
    """Set or clear a tenant's explicit retention override (Enterprise)."""
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if retention_days is not None and not (1 <= int(retention_days) <= 3650):
        raise HTTPException(status_code=400, detail="retention_days must be between 1 and 3650, or null")

    before = tenant.retention_days
    tenant.retention_days = int(retention_days) if retention_days is not None else None
    db.add(AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="RETENTION_POLICY_UPDATE",
        details={"target_tenant": tenant_id, "before": before, "after": tenant.retention_days},
        ip_address="127.0.0.1",
    ))
    await db.commit()
    return {"tenant_id": tenant_id, "retention_days": tenant.retention_days}


@router.get("/retention/dry-run")
async def retention_dry_run(
    tenant_id: int = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin)
):
    """
    Reports how many position rows each tenant WOULD lose under its retention
    policy. Issues SELECT statements only — no rows are deleted or modified.
    """
    report = await dry_run_report(db, tenant_id=tenant_id)
    try:
        audit = AuditLog(
            user_id=current_user.id,
            tenant_id=current_user.tenant_id,
            action="RETENTION_DRY_RUN",
            details={
                "tenant_id": tenant_id,
                "would_delete_rows": report["summary"]["would_delete_rows"],
                "eligible_tenants": report["summary"]["eligible_tenants"],
            },
            ip_address="127.0.0.1",
        )
        db.add(audit)
        await db.commit()
    except Exception:
        await db.rollback()
    return report

