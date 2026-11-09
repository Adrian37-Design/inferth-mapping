from fastapi import APIRouter, Depends, HTTPException, status, Query, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, and_, desc
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta
from pydantic import BaseModel

from app.db import get_db
from app.models import User, Device, Insight, InsightAction, DriverScore, Position
from app.auth_middleware import get_current_user, require_manager
from app.services.insights_engine import (
    generate_manager_insights,
    generate_driver_insights,
    compute_driver_score
)
from app.config import settings

router = APIRouter(prefix="/insights", tags=["Insights"])


class InsightActionIn(BaseModel):
    action_type: str
    details: Optional[Dict[str, Any]] = None


class SimulateInsightIn(BaseModel):
    type: str = "fuel_siphoning"  # fuel_siphoning, night_trip, dtc_attention, harsh_braking
    device_id: Optional[int] = None
    fuel_drop_liters: Optional[float] = 18.5
    driver_name: Optional[str] = None
    details: Optional[Dict[str, Any]] = None


@router.get("/manager")
async def get_manager_insights_endpoint(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Manager Insights: 'Where am I losing money?'
    Strict RBAC: Only admin or manager role may access this endpoint.
    """
    if current_user.role not in ["admin", "manager"] and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access restricted: Manager role required to view Fleet Manager Insights"
        )

    data = await generate_manager_insights(db, current_user.tenant_id, current_user)
    return data


@router.get("/driver")
async def get_driver_insights_endpoint(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Driver Insights: 'How do I drive better and not get in trouble?'
    Only shows the driver's own assigned vehicle and performance score.
    Zero money loss or driver comparison data is exposed.
    """
    data = await generate_driver_insights(db, current_user)
    return data


@router.post("/simulate")
async def simulate_insight_event(
    payload: SimulateInsightIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """
    Simulation utility to trigger test events such as Fuel Siphoning with engine off.
    Enables testing acceptance criteria.
    """
    tenant_id = current_user.tenant_id
    fuel_price = getattr(settings, "FUEL_PRICE_USD", 1.65)

    # Pick device
    device = None
    if payload.device_id:
        dev_res = await db.execute(select(Device).where(Device.id == payload.device_id))
        device = dev_res.scalars().first()
    if not device:
        dev_res = await db.execute(select(Device).where(Device.tenant_id == tenant_id))
        device = dev_res.scalars().first()

    dev_id = device.id if device else 1
    dev_name = device.name if device else "Fleet Tracker 01"
    driver_name = payload.driver_name or (device.driver_name if device and device.driver_name else "Assigned Driver")

    sim_type = payload.type.lower()
    now = datetime.utcnow()

    if sim_type in ["fuel_siphoning", "siphon"]:
        liters = payload.fuel_drop_liters or 18.5
        money_impact = round(liters * fuel_price, 2)
        ins = Insight(
            tenant_id=tenant_id,
            device_id=dev_id,
            driver_name=driver_name,
            role_target="manager",
            category="fuel_siphoning",
            severity="red",
            title="Possible Fuel Siphoning Detected",
            description=f"Fuel drop of {liters:.1f}L while engine OFF and speed = 0 km/h for >10 mins.",
            metric_value=f"-{liters:.1f} L",
            money_impact=money_impact,
            status="open",
            extra_data={
                "fuel_dropped": liters,
                "fuel_price": fuel_price,
                "time": now.strftime("%Y-%m-%d %H:%M"),
                "lat": -17.8248,
                "lng": 31.0530,
                "location_name": "Depot Parking Area (Off-shift)",
                "actions": ["view_fuel_graph", "message_driver", "mark_resolved"]
            }
        )
        db.add(ins)
        await db.commit()
        await db.refresh(ins)
        return {"status": "success", "message": "Simulated fuel siphoning event created", "insight_id": ins.id}

    elif sim_type in ["night_trip", "unauthorized_trip"]:
        ins = Insight(
            tenant_id=tenant_id,
            device_id=dev_id,
            driver_name=driver_name,
            role_target="manager",
            category="unauthorized_night_trip",
            severity="red",
            title="Unauthorized Night Trip",
            description="Vehicle moved 38.4 km outside approved work hours between 23:30 and 01:15.",
            metric_value="38.4 km (5.2 L)",
            money_impact=round(5.2 * fuel_price, 2),
            status="open",
            extra_data={
                "distance_km": 38.4,
                "fuel_used_l": 5.2,
                "start_time": (now - timedelta(hours=3)).strftime("%H:%M"),
                "end_time": (now - timedelta(hours=1)).strftime("%H:%M"),
                "lat": -17.8300,
                "lng": 31.0600,
                "actions": ["view_trip_replay", "call_driver"]
            }
        )
        db.add(ins)
        await db.commit()
        await db.refresh(ins)
        return {"status": "success", "message": "Simulated unauthorized night trip created", "insight_id": ins.id}

    elif sim_type in ["car_attention", "dtc"]:
        ins = Insight(
            tenant_id=tenant_id,
            device_id=dev_id,
            driver_name=driver_name,
            role_target="driver",
            category="car_attention",
            severity="red",
            title="Your Car Needs Attention",
            description="What happened: Engine coolant temperature high (114°C). What to do now: Pull over safely and call your fleet manager.",
            metric_value="Immediate Attention",
            status="open",
            extra_data={
                "plain_issue": "Engine coolant temperature high (114°C).",
                "plain_action": "Pull over safely and notify your manager.",
                "actions": ["stop_safely", "call_manager", "find_nearest_mechanic"]
            }
        )
        db.add(ins)
        await db.commit()
        await db.refresh(ins)
        return {"status": "success", "message": "Simulated driver attention event created", "insight_id": ins.id}

    raise HTTPException(status_code=400, detail=f"Unknown simulation type: {payload.type}")


@router.post("/{insight_id}/resolve")
async def resolve_insight(
    insight_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """Mark an insight card as resolved."""
    # Check if numerical ID for persisted DB model
    if insight_id.isdigit():
        q = await db.execute(select(Insight).where(and_(Insight.id == int(insight_id), Insight.tenant_id == current_user.tenant_id)))
        ins = q.scalars().first()
        if ins:
            ins.status = "resolved"
            ins.resolved_at = datetime.utcnow()
            action = InsightAction(
                insight_id=ins.id,
                action_type="mark_resolved",
                performed_by_id=current_user.id,
                details={"user_email": current_user.email}
            )
            db.add(action)
            await db.commit()
            return {"status": "success", "message": f"Insight #{insight_id} resolved"}

    # For live generated synthetic cards, create resolved DB record so it suppresses re-appearance
    ins = Insight(
        tenant_id=current_user.tenant_id,
        category="resolved_live",
        role_target="manager",
        severity="blue",
        title="Resolved Card",
        description=f"Synthetic insight {insight_id} marked resolved by {current_user.email}",
        status="resolved",
        resolved_at=datetime.utcnow(),
        extra_data={"synthetic_id": insight_id}
    )
    db.add(ins)
    await db.commit()
    return {"status": "success", "message": "Insight resolved"}


@router.post("/{insight_id}/action")
async def record_insight_action(
    insight_id: str,
    payload: InsightActionIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Record an action taken on an insight card."""
    if insight_id.isdigit():
        q = await db.execute(select(Insight).where(Insight.id == int(insight_id)))
        ins = q.scalars().first()
        if ins:
            act = InsightAction(
                insight_id=ins.id,
                action_type=payload.action_type,
                performed_by_id=current_user.id,
                details=payload.details or {}
            )
            db.add(act)
            await db.commit()

    return {
        "status": "success",
        "action": payload.action_type,
        "insight_id": insight_id,
        "performed_by": current_user.email
    }


@router.get("/fuel-graph/{device_id}")
async def get_fuel_graph_data(
    device_id: int,
    hours: int = 48,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Return time-series fuel level data for rendering the Fuel Graph modal
    showing fuel drops, engine status, and speed.
    """
    since = datetime.utcnow() - timedelta(hours=hours)
    stmt = (
        select(Position)
        .where(and_(Position.device_id == device_id, Position.timestamp >= since))
        .order_by(Position.timestamp.asc())
        .limit(300)
    )
    result = await db.execute(stmt)
    positions = result.scalars().all()

    points = []
    baseline_fuel = 45.0
    for i, p in enumerate(positions):
        fuel = p.fuel_level
        if fuel is None:
            # Baseline simulation if fuel sensor not calibrated
            fuel = round(baseline_fuel - (i * 0.08), 1)
        points.append({
            "timestamp": p.timestamp.isoformat(),
            "fuel_level": fuel,
            "speed": p.speed or 0.0,
            "ignition": p.ignition,
            "lat": p.latitude,
            "lng": p.longitude
        })

    # If no points yet, provide a mock 24h curve demonstrating fuel drop
    if not points:
        now = datetime.utcnow()
        for h in range(24, 0, -1):
            t = now - timedelta(hours=h)
            # Simulate sharp fuel drop 8 hours ago
            f_lvl = 52.0 if h > 8 else 33.5
            points.append({
                "timestamp": t.isoformat(),
                "fuel_level": f_lvl,
                "speed": 40.0 if h > 10 else 0.0,
                "ignition": True if h > 10 else False,
                "lat": -17.825,
                "lng": 31.05
            })

    return {"device_id": device_id, "points": points}
