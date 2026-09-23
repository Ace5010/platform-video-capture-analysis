"""Loopback-only ASR service for the Douyin monitoring dashboard."""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit

from .punctuation import restore_punctuation


LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 43128
MAX_REQUEST_BYTES = 32 * 1024
MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_URL_LENGTH = 8_192
MAX_REDIRECTS = 4
DOWNLOAD_TIMEOUT_SECONDS = 30

MODEL_NAME = (os.environ.get("DOUYIN_ASR_MODEL") or "large-v3").strip()
LANGUAGE = (os.environ.get("DOUYIN_ASR_LANGUAGE") or "zh").strip()

# These suffixes are used by Douyin for direct media/music delivery. API,
# short-link, arbitrary ByteDance, and user-supplied hosts are intentionally
# excluded. Matching is label-aware: evil-douyinvod.com is not accepted.
ALLOWED_AUDIO_CDN_SUFFIXES = (
    "douyinvod.com",
    "douyinstatic.com",
    "douyinpic.com",
    "zjcdn.com",
    "bytecdn.cn",
)

ALLOWED_MEDIA_TYPES = (
    "application/octet-stream",
    "binary/octet-stream",
)
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
HOST_PATTERN = re.compile(r"^[a-z0-9.-]+$")
CHROME_EXTENSION_ID_PATTERN = re.compile(r"^[a-p]{32}$")

_MODEL: Any | None = None
_MODEL_LOCK = threading.Lock()
_TRANSCRIBE_LOCK = threading.Lock()
_TLS_CONTEXT = ssl.create_default_context()


class ApiError(Exception):
    """An expected failure whose message is safe to return to the browser."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class DownloadTarget:
    hostname: str
    port: int
    request_path: str
    addresses: tuple[str, ...]


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection pinned to a previously validated public IP address."""

    def __init__(self, hostname: str, port: int, address: str) -> None:
        super().__init__(
            hostname,
            port=port,
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
            context=_TLS_CONTEXT,
        )
        self._pinned_address = address

    def connect(self) -> None:
        raw_socket = socket.create_connection(
            (self._pinned_address, self.port),
            timeout=self.timeout,
            source_address=self.source_address,
        )
        try:
            self.sock = self._context.wrap_socket(
                raw_socket,
                server_hostname=self.host,
            )
        except Exception:
            raw_socket.close()
            raise


def _is_allowed_cdn_hostname(hostname: str) -> bool:
    return any(
        hostname == suffix or hostname.endswith(f".{suffix}")
        for suffix in ALLOWED_AUDIO_CDN_SUFFIXES
    )


def _is_verified_douyin_play_url(url: str, expected_video_id: str | None) -> bool:
    if not expected_video_id or not VIDEO_ID_PATTERN.fullmatch(expected_video_id):
        return False
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() != "www.douyin.com"
        or parsed.path != "/aweme/v1/play/"
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        return False
    return parse_qs(parsed.query).get("__vid", []) == [expected_video_id]


def _is_public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    return address.is_global


def _validate_download_target(url: str, *, expected_video_id: str | None = None) -> DownloadTarget:
    if not url or len(url) > MAX_URL_LENGTH:
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 为空或过长")
    if any(ord(character) < 32 or ord(character) == 127 for character in url):
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 包含非法字符")

    try:
        parsed = urlsplit(url)
        port = parsed.port or 443
    except ValueError as error:
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 格式无效") from error

    if parsed.scheme.lower() != "https":
        raise ApiError(HTTPStatus.BAD_REQUEST, "只允许 HTTPS 音频地址")
    if parsed.username is not None or parsed.password is not None:
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 不允许包含用户信息")
    if parsed.port not in (None, 443):
        raise ApiError(HTTPStatus.BAD_REQUEST, "音频地址只允许使用 HTTPS 443 端口")
    if not parsed.hostname:
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 缺少域名")

    try:
        hostname = parsed.hostname.encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 域名无效") from error

    if (
        hostname.endswith(".")
        or not HOST_PATTERN.fullmatch(hostname)
        or ".." in hostname
        or not (
            _is_allowed_cdn_hostname(hostname)
            or _is_verified_douyin_play_url(url, expected_video_id)
        )
    ):
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 不是允许的抖音音频 CDN 地址")

    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 不允许使用 IP 地址")

    try:
        resolved = socket.getaddrinfo(
            hostname,
            port,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, "音频 CDN 域名解析失败") from error

    addresses: list[str] = []
    for result in resolved:
        address = result[4][0]
        if not _is_public_address(address):
            raise ApiError(HTTPStatus.BAD_REQUEST, "音频 CDN 解析到了非公网地址")
        if address not in addresses:
            addresses.append(address)

    if not addresses:
        raise ApiError(HTTPStatus.BAD_GATEWAY, "音频 CDN 没有可用地址")

    request_path = parsed.path or "/"
    if parsed.query:
        request_path = f"{request_path}?{parsed.query}"

    return DownloadTarget(
        hostname=hostname,
        port=port,
        request_path=request_path,
        addresses=tuple(addresses),
    )


def _open_download(target: DownloadTarget, *, deadline: float | None = None, check_cancelled=None) -> tuple[PinnedHTTPSConnection, http.client.HTTPResponse]:
    for address in target.addresses:
        if check_cancelled is not None:
            check_cancelled()
        remaining = deadline - time.monotonic() if deadline is not None else DOWNLOAD_TIMEOUT_SECONDS
        if remaining <= 0:
            raise ApiError(HTTPStatus.GATEWAY_TIMEOUT, "完整媒体连接超过本次获取时限")
        connection = PinnedHTTPSConnection(
            target.hostname,
            target.port,
            address,
        )
        connection.timeout = min(DOWNLOAD_TIMEOUT_SECONDS, remaining)
        try:
            connection.request(
                "GET",
                target.request_path,
                headers={
                    "Accept": "audio/*,video/*,application/octet-stream",
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                    "Referer": "https://www.douyin.com/",
                    "User-Agent": "DouyinLocalASR/1.0",
                },
            )
            return connection, connection.getresponse()
        except (OSError, ssl.SSLError, http.client.HTTPException):
            connection.close()

    raise ApiError(HTTPStatus.BAD_GATEWAY, "无法连接抖音音频 CDN")


def _download_audio(audio_url: str, destination: Path) -> None:
    current_url = audio_url

    for redirect_index in range(MAX_REDIRECTS + 1):
        target = _validate_download_target(current_url)
        connection, response = _open_download(target)
        try:
            if response.status in (301, 302, 303, 307, 308):
                if redirect_index >= MAX_REDIRECTS:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, "音频 CDN 重定向次数过多")
                location = response.getheader("Location")
                if not location:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, "音频 CDN 返回了无效重定向")
                current_url = urljoin(current_url, location)
                continue

            if response.status != HTTPStatus.OK:
                raise ApiError(
                    HTTPStatus.BAD_GATEWAY,
                    f"音频 CDN 返回 HTTP {response.status}",
                )

            content_length = response.getheader("Content-Length")
            if content_length is not None:
                try:
                    declared_size = int(content_length)
                except ValueError as error:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, "音频 CDN 返回了无效文件大小") from error
                if declared_size <= 0:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, "音频文件为空")
                if declared_size > MAX_AUDIO_BYTES:
                    raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "音频文件超过 64MB 限制")

            content_type = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
            if content_type and not (
                content_type.startswith("audio/")
                or content_type.startswith("video/")
                or content_type in ALLOWED_MEDIA_TYPES
            ):
                raise ApiError(HTTPStatus.BAD_GATEWAY, "音频 CDN 未返回可识别的媒体文件")

            total = 0
            with destination.open("wb") as output:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "音频文件超过 64MB 限制")
                    output.write(chunk)

            if total == 0:
                raise ApiError(HTTPStatus.BAD_GATEWAY, "音频文件为空")
            return
        except ApiError:
            raise
        except (OSError, ssl.SSLError, http.client.HTTPException) as error:
            raise ApiError(HTTPStatus.BAD_GATEWAY, "音频下载中断") from error
        finally:
            response.close()
            connection.close()

    raise ApiError(HTTPStatus.BAD_GATEWAY, "音频 CDN 重定向次数过多")


def _get_model() -> Any:
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise ApiError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "faster-whisper 尚未安装，请先运行 scripts/setup-asr.ps1",
            ) from error

        print(f"[local-asr] 正在惰性加载 {MODEL_NAME} 模型（CPU int8）", flush=True)
        try:
            _MODEL = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
        except Exception as error:
            raise ApiError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "ASR 模型加载失败，请检查网络或模型缓存",
            ) from error
        return _MODEL


def _transcribe_file(path: Path) -> dict[str, Any]:
    model = _get_model()
    try:
        segments, info = model.transcribe(
            str(path),
            language=LANGUAGE,
            vad_filter=True,
            beam_size=5,
        )
        text = restore_punctuation(segments)
    except Exception as error:
        raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "本地语音识别失败") from error

    if not text:
        raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "音频中未识别到清晰口播内容")

    duration = getattr(info, "duration", None)
    language_probability = getattr(info, "language_probability", None)
    return {
        "text": text,
        "language": getattr(info, "language", LANGUAGE) or LANGUAGE,
        "languageProbability": (
            round(float(language_probability), 4)
            if language_probability is not None
            else None
        ),
        "duration": round(float(duration), 3) if duration is not None else None,
    }


def _is_allowed_origin(origin: str) -> bool:
    if len(origin) > 256:
        return False
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return False
    common_valid = (
        parsed.username is None
        and parsed.password is None
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
    )
    if not common_valid:
        return False
    if parsed.scheme in ("http", "https"):
        return (
            parsed.hostname in ("localhost", "127.0.0.1", "::1")
            and (port is None or 1 <= port <= 65535)
        )
    if parsed.scheme == "chrome-extension":
        return (
            port is None
            and parsed.hostname is not None
            and CHROME_EXTENSION_ID_PATTERN.fullmatch(parsed.hostname) is not None
        )
    return False


class LocalASRHandler(BaseHTTPRequestHandler):
    server_version = "DouyinLocalASR/1.0"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        # Request bodies can contain signed CDN URLs. Never include them in logs.
        return

    def _origin(self) -> str | None:
        origin = self.headers.get("Origin")
        return origin if origin and _is_allowed_origin(origin) else None

    def _require_allowed_origin(self) -> None:
        origin = self.headers.get("Origin")
        if origin and not _is_allowed_origin(origin):
            raise ApiError(HTTPStatus.FORBIDDEN, "不允许的浏览器来源")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        origin = self._origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _send_api_error(self, error: ApiError) -> None:
        self._send_json(error.status, {"ok": False, "error": error.message})

    def do_OPTIONS(self) -> None:
        try:
            self._require_allowed_origin()
            if urlsplit(self.path).path not in ("/health", "/transcribe"):
                raise ApiError(HTTPStatus.NOT_FOUND, "接口不存在")
            self.send_response(HTTPStatus.NO_CONTENT)
            origin = self._origin()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "600")
                self.send_header("Vary", "Origin")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except ApiError as error:
            self._send_api_error(error)

    def do_GET(self) -> None:
        try:
            self._require_allowed_origin()
            if urlsplit(self.path).path != "/health":
                raise ApiError(HTTPStatus.NOT_FOUND, "接口不存在")
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "service": "douyin-local-asr",
                    "model": MODEL_NAME,
                    "language": LANGUAGE,
                    "device": "cpu",
                    "computeType": "int8",
                    "vad": True,
                    "modelLoaded": _MODEL is not None,
                    "maxAudioBytes": MAX_AUDIO_BYTES,
                },
            )
        except ApiError as error:
            self._send_api_error(error)

    def do_POST(self) -> None:
        temporary_path: Path | None = None
        lock_acquired = False
        try:
            self._require_allowed_origin()
            if urlsplit(self.path).path != "/transcribe":
                raise ApiError(HTTPStatus.NOT_FOUND, "接口不存在")

            content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "请求必须使用 application/json")
            if self.headers.get("Transfer-Encoding"):
                raise ApiError(HTTPStatus.BAD_REQUEST, "不支持分块请求体")

            content_length = self.headers.get("Content-Length")
            if content_length is None:
                raise ApiError(HTTPStatus.LENGTH_REQUIRED, "缺少 Content-Length")
            try:
                body_length = int(content_length)
            except ValueError as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length 无效") from error
            if body_length <= 0 or body_length > MAX_REQUEST_BYTES:
                raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "请求体为空或超过 32KB 限制")

            try:
                payload = json.loads(self.rfile.read(body_length))
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, "请求 JSON 无效") from error
            if not isinstance(payload, dict):
                raise ApiError(HTTPStatus.BAD_REQUEST, "请求 JSON 必须是对象")

            audio_url = payload.get("audioUrl")
            video_id = payload.get("videoId")
            if not isinstance(audio_url, str):
                raise ApiError(HTTPStatus.BAD_REQUEST, "audioUrl 必须是字符串")
            if not isinstance(video_id, str) or not VIDEO_ID_PATTERN.fullmatch(video_id):
                raise ApiError(HTTPStatus.BAD_REQUEST, "videoId 格式无效")

            # Validate before creating a temporary file, then validate again while
            # downloading each redirect target.
            _validate_download_target(audio_url)
            lock_acquired = _TRANSCRIBE_LOCK.acquire(blocking=False)
            if not lock_acquired:
                raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, "ASR 正在处理另一条视频，请稍后重试")

            with tempfile.NamedTemporaryFile(
                prefix="douyin-local-asr-",
                suffix=".media",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)

            _download_audio(audio_url, temporary_path)
            result = _transcribe_file(temporary_path)
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "videoId": video_id, **result},
            )
        except ApiError as error:
            self._send_api_error(error)
        except Exception as error:
            # Log only the exception class. Exception text may contain a signed URL.
            print(f"[local-asr] 未预期错误：{type(error).__name__}", flush=True)
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "本地 ASR 服务发生未预期错误"},
            )
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    print("[local-asr] 临时音频清理失败", flush=True)
            if lock_acquired:
                _TRANSCRIBE_LOCK.release()


class LocalASRServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    server = LocalASRServer((LISTEN_HOST, LISTEN_PORT), LocalASRHandler)
    print(
        f"[local-asr] 已监听 http://{LISTEN_HOST}:{LISTEN_PORT} "
        f"（模型 {MODEL_NAME}，语言 {LANGUAGE}，CPU int8，VAD）",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[local-asr] 已停止", flush=True)


if __name__ == "__main__":
    main()
