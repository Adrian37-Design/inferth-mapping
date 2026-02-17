from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import desc
from app.db import get_db
from app.models import User, AuditLog
from app.auth_middleware import require_admin
from pydantic import BaseModel
from datetime import datetime
from typing import List, Optional, Any

router = APIRouter(prefix="/audit-logs", tags=["Audit Logs"])

class AuditLogOut(BaseModel):
    id: int
    user_id: Optional[int]
    action: str
    details: Any
    ip_address: Optional[str]
    timestamp: datetime
    user_email: Optional[str] = None # Computed field

    class Config:
        orm_mode = True

@router.get("/", response_model=List[AuditLogOut])
async def get_audit_logs(
    skip: int = 0, 
    limit: int = 50, 
    current_user: User = Depends(require_admin), 
    db: AsyncSession = Depends(get_db)
):
    """List audit logs (Admin only)"""
    # Join with User to get email
    query = select(AuditLog, User.email).outerjoin(User, AuditLog.user_id == User.id).order_by(desc(AuditLog.timestamp)).offset(skip).limit(limit)
    result = await db.execute(query)
    
    logs = []
    for row in result:
        log, email = row
        log_dict = {
            "id": log.id,
            "user_id": log.user_id,
            "action": log.action,
            "details": log.details,
            "ip_address": log.ip_address,
            "timestamp": log.timestamp,
            "user_email": email
        }
        logs.append(log_dict)
        
    return logs
