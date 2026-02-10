import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from app.config import settings
import logging
import socket
import ssl

logger = logging.getLogger(__name__)

def send_email(to_email: str, subject: str, html_content: str):
    """
    Sends an email using the configured SMTP server.
    """
    if not settings.SMTP_HOST or not settings.SMTP_EMAIL or not settings.SMTP_PASSWORD:
        logger.warning("SMTP not configured. Email not sent.")
        print(f"--- MOCK EMAIL TO {to_email} ---\nSubject: {subject}\n{html_content}\n-----------------------------")
        return False

    # Debug: Check what config we actually loaded
    pass_len = len(settings.SMTP_PASSWORD) if settings.SMTP_PASSWORD else 0
    pass_start = settings.SMTP_PASSWORD[:2] if settings.SMTP_PASSWORD else "**"
    logger.info(f"DEBUG SMTP Config: Host='{settings.SMTP_HOST}', Port='{settings.SMTP_PORT}' ({type(settings.SMTP_PORT)}), User='{settings.SMTP_EMAIL}', PassLen={pass_len}, PassStart='{pass_start}'")

    msg = MIMEMultipart()
    msg['From'] = settings.SMTP_EMAIL
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(html_content, 'html'))
    text = msg.as_string()

    # Try different connection methods
    connection_attempts = [
        # Method 1: SSL on configured port (usually 465)
        {"method": "SSL", "port": 465},
        # Method 2: TLS on configured port (usually 587)
        {"method": "TLS", "port": 587},
    ]

    # Resolve hostname to IPv4 to bypass Railway IPv6 issues
    smtp_host_ip = settings.SMTP_HOST
    try:
        addr_info = socket.getaddrinfo(settings.SMTP_HOST, None, family=socket.AF_INET)
        if addr_info:
            smtp_host_ip = addr_info[0][4][0]
            logger.info(f"Resolved {settings.SMTP_HOST} to IPv4: {smtp_host_ip}")
    except Exception as e:
        logger.warning(f"IPv4 resolution failed, using hostname: {e}")

    # Create SSL Context that allows IP connection (ignore hostname mismatch)
    # This is necessary because we are connecting to an IP (142.x.x.x) but cert is for smtp.gmail.com
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_REQUIRED 

    for attempt in connection_attempts:
        try:
            logger.info(f"Attempting email send via {attempt['method']} on port {attempt['port']} (IP: {smtp_host_ip})...")
            
            if attempt['method'] == "SSL":
                # For SSL, pass context to constructor
                server = smtplib.SMTP_SSL(smtp_host_ip, attempt['port'], timeout=10, context=context)
            else:
                # For TLS, connect then starttls
                server = smtplib.SMTP(smtp_host_ip, attempt['port'], timeout=10)
                server.starttls(context=context)
            
            server.login(settings.SMTP_EMAIL, settings.SMTP_PASSWORD)
            server.sendmail(settings.SMTP_EMAIL, to_email, text)
            server.quit()
            
            logger.info(f"Email sent successfully to {to_email} via {attempt['method']}")
            return True
            
        except Exception as e:
            logger.warning(f"Failed via {attempt['method']}: {e}")
            continue

    logger.error("All email sending attempts failed.")
    return False
