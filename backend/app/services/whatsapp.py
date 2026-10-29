"""WhatsApp invite/notification sender.

Speaks REST to a self-hosted open-source gateway:
- Evolution API (Baileys, https://github.com/EvolutionAPI/evolution-api)
- WAHA (https://github.com/devlikeapro/whatsapp-http-api)

Both expose "send text" endpoints; the payload shapes differ, so the
provider is selected via settings.WHATSAPP_PROVIDER.
"""
import logging
import re

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


def normalize_msisdn(raw: str | None) -> str | None:
    """Normalize a phone number to digits-only E.164-ish form.

    Handles Zimbabwe local format: 0772123456 / +263772123456 -> 263772123456.
    Returns None when the input doesn't look like a real number.
    """
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    # Zimbabwe local: leading 0 -> country code 263
    if digits.startswith("0") and len(digits) == 10:
        digits = "263" + digits[1:]
    if digits.startswith("00"):
        digits = digits[2:]
    if not (9 <= len(digits) <= 15):
        return None
    return digits


async def send_whatsapp(msisdn: str, text: str) -> bool:
    """Send a plain-text WhatsApp message. Never raises."""
    if not settings.WHATSAPP_ENABLED:
        logger.info("WhatsApp disabled; not sending to %s", msisdn)
        return False
    if not settings.WHATSAPP_API_URL:
        logger.warning("WHATSAPP_API_URL unset; cannot send to %s", msisdn)
        return False

    base = settings.WHATSAPP_API_URL.rstrip("/")
    try:
        if settings.WHATSAPP_PROVIDER == "waha":
            # WAHA: POST /api/sendText {chatId: "<msisdn>@c.us", text, session}
            url = f"{base}/api/sendText"
            headers = {"X-Api-Key": settings.WHATSAPP_API_KEY or ""}
            payload = {
                "chatId": f"{msisdn}@c.us",
                "text": text,
                "session": settings.WHATSAPP_SESSION,
            }
        else:
            # Evolution API v2: POST /message/sendText/{instance}
            url = f"{base}/message/sendText/{settings.WHATSAPP_SESSION}"
            headers = {"apikey": settings.WHATSAPP_API_KEY or ""}
            payload = {"number": msisdn, "text": text}

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if 200 <= resp.status_code < 300:
            logger.info("WhatsApp sent to %s via %s", msisdn, settings.WHATSAPP_PROVIDER)
            return True
        logger.error("WhatsApp send failed %s: %s", resp.status_code, resp.text[:300])
        return False
    except Exception as e:  # network/config — never break the request
        logger.error("WhatsApp send exception to %s: %s", msisdn, e)
        return False


async def send_invite_whatsapp(phone: str, role: str, link: str) -> bool:
    msisdn = normalize_msisdn(phone)
    if not msisdn:
        logger.warning("Invite phone %r not a valid number; skipping WhatsApp", phone)
        return False
    text = (
        "Welcome to Inferth Mapping!\n\n"
        f"You've been invited to join the platform as a *{role}*.\n"
        "Tap the link below to set your password and activate your account "
        "(link expires in "
        f"{settings.SETUP_TOKEN_EXPIRE_HOURS}h):\n\n{link}"
    )
    return await send_whatsapp(msisdn, text)
