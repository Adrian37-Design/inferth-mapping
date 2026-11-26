"""Customer-facing billing for tenants that buy tracking from a reseller.

Inferth's reseller model rents the platform to a reseller tenant (see
``reseller_contracts``).  A reseller's own customers are ordinary tenants linked
through ``tenants.reseller_tenant_id``.  Those customers pay the reseller
directly, through the reseller's own merchant gateway (``tenant_gateways``), and
see only their own invoices, payments and wallet.

Nothing here touches the wholesale Platform Fleet Rental invoicing
(``reseller_invoicing.py``), the commission ledger, or the PAYD meter
(``usage_billing.py``).  It reads the wallet ledger and produces retail invoices.
"""

from __future__ import annotations

import datetime as dt
from calendar import monthrange
from typing import Any, Dict, List, Optional, Tuple
from xml.sax.saxutils import escape

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    CustomerInvoice,
    Device,
    ManualPayment,
    Tenant,
    Transaction,
)
from app.services import usage_billing as ub

# ── Packages ────────────────────────────────────────────────────────────────
# The four retail packages a reseller sells.  Only the two recurring monthly
# packages generate invoices; Lifetime is paid once and PAYD is metered.
PACKAGE_BASIC = "basic_monthly"
PACKAGE_PREMIUM = "premium_monthly"
PACKAGE_ENTERPRISE = "enterprise_monthly"
PACKAGE_LIFETIME = "lifetime_basic"
PACKAGE_PAYD = "payd"
PACKAGE_RENTAL = "console_rental"

PACKAGE_LABELS = {
    PACKAGE_BASIC: "Basic Monthly",
    PACKAGE_PREMIUM: "Premium Monthly",
    PACKAGE_ENTERPRISE: "Enterprise Monthly",
    PACKAGE_LIFETIME: "Lifetime Basic",
    PACKAGE_PAYD: "PAYD (Pay As You Drive)",
    PACKAGE_RENTAL: "Console Rental",
}

# Retail monthly price per vehicle.  Same figures the Billing page charges.
MONTHLY_RATE_PER_VEHICLE = {
    PACKAGE_BASIC: 15.0,
    PACKAGE_PREMIUM: 25.0,
}
RECURRING_PACKAGES = (PACKAGE_BASIC, PACKAGE_PREMIUM)

PAYMENT_TERMS_DAYS = 7
PAID_EPSILON = 0.005


def money(value: Any) -> float:
    return round(float(value or 0.0), 6)


def cash(value: Any) -> float:
    """Customer-facing amount: two decimal places."""
    return round(float(value or 0.0), 2)


# ── Package detection ───────────────────────────────────────────────────────

def package_of(tenant: Optional[Tenant]) -> Tuple[str, str]:
    """(package key, display label) for a customer tenant."""
    if not tenant:
        return PACKAGE_BASIC, PACKAGE_LABELS[PACKAGE_BASIC]
    plan = (tenant.plan or "").strip().lower()
    cycle = (tenant.billing_cycle or "").strip().lower()

    if "prepaid" in plan or "wallet" in plan or "prepaid" in cycle or "wallet" in cycle or "payd" in plan:
        return PACKAGE_PAYD, PACKAGE_LABELS[PACKAGE_PAYD]
    if "once" in cycle or "once" in plan or "lifetime" in plan or "starter pass" in plan:
        return PACKAGE_LIFETIME, PACKAGE_LABELS[PACKAGE_LIFETIME]
    if "rental" in cycle or "console" in plan:
        return PACKAGE_RENTAL, PACKAGE_LABELS[PACKAGE_RENTAL]
    if "enterprise" in plan:
        return PACKAGE_ENTERPRISE, PACKAGE_LABELS[PACKAGE_ENTERPRISE]
    if "premium" in plan or "pro" in plan:
        return PACKAGE_PREMIUM, PACKAGE_LABELS[PACKAGE_PREMIUM]
    return PACKAGE_BASIC, PACKAGE_LABELS[PACKAGE_BASIC]


async def vehicle_count(db: AsyncSession, tenant_id: int) -> int:
    total = (
        await db.execute(select(func.count(Device.id)).where(Device.tenant_id == tenant_id))
    ).scalar()
    return int(total or 0)


def _month_bounds(day: dt.date) -> Tuple[dt.date, dt.date]:
    start = day.replace(day=1)
    last = monthrange(day.year, day.month)[1]
    return start, day.replace(day=last)


def next_month_start(day: dt.date) -> dt.date:
    return (day.replace(day=28) + dt.timedelta(days=4)).replace(day=1)


# ── Invoices ────────────────────────────────────────────────────────────────

def invoice_outstanding(invoice: CustomerInvoice) -> float:
    if (invoice.status or "").lower() in ("cancelled", "refunded", "voided"):
        return 0.0
    return cash(cash(invoice.total_usd) - cash(invoice.amount_paid_usd))


def invoice_status(invoice: CustomerInvoice, today: Optional[dt.date] = None) -> str:
    """Computed status: cancelled/refunded win, then paid, overdue, partial, unpaid."""
    stored = (invoice.status or "unpaid").lower()
    if stored in ("cancelled", "voided"):
        return "cancelled"
    if stored == "refunded":
        return "refunded"
    if invoice_outstanding(invoice) <= PAID_EPSILON:
        return "paid"
    today = today or ub.billing_day()
    if invoice.due_date and invoice.due_date < today:
        return "overdue"
    if cash(invoice.amount_paid_usd) > 0:
        return "partially_paid"
    return "unpaid"


def invoice_payload(invoice: CustomerInvoice, today: Optional[dt.date] = None) -> Dict[str, Any]:
    status = invoice_status(invoice, today)
    return {
        "id": invoice.id,
        "invoice_number": invoice.invoice_number,
        "invoice_date": invoice.issued_at.date().isoformat() if invoice.issued_at else None,
        "billing_period_start": invoice.billing_period_start.isoformat() if invoice.billing_period_start else None,
        "billing_period_end": invoice.billing_period_end.isoformat() if invoice.billing_period_end else None,
        "due_date": invoice.due_date.isoformat() if invoice.due_date else None,
        "total_usd": cash(invoice.total_usd),
        "amount_paid_usd": cash(invoice.amount_paid_usd),
        "outstanding_usd": invoice_outstanding(invoice),
        "status": status,
        "package": invoice.package or None,
        "notes": invoice.notes,
        "paid_at": invoice.paid_at.isoformat() if invoice.paid_at else None,
    }


async def ensure_current_invoice(db: AsyncSession, tenant: Tenant) -> Optional[CustomerInvoice]:
    """Issue this month's retail invoice for a recurring customer, once.

    Idempotent per (customer, billing period): the table carries a unique index,
    so a second call (or a racing request) returns the existing row instead of
    charging the customer twice.
    """
    if not tenant or not tenant.reseller_tenant_id:
        return None
    package, _ = package_of(tenant)
    if package not in RECURRING_PACKAGES:
        return None

    today = ub.billing_day()
    period_start, period_end = _month_bounds(today)

    existing = (
        await db.execute(
            select(CustomerInvoice).where(
                CustomerInvoice.tenant_id == tenant.id,
                CustomerInvoice.billing_period_start == period_start,
            )
        )
    ).scalars().first()
    if existing:
        return existing

    vehicles = await vehicle_count(db, tenant.id)
    if vehicles <= 0:
        return None

    rate = MONTHLY_RATE_PER_VEHICLE[package]
    subtotal = cash(rate * vehicles)
    invoice = CustomerInvoice(
        invoice_number=f"INV-C{tenant.id}-{period_start.strftime('%Y%m')}",
        tenant_id=tenant.id,
        reseller_tenant_id=tenant.reseller_tenant_id,
        package=package,
        billing_period_start=period_start,
        billing_period_end=period_end,
        due_date=period_start + dt.timedelta(days=PAYMENT_TERMS_DAYS),
        line_items=[
            {
                "description": f"{PACKAGE_LABELS[package]} — tracking subscription",
                "quantity": vehicles,
                "unit_price_usd": cash(rate),
                "amount_usd": subtotal,
            }
        ],
        subtotal_usd=subtotal,
        tax_usd=0.0,
        adjustments_usd=0.0,
        total_usd=subtotal,
        amount_paid_usd=0.0,
        status="unpaid",
        issued_at=dt.datetime.now(dt.timezone.utc),
    )
    db.add(invoice)
    try:
        await db.flush()
    except IntegrityError:
        # A concurrent request already issued this period's invoice.
        await db.rollback()
        return (
            await db.execute(
                select(CustomerInvoice).where(
                    CustomerInvoice.tenant_id == tenant.id,
                    CustomerInvoice.billing_period_start == period_start,
                )
            )
        ).scalars().first()
    return invoice


async def allocate_to_invoice(
    db: AsyncSession, invoice: CustomerInvoice, amount: float
) -> None:
    """Apply a verified payment to an invoice; never above the amount payable."""
    paid = cash(cash(invoice.amount_paid_usd) + cash(amount))
    total = cash(invoice.total_usd)
    if paid > total:
        paid = total
    invoice.amount_paid_usd = paid
    if cash(total - paid) <= PAID_EPSILON:
        invoice.status = "paid"
        invoice.paid_at = invoice.paid_at or dt.datetime.now(dt.timezone.utc)
    else:
        invoice.status = "partially_paid"


async def settle_invoice_transaction(db: AsyncSession, txn: Transaction) -> bool:
    """Settle the invoice behind a paid gateway transaction exactly once."""
    if not getattr(txn, "invoice_id", None):
        return False
    invoice = (
        await db.execute(
            select(CustomerInvoice).where(CustomerInvoice.id == txn.invoice_id)
        )
    ).scalars().first()
    if not invoice or invoice.tenant_id != txn.tenant_id:
        return False
    # Nothing left to pay: leave the transaction unapplied rather than swallowing
    # money on an invoice that is already settled.
    if invoice_outstanding(invoice) <= PAID_EPSILON:
        return False
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
    if not claim.rowcount:
        return False
    await allocate_to_invoice(db, invoice, float(txn.amount_usd or 0))
    return True


async def settle_manual_payment(db: AsyncSession, payment: ManualPayment) -> Dict[str, Any]:
    """Apply a confirmed EcoCash/manual payment to its customer invoice."""
    if payment.activation_applied_at:
        return {
            "kind": "customer_invoice",
            "already_applied": True,
            "message": "This payment has already been applied.",
        }
    invoice = None
    if payment.invoice_id:
        invoice = (
            await db.execute(
                select(CustomerInvoice).where(CustomerInvoice.id == payment.invoice_id)
            )
        ).scalars().first()
    if invoice and invoice.tenant_id == payment.customer_tenant_id:
        await allocate_to_invoice(db, invoice, float(payment.amount_usd or 0))
        payment.activation_applied_at = dt.datetime.now(dt.timezone.utc)
        return {
            "kind": "customer_invoice",
            "invoice_id": invoice.id,
            "invoice_number": invoice.invoice_number,
            "status": invoice_status(invoice),
            "outstanding_usd": invoice_outstanding(invoice),
            "message": (
                f"Payment confirmed and applied to invoice {invoice.invoice_number}."
            ),
        }
    payment.activation_applied_at = dt.datetime.now(dt.timezone.utc)
    return {
        "kind": "customer_invoice",
        "invoice_id": None,
        "message": (
            "Payment confirmed and held on the account. It will be allocated to the "
            "next invoice."
        ),
    }


# ── PDF documents ───────────────────────────────────────────────────────────

_INK = "#0f172a"
_MUTED = "#64748b"
_LINE = "#e2e8f0"


def _pdf_styles():
    from reportlab.lib.styles import ParagraphStyle

    base = ParagraphStyle("cb-base", fontName="Helvetica", fontSize=9, leading=13, textColor=_INK)
    small = ParagraphStyle("cb-small", parent=base, fontSize=8, textColor=_MUTED, leading=11)
    title = ParagraphStyle("cb-title", parent=base, fontSize=18, leading=22, spaceAfter=2)
    heading = ParagraphStyle("cb-heading", parent=base, fontSize=10, leading=13, spaceBefore=10, spaceAfter=4)
    right = ParagraphStyle("cb-right", parent=base, alignment=2)
    return base, small, title, heading, right


def _pdf_document(story: List[Any]) -> bytes:
    import io

    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title="Inferth Mapping billing document",
        author="Inferth Mapping",
    )
    doc.build(story)
    return buffer.getvalue()


def _pdf_table(rows: List[List[str]], widths: List[float], right_cols: Tuple[int, ...] = ()):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Table, TableStyle

    table = Table(rows, colWidths=[w * mm for w in widths])
    style = [
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor(_MUTED)),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor(_LINE)),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, colors.HexColor("#f1f5f9")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    for col in right_cols:
        style.append(("ALIGN", (col, 0), (col, -1), "RIGHT"))
    table.setStyle(TableStyle(style))
    return table


def _pdf_header(reseller: Optional[Tenant], subtitle: str):
    from reportlab.platypus import Paragraph, Spacer

    _, small, title, _, _ = _pdf_styles()
    business = escape(reseller.name if reseller else "Inferth Mapping")
    return [
        Paragraph(business, title),
        Paragraph(escape(subtitle), small),
        Spacer(1, 10),
    ]


def invoice_pdf(
    invoice: CustomerInvoice,
    customer: Tenant,
    reseller: Optional[Tenant],
    contact: Optional[Dict[str, Any]] = None,
) -> bytes:
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Spacer

    _, small, _, heading, _ = _pdf_styles()
    contact = contact or {}
    status = invoice_status(invoice).replace("_", " ").title()
    story = _pdf_header(reseller, f"Tax invoice {invoice.invoice_number}")
    story += [
        Paragraph(f"<b>Invoice</b> {escape(invoice.invoice_number)}", small),
        Paragraph(f"<b>Status</b> {escape(status)}", small),
        Paragraph(
            "<b>Billing period</b> "
            + (
                f"{invoice.billing_period_start.isoformat()} to {invoice.billing_period_end.isoformat()}"
                if invoice.billing_period_start and invoice.billing_period_end
                else "—"
            ),
            small,
        ),
        Paragraph(
            f"<b>Due date</b> {invoice.due_date.isoformat() if invoice.due_date else '—'}",
            small,
        ),
        Spacer(1, 12),
        Paragraph("Billed to", heading),
        Paragraph(escape(customer.name), small),
        Paragraph(escape(contact.get("email") or ""), small),
        Paragraph(escape(contact.get("phone") or ""), small),
        Spacer(1, 12),
        Paragraph("Charges", heading),
    ]

    rows: List[List[str]] = [["Description", "Qty", "Unit price", "Amount"]]
    for item in invoice.line_items or []:
        rows.append([
            escape(str(item.get("description") or "Tracking subscription")),
            str(item.get("quantity") or ""),
            f"${cash(item.get('unit_price_usd')):,.2f}",
            f"${cash(item.get('amount_usd')):,.2f}",
        ])
    story.append(_pdf_table(rows, [92, 16, 32, 32], right_cols=(1, 2, 3)))

    totals = [
        ["Subtotal", f"${cash(invoice.subtotal_usd):,.2f}"],
        ["Tax", f"${cash(invoice.tax_usd):,.2f}"],
        ["Adjustments", f"${cash(invoice.adjustments_usd):,.2f}"],
        ["Total", f"${cash(invoice.total_usd):,.2f}"],
        ["Paid", f"${cash(invoice.amount_paid_usd):,.2f}"],
        ["Outstanding", f"${invoice_outstanding(invoice):,.2f}"],
    ]
    story += [Spacer(1, 8), _pdf_table(totals, [140, 32], right_cols=(1,))]

    footer = []
    if contact.get("ecocash_number"):
        footer.append(f"EcoCash: {escape(str(contact.get('ecocash_number')))}")
    if contact.get("whatsapp_number"):
        footer.append(f"WhatsApp: {escape(str(contact.get('whatsapp_number')))}")
    if contact.get("payment_instructions"):
        footer.append(escape(str(contact.get("payment_instructions"))))
    footer.append("This invoice is issued by your tracking service provider. Keep it for your records.")
    story += [Spacer(1, 14)]
    for line in footer:
        story.append(Paragraph(line, small))

    return _pdf_document(story)


def receipt_pdf(
    txn: Transaction,
    customer: Tenant,
    reseller: Optional[Tenant],
    contact: Optional[Dict[str, Any]] = None,
    invoice_number: Optional[str] = None,
) -> bytes:
    from reportlab.platypus import Paragraph, Spacer

    _, small, _, heading, _ = _pdf_styles()
    contact = contact or {}
    story = _pdf_header(reseller, f"Payment receipt {receipt_number(txn)}")
    story += [
        Paragraph(f"<b>Receipt</b> {escape(receipt_number(txn))}", small),
        Paragraph(f"<b>Paid by</b> {escape(customer.name)}", small),
        Paragraph(
            "<b>Payment date</b> "
            + (
                txn.created_at.astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                if txn.created_at
                else "—"
            ),
            small,
        ),
        Paragraph(f"<b>Payment method</b> {escape((txn.payment_method or 'paynow').title())}", small),
        Paragraph(
            f"<b>Invoice</b> {escape(invoice_number)}" if invoice_number else "",
            small,
        ),
        Spacer(1, 12),
        Paragraph("Amount received", heading),
        _pdf_table(
            [
                ["Description", "Amount"],
                [
                    escape(txn.plan_name or "Tracking subscription payment"),
                    f"${cash(txn.amount_usd):,.2f}",
                ],
                ["Total paid", f"${cash(txn.amount_usd):,.2f}"],
            ],
            [140, 32],
            right_cols=(1,),
        ),
        Spacer(1, 12),
        Paragraph("Payment confirmed by the payment provider and recorded on your account.", small),
    ]
    if contact.get("whatsapp_number"):
        story.append(Paragraph(f"WhatsApp: {escape(str(contact.get('whatsapp_number')))}", small))
    return _pdf_document(story)


def receipt_number(txn: Transaction) -> str:
    return f"RCT-{txn.id}"
