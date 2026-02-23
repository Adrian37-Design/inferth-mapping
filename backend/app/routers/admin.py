from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db import get_db
from app.models import Tenant, Transaction, User
from app.auth import get_current_user
import datetime

router = APIRouter(prefix="/admin", tags=["admin"])

@router.patch("/payments/{txn_id}/approve")
async def approve_payment(
    txn_id: int, 
    db: Session = Depends(get_db), 
    current_user = Depends(get_current_user)
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    txn = db.query(Transaction).filter(Transaction.id == txn_id).first()
    if not txn: raise HTTPException(status_code=404, detail="Transaction not found")
    
    if txn.status == "paid":
        return {"message": "Transaction already approved"}

    # Update Transaction Status
    txn.status = "paid"
    
    # Update Tenant Subscription
    tenant = db.query(Tenant).filter(Tenant.id == txn.tenant_id).first()
    if tenant:
        tenant.subscription_status = "active"
        # Set next billing to 30 days from now
        tenant.next_billing_date = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30)
    
    db.commit()
    return {"message": f"Payment approved for {tenant.name}. Subscription active until {tenant.next_billing_date}"}

@router.get("/payments/pending")
async def list_pending_payments(
    db: Session = Depends(get_db), 
    current_user = Depends(get_current_user)
):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    return db.query(Transaction).filter(Transaction.status == "approval_pending").all()
