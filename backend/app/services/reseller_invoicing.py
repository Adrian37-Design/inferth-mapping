"""
reseller_invoicing.py — Platform Fleet Rental monthly invoice generation.

Generates ResellerInvoice records for all active reseller tenants.
Runs as a background task on the 1st of each month at 06:00 UTC.

Do NOT touch usage_billing.py or the PAYD billing loop.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timezone
from calendar import monthrange

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ResellerContract, ResellerInvoice, ResellerCommissionLedger
from app.services.reseller_billing import (
    compute_monthly_charge,
    get_active_billable_vehicle_count,
    get_active_lifetime_vehicle_count,
)

logger = logging.getLogger(__name__)


def _invoice_number(tenant_id: int, period_start: date) -> str:
    """Format: INV-RES-{tenant_id}-YYYYMM"""
    return f"INV-RES-{tenant_id}-{period_start.strftime('%Y%m')}"


async def _get_period_revenue(
    db: AsyncSession,
    tenant_id: int,
    period_start: date,
    period_end: date,
) -> dict:
    """Aggregate gross customer revenue from the commission ledger for the period.

    Returns dict with total_revenue, monthly_payd_revenue, lifetime_revenue.
    """
    start_dt = datetime(period_start.year, period_start.month, period_start.day, tzinfo=timezone.utc)
    end_dt = datetime(period_end.year, period_end.month, period_end.day, 23, 59, 59, tzinfo=timezone.utc)

    result = await db.execute(
        select(
            ResellerCommissionLedger.package_type,
            ResellerCommissionLedger.retail_amount_usd,
        ).where(
            ResellerCommissionLedger.tenant_id == tenant_id,
            ResellerCommissionLedger.created_at >= start_dt,
            ResellerCommissionLedger.created_at <= end_dt,
            ResellerCommissionLedger.status.in_(["calculated", "payable"]),
        )
    )
    rows = result.all()

    total_revenue = 0.0
    lifetime_revenue = 0.0
    monthly_payd_revenue = 0.0

    for row in rows:
        amt = float(row.retail_amount_usd or 0)
        total_revenue += amt
        if row.package_type == "onceoff_lifetime":
            lifetime_revenue += amt
        else:
            monthly_payd_revenue += amt

    return {
        "total_revenue": round(total_revenue, 2),
        "lifetime_revenue": round(lifetime_revenue, 2),
        "monthly_payd_revenue": round(monthly_payd_revenue, 2),
    }


async def generate_monthly_invoice(
    db: AsyncSession,
    tenant_id: int,
    period_start: date,
    period_end: date,
) -> ResellerInvoice | None:
    """Generate a ResellerInvoice for a single reseller tenant for a billing period.

    Args:
        db: Async DB session.
        tenant_id: The reseller's tenant ID.
        period_start: First day of the billing period (inclusive).
        period_end: Last day of the billing period (inclusive).

    Returns:
        The created (or existing) ResellerInvoice, or None if no contract found.
    """
    # Load reseller contract
    contract_res = await db.execute(
        select(ResellerContract).where(
            ResellerContract.tenant_id == tenant_id,
            ResellerContract.status == "active",
        )
    )
    contract = contract_res.scalar_one_or_none()
    if not contract:
        logger.warning(f"No active reseller contract for tenant {tenant_id}; skipping invoice.")
        return None

    inv_number = _invoice_number(tenant_id, period_start)

    # Idempotent: return existing invoice if already generated
    existing = await db.execute(
        select(ResellerInvoice).where(ResellerInvoice.invoice_number == inv_number)
    )
    existing_inv = existing.scalar_one_or_none()
    if existing_inv:
        logger.info(f"Invoice {inv_number} already exists; returning existing.")
        return existing_inv

    # Gather vehicle counts
    active_vehicles = await get_active_billable_vehicle_count(db, tenant_id)
    active_lifetime_vehicles = await get_active_lifetime_vehicle_count(db, tenant_id)

    # Gather revenue (Model B only needs this)
    revenue_data = await _get_period_revenue(db, tenant_id, period_start, period_end)

    custom_pricing = contract.custom_pricing_json

    billing = compute_monthly_charge(
        model=contract.model,
        active_vehicles=active_vehicles,
        eligible_revenue_usd=revenue_data["monthly_payd_revenue"],
        active_lifetime_vehicles=active_lifetime_vehicles,
        custom_pricing=custom_pricing,
        commission_pct=contract.commission_pct,
        min_contribution_usd=contract.min_platform_contribution_usd,
        lifetime_hosting_rate=contract.lifetime_hosting_per_vehicle_usd,
    )

    invoice = ResellerInvoice(
        invoice_number=inv_number,
        tenant_id=tenant_id,
        model=contract.model,
        billing_period_start=period_start,
        billing_period_end=period_end,
        active_vehicles_count=active_vehicles,
        lifetime_vehicles_count=active_lifetime_vehicles,
        gross_customer_revenue_usd=revenue_data["total_revenue"],
        calculated_amount_usd=billing["total_due"],
        adjustments_usd=0.0,
        total_due_usd=billing["total_due"],
        status="unpaid",
        notes="\n".join(billing["breakdown"]),
    )
    db.add(invoice)
    await db.commit()
    await db.refresh(invoice)
    logger.info(f"Generated invoice {inv_number}: ${billing['total_due']:.2f} due")
    return invoice


async def run_monthly_invoicing(db: AsyncSession) -> int:
    """Generate invoices for all active reseller contracts.

    Called by the monthly background task. Returns the count of invoices generated.

    Billing period = 1st to last day of PREVIOUS month.
    """
    today = date.today()
    # Previous month
    if today.month == 1:
        year, month = today.year - 1, 12
    else:
        year, month = today.year, today.month - 1

    period_start = date(year, month, 1)
    _, last_day = monthrange(year, month)
    period_end = date(year, month, last_day)

    # Load all active contracts
    contracts_res = await db.execute(
        select(ResellerContract).where(ResellerContract.status == "active")
    )
    contracts = contracts_res.scalars().all()

    count = 0
    for contract in contracts:
        try:
            inv = await generate_monthly_invoice(db, contract.tenant_id, period_start, period_end)
            if inv:
                count += 1
        except Exception as e:
            logger.error(f"Invoice generation failed for tenant {contract.tenant_id}: {e}")

    logger.info(f"Monthly invoicing complete: {count} invoice(s) generated for {period_start} – {period_end}")
    return count
