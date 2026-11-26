"""Customer-facing Billing tab for tenants billed by a reseller.

Every query is scoped to the caller's own tenant.  A customer can only read and
pay its own invoices, and the merchant credentials used are always the
reseller's own gateway — the customer never learns them.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_middleware import get_current_user, is_platform_admin, require_admin
from app.db import get_db
from app.models import (
    CustomerInvoice,
    Device,
    ManualPayment,
    Tenant,
    TenantGateway,
    Transaction,
    User,
    WalletLedger,
)
from app.services import customer_billing as cb
from app.services import usage_billing as ub

router = APIRouter(prefix="/customer-billing", tags=["customer-billing"])

TRANSACTION_STATES = {
    "paid": "successful",
    "pending": "pending",
    "approval_pending": "pending",
    "quote_requested": "pending",
    "failed": "failed",
    "cancelled": "failed",
    "rejected": "failed",
    "refunded": "refunded",
    "reversed": "reversed",
}


# ── Helpers ─────────────────────────────────────────────────────────────────

async def _current_tenant(db: AsyncSession, user: User) -> Tenant:
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == user.tenant_id))
    ).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Account not found")
    return tenant


async def _reseller_of(db: AsyncSession, tenant: Tenant) -> Optional[Tenant]:
    if not tenant.reseller_tenant_id or tenant.reseller_tenant_id == tenant.id:
        return None
    return (
        await db.execute(select(Tenant).where(Tenant.id == tenant.reseller_tenant_id))
    ).scalars().first()


async def _gateway_row(db: AsyncSession, tenant_id: int) -> Optional[TenantGateway]:
    return (
        await db.execute(select(TenantGateway).where(TenantGateway.tenant_id == tenant_id))
    ).scalars().first()


def _contact(gw: Optional[TenantGateway]) -> Dict[str, Any]:
    """Public contact/payment details. Never merchant ids or keys."""
    if not gw:
        return {
            "paynow_available": False,
            "manual_available": False,
            "ecocash_number": None,
            "ecocash_name": None,
            "whatsapp_number": None,
            "payment_instructions": None,
            "accept_manual_payments": False,
        }
    manual = bool(gw.accept_manual_payments) and bool(
        (gw.ecocash_number or "").strip() or (gw.whatsapp_number or "").strip()
    )
    return {
        "paynow_available": bool(gw.is_active and gw.merchant_id_enc and gw.merchant_key_enc),
        "manual_available": manual,
        "ecocash_number": gw.ecocash_number,
        "ecocash_name": gw.ecocash_name,
        "whatsapp_number": gw.whatsapp_number,
        "payment_instructions": gw.payment_instructions,
        "accept_manual_payments": bool(gw.accept_manual_payments),
    }


async def _reseller_paynow(db: AsyncSession, reseller_id: int):
    """The reseller's own Paynow client. Deliberately no platform fallback: a
    reseller customer must never be charged into another merchant account."""
    gw = await _gateway_row(db, reseller_id)
    if not gw or not gw.is_active or not gw.merchant_id_enc or not gw.merchant_key_enc:
        return None
    try:
        from paynow import Paynow

        from app.routers.payments import PAYNOW_RESULT_URL, PAYNOW_RETURN_URL
        from app.services.gateway_crypto import decrypt_credential

        merchant_id = decrypt_credential(gw.merchant_id_enc)
        merchant_key = decrypt_credential(gw.merchant_key_enc)
        if not merchant_id or not merchant_key:
            return None
        return Paynow(
            merchant_id,
            merchant_key,
            gw.webhook_url or PAYNOW_RESULT_URL,
            PAYNOW_RETURN_URL,
        )
    except Exception as exc:
        print(f"[customer_billing] reseller gateway unavailable: {exc}")
        return None


async def _own_invoice(db: AsyncSession, user: User, invoice_id: int) -> CustomerInvoice:
    invoice = (
        await db.execute(select(CustomerInvoice).where(CustomerInvoice.id == invoice_id))
    ).scalars().first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if not is_platform_admin(user) and invoice.tenant_id != user.tenant_id:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice


def _account_status(tenant: Tenant, invoices: List[CustomerInvoice]) -> str:
    today = ub.billing_day()
    statuses = [cb.invoice_status(inv, today) for inv in invoices]
    if "overdue" in statuses:
        return "overdue"
    state = (tenant.subscription_status or "active").strip().lower()
    if state in ("past_due", "overdue"):
        return "overdue"
    if state in ("canceled", "cancelled"):
        return "suspended"
    if state in ("suspended", "restricted"):
        return state
    if state in ("punished", "pending", "inactive"):
        return "pending"
    return "active" if state in ("active", "trialing", "") else state


async def _payd_block(db: AsyncSession, tenant: Tenant) -> Dict[str, Any]:
    today = ub.billing_day()
    day_start = dt.datetime.combine(today, dt.time.min, tzinfo=ub.BILLING_TZ)

    usage_total = (
        await db.execute(
            select(func.coalesce(func.sum(WalletLedger.amount_usd), 0)).where(
                WalletLedger.tenant_id == tenant.id,
                WalletLedger.kind == "usage",
            )
        )
    ).scalar()
    deposits_total = (
        await db.execute(
            select(func.coalesce(func.sum(WalletLedger.amount_usd), 0)).where(
                WalletLedger.tenant_id == tenant.id,
                WalletLedger.kind == "topup",
            )
        )
    ).scalar()
    today_usage = (
        await db.execute(
            select(func.coalesce(func.sum(WalletLedger.amount_usd), 0)).where(
                WalletLedger.tenant_id == tenant.id,
                WalletLedger.kind == "usage",
                WalletLedger.created_at >= day_start,
            )
        )
    ).scalar()

    ledger = (
        await db.execute(
            select(WalletLedger)
            .where(WalletLedger.tenant_id == tenant.id)
            .order_by(WalletLedger.id.desc())
            .limit(25)
        )
    ).scalars().all()
    daily = (
        await db.execute(
            select(WalletLedger)
            .where(
                WalletLedger.tenant_id == tenant.id,
                WalletLedger.kind == "usage",
            )
            .order_by(WalletLedger.id.desc())
            .limit(500)
        )
    ).scalars().all()

    by_day: Dict[str, Dict[str, Any]] = {}
    for row in daily:
        if row.created_at is None:
            continue
        key = ub.billing_day(row.created_at).isoformat()
        bucket = by_day.setdefault(key, {"day": key, "usd_billed": 0.0, "minutes": 0.0})
        amount = abs(float(row.amount_usd or 0))
        bucket["usd_billed"] = round(bucket["usd_billed"] + amount, 6)
        bucket["minutes"] = round(bucket["usd_billed"] / ub.RATE_PER_HOUR_USD * 60.0, 2)

    vehicles = await cb.vehicle_count(db, tenant.id)
    balance = cb.cash(ub.balance_of(tenant))
    daily_burn = round(ub.DAILY_CAP_USD * max(vehicles, 1), 2)

    return {
        "wallet_balance_usd": balance,
        "total_usage_usd": cb.cash(abs(float(usage_total or 0))),
        "total_deposits_usd": cb.cash(float(deposits_total or 0)),
        "today_usage_usd": cb.cash(abs(float(today_usage or 0))),
        "rate_per_hour_usd": ub.RATE_PER_HOUR_USD,
        "daily_cap_usd": ub.DAILY_CAP_USD,
        "daily_burn_usd": daily_burn,
        "estimated_days": int(balance // daily_burn) if balance > 0 and daily_burn > 0 else 0,
        "low_balance": balance < daily_burn,
        "wallet_min_usd": ub.WALLET_MIN_USD,
        "is_prepaid": ub.is_prepaid(tenant),
        "tracked_vehicles": vehicles,
        "daily": sorted(by_day.values(), key=lambda r: r["day"], reverse=True)[:14],
        "ledger": [
            {
                "id": row.id,
                "kind": row.kind,
                "amount_usd": cb.cash(row.amount_usd),
                "balance_after_usd": cb.cash(row.balance_after),
                "reference": row.reference,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in ledger
        ],
    }


# ── Overview ────────────────────────────────────────────────────────────────

@router.get("/overview")
async def billing_overview(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Summary cards, current subscription and package-specific billing details."""
    tenant = await _current_tenant(db, current_user)
    reseller = await _reseller_of(db, tenant)
    if not reseller:
        return {
            "linked": False,
            "reason": (
                "This account is billed directly by Inferth Mapping, so there is no "
                "reseller billing record to show."
            ),
        }

    try:
        created = await cb.ensure_current_invoice(db, tenant)
        if created:
            await db.commit()
    except Exception as exc:
        print(f"[customer_billing] invoice issue skipped: {exc}")
        await db.rollback()
        tenant = await _current_tenant(db, current_user)
        reseller = await _reseller_of(db, tenant)

    invoices = (
        await db.execute(
            select(CustomerInvoice)
            .where(CustomerInvoice.tenant_id == tenant.id)
            .order_by(CustomerInvoice.billing_period_start.desc())
        )
    ).scalars().all()

    today = ub.billing_day()
    open_invoices = [
        inv for inv in invoices if cb.invoice_status(inv, today) in ("unpaid", "partially_paid", "overdue")
    ]
    outstanding = round(sum(cb.invoice_outstanding(inv) for inv in open_invoices), 2)
    paid_total = round(
        sum(cb.cash(inv.amount_paid_usd) for inv in invoices if (inv.status or "") != "cancelled"),
        2,
    )

    package, package_label = cb.package_of(tenant)
    vehicles = await cb.vehicle_count(db, tenant.id)
    rate = cb.MONTHLY_RATE_PER_VEHICLE.get(package)
    total_subscription = cb.cash(rate * vehicles) if rate is not None else None

    next_amount: Optional[float] = None
    next_due: Optional[str] = None
    if open_invoices:
        nxt = sorted(open_invoices, key=lambda inv: (inv.due_date or today))[0]
        next_amount = cb.invoice_outstanding(nxt)
        next_due = nxt.due_date.isoformat() if nxt.due_date else None
    elif package in cb.RECURRING_PACKAGES:
        next_amount = total_subscription
        if tenant.next_billing_date:
            next_due = tenant.next_billing_date.date().isoformat()
        else:
            next_due = cb.next_month_start(today).isoformat()

    gw = await _gateway_row(db, reseller.id)
    contact = _contact(gw)

    payload: Dict[str, Any] = {
        "linked": True,
        "reseller": {
            "tenant_id": reseller.id,
            "name": reseller.name,
            "paynow_available": contact["paynow_available"],
            "manual_available": contact["manual_available"],
            "ecocash_number": contact["ecocash_number"],
            "ecocash_name": contact["ecocash_name"],
            "whatsapp_number": contact["whatsapp_number"],
            "payment_instructions": contact["payment_instructions"],
        },
        "account": {
            "tenant_id": tenant.id,
            "customer_name": tenant.name,
            "email": current_user.email,
            "phone": current_user.phone,
            "package": package,
            "package_label": package_label,
            "plan": tenant.plan,
            "billing_frequency": tenant.billing_cycle,
            "status": _account_status(tenant, invoices),
            "subscription_status": tenant.subscription_status,
            "vehicles": vehicles,
            "price_per_vehicle_usd": cb.cash(rate) if rate is not None else None,
            "total_subscription_usd": total_subscription,
            "started_at": tenant.created_at.date().isoformat() if tenant.created_at else None,
            "next_billing_date": tenant.next_billing_date.date().isoformat()
            if tenant.next_billing_date
            else None,
            "recurring": package in cb.RECURRING_PACKAGES,
        },
        "summary": {
            "outstanding_usd": outstanding,
            "paid_total_usd": paid_total,
            "next_payment_usd": next_amount,
            "next_due_date": next_due,
            "billing_status": _account_status(tenant, invoices),
            "open_invoices": len(open_invoices),
        },
        "recent_invoices": [cb.invoice_payload(inv, today) for inv in invoices[:5]],
        "payd": None,
        "lifetime": None,
    }

    if package == cb.PACKAGE_PAYD:
        payload["payd"] = await _payd_block(db, tenant)
    elif package == cb.PACKAGE_LIFETIME:
        paid_txn = (
            await db.execute(
                select(Transaction)
                .where(
                    Transaction.tenant_id == tenant.id,
                    Transaction.status == "paid",
                )
                .order_by(Transaction.id.desc())
                .limit(1)
            )
        ).scalars().first()
        payload["lifetime"] = {
            "once_off": True,
            "purchase_amount_usd": cb.cash(paid_txn.amount_usd) if paid_txn else None,
            "purchase_date": paid_txn.created_at.date().isoformat() if paid_txn and paid_txn.created_at else None,
            "payment_status": "paid" if paid_txn else "no payment on record",
            "receipt_transaction_id": paid_txn.id if paid_txn else None,
            "service_status": tenant.subscription_status or "active",
            "message": (
                "Lifetime Basic was bought once-off. There is no recurring subscription "
                "payment for this package."
            ),
        }
    elif package == cb.PACKAGE_ENTERPRISE:
        payload["enterprise"] = {
            "quoted": True,
            "message": "Enterprise is quoted per fleet. Your reseller issues invoices for the agreed amount.",
        }

    return payload


# ── Invoices ────────────────────────────────────────────────────────────────

@router.get("/invoices")
async def list_invoices(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tenant = await _current_tenant(db, current_user)
    rows = (
        await db.execute(
            select(CustomerInvoice)
            .where(CustomerInvoice.tenant_id == tenant.id)
            .order_by(CustomerInvoice.billing_period_start.desc())
            .limit(120)
        )
    ).scalars().all()
    today = ub.billing_day()
    return {"invoices": [cb.invoice_payload(inv, today) for inv in rows]}


@router.get("/invoices/{invoice_id}")
async def invoice_detail(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    invoice = await _own_invoice(db, current_user, invoice_id)
    customer = await _current_tenant(db, current_user)
    reseller = (
        await db.execute(select(Tenant).where(Tenant.id == invoice.reseller_tenant_id))
    ).scalars().first()
    gw = await _gateway_row(db, invoice.reseller_tenant_id) if invoice.reseller_tenant_id else None
    contact = _contact(gw)

    payments = (
        await db.execute(
            select(Transaction)
            .where(Transaction.invoice_id == invoice.id)
            .order_by(Transaction.id.desc())
        )
    ).scalars().all()

    return {
        **cb.invoice_payload(invoice),
        "line_items": invoice.line_items or [],
        "subtotal_usd": cb.cash(invoice.subtotal_usd),
        "tax_usd": cb.cash(invoice.tax_usd),
        "adjustments_usd": cb.cash(invoice.adjustments_usd),
        "currency": "USD",
        "reseller": {
            "name": reseller.name if reseller else "Inferth Mapping",
            "ecocash_number": contact["ecocash_number"],
            "ecocash_name": contact["ecocash_name"],
            "whatsapp_number": contact["whatsapp_number"],
            "payment_instructions": contact["payment_instructions"],
        },
        "customer": {
            "name": customer.name,
            "email": current_user.email,
            "phone": current_user.phone,
        },
        "payments": [_payment_payload(txn) for txn in payments],
    }


@router.get("/invoices/{invoice_id}/pdf")
async def invoice_pdf(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    invoice = await _own_invoice(db, current_user, invoice_id)
    customer = await _current_tenant(db, current_user)
    reseller = (
        await db.execute(select(Tenant).where(Tenant.id == invoice.reseller_tenant_id))
    ).scalars().first()
    gw = await _gateway_row(db, invoice.reseller_tenant_id) if invoice.reseller_tenant_id else None
    data = cb.invoice_pdf(
        invoice,
        customer,
        reseller,
        {
            "email": current_user.email,
            "phone": current_user.phone,
            **_contact(gw),
        },
    )
    filename = f"{invoice.invoice_number}.pdf"
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Payments ────────────────────────────────────────────────────────────────

def _payment_payload(txn: Transaction, invoice_number: Optional[str] = None) -> Dict[str, Any]:
    state = TRANSACTION_STATES.get((txn.status or "").lower(), (txn.status or "pending").lower())
    return {
        "transaction_id": txn.id,
        "reference": f"PAY-{txn.id}",
        "receipt_number": cb.receipt_number(txn),
        "date": txn.created_at.astimezone(dt.timezone.utc).isoformat() if txn.created_at else None,
        "amount_usd": cb.cash(txn.amount_usd),
        "method": txn.payment_method or "paynow",
        "provider": "Paynow" if (txn.payment_method or "").lower() in ("paynow", "ecocash", "onemoney") else "Manual",
        "invoice_number": invoice_number,
        "invoice_id": getattr(txn, "invoice_id", None),
        "status": state,
        "raw_status": txn.status,
        "receipt_available": (txn.status or "").lower() == "paid",
    }


@router.get("/payments")
async def payment_history(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tenant = await _current_tenant(db, current_user)
    rows = (
        await db.execute(
            select(Transaction)
            .where(
                Transaction.tenant_id == tenant.id,
                Transaction.payment_method != "quotation",
            )
            .order_by(Transaction.id.desc())
            .limit(100)
        )
    ).scalars().all()
    invoices = (
        await db.execute(
            select(CustomerInvoice).where(CustomerInvoice.tenant_id == tenant.id)
        )
    ).scalars().all()
    numbers = {inv.id: inv.invoice_number for inv in invoices}
    return {
        "payments": [
            _payment_payload(txn, numbers.get(getattr(txn, "invoice_id", None)))
            for txn in rows
        ]
    }


@router.get("/payments/{txn_id}/receipt")
async def payment_receipt(
    txn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    txn = (
        await db.execute(select(Transaction).where(Transaction.id == txn_id))
    ).scalars().first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if not is_platform_admin(current_user) and txn.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if (txn.status or "").lower() != "paid":
        raise HTTPException(status_code=400, detail="A receipt is only available for successful payments")

    customer = await _current_tenant(db, current_user)
    invoice = None
    if getattr(txn, "invoice_id", None):
        invoice = (
            await db.execute(select(CustomerInvoice).where(CustomerInvoice.id == txn.invoice_id))
        ).scalars().first()
    reseller_id = invoice.reseller_tenant_id if invoice else customer.reseller_tenant_id
    reseller = (
        await db.execute(select(Tenant).where(Tenant.id == reseller_id))
    ).scalars().first() if reseller_id else None
    gw = await _gateway_row(db, reseller_id) if reseller_id else None
    data = cb.receipt_pdf(
        txn,
        customer,
        reseller,
        {"email": current_user.email, "phone": current_user.phone, **_contact(gw)},
        invoice.invoice_number if invoice else None,
    )
    filename = f"{cb.receipt_number(txn)}.pdf"
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Payment methods and initiation ──────────────────────────────────────────

@router.get("/methods")
async def payment_methods(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tenant = await _current_tenant(db, current_user)
    reseller = await _reseller_of(db, tenant)
    if not reseller:
        raise HTTPException(status_code=404, detail="No reseller billing account")
    gw = await _gateway_row(db, reseller.id)
    contact = _contact(gw)
    methods = []
    if contact["paynow_available"]:
        methods.append({
            "key": "paynow",
            "label": "Card / Zimswitch / EcoCash / OneMoney",
            "description": "Secure Paynow checkout. You are redirected to Paynow to authorise the payment.",
            "kind": "online",
        })
    if (contact["ecocash_number"] or "").strip():
        methods.append({
            "key": "ecocash",
            "label": f"EcoCash to {contact['ecocash_number']}",
            "description": "Send the amount by EcoCash and submit the transaction code below.",
            "kind": "manual",
        })
    if (contact["whatsapp_number"] or "").strip():
        methods.append({
            "key": "whatsapp",
            "label": f"WhatsApp proof to {contact['whatsapp_number']}",
            "description": "Send your proof of payment on WhatsApp and it will be verified.",
            "kind": "manual",
        })
    return {
        "reseller_name": reseller.name,
        **{k: v for k, v in contact.items()},
        "methods": methods,
    }


class InvoicePayRequest(BaseModel):
    method: str = Field("paynow", description="paynow | ecocash | onemoney")
    phone: Optional[str] = None


@router.post("/invoices/{invoice_id}/pay")
async def pay_invoice(
    invoice_id: int,
    payload: InvoicePayRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Start a payment for one outstanding invoice through the reseller's gateway."""
    invoice = await _own_invoice(db, current_user, invoice_id)
    outstanding = cb.invoice_outstanding(invoice)
    if outstanding <= cb.PAID_EPSILON:
        raise HTTPException(status_code=400, detail="This invoice has no outstanding balance")

    customer = await _current_tenant(db, current_user)
    reseller = (
        await db.execute(select(Tenant).where(Tenant.id == invoice.reseller_tenant_id))
    ).scalars().first()
    if not reseller:
        raise HTTPException(status_code=400, detail="Invoice has no reseller account")

    active_paynow = await _reseller_paynow(db, reseller.id)
    if active_paynow is None:
        raise HTTPException(
            status_code=503,
            detail="Your provider has not enabled online payments. Use the manual payment option instead.",
        )

    method = (payload.method or "paynow").strip().lower()
    if method not in ("paynow", "ecocash", "onemoney"):
        raise HTTPException(status_code=400, detail="Unsupported payment method")

    txn = Transaction(
        tenant_id=customer.id,
        amount_usd=outstanding,
        plan_name=f"Invoice_{invoice.invoice_number}",
        billing_period="invoice",
        payment_method=method,
        status="pending",
        invoice_id=invoice.id,
    )
    db.add(txn)
    await db.commit()
    await db.refresh(txn)

    item_label = f"{reseller.name} — Invoice {invoice.invoice_number}"
    payment = active_paynow.create_payment(
        f"INV-{txn.id}", current_user.email or f"customer{customer.id}@inferthmapping.co.zw"
    )
    payment.add(item_label, outstanding)

    if method in ("ecocash", "onemoney"):
        phone = (payload.phone or current_user.phone or "").strip()
        clean = phone.replace(" ", "").replace("-", "")
        if clean.startswith("+263"):
            clean = "0" + clean[4:]
        elif clean.startswith("263"):
            clean = "0" + clean[3:]
        if len(clean) < 9:
            raise HTTPException(status_code=400, detail="Enter the mobile money number to charge")
        response = active_paynow.send_mobile(payment, clean, method)
        if not response.success:
            txn.status = "failed"
            await db.commit()
            raise HTTPException(
                status_code=400,
                detail=str(getattr(response, "error", "Mobile money payment could not be started")),
            )
        txn.paynow_reference = response.poll_url
        await db.commit()
        return {
            "status": "pending",
            "txn_id": txn.id,
            "amount_usd": outstanding,
            "instructions": getattr(
                response,
                "instructions",
                f"Authorise the ${outstanding:.2f} prompt on your {method.title()} phone.",
            ),
        }

    response = active_paynow.send(payment)
    if not response.success:
        txn.status = "failed"
        await db.commit()
        raise HTTPException(status_code=502, detail="The payment provider could not start the checkout")

    txn.paynow_reference = response.poll_url
    await db.commit()
    return {
        "status": "pending",
        "txn_id": txn.id,
        "amount_usd": outstanding,
        "redirect_url": response.redirect_url,
    }


@router.get("/payments/{txn_id}/status")
async def payment_status(
    txn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Confirm a pending invoice payment with the provider (never the browser)."""
    txn = (
        await db.execute(select(Transaction).where(Transaction.id == txn_id))
    ).scalars().first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if not is_platform_admin(current_user) and txn.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if (txn.status or "").lower() == "pending":
        from app.routers.payments import _refresh_paynow_status

        txn = await _refresh_paynow_status(db, txn)

    invoice_number = None
    if getattr(txn, "invoice_id", None):
        inv = (
            await db.execute(select(CustomerInvoice).where(CustomerInvoice.id == txn.invoice_id))
        ).scalars().first()
        invoice_number = inv.invoice_number if inv else None
    return _payment_payload(txn, invoice_number)


class ManualPaymentRequest(BaseModel):
    invoice_id: Optional[int] = None
    amount_usd: float = Field(..., gt=0)
    payer_name: str = Field(..., min_length=2, max_length=100)
    payer_phone: str = Field(..., min_length=6, max_length=50)
    reference_code: Optional[str] = Field(None, max_length=100)
    proof_image_data: Optional[str] = None
    notes: Optional[str] = None


@router.post("/manual-payments")
async def submit_manual_payment(
    payload: ManualPaymentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Submit an EcoCash / WhatsApp proof of payment to the reseller for approval."""
    customer = await _current_tenant(db, current_user)
    reseller = await _reseller_of(db, customer)
    if not reseller:
        raise HTTPException(status_code=404, detail="No reseller billing account")

    gw = await _gateway_row(db, reseller.id)
    contact = _contact(gw)
    if not contact["accept_manual_payments"]:
        raise HTTPException(status_code=400, detail="Your provider does not accept manual payments")

    invoice = None
    if payload.invoice_id:
        invoice = await _own_invoice(db, current_user, payload.invoice_id)

    payment = ManualPayment(
        tenant_id=reseller.id,
        customer_tenant_id=customer.id,
        invoice_id=invoice.id if invoice else None,
        payer_name=payload.payer_name.strip(),
        payer_phone=payload.payer_phone.strip(),
        amount_usd=round(float(payload.amount_usd), 2),
        reference_code=(payload.reference_code or "").strip(),
        proof_image_data=payload.proof_image_data,
        notes=payload.notes,
        status="pending",
    )
    db.add(payment)
    await db.commit()
    await db.refresh(payment)

    text = (
        f"Payment submitted for verification (#{payment.id})\n"
        f"Customer: {customer.name}\n"
        f"Payer: {payment.payer_name} | {payment.payer_phone}\n"
        f"Amount: ${payment.amount_usd:.2f}\n"
        + (f"Invoice: {invoice.invoice_number}\n" if invoice else "")
        + (f"Reference: {payment.reference_code}\n" if payment.reference_code else "")
        + "Confirm it under Settings \u2192 Pending payment approvals."
    )
    try:
        from app.services.whatsapp import send_whatsapp

        numbers = (
            await db.execute(
                select(User.phone).where(
                    User.tenant_id == reseller.id,
                    User.role.in_(["admin", "super_admin"]),
                    User.phone.is_not(None),
                )
            )
        ).all()
        for row in numbers:
            if row[0]:
                asyncio.create_task(send_whatsapp(str(row[0]).strip(), text))
    except Exception as exc:
        print(f"[customer_billing] manual payment notification skipped: {exc}")

    return {
        "status": "pending",
        "payment_id": payment.id,
        "reference": f"MAN-{payment.id}",
        "message": (
            f"Proof of payment submitted. {reseller.name} will verify it and confirm your invoice."
        ),
    }


@router.post("/manual-payments/{payment_id}/confirm")
async def confirm_manual_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Reseller admin: verify a customer's manual payment and apply it."""
    payment = (
        await db.execute(select(ManualPayment).where(ManualPayment.id == payment_id))
    ).scalars().first()
    if not payment or not payment.customer_tenant_id:
        raise HTTPException(status_code=404, detail="Payment record not found")
    if not is_platform_admin(current_user) and payment.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Unauthorized")

    payment.status = "confirmed"
    payment.confirmed_by = current_user.email
    payment.confirmed_at = dt.datetime.now(dt.timezone.utc)
    result = await cb.settle_manual_payment(db, payment)
    await db.commit()
    return {"status": "confirmed", "payment_id": payment.id, "result": result}


@router.post("/manual-payments/{payment_id}/reject")
async def reject_manual_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    payment = (
        await db.execute(select(ManualPayment).where(ManualPayment.id == payment_id))
    ).scalars().first()
    if not payment or not payment.customer_tenant_id:
        raise HTTPException(status_code=404, detail="Payment record not found")
    if not is_platform_admin(current_user) and payment.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Unauthorized")
    payment.status = "rejected"
    await db.commit()
    return {"status": "rejected", "payment_id": payment.id}


# ── Reseller-side customer linking ──────────────────────────────────────────

@router.get("/customers")
async def list_my_customers(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Reseller admin: the customer accounts billed through this tenant."""
    if is_platform_admin(current_user) and not current_user.tenant_id:
        raise HTTPException(status_code=400, detail="Choose a company first")
    tenants = (
        await db.execute(
            select(Tenant)
            .where(Tenant.reseller_tenant_id == current_user.tenant_id)
            .order_by(Tenant.name.asc())
        )
    ).scalars().all()
    today = ub.billing_day()
    output = []
    for tenant in tenants:
        invoices = (
            await db.execute(
                select(CustomerInvoice).where(CustomerInvoice.tenant_id == tenant.id)
            )
        ).scalars().all()
        package, package_label = cb.package_of(tenant)
        output.append({
            "tenant_id": tenant.id,
            "name": tenant.name,
            "package": package,
            "package_label": package_label,
            "vehicles": await cb.vehicle_count(db, tenant.id),
            "outstanding_usd": round(
                sum(
                    cb.invoice_outstanding(inv)
                    for inv in invoices
                    if cb.invoice_status(inv, today) in ("unpaid", "partially_paid", "overdue")
                ),
                2,
            ),
            "billing_status": _account_status(tenant, invoices),
        })
    return {"customers": output}


class LinkCustomerRequest(BaseModel):
    tenant_id: int


@router.post("/customers")
async def link_customer(
    payload: LinkCustomerRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Reseller admin: attach a customer account to this reseller for billing."""
    if not current_user.tenant_id:
        raise HTTPException(status_code=400, detail="No company on this account")
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == payload.tenant_id))
    ).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Account not found")
    if tenant.id == current_user.tenant_id:
        raise HTTPException(status_code=400, detail="An account cannot be its own customer")
    if not is_platform_admin(current_user) and tenant.reseller_tenant_id not in (None, current_user.tenant_id):
        raise HTTPException(status_code=409, detail="That account is billed by another provider")
    tenant.reseller_tenant_id = current_user.tenant_id
    await db.commit()
    return {"status": "linked", "tenant_id": tenant.id, "reseller_tenant_id": current_user.tenant_id}
