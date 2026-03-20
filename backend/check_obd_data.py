import os
import json
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()

def check_obd():
    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("Error: DATABASE_URL not found")
        return
    
    if db_url.startswith("postgresql+asyncpg://"):
        db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
    elif db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://")

    # Use synchronous engine for simple check
    engine = create_engine(db_url)
    
    query = text("""
        SELECT id, device_id, raw, timestamp 
        FROM positions 
        WHERE raw IS NOT NULL 
        ORDER BY id DESC 
        LIMIT 50
    """)
    
    print("--- RECENT POSITIONS RAW CHECK ---")
    with engine.connect() as conn:
        result = conn.execute(query)
        found_obd = False
        for row in result:
            raw_data = row[2]
            if isinstance(raw_data, str):
                try:
                    raw_data = json.loads(raw_data)
                except:
                    pass
            
            # Check for OBD fields
            obd_fields = ['rpm', 'coolant', 'engine_load', 'fuel_consumption', 'battery', 'voltage']
            has_obd = any(field in raw_data for field in obd_fields)
            
            if has_obd:
                found_obd = True
                print(f"ID: {row[0]}, DeviceID: {row[1]}, Time: {row[3]}")
                print(f"  OBD Data found: { {k: raw_data[k] for k in obd_fields if k in raw_data} }")
        
        if not found_obd:
            print("No OBD telemetry found in the last 50 positions.")

if __name__ == "__main__":
    check_obd()
