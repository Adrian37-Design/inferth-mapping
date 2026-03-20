from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import select, delete
from typing import List
from app.db import AsyncSessionLocal
from app.models import Rule, User
from app.routers.auth import get_current_user
from pydantic import BaseModel
from datetime import datetime

router = APIRouter(prefix="/rules", tags=["rules"])

class RuleBase(BaseModel):
    device_id: int = None
    event_type: str
    threshold: float = None
    channel: str = "system"
    contact: str = None
    is_active: bool = True

class RuleCreate(RuleBase):
    pass

class RuleOut(RuleBase):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True

@router.post("/", response_model=RuleOut)
async def create_rule(rule: RuleCreate, current_user: User = Depends(get_current_user)):
    async with AsyncSessionLocal() as db:
        new_rule = Rule(
            tenant_id=current_user.tenant_id,
            device_id=rule.device_id,
            event_type=rule.event_type,
            threshold=rule.threshold,
            channel=rule.channel,
            contact=rule.contact,
            is_active=rule.is_active
        )
        db.add(new_rule)
        await db.commit()
        await db.refresh(new_rule)
        return new_rule

@router.get("/", response_model=List[RuleOut])
async def get_rules(current_user: User = Depends(get_current_user)):
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Rule).where(Rule.tenant_id == current_user.tenant_id))
        return res.scalars().all()

@router.delete("/{rule_id}")
async def delete_rule(rule_id: int, current_user: User = Depends(get_current_user)):
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Rule).where(Rule.id == rule_id, Rule.tenant_id == current_user.tenant_id))
        rule = res.scalars().first()
        if not rule:
            raise HTTPException(status_code=404, detail="Rule not found")
        
        await db.delete(rule)
        await db.commit()
        return {"message": "Rule deleted"}
