from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
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
