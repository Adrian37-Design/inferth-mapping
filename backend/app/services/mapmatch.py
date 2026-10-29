"""
Route map-matching service.

Turns a trip's raw GPS fixes into one continuous, road-following polyline by
calling a Valhalla `trace_attributes` endpoint (HMM map matcher) and assembling
the response:

- Stationary runs are collapsed first so a vehicle waiting at a junction is not
  snapped back and forth between the junction's roads.
- Single-point lateral outliers (multipath spikes) are dropped before matching
  so the matcher cannot route a spur out to them.
- Matched points are positioned on the returned path shape (edge_index +
  distance_along_edge) and consecutive matched points are joined along the
  shape — this is what makes the line follow the road exactly.
- Runs of unmatched fixes (yards, compounds, unmapped tracks) are spliced back
  in as raw geometry, so the line stays where the vehicle actually went instead
  of being pulled onto a nearby road. Nothing is left as a gap.
- Route discontinuities (big data gaps) are bridged with a normal route
  request, but only when the route is plausible for the elapsed time; otherwise
  the raw fixes in between are drawn.
- Remaining unsupported out-and-back excursions are removed as a final pass.

The public demo endpoint is used by default; set MAP_MATCH_URL to a self-hosted
Valhalla (or compatible) base URL for production use. Requests are globally
rate-limited to one per second per the FOSSGIS demo terms of use.
"""
import asyncio
import hashlib
import json
import math
import time
from typing import Optional, Sequence

import httpx

from app.config import settings

_TIMEOUT_S = 15.0
_UA = {
    "User-Agent": "InferthMapping/1.0 (+https://www.inferthmapping.co.zw)",
    "X-Client-Id": "inferthmapping.co.zw",
}
_RATE_INTERVAL_S = 1.05
_rate_lock = asyncio.Lock()
_last_call = 0.0
_PARAMS_VERSION = "valhalla-r40-a20-b2500-v1"
_MAX_TRACE_POINTS = 1400


def _base_url() -> Optional[str]:
    url = (getattr(settings, "MAP_MATCH_URL", None) or "").strip()
    return url.rstrip("/") or None


def engine_params_version() -> str:
    return _PARAMS_VERSION


def _haversine_m(a, b) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(min(1.0, h)))


def _decode_polyline6(s: str):
    coords, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lng += d
        coords.append((lat / 1e6, lng / 1e6))
    return coords


async def _post(path: str, body: dict) -> Optional[dict]:
    base = _base_url()
    if not base:
        return None
    global _last_call
    async with httpx.AsyncClient(timeout=_TIMEOUT_S, headers=_UA) as client:
        for attempt in range(2):
            async with _rate_lock:
                wait = _RATE_INTERVAL_S - (time.monotonic() - _last_call)
                if wait > 0:
                    await asyncio.sleep(wait)
                _last_call = time.monotonic()
            try:
                resp = await client.post(base + path, json=body)
            except httpx.HTTPError:
                continue
            if resp.status_code == 200:
                try:
                    return resp.json()
                except ValueError:
                    return None
            if resp.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                await asyncio.sleep(2.0)
                continue
            return None
    return None


def _collapse_stationary(trace, radius_m=12.0):
    out = []
    for p in trace:
        if out and _haversine_m((out[-1]["lat"], out[-1]["lng"]), (p["lat"], p["lng"])) < radius_m:
            out[-1]["t_end"] = p["t"]
            continue
        out.append({**p, "t_end": p["t"]})
    return out


def _perp_m(P, A, B) -> float:
    k = math.cos(math.radians(P[0]))
    ax, ay = (A[1] - P[1]) * k * 111320, (A[0] - P[0]) * 111320
    dx, dy = (B[1] - A[1]) * k * 111320, (B[0] - A[0]) * 111320
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return _haversine_m(A, P)
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
    return math.hypot(ax + t * dx, ay + t * dy)


def _is_suspect_spike(P, A, B, lateral_m=25.0):
    leg1, leg2 = _haversine_m(A, P), _haversine_m(P, B)
    detour = leg1 + leg2 - _haversine_m(A, B)
    return min(leg1, leg2) > 20 and _perp_m(P, A, B) > lateral_m and detour > 45


def _drop_local_outliers(trace, lateral_m=25.0):
    """Drop fixes that look like multipath spikes: a lone fix sitting well off
    the line between two normal fixes gets snapped onto a side road and draws
    a false spur. A spike also poisons the chord for its neighbour, so flags
    are grouped into runs; members that still look suspect against the clean
    points outside the run are dropped only when one remains — runs of two or
    more suspect fixes are a real excursion (a gate, a yard) and are kept."""
    n = len(trace)
    if n < 3:
        return trace
    flag = [False] * n
    for k in range(1, n - 1):
        a, p, b = trace[k - 1], trace[k], trace[k + 1]
        flag[k] = _is_suspect_spike(
            (p["lat"], p["lng"]), (a["lat"], a["lng"]), (b["lat"], b["lng"]), lateral_m)

    drop = set()
    k = 1
    while k < n - 1:
        if not flag[k]:
            k += 1
            continue
        run = [k]
        while k + 1 < n - 1 and flag[k + 1]:
            k += 1
            run.append(k)
        left, right = run[0] - 1, run[-1] + 1
        A = (trace[left]["lat"], trace[left]["lng"])
        B = (trace[right]["lat"], trace[right]["lng"])
        still = [m for m in run if _is_suspect_spike(
            (trace[m]["lat"], trace[m]["lng"]), A, B, lateral_m)]
        if len(still) == 1:
            drop.add(still[0])
        k += 1
    return [p for i, p in enumerate(trace) if i not in drop]


def _path_len(line, i, j) -> float:
    return sum(_haversine_m(line[k - 1], line[k]) for k in range(i + 1, j + 1))


def _remove_spurs(line, fixes, max_len=800.0, close_m=15.0, reach_m=25.0, support_m=20.0, min_support=2):
    """Remove out-and-back excursions not supported by at least `min_support`
    real fixes near the far side. GPS spikes matched to side roads produce a
    'drive out to the spur and come straight back' artefact; genuine visits
    (a depot, a blocked dead end) leave multiple fixes at the tip."""
    out = list(line)
    i = 0
    while i < len(out) - 2:
        cut = None
        length = 0.0
        far = []
        for j in range(i + 1, len(out)):
            length += _haversine_m(out[j - 1], out[j])
            if length > max_len:
                break
            d = _haversine_m(out[i], out[j])
            if d > reach_m:
                far.append(out[j])
            elif far and d <= close_m and length >= 2 * reach_m:
                supported = sum(1 for f in fixes if any(_haversine_m(f, q) <= support_m for q in far))
                if supported < min_support:
                    cut = j
                break
        if cut is not None:
            out = out[: i + 1] + out[cut:]
        else:
            i += 1
    return out


def _position_on_shape(shape, edge, frac):
    b, e = edge["begin_shape_index"], edge["end_shape_index"]
    seg = [_haversine_m(shape[k], shape[k + 1]) for k in range(b, e)]
    total = sum(seg)
    target = max(0.0, min(1.0, frac)) * total
    acc = 0.0
    for k, d in enumerate(seg):
        if acc + d >= target and d > 0:
            f = (target - acc) / d
            idx = b + k
            p = (
                shape[idx][0] + (shape[idx + 1][0] - shape[idx][0]) * f,
                shape[idx][1] + (shape[idx + 1][1] - shape[idx][1]) * f,
            )
            return idx + f, p
        acc += d
    return float(e), shape[e]


def _sub_shape(shape, pa, pb, a_pt, b_pt):
    out = [a_pt]
    for k in range(int(math.floor(pa)) + 1, int(math.floor(pb)) + 1):
        if k < len(shape):
            out.append(shape[k])
    out.append(b_pt)
    return out


async def _route_between(a, b):
    body = {
        "locations": [
            {"lat": a[0], "lon": a[1], "type": "break"},
            {"lat": b[0], "lon": b[1], "type": "break"},
        ],
        "costing": "auto",
        "directions_type": "none",
    }
    res = await _post("/route", body)
    legs = (res or {}).get("trip", {}).get("legs") or []
    if not legs:
        return None, None
    return _decode_polyline6(legs[0]["shape"]), res["trip"]["summary"]["length"] * 1000


async def _trace_attributes(trace):
    body = {
        "shape": [{"lat": p["lat"], "lon": p["lng"], "time": int(p["t"])} for p in trace],
        "costing": "auto",
        "shape_match": "map_snap",
        "use_timestamps": False,
        "trace_options": {
            "search_radius": 40,
            "gps_accuracy": 20,
            "breakage_distance": 2500,
            "turn_penalty_factor": 100,
        },
        "filters": {
            "attributes": [
                "shape",
                "matched.point",
                "matched.type",
                "matched.edge_index",
                "matched.distance_along_edge",
                "matched.distance_from_trace_point",
                "matched.begin_route_discontinuity",
                "matched.end_route_discontinuity",
                "edge.begin_shape_index",
                "edge.end_shape_index",
                "edge.length",
            ],
            "action": "include",
        },
    }
    return await _post("/trace_attributes", body)


async def _assemble(trace, resp):
    shape = _decode_polyline6(resp["shape"])
    edges = resp["edges"]
    mps = resp["matched_points"]
    pos = []
    for mp in mps:
        if mp.get("type") == "unmatched" or "edge_index" not in mp:
            pos.append(None)
        else:
            pos.append(_position_on_shape(shape, edges[mp["edge_index"]], mp.get("distance_along_edge", 0.0)))

    line = [(trace[0]["lat"], trace[0]["lng"])]
    notes = []
    prev = None
    pending = []
    for i, p in enumerate(trace):
        raw = (p["lat"], p["lng"])
        if pos[i] is None:
            pending.append(raw)
            continue
        if prev is None:
            line.extend(pending)
            line.append(pos[i][1])
        else:
            j = prev
            discontinuous = mps[j].get("end_route_discontinuity") or mps[i].get("begin_route_discontinuity")
            if len(pending) >= 2:
                line.extend(pending)
                line.append(pos[i][1])
                notes.append("offroad")
            elif pos[i][0] < pos[j][0]:
                # Matched position stepped backwards on the path — matcher
                # micro-regression or a flagged restart. Drawing it would
                # zig-zag or loop along the road; keep the line monotonic
                # instead. A genuine U-turn rejoins forward on the same road
                # and loses nothing by collapsing onto it.
                pending = []
                continue
            elif discontinuous:
                chord = _haversine_m(pos[j][1], pos[i][1])
                geo, length = (None, None) if chord < 60 else await _route_between(pos[j][1], pos[i][1])
                dt = max(5.0, trace[i]["t"] - trace[j].get("t_end", trace[j]["t"]))
                plausible = geo and length <= 2 * chord + 300 and length / dt * 3.6 <= 150
                if plausible:
                    line.extend(geo[1:-1])
                    notes.append("bridge")
                else:
                    for k in range(j + 1, i):
                        line.append((trace[k]["lat"], trace[k]["lng"]))
                    notes.append("rawlink")
                line.append(pos[i][1])
            else:
                line.extend(_sub_shape(shape, pos[j][0], pos[i][0], pos[j][1], pos[i][1])[1:])
        pending = []
        prev = i
    line.extend(pending)
    line.append((trace[-1]["lat"], trace[-1]["lng"]))

    dedup = [line[0]]
    for q in line[1:]:
        if _haversine_m(dedup[-1], q) > 0.5:
            dedup.append(q)
    return dedup, notes


def _thin_trace(trace, max_points=_MAX_TRACE_POINTS):
    if len(trace) <= max_points:
        return trace
    step = (len(trace) - 1) / (max_points - 1)
    idxs = {round(k * step) for k in range(max_points)}
    return [p for k, p in enumerate(trace) if k in idxs]


async def match_trip_shape(points: Sequence[dict], before=None, after=None) -> Optional[dict]:
    """Match one trip's points to the road network.

    `points`: ordered sequence of {"lat","lng","t"} (t = unix epoch seconds).
    `before`/`after`: optional (lat, lng) anchors placed just outside the trip
    window so the drawn line can connect to the parked position on either side.

    Returns {"segments": [[(lat,lng),...]], "matched": bool} or None when the
    matching engine is unavailable or failed."""
    trace = [{"lat": float(p["lat"]), "lng": float(p["lng"]), "t": float(p["t"])} for p in points]
    trace.sort(key=lambda p: p["t"])
    if before:
        anchor = {"lat": float(before[0]), "lng": float(before[1]), "t": trace[0]["t"] - 5.0}
        trace = [anchor] + trace
    if after:
        anchor = {"lat": float(after[0]), "lng": float(after[1]), "t": trace[-1]["t"] + 5.0}
        trace = trace + [anchor]
    if len(trace) < 2:
        return None

    trace = _thin_trace(_drop_local_outliers(_collapse_stationary(trace)))
    if len(trace) < 2:
        return {"segments": [[(trace[0]["lat"], trace[0]["lng"])]], "matched": False}

    resp = await _trace_attributes(trace)
    if not resp or "shape" not in resp or not resp.get("edges"):
        return None

    try:
        line, notes = await _assemble(trace, resp)
    except (KeyError, IndexError, TypeError, ValueError):
        return None

    fixes = [(p["lat"], p["lng"]) for p in trace]
    line = _remove_spurs(line, fixes)
    any_matched = any(mp.get("type") != "unmatched" and "edge_index" in mp for mp in resp["matched_points"])
    return {"segments": [line], "matched": bool(any_matched), "notes": notes}


def trip_fingerprint(points: Sequence[dict], params_version: str) -> str:
    """Stable fingerprint for a cached match: recompute when the point set or
    the matching parameters change (e.g. an ongoing trip gained more fixes)."""
    if not points:
        return "empty"
    h = hashlib.sha256()
    h.update(f"{params_version}|{len(points)}|{points[0]['t']:.0f}|{points[-1]['t']:.0f}".encode())
    return h.hexdigest()[:32]
