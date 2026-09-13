"""
Data Guardrail Sanitization Service for Inferth Telematics Stream.

Implements the 3-step telematics data hygiene pipeline:
1. GPS Coordinate Integrity & Bounds Guardrail (reject nulls, (0,0) Null Island, out-of-bounds, no-fix flags)
2. Outlier Speed & Teleportation Jump Guardrail (clamp impossible spikes, haversine velocity jump rejection, stationary deadband)
3. Timestamp Sanity & Status Grace Period Guardrail (reject clock drift/corrupted dates, deduplication of stationary pings)
"""

import math
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Tuple

MAX_PHYSICAL_SPEED_KMH = 200.0   # Speeds above this are deemed sensor acquisition glitches
MAX_IMPLIED_VELOCITY_KMH = 250.0  # Teleportation jump threshold between successive pings
STATIONARY_DRIFT_METERS = 15.0   # Stationary GPS jitter deadband
OFFLINE_GRACE_MINUTES = 10.0     # Threshold for marking a vehicle offline


def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points on Earth in kilometers."""
    R = 6371.0  # Earth's radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def validate_coordinates(lat: Any, lon: Any) -> Tuple[Optional[float], Optional[float], bool]:
    """
    Guardrail 1: GPS Coordinate Integrity & Bounds.
    Rejects null, NaN, out-of-range, and Null Island (0.0, 0.0) coordinates.
    Returns (cleaned_lat, cleaned_lon, is_valid).
    """
    if lat is None or lon is None:
        return None, None, False

    try:
        f_lat = float(lat)
        f_lon = float(lon)
    except (ValueError, TypeError):
        return None, None, False

    # Check for NaN or Inf
    if math.isnan(f_lat) or math.isnan(f_lon) or math.isinf(f_lat) or math.isinf(f_lon):
        return None, None, False

    # Geographic boundary check
    if not (-90.0 <= f_lat <= 90.0) or not (-180.0 <= f_lon <= 180.0):
        return None, None, False

    # Zero / Null Island rejection (0, 0 or near-zero uninitialized GPS registers)
    if abs(f_lat) < 0.0001 and abs(f_lon) < 0.0001:
        return None, None, False

    return round(f_lat, 7), round(f_lon, 7), True


def validate_and_sanitize_speed(speed: Any) -> float:
    """
    Guardrail 2a: Speed Outlier Sanitation.
    Clamps negative speeds and discards / caps impossible spikes (> 200 km/h).
    """
    try:
        f_speed = float(speed or 0.0)
    except (ValueError, TypeError):
        return 0.0

    if math.isnan(f_speed) or math.isinf(f_speed) or f_speed < 0:
        return 0.0

    # Sensor glitch spike check
    if f_speed > MAX_PHYSICAL_SPEED_KMH:
        return MAX_PHYSICAL_SPEED_KMH

    return round(f_speed, 1)


def is_teleportation_jump(
    prev_lat: float, prev_lon: float, prev_time: datetime,
    curr_lat: float, curr_lon: float, curr_time: datetime
) -> bool:
    """
    Guardrail 2b: Teleportation Jump Check.
    Detects impossible jumps where implied velocity exceeds realistic physical limits.
    """
    time_diff_sec = abs((curr_time - prev_time).total_seconds())
    if time_diff_sec < 1.0:
        # Same instant; if distance is non-zero and significant (> 50m), it's an anomaly
        dist_km = haversine_distance_km(prev_lat, prev_lon, curr_lat, curr_lon)
        return dist_km > 0.05

    dist_km = haversine_distance_km(prev_lat, prev_lon, curr_lat, curr_lon)
    implied_speed_kmh = dist_km / (time_diff_sec / 3600.0)

    # If implied speed exceeds 250 km/h and distance is substantial (> 100m)
    if implied_speed_kmh > MAX_IMPLIED_VELOCITY_KMH and dist_km > 0.1:
        return True

    return False


def validate_timestamp(candidate_ts: Any, fallback_now: Optional[datetime] = None) -> datetime:
    """
    Guardrail 3a: Timestamp Clock Sanity.
    Rejects future timestamps and corrupted historic dates (e.g. 1970/2000 reset).
    """
    now = fallback_now or datetime.utcnow()

    if not candidate_ts:
        return now

    ts = None
    if isinstance(candidate_ts, datetime):
        ts = candidate_ts
    elif isinstance(candidate_ts, str):
        try:
            ts = datetime.fromisoformat(candidate_ts.replace('Z', '+00:00')).replace(tzinfo=None)
        except Exception:
            return now

    if ts is None:
        return now

    # Check future bounds (allow at most 5 minutes clock drift)
    if ts > (now + timedelta(minutes=5)):
        return now

    # Check past bounds (must be year >= 2024 and within last 365 days)
    if ts.year < 2024 or (now - ts).days > 365:
        return now

    return ts


def is_duplicate_ping(
    prev_lat: Optional[float], prev_lon: Optional[float], prev_speed: float, prev_time: datetime,
    curr_lat: Optional[float], curr_lon: Optional[float], curr_speed: float, curr_time: datetime
) -> bool:
    """
    Guardrail 3b: Deduplication of stationary/consecutive identical pings.
    """
    if prev_lat is None or curr_lat is None or prev_lon is None or curr_lon is None:
        return False

    time_diff_sec = abs((curr_time - prev_time).total_seconds())
    if time_diff_sec < 4.0:
        # Within 4 seconds and stationary / near-stationary
        if prev_speed <= 3.0 and curr_speed <= 3.0:
            dist_km = haversine_distance_km(prev_lat, prev_lon, curr_lat, curr_lon)
            if dist_km < 0.01:  # Less than 10 meters
                return True

    return False


def compute_resolved_status(
    speed: float,
    last_ping_time: datetime,
    ignition: Optional[bool] = None,
    now: Optional[datetime] = None
) -> Tuple[str, str]:
    """
    Guardrail 3c: Standardized Vehicle Status Resolution.
    Returns (status_key, display_label).
    """
    ref_now = now or datetime.utcnow()
    # Normalize tzinfo if mixed
    if last_ping_time.tzinfo and not ref_now.tzinfo:
        last_ping_time = last_ping_time.replace(tzinfo=None)
    elif ref_now.tzinfo and not last_ping_time.tzinfo:
        ref_now = ref_now.replace(tzinfo=None)

    mins_ago = (ref_now - last_ping_time).total_seconds() / 60.0

    if mins_ago >= OFFLINE_GRACE_MINUTES:
        return "offline", "Offline"

    if speed > 3.0:
        return "moving", "Moving"

    if ignition is True:
        return "idling", "Idling"

    return "stationary", "Stationary"

