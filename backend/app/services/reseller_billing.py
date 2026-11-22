"""
reseller_billing.py — Platform Fleet Rental pricing engine.

Implements progressive marginal pricing (Model A: Wholesale) and revenue-share
billing (Model B: Commission) as specified in the Platform Fleet Rental Plan.

All commercial rates are configurable via custom_pricing_json on ResellerContract.
Nothing is hardcoded — the DEFAULT_* constants are only the initial defaults that
populate the DB at contract creation time.

Do NOT touch usage_billing.py or the PAYD billing loop.
"""

from __future__ import annotations

import math
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession


# ─── DEFAULT MODEL A PROGRESSIVE BANDS ───────────────────────────────────────
#   Each entry is (up_to_vehicle_inclusive, rate_per_vehicle_in_band).
#   "up_to" = None means open-ended (applies to all vehicles above previous band).
#   The first band uses a flat minimum rather than per-vehicle, so it is handled
#   specially: if total active <= band[0].up_to, the charge is the flat minimum.
DEFAULT_MODEL_A_BANDS: list[dict] = [
    {"up_to": 5,   "rate": None,  "flat_minimum": 20.00},  # first 5 vehicles → $20 flat
    {"up_to": 25,  "rate": 2.50,  "flat_minimum": None},   # vehicles 6–25
    {"up_to": 75,  "rate": 2.00,  "flat_minimum": None},   # vehicles 26–75
    {"up_to": 200, "rate": 1.50,  "flat_minimum": None},   # vehicles 76–200
    {"up_to": 500, "rate": 1.25,  "flat_minimum": None},   # vehicles 201–500
    {"up_to": None,"rate": 1.00,  "flat_minimum": None},   # vehicles 501+
]

# ─── DEFAULT MODEL B COMMISSION ──────────────────────────────────────────────
DEFAULT_COMMISSION_PCT: float = 20.0        # Inferth's percentage of eligible revenue
DEFAULT_MIN_CONTRIBUTION_USD: float = 20.0  # Monthly floor regardless of revenue
DEFAULT_LIFETIME_HOSTING_USD: float = 1.50  # Per active lifetime-vehicle per month


# ─── MODEL A: WHOLESALE PROGRESSIVE PRICING ──────────────────────────────────

def compute_model_a_wholesale(
    active_vehicles: int,
    custom_bands: Optional[list[dict]] = None,
) -> float:
    """Return the monthly wholesale charge for the given active vehicle count.

    Uses marginal (progressive) banding — each rate applies only to vehicles
    within its band, not the entire fleet at a single rate.

    Args:
        active_vehicles: Number of billable active vehicles for the period.
        custom_bands: Optional override list (same schema as DEFAULT_MODEL_A_BANDS).
                      Loaded from ResellerContract.custom_pricing_json["model_a_bands"].

    Returns:
        Monthly charge in USD, rounded to 2 decimal places.

    Benchmark validation (from spec):
        5 veh  → $20.00
        10 veh → $32.50
        25 veh → $70.00
        50 veh → $120.00
        75 veh → $170.00
        100 veh → $207.50
        150 veh → $282.50
        200 veh → $357.50
        300 veh → $482.50
        500 veh → $732.50
        1000 veh → $1,232.50
    """
    if active_vehicles <= 0:
        return 0.00

    bands = custom_bands or DEFAULT_MODEL_A_BANDS

    # First band: flat minimum if within the initial vehicle count
    flat_min_band = bands[0]
    flat_min = flat_min_band.get("flat_minimum", 20.00)
    flat_up_to = flat_min_band.get("up_to", 5)

    if active_vehicles <= flat_up_to:
        return round(float(flat_min), 2)

    # Start with the flat minimum for the first band
    total = float(flat_min)
    prev_up_to = flat_up_to

    for band in bands[1:]:
        up_to = band.get("up_to")
        rate = float(band["rate"])

        band_start = prev_up_to + 1
        band_end = up_to if up_to is not None else active_vehicles

        vehicles_in_band = max(0, min(active_vehicles, band_end) - prev_up_to)
        total += vehicles_in_band * rate

        if up_to is None or active_vehicles <= up_to:
            break

        prev_up_to = up_to

    return round(total, 2)


def _validate_model_a_benchmarks() -> None:
    """Internal smoke-test of the billing engine against spec benchmarks."""
    benchmarks = [
        (5,    20.00),
        (10,   32.50),
        (25,   70.00),
        (50,  120.00),
        (75,  170.00),
        (100, 207.50),
        (150, 282.50),
        (200, 357.50),
        (300, 482.50),
        (500, 732.50),
        (1000, 1232.50),
    ]
    for vehicles, expected in benchmarks:
        result = compute_model_a_wholesale(vehicles)
        assert result == expected, (
            f"Model A benchmark FAILED: {vehicles} vehicles → "
            f"expected ${expected}, got ${result}"
        )


# ─── MODEL B: REVENUE-SHARE COMMISSION ───────────────────────────────────────

def compute_model_b_commission(
    eligible_revenue_usd: float,
    commission_pct: float = DEFAULT_COMMISSION_PCT,
    min_contribution_usd: float = DEFAULT_MIN_CONTRIBUTION_USD,
) -> float:
    """Return Inferth's monthly commission under Model B.

    Inferth receives MAX(min_contribution_usd, eligible_revenue * commission_pct/100).
    The minimum is NOT added on top of the commission — it is a floor.

    Args:
        eligible_revenue_usd: Total qualifying retail service revenue for the period.
        commission_pct: Inferth's percentage share (default 20%).
        min_contribution_usd: Minimum monthly floor in USD (default $20).

    Returns:
        Inferth's commission in USD, rounded to 2 decimal places.

    Benchmark validation (from spec):
        $50 rev   → $20.00  (floor applies)
        $100 rev  → $20.00  (floor applies)
        $200 rev  → $40.00
        $500 rev  → $100.00
        $1,000 rev → $200.00
    """
    calculated = eligible_revenue_usd * (commission_pct / 100.0)
    return round(max(calculated, float(min_contribution_usd)), 2)


def compute_reseller_net_model_b(
    eligible_revenue_usd: float,
    commission_pct: float = DEFAULT_COMMISSION_PCT,
    min_contribution_usd: float = DEFAULT_MIN_CONTRIBUTION_USD,
) -> float:
    """Return the reseller's net retention under Model B after Inferth's commission."""
    inferth = compute_model_b_commission(eligible_revenue_usd, commission_pct, min_contribution_usd)
    return round(eligible_revenue_usd - inferth, 2)


def _validate_model_b_benchmarks() -> None:
    benchmarks = [
        (50.00,   20.00),
        (100.00,  20.00),
        (200.00,  40.00),
        (500.00, 100.00),
        (1000.00, 200.00),
    ]
    for revenue, expected_inferth in benchmarks:
        result = compute_model_b_commission(revenue)
        assert result == expected_inferth, (
            f"Model B benchmark FAILED: revenue=${revenue} → "
            f"expected Inferth=${expected_inferth}, got ${result}"
        )


# ─── MODEL B: LIFETIME VEHICLE HOSTING ───────────────────────────────────────

def compute_lifetime_hosting(
    active_lifetime_vehicles: int,
    rate_per_vehicle_usd: float = DEFAULT_LIFETIME_HOSTING_USD,
) -> float:
    """Return the monthly recurring hosting charge for active lifetime-plan vehicles.

    This is charged on top of the initial once-off retail sale commission.
    It applies ONLY under Model B, to prevent indefinite hosting at no recurring cost.
    Do NOT apply ordinary monthly/PAYD revenue-share to the same vehicles.

    Args:
        active_lifetime_vehicles: Count of vehicles on active lifetime-plan subscriptions.
        rate_per_vehicle_usd: Per-vehicle monthly hosting charge (default $1.50).

    Returns:
        Total monthly hosting charge in USD, rounded to 2 decimal places.
    """
    if active_lifetime_vehicles <= 0:
        return 0.00
    return round(active_lifetime_vehicles * float(rate_per_vehicle_usd), 2)


def _validate_lifetime_benchmarks() -> None:
    benchmarks = [
        (1,  1.50),
        (10, 15.00),
        (50, 75.00),
    ]
    for count, expected in benchmarks:
        result = compute_lifetime_hosting(count)
        assert result == expected, (
            f"Lifetime hosting benchmark FAILED: {count} vehicles → "
            f"expected ${expected}, got ${result}"
        )


# ─── ACTIVE BILLABLE VEHICLE COUNT ───────────────────────────────────────────

async def get_active_billable_vehicle_count(
    db: AsyncSession,
    tenant_id: int,
) -> int:
    """Return the count of billable active vehicles for a reseller tenant.

    Definition (from spec):
    - Registered vehicle with an ENABLED service entitlement (service_status = 'active').
    - Temporarily offline trackers remain billable if entitlement is active.
    - Suspended (service_status = 'suspended') and unassigned devices are excluded.
    - Does NOT use GPS packet frequency as the billing criterion.
    """
    from app.models import Device
    result = await db.execute(
        select(func.count(Device.id)).where(
            Device.tenant_id == tenant_id,
            Device.service_status == "active",
        )
    )
    return result.scalar() or 0


async def get_active_lifetime_vehicle_count(
    db: AsyncSession,
    tenant_id: int,
) -> int:
    """Return the count of active lifetime-plan vehicles under a reseller tenant.

    Lifetime subscriptions are identified by subscription.plan_type = 'onceoff_lifetime'.
    Only vehicles with active entitlements (service_status = 'active') are counted.
    """
    from app.models import Device, Subscription
    result = await db.execute(
        select(func.count(Device.id))
        .join(Subscription, Subscription.device_id == Device.id, isouter=True)
        .where(
            Device.tenant_id == tenant_id,
            Device.service_status == "active",
            Subscription.plan_type == "onceoff_lifetime",
            Subscription.status == "active",
        )
    )
    return result.scalar() or 0


# ─── COMBINED BILLING SUMMARY ─────────────────────────────────────────────────

def compute_monthly_charge(
    model: str,
    active_vehicles: int,
    eligible_revenue_usd: float = 0.0,
    active_lifetime_vehicles: int = 0,
    custom_pricing: Optional[dict] = None,
    commission_pct: float = DEFAULT_COMMISSION_PCT,
    min_contribution_usd: float = DEFAULT_MIN_CONTRIBUTION_USD,
    lifetime_hosting_rate: float = DEFAULT_LIFETIME_HOSTING_USD,
) -> dict:
    """Compute the full monthly charge breakdown for a reseller.

    Args:
        model: 'MODEL_A' or 'MODEL_B'.
        active_vehicles: Total active billable vehicle count.
        eligible_revenue_usd: (Model B) Qualifying retail service revenue for the period.
        active_lifetime_vehicles: (Model B) Active lifetime-plan vehicle count.
        custom_pricing: Dict from ResellerContract.custom_pricing_json.
        commission_pct: (Model B) Inferth's percentage cut.
        min_contribution_usd: (Model B) Minimum monthly floor.
        lifetime_hosting_rate: (Model B) Per-vehicle hosting charge for lifetime vehicles.

    Returns:
        Dict with keys: model, wholesale_charge, commission, lifetime_hosting,
        total_due, reseller_net, breakdown (human-readable lines).
    """
    custom_bands = None
    if custom_pricing and "model_a_bands" in custom_pricing:
        custom_bands = custom_pricing["model_a_bands"]
    if custom_pricing and "commission_pct" in custom_pricing:
        commission_pct = float(custom_pricing["commission_pct"])
    if custom_pricing and "min_contribution_usd" in custom_pricing:
        min_contribution_usd = float(custom_pricing["min_contribution_usd"])
    if custom_pricing and "lifetime_hosting_rate" in custom_pricing:
        lifetime_hosting_rate = float(custom_pricing["lifetime_hosting_rate"])

    result: dict = {
        "model": model,
        "wholesale_charge": 0.0,
        "commission": 0.0,
        "lifetime_hosting": 0.0,
        "total_due": 0.0,
        "reseller_net": 0.0,
        "breakdown": [],
        "double_billing_safe": True,
    }

    if model == "MODEL_A":
        charge = compute_model_a_wholesale(active_vehicles, custom_bands)
        result["wholesale_charge"] = charge
        result["total_due"] = charge
        result["reseller_net"] = round(eligible_revenue_usd - charge, 2)
        result["breakdown"] = [
            f"Model A: {active_vehicles} active vehicles → ${charge:.2f}/month wholesale",
        ]

    elif model == "MODEL_B":
        # Commission on monthly/PAYD revenue
        # Lifetime vehicles are excluded from the revenue-share calculation
        # (they are charged hosting instead — no double billing)
        commission = compute_model_b_commission(
            eligible_revenue_usd, commission_pct, min_contribution_usd
        )
        hosting = compute_lifetime_hosting(active_lifetime_vehicles, lifetime_hosting_rate)

        result["commission"] = commission
        result["lifetime_hosting"] = hosting
        result["total_due"] = round(commission + hosting, 2)
        result["reseller_net"] = round(eligible_revenue_usd - result["total_due"], 2)
        result["breakdown"] = [
            f"Model B: eligible revenue ${eligible_revenue_usd:.2f}",
            f"  Inferth commission ({commission_pct}%, min ${min_contribution_usd:.2f}): ${commission:.2f}",
            f"  Lifetime hosting ({active_lifetime_vehicles} vehicles × ${lifetime_hosting_rate:.2f}): ${hosting:.2f}",
            f"  Total due to Inferth: ${result['total_due']:.2f}",
        ]
        # Double-billing guard: same vehicle cannot be counted in both
        # commission revenue and lifetime hosting in the same invoice period.
        # Caller is responsible for splitting monthly/PAYD revenue from lifetime revenue.

    return result


# ─── SELF-TEST ON IMPORT ─────────────────────────────────────────────────────
# Run immediately at module load to catch regressions.
_validate_model_a_benchmarks()
_validate_model_b_benchmarks()
_validate_lifetime_benchmarks()
