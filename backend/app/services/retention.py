"""
Tenant-aware GPS position retention — policy resolution and read-only dry run.

Phase 1 scope:
  * resolve each tenant's retention entitlement
  * report exactly how many rows a cleanup WOULD remove
  * never delete, update or move any data

Deletion is intentionally not implemented here. A separate, explicitly enabled
worker will consume these policies once the dry-run numbers have been reviewed.

Entitlement decisions (approved):
  * Basic ................ 30 days
  * Premium .............. 90 days
  * Enterprise ........... configurable via tenants.retention_days
  * Starter Pass (once-off) 30 days
  * Prepaid wallet ....... 30 days
  * Reseller ............. 90 days by default (per end customer override)
  * Legacy BYOT .......... 90 days (retired plan; generous so nothing is lost)
  * Unknown / unset ...... NOT eligible (fail closed)
  * Devices without tenant_id ... exempt from any future deletion
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# Keep a few newest fixes per device even after the cutoff so the live map,
# "last seen" and the end of the latest trip never lose their anchor point.
KEEP_LATEST_PER_DEVICE = 3

# Global floor: no policy may ever delete anything newer than this.
MIN_RETENTION_DAYS = 30
MAX_RETENTION_DAYS = 3650

TIER_BASIC = "basic"
TIER_PREMIUM = "premium"
TIER_ENTERPRISE = "enterprise"
TIER_STARTER = "starter-pass"
TIER_PREPAID = "prepaid"
TIER_RESELLER = "reseller"
TIER_UNKNOWN = "unknown"

ENTERPRISE_DEFAULT_DAYS = 90  # used only when an override is missing? No — fail closed.
FIXED_DAYS = {
    TIER_BASIC: 30,
    TIER_PREMIUM: 90,
    TIER_STARTER: 30,
    TIER_PREPAID: 30,
    TIER_RESELLER: 90,
}


@dataclass(frozen=True)
class RetentionPolicy:
    tenant_id: int
    tenant_name: str
    tier: str
    retention_days: Optional[int]
    source: str
    eligible: bool
    reason: str
    plan: str
    billing_cycle: str

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _norm(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def _field(obj: Any, key: str, default: Any = None) -> Any:
    """Read from an ORM row, a dict or a SQLAlchemy RowMapping."""
    try:
        return obj[key] if key in obj else default
    except TypeError:
        return getattr(obj, key, default)


def resolve_policy(tenant: Any) -> RetentionPolicy:
    """
    Resolve a tenant's retention entitlement.

    Order of precedence:
      1. explicit tenants.retention_days override (Enterprise / negotiated)
      2. tenants.plan
      3. tenants.billing_cycle (legacy display strings)
      4. fail closed

    Anything ambiguous or unknown is marked ineligible rather than being given
    a short retention, so a cleanup can never shorten an entitlement by mistake.
    """
    tenant_id = int(_field(tenant, "id", 0) or 0)
    name = _field(tenant, "name", "") or f"tenant {tenant_id}"
    plan = _norm(_field(tenant, "plan", ""))
    cycle = _norm(_field(tenant, "billing_cycle", ""))
    override = _field(tenant, "retention_days", None)

    base = dict(
        tenant_id=tenant_id,
        tenant_name=name,
        tier=TIER_UNKNOWN,
        retention_days=None,
        source="none",
        eligible=False,
        reason="",
        plan=plan or "unset",
        billing_cycle=cycle or "unset",
    )

    # 1. Explicit override wins for every plan.
    if override is not None:
        try:
            days = int(override)
        except (TypeError, ValueError):
            return RetentionPolicy(**{**base, "source": "override",
                                      "reason": "retention_days is not a number"})
        if days < 1 or days > MAX_RETENTION_DAYS:
            return RetentionPolicy(**{**base, "source": "override",
                                      "reason": f"retention_days {days} outside 1..{MAX_RETENTION_DAYS}"})
        days = max(days, MIN_RETENTION_DAYS)
        return RetentionPolicy(**{**base, "tier": TIER_ENTERPRISE, "retention_days": days,
                                  "source": "override", "eligible": True,
                                  "reason": "explicit tenant override"})

    # 2. Plan name.
    if "enterprise" in plan:
        return RetentionPolicy(**{**base, "tier": TIER_ENTERPRISE,
                                  "reason": "Enterprise plan has no retention_days override yet"})
    if "premium" in plan or plan == "pro":
        return RetentionPolicy(**{**base, "tier": TIER_PREMIUM,
                                  "retention_days": FIXED_DAYS[TIER_PREMIUM],
                                  "source": "plan", "eligible": True,
                                  "reason": "Premium plan"})
    if "starter" in plan or "once" in plan or "lifetime" in plan:
        return RetentionPolicy(**{**base, "tier": TIER_STARTER,
                                  "retention_days": FIXED_DAYS[TIER_STARTER],
                                  "source": "plan", "eligible": True,
                                  "reason": "Starter Pass (once-off)"})
    if "prepaid" in plan or "wallet" in plan:
        return RetentionPolicy(**{**base, "tier": TIER_PREPAID,
                                  "retention_days": FIXED_DAYS[TIER_PREPAID],
                                  "source": "plan", "eligible": True,
                                  "reason": "Prepaid wallet"})
    if "resell" in plan:
        return RetentionPolicy(**{**base, "tier": TIER_RESELLER,
                                  "retention_days": FIXED_DAYS[TIER_RESELLER],
                                  "source": "plan", "eligible": True,
                                  "reason": "Reseller (per end customer override)"})
    if "basic" in plan:
        return RetentionPolicy(**{**base, "tier": TIER_BASIC,
                                  "retention_days": FIXED_DAYS[TIER_BASIC],
                                  "source": "plan", "eligible": True,
                                  "reason": "Basic plan"})

    # 3. Legacy billing-cycle strings (plan column is not maintained for
    #    older customers; cycle is what the billing UI historically stored).
    if "byot" in cycle or "tracker" in cycle:
        return RetentionPolicy(**{**base, "tier": TIER_PREMIUM,
                                  "retention_days": FIXED_DAYS[TIER_PREMIUM],
                                  "source": "billing_cycle", "eligible": True,
                                  "reason": "Legacy BYOT customer — kept on Premium retention"})
    if "rent" in cycle or "resell" in cycle:
        return RetentionPolicy(**{**base, "tier": TIER_RESELLER,
                                  "retention_days": FIXED_DAYS[TIER_RESELLER],
                                  "source": "billing_cycle", "eligible": True,
                                  "reason": "Reseller / rental cycle (per end customer override)"})
    if "prepaid" in cycle or "wallet" in cycle:
        return RetentionPolicy(**{**base, "tier": TIER_PREPAID,
                                  "retention_days": FIXED_DAYS[TIER_PREPAID],
                                  "source": "billing_cycle", "eligible": True,
                                  "reason": "Prepaid cycle"})
    if "once" in cycle or "starter" in cycle:
        return RetentionPolicy(**{**base, "tier": TIER_STARTER,
                                  "retention_days": FIXED_DAYS[TIER_STARTER],
                                  "source": "billing_cycle", "eligible": True,
                                  "reason": "Once-off cycle"})
    if "month" in cycle:
        return RetentionPolicy(**{**base, "tier": TIER_BASIC,
                                  "retention_days": FIXED_DAYS[TIER_BASIC],
                                  "source": "billing_cycle", "eligible": True,
                                  "reason": "Monthly cycle with no explicit plan tier"})

    # 4. Fail closed.
    return RetentionPolicy(**{**base, "reason": "Plan and billing cycle are both unknown"})


def _cutoff(days: int, now: Optional[dt.datetime] = None) -> dt.datetime:
    now = now or dt.datetime.now(dt.timezone.utc)
    return now - dt.timedelta(days=days)


_COUNT_SQL = text(
    """
    WITH ranked AS (
        SELECT p.id,
               p.timestamp,
               row_number() OVER (
                   PARTITION BY p.device_id ORDER BY p.timestamp DESC
               ) AS rn
        FROM positions p
        JOIN devices d ON d.id = p.device_id
        WHERE d.tenant_id = :tenant_id
    )
    SELECT count(*) AS total_rows,
           count(*) FILTER (WHERE timestamp < :cutoff) AS expired_rows,
           count(*) FILTER (WHERE timestamp < :cutoff AND rn <= :keep) AS protected_rows,
           min(timestamp) AS oldest_ts,
           max(timestamp) AS newest_ts
    FROM ranked
    """
)

_UNOWNED_SQL = text(
    """
    SELECT count(*) AS unowned_positions,
           count(DISTINCT p.device_id) AS unowned_devices
    FROM positions p
    LEFT JOIN devices d ON d.id = p.device_id
    WHERE d.id IS NULL OR d.tenant_id IS NULL
    """
)


async def _scalar_map(db: AsyncSession, sql: str) -> Dict[str, Any]:
    row = (await db.execute(text(sql))).mappings().first()
    return dict(row) if row else {}


async def dry_run_report(
    db: AsyncSession,
    tenant_id: Optional[int] = None,
    keep_latest: int = KEEP_LATEST_PER_DEVICE,
) -> Dict[str, Any]:
    """
    Read-only report: how many position rows each tenant would lose under its
    resolved policy. Issues SELECT statements only.
    """
    now = dt.datetime.now(dt.timezone.utc)

    # Best-effort statement timeout so a reporting call can never hold locks
    # long enough to disturb live ingest.
    try:
        await db.execute(text("SET LOCAL statement_timeout = '30000ms'"))
    except Exception:
        pass

    tenants_sql = "SELECT id, name, plan, billing_cycle, retention_days FROM tenants"
    params: Dict[str, Any] = {}
    if tenant_id is not None:
        tenants_sql += " WHERE id = :tid"
        params["tid"] = tenant_id
    tenants_sql += " ORDER BY id"
    tenant_rows = (await db.execute(text(tenants_sql), params)).mappings().all()

    devices_by_tenant = {
        int(r["tenant_id"]): int(r["devices"])
        for r in (
            await db.execute(
                text(
                    "SELECT tenant_id, count(*) AS devices FROM devices "
                    "WHERE tenant_id IS NOT NULL GROUP BY tenant_id"
                )
            )
        ).mappings()
    }

    report_rows: List[Dict[str, Any]] = []
    eligible = 0
    expired_total = 0
    delete_total = 0

    for row in tenant_rows:
        policy = resolve_policy(row)
        entry: Dict[str, Any] = policy.as_dict()
        entry["devices"] = devices_by_tenant.get(policy.tenant_id, 0)

        counts: Dict[str, Any] = {}
        if policy.eligible and policy.retention_days:
            try:
                counts = dict(
                    (
                        await db.execute(
                            _COUNT_SQL,
                            {
                                "tenant_id": policy.tenant_id,
                                "cutoff": _cutoff(policy.retention_days, now),
                                "keep": keep_latest,
                            },
                        )
                    ).mappings().first()
                    or {}
                )
            except Exception as exc:  # report the failure, never fail the whole run
                entry["error"] = f"count failed: {exc}"
                counts = {}

        total_rows = int(counts.get("total_rows") or 0)
        expired = int(counts.get("expired_rows") or 0)
        protected = int(counts.get("protected_rows") or 0)
        would_delete = max(0, expired - protected)

        entry.update(
            {
                "total_rows": total_rows,
                "expired_rows": expired,
                "protected_last_fixes": protected,
                "would_delete_rows": would_delete,
                "oldest_timestamp": counts.get("oldest_ts"),
                "newest_timestamp": counts.get("newest_ts"),
                "cutoff_utc": _cutoff(policy.retention_days, now) if policy.retention_days else None,
            }
        )
        if policy.eligible:
            eligible += 1
            expired_total += expired
            delete_total += would_delete
        report_rows.append(entry)

    unowned = await _scalar_map(db, str(_UNOWNED_SQL))
    table_size = "N/A"
    total_positions = 0
    try:
        row = (
            await db.execute(
                text(
                    "SELECT pg_size_pretty(pg_total_relation_size('positions')) AS size, "
                    "(SELECT count(*) FROM positions) AS total"
                )
            )
        ).mappings().first()
        if row:
            table_size = row.get("size") or "N/A"
            total_positions = int(row.get("total") or 0)
    except Exception:
        pass

    return {
        "generated_at": now.isoformat(),
        "dry_run": True,
        "deletes_performed": 0,
        "keep_latest_per_device": keep_latest,
        "min_retention_days": MIN_RETENTION_DAYS,
        "positions_total_rows": total_positions,
        "positions_table_size": table_size,
        "unowned_positions_rows": int(unowned.get("unowned_positions") or 0),
        "unowned_devices": int(unowned.get("unowned_devices") or 0),
        "summary": {
            "tenants_reported": len(report_rows),
            "eligible_tenants": eligible,
            "expired_rows": expired_total,
            "would_delete_rows": delete_total,
        },
        "tenants": report_rows,
    }
