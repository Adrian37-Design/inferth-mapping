
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import sys

# --- CONFIGURATION ---
# Hardcode these temporarily OR read from env if you have them set locally
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587  # TLS Port
SMTP_EMAIL = "inferth2026@gmail.com"
SMTP_PASSWORD = "azph aryl mrrn sjco"

TO_EMAIL = "adriantakudzwa7337@gmail.com"

def test_send_email():
    print(f"Testing TLS email connection to {SMTP_HOST}:{SMTP_PORT}...")
    
    try:
        msg = MIMEMultipart()
        msg['From'] = SMTP_EMAIL
        msg['To'] = TO_EMAIL
        msg['Subject'] = "Inferth Mapping - TLS Test Email"
        body = "<h1>It Works via TLS!</h1><p>Test from port 587.</p>"
        msg.attach(MIMEText(body, 'html'))

        # Connect using SMTP (Explicit TLS)
        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT)
        server.set_debuglevel(1)
        server.starttls()
        server.login(SMTP_EMAIL, SMTP_PASSWORD)
        
        server.sendmail(SMTP_EMAIL, TO_EMAIL, msg.as_string())
        server.quit()
        
        print("\nSUCCESS! Email sent successfully via TLS.")
    except Exception as e:
        print(f"\nFAILED: {e}")
        
        print("\nSUCCESS! Email sent successfully.")
    except Exception as e:
        print(f"\nFAILED: {e}")

if __name__ == "__main__":
    if SMTP_PASSWORD == "PUT_YOUR_16_CHAR_APP_PASSWORD_HERE":
        print("Please edit this script and put your actual Gmail App Password in the SMTP_PASSWORD variable.")
    else:
        test_send_email()
