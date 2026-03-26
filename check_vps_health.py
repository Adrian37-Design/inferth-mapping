import asyncio
import socket
import os
import sys

# Add backend to path to import settings if needed, or just use basics
def check_port(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(2)
        try:
            s.connect((host, port))
            return True
        except:
            return False

async def verify_vps():
    print("🚀 --- Inferth VPS Health Check --- 🚀")
    print("-" * 40)
    
    # Check Web App (Internal check assumes running inside container or on host)
    # On host, we check Port 80
    web_ok = check_port("127.0.0.1", 80)
    print(f"[{'✅' if web_ok else '❌'}] Web Server (Port 80)")
    
    # Check Tracker Port
    tracker_ok = check_port("127.0.0.1", 9005)
    print(f"[{'✅' if tracker_ok else '❌'}] Tracker Server (Port 9005)")
    
    # Suggest next steps
    if not web_ok or not tracker_ok:
        print("\n⚠️  Warnings detected!")
        print("- Ensure 'docker-compose up -d' is running.")
        print("- Check 'docker ps' to see if containers are UP.")
        print("- Check OCI Ingress Rules for Ports 80 and 9005.")
    else:
        print("\n✅ System seems healthy!")
        print("Note: If you can't access it from outside, check your ORACLE CLOUD FIREWALL (Security Lists).")

if __name__ == "__main__":
    asyncio.run(verify_vps())
