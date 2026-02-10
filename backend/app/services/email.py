import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from app.config import settings
import logging

logger = logging.getLogger(__name__)

def send_email(to_email: str, subject: str, html_content: str):
    """
    Sends an email using the configured SMTP server.
    """
    if not settings.SMTP_HOST or not settings.SMTP_EMAIL or not settings.SMTP_PASSWORD:
        logger.warning("SMTP not configured. Email not sent.")
        print(f"--- MOCK EMAIL TO {to_email} ---\nSubject: {subject}\n{html_content}\n-----------------------------")
        return False

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
        # Method 3: Configured port as is
        {"method": "Configured", "port": int(settings.SMTP_PORT)}
    ]

    for attempt in connection_attempts:
        try:
            logger.info(f"Attempting email send via {attempt['method']} on port {attempt['port']}...")
            
            if attempt['method'] == "SSL":
                server = smtplib.SMTP_SSL(settings.SMTP_HOST, attempt['port'], timeout=10)
            else:
                server = smtplib.SMTP(settings.SMTP_HOST, attempt['port'], timeout=10)
                server.starttls()
            
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
