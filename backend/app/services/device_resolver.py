"""
Single authoritative device-resolution chain for tracker identities.

Physical trackers alternate identities across message types — full IMEI in
one packet, a short/SIM/plate id in another, a JWT plate claim in a third.
Every ingest, violation, and command path MUST resolve through this helper;
a local exact-match lookup is how duplicate phantom devices get created for
one physical unit.
"""

from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Device


async def resolve_device(db: AsyncSession, ident) -> Optional[Device]:
    """Resolve a tracker-reported identity to its authoritative Device row.

    Returns None when no device claims the identity — callers decide whether
    to auto-provision (ingest paths) or reject (signed API calls).
    """
    ident = str(ident or "").strip()
    if not ident:
        return None

    # 1. Exact IMEI
    res = await db.execute(select(Device).where(Device.imei == ident))
    device = res.scalars().first()
    if device:
        return device

    if len(ident) >= 6:
        # 2. Tracker posts a long identity while the device was registered
        #    under its short id (e.g. plate YZ4321).
        res = await db.execute(select(Device).where(Device.imei == ident[-6:]))
        device = res.scalars().first()
        if device:
            return device

        # 3. Device name contains the tail (legacy "Tracker (YZ4321)" naming)
        res = await db.execute(select(Device).where(Device.name.ilike(f"%{ident[-6:]}%")))
        device = res.scalars().first()
        if device:
            return device

    if len(ident) < 15:
        # 4. Short ident is the tail of a stored full IMEI.
        res = await db.execute(select(Device).where(Device.imei.like(f"%{ident}")))
        device = res.scalars().first()
        if device:
            return device

    # 5. Aliases: device_metadata {"aliases": [...]} records every identity a
    #    physical tracker reports (full IMEI, SIM number, plate id) so all of
    #    them resolve to one device. Postgres JSONB '?' tests array membership.
    res = await db.execute(
        select(Device).where(text("device_metadata::jsonb -> 'aliases' ? :ident")).params(ident=ident)
    )
    return res.scalars().first()
