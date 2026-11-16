from fastapi import APIRouter, Request, Depends, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.responses import RedirectResponse
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, or_, update
from app.db import get_db
from app.models import Device, Tenant, Transaction, User
from app.auth_middleware import get_current_user
from paynow import Paynow
import os
import uuid
import time

router = APIRouter(prefix="/payments", tags=["payments"])

# Paynow credentials come from the environment only — never a code default.
# (The integration key previously committed here must be considered leaked:
# rotate it in the Paynow merchant portal.)
# Accept both naming conventions used across docs and deployments.
PAYNOW_ID = os.getenv("PAYNOW_ID", "") or os.getenv("PAYNOW_INTEGRATION_ID", "")
PAYNOW_KEY = os.getenv("PAYNOW_KEY", "") or os.getenv("PAYNOW_INTEGRATION_KEY", "")
PAYNOW_RESULT_URL = os.getenv(
    "PAYNOW_RESULT_URL",
    "https://inferth-mapping.up.railway.app/payments/paynow/webhook",
)
# Where Paynow sends the customer's browser after checkout. It must be the
# app's own page (not the webhook), so the customer lands on Billing and sees
# whether their payment succeeded.
PAYNOW_RETURN_URL = os.getenv(
    "PAYNOW_RETURN_URL",
    "https://www.inferthmapping.co.zw/static/index.html?payment=return",
)

paynow = Paynow(
    PAYNOW_ID,
    PAYNOW_KEY,
    PAYNOW_RESULT_URL,
    PAYNOW_RETURN_URL,
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
    
    # Server-side prices. The browser may pass an amount, but it is only accepted
    # when it matches what the product costs — a dropped query parameter can no
    # longer silently charge a different price.
    price_map = {
        "Basic": 15.0,
        "Premium": 25.0,
        "Professional": 25.0,
        "Enterprise": 100.0,
        "Fleet": 25.0,
        "Fleet_Starter": 12.0,
        "Console_Rental": 15.0,
        "Console_Base_5": 15.0,
        "Console_Growth_25": 49.0,
        "Console_Scale_100": 119.0,
    }
    TOPUP_PLAN = "Prepaid_Wallet_Topup"
    TOPUP_AMOUNTS = {12.0, 24.0, 40.0, 100.0}

    is_topup = plan_name == TOPUP_PLAN
    if is_topup:
        if amount is None or round(float(amount), 2) not in TOPUP_AMOUNTS:
            raise HTTPException(
                status_code=400,
                detail="Choose a valid wallet top-up amount (12, 24, 40 or 100 USD)",
            )
        charge_amount = round(float(amount), 2)
    elif amount is not None and float(amount) > 0:
        charge_amount = round(float(amount), 2)
        expected = price_map.get(plan_name)
        if expected is not None and abs(charge_amount - expected) > 0.001:
            raise HTTPException(
                status_code=400,
                detail=f"Amount ${charge_amount:.2f} does not match the price of {plan_name} (${expected:.2f})",
            )
    else:
        charge_amount = price_map.get(plan_name, 12.0)

    # Create Local Transaction record
    txn = Transaction(
        tenant_id=current_user.tenant_id,
        amount_usd=charge_amount,
        plan_name=plan_name,
        payment_method="paynow",
        status="pending",
    )
    db.add(txn)
    await db.commit()
    await db.refresh(txn)

    # Initiate Paynow via official SDK
    item_label = (
        f"Inferth Prepaid Wallet Top-up ${charge_amount:.2f}"
        if is_topup
        else f"Inferth {plan_name} Subscription"
    )
    payment = paynow.create_payment(f"INV-{txn.id}", current_user.email or "billing@inferthmapping.co.zw")
    payment.add(item_label, charge_amount)
    
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
    
    price_map = {"Basic": 15.0, "Premium": 25.0, "Professional": 25.0, "Enterprise": 100.0, "Fleet": 25.0, "Console_Rental": 15.0}
    if amount is not None and float(amount) > 0:
        charge_amount = round(float(amount), 2)
    else:
        charge_amount = price_map.get(plan_name, 12.0)
    
    txn = Transaction(
        tenant_id=current_user.tenant_id,
        amount_usd=charge_amount,
        plan_name=plan_name,
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


@router.get("/paynow/webhook")
async def paynow_webhook_browser():
    """Paynow only POSTs to the webhook; a browser that lands here (because the
    integration's return URL points at it) is sent back to the app instead of a
    bare 405."""
    return RedirectResponse(PAYNOW_RETURN_URL, status_code=303)


def _paynow_failure_reason(txn: Transaction) -> Optional[str]:
    """Customer-facing explanation for a payment that did not succeed."""
    raw = (txn.paynow_status or "").strip()
    low = raw.lower()
    if "cancel" in low:
        return "The payment was cancelled on Paynow. No money was taken and no subscription was activated."
    if "insufficient" in low:
        return "Paynow declined the payment because there were insufficient funds. Top up and try again."
    if any(key in low for key in ("fail", "declin", "error", "disallow", "invalid")):
        label = raw or "failed"
        return f"Paynow reported this payment as {label}. No subscription was activated."
    if txn.status in ("failed", "cancelled", "rejected"):
        return "Paynow could not complete the payment. Try another method (EcoCash, OneMoney or card) or contact support with your invoice reference."
    return None


async def _refresh_paynow_status(db: AsyncSession, txn: Optional[Transaction]) -> Optional[Transaction]:
    """Ask Paynow for the current status and persist it. Safe to call repeatedly."""
    if not txn or not txn.paynow_reference:
        return txn
    try:
        status = paynow.check_transaction_status(txn.paynow_reference)
    except Exception:
        return txn

    raw = str(getattr(status, "status", "") or "")
    if raw:
        txn.paynow_status = raw

    if bool(getattr(status, "paid", False)):
        txn.status = "paid"
        tenant = (
            await db.execute(select(Tenant).where(Tenant.id == txn.tenant_id))
        ).scalars().first()
        if tenant:
            if txn.plan_name == "Prepaid_Wallet_Topup":
                # Credit the wallet exactly once, even if the webhook and the
                # browser's status poll race each other.
                claim = await db.execute(
                    update(Transaction)
                    .where(
                        Transaction.id == txn.id,
                        or_(
                            Transaction.wallet_credited.is_(None),
                            Transaction.wallet_credited.is_(False),
                        ),
                    )
                    .values(wallet_credited=True)
                )
                if claim.rowcount:
                    tenant.wallet_balance_usd = round(
                        float(tenant.wallet_balance_usd or 0) + float(txn.amount_usd or 0), 2
                    )
            else:
                tenant.subscription_status = "active"
    else:
        low = raw.lower()
        if "cancel" in low:
            txn.status = "cancelled"
        elif any(key in low for key in ("fail", "declin", "insufficient", "error", "invalid")):
            txn.status = "failed"

    try:
        await db.commit()
    except Exception:
        await db.rollback()
    return txn


def _payment_payload(txn: Transaction) -> dict:
    return {
        "found": True,
        "transaction_id": txn.id,
        "status": txn.status or "pending",
        "paynow_status": txn.paynow_status,
        "amount": txn.amount_usd,
        "reference": f"INV-{txn.id}",
        "product": (
            "Prepaid Wallet top-up" if txn.plan_name == "Prepaid_Wallet_Topup" else (txn.plan_name or "Subscription")
        ),
        "reason": None if txn.status == "paid" else _paynow_failure_reason(txn),
        "created_at": txn.created_at.isoformat() if txn.created_at else None,
    }


@router.get("/paynow/latest")
async def latest_paynow_payment(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The customer's most recent Paynow attempt, used by the return-to-billing banner."""
    txn = (
        await db.execute(
            select(Transaction)
            .where(Transaction.tenant_id == current_user.tenant_id)
            .where(Transaction.payment_method == "paynow")
            .order_by(Transaction.id.desc())
            .limit(1)
        )
    ).scalars().first()
    if not txn:
        return {"found": False}
    if txn.status == "pending":
        txn = await _refresh_paynow_status(db, txn)
    return _payment_payload(txn)


@router.post("/subscription/cancel")
async def cancel_subscription(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Cancel the tenant's subscription so a different plan can be chosen."""
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == current_user.tenant_id))
    ).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if (tenant.subscription_status or "").lower() != "cancelled":
        tenant.subscription_status = "cancelled"
        tenant.next_billing_date = None
        await db.commit()

    return {
        "status": "cancelled",
        "plan": tenant.plan,
        "wallet_balance_usd": round(float(tenant.wallet_balance_usd or 0), 2),
    }


@router.get("/wallet")
async def prepaid_wallet(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Prepaid Fleet Wallet balance, billed at $0.40 per active vehicle per day."""
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == current_user.tenant_id))
    ).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    vehicles = (
        await db.execute(
            select(func.count(Device.id)).where(Device.tenant_id == current_user.tenant_id)
        )
    ).scalar() or 0
    balance = round(float(tenant.wallet_balance_usd or 0), 2)
    daily_rate = 0.40
    per_day = round(daily_rate * max(int(vehicles), 1), 2)
    return {
        "balance_usd": balance,
        "daily_rate_per_vehicle": daily_rate,
        "tracked_vehicles": int(vehicles),
        "estimated_days": int(balance // per_day) if balance > 0 else 0,
        "daily_burn_usd": per_day,
    }


@router.get("/paynow/status/{txn_id}")
async def paynow_transaction_status(
    txn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Re-check one transaction (used to poll while Paynow confirms)."""
    txn = (
        await db.execute(select(Transaction).where(Transaction.id == txn_id))
    ).scalars().first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if current_user.tenant_id != 1 and txn.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if txn.status == "pending":
        txn = await _refresh_paynow_status(db, txn)
    return _payment_payload(txn)


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

    await _refresh_paynow_status(db, txn)
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
