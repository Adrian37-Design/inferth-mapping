"""Generate bcrypt hash for a password: ADMIN_PASSWORD=... python generate_hash.py"""
import os, sys, bcrypt
password = os.environ.get("ADMIN_PASSWORD")
if not password:
    sys.exit("Set ADMIN_PASSWORD in the environment.")
hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
print(hashed.decode('utf-8'))
print(f"UPDATE users SET hashed_password = '{hashed.decode('utf-8')}' WHERE email = '<admin-email>';")
