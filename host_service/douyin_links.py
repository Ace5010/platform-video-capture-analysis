"""Safe parsing and resolution for user-pasted Douyin share links."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


_URL_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_VIDEO_PATTERNS = (
    re.compile(r"/video/(\d+)(?:[/?#]|$)"),
    re.compile(r"/share/video/(\d+)(?:[/?#]|$)"),
    re.compile(r"[?&](?:modal_id|aweme_id|item_id)=(\d+)(?:[&#]|$)"),
)
_HTML_VIDEO_PATTERNS = (
    re.compile(rb"https?://(?:www\.)?douyin\.com/video/(\d+)"),
    re.compile(rb'"(?:aweme_id|awemeId|item_id|itemId)"\s*:\s*"?(\d+)'),
)
_TRAILING_PUNCTUATION = "，。！？、；：,.!?;:)]}》」』"
_ALLOWED_ROOT_DOMAINS = ("douyin.com", "iesdouyin.com")


@dataclass(frozen=True)
class ResolvedDouyinLink:
    video_id: str
    canonical_url: str
    source_url: str


def _allowed_host(hostname: str | None) -> bool:
    host = (hostname or "").lower().rstrip(".")
    return any(host == root or host.endswith(f".{root}") for root in _ALLOWED_ROOT_DOMAINS)


def _validated_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ValueError("抖音分享链接格式无效") from error
    if parsed.scheme != "https" or not _allowed_host(parsed.hostname):
        raise ValueError("只支持抖音官方 HTTPS 分享链接")
    if parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("抖音分享链接格式无效")
    return value


def extract_douyin_url(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请粘贴抖音视频分享链接")
    for match in _URL_PATTERN.finditer(value):
        candidate = match.group(0).rstrip(_TRAILING_PUNCTUATION)
        try:
            return _validated_url(candidate)
        except ValueError:
            continue
    raise ValueError("没有找到有效的抖音视频分享链接")


def video_id_from_url(value: str) -> str | None:
    for pattern in _VIDEO_PATTERNS:
        match = pattern.search(value)
        if match:
            return match.group(1)
    return None


class _DouyinRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        safe_url = _validated_url(urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, safe_url)


def resolve_douyin_video_link(value: str, timeout_seconds: float = 15.0) -> ResolvedDouyinLink:
    source_url = extract_douyin_url(value)
    direct_video_id = video_id_from_url(source_url)
    if direct_video_id:
        return ResolvedDouyinLink(
            video_id=direct_video_id,
            canonical_url=f"https://www.douyin.com/video/{direct_video_id}",
            source_url=source_url,
        )

    request = Request(
        source_url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Encoding": "identity",
        },
    )
    try:
        with build_opener(_DouyinRedirectHandler()).open(request, timeout=timeout_seconds) as response:
            final_url = _validated_url(response.geturl())
            video_id = video_id_from_url(final_url)
            body = b"" if video_id else response.read(512 * 1024)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
        raise ValueError("抖音分享链接解析失败，请确认链接仍然有效") from error

    if not video_id:
        for pattern in _HTML_VIDEO_PATTERNS:
            match = pattern.search(body)
            if match:
                video_id = match.group(1).decode("ascii")
                break
    if not video_id:
        raise ValueError("分享链接没有解析到有效的抖音视频 ID")
    return ResolvedDouyinLink(
        video_id=video_id,
        canonical_url=f"https://www.douyin.com/video/{video_id}",
        source_url=source_url,
    )
