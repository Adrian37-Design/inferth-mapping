import math


def fuel_reading(adc, cal):
    """Convert raw fuel-sensor counts to percent, and to litres when the tank size is known.

    Each vehicle has its own two-point calibration (empty and full readings), so the
    result does not depend on the tank's size or shape.
    """
    try:
        value = float(adc)
    except (TypeError, ValueError):
        return None, None
    if cal is None or not math.isfinite(value) or cal.full_adc == cal.empty_adc:
        return None, None
    percent = min(max((value - cal.empty_adc) / (cal.full_adc - cal.empty_adc) * 100, 0.0), 100.0)
    litres = round(percent / 100 * cal.capacity_l, 1) if cal.capacity_l else None
    return round(percent, 1), litres
