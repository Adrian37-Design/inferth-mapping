from fastapi import APIRouter, Request, Depends, HTTPException, UploadFile, File, BackgroundTasks
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

# Paynow credentials come from the environment only — never a code default.
# (The integration key previously committed here must be considered leaked:
# rotate it in the Paynow merchant portal.)
PAYNOW_ID = os.getenv("PAYNOW_ID", "")
PAYNOW_KEY = os.getenv("PAYNOW_KEY", "")

paynow = Paynow(
    PAYNOW_ID,
    PAYNOW_KEY,
    "https://inferth-mapping.up.railway.app/payments/paynow/webhook",
    "https://inferth-mapping.up.railway.app/"
)

ALLOWED_UPLOAD_TYPES = {
    b"\x89PNG": ".png",
    b"\xff\xd8\xff": ".jpg",
    b"%PDF": ".pdf",
}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024

def _upload_extension(data: bytes):
    for magic, ext in ALLOWED_UPLOAD_TYPES.items():
        if data.startswith(magic):
            return ext
    return None

@router.post("/paynow/initiate")
async def initiate_paynow(
    plan_name: str, 
    amount: float = None,
    db: AsyncSession = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    """
    Initiates standard Paynow Web Checkout using the official Paynow Python SDK.
    Supports Visa, Mastercard, Zimswitch, EcoCash, and OneMoney via redirect.
    """
    if not PAYNOW_ID or not PAYNOW_KEY:
        raise HTTPException(status_code=503, detail="Online payments are not configured")
    
    # Determine billing price
    price_map = {"Basic": 12.0, "Professional": 17.0, "Enterprise": 100.0, "Fleet": 17.0}
    if amount is not None and float(amount) > 0:
        charge_amount = round(float(amount), 2)
    else:
        charge_amount = price_map.get(plan_name, 12.0)
    
    # Create Local Transaction record
    txn = Transaction(
        tenant_id=current_user.tenant_id,
        amount_usd=charge_amount,
        payment_method="paynow",
        status="pending"
    )
    db.add(txn)
    await db.commit()
    await db.refresh(txn)

    # Initiate Paynow via official SDK
    payment = paynow.create_payment(f"INV-{txn.id}", current_user.email or "billing@inferthmapping.co.zw")
    payment.add(f"Inferth {plan_name} Subscription", charge_amount)
    
    response = paynow.send(payment)
    
    if response.success:
        txn.paynow_reference = response.poll_url
        await db.commit()
        return {
            "redirect_url": response.redirect_url, 
            "poll_url": response.poll_url,
            "txn_id": txn.id,
            "amount": charge_amount
        }
    else:
        txn.status = "failed"
        await db.commit()
        raise HTTPException(status_code=500, detail="Failed to initiate Paynow payment session")


@router.post("/paynow/mobile")
async def initiate_paynow_mobile(
    plan_name: str,
    phone: str,
    method: str = "ecocash",
    amount: float = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Initiates express mobile checkout via EcoCash or OneMoney USSD push
    using Paynow Python SDK's send_mobile() method.
    """
    if not PAYNOW_ID or not PAYNOW_KEY:
        raise HTTPException(status_code=503, detail="Online payments are not configured")
    
    method_clean = method.lower().strip()
    if method_clean not in ["ecocash", "onemoney"]:
        raise HTTPException(status_code=400, detail="Supported mobile money methods: 'ecocash' or 'onemoney'")
    
    clean_phone = phone.strip().replace(" ", "").replace("-", "")
    if clean_phone.startswith("+263"):
        clean_phone = "0" + clean_phone[4:]
    elif clean_phone.startswith("263"):
        clean_phone = "0" + clean_phone[3:]
    
    price_map = {"Basic": 12.0, "Professional": 17.0, "Enterprise": 100.0, "Fleet": 17.0}
    if amount is not None and float(amount) > 0:
        charge_amount = round(float(amount), 2)
    else:
        charge_amount = price_map.get(plan_name, 12.0)
    
    txn = Transaction(
        tenant_id=current_user.tenant_id,
        amount_usd=charge_amount,
        payment_method=method_clean,
        status="pending"
    )
    db.add(txn)
    await db.commit()
    await db.refresh(txn)

    payment = paynow.create_payment(f"INV-{txn.id}", current_user.email or f"{clean_phone}@inferthmapping.co.zw")
    payment.add(f"Inferth {plan_name}", charge_amount)
    
    response = paynow.send_mobile(payment, clean_phone, method_clean)
    
    if response.success:
        txn.paynow_reference = response.poll_url
        await db.commit()
        return {
            "success": True,
            "instructions": getattr(response, 'instructions', f"Please check your {method_clean.title()} phone prompt to enter PIN and authorize ${charge_amount} USD."),
            "poll_url": response.poll_url,
            "txn_id": txn.id
        }
    else:
        txn.status = "failed"
        await db.commit()
        error_msg = getattr(response, 'error', "Failed to initiate mobile money payment")
        raise HTTPException(status_code=400, detail=str(error_msg))


@router.post("/paynow/webhook")
async def paynow_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """
    Paynow IPN (Instant Payment Notification) Webhook.
    Called automatically by Paynow when transaction status changes.
    """
    form_data = await request.form()
    poll_url = form_data.get("pollurl")
    reference = form_data.get("reference")
    
    if not poll_url and not reference:
        return {"status": "ignored"}
    
    # Query Transaction by reference or poll_url
    txn = None
    if poll_url:
        result = await db.execute(select(Transaction).where(Transaction.paynow_reference == str(poll_url)))
        txn = result.scalars().first()
    
    if not txn and reference and reference.startswith("INV-"):
        try:
            t_id = int(reference.replace("INV-", ""))
            result = await db.execute(select(Transaction).where(Transaction.id == t_id))
            txn = result.scalars().first()
        except Exception:
            pass
            
    if txn and txn.paynow_reference:
        try:
            status = paynow.check_transaction_status(txn.paynow_reference)
            if status.paid:
                txn.status = "paid"
                # Activate Tenant Subscription
                tenant_res = await db.execute(select(Tenant).where(Tenant.id == txn.tenant_id))
                tenant = tenant_res.scalars().first()
                if tenant:
                    tenant.subscription_status = "active"
                await db.commit()
        except Exception as e:
            pass
            
    return {"status": "ok"}

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

    # 2. Validate the upload: size cap, extension/MIME from the actual bytes
    # (filename is attacker-controlled and ignored for the stored type).
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 5 MB)")
    ext = _upload_extension(data)
    if ext is None:
        raise HTTPException(status_code=400, detail="Only PNG, JPEG or PDF proofs are accepted")

    # 3. Determine Upload Dir dynamically
    # backend/app/routers/payments.py -> app/routers -> app -> backend -> root -> frontend/uploads
    root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    upload_parent = os.path.join(root_dir, "frontend", "uploads")
    os.makedirs(upload_parent, exist_ok=True)

    file_uuid = uuid.uuid4()
    file_name = f"pop_{file_uuid}{ext}"
    file_path = os.path.join(upload_parent, file_name)

    with open(file_path, "wb") as f:
        f.write(data)

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
