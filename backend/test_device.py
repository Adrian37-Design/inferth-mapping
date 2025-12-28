import socket
import time
import random

# Configuration
HOST = "127.0.0.1"  # Use "192.168.34.133" if running from another machine
PORT = 9000         # TCP server port
IMEI = "359710048216253"

def generate_gps103_string():
    # Format: imei:12345,tracker,date,time,A,lat,N,lon,E,speed,course
    # Example from decoder: +RESP:GTFRI,imei:359710048216253,tracker,120101,120002,A,12.3456,N,34.5678,E,0.0,0.0
    
    lat = -17.824858 + (random.random() - 0.5) * 0.01  # Harare approx
    lon = 31.053028 + (random.random() - 0.5) * 0.01
    
    lat_dir = "N" if lat >= 0 else "S"
    lon_dir = "E" if lon >= 0 else "W"
    
    # Format requires positive float for lat/lon, direction handles sign
    lat_val = abs(lat)
    lon_val = abs(lon)
    
    # Construct the packet
    # Note: The decoder regex is flexible, but let's match the example close enough
    packet = f"imei:{IMEI},tracker,231120,120000,A,{lat_val:.6f},{lat_dir},{lon_val:.6f},{lon_dir},0.0,0.0"
    return packet.encode()

def main():
    print(f"Connecting to {HOST}:{PORT}...")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.connect((HOST, PORT))
            print("Connected!")
            
            while True:
                data = generate_gps103_string()
                s.sendall(data)
                print(f"Sent: {data.decode()}")
                time.sleep(5)
    except ConnectionRefusedError:
        print("Connection failed. Is the backend running?")
    except KeyboardInterrupt:
        print("\nStopping...")

if __name__ == "__main__":
    main()
