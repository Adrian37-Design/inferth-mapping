from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse, Response
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import Device, Position, User
from app.auth import get_current_user
from datetime import datetime, timedelta
from typing import Optional, List, Literal
from math import radians, cos, sin, asin, sqrt
import io
import csv
from collections import defaultdict

router = APIRouter(prefix="/reports", tags=["reports"])


def haversine(lat1, lon1, lat2, lon2):
    """Distance between two lat/lon points in km."""
    if None in (lat1, lon1, lat2, lon2):
        return 0.0
    lon1, lat1, lon2, lat2 = map(radians, [lon1, lat1, lon2, lat2])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    c = 2 * asin(sqrt(max(0, min(1, a))))
    return 6371 * c


async def get_device_check(device_id: int, current_user: User, db: AsyncSession):
    device_q = await db.execute(select(Device).where(Device.id == device_id))
    device = device_q.scalars().first()
    if not device:
        raise HTTPException(404, "Device not found")
    if current_user.tenant_id != 1 and device.tenant_id != current_user.tenant_id:
        raise HTTPException(403, "Not authorized to view this device's reports")
    return device


def parse_date_range(start: Optional[str], end: Optional[str], default_days: int = 7):
    if end:
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    else:
        end_dt = datetime.utcnow()
    if start:
        start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    else:
        start_dt = end_dt - timedelta(days=default_days)
    return start_dt, end_dt


async def fetch_positions(device_id: int, start_dt: datetime, end_dt: datetime, db: AsyncSession):
    query = select(Position).where(
        Position.device_id == device_id,
        Position.timestamp >= start_dt,
        Position.timestamp <= end_dt
    ).order_by(Position.timestamp.asc())
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/{device_id}/trips")
async def trips_report(
    device_id: int,
    start: Optional[str] = None,
    end: Optional[str] = None,
    gap_minutes: int = Query(30, ge=1),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Trip report with start/end times, distance, duration and harsh events."""
    device = await get_device_check(device_id, current_user, db)
    start_dt, end_dt = parse_date_range(start, end)
    positions = await fetch_positions(device_id, start_dt, end_dt, db)
    if not positions:
        return {"device_id": device_id, "device_name": device.name, "trips": [], "total_trips": 0}

    trips = []
    current = [positions[0]]
    for prev, pos in zip(positions, positions[1:]):
        gap = (pos.timestamp - prev.timestamp).total_seconds() / 60
        if gap > gap_minutes:
            trips.append(current)
            current = [pos]
        else:
            current.append(pos)
    trips.append(current)

    summaries = []
    for trip in trips:
        if len(trip) < 2:
            continue
        dist = sum(haversine(trip[i-1].latitude, trip[i-1].longitude, trip[i].latitude, trip[i].longitude)
                   for i in range(1, len(trip)))
        duration_min = (trip[-1].timestamp - trip[0].timestamp).total_seconds() / 60
        harsh = []
        for i in range(1, len(trip)):
            ds = (trip[i].speed or 0) - (trip[i-1].speed or 0)
            dt = (trip[i].timestamp - trip[i-1].timestamp).total_seconds()
            if 0 < dt <= 15:
                accel = ds / dt
                if accel > 10:
                    harsh.append({"type": "Harsh Acceleration", "value": round(accel, 1), "time": trip[i].timestamp.isoformat()})
                elif accel < -12:
                    harsh.append({"type": "Harsh Braking", "value": round(accel, 1), "time": trip[i].timestamp.isoformat()})
        summaries.append({
            "start_time": trip[0].timestamp.isoformat(),
            "end_time": trip[-1].timestamp.isoformat(),
            "duration_minutes": round(duration_min, 1),
            "distance_km": round(dist, 2),
            "harsh_events_count": len(harsh),
            "harsh_events": harsh,
            "start_lat": trip[0].latitude,
            "start_lng": trip[0].longitude,
            "end_lat": trip[-1].latitude,
            "end_lng": trip[-1].longitude
        })

    return {
        "device_id": device_id,
        "device_name": device.name,
        "period": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "trips": summaries,
        "total_trips": len(summaries),
        "total_distance_km": round(sum(t["distance_km"] for t in summaries), 2),
        "total_duration_minutes": round(sum(t["duration_minutes"] for t in summaries), 1)
    }


@router.get("/{device_id}/stops")
async def stops_report(
    device_id: int,
    start: Optional[str] = None,
    end: Optional[str] = None,
    min_duration_minutes: int = Query(5, ge=1),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Stop report where speed was 0 for at least min_duration_minutes."""
    device = await get_device_check(device_id, current_user, db)
    start_dt, end_dt = parse_date_range(start, end)
    positions = await fetch_positions(device_id, start_dt, end_dt, db)
    if not positions:
        return {"device_id": device_id, "device_name": device.name, "stops": [], "total_stops": 0}

    stops = []
    current_stop = None
    for pos in positions:
        speed = pos.speed or 0
        if speed <= 1:
            if current_stop is None:
                current_stop = {"start": pos.timestamp, "lat": pos.latitude, "lng": pos.longitude}
        else:
            if current_stop:
                duration = (pos.timestamp - current_stop["start"]).total_seconds() / 60
                if duration >= min_duration_minutes:
                    stops.append({
                        "start_time": current_stop["start"].isoformat(),
                        "end_time": pos.timestamp.isoformat(),
                        "duration_minutes": round(duration, 1),
                        "lat": current_stop["lat"],
                        "lng": current_stop["lng"]
                    })
                current_stop = None
    if current_stop:
        duration = (positions[-1].timestamp - current_stop["start"]).total_seconds() / 60
        if duration >= min_duration_minutes:
            stops.append({
                "start_time": current_stop["start"].isoformat(),
                "end_time": positions[-1].timestamp.isoformat(),
                "duration_minutes": round(duration, 1),
                "lat": current_stop["lat"],
                "lng": current_stop["lng"]
            })

    total_idle = sum(s["duration_minutes"] for s in stops)
    return {
        "device_id": device_id,
        "device_name": device.name,
        "period": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "stops": stops,
        "total_stops": len(stops),
        "total_idle_minutes": round(total_idle, 1)
    }


@router.get("/{device_id}/mileage")
async def mileage_report(
    device_id: int,
    start: Optional[str] = None,
    end: Optional[str] = None,
    group_by: Literal["day", "week", "month"] = Query("day"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Mileage report grouped by day, week or month."""
    device = await get_device_check(device_id, current_user, db)
    start_dt, end_dt = parse_date_range(start, end)
    positions = await fetch_positions(device_id, start_dt, end_dt, db)
    if not positions:
        return {"device_id": device_id, "device_name": device.name, "group_by": group_by, "entries": []}

    groups = defaultdict(lambda: {"distance_km": 0.0, "points": 0, "start": None, "end": None})
    for i, pos in enumerate(positions):
        if group_by == "day":
            key = pos.timestamp.strftime("%Y-%m-%d")
        elif group_by == "week":
            key = pos.timestamp.strftime("%Y-W%W")
        else:
            key = pos.timestamp.strftime("%Y-%m")
        grp = groups[key]
        if grp["start"] is None or pos.timestamp < grp["start"]:
            grp["start"] = pos.timestamp
        if grp["end"] is None or pos.timestamp > grp["end"]:
            grp["end"] = pos.timestamp
        grp["points"] += 1
        if i > 0:
            grp["distance_km"] += haversine(positions[i-1].latitude, positions[i-1].longitude, pos.latitude, pos.longitude)

    entries = []
    for key in sorted(groups.keys()):
        g = groups[key]
        entries.append({
            "period": key,
            "start_time": g["start"].isoformat() if g["start"] else None,
            "end_time": g["end"].isoformat() if g["end"] else None,
            "distance_km": round(g["distance_km"], 2),
            "points": g["points"]
        })

    total = sum(e["distance_km"] for e in entries)
    return {
        "device_id": device_id,
        "device_name": device.name,
        "group_by": group_by,
        "period": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "entries": entries,
        "total_distance_km": round(total, 2)
    }


@router.get("/{device_id}/speed")
async def speed_report(
    device_id: int,
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Speed report with max, average and speeding instances."""
    device = await get_device_check(device_id, current_user, db)
    start_dt, end_dt = parse_date_range(start, end)
    positions = await fetch_positions(device_id, start_dt, end_dt, db)
    if not positions:
        return {"device_id": device_id, "device_name": device.name, "max_speed": 0, "avg_speed": 0, "speeding_count": 0, "instances": []}

    speeds = [p.speed or 0 for p in positions]
    max_speed = max(speeds)
    avg_speed = round(sum(speeds) / len(speeds), 1)
    speed_limit = 120
    instances = []
    for p in positions:
        s = p.speed or 0
        if s > speed_limit:
            instances.append({"time": p.timestamp.isoformat(), "speed_kmh": round(s, 1), "lat": p.latitude, "lng": p.longitude})

    return {
        "device_id": device_id,
        "device_name": device.name,
        "period": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "max_speed_kmh": round(max_speed, 1),
        "avg_speed_kmh": avg_speed,
        "speed_limit_kmh": speed_limit,
        "speeding_count": len(instances),
        "speeding_instances": instances
    }


@router.get("/{device_id}/idle")
async def idle_report(
    device_id: int,
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Idle report alias for stop-based idle time."""
    return await stops_report(device_id, start, end, min_duration_minutes=1, db=db, current_user=current_user)


@router.get("/{device_id}/summary/{period}")
async def summary_report(
    device_id: int,
    period: Literal["daily", "weekly", "monthly"],
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Daily, weekly or monthly summary report."""
    device = await get_device_check(device_id, current_user, db)
    start_dt, end_dt = parse_date_range(start, end)
    positions = await fetch_positions(device_id, start_dt, end_dt, db)
    if not positions:
        return {"device_id": device_id, "device_name": device.name, "period_type": period, "summaries": []}

    groups = defaultdict(lambda: {"positions": [], "moving_minutes": 0.0, "idle_minutes": 0.0})
    for p in positions:
        if period == "daily":
            key = p.timestamp.strftime("%Y-%m-%d")
        elif period == "weekly":
            key = p.timestamp.strftime("%Y-W%W")
        else:
            key = p.timestamp.strftime("%Y-%m")
        groups[key]["positions"].append(p)

    summaries = []
    for key in sorted(groups.keys()):
        ps = groups[key]["positions"]
        if len(ps) < 2:
            continue
        dist = sum(haversine(ps[i-1].latitude, ps[i-1].longitude, ps[i].latitude, ps[i].longitude) for i in range(1, len(ps)))
        speeds = [p.speed or 0 for p in ps]
        max_speed = max(speeds)
        avg_speed = round(sum(speeds) / len(speeds), 1)
        # Moving time = segments with speed > 1 km/h
        moving_seconds = 0
        for i in range(1, len(ps)):
            if ps[i].speed and ps[i].speed > 1:
                moving_seconds += (ps[i].timestamp - ps[i-1].timestamp).total_seconds()
        total_seconds = (ps[-1].timestamp - ps[0].timestamp).total_seconds()
        idle_seconds = max(0, total_seconds - moving_seconds)
        summaries.append({
            "period": key,
            "start_time": ps[0].timestamp.isoformat(),
            "end_time": ps[-1].timestamp.isoformat(),
            "distance_km": round(dist, 2),
            "max_speed_kmh": round(max_speed, 1),
            "avg_speed_kmh": avg_speed,
            "moving_minutes": round(moving_seconds / 60, 1),
            "idle_minutes": round(idle_seconds / 60, 1),
            "points": len(ps)
        })

    return {
        "device_id": device_id,
        "device_name": device.name,
        "period_type": period,
        "range": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "summaries": summaries,
        "total_distance_km": round(sum(s["distance_km"] for s in summaries), 2),
        "total_idle_minutes": round(sum(s["idle_minutes"] for s in summaries), 1)
    }


@router.get("/export/{format}")
async def export_report(
    format: Literal["csv", "excel", "pdf"],
    device_id: int,
    report_type: Literal["trips", "stops", "mileage", "speed", "idle", "summary"],
    start: Optional[str] = None,
    end: Optional[str] = None,
    group_by: Optional[Literal["day", "week", "month"]] = Query(None),
    period: Optional[Literal["daily", "weekly", "monthly"]] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Export a report to CSV, Excel or PDF."""
    data = None
    if report_type == "trips":
        data = await trips_report(device_id, start, end, db=db, current_user=current_user)
    elif report_type == "stops":
        data = await stops_report(device_id, start, end, db=db, current_user=current_user)
    elif report_type == "idle":
        data = await idle_report(device_id, start, end, db=db, current_user=current_user)
    elif report_type == "mileage":
        data = await mileage_report(device_id, start, end, group_by=group_by or "day", db=db, current_user=current_user)
    elif report_type == "speed":
        data = await speed_report(device_id, start, end, db=db, current_user=current_user)
    elif report_type == "summary":
        data = await summary_report(device_id, period or "daily", start, end, db=db, current_user=current_user)

    device_name = (data or {}).get("device_name", "device")
    filename_base = f"{report_type}_{device_name.replace(' ', '_')}"

    if format == "csv":
        return _export_csv(data, report_type, filename_base)
    elif format == "excel":
        return _export_excel(data, report_type, filename_base)
    else:
        return _export_pdf(data, report_type, filename_base)


def _flatten_rows(data, report_type):
    rows = []
    if report_type in ("trips",):
        for t in data.get("trips", []):
            rows.append({
                "Start": t.get("start_time"),
                "End": t.get("end_time"),
                "Duration (min)": t.get("duration_minutes"),
                "Distance (km)": t.get("distance_km"),
                "Harsh Events": t.get("harsh_events_count"),
                "Start Lat": t.get("start_lat"),
                "Start Lng": t.get("start_lng"),
                "End Lat": t.get("end_lat"),
                "End Lng": t.get("end_lng")
            })
    elif report_type in ("stops", "idle"):
        for s in data.get("stops", data.get("stops", [])):
            rows.append({
                "Start": s.get("start_time"),
                "End": s.get("end_time"),
                "Duration (min)": s.get("duration_minutes"),
                "Lat": s.get("lat"),
                "Lng": s.get("lng")
            })
    elif report_type == "mileage":
        for e in data.get("entries", []):
            rows.append({
                "Period": e.get("period"),
                "Start": e.get("start_time"),
                "End": e.get("end_time"),
                "Distance (km)": e.get("distance_km"),
                "Points": e.get("points")
            })
    elif report_type == "speed":
        for inst in data.get("speeding_instances", []):
            rows.append({
                "Time": inst.get("time"),
                "Speed (km/h)": inst.get("speed_kmh"),
                "Lat": inst.get("lat"),
                "Lng": inst.get("lng")
            })
    elif report_type == "summary":
        for s in data.get("summaries", []):
            rows.append({
                "Period": s.get("period"),
                "Start": s.get("start_time"),
                "End": s.get("end_time"),
                "Distance (km)": s.get("distance_km"),
                "Max Speed (km/h)": s.get("max_speed_kmh"),
                "Avg Speed (km/h)": s.get("avg_speed_kmh"),
                "Moving (min)": s.get("moving_minutes"),
                "Idle (min)": s.get("idle_minutes"),
                "Points": s.get("points")
            })
    return rows


def _export_csv(data, report_type, filename_base):
    rows = _flatten_rows(data, report_type)
    if not rows:
        rows = [{"Report": f"No {report_type} data found"}]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8-sig")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename_base}.csv"}
    )


def _export_excel(data, report_type, filename_base):
    try:
        from openpyxl import Workbook
    except ImportError:
        raise HTTPException(500, "Excel export requires openpyxl. Install it with: pip install openpyxl")
    rows = _flatten_rows(data, report_type)
    if not rows:
        rows = [{"Report": f"No {report_type} data found"}]
    wb = Workbook()
    ws = wb.active
    ws.title = report_type.capitalize()
    ws.append(list(rows[0].keys()))
    for row in rows:
        ws.append(list(row.values()))
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename_base}.xlsx"}
    )


def _export_pdf(data, report_type, filename_base):
    try:
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet
    except ImportError:
        raise HTTPException(500, "PDF export requires reportlab. Install it with: pip install reportlab")
    rows = _flatten_rows(data, report_type)
    if not rows:
        rows = [{"Report": f"No {report_type} data found"}]
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=30, leftMargin=30, topMargin=30, bottomMargin=18)
    elements = []
    styles = getSampleStyleSheet()
    elements.append(Paragraph(f"<b>{report_type.capitalize()} Report - {data.get('device_name', '')}</b>", styles["Title"]))
    elements.append(Paragraph(f"Period: {data.get('period', data.get('range', {})).get('start', '')} to {data.get('period', data.get('range', {})).get('end', '')}", styles["Normal"]))
    elements.append(Spacer(1, 12))
    table_data = [list(rows[0].keys())] + [list(r.values()) for r in rows]
    table = Table(table_data, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2D5F6D")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 10),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f5f5")])
    ]))
    elements.append(table)
    doc.build(elements)
    output.seek(0)
    return Response(
        content=output.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename_base}.pdf"}
    )
