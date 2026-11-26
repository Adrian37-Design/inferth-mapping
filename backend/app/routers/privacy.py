"""Privacy requests: data deletion, email preferences and the opt-out page.

These endpoints exist so a person can exercise a privacy right without needing
an account in the console, while still being verifiable and abuse-resistant.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from typing import Optional

import html as html_lib

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_middleware import require_super_admin
from app.db import get_db
from app.models import PrivacyRequest, User
from app.services.consent import valid_token

router = APIRouter(prefix="/privacy", tags=["privacy"])

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
PRIVACY_EMAIL = "sales@inferth.com"
VALID_SCOPES = ("account", "telemetry", "user")

_PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Inferth Mapping</title>
<link rel="stylesheet" href="/static/policy.css"></head>
<body class="policy-page">
<main class="policy-main" id="main"><article class="policy-card">
<p class="policy-eyebrow">Privacy</p><h1>{title}</h1>{body}
</article></main>
</body></html>"""


class DeletionRequestPayload(BaseModel):
    email: str = Field(..., max_length=255)
    full_name: str = Field(..., min_length=2, max_length=120)
    company: Optional[str] = Field(None, max_length=160)
    scope: str = Field("account", max_length=20)
    reason: Optional[str] = Field(None, max_length=1000)
    authority_confirmed: bool = False


@router.post("/data-deletion")
async def request_data_deletion(
    payload: DeletionRequestPayload,
    db: AsyncSession = Depends(get_db),
):
    """File a verifiable deletion request; one open request per address per day."""
    email = (payload.email or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if not payload.authority_confirmed:
        raise HTTPException(
            status_code=400,
            detail="Confirm that you are authorised to request this deletion.",
        )
    if payload.scope not in VALID_SCOPES:
        raise HTTPException(status_code=400, detail="Choose what should be deleted.")

    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)
    existing = (
        await db.execute(
            select(PrivacyRequest)
            .where(
                PrivacyRequest.email == email,
                PrivacyRequest.status == "pending",
                PrivacyRequest.created_at >= since,
            )
            .order_by(PrivacyRequest.id.desc())
            .limit(1)
        )
    ).scalars().first()
    if existing:
        return {
            "status": "received",
            "reference": existing.reference,
            "duplicate": True,
            "message": "A request from this address is already being handled.",
        }

    record = PrivacyRequest(
        reference=f"PD-{uuid.uuid4().hex[:8].upper()}",
        email=email,
        full_name=payload.full_name.strip(),
        company=(payload.company or "").strip() or None,
        request_type="deletion",
        scope=payload.scope,
        reason=(payload.reason or "").strip() or None,
        status="pending",
        source="web",
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)

    # Notify the data-protection inbox. Never block the request on email delivery.
    try:
        from app.services.email import send_email

        send_email(
            PRIVACY_EMAIL,
            f"Data deletion request {record.reference}",
            (
                "<p>A data deletion request was submitted through the website.</p>"
                f"<p><strong>Reference:</strong> {record.reference}<br>"
                f"<strong>Email:</strong> {record.email}<br>"
                f"<strong>Name:</strong> {record.full_name}<br>"
                f"<strong>Company:</strong> {record.company or '—'}<br>"
                f"<strong>Scope:</strong> {record.scope}<br>"
                f"<strong>Reason:</strong> {record.reason or '—'}</p>"
                "<p>Verify the request with the account contact before deleting anything.</p>"
            ),
        )
    except Exception as exc:
        print(f"[privacy] deletion notification skipped: {exc}")

    return {
        "status": "received",
        "reference": record.reference,
        "duplicate": False,
        "message": "We will confirm the request with the account email before deleting anything.",
    }


@router.get("/requests")
async def list_privacy_requests(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_super_admin),
):
    """Platform administrator: the queue of privacy requests."""
    rows = (
        await db.execute(
            select(PrivacyRequest).order_by(PrivacyRequest.created_at.desc()).limit(200)
        )
    ).scalars().all()
    return [
        {
            "id": row.id,
            "reference": row.reference,
            "email": row.email,
            "full_name": row.full_name,
            "company": row.company,
            "type": row.request_type,
            "scope": row.scope,
            "reason": row.reason,
            "status": row.status,
            "source": row.source,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "completed_at": row.completed_at.isoformat() if row.completed_at else None,
        }
        for row in rows
    ]


@router.get("/unsubscribe", response_class=HTMLResponse)
async def unsubscribe_page(
    email: str = Query(""),
    token: str = Query(""),
    db: AsyncSession = Depends(get_db),
):
    """Confirmation page, so a link in an email is never acted on by a scanner."""
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email) or not valid_token(email, token):
        return HTMLResponse(
            _PAGE.format(
                title="That link is not valid",
                body=(
                    "<p>The unsubscribe link is incomplete or has expired.</p>"
                    "<p>Email <a href=\"mailto:sales@inferth.com\">sales@inferth.com</a> and we will "
                    "update your preference for you.</p>"
                ),
            ),
            status_code=400,
        )

    user = (
        await db.execute(select(User).where(User.email.ilike(email)))
    ).scalars().first()
    state = "already opted out" if user and user.marketing_opt_out else "still subscribed"

    safe_email = html_lib.escape(email, quote=True)
    safe_token = html_lib.escape(token, quote=True)

    body = (
        f"<p>We have an account for <strong>{safe_email}</strong> ({state}).</p>"
        "<p>Confirm below to stop optional product email. Account, billing and security messages "
        "will still be sent, because they are part of the service.</p>"
        '<form method="post" action="/privacy/unsubscribe" class="policy-form">'
        f'<input type="hidden" name="email" value="{safe_email}">'
        f'<input type="hidden" name="token" value="{safe_token}">'
        '<button type="submit">Unsubscribe from optional email</button></form>'
        '<p style="margin-top:14px;"><a href="/static/privacy.html">Privacy policy</a></p>'
    )
    return HTMLResponse(_PAGE.format(title="Email preferences", body=body))


@router.post("/unsubscribe", response_class=HTMLResponse)
async def unsubscribe(
    request: Request,
    email: str = Query(""),
    token: str = Query(""),
    db: AsyncSession = Depends(get_db),
):
    # The confirmation page posts a form body; accept the link's query too.
    if not email or not token:
        form = await request.form()
        email = str(form.get("email") or email)
        token = str(form.get("token") or token)
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email) or not valid_token(email, token):
        raise HTTPException(status_code=400, detail="Invalid unsubscribe link")

    user = (
        await db.execute(select(User).where(User.email.ilike(email)))
    ).scalars().first()
    if user:
        user.marketing_opt_out = True
        await db.commit()

    return HTMLResponse(
        _PAGE.format(
            title="You are unsubscribed",
            body=(
                "<p>Optional product email to this address has been stopped.</p>"
                "<p>You will still receive invitations, sign-in codes, receipts and security notices "
                "while the account is active.</p>"
                '<p><a href="/static/terms.html">Terms</a> · '
                '<a href="/static/privacy.html">Privacy policy</a></p>'
            ),
        )
    )
