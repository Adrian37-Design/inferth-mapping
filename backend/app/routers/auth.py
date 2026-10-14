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
from sqlalchemy import text, func, update
from typing import Optional
import asyncio
import secrets
import shutil
from pathlib import Path
from app.utils.colors import extract_brand_colors

router = APIRouter(prefix="/auth", tags=["Authentication"])

DEFAULT_INFERTH_LOGO = "/static/inferth_mapping_logo.png"

def resolve_frontend_dir() -> Path:
    current_file = Path(__file__).resolve()
    candidates = [
        current_file.parent.parent.parent.parent / "frontend",
        current_file.parent.parent.parent / "frontend",
        Path("/app/frontend"),
        Path("frontend")
    ]
    for path in candidates:
        if path.exists() and path.is_dir():
            return path
    static_dir = Path("static")
    static_dir.mkdir(exist_ok=True)
    return static_dir

def get_effective_logo_url(logo_url: Optional[str]) -> str:
    if not logo_url or not isinstance(logo_url, str):
        return DEFAULT_INFERTH_LOGO
    cleaned = logo_url.strip()
    if not cleaned:
        return DEFAULT_INFERTH_LOGO
    if cleaned.startswith("http://") or cleaned.startswith("https://"):
        return cleaned
    
    try:
        rel_path = cleaned.replace("/static/", "").strip()
        static_dir = resolve_frontend_dir()
        if (static_dir / rel_path).exists():
            return cleaned
    except Exception:
        pass
    return DEFAULT_INFERTH_LOGO

INFERTH_DEFAULT_THEME = {
    "logo": DEFAULT_INFERTH_LOGO,
    "primary": "#ff8c00",
    "secondary": "#ef4835",
    "navbar_bg": "#ffffff",
    "navbar_text": "#ff8c00",
    "has_custom_logo": False
}

def get_field(obj, field_name, default=None):
    if obj is None:
        return default
    if isinstance(obj, dict) or hasattr(obj, "__getitem__"):
        try:
            return obj[field_name]
        except (KeyError, TypeError, IndexError):
            pass
    return getattr(obj, field_name, default)

def resolve_tenant_theme(tenant) -> dict:
    """
    Guarantees that any company using the default logo MUST use the theme colours
    for Inferth Mapping (#ff8c00, #ef4835, #ffffff white navbar).
    Only companies with an actual verified custom logo file on disk use custom colors.
    """
    if not tenant:
        return dict(INFERTH_DEFAULT_THEME)
        
    t_id = get_field(tenant, "id")
    logo_url = get_field(tenant, "logo_url")
    eff_logo = get_effective_logo_url(logo_url)
    
    has_custom = bool(logo_url and eff_logo != DEFAULT_INFERTH_LOGO and t_id != 1)
    
    if not has_custom:
        return dict(INFERTH_DEFAULT_THEME)
        
    primary = get_field(tenant, "primary_color") or "#ff8c00"
    secondary = get_field(tenant, "secondary_color") or "#ef4835"
    navbar_bg = get_field(tenant, "navbar_bg") or "linear-gradient(to right, #1a1c23, #2d3139)"
    navbar_text = get_field(tenant, "navbar_text_color") or ("#ff8c00" if navbar_bg == "#ffffff" else primary)
    
    return {
        "logo": eff_logo,
        "primary": primary,
        "secondary": secondary,
        "navbar_bg": navbar_bg,
        "navbar_text": navbar_text,
        "has_custom_logo": True
    }

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
        query = text("SELECT id, name, logo_url, primary_color, secondary_color, navbar_bg, navbar_text_color FROM tenants ORDER BY id ASC")
        result = await asyncio.wait_for(db.execute(query), timeout=5)
        tenants = result.mappings().all()
        
        # 3. Format with resolve_tenant_theme (strictly enforces Inferth colors for default logo)
        formatted = []
        for t in tenants:
            theme = resolve_tenant_theme(t)
            formatted.append({
                "id": t["id"],
                "name": t["name"],
                "logo": theme["logo"],
                "has_custom_logo": theme["has_custom_logo"],
                "primary_color": theme["primary"],
                "secondary_color": theme["secondary"],
                "navbar_bg": theme["navbar_bg"],
                "navbar_text_color": theme["navbar_text"]
            })

        if current_user and (current_user.tenant_id != 1 or current_user.role != "admin"):
            return [f for f in formatted if f["id"] == current_user.tenant_id]
            
        return formatted
    except Exception as e:
        print(f"Tenants list fetch bypassed (DB busy/timeout): {e}")
        return []

@router.patch("/tenants/{tenant_id}")
async def update_tenant(
    tenant_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin)
):
    """Update a tenant name, logo, and theme colors (admin only)"""
    from app.models import Device

    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Company not found")

    content_type = request.headers.get("content-type", "")
    new_name = None
    remove_logo = False
    logo_file = None
    primary_color = None
    secondary_color = None
    navbar_bg = None
    navbar_text_color = None

    if "application/json" in content_type:
        try:
            body = await request.json()
            new_name = body.get("name")
            remove_logo = body.get("remove_logo", False)
            primary_color = body.get("primary_color")
            secondary_color = body.get("secondary_color")
            navbar_bg = body.get("navbar_bg")
            navbar_text_color = body.get("navbar_text_color")
        except Exception:
            pass
    else:
        try:
            form = await request.form()
            new_name = form.get("name")
            remove_val = form.get("remove_logo")
            if str(remove_val).lower() in ("true", "1", "yes"):
                remove_logo = True
            uploaded = form.get("logo")
            if uploaded and hasattr(uploaded, "filename") and uploaded.filename:
                logo_file = uploaded
            primary_color = form.get("primary_color")
            secondary_color = form.get("secondary_color")
            navbar_bg = form.get("navbar_bg")
            navbar_text_color = form.get("navbar_text_color")
        except Exception:
            pass

    if new_name and str(new_name).strip():
        old_name = tenant.name
        tenant.name = str(new_name).strip()
        # Keep devices in sync if company name changed
        if old_name != tenant.name:
            await db.execute(
                update(Device).where(Device.tenant_id == tenant.id).values(company=tenant.name)
            )

    if remove_logo:
        tenant.logo_url = None
        tenant.primary_color = primary_color or "#ff8c00"
        tenant.secondary_color = secondary_color or "#ef4835"
        tenant.navbar_bg = navbar_bg or "#ffffff"
        tenant.navbar_text_color = navbar_text_color or "#ff8c00"
    elif logo_file:
        static_dir = resolve_frontend_dir()
        static_dir.mkdir(exist_ok=True)
        ext = Path(logo_file.filename).suffix.lower()
        if ext not in [".png", ".jpg", ".jpeg", ".svg", ".webp"]:
            ext = ".png"
        safe_name = "".join(c if c.isalnum() else "_" for c in tenant.name.lower()).strip("_")
        filename = f"{safe_name}_logo{ext}"
        file_path = static_dir / filename
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(logo_file.file, buffer)
        primary_color_extracted, secondary_color_extracted = extract_brand_colors(file_path)
        tenant.logo_url = f"/static/{filename}"
        tenant.primary_color = primary_color or primary_color_extracted
        tenant.secondary_color = secondary_color or secondary_color_extracted
        if navbar_bg:
            tenant.navbar_bg = navbar_bg
        if navbar_text_color:
            tenant.navbar_text_color = navbar_text_color
    else:
        # Color-only update
        if primary_color:
            tenant.primary_color = str(primary_color).strip()
        if secondary_color:
            tenant.secondary_color = str(secondary_color).strip()
        if navbar_bg:
            tenant.navbar_bg = str(navbar_bg).strip()
        if navbar_text_color:
            tenant.navbar_text_color = str(navbar_text_color).strip()

    await db.commit()
    await db.refresh(tenant)

    effective_logo = get_effective_logo_url(tenant.logo_url)
    return {
        "id": tenant.id,
        "name": tenant.name,
        "logo": effective_logo,
        "has_custom_logo": bool(tenant.logo_url and effective_logo != DEFAULT_INFERTH_LOGO),
        "primary": tenant.primary_color,
        "secondary": tenant.secondary_color,
        "navbar_bg": tenant.navbar_bg,
        "navbar_text_color": tenant.navbar_text_color
    }

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
            db.execute(select(User).options(joinedload(User.tenant)).where(func.lower(User.email) == data.email.strip().lower())),
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
            # Auto-activate: user has valid credentials but never completed setup link
            user.is_active = True
            user.setup_token = None
        
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
            "theme": resolve_tenant_theme(user.tenant),
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
        "theme": resolve_tenant_theme(current_user.tenant),
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
