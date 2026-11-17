"""Pay-as-you-drive wallet billing.

Rate model (per vehicle):
  * $0.02 per hour of *elapsed* active tracking time (not per GPS message).
  * Charges accumulate internally and are settled every 5 minutes.
  * A 2-minute session costs ~$0.00067 — the 5-minute tick is a settlement
    interval, never a minimum charge.
  * Hard cap of $0.40 per vehicle per 24-hour period.
  * Tracking pauses when the wallet cannot cover the next settlement.
  * Wallet-funded features end when the balance reaches $0.
  * Balances are stored to 6 dp (customer-facing display rounds to 2 dp).
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any, Dict, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Device,
    DeviceFeature,
    DeviceUsageDaily,
    Tenant,
    TrackingSession,
    WalletLedger,
)

logger = logging.getLogger(__name__)

RATE_PER_HOUR_USD = 0.02
DAILY_CAP_USD = 0.40
WALLET_MIN_USD = 10.00
SETTLE_SECONDS = 300
FRACTIONAL_DAY_MINUTES = 24 * 60

# Optional features: key -> (label, price in USD, activation period in days)
FEATURE_CATALOG: Dict[str, Dict[str, Any]] = {
    "route_history": {"label": "Route history & playback", "price": 1.00, "days": 0},
    "geofencing": {"label": "Geofencing & alerts", "price": 1.00, "days": 0},
    "whatsapp_reports": {"label": "WhatsApp reports", "price": 1.00, "days": 0},
    "can_obd": {"label": "CAN/OBD diagnostics", "price": 3.00, "days": 30},
    "fuel_monitoring": {"label": "Fuel monitoring", "price": 2.00, "days": 30},
    "immobilisation": {"label": "Remote immobilisation", "price": 2.00, "days": 30},
}


def money(value: float) -> float:
    """Round to the 6 dp precision the wallet and ledger are stored at."""
    return round(float(value or 0.0), 6)


def balance_of(tenant: Tenant) -> float:
    return money(tenant.wallet_balance_usd or 0.0)


def is_prepaid(tenant: Tenant) -> bool:
    """Usage billing only applies to Prepaid Wallet accounts."""
    if not tenant:
        return False
    plan = (tenant.plan or "").strip().lower()
    cycle = (tenant.billing_cycle or "").strip().lower()
    return "prepaid" in plan or "wallet" in plan or "prepaid" in cycle or "wallet" in cycle


def _log(db: AsyncSession, tenant_id: int, device_id: Optional[int], kind: str,
         amount: float, balance_after: float, reference: str = "") -> None:
    db.add(WalletLedger(
        tenant_id=tenant_id,
        device_id=device_id,
        kind=kind,
        amount_usd=money(amount),
        balance_after=money(balance_after),
        reference=reference,
    ))


async def _daily_row(db: AsyncSession, device_id: int, tenant_id: int, day: dt.date) -> DeviceUsageDaily:
    row = (
        await db.execute(
            select(DeviceUsageDaily).where(
                DeviceUsageDaily.device_id == device_id,
                DeviceUsageDaily.day == day,
            )
        )
    ).scalars().first()
    if not row:
        row = DeviceUsageDaily(
            device_id=device_id, tenant_id=tenant_id, day=day,
            minutes=0.0, usd_billed=0.0, capped=False,
        )
        db.add(row)
        await db.flush()
    return row


async def start_session(db: AsyncSession, tenant: Tenant, device: Device) -> TrackingSession:
    existing = (
        await db.execute(
            select(TrackingSession).where(
                TrackingSession.device_id == device.id,
                TrackingSession.status == "active",
            )
        )
    ).scalars().first()
    if existing:
        return existing

    if not is_prepaid(tenant):
        raise ValueError("not_prepaid")
    if balance_of(tenant) <= 0:
        raise ValueError("wallet_empty")

    now = dt.datetime.now(dt.timezone.utc)
    session = TrackingSession(
        tenant_id=tenant.id, device_id=device.id, status="active",
        started_at=now, last_settled_at=now, minutes_billed=0.0, usd_billed=0.0,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def stop_session(db: AsyncSession, device_id: int, reason: str = "deactivated") -> int:
    now = dt.datetime.now(dt.timezone.utc)
    result = await db.execute(
        update(TrackingSession)
        .where(TrackingSession.device_id == device_id, TrackingSession.status == "active")
        .values(status="ended", ended_at=now, ended_reason=reason)
    )
    await db.commit()
    return result.rowcount or 0


async def end_wallet_features(db: AsyncSession, tenant_id: int, reason: str = "wallet_empty") -> int:
    result = await db.execute(
        update(DeviceFeature)
        .where(
            DeviceFeature.tenant_id == tenant_id,
            DeviceFeature.source == "wallet",
            DeviceFeature.status == "active",
        )
        .values(status="ended", ended_reason=reason)
    )
    return result.rowcount or 0


async def settle_sessions(db: AsyncSession) -> Dict[str, Any]:
    """Charge every open tracking session for the time elapsed since its last tick."""
    now = dt.datetime.now(dt.timezone.utc)
    sessions = (
        await db.execute(
            select(TrackingSession)
            .where(TrackingSession.status == "active")
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()

    charged_total = 0.0
    paused = 0
    settled = 0

    for session in sessions:
        last = session.last_settled_at or session.started_at or now
        if last.tzinfo is None:
            last = last.replace(tzinfo=dt.timezone.utc)
        elapsed_minutes = (now - last).total_seconds() / 60.0
        if elapsed_minutes <= 0:
            continue

        tenant = (
            await db.execute(select(Tenant).where(Tenant.id == session.tenant_id))
        ).scalars().first()
        if not tenant:
            continue
        if not is_prepaid(tenant):
            # Defensive: usage billing never charges a monthly/once-off/rental plan.
            session.status = "ended"
            session.ended_at = now
            session.ended_reason = "plan_not_prepaid"
            continue

        daily = await _daily_row(db, session.device_id, session.tenant_id, now.date())
        remaining_cap = max(0.0, DAILY_CAP_USD - money(daily.usd_billed))
        if remaining_cap <= 0.000001:
            daily.capped = True
            session.last_settled_at = now
            settled += 1
            continue

        cost = min(money(elapsed_minutes / 60.0 * RATE_PER_HOUR_USD), money(remaining_cap))
        balance = balance_of(tenant)
        if balance <= 0 or balance < cost:
            # Rule 6: stop billing and pause tracking when the balance cannot cover usage.
            await db.execute(
                update(TrackingSession)
                .where(
                    TrackingSession.tenant_id == session.tenant_id,
                    TrackingSession.status == "active",
                )
                .values(status="paused", ended_at=now, ended_reason="insufficient_balance")
            )
            await end_wallet_features(db, session.tenant_id, "wallet_empty")
            paused += 1
            continue

        tenant.wallet_balance_usd = money(balance - cost)
        session.minutes_billed = float(session.minutes_billed or 0) + elapsed_minutes
        session.usd_billed = money(float(session.usd_billed or 0) + cost)
        session.last_settled_at = now
        daily.minutes = float(daily.minutes or 0) + elapsed_minutes
        daily.usd_billed = money(float(daily.usd_billed or 0) + cost)
        if money(daily.usd_billed) >= DAILY_CAP_USD - 0.000001:
            daily.capped = True

        _log(db, session.tenant_id, session.device_id, "usage", -cost,
             balance_of(tenant), f"device {session.device_id}")
        charged_total += cost

        if balance_of(tenant) <= 0:
            await end_wallet_features(db, session.tenant_id, "wallet_empty")
            await db.execute(
                update(TrackingSession)
                .where(
                    TrackingSession.tenant_id == session.tenant_id,
                    TrackingSession.status == "active",
                )
                .values(status="paused", ended_at=now, ended_reason="insufficient_balance")
            )
            paused += 1

    await db.commit()
    if charged_total or paused:
        logger.info("usage settlement: charged $%.6f, paused %s sessions", charged_total, paused)
    return {"settled": settled, "charged_usd": money(charged_total), "paused": paused}


def get_feature(key: str) -> Optional[Dict[str, Any]]:
    return FEATURE_CATALOG.get(key)


async def activate_feature_from_wallet(
    db: AsyncSession, tenant: Tenant, device: Device, key: str
) -> Dict[str, Any]:
    meta = get_feature(key)
    if not meta:
        raise ValueError("unknown_feature")

    price = money(meta["price"])
    balance = balance_of(tenant)
    # Wallet purchases must leave the $10 minimum intact.
    if balance - price < WALLET_MIN_USD:
        raise ValueError("wallet_floor")

    tenant.wallet_balance_usd = money(balance - price)
    feature = DeviceFeature(
        tenant_id=tenant.id, device_id=device.id, feature=key, source="wallet",
        amount_usd=price, status="active", ends_at=None,
    )
    db.add(feature)
    _log(db, tenant.id, device.id, "feature", -price, balance_of(tenant), key)
    await db.commit()
    await db.refresh(feature)
    return {
        "feature": key,
        "status": "active",
        "source": "wallet",
        "charged_usd": price,
        "wallet_balance_usd": balance_of(tenant),
    }


async def activate_feature_from_payment(
    db: AsyncSession, tenant_id: int, device_id: int, key: str, transaction_id: int
) -> Optional[DeviceFeature]:
    meta = get_feature(key)
    if not meta:
        return None
    days = int(meta.get("days") or 0)
    ends_at = None
    if days:
        ends_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)
    feature = DeviceFeature(
        tenant_id=tenant_id, device_id=device_id, feature=key, source="paynow",
        amount_usd=money(meta["price"]), status="active", transaction_id=transaction_id,
        ends_at=ends_at,
    )
    db.add(feature)
    await db.commit()
    await db.refresh(feature)
    return feature
