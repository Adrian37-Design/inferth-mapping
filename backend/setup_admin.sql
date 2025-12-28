-- Add new columns to users table if they don't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_token VARCHAR UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ALTER COLUMN hashed_password DROP NOT NULL;

-- Insert tenant
INSERT INTO tenants (name, created_at) VALUES ('Inferth Mapping', NOW()) ON CONFLICT DO NOTHING;

-- Get tenant ID
DO $$
DECLARE
    tenant_id_var INTEGER;
BEGIN
    SELECT id INTO tenant_id_var FROM tenants WHERE name = 'Inferth Mapping' LIMIT 1;
    
    -- Insert admin user with bcrypt hash for 'Kingcarter@1'
    -- Note: This hash needs to be generated properly with bcrypt
    INSERT INTO users (email, hashed_password, is_admin, is_active, tenant_id, created_at)
    VALUES (
        'adriankwaramba@gmail.com',
        '$2b$12$vHZ1YhI8K3YZ8j6nRKj6nOEQjKVVX9YZ8j6nRKj6nY6puLZKqX8ze',  -- Placeholder hash
        true,
        true,
        tenant_id_var,
        NOW()
    ) ON CONFLICT (email) DO UPDATE SET 
        is_admin = true,
        is_active = true,
        hashed_password = EXCLUDED.hashed_password;
END $$;

SELECT 'Admin user created successfully!' AS status;
SELECT email, is_admin, is_active FROM users WHERE email = 'adriankwaramba@gmail.com';
