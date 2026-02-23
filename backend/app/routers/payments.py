from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.db import get_db
from app.models import Tenant, Transaction, User
from app.auth_middleware import get_current_user
from paynow import Paynow
import os
import uuid
import time

router = APIRouter(prefix="/payments", tags=["payments"])

PAYNOW_ID = os.getenv("PAYNOW_ID", "17646") # Integration ID
PAYNOW_KEY = os.getenv("PAYNOW_KEY", "77f3e8b1-4d1a-4d12-8d1e-8d1e8d1e8d1e") # Integration Key

paynow = Paynow(
    PAYNOW_ID,
    PAYNOW_KEY,
    "https://inferth-mapping.up.railway.app/payments/paynow/webhook",
    "https://inferth-mapping.up.railway.app/"
)

@router.post("/paynow/initiate")
async def initiate_paynow(plan_name: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Calculate Price
    price_map = {"Basic": 12, "Professional": 17, "Enterprise": 100} # Enterprise placeholder
    amount = price_map.get(plan_name, 12)
    
    # Create Local Transaction
    txn = Transaction(
        tenant_id=current_user.tenant_id,
        amount_usd=amount,
        payment_method="paynow",
        status="pending"
    )
    db.add(txn)
    await db.commit()
    await db.refresh(txn)

    # Initiate Paynow
    payment = paynow.create_payment(f"INV-{txn.id}", current_user.email)
    payment.add(f"Inferth {plan_name} Subscription", amount)
    
    response = paynow.send(payment)
    
    if response.success:
        txn.paynow_reference = response.poll_url
        await db.commit()
        return {"redirect_url": response.redirect_url, "txn_id": txn.id}
    else:
        txn.status = "failed"
        await db.commit()
        raise HTTPException(status_code=500, detail="Failed to initiate Paynow")

@router.post("/manual/upload-pop")
async def upload_pop(
    file: UploadFile = File(...), 
    txn_id: int = None,
    db: AsyncSession = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    # 1. Identify or Create Transaction
    if not txn_id:
        txn = Transaction(
            tenant_id=current_user.tenant_id,
            amount_usd=-1.0, 
            payment_method="bank_transfer",
            status="approval_pending"
        )
        db.add(txn)
    else:
        result = await db.execute(select(Transaction).where(Transaction.id == txn_id))
        txn = result.scalars().first()
        if not txn or txn.tenant_id != current_user.tenant_id:
            raise HTTPException(status_code=404, detail="Transaction not found")
        txn.status = "approval_pending"
        txn.payment_method = "bank_transfer"

    # 2. Determine Upload Dir dynamically
    # backend/app/routers/payments.py -> app/routers -> app -> backend -> root -> frontend/uploads
    root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    upload_parent = os.path.join(root_dir, "frontend", "uploads")
    os.makedirs(upload_parent, exist_ok=True)
    
    file_uuid = uuid.uuid4()
    file_name = f"pop_{file_uuid}.png"
    file_path = os.path.join(upload_parent, file_name)
    
    with open(file_path, "wb") as f:
        f.write(await file.read())
    
    txn.proof_url = f"/static/uploads/{file_name}"
    await db.commit()
    
    return {"message": "POP uploaded. Waiting for manual approval.", "txn_id": txn.id}

@router.get("/status/{txn_id}")
async def get_payment_status(txn_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = await db.execute(select(Transaction).where(Transaction.id == txn_id))
    txn = result.scalars().first()
    if not txn or txn.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=404, detail="Transaction not found")
    
    # Optional: Poll Paynow if pending
    if txn.payment_method == "paynow" and txn.status == "pending" and txn.paynow_reference:
        status = paynow.check_transaction_status(txn.paynow_reference)
        if status.paid:
            txn.status = "paid"
            # Unlock Plan Logic
            result = await db.execute(select(Tenant).where(Tenant.id == txn.tenant_id))
            tenant = result.scalars().first()
            if tenant:
                tenant.subscription_status = "active"
            await db.commit()
            
    return {"status": txn.status, "method": txn.payment_method, "created_at": txn.created_at}
