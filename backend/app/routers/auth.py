from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, UploadFile, File, Form, Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.models import User, Tenant, AuditLog
from datetime import datetime, timedelta
from app.config import settings
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
import random
import hashlib
from pathlib import Path
from app.utils.colors import extract_brand_colors
from app.services.whatsapp import normalize_msisdn, send_whatsapp

router = APIRouter(prefix="/auth", tags=["Authentication"])

# ---------------------------------------------------------------------------
# WhatsApp OTP Store
# Process-local in-memory store (single uvicorn worker — fine for Railway).
# Key: temp_token (opaque URL-safe string, 32 bytes).
# Value: {hashed_otp, user_id, expires_at, attempts, last_sent_at, has_sent, user_payload, token_payload}
# ---------------------------------------------------------------------------
_otp_store: dict[str, dict] = {}
_latest_otps: list[dict] = []
_OTP_TTL_SECONDS = 300        # 5 minutes validity
_OTP_MAX_ATTEMPTS = 5         # wrong guesses before invalidation
_OTP_RESEND_COOLDOWN = 60     # seconds between resend requests

def _purge_expired_otps() -> None:
    now = datetime.utcnow()
    expired = [k for k, v in _otp_store.items() if v["expires_at"] < now]
    for k in expired:
        _otp_store.pop(k, None)

def _hash_otp(otp: str) -> str:
    return hashlib.sha256(otp.encode()).hexdigest()

def _mask_phone(phone: str) -> str:
    """Return e.g. '+263 ••• ••456' for display."""
    if not phone or len(phone) < 6:
        return "***"
    return f"+{phone[:3]} ••• ••{phone[-3:]}"

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
    access_token: Optional[str] = None
    token_type: Optional[str] = "bearer"
    user: Optional[dict] = None
    otp_required: Optional[bool] = False
    phone_required: Optional[bool] = False
    temp_token: Optional[str] = None
    phone_masked: Optional[str] = None
    message: Optional[str] = None

class VerifyOtpRequest(BaseModel):
    temp_token: str
    otp: str

class SendOtpRequest(BaseModel):
    temp_token: str
    phone: Optional[str] = None

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
    res = await db.execute(select(Tenant).where(Tenant.name == name))
    if res.scalars().first():
        raise HTTPException(status_code=400, detail="Company already exists")
    
    logo_url = None
    primary_color = "#2D5F6D"
    secondary_color = "#EF4835"

    if logo:
        current_file = Path(__file__).resolve()
        candidates = [
            current_file.parent.parent.parent.parent / "frontend",
            current_file.parent.parent.parent / "frontend",
            Path("/app/frontend"),
            Path("frontend")
        ]
        static_dir = None
        for path in candidates:
            if path.exists() and path.is_dir():
                static_dir = path
                break
        if not static_dir:
            static_dir = Path("static")
        static_dir.mkdir(exist_ok=True)
        filename = f"{name.lower().replace(' ', '_')}_logo.png"
        file_path = static_dir / filename
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(logo.file, buffer)
        primary_color, secondary_color = extract_brand_colors(file_path)
        logo_url = f"/static/{filename}"
    
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
    if not getattr(request.app.state, "db_ready", False):
        return []

    try:
        query = text("SELECT id, name, logo_url, primary_color, secondary_color, navbar_bg, navbar_text_color FROM tenants ORDER BY id ASC")
        result = await asyncio.wait_for(db.execute(query), timeout=5)
        tenants = result.mappings().all()
        
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
    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalars().first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Company not found")
    await db.delete(tenant)
    await db.commit()

_login_attempts: dict[str, list] = {}

def _login_key(request: Request, email: str) -> str:
    return email.strip().lower()

def _check_login_rate(key: str) -> None:
    rec = _login_attempts.get(key)
    if not rec:
        return
    fails, locked_until = rec
    if locked_until and datetime.utcnow() < locked_until:
        retry = int((locked_until - datetime.utcnow()).total_seconds()) + 1
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {retry} seconds.",
            headers={"Retry-After": str(retry)},
        )

def _record_login_failure(key: str) -> None:
    fails, _ = _login_attempts.get(key, [0, None])
    fails += 1
    locked_until = None
    if fails >= settings.LOGIN_MAX_ATTEMPTS:
        locked_until = datetime.utcnow() + timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
    _login_attempts[key] = [fails, locked_until]
    if len(_login_attempts) > 20000:
        cutoff = datetime.utcnow() - timedelta(hours=24)
        for k in [k for k, v in _login_attempts.items() if v[1] and v[1] < cutoff]:
            _login_attempts.pop(k, None)

def _build_full_token_payload(user: User) -> dict:
    return {
        "sub": user.email,
        "user_id": user.id,
        "tenant_id": user.tenant_id,
        "role": user.role,
        "is_admin": user.is_admin,
        "tv": user.token_version or 0
    }

def _build_user_response(user: User) -> dict:
    return {
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

@router.post("/login")
async def login(
    data: LoginRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db)
):
    """Login with email and password. Every user undergoes WhatsApp OTP verification."""
    if not getattr(request.app.state, "db_ready", False):
        raise HTTPException(status_code=503, detail="Database is initializing. Please try again in a few seconds.")

    rate_key = _login_key(request, data.email)
    _check_login_rate(rate_key)

    try:
        result = await asyncio.wait_for(
            db.execute(select(User).options(joinedload(User.tenant)).where(func.lower(User.email) == data.email.strip().lower())),
            timeout=10
        )
        user = result.scalars().first()

        if not user or not user.hashed_password or not verify_password(data.password, user.hashed_password):
            _record_login_failure(rate_key)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials"
            )

        if data.tenant_id and user.tenant_id != data.tenant_id:
            _record_login_failure(rate_key)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials"
            )

        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account disabled. Contact your administrator."
            )

        _login_attempts.pop(rate_key, None)

        user.last_login = datetime.utcnow()
        audit = AuditLog(
            user_id=user.id,
            action="LOGIN_ATTEMPT",
            details={"email": user.email},
            ip_address=request.client.host if request.client else None
        )
        db.add(audit)
        await db.commit()
    except HTTPException:
        raise
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Database connection timed out")
    except Exception as e:
        print(f"Login error: {e}")
        raise HTTPException(status_code=500, detail="An internal error occurred during login")

    # ------------------------------------------------------------------
    # WhatsApp OTP 2FA for EVERY sign-in
    # ------------------------------------------------------------------
    _purge_expired_otps()
    temp_token = secrets.token_urlsafe(32)
    phone = normalize_msisdn(user.phone)

    if phone:
        otp = f"{random.SystemRandom().randint(0, 999999):06d}"
        _otp_store[temp_token] = {
            "hashed_otp": _hash_otp(otp),
            "user_id": user.id,
            "expires_at": datetime.utcnow() + timedelta(seconds=_OTP_TTL_SECONDS),
            "attempts": 0,
            "last_sent_at": datetime.utcnow(),
            "has_sent": True,
            "token_payload": _build_full_token_payload(user),
            "user_payload": _build_user_response(user),
        }

        message = (
            f"🔐 *Inferth Mapping Security Code*\n\n"
            f"Your one-time sign-in code is: *{otp}*\n\n"
            f"⏱ This code expires in 5 minutes. Do not share it with anyone."
        )

        background_tasks.add_task(send_whatsapp, phone, message)
        print(f"[WhatsApp OTP] Dispatched to {phone}: {otp}")

        _latest_otps.append({
            "phone": _mask_phone(phone),
            "code": otp,
            "time": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        })
        if len(_latest_otps) > 10:
            _latest_otps.pop(0)

        return {
            "otp_required": True,
            "phone_required": False,
            "temp_token": temp_token,
            "phone_masked": _mask_phone(phone),
            "message": f"A 6-digit code has been sent to your WhatsApp number ({_mask_phone(phone)})."
        }
    else:
        # User has no phone on record yet — require WhatsApp phone registration
        _otp_store[temp_token] = {
            "hashed_otp": "",
            "user_id": user.id,
            "expires_at": datetime.utcnow() + timedelta(seconds=_OTP_TTL_SECONDS),
            "attempts": 0,
            "last_sent_at": datetime.utcnow() - timedelta(seconds=_OTP_RESEND_COOLDOWN + 10),
            "has_sent": False,
            "token_payload": _build_full_token_payload(user),
            "user_payload": _build_user_response(user),
        }

        return {
            "otp_required": True,
            "phone_required": True,
            "temp_token": temp_token,
            "phone_masked": "",
            "message": "Please enter your WhatsApp number to receive your login verification code."
        }


@router.post("/send-otp")
async def send_otp(data: SendOtpRequest, background_tasks: BackgroundTasks):
    """Send or re-send WhatsApp OTP. Supports linking/updating phone number."""
    _purge_expired_otps()

    record = _otp_store.get(data.temp_token)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session. Please log in again."
        )

    cooldown_remaining = (
        record["last_sent_at"] + timedelta(seconds=_OTP_RESEND_COOLDOWN) - datetime.utcnow()
    ).total_seconds()
    if cooldown_remaining > 0 and record.get("has_sent"):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Please wait {int(cooldown_remaining) + 1} seconds before requesting a new code."
        )

    from app.db import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.id == record["user_id"]))
        user = result.scalars().first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        if data.phone and str(data.phone).strip():
            norm_phone = normalize_msisdn(data.phone)
            if not norm_phone:
                raise HTTPException(status_code=400, detail="Invalid WhatsApp phone number. Please use format like 0771234567 or +263771234567")
            user.phone = norm_phone
            await db.commit()
            phone = norm_phone
        else:
            phone = normalize_msisdn(user.phone)

    if not phone:
        raise HTTPException(status_code=400, detail="Please enter your WhatsApp phone number.")

    otp = f"{random.SystemRandom().randint(0, 999999):06d}"
    record["hashed_otp"] = _hash_otp(otp)
    record["expires_at"] = datetime.utcnow() + timedelta(seconds=_OTP_TTL_SECONDS)
    record["attempts"] = 0
    record["last_sent_at"] = datetime.utcnow()
    record["has_sent"] = True

    message = (
        f"🔐 *Inferth Mapping Security Code*\n\n"
        f"Your one-time login code is: *{otp}*\n\n"
        f"⏱ This code expires in 5 minutes. Do not share it with anyone."
    )

    background_tasks.add_task(send_whatsapp, phone, message)
    print(f"[WhatsApp OTP] Sent to {phone}: {otp}")

    _latest_otps.append({
        "phone": _mask_phone(phone),
        "code": otp,
        "time": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
    })
    if len(_latest_otps) > 10:
        _latest_otps.pop(0)

    return {
        "status": "success",
        "phone_masked": _mask_phone(phone),
        "message": f"Verification code sent to WhatsApp ({_mask_phone(phone)})"
    }


@router.post("/resend-otp")
async def resend_otp(data: SendOtpRequest, background_tasks: BackgroundTasks):
    return await send_otp(data, background_tasks)


@router.post("/verify-otp")
async def verify_otp(data: VerifyOtpRequest):
    """Validate WhatsApp OTP and issue real JWT token."""
    _purge_expired_otps()

    record = _otp_store.get(data.temp_token)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session. Please log in again."
        )

    if datetime.utcnow() > record["expires_at"]:
        _otp_store.pop(data.temp_token, None)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="OTP has expired. Please log in again."
        )

    record["attempts"] += 1
    if record["attempts"] > _OTP_MAX_ATTEMPTS:
        _otp_store.pop(data.temp_token, None)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many incorrect attempts. Please log in again."
        )

    if not record.get("hashed_otp") or _hash_otp(data.otp.strip()) != record["hashed_otp"]:
        remaining = _OTP_MAX_ATTEMPTS - record["attempts"]
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Incorrect OTP. {max(remaining, 0)} attempt(s) remaining."
        )

    # Approved! Issue real token
    _otp_store.pop(data.temp_token, None)
    token = create_access_token(record["token_payload"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": record["user_payload"]
    }


@router.post("/setup-account")
async def setup_account(data: SetupAccountRequest, db: AsyncSession = Depends(get_db)):
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

    expires = user.setup_token_expires
    if expires is not None:
        if expires.tzinfo is None:
            from datetime import timezone
            expires = expires.replace(tzinfo=timezone.utc)
        if datetime.utcnow().replace(tzinfo=expires.tzinfo) > expires:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Invalid or expired setup token"
            )

    user.hashed_password = hash_password(data.password)
    user.is_active = True
    user.setup_token = None
    user.setup_token_expires = None
    user.token_version = (user.token_version or 0) + 1

    await db.commit()
    await db.refresh(user)

    token = create_access_token({
        "sub": user.email,
        "user_id": user.id,
        "tenant_id": user.tenant_id,
        "is_admin": user.is_admin,
        "tv": user.token_version or 0
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


@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "email": current_user.email,
        "role": current_user.role,
        "is_admin": current_user.is_admin,
        "tenant_id": current_user.tenant_id,
        "company_name": current_user.tenant.name if current_user.tenant else "Inferth Mapping",
        "theme": resolve_tenant_theme(current_user.tenant),
        "accessible_assets": current_user.accessible_assets or ["*"],
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
    result = await db.execute(select(User).where(User.setup_token == token))
    user = result.scalars().first()

    expired = False
    if user and user.setup_token_expires is not None:
        exp = user.setup_token_expires
        if exp.tzinfo is None:
            from datetime import timezone
            exp = exp.replace(tzinfo=timezone.utc)
        expired = datetime.utcnow().replace(tzinfo=exp.tzinfo) > exp

    if not user or user.is_active or expired:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired setup token"
        )

    return {
        "email": user.email,
        "valid": True
    }


@router.get("/latest-otp")
async def get_latest_otp():
    """Diagnostic endpoint to inspect recent dispatched OTP codes."""
    return {"latest_codes": _latest_otps[-5:]}


_last_warm_gateway_ts: float = 0.0
_cached_warm_gateway_result: dict = {"status": "ready"}

@router.get("/warm-gateway")
async def warm_gateway():
    """Background pre-warm triggered whenever the login page opens.
    Cached for 180 seconds to avoid tripping Evolution API rate limits.
    """
    global _last_warm_gateway_ts, _cached_warm_gateway_result
    import time
    now = time.time()
    if (now - _last_warm_gateway_ts) < 180.0:
        return _cached_warm_gateway_result

    from app.services.whatsapp import get_active_evolution_session, trigger_evolution_redeploy
    import httpx
    if not (settings.WHATSAPP_ENABLED and settings.WHATSAPP_API_URL):
        return {"status": "disabled"}

    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base
    headers = {"apikey": settings.WHATSAPP_API_KEY or ""}

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            sess = await get_active_evolution_session(client, base, headers)
            # Query instance connection state
            r = await client.get(f"{base}/instance/connectionState/{sess}", headers=headers)
            _last_warm_gateway_ts = now
            if r.status_code == 200:
                data = r.json()
                state = (data.get("instance") or {}).get("state") or data.get("state")
                if state == "close":
                    print(f"[WarmGateway] State is 'close' on {sess} — auto-rebooting container before user signs in...")
                    reboot_res = await trigger_evolution_redeploy()
                    _cached_warm_gateway_result = {"status": "rebooting", "session": sess, "result": reboot_res}
                    return _cached_warm_gateway_result
                _cached_warm_gateway_result = {"status": "ready", "session": sess, "state": state}
                return _cached_warm_gateway_result
            elif r.status_code == 429:
                print(f"[WarmGateway] Rate limited by Evolution API — pausing checks for 180s")
                _cached_warm_gateway_result = {"status": "rate_limited"}
                return _cached_warm_gateway_result
            elif r.status_code in (500, 502, 503):
                print(f"[WarmGateway] Gateway error {r.status_code} — auto-rebooting container...")
                reboot_res = await trigger_evolution_redeploy()
                _cached_warm_gateway_result = {"status": "rebooting", "session": sess, "result": reboot_res}
                return _cached_warm_gateway_result
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


