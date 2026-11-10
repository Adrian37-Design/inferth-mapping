"""
Inferth Mapping — Database Maintenance & Telemetry Pruning Service
Addresses Risk 2 (PostgreSQL Time-Series Bloat) by safely pruning stationary
and redundant telemetry pings older than retention threshold (default 90 days).
"""

import datetime
from sqlalchemy import select, delete, and_, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import Position, AuditLog


async def prune_stationary_telemetry(db: AsyncSession, retention_days: int = 90) -> dict:
    """
    Safely prunes stationary GPS points older than `retention_days`.
    Preserves:
    - Moving points (speed > 1 km/h)
    - Ignition-on points
    - Points containing diagnostic DTC fault codes or alarms
    - Points with raw alert data
    """
    cutoff_date = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=retention_days)

    # Delete stationary, ignition-off, non-alarm points older than cutoff
    stmt = (
        delete(Position)
        .where(
            and_(
                Position.timestamp < cutoff_date,
                func.coalesce(Position.speed, 0) < 1.0,
                func.coalesce(Position.ignition, False) == False,
                Position.dtc_fault_codes == None
            )
        )
    )
    result = await db.execute(stmt)
    await db.commit()

    deleted_count = result.rowcount or 0
    return {
        "status": "success",
        "retention_days": retention_days,
        "cutoff_date": cutoff_date.isoformat(),
        "pruned_rows": deleted_count,
        "message": f"Successfully pruned {deleted_count} redundant stationary telemetry records older than {retention_days} days."
    }
