from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
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
from app.services.db_maintenance import (
    get_disk_report,
    get_storage_stats,
    optimize_database_indexes,
    prune_old_heartbeats,
    reclaim_position_space,
)
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


@router.get("/storage/disk")
async def storage_disk_usage(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin)
):
    """
    What is actually eating the volume: positions heap and indexes, table bloat,
    WAL, replication slots and their retention settings. Read-only.
    """
    return await get_disk_report(db)


@router.post("/storage/reclaim")
async def reclaim_storage(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin)
):
    """
    VACUUM (ANALYZE) positions so space freed by retention is reusable again.
    Safe to run while ingest is live; does not return space to the OS.
    """
    result = await reclaim_position_space()
    db.add(AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="DATABASE_RECLAIM_SPACE",
        details=result,
        ip_address="127.0.0.1",
    ))
    await db.commit()
    return result


@router.post("/retention/run")
async def run_retention_now(
    apply: bool = False,
    tenant_id: int = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin)
):
    """
    Force a retention pass now instead of waiting for the daily run.
    apply=false is a dry run; apply=true deletes expired rows and vacuums.
    """
    from app.services.retention_worker import retention_enabled, run_cleanup

    if apply and not retention_enabled():
        raise HTTPException(
            status_code=409,
            detail="RETENTION_ENABLED is not true, so nothing may be deleted. "
                   "Set RETENTION_ENABLED=true on the service, then retry.",
        )

    summary = await run_cleanup(db, dry_run=not apply, tenant_id=tenant_id)
    try:
        db.add(AuditLog(
            user_id=current_user.id,
            tenant_id=current_user.tenant_id,
            action="RETENTION_RUN_APPLIED" if apply else "RETENTION_RUN_DRY",
            details={
                "tenant_id": tenant_id,
                "deleted_rows": summary.get("deleted_rows", 0),
                "orphans_deleted": summary.get("orphans_deleted", 0),
                "skipped": summary.get("skipped"),
            },
            ip_address="127.0.0.1",
        ))
        await db.commit()
    except Exception:
        await db.rollback()
    return summary


# --- ENTERPRISE QUOTATIONS ---
# A request from the Billing tab is recorded, not activated: Enterprise is
# negotiated. Sales agrees a price, then activates it here, which moves the
# tenant onto Enterprise and sets the next invoice date.

class EnterpriseQuoteActivation(BaseModel):
    monthly_usd: float
    billing_period: str = "monthly"
    vehicles: Optional[int] = None


@router.get("/enterprise-quotes")
async def list_enterprise_quotes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Open Enterprise quotation requests, newest first."""
    rows = (
        await db.execute(
            select(Transaction, Tenant)
            .join(Tenant, Tenant.id == Transaction.tenant_id, isouter=True)
            .where(Transaction.plan_name == "Enterprise_Quotation")
            .where(Transaction.status == "quote_requested")
            .order_by(Transaction.id.desc())
            .limit(200)
        )
    ).all()
    quotes = []
    for txn, tenant in rows:
        quotes.append({
            "id": txn.id,
            "reference": f"QTE-{txn.id}",
            "tenant_id": txn.tenant_id,
            "tenant_name": tenant.name if tenant else None,
            "vehicles": txn.quote_vehicles,
            "notes": txn.quote_notes,
            "contact": txn.quote_contact,
            "created_at": txn.created_at.isoformat() if txn.created_at else None,
        })
    return {"quotes": quotes}


@router.patch("/enterprise-quotes/{txn_id}/activate")
async def activate_enterprise_quote(
    txn_id: int,
    payload: EnterpriseQuoteActivation,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Activate an agreed Enterprise quotation on the requesting tenant."""
    txn = (
        await db.execute(select(Transaction).where(Transaction.id == txn_id))
    ).scalars().first()
    if not txn or (txn.plan_name or "") != "Enterprise_Quotation":
        raise HTTPException(status_code=404, detail="Quotation not found")
    if txn.status != "quote_requested":
        raise HTTPException(status_code=400, detail="This quotation has already been handled")

    monthly = round(float(payload.monthly_usd or 0), 2)
    if monthly <= 0 or monthly > 100000:
        raise HTTPException(status_code=400, detail="Enter the agreed monthly price in USD")
    if payload.vehicles is not None and not (1 <= int(payload.vehicles) <= 100000):
        raise HTTPException(status_code=400, detail="Vehicles must be between 1 and 100000")

    yearly = (payload.billing_period or "").strip().lower().startswith("y")
    days = 365 if yearly else 30
    # Yearly is charged as ten months, the same rule as the self-serve plans.
    amount = round(monthly * 10 if yearly else monthly, 2)

    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == txn.tenant_id))
    ).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    now = datetime.datetime.now(datetime.timezone.utc)
    txn.amount_usd = amount
    txn.billing_period = "yearly" if yearly else "monthly"
    txn.status = "quote_approved"
    # Keep the paid-subscription healer from re-applying this record later.
    txn.wallet_credited = True
    if payload.vehicles is not None:
        txn.quote_vehicles = int(payload.vehicles)

    tenant.plan = "Enterprise"
    tenant.billing_cycle = "Yearly" if yearly else "Monthly"
    tenant.subscription_status = "active"
    tenant.next_billing_date = now + datetime.timedelta(days=days)

    db.add(AuditLog(
        user_id=current_user.id,
        tenant_id=current_user.tenant_id,
        action="ENTERPRISE_QUOTE_ACTIVATED",
        details={
            "quote_id": txn_id,
            "target_tenant": tenant.id,
            "monthly_usd": monthly,
            "billing_period": txn.billing_period,
            "amount_usd": amount,
        },
        ip_address="127.0.0.1",
    ))
    await db.commit()
    return {
        "reference": f"QTE-{txn.id}",
        "tenant_id": tenant.id,
        "plan": tenant.plan,
        "billing_cycle": tenant.billing_cycle,
        "amount_usd": amount,
        "next_billing_date": tenant.next_billing_date.isoformat() if tenant.next_billing_date else None,
    }

