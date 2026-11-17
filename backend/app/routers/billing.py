"""Wallet, pay-as-you-drive usage and optional feature purchases."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_middleware import get_current_user
from app.db import get_db
from app.models import (
    Device,
    DeviceFeature,
    DeviceUsageDaily,
    Tenant,
    TrackingSession,
    Transaction,
    User,
    WalletLedger,
)
from app.routers.payments import PAYNOW_ID, PAYNOW_KEY, paynow
from app.services import usage_billing as ub

router = APIRouter(prefix="/billing", tags=["billing"])

FEATURE_PREFIX = "Feature_"


async def _own_device(db: AsyncSession, user: User, device_id: int) -> Device:
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalars().first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if user.tenant_id != 1 and device.tenant_id != user.tenant_id:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.get("/features")
async def feature_catalog():
    return {
        "features": [
            {"key": key, **meta} for key, meta in ub.FEATURE_CATALOG.items()
        ],
        "wallet_min_usd": ub.WALLET_MIN_USD,
        "rate_per_hour_usd": ub.RATE_PER_HOUR_USD,
        "daily_cap_usd": ub.DAILY_CAP_USD,
        "settlement_seconds": ub.SETTLE_SECONDS,
    }


@router.get("/active-features")
async def active_features(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every active paid add-on for the tenant, across vehicles."""
    rows = (
        await db.execute(
            select(DeviceFeature, Device.name)
            .join(Device, Device.id == DeviceFeature.device_id)
            .where(
                DeviceFeature.tenant_id == current_user.tenant_id,
                DeviceFeature.status == "active",
            )
            .order_by(DeviceFeature.id.desc())
        )
    ).all()
    return {
        "features": [
            {
                "id": f.id,
                "device_id": f.device_id,
                "device_name": name,
                "feature": f.feature,
                "label": (ub.FEATURE_CATALOG.get(f.feature) or {}).get("label", f.feature),
                "source": f.source,
                "amount_usd": float(f.amount_usd or 0),
                "activated_at": f.activated_at.isoformat() if f.activated_at else None,
                "ends_at": f.ends_at.isoformat() if f.ends_at else None,
            }
            for f, name in rows
        ]
    }


@router.get("/devices/{device_id}/features")
async def device_features(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    device = await _own_device(db, current_user, device_id)
    rows = (
        await db.execute(
            select(DeviceFeature)
            .where(DeviceFeature.device_id == device.id)
            .order_by(DeviceFeature.id.desc())
        )
    ).scalars().all()
    return {
        "device_id": device.id,
        "device_name": device.name,
        "features": [
            {
                "id": f.id,
                "feature": f.feature,
                "label": (ub.FEATURE_CATALOG.get(f.feature) or {}).get("label", f.feature),
                "source": f.source,
                "status": f.status,
                "amount_usd": float(f.amount_usd or 0),
                "activated_at": f.activated_at.isoformat() if f.activated_at else None,
                "ends_at": f.ends_at.isoformat() if f.ends_at else None,
            }
            for f in rows
        ],
    }


@router.post("/devices/{device_id}/features/{key}")
async def buy_feature(
    device_id: int,
    key: str,
    source: str = "wallet",
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Buy one optional feature for one vehicle: from the wallet or via Paynow."""
    device = await _own_device(db, current_user, device_id)
    meta = ub.get_feature(key)
    if not meta:
        raise HTTPException(status_code=404, detail="Unknown feature")

    source = (source or "wallet").lower()
    if source == "wallet":
        tenant = (
            await db.execute(select(Tenant).where(Tenant.id == device.tenant_id))
        ).scalars().first()
        if not tenant:
            raise HTTPException(status_code=404, detail="Tenant not found")
        try:
            return await ub.activate_feature_from_wallet(db, tenant, device, key)
        except ValueError as exc:
            if str(exc) == "not_prepaid":
                raise HTTPException(
                    status_code=400,
                    detail="Wallet spending needs the Prepaid plan. Activate Prepaid to use your credit.",
                )
            if str(exc) == "wallet_floor":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Your wallet must keep at least ${ub.WALLET_MIN_USD:.2f} after a feature purchase. "
                        "Top up or buy this feature separately with Paynow."
                    ),
                )
            raise HTTPException(status_code=400, detail="Could not activate this feature")

    if source != "paynow":
        raise HTTPException(status_code=400, detail="source must be 'wallet' or 'paynow'")

    if not PAYNOW_ID or not PAYNOW_KEY:
        raise HTTPException(status_code=503, detail="Online payments are not configured")

    price = float(meta["price"])
    txn = Transaction(
        tenant_id=device.tenant_id,
        amount_usd=price,
        plan_name=f"{FEATURE_PREFIX}{key}_DEV_{device.id}",
        payment_method="paynow",
        status="pending",
    )
    db.add(txn)
    await db.commit()
    await db.refresh(txn)

    payment = paynow.create_payment(
        f"INV-{txn.id}", current_user.email or "billing@inferthmapping.co.zw"
    )
    payment.add(f"Inferth {meta['label']} - {device.name or ('device ' + str(device.id))}", price)
    response = paynow.send(payment)
    if not response.success:
        txn.status = "failed"
        await db.commit()
        raise HTTPException(status_code=502, detail="Paynow could not start the checkout")

    txn.paynow_reference = response.poll_url
    await db.commit()
    return {
        "redirect_url": response.redirect_url,
        "txn_id": txn.id,
        "amount": price,
        "feature": key,
        "device_id": device.id,
    }


@router.post("/tracking/{device_id}/start")
async def start_tracking(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    device = await _own_device(db, current_user, device_id)
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == device.tenant_id))
    ).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    try:
        session = await ub.start_session(db, tenant, device)
    except ValueError as exc:
        if str(exc) == "not_prepaid":
            raise HTTPException(
                status_code=400,
                detail="Pay-as-you-drive tracking applies to Prepaid Wallet accounts only.",
            )
        raise HTTPException(
            status_code=402,
            detail="Wallet balance is empty. Top up before activating tracking.",
        )
    return {
        "device_id": device.id,
        "status": session.status,
        "started_at": session.started_at.isoformat() if session.started_at else None,
        "wallet_balance_usd": ub.balance_of(tenant),
    }


@router.post("/tracking/{device_id}/stop")
async def stop_tracking(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    device = await _own_device(db, current_user, device_id)
    await ub.settle_sessions(db)
    await ub.stop_session(db, device.id, "deactivated")
    return {"device_id": device.id, "status": "ended"}


@router.get("/usage")
async def usage_summary(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == current_user.tenant_id))
    ).scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    sessions = (
        await db.execute(
            select(TrackingSession)
            .where(TrackingSession.tenant_id == tenant.id, TrackingSession.status.in_(["active", "paused"]))
            .order_by(TrackingSession.id.desc())
        )
    ).scalars().all()
    daily = (
        await db.execute(
            select(DeviceUsageDaily)
            .where(DeviceUsageDaily.tenant_id == tenant.id)
            .order_by(DeviceUsageDaily.day.desc())
            .limit(60)
        )
    ).scalars().all()
    ledger = (
        await db.execute(
            select(WalletLedger)
            .where(WalletLedger.tenant_id == tenant.id)
            .order_by(WalletLedger.id.desc())
            .limit(12)
        )
    ).scalars().all()

    return {
        "is_prepaid": ub.is_prepaid(tenant),
        "wallet_balance_usd": ub.balance_of(tenant),
        "available_usd": ub.balance_of(tenant) if ub.is_prepaid(tenant) else 0.0,
        "held_usd": 0.0 if ub.is_prepaid(tenant) else ub.balance_of(tenant),
        "rate_per_hour_usd": ub.RATE_PER_HOUR_USD,
        "daily_cap_usd": ub.DAILY_CAP_USD,
        "wallet_min_usd": ub.WALLET_MIN_USD,
        "settlement_seconds": ub.SETTLE_SECONDS,
        "open_sessions": [
            {
                "device_id": s.device_id,
                "status": s.status,
                "started_at": s.started_at.isoformat() if s.started_at else None,
                "minutes_billed": round(float(s.minutes_billed or 0), 4),
                "usd_billed": float(s.usd_billed or 0),
            }
            for s in sessions
        ],
        "daily": [
            {
                "device_id": d.device_id,
                "day": d.day.isoformat(),
                "minutes": round(float(d.minutes or 0), 4),
                "usd_billed": float(d.usd_billed or 0),
                "capped": bool(d.capped),
            }
            for d in daily
        ],
        "recent_ledger": [
            {
                "id": entry.id,
                "device_id": entry.device_id,
                "kind": entry.kind,
                "amount_usd": float(entry.amount_usd or 0),
                "balance_after_usd": float(entry.balance_after or 0),
                "reference": entry.reference,
                "created_at": entry.created_at.isoformat() if entry.created_at else None,
            }
            for entry in ledger
        ],
    }
