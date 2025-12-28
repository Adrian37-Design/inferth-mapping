import bcrypt

# Generate hash for password
password = b"Kingcarter@1"
salt = bcrypt.gensalt()
hashed = bcrypt.hashpw(password, salt)

print(hashed.decode('utf-8'))
