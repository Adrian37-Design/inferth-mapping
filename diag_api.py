import jwt
import requests
from datetime import datetime, timedelta

# Settings from backend/app/config.py
JWT_SECRET = "change_this_secret_key_in_production"
JWT_ALGORITHM = "HS256"

# Create a token for Adrian (User ID 1, likely admin)
payload = {
    "sub": "adrian@inferth.com",
    "user_id": 1,
    "exp": datetime.utcnow() + timedelta(days=1)
}

token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

base_url = "https://inferth-mapping.up.railway.app"
headers = {"Authorization": f"Bearer {token}"}

print(f"Generated Token: {token}")

# Fetch latest 20 positions
try:
    resp = requests.get(f"{base_url}/positions/?limit=20", headers=headers)
    print(f"Status: {resp.status_code}")
    if resp.status_code == 200:
        positions = resp.json()
        print(f"Found {len(positions)} positions.")
        for p in positions:
            print(f"ID: {p['id']} | Type: {p.get('raw', {}).get('type')} | Raw: {p.get('raw')}")
    else:
        print(f"Error Body: {resp.text}")
except Exception as e:
    print(f"Request failed: {e}")
