"""Stable public profile identity; referral parameters are not account keys."""
from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit


def canonical_douyin_account_url(value: str) -> str | None:
    try:
        url = urlsplit(value.strip())
        host = (url.hostname or "").lower()
        if (url.scheme not in ("http", "https") or url.username or url.password
                or not (host == "douyin.com" or host.endswith(".douyin.com"))
                or url.port not in (None, 80, 443)):
            return None
        match = re.fullmatch(r"/user/([A-Za-z0-9._-]+)/?", unquote(url.path))
        if not match or match[1] in (".", ".."):
            return None
        return f"https://www.douyin.com/user/{match[1]}"
    except (ValueError, AttributeError):
        return None
