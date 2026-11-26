"""Email preferences: unsubscribe links and the footer every email carries.

Transactional mail (invitations, sign-in codes, receipts, security notices) is
part of the service; the preference stored here stops optional product email.
The link is signed so it cannot be used to unsubscribe someone else.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from urllib.parse import quote

from app.config import settings

PUBLIC_BASE_URL = (
    os.getenv("PUBLIC_BASE_URL")
    or os.getenv("APP_BASE_URL")
    or "https://inferth-mapping.up.railway.app"
).rstrip("/")


def _secret() -> bytes:
    return (settings.JWT_SECRET or "inferth-email-preferences").encode("utf-8")


def unsubscribe_token(email: str) -> str:
    return hmac.new(_secret(), email.strip().lower().encode("utf-8"), hashlib.sha256).hexdigest()[:40]


def valid_token(email: str, token: str) -> bool:
    if not email or not token:
        return False
    return hmac.compare_digest(unsubscribe_token(email), token.strip())


def unsubscribe_url(email: str) -> str:
    address = (email or "").strip()
    return (
        f"{PUBLIC_BASE_URL}/privacy/unsubscribe"
        f"?email={quote(address)}&token={unsubscribe_token(address)}"
    )


def with_unsubscribe_footer(html: str, email: str) -> tuple[str, str]:
    """(html with a visible opt-out link, that link)."""
    url = unsubscribe_url(email)
    footer = (
        '<div style="margin-top:28px;padding-top:14px;border-top:1px solid #e2e8f0;'
        "font-size:12px;line-height:1.5;color:#64748b;font-family:Arial,sans-serif;\">"
        "<p style=\"margin:0 0 6px;\">You received this message because this address is on an "
        "Inferth Mapping account.</p>"
        "<p style=\"margin:0;\">Do not want product updates? "
        f'<a href="{url}" style="color:#c2410c;">Unsubscribe from optional email</a>. '
        "Account, billing and security messages will still be sent.</p>"
        "<p style=\"margin:6px 0 0;\">Inferth Mapping · Inferth Projects · Harare, Zimbabwe · "
        '<a href="https://inferth-mapping.up.railway.app/static/privacy.html" '
        'style="color:#c2410c;">Privacy policy</a></p>'
        "</div>"
    )
    return f"{html}{footer}", url
