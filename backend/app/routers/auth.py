from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import User, Tenant, AuditLog
from datetime import datetime
from app.utils import hash_password, verify_password, create_access_token
from app.auth_middleware import require_admin, get_current_user
from pydantic import BaseModel, EmailStr
from sqlalchemy.future import select
import secrets

router = APIRouter(prefix="/auth", tags=["Authentication"])

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

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

@router.post("/login", response_model=LoginResponse)
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Login with email and password"""
    result = await db.execute(select(User).where(User.email == data.email))
    user = result.scalars().first()
    
    if not user or not user.hashed_password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials"
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
            "last_login": user.last_login # Added to response
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
