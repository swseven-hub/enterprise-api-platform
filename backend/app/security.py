import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any


SECRET_KEY = os.getenv("API_PLATFORM_SECRET", "dev-change-me-before-production")


def hash_password(password: str, salt: str | None = None) -> str:
    salt_bytes = base64.urlsafe_b64decode(salt.encode()) if salt else os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt_bytes, 200_000)
    return f"pbkdf2${base64.urlsafe_b64encode(salt_bytes).decode()}${base64.urlsafe_b64encode(digest).decode()}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        algorithm, salt, expected = password_hash.split("$", 2)
        if algorithm != "pbkdf2":
            return False
        candidate = hash_password(password, salt).split("$", 2)[2]
        return hmac.compare_digest(candidate, expected)
    except ValueError:
        return False


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + padding).encode())


def create_token(payload: dict[str, Any], ttl_seconds: int = 60 * 60 * 8) -> str:
    body = dict(payload)
    body["exp"] = int(time.time()) + ttl_seconds
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    encoded = _b64(raw)
    signature = hmac.new(SECRET_KEY.encode(), encoded.encode(), hashlib.sha256).digest()
    return f"{encoded}.{_b64(signature)}"


def verify_token(token: str) -> dict[str, Any] | None:
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(SECRET_KEY.encode(), encoded.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(_unb64(signature), expected):
            return None
        payload = json.loads(_unb64(encoded))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None

