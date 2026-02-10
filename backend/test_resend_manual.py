import httpx
import asyncio

# Configuration
RESEND_API_KEY = "re_Mt6hKpep_3d9VMENZa8vxmmHcJtsMd4wR"
TO_EMAIL = "inferth2026@gmail.com" # MUST be the account email for unverified domains
FROM_EMAIL = "onboarding@resend.dev" # Default for testing

async def send_resend_email():
    print(f"Testing Resend API...")
    print(f"Key: {RESEND_API_KEY[:5]}...")
    print(f"To: {TO_EMAIL}")
    
    url = "https://api.resend.com/emails"
    headers = {
        "Authorization": f"Bearer {RESEND_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "from": "Inferth Test <" + FROM_EMAIL + ">",
        "to": [TO_EMAIL],
        "subject": "Inferth Mapping - Resend API Test",
        "html": "<h1>It Works!</h1><p>This email was sent via the Resend API (Port 443).</p>"
    }
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers)
            
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 200:
            print("\nSUCCESS! Email sent.")
        else:
            print("\nFAILED. Check the error message above.")
            
    except Exception as e:
        print(f"\nEXCEPTION: {e}")

if __name__ == "__main__":
    asyncio.run(send_resend_email())
