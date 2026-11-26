"""
resellers.py — Platform Fleet Rental API routes.

Provides endpoints for:
1. Reseller Tenants:
   - View their Platform Fleet Rental plan and status (Model A or Model B)
   - Inspect billable vehicle count breakdown
   - View monthly wholesale invoices
   - View commission ledgers (Model B)
   - Configure per-tenant Paynow merchant gateway credentials
2. Super Admin:
   - Manage reseller commercial contracts (models, rates, status)
   - Inspect active billable vehicle calculations
   - Generate, view and manage reseller monthly invoices
   - Pricing benchmark calculator
"""

from __future__ import annotations

import asyncio
import datetime
from typing import Optional, Any
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, update

from app.db import get_db
from app.models import (
    Tenant, User, Device, ResellerContract, TenantGateway,
    ResellerInvoice, ResellerCommissionLedger, ManualPayment
)
from app.auth_middleware import get_current_user, require_admin, require_super_admin, is_platform_admin
from app.services.reseller_billing import (
    compute_model_a_wholesale,
    compute_model_b_commission,
    compute_lifetime_hosting,
    compute_monthly_charge,
    get_active_billable_vehicle_count,
    get_active_lifetime_vehicle_count,
    DEFAULT_MODEL_A_BANDS,
    DEFAULT_COMMISSION_PCT,
    DEFAULT_MIN_CONTRIBUTION_USD,
    DEFAULT_LIFETIME_HOSTING_USD,
)
from app.services.reseller_invoicing import generate_monthly_invoice, run_monthly_invoicing
from app.services.gateway_crypto import (
    encrypt_credential, decrypt_credential, mask_credential
)

router = APIRouter(prefix="/resellers", tags=["resellers"])
admin_router = APIRouter(prefix="/admin/resellers", tags=["resellers-admin"])


# ─── PYDANTIC SCHEMAS ────────────────────────────────────────────────────────

class GatewayConfigRequest(BaseModel):
    merchant_id: Optional[str] = Field(None, description="Paynow Integration ID")
    merchant_key: Optional[str] = Field(None, description="Paynow Integration Key")
    gateway_name: str = "paynow"
    is_active: bool = True
    webhook_url: Optional[str] = None
    # Direct EcoCash & WhatsApp Manual Payment Support
    ecocash_number: Optional[str] = Field(None, description="EcoCash or mobile money phone number")
    ecocash_name: Optional[str] = Field(None, description="Registered name on EcoCash")
    whatsapp_number: Optional[str] = Field(None, description="WhatsApp number for proof of payment")
    payment_instructions: Optional[str] = Field(None, description="Custom payment instructions for clients")
    accept_manual_payments: bool = True


class ManualPaymentCreateRequest(BaseModel):
    payer_name: str = Field(..., min_length=2, max_length=100)
    payer_phone: str = Field(..., min_length=6, max_length=50)
    amount_usd: float = Field(..., gt=0)
    reference_code: Optional[str] = None
    proof_image_data: Optional[str] = None
    notes: Optional[str] = None
    tenant_id: Optional[int] = None
    # Package request fields
    num_vehicles: Optional[int] = Field(None, ge=1, le=1000)
    package_tier: Optional[str] = Field(None, description="basic | premium | enterprise")
    payment_plan: Optional[str] = Field(None, description="monthly | onceoff_lifetime | payd")


class ContractCreateRequest(BaseModel):
    tenant_id: int
    model: str = Field("MODEL_A", description="MODEL_A (Wholesale) or MODEL_B (RevShare)")
    status: str = "active"
    commission_pct: float = DEFAULT_COMMISSION_PCT
    min_platform_contribution_usd: float = DEFAULT_MIN_CONTRIBUTION_USD
    lifetime_hosting_per_vehicle_usd: float = DEFAULT_LIFETIME_HOSTING_USD
    custom_pricing_json: Optional[dict[str, Any]] = None
    billing_day_of_month: int = 1
    notes: Optional[str] = None


class ContractUpdateRequest(BaseModel):
    model: Optional[str] = None
    status: Optional[str] = None
    commission_pct: Optional[float] = None
    min_platform_contribution_usd: Optional[float] = None
    lifetime_hosting_per_vehicle_usd: Optional[float] = None
    custom_pricing_json: Optional[dict[str, Any]] = None
    billing_day_of_month: Optional[int] = None
    notes: Optional[str] = None


class InvoiceStatusUpdateRequest(BaseModel):
    status: str = Field(..., description="unpaid | paid | overdue | voided")
    notes: Optional[str] = None


class InvoiceGenerateRequest(BaseModel):
    tenant_id: int
    period_start: datetime.date
    period_end: datetime.date


# ─── RESELLER TENANT ENDPOINTS ───────────────────────────────────────────────

@router.get("/my-plan")
async def get_my_rental_plan(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the Platform Fleet Rental agreement and live metrics for the current tenant."""
    tenant_id = current_user.tenant_id

    contract_res = await db.execute(
        select(ResellerContract).where(ResellerContract.tenant_id == tenant_id)
    )
    contract = contract_res.scalar_one_or_none()

    if not contract:
        return {
            "has_reseller_contract": False,
            "tenant_id": tenant_id,
            "message": "No active platform fleet rental contract for this tenant."
        }

    active_count = await get_active_billable_vehicle_count(db, tenant_id)
    lifetime_count = await get_active_lifetime_vehicle_count(db, tenant_id)

    # Calculate current month estimated wholesale or revshare obligations
    estimate = compute_monthly_charge(
        model=contract.model,
        active_vehicles=active_count,
        eligible_revenue_usd=0.0,
        active_lifetime_vehicles=lifetime_count,
        custom_pricing=contract.custom_pricing_json,
        commission_pct=contract.commission_pct,
        min_contribution_usd=contract.min_platform_contribution_usd,
        lifetime_hosting_rate=contract.lifetime_hosting_per_vehicle_usd,
    )

    return {
        "has_reseller_contract": True,
        "contract": {
            "id": contract.id,
            "tenant_id": contract.tenant_id,
            "model": contract.model,
            "status": contract.status,
            "commission_pct": contract.commission_pct,
            "min_platform_contribution_usd": contract.min_platform_contribution_usd,
            "lifetime_hosting_per_vehicle_usd": contract.lifetime_hosting_per_vehicle_usd,
            "billing_day_of_month": contract.billing_day_of_month,
            "commenced_at": contract.commenced_at,
            "notes": contract.notes,
        },
        "live_metrics": {
            "active_vehicles_count": active_count,
            "active_lifetime_vehicles_count": lifetime_count,
            "current_estimated_monthly_charge_usd": estimate["total_due"],
            "breakdown": estimate["breakdown"],
        }
    }


@router.get("/my-gateway")
async def get_my_gateway_config(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Return configured payment gateway details with sensitive keys securely masked."""
    tenant_id = current_user.tenant_id
    gw_res = await db.execute(
        select(TenantGateway).where(TenantGateway.tenant_id == tenant_id)
    )
    gw = gw_res.scalar_one_or_none()
    if not gw:
        return {"configured": False, "tenant_id": tenant_id}

    merchant_id = decrypt_credential(gw.merchant_id_enc) if gw.merchant_id_enc else ""

    return {
        "configured": True,
        "tenant_id": tenant_id,
        "gateway_name": gw.gateway_name,
        "merchant_id_masked": mask_credential(merchant_id, 2, 2) if merchant_id else "",
        "is_active": gw.is_active,
        "webhook_url": gw.webhook_url,
        "ecocash_number": gw.ecocash_number,
        "ecocash_name": gw.ecocash_name,
        "whatsapp_number": gw.whatsapp_number,
        "payment_instructions": gw.payment_instructions,
        "accept_manual_payments": gw.accept_manual_payments if gw.accept_manual_payments is not None else True,
        "updated_at": gw.updated_at,
    }


@router.post("/my-gateway")
async def set_my_gateway_config(
    req: GatewayConfigRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Save or update reseller's merchant gateway credentials (encrypted) and WhatsApp/EcoCash details."""
    tenant_id = current_user.tenant_id

    has_paynow = bool((req.merchant_id or "").strip() and (req.merchant_key or "").strip())
    has_ecocash = bool((req.ecocash_number or "").strip() or (req.whatsapp_number or "").strip())

    if not has_paynow and not has_ecocash:
        raise HTTPException(
            status_code=400,
            detail="Please provide either Paynow merchant credentials or an EcoCash / WhatsApp payment number."
        )

    gw_res = await db.execute(
        select(TenantGateway).where(TenantGateway.tenant_id == tenant_id)
    )
    gw = gw_res.scalar_one_or_none()

    merchant_id_enc = encrypt_credential(req.merchant_id.strip()) if has_paynow else (gw.merchant_id_enc if gw else "")
    merchant_key_enc = encrypt_credential(req.merchant_key.strip()) if has_paynow else (gw.merchant_key_enc if gw else "")

    if gw:
        if has_paynow:
            gw.merchant_id_enc = merchant_id_enc
            gw.merchant_key_enc = merchant_key_enc
        gw.gateway_name = req.gateway_name
        gw.is_active = req.is_active
        gw.webhook_url = req.webhook_url
        if req.ecocash_number is not None:
            gw.ecocash_number = req.ecocash_number.strip()
        if req.ecocash_name is not None:
            gw.ecocash_name = req.ecocash_name.strip()
        if req.whatsapp_number is not None:
            gw.whatsapp_number = req.whatsapp_number.strip()
        if req.payment_instructions is not None:
            gw.payment_instructions = req.payment_instructions.strip()
        gw.accept_manual_payments = req.accept_manual_payments
    else:
        gw = TenantGateway(
            tenant_id=tenant_id,
            gateway_name=req.gateway_name,
            merchant_id_enc=merchant_id_enc,
            merchant_key_enc=merchant_key_enc,
            is_active=req.is_active,
            webhook_url=req.webhook_url,
            ecocash_number=req.ecocash_number.strip() if req.ecocash_number else None,
            ecocash_name=req.ecocash_name.strip() if req.ecocash_name else None,
            whatsapp_number=req.whatsapp_number.strip() if req.whatsapp_number else None,
            payment_instructions=req.payment_instructions.strip() if req.payment_instructions else None,
            accept_manual_payments=req.accept_manual_payments,
        )
        db.add(gw)

    await db.commit()
    decrypted_id = decrypt_credential(gw.merchant_id_enc) if gw.merchant_id_enc else ""
    return {
        "message": "Payment options and credentials saved successfully.",
        "merchant_id_masked": mask_credential(decrypted_id, 2, 2) if decrypted_id else "",
        "ecocash_number": gw.ecocash_number,
        "whatsapp_number": gw.whatsapp_number,
        "accept_manual_payments": gw.accept_manual_payments,
        "is_active": gw.is_active,
    }


@router.get("/my-invoices")
async def get_my_invoices(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all monthly platform rental invoices issued to the current tenant."""
    tenant_id = current_user.tenant_id
    res = await db.execute(
        select(ResellerInvoice)
        .where(ResellerInvoice.tenant_id == tenant_id)
        .order_by(ResellerInvoice.billing_period_start.desc())
    )
    invoices = res.scalars().all()
    return [
        {
            "id": inv.id,
            "invoice_number": inv.invoice_number,
            "model": inv.model,
            "billing_period_start": inv.billing_period_start,
            "billing_period_end": inv.billing_period_end,
            "active_vehicles_count": inv.active_vehicles_count,
            "lifetime_vehicles_count": inv.lifetime_vehicles_count,
            "gross_customer_revenue_usd": float(inv.gross_customer_revenue_usd or 0),
            "calculated_amount_usd": float(inv.calculated_amount_usd or 0),
            "adjustments_usd": float(inv.adjustments_usd or 0),
            "total_due_usd": float(inv.total_due_usd or 0),
            "status": inv.status,
            "notes": inv.notes,
            "paid_at": inv.paid_at,
            "created_at": inv.created_at,
        }
        for inv in invoices
    ]


@router.get("/my-commissions")
async def get_my_commissions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List commission ledger entries for Model B revenue-sharing audit."""
    tenant_id = current_user.tenant_id
    res = await db.execute(
        select(ResellerCommissionLedger)
        .where(ResellerCommissionLedger.tenant_id == tenant_id)
        .order_by(ResellerCommissionLedger.created_at.desc())
        .limit(100)
    )
    rows = res.scalars().all()
    return [
        {
            "id": row.id,
            "transaction_id": row.transaction_id,
            "retail_amount_usd": float(row.retail_amount_usd or 0),
            "commission_pct": row.commission_pct,
            "inferth_commission_usd": float(row.inferth_commission_usd or 0),
            "package_type": row.package_type,
            "status": row.status,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.get("/manual-payments")
async def list_manual_payments(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Reseller: list all manual payments / POP submissions received for current tenant."""
    tenant_id = current_user.tenant_id
    res = await db.execute(
        select(ManualPayment)
        .where(ManualPayment.tenant_id == tenant_id)
        .order_by(ManualPayment.created_at.desc())
        .limit(100)
    )
    rows = res.scalars().all()
    return [
        {
            "id": p.id,
            "payer_name": p.payer_name,
            "payer_phone": p.payer_phone,
            "amount_usd": float(p.amount_usd or 0),
            "reference_code": p.reference_code,
            "proof_image_data": p.proof_image_data,
            "notes": p.notes,
            "num_vehicles": p.num_vehicles,
            "package_tier": p.package_tier,
            "payment_plan": p.payment_plan,
            "status": p.status,
            "confirmed_by": p.confirmed_by,
            "confirmed_at": p.confirmed_at.isoformat() if p.confirmed_at else None,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in rows
    ]


@router.post("/manual-payments")
async def submit_manual_payment(
    req: ManualPaymentCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Customer / Sender: submit proof of manual payment (EcoCash / WhatsApp POP with screenshot)."""
    import urllib.parse
    target_tenant_id = req.tenant_id or current_user.tenant_id

    # Verify tenant exists
    t_res = await db.execute(select(Tenant).where(Tenant.id == target_tenant_id))
    if not t_res.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Tenant not found.")

    payment = ManualPayment(
        tenant_id=target_tenant_id,
        payer_name=req.payer_name.strip(),
        payer_phone=req.payer_phone.strip(),
        amount_usd=req.amount_usd,
        reference_code=req.reference_code.strip() if req.reference_code else "",
        proof_image_data=req.proof_image_data,
        notes=req.notes.strip() if req.notes else None,
        num_vehicles=req.num_vehicles,
        package_tier=req.package_tier,
        payment_plan=req.payment_plan,
        status="pending",
    )
    db.add(payment)
    await db.commit()
    await db.refresh(payment)

    # Notify the people who can actually approve this: the admins of the account
    # the payment was submitted to, plus every platform super admin. Previously
    # the endpoint only returned a wa.me link to one hardcoded number, so nothing
    # reached the admins unless the customer chose to forward it themselves.
    tier_label = {
        "basic": "Basic", "premium": "Premium", "enterprise": "Enterprise"
    }.get(req.package_tier or "", req.package_tier or "—")
    plan_label = {
        "monthly": "Monthly Subscription",
        "onceoff_lifetime": "Once-Off Lifetime",
        "payd": "Pay-As-You-Drive",
    }.get(req.payment_plan or "", req.payment_plan or "—")

    tenant_row = await db.execute(select(Tenant.name).where(Tenant.id == target_tenant_id))
    tenant_label = tenant_row.scalar() or f"Tenant #{target_tenant_id}"

    whatsapp_msg = (
        f"🔔 *Payment awaiting approval* (#{payment.id})\n"
        f"🏢 Account: {tenant_label}\n"
        f"👤 Customer: {req.payer_name} | {req.payer_phone}\n"
        f"💵 Amount paid: ${req.amount_usd:.2f} USD\n"
        f"🚗 Vehicles: {req.num_vehicles or '—'}\n"
        f"📦 Tier: {tier_label} | Plan: {plan_label}\n"
        f"📝 Notes: {req.notes or '—'}\n"
        f"✅ Confirm the funds and the trackers, then approve under "
        f"Settings → Pending payment approvals."
    )

    from app.services.whatsapp import send_whatsapp

    recipient_phones: set[str] = set()
    tenant_admins = await db.execute(
        select(User.phone).where(
            User.tenant_id == target_tenant_id,
            User.role.in_(["admin", "super_admin"]),
            User.phone.is_not(None),
        )
    )
    recipient_phones.update(str(row[0]).strip() for row in tenant_admins.all() if row[0])
    platform_admins = await db.execute(
        select(User.phone).where(
            User.role == "super_admin",
            User.phone.is_not(None),
        )
    )
    recipient_phones.update(str(row[0]).strip() for row in platform_admins.all() if row[0])

    for phone in recipient_phones:
        asyncio.create_task(send_whatsapp(phone, whatsapp_msg))

    return {
        "message": (
            "Proof of payment submitted successfully. Your admin has been notified "
            "and will approve the package once the funds are confirmed."
        ),
        "payment_id": payment.id,
        "status": payment.status,
        "admins_notified": len(recipient_phones),
    }


@router.get("/admin/pending-pops")
async def list_all_pending_pops(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Pending proof-of-payment requests awaiting approval.

    A platform admin sees every company; a company's own admin sees only the
    payments submitted to their account — the request that concerns them.
    """
    stmt = (
        select(ManualPayment, Tenant)
        .join(Tenant, ManualPayment.tenant_id == Tenant.id)
        .where(ManualPayment.status == "pending")
    )
    if not is_platform_admin(current_user):
        stmt = stmt.where(ManualPayment.tenant_id == current_user.tenant_id)
    res = await db.execute(
        stmt.order_by(ManualPayment.created_at.desc()).limit(50)
    )
    rows = res.all()
    tier_labels = {"basic": "Basic", "premium": "Premium", "enterprise": "Enterprise"}
    plan_labels = {"monthly": "Monthly", "onceoff_lifetime": "Once-Off Lifetime", "payd": "Pay-As-You-Drive"}
    return [
        {
            "id": p.id,
            "tenant_id": p.tenant_id,
            "tenant_name": t.name if t else f"Tenant #{p.tenant_id}",
            "payer_name": p.payer_name,
            "payer_phone": p.payer_phone,
            "amount_usd": float(p.amount_usd or 0),
            "num_vehicles": p.num_vehicles,
            "package_tier": tier_labels.get(p.package_tier or "", p.package_tier or "—"),
            "payment_plan": plan_labels.get(p.payment_plan or "", p.payment_plan or "—"),
            "proof_image_data": p.proof_image_data,
            "notes": p.notes,
            "status": p.status,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p, t in rows
    ]


RESELLER_MODEL_ALIASES = {
    "model_a": "MODEL_A",
    "model_a_wholesale": "MODEL_A",
    "model_b": "MODEL_B",
    "model_b_revshare": "MODEL_B",
}
PACKAGE_PLAN_STATE = {
    # payment_plan -> (tenants.plan suffix, tenants.billing_cycle, days)
    "monthly": ("Monthly", 30),
    "onceoff_lifetime": ("Once-off", None),
    "payd": ("Prepaid", None),
}


def _reseller_model_for(payment: ManualPayment) -> Optional[str]:
    """Which Platform Fleet Rental model this POP is paying for, if any."""
    tier = (payment.package_tier or "").strip().lower()
    if tier in RESELLER_MODEL_ALIASES:
        return RESELLER_MODEL_ALIASES[tier]
    if tier in ("console", "console_rental", "rental", "platform_fleet_rental"):
        return "MODEL_A"
    haystack = f"{payment.payer_name or ''} {payment.notes or ''}".lower()
    if "model_b" in haystack:
        return "MODEL_B"
    if "model_a" in haystack or "platform reseller" in haystack or "platform rental" in haystack:
        return "MODEL_A"
    return None


async def _activate_confirmed_package(
    db: AsyncSession, payment: ManualPayment
) -> Optional[dict]:
    """Switch on what a confirmed POP paid for.

    Approving used to only flip the payment row to "confirmed", so nothing was
    ever activated: an approved reseller stayed missing from Platform Fleet
    Rental agreements and Billing kept saying "No active plan" even though the
    money had been confirmed. This applies the rental contract or the package
    plan in the same transaction as the approval.
    """
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == payment.tenant_id))
    ).scalars().first()
    if not tenant:
        return None

    now = datetime.datetime.now(datetime.timezone.utc)
    model = _reseller_model_for(payment)
    if model:
        contract = (
            await db.execute(
                select(ResellerContract).where(ResellerContract.tenant_id == tenant.id)
            )
        ).scalars().first()
        created = False
        if contract:
            contract.model = model
            contract.status = "active"
        else:
            db.add(ResellerContract(
                tenant_id=tenant.id,
                model=model,
                status="active",
                notes=f"Activated from approved proof of payment #{payment.id}",
            ))
            created = True

        tenant.plan = "Console Rental"
        tenant.billing_cycle = "Rental"
        tenant.subscription_status = "active"
        tenant.next_billing_date = now + datetime.timedelta(days=30)
        model_label = "Model B (Revenue Share)" if model == "MODEL_B" else "Model A (Wholesale Rental)"
        return {
            "kind": "reseller_rental",
            "model": model,
            "contract_created": created,
            "plan": tenant.plan,
            "billing_cycle": tenant.billing_cycle,
            "next_billing_date": tenant.next_billing_date.isoformat(),
            "message": (
                f"Payment confirmed. {model_label} is now active on this console "
                f"and the agreement appears under Platform Fleet Rental."
            ),
        }

    tier = (payment.package_tier or "").strip().lower()
    if tier in ("basic", "premium", "enterprise"):
        plan_key = (payment.payment_plan or "monthly").strip().lower()
        cycle, days = PACKAGE_PLAN_STATE.get(plan_key, PACKAGE_PLAN_STATE["monthly"])
        label = {"basic": "Basic", "premium": "Premium", "enterprise": "Enterprise"}[tier]
        tenant.plan = "Starter Pass" if plan_key == "onceoff_lifetime" else label
        tenant.billing_cycle = cycle
        tenant.subscription_status = "active"
        tenant.next_billing_date = now + datetime.timedelta(days=days) if days else None
        return {
            "kind": "package",
            "tier": tier,
            "payment_plan": plan_key,
            "plan": tenant.plan,
            "billing_cycle": tenant.billing_cycle,
            "next_billing_date": (
                tenant.next_billing_date.isoformat() if tenant.next_billing_date else None
            ),
            "message": f"Payment confirmed. The {label} package ({cycle}) is now active.",
        }

    return None


async def backfill_confirmed_packages(db: AsyncSession) -> int:
    """Switch on the package behind POPs approved before approval did that.

    Approvals made before this existed only set status="confirmed", so those
    resellers still had no agreement and their account still read "No active
    plan". Runs at boot, oldest first, and stamps every row it has seen with
    activation_applied_at so the pass happens once per payment.
    """
    rows = (
        await db.execute(
            select(ManualPayment)
            .where(
                ManualPayment.status == "confirmed",
                ManualPayment.activation_applied_at.is_(None),
            )
            .order_by(ManualPayment.created_at.asc())
        )
    ).scalars().all()
    if not rows:
        return 0

    now = datetime.datetime.now(datetime.timezone.utc)
    activated = 0
    for payment in rows:
        try:
            if await _activate_confirmed_package(db, payment):
                activated += 1
        except Exception as exc:
            print(f"POP activation backfill warning (payment {payment.id}): {exc}")
        # Stamped even on failure: a permanently bad row must not re-run forever.
        payment.activation_applied_at = now
    await db.commit()
    return activated


@router.post("/manual-payments/{payment_id}/confirm")
async def confirm_manual_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Receiver: confirm an EcoCash/manual payment and activate the package it paid for."""
    res = await db.execute(
        select(ManualPayment).where(ManualPayment.id == payment_id)
    )
    p = res.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Payment record not found.")

    if not is_platform_admin(current_user) and p.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Unauthorized.")

    p.status = "confirmed"
    p.confirmed_by = current_user.email
    p.confirmed_at = datetime.datetime.now(datetime.timezone.utc)
    activation = await _activate_confirmed_package(db, p)
    p.activation_applied_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    return {
        "message": (
            activation["message"] if activation
            else "Payment confirmed and marked as received."
        ),
        "payment_id": p.id,
        "status": "confirmed",
        "activation": activation,
    }


@router.post("/manual-payments/{payment_id}/reject")
async def reject_manual_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Receiver: reject an unverified manual payment."""
    res = await db.execute(
        select(ManualPayment).where(ManualPayment.id == payment_id)
    )
    p = res.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Payment record not found.")

    if not is_platform_admin(current_user) and p.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Unauthorized.")

    p.status = "rejected"
    await db.commit()
    return {"message": "Payment marked as rejected.", "payment_id": p.id, "status": "rejected"}


# ─── SUPER ADMIN ENDPOINTS ───────────────────────────────────────────────────

@admin_router.get("/contracts")
async def list_all_reseller_contracts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: list all tenant reseller contracts with live vehicle stats."""
    res = await db.execute(
        select(ResellerContract, Tenant)
        .join(Tenant, Tenant.id == ResellerContract.tenant_id)
        .order_by(ResellerContract.created_at.desc())
    )
    records = res.all()
    output = []
    for contract, tenant in records:
        active_count = await get_active_billable_vehicle_count(db, contract.tenant_id)
        lifetime_count = await get_active_lifetime_vehicle_count(db, contract.tenant_id)
        output.append({
            "id": contract.id,
            "tenant_id": contract.tenant_id,
            "tenant_name": tenant.name,
            "tenant_plan": tenant.plan,
            "model": contract.model,
            "status": contract.status,
            "commission_pct": contract.commission_pct,
            "min_platform_contribution_usd": contract.min_platform_contribution_usd,
            "lifetime_hosting_per_vehicle_usd": contract.lifetime_hosting_per_vehicle_usd,
            "custom_pricing_json": contract.custom_pricing_json,
            "active_vehicles_count": active_count,
            "lifetime_vehicles_count": lifetime_count,
            "commenced_at": contract.commenced_at,
            "notes": contract.notes,
        })
    return output


@admin_router.post("/contracts")
async def create_reseller_contract(
    req: ContractCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: create or approve a new Platform Fleet Rental agreement."""
    # Check tenant exists
    t_res = await db.execute(select(Tenant).where(Tenant.id == req.tenant_id))
    if not t_res.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Tenant not found.")

    # Check if contract already exists
    existing = await db.execute(
        select(ResellerContract).where(ResellerContract.tenant_id == req.tenant_id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Contract already exists for this tenant.")

    if req.model not in ("MODEL_A", "MODEL_B"):
        raise HTTPException(status_code=400, detail="Model must be MODEL_A or MODEL_B.")

    contract = ResellerContract(
        tenant_id=req.tenant_id,
        model=req.model,
        status=req.status,
        commission_pct=req.commission_pct,
        min_platform_contribution_usd=req.min_platform_contribution_usd,
        lifetime_hosting_per_vehicle_usd=req.lifetime_hosting_per_vehicle_usd,
        custom_pricing_json=req.custom_pricing_json,
        billing_day_of_month=req.billing_day_of_month,
        notes=req.notes,
    )
    db.add(contract)
    await db.commit()
    await db.refresh(contract)
    return {"message": "Reseller contract created successfully.", "contract_id": contract.id}


@admin_router.patch("/contracts/{tenant_id}")
async def update_reseller_contract(
    tenant_id: int,
    req: ContractUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: update pricing parameters, model or status of a contract."""
    res = await db.execute(
        select(ResellerContract).where(ResellerContract.tenant_id == tenant_id)
    )
    contract = res.scalar_one_or_none()
    if not contract:
        raise HTTPException(status_code=404, detail="Reseller contract not found.")

    if req.model is not None:
        if req.model not in ("MODEL_A", "MODEL_B"):
            raise HTTPException(status_code=400, detail="Model must be MODEL_A or MODEL_B.")
        contract.model = req.model
    if req.status is not None:
        contract.status = req.status
    if req.commission_pct is not None:
        contract.commission_pct = req.commission_pct
    if req.min_platform_contribution_usd is not None:
        contract.min_platform_contribution_usd = req.min_platform_contribution_usd
    if req.lifetime_hosting_per_vehicle_usd is not None:
        contract.lifetime_hosting_per_vehicle_usd = req.lifetime_hosting_per_vehicle_usd
    if req.custom_pricing_json is not None:
        contract.custom_pricing_json = req.custom_pricing_json
    if req.billing_day_of_month is not None:
        contract.billing_day_of_month = req.billing_day_of_month
    if req.notes is not None:
        contract.notes = req.notes

    await db.commit()
    return {"message": "Contract updated successfully."}


@admin_router.get("/invoices")
async def list_all_invoices(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: list all wholesale invoices across all resellers."""
    res = await db.execute(
        select(ResellerInvoice, Tenant.name)
        .join(Tenant, Tenant.id == ResellerInvoice.tenant_id)
        .order_by(ResellerInvoice.billing_period_start.desc())
    )
    rows = res.all()
    return [
        {
            "id": inv.id,
            "tenant_id": inv.tenant_id,
            "tenant_name": t_name,
            "invoice_number": inv.invoice_number,
            "model": inv.model,
            "billing_period_start": inv.billing_period_start,
            "billing_period_end": inv.billing_period_end,
            "active_vehicles_count": inv.active_vehicles_count,
            "lifetime_vehicles_count": inv.lifetime_vehicles_count,
            "gross_customer_revenue_usd": float(inv.gross_customer_revenue_usd or 0),
            "total_due_usd": float(inv.total_due_usd or 0),
            "status": inv.status,
            "paid_at": inv.paid_at,
            "notes": inv.notes,
        }
        for inv, t_name in rows
    ]


@admin_router.post("/invoices/generate")
async def trigger_generate_invoice(
    req: InvoiceGenerateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: generate or recalculate invoice for a specific tenant and period."""
    inv = await generate_monthly_invoice(db, req.tenant_id, req.period_start, req.period_end)
    if not inv:
        raise HTTPException(status_code=400, detail="Failed to generate invoice. Ensure tenant has an active reseller contract.")
    return {
        "message": "Invoice generated successfully.",
        "invoice_number": inv.invoice_number,
        "total_due_usd": float(inv.total_due_usd or 0),
        "status": inv.status,
    }


@admin_router.patch("/invoices/{invoice_id}/status")
async def update_invoice_status(
    invoice_id: int,
    req: InvoiceStatusUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: update invoice payment status."""
    res = await db.execute(
        select(ResellerInvoice).where(ResellerInvoice.id == invoice_id)
    )
    inv = res.scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found.")

    inv.status = req.status
    if req.status == "paid" and not inv.paid_at:
        inv.paid_at = datetime.datetime.now(datetime.timezone.utc)
    if req.notes:
        inv.notes = f"{inv.notes or ''}\n{req.notes}".strip()

    await db.commit()
    return {"message": f"Invoice status updated to {req.status}."}


@admin_router.post("/invoices/{invoice_id}/settle")
async def settle_reseller_invoice(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: mark a wholesale platform rental invoice as settled/paid."""
    res = await db.execute(select(ResellerInvoice).where(ResellerInvoice.id == invoice_id))
    inv = res.scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found.")
    inv.status = "paid"
    inv.paid_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    return {"message": "Invoice marked as settled.", "invoice_id": invoice_id}


@admin_router.get("/benchmark-calculator")
async def calculate_benchmark(
    vehicles: int = 100,
    revenue: float = 1000.0,
    lifetime_vehicles: int = 0,
    model: str = "MODEL_A",
    current_user: User = Depends(require_super_admin),
):
    """Super Admin: benchmark and quotation calculator."""
    return compute_monthly_charge(
        model=model,
        active_vehicles=vehicles,
        eligible_revenue_usd=revenue,
        active_lifetime_vehicles=lifetime_vehicles,
    )
