from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.db import get_db
from app.models import User, Tenant, AuditLog
from app.auth_middleware import require_admin, get_current_user
from pydantic import BaseModel, EmailStr
from datetime import datetime
from typing import List, Optional
import secrets
from app.security import hash_password
from app.services.email import send_email

router = APIRouter(prefix="/users", tags=["Users"])

class UserCreate(BaseModel):
    email: EmailStr
    role: str = "viewer"
    tenant_id: int

class UserUpdate(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    tenant_id: Optional[int] = None

class UserOut(BaseModel):
    id: int
    email: str
    role: str
    is_active: bool
    tenant_id: int
    last_login: Optional[datetime] = None
    accessible_assets: Optional[List[str]] = None
    created_at: Optional[datetime] = None
    tenant_name: Optional[str] = None # Added via property or select_from

    class Config:
        orm_mode = True

@router.get("/", response_model=List[UserOut])
async def get_users(
    skip: int = 0, 
    limit: int = 100, 
    current_user: User = Depends(require_admin), 
    db: AsyncSession = Depends(get_db)
):
    """List all users (Admin only)"""
    # Join with Tenant to get names
    from sqlalchemy.orm import joinedload
    result = await db.execute(
        select(User).options(joinedload(User.tenant)).offset(skip).limit(limit)
    )
    users = result.scalars().all()
    
    # Map tenant name to property for Pydantic
    for u in users:
        u.tenant_name = u.tenant.name if u.tenant else "No Company"
        
    return users

@router.post("/", response_model=UserOut)
async def create_user(
    user_in: UserCreate, 
    current_user: User = Depends(require_admin), 
    db: AsyncSession = Depends(get_db)
):
    """Invite a new user"""
    # Check if user exists
    result = await db.execute(select(User).where(User.email == user_in.email))
    if result.scalars().first():
        raise HTTPException(status_code=400, detail="Email already registered")

    # Generate setup token
    setup_token = secrets.token_urlsafe(32)
    
    # Enforce role restriction: Admin only for Tenant 1 (Inferth Mapping)
    if user_in.role == "admin" and user_in.tenant_id != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, 
            detail="Admin role is only available for Inferth Mapping"
        )
    
    new_user = User(
        email=user_in.email,
        role=user_in.role,
        tenant_id=user_in.tenant_id,
        is_active=False,
        setup_token=setup_token,
        accessible_assets=["*"] # Default to all
    )
    db.add(new_user)
    
    # Audit Log
    audit = AuditLog(
        user_id=current_user.id,
        action="CREATE_USER",
        details={"email": new_user.email, "role": new_user.role},
        ip_address="127.0.0.1" # TODO: Extract from request
    )
    db.add(audit)
    
    await db.commit()
    await db.refresh(new_user)
    
    # Send Invite Email (Mock for now, or use Resend if configured)
    # background_tasks.add_task(send_invite_email, new_user.email, setup_token)
    
    return new_user

@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int, 
    user_update: UserUpdate, 
    current_user: User = Depends(require_admin), 
    db: AsyncSession = Depends(get_db)
):
    """Update user role or status"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Enforce role restriction
    target_role = user_update.role if user_update.role is not None else user.role
    target_tenant = user_update.tenant_id if user_update.tenant_id is not None else user.tenant_id
    
    if target_role == "admin" and target_tenant != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, 
            detail="Admin role is only available for Inferth Mapping"
        )
        
    if user_update.role is not None:
        user.role = user_update.role
    if user_update.is_active is not None:
        user.is_active = user_update.is_active
    if user_update.tenant_id is not None:
        user.tenant_id = user_update.tenant_id
        
    # Audit Log
    audit = AuditLog(
        user_id=current_user.id,
        action="UPDATE_USER",
        details={"target_user_id": user_id, "changes": user_update.dict(exclude_unset=True)},
        ip_address="127.0.0.1"
    )
    db.add(audit)
        
    await db.commit()
    await db.refresh(user)
    return user

@router.delete("/{user_id}")
async def delete_user(
    user_id: int, 
    current_user: User = Depends(require_admin), 
    db: AsyncSession = Depends(get_db)
):
    """Delete a user"""
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
        
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    # Nullify user_id in AuditLog before deleting user
    from sqlalchemy import update
    await db.execute(
        update(AuditLog).where(AuditLog.user_id == user_id).values(user_id=None)
    )
    
    await db.delete(user)
    
    # Audit Log
    audit = AuditLog(
        user_id=current_user.id,
        action="DELETE_USER",
        details={"target_user_id": user_id, "email": user.email},
        ip_address="127.0.0.1"
    )
    db.add(audit)
    
    await db.commit()
    return {"message": "User deleted"}
