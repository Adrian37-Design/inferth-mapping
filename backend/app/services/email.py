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

    try:
        msg = MIMEMultipart()
        msg['From'] = settings.SMTP_EMAIL
        msg['To'] = to_email
        msg['Subject'] = subject

        msg.attach(MIMEText(html_content, 'html'))

        # Connect to SMTP Server
        server = smtplib.SMTP(settings.SMTP_HOST, int(settings.SMTP_PORT))
        server.starttls()
        server.login(settings.SMTP_EMAIL, settings.SMTP_PASSWORD)
        
        text = msg.as_string()
        server.sendmail(settings.SMTP_EMAIL, to_email, text)
        server.quit()
        
        logger.info(f"Email sent to {to_email}")
        return True
    except Exception as e:
        logger.error(f"Failed to send email: {e}")
        return False
