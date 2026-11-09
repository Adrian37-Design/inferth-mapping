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

last_send_log: dict = {"status": "none", "detail": "No send attempted yet"}


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

    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:  # bare host -> assume https so httpx accepts it
        base = "https://" + base
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

        # Attempt send with auto-reconnect on "Connection Closed" socket drop
        import asyncio
        global last_send_log
        for attempt in range(1, 4):
            try:
                async with httpx.AsyncClient(timeout=25.0) as client:
                    resp = await client.post(url, json=payload, headers=headers)
                if 200 <= resp.status_code < 300:
                    print(f"[WhatsApp SUCCESS] Message dispatched to {msisdn} via {settings.WHATSAPP_PROVIDER}")
                    logger.info("WhatsApp sent to %s via %s (attempt %d)", msisdn, settings.WHATSAPP_PROVIDER, attempt)
                    last_send_log = {
                        "status": "success",
                        "msisdn": msisdn[-6:],
                        "http_code": resp.status_code,
                        "response": resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text[:200]
                    }
                    return True
                
                resp_text = resp.text
                print(f"[WhatsApp FAILED] Attempt {attempt} Status: {resp.status_code}, Response: {resp_text[:300]}")
                logger.warning("WhatsApp send attempt %d failed %s: %s", attempt, resp.status_code, resp_text[:200])
                last_send_log = {
                    "status": "failed",
                    "attempt": attempt,
                    "msisdn": msisdn[-6:],
                    "http_code": resp.status_code,
                    "response": resp_text[:300]
                }

                # If WhatsApp socket dropped ("Connection Closed"), trigger reconnect on Evolution API
                if settings.WHATSAPP_PROVIDER == "evolution" and ("Connection Closed" in resp_text or resp.status_code in (500, 502, 503)):
                    print(f"[WhatsApp RECONNECT] Socket connection was closed; triggering restart for instance {settings.WHATSAPP_SESSION}...")
                    try:
                        async with httpx.AsyncClient(timeout=15.0) as client:
                            # Evolution API restart endpoint re-initializes the Baileys WebSocket
                            await client.post(f"{base}/instance/restart/{settings.WHATSAPP_SESSION}", headers=headers)
                    except Exception as rec_err:
                        print(f"[WhatsApp RECONNECT ERROR] {rec_err}")
                    # Wait 6 seconds for Baileys WebSocket to finish handshaking with WhatsApp
                    await asyncio.sleep(6.0)
                else:
                    await asyncio.sleep(2.0)

            except Exception as req_err:
                print(f"[WhatsApp EXCEPTION] Network error on attempt {attempt}: {req_err}")
                logger.warning("WhatsApp send attempt %d network exception: %s", attempt, req_err)
                last_send_log = {
                    "status": "exception",
                    "attempt": attempt,
                    "msisdn": msisdn[-6:],
                    "error": str(req_err)
                }
                await asyncio.sleep(2.0)

        logger.error("WhatsApp send failed for %s after retries", msisdn)
        return False
    except Exception as e:  # config or unexpected
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
