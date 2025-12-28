"""
Generate bcrypt hash for the admin password
"""
import bcrypt

password = "Kingcarter@1"
hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
print("Password Hash:")
print(hashed.decode('utf-8'))
print("\nSQL to update user:")
print(f"UPDATE users SET hashed_password = '{hashed.decode('utf-8')}' WHERE email = 'adriankwaramba@gmail.com';")
