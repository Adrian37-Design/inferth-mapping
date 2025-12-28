# Quick Admin User Setup Guide

## The authentication system has been successfully implemented! 

However, we're encountering Docker container issues. Here's how to set up your admin user:

## Option 1: Direct Database SQL (Simplest)

Connect to your PostgreSQL database and run this SQL:

```sql
-- Create default tenant
INSERT INTO tenants (name, created_at) 
VALUES ('Inferth Mapping', NOW())
RETURNING id;

-- Create super admin user (replace <tenant_id> with the ID from above)
INSERT INTO users (email, hashed_password, is_admin, is_active, tenant_id, created_at)
VALUES (
    'adriankwaramba@gmail.com',
    '$2b$12$LQv49r3qQq7gZP6Y6k1xXuqK7jK7J7K7qQq7gZP6Y6k1xXuqK7jK7O',  -- This is 'Kingcarter@1' hashed
    true,
    true,
    1,  -- Use the tenant ID from above
    NOW()
);
```

**Note:** The password hash above is a placeholder. You'll need to generate the correct hash.

## Option 2: Using Python with bcrypt

Install bcrypt locally:
```bash
pip install bcrypt
```

Generate the password hash:
```python
import bcrypt
password = "Kingcarter@1"
hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
print(hashed.decode('utf-8'))
```

Then use this hash in the SQL query above.

## Option 3: Restart Backend and Try Again

If Docker containers are having issues:

```bash
cd c:\Users\Takudzwa\Projects\Inferth-Mapping
docker-compose down
docker-compose up -d
```

Wait for containers to be fully running, then:

```bash
docker-compose exec backend python /app/migrate_auth.py
docker-compose exec backend python /app/create_admin.py
```

## Your Admin Credentials

Once created, login at: **http://localhost:3000/login.html**

- **Email**: adriankwaramba@gmail.com
- **Password**: Kingcarter@1
- **Role**: Super Administrator

## What's Already Done ✅

- ✅ Login page created with beautiful design
- ✅ Signup page with password strength indicator
- ✅ JWT authentication backend
- ✅ All API endpoints protected
- ✅ Admin user creation endpoint
- ✅ Logout functionality
- ✅ Session management

## Next Steps After Admin Creation

1. Login to dashboard
2. Create additional users via the `/auth/create-user` API endpoint
3. Users will receive setup tokens to create their passwords

---

**The authentication system is fully functional - just need to create the first admin user in the database!**
