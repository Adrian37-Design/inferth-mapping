from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import User, Tenant, AuditLog
from datetime import datetime
from app.security import hash_password, verify_password, create_access_token
from app.auth_middleware import require_admin, get_current_user, get_current_user_optional
from pydantic import BaseModel, EmailStr
from sqlalchemy.future import select
from sqlalchemy.orm import joinedload
from typing import Optional
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
        orm_mode = True

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
    db: AsyncSession = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional)
):
    """List all available companies (Public for login, Admin for ID view)"""
    result = await db.execute(select(Tenant.id, Tenant.name, Tenant.logo_url))
    tenants = result.all()
    
    # IDs are needed for login, so we must return them. 
    # Protection is handled at the UI/Role level for management features.
    return [{"id": t.id, "name": t.name, "logo": t.logo_url} for t in tenants]

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
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Login with email and password"""
    result = await db.execute(
        select(User).options(joinedload(User.tenant)).where(User.email == data.email)
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
        ip_address="127.0.0.1" # TODO: Extract from request
    )
    db.add(audit)
    await db.commit()
    
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
            "last_login": user.last_login,
            "theme": {
                "logo": user.tenant.logo_url if user.tenant else None,
                "primary": user.tenant.primary_color if user.tenant else "#2D5F6D",
                "secondary": user.tenant.secondary_color if user.tenant else "#EF4835"
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

@router.post("/create-user", response_model=UserResponse)
async def create_user(
    data: CreateUserRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Create a new user (admin only). User must complete setup via token."""
    # Check if user already exists
    result = await db.execute(select(User).where(User.email == data.email))
    existing_user = result.scalars().first()
    
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User with this email already exists"
        )
    
    # Verify tenant exists
    tenant_result = await db.execute(select(Tenant).where(Tenant.id == data.tenant_id))
    tenant = tenant_result.scalars().first()
    
    if not tenant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tenant not found"
        )
    
    # Generate setup token
    setup_token = secrets.token_urlsafe(32)
    
    # Create new user
    new_user = User(
        email=data.email,
        is_admin=data.is_admin,
        role=data.role, # Save assigned role
        is_active=False,
        setup_token=setup_token,
        tenant_id=data.tenant_id
    )
    
    db.add(new_user)
    await db.commit()
    await db.refresh(new_user)
    
    # Send Invitation Email
    from app.services.email import send_email
    from app.config import settings
    
    # Check if we are in production or local to determine the link
    # We can use a setting or a hardcoded fallback if domain is not set
    # ideally settings.FRONTEND_URL, but for now we infer or use a placeholder
    base_url = "https://inferth-mapping.up.railway.app" 
    link = f"{base_url}/static/signup.html?token={setup_token}"
    
    subject = "Welcome to Inferth Mapping - Setup Your Account"
    html_content = f"""
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #007bff;">Welcome to Inferth Mapping!</h2>
        <p>You have been invited to join the platform as a <strong>{data.role}</strong>.</p>
        <p>Please click the button below to set up your password and access your account:</p>
        <div style="text-align: center; margin: 30px 0;">
            <a href="{link}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Set Up Account</a>
        </div>
        <p style="font-size: 12px; color: #888;">If the button doesn't work, copy this link:<br>{link}</p>
    </div>
    """
    
    # Send email in background to avoid blocking the UI
    background_tasks.add_task(send_email, new_user.email, subject, html_content)

    return {
        "id": new_user.id,
        "email": new_user.email,
        "is_admin": new_user.is_admin,
        "is_active": new_user.is_active,
        "setup_token": setup_token
    }

@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    """Get current user info"""
    return {
        "id": current_user.id,
        "email": current_user.email,
        "is_admin": current_user.is_admin,
        "tenant_id": current_user.tenant_id
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

@router.get("/users", response_model=list[UserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """List all users (admin only)"""
    result = await db.execute(select(User))
    users = result.scalars().all()
    print(f"DEBUG: list_users returning {len(users)} users: {[u.email for u in users]}") 
    return users

class UpdateUserRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None

@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    data: UpdateUserRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Update user role or status (admin only)"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    # Prevent modifying self to avoid lockout
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot modify your own account status/role")

    if data.role:
        user.role = data.role
        # Sync is_admin flag for backward compatibility
        user.is_admin = (data.role == 'admin')
        
    if data.is_active is not None:
        user.is_active = data.is_active
        
    await db.commit()
    await db.refresh(user)
    return user

@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Delete a user (admin only)"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
        
    await db.delete(user)
    await db.commit()
    
    return {"message": "User deleted successfully"}
