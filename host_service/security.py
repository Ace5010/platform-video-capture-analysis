"""Password, session-token and Windows DPAPI helpers."""

from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import json
import os
import secrets
from ctypes import wintypes
from pathlib import Path
from typing import Any


PASSWORD_ITERATIONS = 600_000
MIN_PASSWORD_LENGTH = 10
APP_ENTROPY = b"douyin-monitor-host-service-v1"


def token_urlsafe(byte_count: int = 32) -> str:
    return secrets.token_urlsafe(byte_count)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def password_hash(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"访问密码至少需要 {MIN_PASSWORD_LENGTH} 个字符")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2-sha256${PASSWORD_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, raw_iterations, raw_salt, raw_digest = encoded.split("$", 3)
        if algorithm != "pbkdf2-sha256":
            return False
        iterations = int(raw_iterations)
        if iterations < 100_000 or iterations > 2_000_000:
            return False
        salt = base64.b64decode(raw_salt, validate=True)
        expected = base64.b64decode(raw_digest, validate=True)
    except (ValueError, TypeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(value: bytes) -> tuple[_DataBlob, Any]:
    buffer = ctypes.create_string_buffer(value)
    return _DataBlob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def _dpapi_protect(value: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("DPAPI 仅可在 Windows 上使用")
    input_blob, input_buffer = _blob(value)
    entropy_blob, entropy_buffer = _blob(APP_ENTROPY)
    output_blob = _DataBlob()
    # Keep the buffers alive for the native call.
    _ = (input_buffer, entropy_buffer)
    success = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        "Douyin Monitor Qwen API key",
        ctypes.byref(entropy_blob),
        None,
        None,
        0x01,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(output_blob),
    )
    if not success:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def _dpapi_unprotect(value: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("DPAPI 仅可在 Windows 上使用")
    input_blob, input_buffer = _blob(value)
    entropy_blob, entropy_buffer = _blob(APP_ENTROPY)
    output_blob = _DataBlob()
    _ = (input_buffer, entropy_buffer)
    success = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(input_blob), None, ctypes.byref(entropy_blob), None, None, 0x01, ctypes.byref(output_blob)
    )
    if not success:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


class SecretStore:
    """A DPAPI CurrentUser encrypted JSON file.

    A non-Windows fallback is intentionally available only under the explicit
    test flag, so production can never silently downgrade to plaintext.
    """

    def __init__(self, path: Path, testing: bool = False) -> None:
        self.path = path
        self.testing = testing

    def save(self, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if os.name == "nt":
            protected = _dpapi_protect(raw)
        elif self.testing:
            protected = b"TEST-ONLY\0" + base64.b64encode(raw)
        else:
            raise RuntimeError("API Key 安全存储需要 Windows DPAPI")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_bytes(protected)
        os.replace(temporary, self.path)

    def load(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        protected = self.path.read_bytes()
        if os.name == "nt":
            raw = _dpapi_unprotect(protected)
        elif self.testing and protected.startswith(b"TEST-ONLY\0"):
            raw = base64.b64decode(protected.split(b"\0", 1)[1], validate=True)
        else:
            raise RuntimeError("API Key 安全存储不可用")
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else None

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)
