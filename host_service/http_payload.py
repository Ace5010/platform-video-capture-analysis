"""Compress large workspace reads before they cross the private tunnel."""
import gzip
import json
from typing import Any


def encode_json(payload: dict[str, Any], accept_encoding: str, *, compress: bool) -> tuple[bytes, str | None]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not compress or len(body) < 4096:
        return body, None
    for option in accept_encoding.lower().split(","):
        name, *parameters = option.strip().split(";")
        if name.strip() != "gzip":
            continue
        try:
            quality = next((float(part.split("=", 1)[1]) for part in parameters if part.strip().startswith("q=")), 1)
        except ValueError:
            return body, None
        if 0 < quality <= 1:
            compressed = gzip.compress(body, compresslevel=6, mtime=0)
            if len(compressed) < len(body):
                return compressed, "gzip"
        break
    return body, None
