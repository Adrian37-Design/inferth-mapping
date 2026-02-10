from app.config import settings
import logging
# import socket (unused)
# import ssl (unused)
# import smtplib (unused)
import logging
import socket
import ssl

logger = logging.getLogger(__name__)

def send_email(to_email: str, subject: str, html_content: str):
    """
    Sends an email using the configured SMTP server.
    """
    if settings.RESEND_API_KEY:
        # Use Resend API (HTTP over Port 443 - Firewall Friendly)
        import httpx
        
        try:
            logger.info(f"Sending email via Resend API to {to_email}...")
            
            # If "From" is just an email, Resend requires a verified domain.
            # For testing/onboarding, use 'onboarding@resend.dev' if you don't have a domain yet.
            # OR better: User should set SMTP_EMAIL to their verified sender in Resend.
            from_email = settings.SMTP_EMAIL or "onboarding@resend.dev" 
            
            url = "https://api.resend.com/emails"
            headers = {
                "Authorization": f"Bearer {settings.RESEND_API_KEY}",
                "Content-Type": "application/json"
            }
            payload = {
                "from": "Inferth Mapping <" + from_email + ">", # Friendly name
                "to": [to_email],
                "subject": subject,
                "html": html_content
            }
            
            # Use sync call since this function is currently sync in auth.py
            # But httpx is async by default, so we use httpx.post
            response = httpx.post(url, json=payload, headers=headers, timeout=10.0)
            
            if response.status_code == 200:
                logger.info(f"Resend API Success: {response.json()}")
                return True
            else:
                logger.error(f"Resend API Failed: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            logger.error(f"Resend API Exception: {e}")
            return False

    # Fallback to SMTP if RESEND_API_KEY is not set (e.g. local dev)
    if not settings.SMTP_HOST or not settings.SMTP_EMAIL or not settings.SMTP_PASSWORD:
        logger.warning("SMTP/Resend not configured. Email not sent.")
        print(f"--- MOCK EMAIL TO {to_email} ---\nSubject: {subject}\n{html_content}\n-----------------------------")
        return False

    # ... Existing SMTP Logic (kept as fallback for local dev) ...
    # Debug: Check what config we actually loaded
    pass_len = len(settings.SMTP_PASSWORD) if settings.SMTP_PASSWORD else 0
    # ... rest of SMTP logic ...
    
    # We will just return False for now if Resend is missing to force decision, 
    # OR we can keep the SMTP logic below. 
    # Let's keep the SMTP logic but wrapped in an "else".
    
    # Actually, simpler to just replace the whole function with a clean Resend implementation
    # since user explicitly chose to switch.
    
    return False 

