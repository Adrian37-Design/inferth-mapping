import psycopg2
import sys

# Connection details from user confirmation
# HOST: switchback.proxy.rlwy.net
# PORT: 30894
# USER: postgres
# PASSWORD: XooBUVGWZimrgPLZwmsMUScEPSDcdUiw
# DBNAME: railway

DB_URL = "postgresql://postgres:XooBUVGWZimrgPLZwmsMUScEPSDcdUiw@switchback.proxy.rlwy.net:30894/railway"

def check_users():
    print("Connecting to DB...", file=sys.stderr)
    try:
        conn = psycopg2.connect(DB_URL)
        print("Connected successfully!", file=sys.stderr)
        
        cur = conn.cursor()
        cur.execute("SELECT id, email, role, is_active, hashed_password FROM users;")
        rows = cur.fetchall()
        
        print(f"Found {len(rows)} users:")
        for row in rows:
            uid, email, role, active, pw_hash = row
            has_pw = "YES" if pw_hash else "NO"
            print(f"ID: {uid} | Email: {email} | Role: {role} | Active: {active} | HasPassword: {has_pw}")
            
        conn.close()
        
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)

if __name__ == "__main__":
    check_users()
