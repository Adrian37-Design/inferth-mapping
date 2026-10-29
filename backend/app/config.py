from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # MQTT Settings with defaults (so it doesn't crash if env missing)
    MQTT_BROKER: str = "mqtt.inferth.com"  
    MQTT_PORT: int = 1883
    
    DATABASE_URL: str = ""
    REDIS_URL: str = "redis://localhost:6379/0"

    # TCP Server Settings with defaults
    TCP_LISTEN_ADDR: str = "0.0.0.0"
    TCP_PORT: int = 9005
    
    JWT_SECRET: str = "change_this_secret_key_in_production"
    JWT_ALGORITHM: str = "HS256"

    TRACKER_AUTH_MODE: str = "monitor"
    TRACKER_JWT_SECRETS: dict[str, str] = {}
    # Engine lock/unlock commands are only delivered to a tracker that presents
    # a valid HMAC signature for its per-IMEI secret (tracker_secrets table or
    # TRACKER_JWT_SECRETS). Keep True; unsigned trackers still ingest data in
    # monitor mode but never receive engine commands.
    TRACKER_COMMANDS_REQUIRE_SIGNATURE: bool = True

    # Environment: "production" enables strict checks (docs off, secret enforcement).
    APP_ENV: str = "development"
    # Comma-separated exact origins allowed for credentialed CORS. Never "*".
    ALLOWED_ORIGINS: str = "https://inferth-mapping.up.railway.app,https://www.inferthmapping.co.zw,https://inferthmapping.co.zw,http://localhost:8000,http://127.0.0.1:8000,http://localhost:5500,http://127.0.0.1:5500"
    ENABLE_API_DOCS: bool = False
    # Opt-in Host allowlist (comma separated). Empty = middleware disabled.
    ALLOWED_HOSTS: str = ""
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480
    LOGIN_MAX_ATTEMPTS: int = 5
    LOGIN_LOCKOUT_MINUTES: int = 15
    SETUP_TOKEN_EXPIRE_HOURS: int = 72
    MAX_UPLOAD_MB: int = 5

    # Route map-matching engine (Valhalla trace_attributes). Set to a self-hosted
    # Valhalla base URL for production; the default is the FOSSGIS public demo
    # server (1 request/second, not for high-traffic production use).
    MAP_MATCH_URL: str = "https://valhalla1.openstreetmap.de"

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
