from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession
import os
from sqlalchemy.future import select
from app.db import get_db
from app.models import Tenant, Transaction, User
from app.auth_middleware import get_current_user, require_admin
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
async def get_tracker_debug_logs():
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
