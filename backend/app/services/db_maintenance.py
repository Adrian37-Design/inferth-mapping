"""
High-Performance Database Maintenance & Storage Optimization Service.

Provides automated storage hygiene, pruning, and indexing optimizations for
telematics scale:
1. Storage statistics & health audit
2. Heartbeat & null-ping pruning (removes valueless pings older than N days)
3. Stationary downsampling (preserves trip endpoints while pruning redundant zero-speed pings)
4. PostgreSQL index optimization (ANALYZE / REINDEX)
"""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text, func, select, delete, and_
from datetime import datetime, timedelta
from typing import Dict, Any, Optional
from app.models import Position, Device, Alert


async def get_storage_stats(db: AsyncSession) -> Dict[str, Any]:
    """Retrieve table row counts, storage footprint, and indexing health."""
    stats = {
        "positions_total_rows": 0,
        "valid_coords_rows": 0,
        "can_obd_rows": 0,
        "devices_count": 0,
        "alerts_count": 0,
        "database_type": "postgresql"
    }

    try:
        # Total positions count
        pos_q = await db.execute(select(func.count(Position.id)))
        stats["positions_total_rows"] = pos_q.scalar() or 0

        # Valid coordinate rows
        valid_q = await db.execute(
            select(func.count(Position.id)).where(
                Position.latitude.is_not(None),
                Position.latitude != 0.0
            )
        )
        stats["valid_coords_rows"] = valid_q.scalar() or 0

        # CAN/OBD diagnostic rows
        obd_q = await db.execute(
            select(func.count(Position.id)).where(
                (Position.rpm.is_not(None)) | (Position.fuel_level.is_not(None))
            )
        )
        stats["can_obd_rows"] = obd_q.scalar() or 0

        # Devices count
        dev_q = await db.execute(select(func.count(Device.id)))
        stats["devices_count"] = dev_q.scalar() or 0

        # Alerts count
        alert_q = await db.execute(select(func.count(Alert.id)))
        stats["alerts_count"] = alert_q.scalar() or 0

        # PostgreSQL-specific table size in MB (if supported)
        try:
            pg_size_q = await db.execute(
                text("SELECT pg_size_pretty(pg_total_relation_size('positions'))")
            )
            stats["positions_table_size"] = pg_size_q.scalar()
        except Exception:
            stats["positions_table_size"] = "N/A"

    except Exception as e:
        stats["error"] = str(e)

    return stats


async def prune_old_heartbeats(db: AsyncSession, days: int = 30) -> int:
    """
    Deletes heartbeat pings that have NO coordinates and NO OBD/diagnostic data
    older than `days` days. These pings contain zero analytical or mapping value.
    """
    cutoff = datetime.utcnow() - timedelta(days=days)

    stmt = delete(Position).where(
        Position.timestamp < cutoff,
        Position.latitude.is_(None),
        Position.rpm.is_(None),
        Position.fuel_level.is_(None),
        Position.dtc_fault_codes.is_(None)
    )

    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount or 0


async def optimize_database_indexes(db: AsyncSession) -> Dict[str, Any]:
    """
    Runs ANALYZE on PostgreSQL to update query planner statistics for
    composite and partial indexes.
    """
    results = {"status": "success", "operations": []}
    try:
        await db.execute(text("ANALYZE positions;"))
        results["operations"].append("ANALYZE positions")
        await db.execute(text("ANALYZE devices;"))
        results["operations"].append("ANALYZE devices")
        await db.commit()
    except Exception as e:
        results["status"] = "notice"
        results["message"] = f"Index maintenance completed with notice: {e}"

    return results

async def get_disk_report(db: AsyncSession) -> Dict[str, Any]:
    """
    Where the volume's bytes actually went. Answers the only question that
    matters when PostgreSQL panics with "No space left on device": is it the
    positions heap, its indexes, WAL, or a stale replication slot?

    Every probe is independent - one failing (pg_ls_waldir needs a privileged
    role) never hides the others.
    """
    report: Dict[str, Any] = {"database_type": "postgresql"}

    async def probe(key: str, sql: str, many: bool = False) -> None:
        try:
            result = await db.execute(text(sql))
            if many:
                report[key] = [dict(r) for r in result.mappings().all()]
            else:
                row = result.mappings().first()
                report[key] = dict(row) if row else None
        except Exception as exc:
            # A failed statement poisons the transaction; roll back so the
            # remaining probes still run.
            try:
                await db.rollback()
            except Exception:
                pass
            report[key] = {"error": str(exc)}

    await probe("database", (
        "SELECT current_database() AS name, "
        "pg_size_pretty(pg_database_size(current_database())) AS size, "
        "pg_database_size(current_database()) AS bytes"
    ))

    await probe("largest_relations", (
        "SELECT c.relname AS relation, "
        "pg_size_pretty(pg_total_relation_size(c.oid)) AS total, "
        "pg_total_relation_size(c.oid) AS total_bytes, "
        "pg_size_pretty(pg_relation_size(c.oid)) AS heap, "
        "pg_size_pretty(pg_indexes_size(c.oid)) AS indexes "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind = 'r' "
        "ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15"
    ), many=True)

    await probe("positions_bloat", (
        "SELECT relname, n_live_tup, n_dead_tup, "
        "pg_size_pretty(pg_total_relation_size(relid)) AS total, "
        "last_vacuum, last_autovacuum, last_analyze, "
        "autovacuum_count, vacuum_count "
        "FROM pg_stat_user_tables WHERE relname = 'positions'"
    ))

    await probe("wal", (
        "SELECT count(*) AS segments, "
        "pg_size_pretty(coalesce(sum(size), 0)) AS size "
        "FROM pg_ls_waldir()"
    ))

    await probe("replication_slots", (
        "SELECT slot_name, slot_type, active, "
        "pg_size_pretty(coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)) "
        "AS retained_wal "
        "FROM pg_replication_slots"
    ), many=True)

    await probe("wal_settings", (
        "SELECT name, setting, unit FROM pg_settings WHERE name IN "
        "('wal_level', 'max_wal_size', 'min_wal_size', 'checkpoint_timeout', "
        "'archive_mode', 'autovacuum', 'autovacuum_naptime') ORDER BY name"
    ), many=True)

    return report


async def reclaim_position_space() -> Dict[str, Any]:
    """
    VACUUM (ANALYZE) positions so space freed by the retention worker becomes
    reusable.

    A DELETE only marks tuples dead: the heap file keeps every byte, so pruning
    rows does NOT stop the volume growing. Autovacuum reclaims for reuse but
    lags badly on a hot append table, and nothing returns space to the OS
    without a rewrite. Runs right after a delete pass, on its own autocommit
    connection (PostgreSQL refuses VACUUM inside a transaction block) with the
    app's 10 second command timeout lifted.

    VACUUM FULL is deliberately never automatic: it takes an ACCESS EXCLUSIVE
    lock and needs free space equal to the table, which is exactly what a full
    volume does not have.
    """
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool
    from app.db import DATABASE_URL

    out: Dict[str, Any] = {"status": "success", "operations": []}
    engine = None
    try:
        engine = create_async_engine(
            DATABASE_URL,
            poolclass=NullPool,
            connect_args={"timeout": 15, "command_timeout": None},
        )
        async with engine.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.execute(text("VACUUM (ANALYZE) positions"))
            out["operations"].append("VACUUM (ANALYZE) positions")
            row = (await conn.execute(text(
                "SELECT pg_size_pretty(pg_total_relation_size('positions')) AS size"
            ))).mappings().first()
            if row:
                out["positions_size"] = row.get("size")
    except Exception as exc:
        out["status"] = "notice"
        out["message"] = str(exc)
    finally:
        if engine is not None:
            try:
                await engine.dispose()
            except Exception:
                pass
    return out
