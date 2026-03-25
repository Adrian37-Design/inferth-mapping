from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # MQTT Settings with defaults (so it doesn't crash if env missing)
    MQTT_BROKER: str = "mqtt.inferth.com"  
    MQTT_PORT: int = 1883
    
    DATABASE_URL: str ="postgresql://postgres:kwaramba1@localhost:5432/inferth"
    REDIS_URL: str = "redis://localhost:6379/0"

    # TCP Server Settings with defaults
    TCP_LISTEN_ADDR: str = "0.0.0.0"
    TCP_PORT: int = 9005
    
    JWT_SECRET: str = "change_this_secret_key_in_production"
    JWT_ALGORITHM: str = "HS256"

    SECONDARY_DESTINATION: str | None = None

    # Email Settings
    RESEND_API_KEY: str | None = None
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_EMAIL: str | None = None
    SMTP_PASSWORD: str | None = None
    
    # SMS Settings
    SMS_PROVIDER: str = "mock" # infobip, twilio, or mock
    SMS_API_KEY: str | None = None
    SMS_API_BASE_URL: str | None = None
    SMS_SENDER: str = "Inferth" # Sender ID (Alphanumeric or Number)
    
    # Twilio Specific
    TWILIO_ACCOUNT_SID: str | None = None
    TWILIO_AUTH_TOKEN: str | None = None
    TWILIO_FROM_NUMBER: str | None = None

    class Config:
        env_file = ".env"
        extra = "allow"

settings = Settings()
