
import asyncio
import httpx

API_URL = "https://inferth-mapping.up.railway.app"
CREDENTIALS = {"username": "adriankwaramba@gmail.com", "password": "Kingcarter@1"}

async def check_live_api():
    async with httpx.AsyncClient(timeout=10.0) as client:
        print(f"Connecting to {API_URL}...")
        
        # 1. Login
        try:
            print("Attempting login...")
            login_res = await client.post(f"{API_URL}/auth/login", json={"email": CREDENTIALS["username"], "password": CREDENTIALS["password"]}) # Note: it expects JSON now based on Pydantic model, not form data
            if login_res.status_code != 200:
                print(f"Login FAILED: {login_res.status_code} - {login_res.text}")
                return
            
            token = login_res.json()["access_token"]
            print(f"Login SUCCESS. Token acquired.")
            
            # 2. List Devices
            print("Fetching devices list...")
            headers = {"Authorization": f"Bearer {token}"}
            dev_res = await client.get(f"{API_URL}/devices/", headers=headers)
            
            if dev_res.status_code == 200:
                devices = dev_res.json()
                print(f"SUCCESS: Fetched {len(devices)} devices.")
                print(devices)
            else:
                print(f"Fetch FAILED: {dev_res.status_code} - {dev_res.text}")
                
        except Exception as e:
            print(f"Network Error: {e}")

if __name__ == "__main__":
    asyncio.run(check_live_api())
