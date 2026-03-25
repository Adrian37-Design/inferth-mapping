from app.config import settings
import httpx
import logging

logger = logging.getLogger(__name__)

class SMSService:
    @staticmethod
    async def send_sms_async(to: str, message: str):
        """
        Entry point for sending SMS via configured provider.
        """
        if settings.SMS_PROVIDER == "mock":
            logger.info(f"MOCK SMS TO {to}: {message}")
            print(f"\n--- MOCK SMS TO {to} ---\n{message}\n-----------------------\n")
            return True
            
        elif settings.SMS_PROVIDER == "infobip":
            return await SMSService._send_infobip(to, message)
            
        elif settings.SMS_PROVIDER == "twilio":
            return await SMSService._send_twilio(to, message)
            
        else:
            logger.warning(f"Unknown SMS provider or not configured: {settings.SMS_PROVIDER}")
            return False

    @staticmethod
    async def _send_infobip(to: str, message: str):
        """
        Sends SMS via Infobip HTTP API.
        """
        if not settings.SMS_API_KEY or not settings.SMS_API_BASE_URL:
            logger.error("Infobip API Key or Base URL missing in config.")
            return False
            
        # Standardize Base URL (ensure no https:// prefix for concatenation if stored as host only)
        base_url = settings.SMS_API_BASE_URL.replace("https://", "").replace("http://", "").rstrip("/")
        url = f"https://{base_url}/sms/2/text/advanced"
        
        headers = {
            "Authorization": f"App {settings.SMS_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        
        payload = {
            "messages": [
                {
                    "from": settings.SMS_SENDER,
                    "destinations": [{"to": to}],
                    "text": message
                }
            ]
        }
        
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=payload, headers=headers, timeout=10.0)
                if resp.status_code in [200, 201]:
                    logger.info(f"Infobip SMS successfully queued for {to}")
                    return True
                else:
                    logger.error(f"Infobip request failed: {resp.status_code} - {resp.text}")
                    return False
        except Exception as e:
            logger.error(f"Exception during Infobip SMS send: {e}")
            return False

    @staticmethod
    async def _send_twilio(to: str, message: str):
        """
        Sends SMS via Twilio REST API using httpx (avoiding heavy twilio-python SDK).
        """
        if not settings.TWILIO_ACCOUNT_SID or not settings.TWILIO_AUTH_TOKEN:
            logger.error("Twilio SID or Token missing.")
            return False

        sid = settings.TWILIO_ACCOUNT_SID
        token = settings.TWILIO_AUTH_TOKEN
        from_num = settings.TWILIO_FROM_NUMBER or settings.SMS_SENDER
        
        url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
        
        # Twilio uses Form Data
        data = {
            "To": to,
            "From": from_num,
            "Body": message
        }
        
        try:
            # Twilio uses Basic Auth (SID:Token)
            auth = (sid, token)
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, data=data, auth=auth, timeout=10.0)
                if resp.status_code in [200, 201]:
                    logger.info(f"Twilio SMS sent to {to}")
                    return True
                else:
                    logger.error(f"Twilio failed: {resp.status_code} - {resp.text}")
                    return False
        except Exception as e:
            logger.error(f"Twilio error: {e}")
            return False
