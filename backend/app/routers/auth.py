from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, UploadFile, File, Form, Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import User, Tenant, AuditLog
from datetime import datetime
from app.security import hash_password, verify_password, create_access_token
from app.auth_middleware import require_admin, get_current_user, get_current_user_optional
from pydantic import BaseModel, EmailStr
from sqlalchemy.future import select
from sqlalchemy.orm import joinedload
from sqlalchemy import text
from typing import Optional
import asyncio
import secrets
import shutil
from pathlib import Path
from app.utils.colors import extract_brand_colors

router = APIRouter(prefix="/auth", tags=["Authentication"])

class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    tenant_id: int | None = None

class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    user: dict

class SetupAccountRequest(BaseModel):
    token: str
    password: str

class CreateUserRequest(BaseModel):
    email: EmailStr
    role: str = "viewer"
    is_admin: bool = False
    tenant_id: int

class UserResponse(BaseModel):
    id: int
    email: str
    is_admin: bool
    is_active: bool
    role: str = "viewer"
    setup_token: str | None = None

    class Config:
        from_attributes = True

@router.post("/tenants", status_code=201)
async def create_tenant(
    name: str = Form(...),
    logo: Optional[UploadFile] = File(None), 
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Create a new tenant"""
    # 1. Check if tenant exists
    res = await db.execute(select(Tenant).where(Tenant.name == name))
    if res.scalars().first():
        raise HTTPException(status_code=400, detail="Company already exists")
    
    # 2. Save Logo (If provided)
    logo_url = None
    primary_color = "#2D5F6D"
    secondary_color = "#EF4835"

    if logo:
        # Resolve frontend directory dynamically
        current_file = Path(__file__).resolve()
        
        # Potential paths
        candidates = [
            # Local: auth.py -> routers -> app -> backend -> Root -> frontend
            current_file.parent.parent.parent.parent / "frontend",
            # Docker: auth.py -> routers -> app -> /app -> frontend
            current_file.parent.parent.parent / "frontend",
            Path("/app/frontend")
        ]
        
        static_dir = None
        for path in candidates:
            if path.exists() and path.is_dir():
                static_dir = path
                break
                
        if not static_dir:
            # Fallback to local static if nothing found
            static_dir = Path("static")
        
        static_dir.mkdir(exist_ok=True)
        
        filename = f"{name.lower().replace(' ', '_')}_logo.png"
        file_path = static_dir / filename
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(logo.file, buffer)
            
        # 3. Extract Colors
        primary_color, secondary_color = extract_brand_colors(file_path)
        logo_url = f"/static/{filename}"
    
    # 4. Create Tenant
    new_tenant = Tenant(
        name=name,
        logo_url=logo_url,
        primary_color=primary_color,
        secondary_color=secondary_color
    )
    db.add(new_tenant)
    await db.commit()
    await db.refresh(new_tenant)
    
    return {
        "id": new_tenant.id,
        "name": new_tenant.name,
        "logo": new_tenant.logo_url,
        "primary": new_tenant.primary_color,
        "secondary": new_tenant.secondary_color
    }

@router.get("/tenants")
async def get_tenants(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional)
):
    """List all available companies (Public for login, Admin for ID view)"""
    # 1. Immediate Fail-Fast if DB not ready
    if not getattr(request.app.state, "db_ready", False):
        print("Tenants list requested but DB not ready. Returning empty list.")
        return []

    try:
        # 2. Use direct SQL with a short timeout to prevent 502s if DB is busy/locked
        query = text("SELECT id, name, logo_url FROM tenants")
        result = await asyncio.wait_for(db.execute(query), timeout=5)
        tenants = result.mappings().all()
        
        # 3. Filter and return
        if current_user and (current_user.tenant_id != 1 or current_user.role != "admin"):
            return [{"id": t["id"], "name": t["name"], "logo": t["logo_url"]} for t in tenants if t["id"] == current_user.tenant_id]
            
        return [{"id": t["id"], "name": t["name"], "logo": t["logo_url"]} for t in tenants]
    except Exception as e:
        print(f"Tenants list fetch bypassed (DB busy/timeout): {e}")
        return []

class UpdateTenantRequest(BaseModel):
    name: Optional[str] = None

@router.patch("/tenants/{tenant_id}")
async def update_tenant(
    tenant_id: int,
    data: UpdateTenantRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Update a tenant (admin only)"""
    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Company not found")
    if data.name:
        tenant.name = data.name
    await db.commit()
    return {"id": tenant.id, "name": tenant.name, "logo": tenant.logo_url}

@router.delete("/tenants/{tenant_id}", status_code=204)
async def delete_tenant(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Delete a tenant (admin only)"""
    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Company not found")
    await db.delete(tenant)
    await db.commit()



@router.post("/login", response_model=LoginResponse)
async def login(data: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Login with email and password"""
    if not getattr(request.app.state, "db_ready", False):
        raise HTTPException(status_code=503, detail="Database is initializing. Please try again in a few seconds.")

    try:
        # Python 3.10: Use wait_for instead of timeout context manager
        result = await asyncio.wait_for(
            db.execute(select(User).options(joinedload(User.tenant)).where(User.email == data.email)),
            timeout=10
        )
        user = result.scalars().first()
            
        if not user or not user.hashed_password:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials"
            )
            
        if data.tenant_id and user.tenant_id != data.tenant_id:
                raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User does not belong to this company"
            )
        
        if not verify_password(data.password, user.hashed_password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials"
            )
        
        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account not activated. Please complete setup first."
            )
        
        # Update last_login
        user.last_login = datetime.utcnow()
        
        # Audit Log
        audit = AuditLog(
            user_id=user.id,
            action="LOGIN",
            details={"email": user.email},
            ip_address="127.0.0.1" 
        )
        db.add(audit)
        await db.commit()
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Database connection timed out")
    except Exception as e:
        print(f"Login error: {e}")
        raise HTTPException(status_code=500, detail="An internal error occurred during login")
    
    token = create_access_token({
        "sub": user.email,
        "user_id": user.id,
        "tenant_id": user.tenant_id,
        "role": user.role,
        "is_admin": user.is_admin
    })
    
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "email": user.email,
            "role": user.role,
            "is_admin": user.is_admin,
            "tenant_id": user.tenant_id,
            "company_name": user.tenant.name if user.tenant else "Inferth Mapping",
            "last_login": user.last_login,
            "theme": {
                "logo": (user.tenant.logo_url.lower().replace(" ", "_") if user.tenant.logo_url else None) if user.tenant_id == 1 else (user.tenant.logo_url if user.tenant else None),
                "primary": user.tenant.primary_color if user.tenant else "#2D5F6D",
                "secondary": user.tenant.secondary_color if user.tenant else "#EF4835",
                "navbar_bg": "#ffffff" if user.tenant_id == 1 else (user.tenant.primary_color if user.tenant else "#1a1c23"),
                "navbar_text": user.tenant.primary_color if user.tenant_id == 1 else "#ffffff"
            },
            "subscription": {
                "plan": user.tenant.plan if user.tenant else "Basic",
                "status": user.tenant.subscription_status if user.tenant else "active",
                "cycle": user.tenant.billing_cycle if user.tenant else "Monthly",
                "next_billing": user.tenant.next_billing_date.isoformat() if user.tenant and user.tenant.next_billing_date else None,
                "features": user.tenant.features if user.tenant else {"reports": False, "advanced_rules": False, "geofencing": True}
            }
        }
    }

@router.post("/setup-account")
async def setup_account(data: SetupAccountRequest, db: AsyncSession = Depends(get_db)):
    """Complete account setup by setting password"""
    # Find user with this setup token
    result = await db.execute(select(User).where(User.setup_token == data.token))
    user = result.scalars().first()
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired setup token"
        )
    
    if user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Account already activated"
        )
    
    # Set password and activate account
    user.hashed_password = hash_password(data.password)
    user.is_active = True
    user.setup_token = None  # Invalidate token
    
    await db.commit()
    await db.refresh(user)
    
    # Generate login token
    token = create_access_token({
        "sub": user.email,
        "user_id": user.id,
        "tenant_id": user.tenant_id,
        "is_admin": user.is_admin
    })
    
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "email": user.email,
            "role": user.role,
            "is_admin": user.is_admin,
            "tenant_id": user.tenant_id
        }
    }

    return {
        "id": new_user.id,
        "email": new_user.email,
        "is_admin": new_user.is_admin,
        "is_active": new_user.is_active,
        "setup_token": setup_token
    }
# (Maintenance: Redundant endpoints removed, see users.py for User CRUD)

@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    """Get current user info"""
    return {
        "id": current_user.id,
        "email": current_user.email,
        "role": current_user.role,
        "is_admin": current_user.is_admin,
        "tenant_id": current_user.tenant_id,
        "company_name": current_user.tenant.name if current_user.tenant else "Inferth Mapping",
        "theme": {
            "logo": (current_user.tenant.logo_url.lower().replace(" ", "_") if current_user.tenant.logo_url else None) if current_user.tenant_id == 1 else (current_user.tenant.logo_url if current_user.tenant else None),
            "primary": current_user.tenant.primary_color if current_user.tenant else "#2D5F6D",
            "secondary": current_user.tenant.secondary_color if current_user.tenant else "#EF4835",
            "navbar_bg": current_user.tenant.navbar_bg if current_user.tenant and current_user.tenant.navbar_bg else ("#ffffff" if current_user.tenant_id == 1 else "linear-gradient(to right, #1a1c23, #2d3139)"),
            "navbar_text": current_user.tenant.navbar_text_color if current_user.tenant and current_user.tenant.navbar_text_color else (current_user.tenant.primary_color if current_user.tenant else "#2D5F6D")
        },
        "subscription": {
            "plan": current_user.tenant.plan if current_user.tenant else "Basic",
            "status": current_user.tenant.subscription_status if current_user.tenant else "active",
            "cycle": current_user.tenant.billing_cycle if current_user.tenant else "Monthly",
            "next_billing": current_user.tenant.next_billing_date.isoformat() if current_user.tenant and current_user.tenant.next_billing_date else None,
            "features": current_user.tenant.features if current_user.tenant else {"reports": False, "advanced_rules": False, "geofencing": True}
        }
    }

@router.get("/verify-token/{token}")
async def verify_setup_token(token: str, db: AsyncSession = Depends(get_db)):
    """Verify if a setup token is valid"""
    result = await db.execute(select(User).where(User.setup_token == token))
    user = result.scalars().first()
    
    if not user or user.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired setup token"
        )
    
    return {
        "email": user.email,
        "valid": True
    }

    return user
