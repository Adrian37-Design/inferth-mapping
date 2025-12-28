import bcrypt

# Generate hash for password
password = b"***REMOVED***"
salt = bcrypt.gensalt()
hashed = bcrypt.hashpw(password, salt)

print(hashed.decode('utf-8'))
