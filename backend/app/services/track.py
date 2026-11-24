"""One definition of a day's track.

Route History, the marker popup ("Today"), the trip/stop cards and the max
speed used to be produced by four separate scans with slightly different
rules. On a day where the tracker alternates between a parked fix and a coarse
fix a few hundred metres away, those scans disagreed by tens of kilometres, the
strip disagreed with its own cards, and the map drew a broken, partly invented
track.

Everything now comes from `analyze_track`. It decides once, from the fixes
themselves, where the vehicle actually travelled, and it returns the segments
the client draws. The totals ARE the sum of those segments, so the strip, the
cards and the popup cannot drift apart again.

The rules only ever trust evidence the fixes carry:

* A **gap** is a silence (>= 15 min and >= 1 km apart) or, with no timestamps
  to judge by, a hop further than 2 km. A gap banks nothing and breaks the
  drawn line, because the vehicle really did go unrecorded.
* A **bad fix** is one that would need more than 200 km/h from the previous
  accepted fix. It is dropped rather than breaking the line: these are the
  multipath jumps a stationary receiver makes every few seconds, and treating
  them as gaps is what shredded a continuous track into hundreds of pieces.
* **Movement is proven by ground covered between fixes at least a minute
  apart.** This tracker sends fixes every 3-40 seconds and reports 40-124 km/h
  while sitting on one coordinate; a 200 m change between two fixes 3 s apart
  is noise, not 240 km/h. Over a one-to-five minute spacing the same scatter
  reads 4-5 km/h, while a car in town reads 20-30 km/h.
* A leg banks distance only when that evidence says the vehicle moved, so a
  parked period contributes exactly zero and every kilometre in the total
  belongs to a trip card.
* **Speed is the ground actually covered**, never the firmware's number. A
  reported speed is kept only when the ground supports it (capped at 1.5x),
  and a fix standing still contributes no speed at all, however fast the device
  claims to be going.
"""

from app.services.data_guardrails import haversine_distance_km

TRACK_GAP_MINUTES = 15
TRACK_GAP_KM = 1.0
TRACK_SILENT_JUMP_KM = 2.0
TRACK_MAX_KMH = 160.0
TRACK_BAD_FIX_KM = 0.3
TRACK_NOISE_KM = 0.15
TRACK_MIN_LEG_KM = 0.03
TRACK_PARK_KM = 0.10
TRACK_STOP_KMH = 3.0

# Fixes closer together than this prove nothing about speed or travel: the
# device's own scatter between a 3-second pair is hundreds of metres.
TRACK_MIN_EVIDENCE_S = 60.0
TRACK_GROUND_WINDOW_S = 300.0
TRACK_SPARSE_WINDOW_S = 1800.0
TRACK_GROUND_MOVING_KMH = 8.0
TRACK_GROUND_STANDING_KMH = 5.0
TRACK_SUPPORT_FACTOR = 1.5


def _seconds(a, b):
    """Elapsed seconds between two datetimes, tolerating naive/aware mixes."""
    try:
        if a.tzinfo is None and b.tzinfo is not None:
            a = a.replace(tzinfo=b.tzinfo)
        elif b.tzinfo is None and a.tzinfo is not None:
            b = b.replace(tzinfo=a.tzinfo)
        return (b - a).total_seconds()
    except Exception:
        return 0.0


def _km(a, b):
    return haversine_distance_km(a["lat"], a["lng"], b["lat"], b["lng"])


def _normalise(points):
    out = []
    for p in points or []:
        lat, lng = p.get("lat"), p.get("lng")
        ts = p.get("timestamp")
        if lat is None or lng is None or ts is None:
            continue
        try:
            lat = float(lat)
            lng = float(lng)
        except (TypeError, ValueError):
            continue
        if abs(lat) < 0.0001 or abs(lng) < 0.0001:
            continue
        try:
            speed = float(p.get("speed") or 0.0)
        except (TypeError, ValueError):
            speed = 0.0
        out.append({
            "lat": lat,
            "lng": lng,
            "ts": ts,
            "speed": max(0.0, min(speed, TRACK_MAX_KMH)),
        })
    return out


def _recompute(chain):
    """Re-derive each fix's travel distance from its surviving neighbour."""
    out = []
    for node in chain:
        node = dict(node)
        if not out:
            node["km"] = 0.0
            out.append(node)
            continue
        prev = out[-1]
        node["km"] = 0.0 if node["gap"] else _km(prev, node)
        out.append(node)
    return out


def _accept(fixes):
    """Drop bad fixes and mark real silences."""
    chain = []
    for f in fixes:
        node = dict(f)
        node.setdefault("gap", False)
        if not chain:
            node["km"] = 0.0
            chain.append(node)
            continue
        prev = chain[-1]
        km = _km(prev, node)
        dt = _seconds(prev["ts"], node["ts"])
        if dt <= 0:
            if km > TRACK_SILENT_JUMP_KM:
                node["km"] = 0.0
                node["gap"] = True
                chain.append(node)
                continue
        else:
            if dt >= TRACK_GAP_MINUTES * 60 and km >= TRACK_GAP_KM:
                node["km"] = 0.0
                node["gap"] = True
                chain.append(node)
                continue
            if km > TRACK_BAD_FIX_KM and (km / (dt / 3600.0)) > TRACK_MAX_KMH:
                continue  # impossible hop: keep the anchor, never break the line
        node["km"] = km
        chain.append(node)
    return _recompute(chain)


def _ground_speeds(chain):
    """Fastest ground covered between fixes one to five minutes apart.

    Deliberately ignores neighbours closer than a minute: on this hardware a
    200 m change across a 3-second pair is where the impossible speeds came
    from, and it is not evidence of travel.
    """
    speeds = []
    for i, node in enumerate(chain):
        best = 0.0
        sparse = 0.0
        for j in range(max(0, i - 6), min(len(chain), i + 7)):
            if j == i:
                continue
            other = chain[j]
            if other["gap"] or node["gap"]:
                continue
            dt = abs(_seconds(node["ts"], other["ts"]))
            if dt < TRACK_MIN_EVIDENCE_S or dt > TRACK_SPARSE_WINDOW_S:
                continue
            km = haversine_distance_km(node["lat"], node["lng"], other["lat"], other["lng"])
            implied = km / (dt / 3600.0)
            if dt <= TRACK_GROUND_WINDOW_S:
                best = max(best, implied)
            # A tracker that uploaded once after a long silence still proves
            # how far it travelled, just not how fast at any instant.
            sparse = max(sparse, implied)
        speeds.append(best if best > 0 else sparse)
    return speeds


def _moving(node, ground):
    """Did the vehicle move here? Only ground covered decides, so a segment can
    never bank kilometres while showing no speed at all."""
    return ground >= TRACK_GROUND_MOVING_KMH


def _bank(chain, ground):
    """Bank distance only where the vehicle provably moved; pin the rest to the
    anchor so a parked unit neither drifts nor draws scatter."""
    out = []
    for i, node in enumerate(chain):
        node = dict(node)
        if not out:
            node["km"] = 0.0
            out.append(node)
            continue
        prev = out[-1]
        if node["gap"]:
            node["km"] = 0.0
            out.append(node)
            continue
        km = node["km"]
        # The movement test already excludes parked scatter, so a leg only has
        # to exceed the receiver's own floor to count. Demanding 150 m per fix
        # threw away real progress: a car at 20 km/h covers 110 m in 20 s.
        if km >= TRACK_MIN_LEG_KM and _moving(node, ground[i]):
            out.append(node)
        else:
            node["km"] = 0.0
            node["lat"] = prev["lat"]
            node["lng"] = prev["lng"]
            out.append(node)
    return out


def _validated_speeds(chain, ground):
    """Speed the fixes can prove. A parked unit contributes zero however fast
    its firmware claims to be going."""
    out = []
    for node, g in zip(chain, ground):
        if g < TRACK_GROUND_STANDING_KMH:
            out.append(0.0)
            continue
        reported = node["speed"] or 0.0
        supported = min(reported if reported > 0 else g, g * TRACK_SUPPORT_FACTOR)
        out.append(max(0.0, min(supported, TRACK_MAX_KMH)))
    return out


def _segments(chain, moving, validated):
    runs = []
    cur = [0]
    for i in range(1, len(chain)):
        if chain[i]["gap"] or moving[i] != moving[i - 1]:
            runs.append(cur)
            cur = [i]
        else:
            cur.append(i)
    runs.append(cur)

    merged = []
    for idx, run in enumerate(runs):
        is_moving = moving[run[0]]
        prev = merged[-1] if merged else None
        spans_gap = any(chain[i]["gap"] for i in run)
        if (not is_moving and not spans_gap and prev and prev["moving"]
                and idx + 1 < len(runs) and moving[runs[idx + 1][0]]):
            # A brief traffic stop inside a drive is part of that drive, but a
            # silence is never folded into the drive it interrupted.
            if abs(_seconds(chain[run[0]]["ts"], chain[run[-1]]["ts"])) <= 300:
                prev["idx"].extend(run)
                continue
        if (not is_moving and prev and not prev["moving"]
                and haversine_distance_km(
                    chain[prev["idx"][-1]]["lat"], chain[prev["idx"][-1]]["lng"],
                    chain[run[0]]["lat"], chain[run[0]]["lng"]) < TRACK_PARK_KM):
            prev["idx"].extend(run)
            continue
        merged.append({"moving": is_moving, "idx": list(run)})

    segments = []
    for run in merged:
        idx = run["idx"]
        distance = sum(chain[i]["km"] for i in idx)
        # A single impossible hop must not become the day's top speed: over a
        # real drive the figure has to be sustained by neighbouring fixes too.
        # A short card has too few fixes for that test to mean anything.
        moving_idx = [i for i in idx if moving[i]]
        top = max((validated[i] for i in moving_idx), default=0.0)
        if len(moving_idx) >= 5:
            top = 0.0
            for k, i in enumerate(moving_idx):
                three = [
                    validated[moving_idx[max(0, k - 1)]],
                    validated[i],
                    validated[moving_idx[min(len(moving_idx) - 1, k + 1)]],
                ]
                top = max(top, min(three))
        segments.append({
            "kind": "trip" if distance >= TRACK_NOISE_KM else "stop",
            "distance_km": round(distance, 3),
            "max_speed_kmh": round(top),
            "points": [
                {
                    "lat": chain[i]["lat"],
                    "lng": chain[i]["lng"],
                    "timestamp": chain[i]["ts"],
                    "speed": round(validated[i], 1),
                }
                for i in idx
            ],
        })
    return segments


def analyze_track(points):
    """Clean a day of fixes and return the one set of numbers everything uses.

    `points` are dicts with lat, lng, timestamp and optional speed. The result
    holds the cleaned `points` (each flagged with `break` where a real silence
    interrupted the track), `segments` (trip and stop runs with their own
    distance, top speed and points) and the totals derived from those segments.
    """
    fixes = _normalise(points)
    if not fixes:
        return {
            "points": [], "segments": [], "distance_km": 0.0,
            "max_speed_kmh": 0, "trips": 0, "stops": 0,
        }

    accepted = _accept(fixes)
    ground = _ground_speeds(accepted)
    chain = _bank(accepted, ground)
    validated = _validated_speeds(chain, ground)
    moving = [_moving(node, ground[i]) for i, node in enumerate(chain)]
    segments = _segments(chain, moving, validated)

    out_points = []
    for i, node in enumerate(chain):
        out_points.append({
            "lat": node["lat"],
            "lng": node["lng"],
            "timestamp": node["ts"],
            "speed": round(validated[i], 1),
            "break": bool(node["gap"]),
        })

    distance = round(sum(s["distance_km"] for s in segments), 3)
    return {
        "points": out_points,
        "segments": segments,
        "distance_km": distance,
        "max_speed_kmh": round(max((s["max_speed_kmh"] for s in segments), default=0)),
        "trips": sum(1 for s in segments if s["kind"] == "trip"),
        "stops": sum(1 for s in segments if s["kind"] == "stop"),
    }
