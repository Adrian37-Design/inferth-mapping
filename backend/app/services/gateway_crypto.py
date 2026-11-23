"""
gateway_crypto.py — Symmetric encryption for multi-tenant merchant gateway credentials.

Supports both Fernet (when cryptography package is installed) and a built-in
standard-library authenticated cipher (PBKDF2 + HMAC-SHA256 keystream + MAC).
This ensures zero runtime crashes if cryptography is ever missing from a container.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Optional

try:
    from cryptography.fernet import Fernet
    _HAS_FERNET = True
except ImportError:
    Fernet = None  # type: ignore
    _HAS_FERNET = False

from app.config import Settings

_settings = Settings()


def _get_secret() -> str:
    return os.getenv("GATEWAY_ENCRYPTION_KEY") or _settings.JWT_SECRET or "inferth_telematics_gateway_secret_2026"


def _get_fernet() -> Optional[Fernet]:
    if not _HAS_FERNET or Fernet is None:
        return None
    secret = _get_secret()
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def _std_encrypt(secret: str, text: str) -> str:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, 50000)
    data = text.encode("utf-8")
    keystream = b""
    block = 0
    while len(keystream) < len(data):
        keystream += hmac.new(key, block.to_bytes(4, "big"), hashlib.sha256).digest()
        block += 1
    ciphertext = bytes(a ^ b for a, b in zip(data, keystream[:len(data)]))
    tag = hmac.new(key, ciphertext, hashlib.sha256).digest()
    return "std:" + base64.urlsafe_b64encode(salt + tag + ciphertext).decode("utf-8")


def _std_decrypt(secret: str, enc: str) -> str:
    if not enc.startswith("std:"):
        return ""
    try:
        raw = base64.urlsafe_b64decode(enc[4:])
        if len(raw) < 48:
            return ""
        salt, tag, ciphertext = raw[:16], raw[16:48], raw[48:]
        key = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, 50000)
        expected_tag = hmac.new(key, ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected_tag):
            return ""
        keystream = b""
        block = 0
        while len(keystream) < len(ciphertext):
            keystream += hmac.new(key, block.to_bytes(4, "big"), hashlib.sha256).digest()
            block += 1
        return bytes(a ^ b for a, b in zip(ciphertext, keystream[:len(ciphertext)])).decode("utf-8")
    except Exception:
        return ""


def encrypt_credential(raw_value: str) -> str:
    """Encrypt a plaintext merchant credential."""
    if not raw_value:
        return ""
    secret = _get_secret()
    f = _get_fernet()
    if f is not None:
        try:
            return f.encrypt(raw_value.encode("utf-8")).decode("utf-8")
        except Exception:
            pass
    return _std_encrypt(secret, raw_value)


def decrypt_credential(enc_value: str) -> str:
    """Decrypt an encrypted merchant credential back to plaintext."""
    if not enc_value:
        return ""
    secret = _get_secret()
    if enc_value.startswith("std:"):
        return _std_decrypt(secret, enc_value)

    # Otherwise try Fernet if available
    f = _get_fernet()
    if f is not None:
        try:
            return f.decrypt(enc_value.encode("utf-8")).decode("utf-8")
        except Exception:
            pass

    # If it was stored under std without prefix or vice versa, fallback
    return ""


def mask_credential(val: str, keep_start: int = 2, keep_end: int = 2) -> str:
    """Mask a sensitive string, e.g. 12345678 -> 12****78."""
    if not val:
        return ""
    if len(val) <= (keep_start + keep_end):
        return "***"
    return val[:keep_start] + ("*" * (len(val) - keep_start - keep_end)) + val[-keep_end:]
