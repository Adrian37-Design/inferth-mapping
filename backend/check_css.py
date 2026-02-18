
import requests
import sys

# Default to localhost if no args
url = "http://127.0.0.1:8000/static/users.css"
if len(sys.argv) > 1:
    url = sys.argv[1]

try:
    print(f"Checking {url}...")
    response = requests.get(url)
    print(f"Status Code: {response.status_code}")
    print(f"Content-Type: {response.headers.get('Content-Type')}")
    if response.status_code == 200:
        print("First 50 bytes:")
        print(response.text[:50])
    else:
        print(f"Error: {response.text[:100]}")
except Exception as e:
    print(f"Failed to connect: {e}")
