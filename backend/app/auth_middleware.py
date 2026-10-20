from fastapi import Depends, HTTPException, status
from typing import Optional
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from sqlalchemy import func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import joinedload
from app.config import settings
from app.db import get_db
from app.models import Device, Tenant, User

security = HTTPBearer(auto_error=False)

from fastapi import Depends, HTTPException, status, Request
import asyncio

async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> User:
    """Verify JWT token and return current user"""
    # 1. Proactive DB check (Fail fast to avoid 502)
    if not getattr(request.app.state, "db_ready", False):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="System is initializing. Please wait."
        )

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    if credentials is None:
        raise credentials_exception
        
    try:
        token = credentials.credentials
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        email: str = payload.get("sub")
        user_id: int = payload.get("user_id")
        
        if email is None or user_id is None:
            raise credentials_exception
            
    except JWTError:
        raise credentials_exception
    
    # 2. Get user from database with strict timeout
    try:
        # Python 3.10: Use wait_for instead of timeout context manager
        result = await asyncio.wait_for(
            db.execute(select(User).options(joinedload(User.tenant)).where(User.id == user_id)),
            timeout=5
        )
        user = result.scalars().first()
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Identity verification timed out")
    except Exception as e:
        print(f"Auth DB error: {e}")
        raise HTTPException(status_code=500, detail="Authentication server busy")
    
    if user is None or not user.is_active:
        raise credentials_exception
    
    return user

async def get_current_user_optional(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> Optional[User]:
    """Verify JWT token if provided, but don't fail if missing"""
    if not credentials:
        return None
        
    try:
        user = await get_current_user(request, credentials, db)
        return user
    except HTTPException:
        return None

async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Require that the current user is an admin"""
    if current_user.role != "admin" and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators can perform this action"
        )
    return current_user

async def require_manager(current_user: User = Depends(get_current_user)) -> User:
    """Require that the current user is an admin or manager"""
    allowed_roles = ["admin", "manager"]
    if current_user.role not in allowed_roles and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only managers or admins can perform this action"
        )
    return current_user

def is_platform_admin(user: User) -> bool:
    return user.tenant_id == 1 and user.role == "admin"

async def tenant_name(db: AsyncSession, user: User) -> Optional[str]:
    return (await db.execute(select(Tenant.name).where(Tenant.id == user.tenant_id))).scalar()

def tracker_visibility(user: User, company_name: Optional[str]):
    clause = Device.tenant_id == user.tenant_id
    if company_name:
        clause = or_(clause, func.lower(Device.company) == company_name.lower().strip())
    return clause

async def require_super_admin(current_user: User = Depends(get_current_user)) -> User:
    if not is_platform_admin(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the platform administrator can perform this action"
        )
    return current_user
