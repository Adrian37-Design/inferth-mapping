from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from pydantic import BaseModel

from app.config import settings
from app.db import get_db
from app.models import TrackerSecret, User
from app.auth_middleware import require_super_admin

router = APIRouter(prefix="/tracker-secrets", tags=["Tracker Secrets"])


class SecretSet(BaseModel):
    secret: str


@router.put("/{imei}")
async def set_tracker_secret(
    imei: str,
    payload: SecretSet,
    current_user: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """Register or rotate a tracker's signing secret. Platform admin only."""
    secret = (payload.secret or "").strip()
    if not (32 <= len(secret) <= 72):
        raise HTTPException(status_code=400, detail="Secret must be between 32 and 72 characters")
    imei = imei.strip()
    row = (await db.execute(select(TrackerSecret).where(TrackerSecret.imei == imei))).scalars().first()
    if row:
        row.secret = secret
        row.created_by = current_user.id
    else:
        db.add(TrackerSecret(imei=imei, secret=secret, created_by=current_user.id))
    await db.commit()
    return {"imei": imei, "configured": True}


@router.get("/")
async def list_tracker_secrets(
    current_user: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """List which trackers have a configured secret. Secret values are never returned."""
    rows = (await db.execute(select(TrackerSecret).order_by(TrackerSecret.imei))).scalars().all()
    registered = {r.imei for r in rows}
    entries = [{"imei": r.imei, "source": "registry", "created_at": r.created_at} for r in rows]
    entries += [{"imei": i, "source": "environment", "created_at": None}
                for i in settings.TRACKER_JWT_SECRETS if i not in registered]
    return entries


@router.delete("/{imei}")
async def delete_tracker_secret(
    imei: str,
    current_user: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """Remove a registered tracker secret. Platform admin only."""
    row = (await db.execute(select(TrackerSecret).where(TrackerSecret.imei == imei.strip()))).scalars().first()
    if not row:
        raise HTTPException(status_code=404, detail="No secret registered for this tracker")
    await db.delete(row)
    await db.commit()
    return {"imei": imei, "configured": False}
