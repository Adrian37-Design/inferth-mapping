"""
gateway_crypto.py — Symmetric encryption for multi-tenant merchant gateway credentials.

Uses Fernet (AES-128-CBC + HMAC-SHA256) with a key derived from GATEWAY_ENCRYPTION_KEY
or settings.JWT_SECRET.
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet
from app.config import Settings

_settings = Settings()


def _get_fernet() -> Fernet:
    secret = os.getenv("GATEWAY_ENCRYPTION_KEY") or _settings.JWT_SECRET or "inferth_telematics_gateway_secret_2026"
    # Derive exactly 32 bytes and base64-encode for Fernet
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_credential(raw_value: str) -> str:
    """Encrypt a plaintext merchant credential into a base64 token string."""
    if not raw_value:
        return ""
    f = _get_fernet()
    return f.encrypt(raw_value.encode("utf-8")).decode("utf-8")


def decrypt_credential(enc_value: str) -> str:
    """Decrypt an encrypted merchant credential back to plaintext."""
    if not enc_value:
        return ""
    f = _get_fernet()
    try:
        return f.decrypt(enc_value.encode("utf-8")).decode("utf-8")
    except Exception:
        return ""


def mask_credential(val: str, keep_start: int = 2, keep_end: int = 2) -> str:
    """Mask a sensitive string, e.g. 12345678 -> 12****78."""
    if not val:
        return ""
    if len(val) <= (keep_start + keep_end):
        return "***"
    return val[:keep_start] + ("*" * (len(val) - keep_start - keep_end)) + val[-keep_end:]
