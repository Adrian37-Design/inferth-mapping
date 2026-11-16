"""
Unit tests for retention policy resolution (no database required).

Run:  py -3 retention_policy_selftest.py
"""

from types import SimpleNamespace

from app.services.retention import (
    resolve_policy,
    TIER_BASIC,
    TIER_PREMIUM,
    TIER_ENTERPRISE,
    TIER_STARTER,
    TIER_PREPAID,
    TIER_RESELLER,
    MIN_RETENTION_DAYS,
)

failures = []


def tenant(**kw):
    base = dict(id=1, name="Acme", plan=None, billing_cycle=None, retention_days=None)
    base.update(kw)
    return SimpleNamespace(**base)


def check(label, condition, detail=""):
    if condition:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label} {detail}")
        failures.append(label)


print("Plan mapping")
check("Basic -> 30", resolve_policy(tenant(plan="Basic")).retention_days == 30)
check("Basic eligible", resolve_policy(tenant(plan="Basic")).eligible is True)
check("Premium -> 90", resolve_policy(tenant(plan="Premium")).retention_days == 90)
check("Pro treated as Premium", resolve_policy(tenant(plan="Pro")).tier == TIER_PREMIUM)
check("Premium tier", resolve_policy(tenant(plan="Premium")).tier == TIER_PREMIUM)
check("Starter Pass -> 30", resolve_policy(tenant(plan="Starter Pass")).tier == TIER_STARTER)
check("Once-off -> 30", resolve_policy(tenant(plan="Once-off")).retention_days == 30)
check("Prepaid -> 30", resolve_policy(tenant(plan="Prepaid")).tier == TIER_PREPAID)
check("Reseller -> 90", resolve_policy(tenant(plan="Reseller")).tier == TIER_RESELLER)

print("Enterprise")
ent = resolve_policy(tenant(plan="Enterprise"))
check("Enterprise without override is ineligible", ent.eligible is False)
check("Enterprise reason mentions override", "override" in ent.reason.lower())
ent_over = resolve_policy(tenant(plan="Enterprise", retention_days=365))
check("Enterprise override -> 365", ent_over.retention_days == 365)
check("Enterprise override eligible", ent_over.eligible is True)
check("Override below floor is raised to 30",
      resolve_policy(tenant(plan="Basic", retention_days=5)).retention_days == MIN_RETENTION_DAYS)
check("Absurd override rejected",
      resolve_policy(tenant(plan="Enterprise", retention_days=999999)).eligible is False)

print("Legacy billing cycles")
check("BYOT keeps Premium 90", resolve_policy(tenant(billing_cycle="BYOT")).retention_days == 90)
check("Rental -> Reseller 90", resolve_policy(tenant(billing_cycle="Rental")).tier == TIER_RESELLER)
check("Monthly -> Basic 30", resolve_policy(tenant(billing_cycle="Monthly")).retention_days == 30)
check("Wallet -> Prepaid 30", resolve_policy(tenant(billing_cycle="Wallet")).tier == TIER_PREPAID)

print("Row mapping input (API path)")
row = {"id": 42, "name": "Mapped Co", "plan": "Premium", "billing_cycle": "Monthly", "retention_days": None}
mapped = resolve_policy(row)
check("dict/RowMapping resolves id", mapped.tenant_id == 42)
check("dict/RowMapping resolves name", mapped.tenant_name == "Mapped Co")
check("dict/RowMapping resolves plan", mapped.retention_days == 90)

print("Fail closed")
unknown = resolve_policy(tenant(plan="Mystery", billing_cycle="Custom"))
check("Unknown plan/cycle ineligible", unknown.eligible is False)
check("Unknown has no retention days", unknown.retention_days is None)

print("")
if failures:
    print(f"{len(failures)} FAILURE(S): {', '.join(failures)}")
    raise SystemExit(1)
print("All retention policy checks passed.")
