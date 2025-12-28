# Run Inferth Mapping Backend (Non-Docker)

## Quick Start

1. **Start PostgreSQL** (from Docker):
```bash
docker-compose up -d db
```

2. **Install Python dependencies** (only once):
```bash
cd backend
pip install fastapi uvicorn pydantic pydantic-settings python-jose passlib bcrypt python-multipart email-validator PyYAML
```

3. **Create admin user**:
```bash
python -c "from passlib.context import CryptContext; print(CryptContext(schemes=['bcrypt']).hash('Kingcarter@1'))"
```
Copy the output hash, then:
```bash
docker exec -i inferth-mapping-db-1 psql -U postgres -d inferth -c "UPDATE users SET hashed_password = 'PASTE_HASH_HERE' WHERE email = 'adriankwaramba@gmail.com';"
```

4. **Run the backend**:
```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

5. **Access the application**:
- Login: http://localhost:8000/static/login.html  
- Dashboard: http://localhost:8000/static/index.html

**No CORS issues!** Everything runs on localhost:8000.

## Your Credentials
- Email: adriankwaramba@gmail.com
- Password: Kingcarter@1
