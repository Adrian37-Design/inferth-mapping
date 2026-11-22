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

class InsightOutcomeIn(BaseModel):
    outcome: str = "CONFIRMED_THEFT"  # CONFIRMED_THEFT, LEGITIMATE_CONSUMPTION, FALSE_ALARM, RESOLVED
    manager_name: str
    notes: Optional[str] = ""

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


@router.post("/demo-showcase")
async def seed_demo_showcase_insights(
    expire_minutes: int = 60,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """
    Seeds a high-impact, eye-catching suite of realistic demo insights
    specifically tailored for a client presentation.
    All seeded insights automatically expire after `expire_minutes` (default: 60 mins).
    """
    tenant_id = current_user.tenant_id
    fuel_price = getattr(settings, "FUEL_PRICE_USD", 2.04)

    # Fetch available vehicles for this tenant
    dev_res = await db.execute(select(Device).where(Device.tenant_id == tenant_id))
    devices = dev_res.scalars().all()
    
    primary_dev = devices[0] if devices else None
    secondary_dev = devices[1] if len(devices) > 1 else primary_dev
    
    dev1_id = primary_dev.id if primary_dev else 1
    dev1_name = primary_dev.name if primary_dev else "Freightliner Argosy (ABG-4921)"
    driver1_name = (primary_dev.driver_name if primary_dev and primary_dev.driver_name else None) or "Tinashe Moyo"

    dev2_id = secondary_dev.id if secondary_dev else 2
    dev2_name = secondary_dev.name if secondary_dev else "Isuzu Forward 8-Ton (ADZ-1104)"
    driver2_name = (secondary_dev.driver_name if secondary_dev and secondary_dev.driver_name else None) or "Blessing Sibanda"

    now = datetime.utcnow()
    expires_at = (now + timedelta(minutes=expire_minutes)).isoformat() + "Z"

    demo_insights = [
        # 1. Fuel Siphoning / Rapid Drain (Critical Alert - Money Impact)
        Insight(
            tenant_id=tenant_id,
            device_id=dev1_id,
            driver_name=driver1_name,
            role_target="manager",
            category="fuel_siphoning",
            severity="red",
            title="Sudden Off-Shift Fuel Drain Detected",
            description=f"Rapid 28.5 Litre fuel drop (-28.5 L) detected while ignition OFF and parked at Msasa Industrial Staging yard. Estimated loss: $58.14 USD.",
            metric_value="-28.5 L",
            money_impact=round(28.5 * fuel_price, 2),
            status="open",
            extra_data={
                "vehicle_name": dev1_name,
                "fuel_dropped": 28.5,
                "fuel_price": fuel_price,
                "time": (now - timedelta(minutes=24)).strftime("%Y-%m-%d %H:%M"),
                "lat": -17.8412,
                "lng": 31.1189,
                "location_name": "Msasa Logistics Hub, Harare",
                "actions": ["view_fuel_graph", "message_driver", "mark_resolved"],
                "expires_at": expires_at,
                "is_demo": True
            }
        ),

        # 2. Unauthorized Night Trip (High Priority Exception)
        Insight(
            tenant_id=tenant_id,
            device_id=dev2_id,
            driver_name=driver2_name,
            role_target="manager",
            category="unauthorized_night_trip",
            severity="red",
            title="Unauthorized Out-of-Hours Vehicle Movement",
            description=f"{dev2_name} operated 46.2 km between 23:45 and 01:20 without a scheduled dispatch order. Geofence perimeter breached.",
            metric_value="46.2 km (6.8 L)",
            money_impact=round(6.8 * fuel_price, 2),
            status="open",
            extra_data={
                "vehicle_name": dev2_name,
                "distance_km": 46.2,
                "fuel_used_l": 6.8,
                "start_time": "23:45",
                "end_time": "01:20",
                "lat": -17.8251,
                "lng": 31.0534,
                "route": "Harare CBD &rarr; Chitungwiza Return Corridor",
                "actions": ["view_trip_replay", "call_driver"],
                "expires_at": expires_at,
                "is_demo": True
            }
        ),

        # 3. Excessive Fuel Burn / Inefficient Driving (Weekly Cost Optimization)
        Insight(
            tenant_id=tenant_id,
            device_id=dev1_id,
            driver_name=driver1_name,
            role_target="manager",
            category="driver_costing_fuel",
            severity="orange",
            title="High Fuel Consumption Pattern",
            description=f"Consuming 38.4 L/100km (+24% above fleet benchmark of 31.0 L/100km) caused by prolonged idling and aggressive acceleration.",
            metric_value="38.4 vs 31.0 L/100km",
            money_impact=round(33.6 * fuel_price, 2),
            status="open",
            extra_data={
                "vehicle_name": dev1_name,
                "driver_l100km": 38.4,
                "fleet_avg_l100km": 31.0,
                "route": "Harare &rarr; Norton Highway Transit",
                "money_impact_per_week": round(33.6 * fuel_price, 2),
                "fuel_price": fuel_price,
                "actions": ["coach_driver", "check_vehicle"],
                "expires_at": expires_at,
                "is_demo": True
            }
        ),

        # 4. Preventive Maintenance Due (Zero Downtime Fleet Protection)
        Insight(
            tenant_id=tenant_id,
            device_id=dev2_id,
            driver_name=driver2_name,
            role_target="manager",
            category="service_due_soon",
            severity="orange",
            title="Scheduled B-Service Due in 320 km",
            description=f"Odometer reached 9,680 km since last major overhaul. Engine coolant operating temperature peaking near 102°C on inclines.",
            metric_value="9,680 / 10,000 km",
            money_impact=450.00,
            status="open",
            extra_data={
                "vehicle_name": dev2_name,
                "km_since_service": 9680,
                "days_left": 4,
                "risk_cost": 450.0,
                "actions": ["schedule_service", "assign_mechanic"],
                "expires_at": expires_at,
                "is_demo": True
            }
        ),

        # 5. Top Driver Reward / Recognition (Culture of Safety)
        Insight(
            tenant_id=tenant_id,
            device_id=dev2_id,
            driver_name=driver2_name,
            role_target="manager",
            category="best_driver_week",
            severity="blue",
            title="Top Safe Driver of the Week",
            description=f"{driver2_name} achieved an exemplary 96/100 score with zero harsh braking maneuvers and optimal gear shift discipline across 840 km.",
            metric_value="96/100 Score",
            money_impact=None,
            status="open",
            extra_data={
                "vehicle_name": dev2_name,
                "score": 96,
                "actions": ["send_bonus_praise"],
                "expires_at": expires_at,
                "is_demo": True
            }
        ),

        # 6. Driver-Facing Alert: Engine Diagnostic Warning (Plain Language, Non-Technical)
        Insight(
            tenant_id=tenant_id,
            device_id=dev1_id,
            driver_name=driver1_name,
            role_target="driver",
            category="car_attention",
            severity="red",
            title="Engine Diagnostic: Coolant Temperature Alert",
            description="What happened: Engine coolant temperature reached 108°C. What to do now: Pull over safely when convenient and notify your fleet coordinator.",
            metric_value="Immediate Attention",
            money_impact=None,
            status="open",
            extra_data={
                "vehicle_name": dev1_name,
                "plain_issue": "Engine coolant temperature running unusually high (108°C).",
                "plain_action": "Pull over safely, let engine idle before shutdown, and contact maintenance.",
                "actions": ["stop_safely", "call_manager", "find_nearest_mechanic"],
                "expires_at": expires_at,
                "is_demo": True
            }
        )
    ]

    for item in demo_insights:
        db.add(item)
    
    await db.commit()

    return {
        "status": "success",
        "message": f"Successfully applied 6 client-ready showcase insights! They will automatically expire in {expire_minutes} minutes.",
        "expires_at": expires_at,
        "count": len(demo_insights)
    }


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


@router.post("/{insight_id}/confirm-outcome")
async def confirm_insight_outcome(
    insight_id: str,
    payload: InsightOutcomeIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """
    P2 Strategic Milestone: Ground-truth theft and incident outcome labeling.
    Strictly restricted to Managers and Admins only. Records manager signature and outcome.
    """
    if not payload.manager_name or not payload.manager_name.strip():
        raise HTTPException(status_code=400, detail="Manager name signature is required")

    mgr_name = payload.manager_name.strip()
    status_mapped = "confirmed_theft" if payload.outcome == "CONFIRMED_THEFT" else "resolved"

    if insight_id.isdigit():
        q = await db.execute(
            select(Insight).where(
                and_(Insight.id == int(insight_id), Insight.tenant_id == current_user.tenant_id)
            )
        )
        ins = q.scalars().first()
        if ins:
            ins.status = status_mapped
            ins.resolved_at = datetime.utcnow()
            meta = dict(ins.extra_data or {})
            meta["outcome"] = payload.outcome
            meta["confirmed_by_manager"] = mgr_name
            meta["resolution_notes"] = payload.notes
            ins.extra_data = meta

            action = InsightAction(
                insight_id=ins.id,
                action_type=f"P2_{payload.outcome}",
                performed_by_id=current_user.id,
                details={
                    "manager_name": mgr_name,
                    "notes": payload.notes,
                    "outcome": payload.outcome,
                    "user_email": current_user.email
                }
            )
            db.add(action)
            await db.commit()
            return {
                "status": "success",
                "message": f"Incident verified as {payload.outcome} by Manager {mgr_name}",
                "outcome": payload.outcome,
                "manager_name": mgr_name
            }

    # For live generated synthetic cards, create resolved DB record
    ins = Insight(
        tenant_id=current_user.tenant_id,
        category="outcome_verified",
        role_target="manager",
        severity="blue",
        title=f"Incident Outcome: {payload.outcome.replace('_', ' ').title()}",
        description=f"Verified by Manager {mgr_name}: {payload.notes or 'Ground-truth outcome recorded.'}",
        status=status_mapped,
        resolved_at=datetime.utcnow(),
        extra_data={
            "synthetic_id": insight_id,
            "outcome": payload.outcome,
            "confirmed_by_manager": mgr_name,
            "resolution_notes": payload.notes
        }
    )
    db.add(ins)
    await db.commit()
    return {
        "status": "success",
        "message": f"Incident verified as {payload.outcome} by Manager {mgr_name}",
        "outcome": payload.outcome,
        "manager_name": mgr_name
    }


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
