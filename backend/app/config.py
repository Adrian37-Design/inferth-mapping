from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    MQTT_BROKER: str
    MQTT_PORT: int = 1883
    DATABASE_URL: str ="postgresql://postgres:kwaramba1@localhost:5432/inferth"
    REDIS_URL: str = "redis://localhost:6379/0"

    TCP_LISTEN_ADDR: str  # e.g., "0.0.0.0"
    TCP_PORT: int = 9000  # or whatever port your TCP server should use
    
    JWT_SECRET: str = "change_this_secret_key_in_production"
    JWT_ALGORITHM: str = "HS256"

    # Email Settings
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_EMAIL: str | None = None
    SMTP_PASSWORD: str | None = None

    class Config:
        env_file = ".env"
        extra = "allow"

settings = Settings()
