import logging
import re
import httpx
from app.config import settings

logger = logging.getLogger(__name__)

# Last dispatch log for /version diagnostic
last_send_log: dict = {}

# Dynamic instance routing cache
_active_session_name: str | None = None
_last_session_check: float = 0.0
_last_redeploy_trigger: float = 0.0


async def trigger_evolution_redeploy() -> dict:
    """Trigger a Railway container restart/redeploy for the Evolution API service.
    Supports either Railway GraphQL API Token or Webhook URL.
    """
    global _last_redeploy_trigger
    import time, os
    now = time.time()
    if (now - _last_redeploy_trigger) < 90.0:
        return {"status": "debounced", "message": f"Redeploy already triggered {int(now - _last_redeploy_trigger)}s ago"}

    _last_redeploy_trigger = now

    # Strategy 1: Railway Official GraphQL API
    token = (settings.RAILWAY_TOKEN or settings.RAILWAY_API_TOKEN or os.environ.get("RAILWAY_TOKEN") or os.environ.get("RAILWAY_API_TOKEN") or "").strip()
    if token:
        env_id = os.environ.get("RAILWAY_ENVIRONMENT_ID") or "production"
        svc_id = settings.RAILWAY_EVOLUTION_SERVICE_ID
        gql_url = "https://backboard.railway.app/graphql/v2"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                # 1. Discover exact environment UUID if not set in os.environ
                resolved_env = os.environ.get("RAILWAY_ENVIRONMENT_ID")
                if not resolved_env or resolved_env == "production":
                    q_proj = {"query": "query { project { id environments { edges { node { id name } } } } }"}
                    r_p = await client.post(gql_url, headers=headers, json=q_proj)
                    data_p = r_p.json()
                    edges = (((data_p.get("data") or {}).get("project") or {}).get("environments") or {}).get("edges") or []
                    for e in edges:
                        node = e.get("node") or {}
                        if node.get("name") in ("production", "prod") or not resolved_env:
                            resolved_env = node.get("id")
                            if node.get("name") in ("production", "prod"):
                                break

                # Try deploymentRestart on latest active deployment first (Project Tokens typically have permission for this)
                q_dep = {
                    "query": """query getLatestDeployment($serviceId: String!, $environmentId: String!) {
                        deployments(input: { serviceId: $serviceId, environmentId: $environmentId }) {
                            edges { node { id status } }
                        }
                    }""",
                    "variables": {"serviceId": svc_id, "environmentId": resolved_env}
                }
                r_dep = await client.post(gql_url, headers=headers, json=q_dep)
                dep_data = r_dep.json()
                dep_edges = (((dep_data.get("data") or {}).get("deployments") or {}).get("edges") or [])
                latest_dep_id = None
                for de in dep_edges:
                    node = de.get("node") or {}
                    if node.get("status") in ("SUCCESS", "INITIALIZING"):
                        latest_dep_id = node.get("id")
                        break
                if not latest_dep_id and dep_edges:
                    latest_dep_id = dep_edges[0].get("node", {}).get("id")

                if latest_dep_id:
                    payload = {
                        "query": "mutation restartDep($id: String!) { deploymentRestart(id: $id) }",
                        "variables": {"id": latest_dep_id}
                    }
                else:
                    payload = {
                        "query": "mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }",
                        "variables": {"environmentId": resolved_env or env_id, "serviceId": svc_id}
                    }
                r = await client.post(gql_url, headers=headers, json=payload)
                print(f"[WhatsApp AUTO-HEAL] Triggered Evolution restart via Railway GraphQL! Status: {r.status_code}, Body: {r.text[:200]}")
                return {"status": "success", "method": "railway_api", "http_code": r.status_code, "response": r.json() if r.status_code == 200 else r.text[:200], "resolved_env": resolved_env}
        except Exception as e:
            print(f"[WhatsApp AUTO-HEAL] Railway GraphQL error: {e}")
            return {"status": "error", "method": "railway_api", "error": str(e)}

    # Strategy 2: Webhook URL fallback
    webhook_url = (settings.EVOLUTION_REDEPLOY_WEBHOOK_URL or "").strip()
    if webhook_url:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(webhook_url)
                print(f"[WhatsApp AUTO-HEAL] Triggered Evolution restart via Webhook! Status: {r.status_code}")
                return {"status": "success", "method": "webhook", "http_code": r.status_code, "response": r.text[:200]}
        except Exception as e:
            print(f"[WhatsApp AUTO-HEAL] Webhook error: {e}")
            return {"status": "error", "method": "webhook", "error": str(e)}

    return {
        "status": "unconfigured",
        "message": "Set RAILWAY_API_TOKEN in backend Variables to enable 100% automated container reboots."
    }


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


async def get_active_evolution_session(client: httpx.AsyncClient, base: str, headers: dict) -> str:
    """Auto-detect which Evolution API instance is currently open and healthy.
    Falls back to settings.WHATSAPP_SESSION if no alternative open instance exists.
    """
    global _active_session_name, _last_session_check
    import time
    now = time.time()
    if _active_session_name and (now - _last_session_check) < 45.0:
        return _active_session_name

    default_session = settings.WHATSAPP_SESSION

    # 1. Check if the default session is healthy and open
    try:
        r = await client.get(f"{base}/instance/connectionState/{default_session}", headers=headers)
        if r.status_code == 200:
            data = r.json()
            state = (data.get("instance") or {}).get("state") or data.get("state")
            if state == "open":
                _active_session_name = default_session
                _last_session_check = now
                return default_session
    except Exception:
        pass

    # 2. If default session is closed or failing, inspect all instances in Evolution API
    try:
        r_all = await client.get(f"{base}/instance/fetchInstances", headers=headers)
        if r_all.status_code == 200:
            instances = r_all.json()
            if isinstance(instances, list):
                for inst in instances:
                    if inst.get("connectionStatus") == "open":
                        found_name = inst.get("name")
                        if found_name:
                            print(f"[WhatsApp] Active open instance detected: {found_name}")
                            _active_session_name = found_name
                            _last_session_check = now
                            return found_name
    except Exception as e:
        print(f"[WhatsApp] Instance discovery error: {e}")

    _active_session_name = default_session
    _last_session_check = now
    return default_session


async def send_whatsapp(msisdn: str, text: str) -> bool:
    """Send a plain-text WhatsApp message. Never raises."""
    global last_send_log, _active_session_name
    if not settings.WHATSAPP_ENABLED:
        logger.info("WhatsApp disabled; not sending to %s", msisdn)
        return False
    if not settings.WHATSAPP_API_URL:
        logger.warning("WHATSAPP_API_URL unset; cannot send to %s", msisdn)
        return False

    base = settings.WHATSAPP_API_URL.strip().rstrip("/")
    if "://" not in base:
        base = "https://" + base

    try:
        import asyncio
        async with httpx.AsyncClient(timeout=25.0) as client:
            headers = {"apikey": settings.WHATSAPP_API_KEY or ""}

            if settings.WHATSAPP_PROVIDER == "waha":
                url = f"{base}/api/sendText"
                headers_waha = {"X-Api-Key": settings.WHATSAPP_API_KEY or ""}
                payload = {
                    "chatId": f"{msisdn}@c.us",
                    "text": text,
                    "session": settings.WHATSAPP_SESSION,
                }
                for attempt in range(1, 4):
                    resp = await client.post(url, json=payload, headers=headers_waha)
                    if 200 <= resp.status_code < 300:
                        return True
                    await asyncio.sleep(2.0)
                return False

            # Evolution API provider
            for attempt in range(1, 4):
                # Dynamically determine the best session (handles instance migration e.g. inferth2)
                session = await get_active_evolution_session(client, base, headers)
                url = f"{base}/message/sendText/{session}"
                payload = {"number": msisdn, "text": text}

                try:
                    resp = await client.post(url, json=payload, headers=headers)
                    if 200 <= resp.status_code < 300:
                        print(f"[WhatsApp SUCCESS] Message dispatched to {msisdn} via {session} (attempt {attempt})")
                        last_send_log = {
                            "status": "success",
                            "session": session,
                            "msisdn": msisdn[-6:],
                            "http_code": resp.status_code,
                            "response": resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text[:200]
                        }
                        return True

                    resp_text = resp.text
                    print(f"[WhatsApp FAILED] Session '{session}' attempt {attempt} Status: {resp.status_code}, Response: {resp_text[:300]}")
                    last_send_log = {
                        "status": "failed",
                        "session": session,
                        "attempt": attempt,
                        "msisdn": msisdn[-6:],
                        "http_code": resp.status_code,
                        "response": resp_text[:300]
                    }

                    # If Connection Closed, clear session cache so it looks for another active instance
                    if "Connection Closed" in resp_text or resp.status_code in (500, 502, 503):
                        _active_session_name = None
                        print(f"[WhatsApp RECONNECT] Baileys socket closed on '{session}'; triggering auto-heal...")
                        await trigger_evolution_redeploy()
                        try:
                            await client.get(f"{base}/instance/connect/{session}", headers=headers)
                        except Exception:
                            pass
                        await asyncio.sleep(4.0)
                    else:
                        await asyncio.sleep(2.0)

                except Exception as req_err:
                    print(f"[WhatsApp EXCEPTION] Attempt {attempt} error: {req_err}")
                    _active_session_name = None
                    last_send_log = {
                        "status": "exception",
                        "attempt": attempt,
                        "msisdn": msisdn[-6:],
                        "error": str(req_err)
                    }
                    await asyncio.sleep(2.0)

    except Exception as e:
        logger.exception("Unexpected error in send_whatsapp: %s", e)

    return False


async def send_invite_whatsapp(msisdn: str, setup_token: str, tenant_name: str | None = None) -> bool:
    """Send user onboarding invite with setup link via WhatsApp."""
    base_url = settings.APP_BASE_URL.rstrip("/")
    link = f"{base_url}/static/login.html?token={setup_token}#set-password"
    company = tenant_name or "Inferth Mapping"

    text = (
        f"Welcome to {company}!\n\n"
        f"Your fleet tracking account is ready. Click the link below to set your password and access the platform:\n\n"
        f"{link}\n\n"
        f"This link expires in {settings.SETUP_TOKEN_EXPIRE_HOURS} hours. "
        f"If you did not expect this message, please ignore it."
    )
    return await send_whatsapp(msisdn, text)
