import asyncpg
import asyncio

async def create_admin_user():
    # Get the DATABASE_URL from Railway
    # Replace this with your actual Railway DATABASE_URL
    DATABASE_URL = input("Paste your Railway DATABASE_URL (from backend variables): ")
    
    # Change postgresql:// to just remove the +asyncpg part for asyncpg
    if "+asyncpg" in DATABASE_URL:
        DATABASE_URL = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    
    try:
        # Connect to database
        conn = await asyncpg.connect(DATABASE_URL)
        
        # Create tenant
        await conn.execute(
            "INSERT INTO tenants (name) VALUES ($1) ON CONFLICT DO NOTHING",
            "Inferth Mapping"
        )
        print("✅ Tenant created")
        
        # Create admin user
        await conn.execute(
            """
            INSERT INTO users (email, hashed_password, is_admin, is_active, tenant_id, created_at) 
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (email) DO UPDATE 
            SET hashed_password = EXCLUDED.hashed_password,
                is_admin = EXCLUDED.is_admin,
                is_active = EXCLUDED.is_active
            """,
            "adriankwaramba@gmail.com",
            "$2b$12$vHZ1YhI8K3YpFr7i9J3yp.jYZ8j6nRKj6nY6puLZKqX8z9YZ8j6nR",
            True,
            True,
            1
        )
        print("✅ Admin user created successfully!")
        print("\nLogin credentials:")
        print("Email: adriankwaramba@gmail.com")
        print("Password: Kingcarter@1")
        
        await conn.close()
        
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    asyncio.run(create_admin_user())
