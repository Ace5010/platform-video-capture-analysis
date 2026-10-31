"""Authenticated LAN JSON API and loopback connector gateway."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import signal
import socket
import threading
import time
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .analysis import AnalysisManager
from .transcription import TranscriptionManager
from .browser import BrowserManager
from .compatibility import (
    CONNECTOR_FRESHNESS_SECONDS,
    MINIMUM_ANALYSIS_EXTENSION_VERSION,
    effective_connector_capabilities,
)
from .config import HostConfig
from .database import CANONICAL_JOB_TYPES, Database, utc_now
from .douyin_links import resolve_douyin_video_link
from .http_payload import encode_json
from .media import cleanup_stale_temp
from .preview import PreviewError, PreviewManager
from .qwen import QwenClient, analysis_section_status
from .codebuddy import analysis_client
from .remote import GATEWAY_PORT, RemoteConnection, TunnelProcess
from .security import (
    MIN_PASSWORD_LENGTH,
    SecretStore,
    password_hash,
    token_hash,
    token_urlsafe,
    verify_password,
)


SESSION_COOKIE = "douyin_monitor_session"
EXTENSION_ID_PATTERN = re.compile(r"^[a-p]{32}$")


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _is_loopback(value: str) -> bool:
    try:
        return ipaddress.ip_address(value.split("%", 1)[0]).is_loopback
    except ValueError:
        return value.lower() == "localhost"


def _private_dashboard_origin(origin: str, dashboard_port: int) -> bool:
    if len(origin) > 512:
        return False
    try:
        parsed = urlsplit(origin)
        hostname = (parsed.hostname or "").lower()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or port != dashboard_port:
        return False
    if parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return False
    # Resolve known local names and numeric addresses before any DNS lookup.
    # Building a set containing getfqdn() eagerly performs reverse DNS even
    # for localhost; a disconnected VPN/DNS server can then stall every API
    # request (and its CORS response) beyond the browser's connection timeout.
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if hostname == socket.gethostname().lower():
            return True
        return hostname == socket.getfqdn().lower()
    return address.is_private or address.is_loopback


def _extension_origin_id(origin: str | None) -> str | None:
    if not origin:
        return None
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return None
    if parsed.scheme != "chrome-extension" or parsed.port is not None or parsed.path not in ("", "/"):
        return None
    extension_id = parsed.hostname or ""
    return extension_id if EXTENSION_ID_PATTERN.fullmatch(extension_id) else None


class HostHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        config: HostConfig,
        database: Database,
        secrets: SecretStore,
        analysis: AnalysisManager,
        remote_connection: RemoteConnection | None = None,
    ) -> None:
        super().__init__(address, HostRequestHandler)
        self.config = config
        self.database = database
        self.secrets = secrets
        self.analysis = analysis
        self.remote_connection = remote_connection
        self.tunnel: TunnelProcess | None = None
        self.remote_error: str | None = None
        self.browser: BrowserManager | None = None
        self.previews: PreviewManager | None = None
        self.transcriptions: TranscriptionManager | None = None
        self.wechat = None
        self.wechat_guard = threading.Lock()

    def server_close(self) -> None:
        if self.transcriptions and not self.remote_connection:
            self.transcriptions.shutdown()
        if self.previews:
            self.previews.shutdown()
        if self.browser and not self.remote_connection:
            self.browser.shutdown()
        super().server_close()


class HostRequestHandler(BaseHTTPRequestHandler):
    server_version = "DouyinMonitorHost/0.1"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    server: HostHTTPServer

    def log_message(self, _format: str, *_args: Any) -> None:
        # Bodies and URLs may contain signed CDN values.  Never log requests.
        return

    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            self.close_connection = True

    @property
    def config(self) -> HostConfig:
        return self.server.config

    @property
    def database(self) -> Database:
        return self.server.database

    def _remote_ip(self) -> str:
        if self.server.remote_connection:
            # The loopback-only listener is reached through the account's VPC
            # service binding. Public clients cannot connect to it directly.
            value = self.headers.get("X-Workbench-Client-IP") or "unknown"
            try:
                return str(ipaddress.ip_address(value))
            except ValueError:
                return "remote-unknown"
        return self.client_address[0].split("%", 1)[0]

    def _loopback(self) -> bool:
        # The tunnel's TCP peer is local, but the person using it is never a
        # localhost administrator. This cannot be overridden by request headers.
        return not self.server.remote_connection and _is_loopback(self._remote_ip())

    def _require_gateway(self) -> None:
        connection = self.server.remote_connection
        if not connection:
            return
        if not _is_loopback(self.client_address[0]):
            raise ApiError(HTTPStatus.FORBIDDEN, "远程入口仅接受本机私有通道连接")
        # Recheck the origin on the host as well as in the Worker.
        if self.headers.get_all("Origin") != [connection.origin]:
            raise ApiError(HTTPStatus.FORBIDDEN, "不允许的网页来源")
        path = urlsplit(self.path).path
        if path.startswith("/connector/") or (self.command != "GET" and path in {
            "/api/auth/setup", "/api/qwen", "/api/qwen/config", "/api/migrate", "/api/browser/open",
        }):
            raise ApiError(HTTPStatus.FORBIDDEN, "此操作只能在电脑的 localhost 工作台执行")

    def _local_dashboard(self) -> bool:
        if not self._loopback():
            return False
        origin = self.headers.get("Origin") or ""
        try:
            hostname = (urlsplit(origin).hostname or "").lower()
        except ValueError:
            return False
        return hostname in {"localhost", "127.0.0.1", "::1"}

    def _require_local_dashboard(self, message: str) -> None:
        if not self._local_dashboard():
            raise ApiError(HTTPStatus.FORBIDDEN, message)

    def _wechat_request(self, action, payload=None):
        local = self._local_dashboard()
        # Authenticated remote readers share the saved archive. Capture,
        # generation and management remain local, checked before opening it.
        read_only = (self.command == 'GET' and action in {'context', 'days', 'summary', 'original', 'asset'}
                     or self.command == 'POST' and action == 'search')
        if not local and not self.server.remote_connection:
            raise ApiError(HTTPStatus.FORBIDDEN, '请通过已登录的正式 HTTPS 工作台阅读微信归档')
        if not local and not read_only:
            raise ApiError(HTTPStatus.FORBIDDEN, '读取并总结仅允许在电脑的 localhost 工作台执行')
        from .wechat.archive import ArchiveError
        from .wechat.service import WeChatService
        with self.server.wechat_guard:
            if self.server.wechat is None:
                self.server.wechat = WeChatService()
            service = self.server.wechat
        try:
            if payload is None:
                query = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
                result = service.get(action, query)
                if action == 'asset':
                    file, asset = result
                    mime = asset['mime'] if asset['mime'] in ('image/jpeg', 'image/png', 'image/gif', 'image/webp') else 'application/octet-stream'
                    self.send_response(HTTPStatus.OK)
                    self.send_header('Content-Type', mime)
                    self.send_header('Content-Length', str(asset['bytes']))
                    self.send_header('Cache-Control', 'private, no-store')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.send_header('Content-Security-Policy', "default-src 'none'; sandbox")
                    self.send_header('Referrer-Policy', 'no-referrer')
                    self.send_header('Content-Disposition', 'inline' if mime.startswith('image/') else 'attachment')
                    origin = self._cors_origin()
                    if origin:
                        self.send_header('Access-Control-Allow-Origin', origin)
                        self.send_header('Access-Control-Allow-Credentials', 'true')
                        self.send_header('Vary', 'Origin')
                    self.end_headers()
                    with file.open('rb') as stream:
                        while chunk := stream.read(64 * 1024):
                            self.wfile.write(chunk)
                    return
                if not local and action == 'context':
                    result = {'groups': [{key: group[key] for key in
                              ('id', 'name', 'start', 'end', 'message_count', 'status') if key in group}
                              for group in result['groups']], 'members': result['members'],
                              'batches': [], 'read_jobs': [], 'revision': result['revision']}
            else:
                result = service.post(action, payload)
        except ArchiveError as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, str(exc)) from None
        except (OSError, ValueError, KeyError):
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, '微信归档暂时不可用，请在电脑的微信读取页面核对配置。') from None
        self._send_json(HTTPStatus.OK, result)

    def _cors_origin(self) -> str | None:
        if self.server.remote_connection:
            return None  # The public browser talks to its same-origin Worker.
        origin = self.headers.get("Origin")
        return origin if origin and _private_dashboard_origin(origin, self.config.dashboard_port) else None

    def _require_browser_origin(self) -> None:
        if self.server.remote_connection:
            self._require_gateway()
            return
        origin = self.headers.get("Origin")
        if not origin or not _private_dashboard_origin(origin, self.config.dashboard_port):
            raise ApiError(HTTPStatus.FORBIDDEN, "不允许的网页来源")

    def _send_json(
        self,
        status: int,
        payload: dict[str, Any],
        *,
        cookies: list[str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        # Auth responses contain per-session secrets and stay uncompressed.
        compress = status == 200 and self.command == "GET" and urlsplit(self.path).path in ("/api/state", "/api/jobs")
        body, encoding = encode_json(payload, self.headers.get("Accept-Encoding", ""), compress=compress)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store" if urlsplit(self.path).path.startswith('/api/wechat/') else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-site")
        self.send_header("Connection", "close")
        origin = self._cors_origin()
        vary = ["Accept-Encoding"] if compress else []
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            vary.append("Origin")
        if vary:
            self.send_header("Vary", ", ".join(vary))
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # The browser navigated away or cancelled the request. This is a
            # normal client-side abort, not a server error, so no traceback.
            self.close_connection = True

    def _error(self, error: ApiError) -> None:
        headers = {"Retry-After": str(error.message.split(":", 1)[1])} if error.status == 429 and error.message.startswith("retry:") else None
        message = "登录尝试过于频繁，请稍后再试" if headers else error.message
        self._send_json(error.status, {"ok": False, "error": message}, extra_headers=headers)

    def _read_json(self) -> dict[str, Any]:
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "请求必须使用 application/json")
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "不支持分块请求体")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ApiError(HTTPStatus.LENGTH_REQUIRED, "缺少 Content-Length")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length 无效") from error
        if length <= 0 or length > self.config.max_request_bytes:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "请求体为空或过大")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求 JSON 无效") from error
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求 JSON 必须是对象")
        return payload

    def _session_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except Exception:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _session(self, require_csrf: bool = False) -> tuple[str, str | None]:
        token = self._session_token()
        if not token:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "请先登录")
        csrf = self.headers.get("X-CSRF-Token") if require_csrf else None
        if require_csrf and not csrf:
            raise ApiError(HTTPStatus.FORBIDDEN, "缺少 CSRF 校验")
        if not self.database.validate_session(token_hash(token)):
            raise ApiError(HTTPStatus.UNAUTHORIZED, "登录已失效，请重新登录")
        if require_csrf and not self.database.validate_session(token_hash(token), token_hash(csrf)):
            raise ApiError(HTTPStatus.FORBIDDEN, "CSRF 操作凭据已更新，请刷新页面")
        return token, csrf

    def _connector(self) -> dict[str, Any]:
        authorization = self.headers.get("Authorization") or ""
        if not authorization.startswith("Bearer "):
            raise ApiError(HTTPStatus.UNAUTHORIZED, "connector 未配对")
        token = authorization[7:].strip()
        if len(token) < 32 or len(token) > 256:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "connector token 无效")
        connector = self.database.connector_by_token(token_hash(token))
        if not connector:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "connector token 已失效")
        return connector

    def _session_cookie(self, token: str, max_age: int) -> str:
        secure = "; Secure" if self.server.remote_connection else ""
        return f"{SESSION_COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{secure}"

    def _new_session(self) -> tuple[str, str]:
        session_token = token_urlsafe(32)
        csrf_token = self._session_csrf(session_token)
        self.database.create_session(
            token_hash(session_token), token_hash(csrf_token), self._remote_ip(), self.config.session_seconds
        )
        return session_token, csrf_token

    @staticmethod
    def _session_csrf(token: str) -> str:
        # Stable within one authenticated session, shared safely across its tabs.
        return hmac.new(token.encode("utf-8"), b"douyin-monitor-csrf-v1", hashlib.sha256).hexdigest()

    def do_OPTIONS(self) -> None:
        try:
            self._require_browser_origin()
            self.send_response(HTTPStatus.NO_CONTENT)
            origin = self._cors_origin()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "600")
                self.send_header("Vary", "Origin")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
        except ApiError as error:
            self._error(error)

    def do_GET(self) -> None:
        try:
            self._require_gateway()
            path = urlsplit(self.path).path
            if path == "/health":
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "service": "douyin-monitor-host",
                        "version": __version__,
                        "analysisProvider": self.config.analysis_provider,
                        "hostTime": utc_now(),
                        **({"remote": self.server.tunnel.status() if self.server.tunnel else {
                            "state": "blocked" if self.server.remote_error else "not_configured",
                            "lastError": self.server.remote_error,
                        }} if self._loopback() else {}),
                    },
                )
                return
            self._require_browser_origin()
            if path == "/api/auth/status":
                password_configured = bool(self.database.get_setting("password_hash"))
                token = self._session_token()
                authenticated = bool(token and self.database.validate_session(token_hash(token)))
                csrf_token = None
                if authenticated and token:
                    csrf_token = self._session_csrf(token)
                    if not self.database.rotate_session_csrf(token_hash(token), token_hash(csrf_token)):
                        authenticated = False
                        csrf_token = None
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "configured": password_configured,
                        "setupRequired": not password_configured,
                        "authenticated": authenticated,
                        "csrfToken": csrf_token,
                        "setupAllowed": self._local_dashboard() and not password_configured,
                        "localHost": self._loopback(),
                        "minPasswordLength": MIN_PASSWORD_LENGTH,
                    },
                )
                return
            self._session()
            if path.startswith('/api/wechat/'):
                self._wechat_request(path.removeprefix('/api/wechat/'))
                return
            if path.startswith("/api/previews/"):
                status_match = re.fullmatch(r"/api/previews/(\d{1,32})/status", path)
                if not status_match:
                    self._serve_preview(path, head=False)
                elif not self._known_video(status_match.group(1)):
                    raise ApiError(HTTPStatus.NOT_FOUND, "作品记录不存在")
                else:
                    # A plain status read never opens a detail page by itself.
                    self._send_json(HTTPStatus.OK, {"ok": True,
                        **self._preview_manager().status(status_match.group(1))})
            elif path == "/api/state":
                query = parse_qs(urlsplit(self.path).query)
                requested_limit = (query.get("videos") or [""])[0]
                if requested_limit and not requested_limit.isdigit():
                    raise ApiError(HTTPStatus.BAD_REQUEST, "作品数量范围无效")
                # Existing clients need the complete snapshot for account history,
                # charts and discoveries. Only explicitly limited reads are bounded.
                video_limit = int(requested_limit) if requested_limit else None
                state = self.database.state(video_limit=video_limit)
                if self.server.browser:
                    state["connector"] = self.server.browser.status()
                    state["browser"] = self.server.browser.status()
                addresses = set()
                try:
                    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                        address = ipaddress.ip_address(info[4][0])
                        if address.is_private and not address.is_loopback and not address.is_link_local:
                            addresses.add(f"http://{address}:{self.config.dashboard_port}")
                except OSError:
                    pass
                state["lanUrls"] = sorted(addresses)
                self._send_json(HTTPStatus.OK, {"ok": True, **state})
            elif path == "/api/jobs":
                query = parse_qs(urlsplit(self.path).query)
                limit = int((query.get("limit") or ["100"])[0])
                self._send_json(HTTPStatus.OK, {"ok": True, "jobs": self.database.list_jobs(limit)})
            elif path.startswith("/api/jobs/"):
                job = self.database.get_job(path.rsplit("/", 1)[1])
                if not job:
                    raise ApiError(HTTPStatus.NOT_FOUND, "任务不存在")
                self._send_json(HTTPStatus.OK, {"ok": True, "job": job})
            elif path in ("/api/qwen", "/api/qwen/status"):
                secret = self.server.secrets.load()
                client = analysis_client(self.config, secret)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "configured": client.configured,
                        "model": client._model(),
                        "analysisProvider": self.config.analysis_provider,
                        "cloudAsrConfigured": QwenClient(self.config, secret).configured,
                        "fallbackModel": "minimax-m3.1-flash" if self.config.analysis_provider == "codebuddy" else None,
                        "fps": self.config.qwen_fps,
                        "configurable": self._loopback(),
                    },
                )
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "接口不存在")
        except ApiError as error:
            self._error(error)
        except (ValueError, RuntimeError) as error:
            self._error(ApiError(HTTPStatus.BAD_REQUEST, str(error)))
        except Exception as error:
            print(f"[host-service] GET 未预期错误：{type(error).__name__}", flush=True)
            self._error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "主机服务发生未预期错误"))

    def do_HEAD(self) -> None:
        try:
            self._require_gateway()
            self._require_browser_origin()
            self._session()
            path = urlsplit(self.path).path
            if path.startswith("/api/previews/"):
                self._serve_preview(path, head=True)
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "接口不存在")
        except ApiError as error:
            self.send_response(error.status)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

    def _preview_manager(self) -> PreviewManager:
        manager = self.server.previews
        if manager is None:
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "在线播放服务未启动")
        return manager

    def _known_video(self, video_id: str) -> bool:
        if not re.fullmatch(r"\d{1,32}", video_id or ""):
            return False
        return bool(self.database.get_video(video_id))

    def _parse_range(self, header: str | None) -> tuple[str, int, int | None]:
        """Accept only the single byte ranges a media element actually sends."""
        if not header:
            return "full", 0, None
        parsed = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
        if not parsed or (not parsed.group(1) and not parsed.group(2)):
            return "unsatisfied", 0, None
        if not parsed.group(1):
            suffix = int(parsed.group(2))
            if suffix <= 0:
                return "unsatisfied", 0, None
            return "suffix", suffix, None
        start = int(parsed.group(1))
        end = int(parsed.group(2)) if parsed.group(2) else None
        if end is not None and end < start:
            return "unsatisfied", 0, None
        return "bounded", start, end

    def _serve_preview(self, path: str, *, head: bool) -> None:
        match = re.fullmatch(r"/api/previews/(\d{1,32})/([a-f0-9]{8,64})/media", path)
        if not match:
            raise ApiError(HTTPStatus.NOT_FOUND, "播放接口不存在")
        video_id, generation = match.group(1), match.group(2)
        if not self._known_video(video_id):
            raise ApiError(HTTPStatus.NOT_FOUND, "作品记录不存在")
        kind, start, end = self._parse_range(self.headers.get("Range"))
        if kind == "unsatisfied":
            raise ApiError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "无效的媒体读取范围")
        manager = self._preview_manager()
        try:
            # A suffix range needs the total length first; the manager resolves
            # it from the verified source before any client bytes are sent.
            if kind == "suffix":
                _, _, _, total, body = manager.play(video_id, generation, 0, 0)
                body.close()
                if start >= total:
                    self._range_unsatisfied(total)
                    return
                start = max(0, total - start)
                end = None
            source, resolved_start, resolved_end, total, body = manager.play(video_id, generation, start, end)
        except PreviewError as error:
            if error.status == 416:
                self._range_unsatisfied(self._known_total(video_id, generation))
                return
            raise ApiError(error.status, str(error))
        length = resolved_end - resolved_start + 1
        status = HTTPStatus.PARTIAL_CONTENT if kind != "full" else HTTPStatus.OK
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if kind != "full":
            self.send_header("Content-Range", f"bytes {resolved_start}-{resolved_end}/{total}")
            # A cross-origin media element must be allowed to read the range
            # metadata, otherwise seeking cannot be resolved.
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-site")
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Vary", "Origin")
        self.end_headers()
        if head:
            self._close_preview_body(body)
            return
        sent = 0
        try:
            for chunk in body:
                if not chunk:
                    continue
                self.wfile.write(chunk)
                sent += len(chunk)
                if sent >= length:
                    break
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # The player left or seeked elsewhere: stop reading upstream instead
            # of finishing the transfer nobody is watching.
            pass
        except PreviewError as error:
            # The media headers have already been sent. Appending an API error
            # response would corrupt the MP4 and its advertised byte range.
            self.close_connection = True
            print(f"[host-service] 播放传输中断（{type(error).__name__}）", flush=True)
        finally:
            self._close_preview_body(body)

    def _known_total(self, video_id: str, generation: str) -> int:
        """Best available total length for a 416 answer; 0 only if unknown."""
        source = self._preview_manager().source_for(video_id, generation)
        if source is None:
            return 0
        entry = self._preview_manager().cache.entry(
            self._preview_manager()._cache_key(video_id, source.generation))
        total = entry.total_bytes if entry is not None else None
        return int(total or source.content_length or 0)

    @staticmethod
    def _close_preview_body(body: Any) -> None:
        close = getattr(body, "close", None)
        if callable(close):
            close()

    def _range_unsatisfied(self, size: int) -> None:
        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        self.send_header("Content-Range", f"bytes */{size}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_POST(self) -> None:
        try:
            self._require_gateway()
            path = urlsplit(self.path).path
            if path.startswith("/connector/"):
                self._handle_connector(path)
                return
            self._require_browser_origin()
            if path == "/api/auth/setup":
                self._require_local_dashboard("首次密码只能在主机 localhost 页面设置")
                if self.database.get_setting("password_hash"):
                    raise ApiError(HTTPStatus.CONFLICT, "访问密码已经设置")
                payload = self._read_json()
                password = payload.get("password")
                if not isinstance(password, str):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "password 必须是字符串")
                encoded = password_hash(password)
                self.database.set_setting("password_hash", encoded)
                session_token, csrf_token = self._new_session()
                self._send_json(
                    HTTPStatus.CREATED,
                    {"ok": True, "authenticated": True, "csrfToken": csrf_token},
                    cookies=[self._session_cookie(session_token, self.config.session_seconds)],
                )
                return
            if path == "/api/auth/login":
                blocked = self.database.login_block_seconds(self._remote_ip())
                if blocked:
                    raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, f"retry:{blocked}")
                payload = self._read_json()
                password = payload.get("password")
                encoded = self.database.get_setting("password_hash")
                if not encoded:
                    raise ApiError(HTTPStatus.PRECONDITION_REQUIRED, "请先在主机本机设置访问密码")
                success = isinstance(password, str) and verify_password(password, encoded)
                self.database.record_login(self._remote_ip(), success)
                if not success:
                    raise ApiError(HTTPStatus.UNAUTHORIZED, "访问密码错误")
                session_token, csrf_token = self._new_session()
                self._send_json(
                    HTTPStatus.OK,
                    {"ok": True, "authenticated": True, "csrfToken": csrf_token},
                    cookies=[self._session_cookie(session_token, self.config.session_seconds)],
                )
                return
            if path == "/api/auth/logout":
                session_token, _ = self._session(require_csrf=True)
                self.database.delete_session(token_hash(session_token))
                self._send_json(
                    HTTPStatus.OK,
                    {"ok": True},
                    cookies=[self._session_cookie("", 0)],
                )
                return

            self._session(require_csrf=True)
            payload = self._read_json()
            if path.startswith('/api/wechat/'):
                self._wechat_request(path.removeprefix('/api/wechat/'), payload)
                return
            if path == "/api/browser/open":
                self._require_local_dashboard("请在电脑工作台打开专用浏览器并完成抖音登录")
                if not self.server.browser:
                    raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "专用浏览器服务未启动")
                self.server.browser.open()
                self._send_json(HTTPStatus.ACCEPTED, {"ok": True, "message": "正在电脑打开抖音登录窗口"})
            elif path == "/api/browser/resume-collection":
                if not self.server.browser:
                    raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "专用浏览器服务未启动")
                self.server.browser.resume_collection()
                self._send_json(HTTPStatus.OK, {"ok": True})
            elif path == "/api/migrate":
                self._require_local_dashboard("旧数据迁移只能在主机 localhost 页面执行")
                backup_name = datetime.now(timezone.utc).strftime("migration-%Y%m%dT%H%M%S-") + uuid.uuid4().hex[:8] + ".json"
                backup_path = self.config.backup_dir / backup_name
                temporary = backup_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                os.replace(temporary, backup_path)
                counts = self.database.migrate(payload)
                actual = self.database.state()
                if len(actual["accounts"]) < counts["accounts"] or len(actual["videos"]) < counts["videos"]:
                    raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "迁移计数校验失败；旧浏览器数据未删除")
                self._send_json(HTTPStatus.OK, {"ok": True, "counts": counts, "backupCreated": True})
            elif path == "/api/previews/prepare":
                # Registering a preview only resolves a low-resolution address for
                # already-saved works. It never downloads media, never touches the
                # analysis pipeline and never calls a paid model.
                raw_ids = payload.get("videoIds")
                if not isinstance(raw_ids, list) or not raw_ids:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "videoIds 必须是非空数组")
                candidate_ids = list(dict.fromkeys(str(value) for value in raw_ids))
                if len(candidate_ids) > self.config.preview_max_prepare_ids:
                    raise ApiError(HTTPStatus.BAD_REQUEST,
                                   f"单次最多准备 {self.config.preview_max_prepare_ids} 个播放源")
                if not all(self._known_video(video_id) for video_id in candidate_ids):
                    raise ApiError(HTTPStatus.NOT_FOUND, "作品记录不存在")
                results = self._preview_manager().prepare(candidate_ids)
                self._send_json(HTTPStatus.ACCEPTED, {"ok": True, "sources": results})
            elif path == "/api/discoveries/clear":
                cleared = self.database.clear_discoveries(payload.get("videoIds"))
                self._send_json(HTTPStatus.OK, {"ok": True, "clearedCount": cleared})
            elif path == "/api/accounts/ack-updates":
                accounts = payload.get("accounts")
                if not isinstance(accounts, list):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "accounts 必须是数组")
                self.database.acknowledge_account_updates(accounts)
                self._send_json(HTTPStatus.OK, {"ok": True})
            elif path == "/api/accounts/upsert":
                account = payload.get("account")
                if not isinstance(account, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "account 必须是对象")
                job, created = None, False
                if payload.get("enqueueInitial") is True:
                    saved, job, created = self.database.add_account_with_initial_job(account)
                else:
                    saved = self.database.upsert_account(account)
                self._send_json(HTTPStatus.OK, {"ok": True, "account": saved,
                    "reused": str(saved["id"]) != str(account.get("id")), "job": job, "created": created})
            elif path == "/api/accounts/remove":
                removed = self.database.remove_account(str(payload.get("accountId") or ""))
                self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed})
            elif path == "/api/video-links/analyze":
                resolved = resolve_douyin_video_link(str(payload.get("shareText") or payload.get("url") or ""))
                existing_video = self.database.get_video(resolved.video_id)
                if existing_video and existing_video.get("transcriptStatus") == "ready" and all(analysis_section_status(existing_video.get("analysis")).values()):
                    self.database.upsert_link_video(resolved.video_id, resolved.canonical_url, resolved.source_url)
                    self._send_json(HTTPStatus.OK, {"ok": True, "reused": True, "video": self.database.get_video(resolved.video_id)})
                    return
                if not analysis_client(self.config, self.server.secrets.load()).configured:
                    raise ApiError(HTTPStatus.PRECONDITION_REQUIRED, "视频分析服务尚未就绪，请检查主机的模型配置或 CodeBuddy 登录")
                if not self._analysis_capture_ready():
                    raise ApiError(
                        HTTPStatus.PRECONDITION_REQUIRED,
                        ("电脑专用浏览器服务尚未就绪，请检查电脑工作台状态" if self.server.browser else f"主机 Chrome 需要已连接的 v{MINIMUM_ANALYSIS_EXTENSION_VERSION} 或更高版本组件，并具备 AI 视频分析能力"),
                    )
                video = self.database.upsert_link_video(
                    resolved.video_id,
                    resolved.canonical_url,
                    resolved.source_url,
                )
                if video.get("transcriptStatus") == "ready" and all(analysis_section_status(video.get("analysis")).values()):
                    self._send_json(HTTPStatus.OK, {"ok": True, "reused": True, "video": self.database.get_video(resolved.video_id)})
                    return
                job_payload = {
                    "accountId": video.get("accountId"),
                    "videoId": video.get("id"),
                    "videoUrl": video.get("url") or resolved.canonical_url,
                    "title": video.get("title"),
                    "description": video.get("description"),
                    "authorName": video.get("authorName"),
                    "sourceKind": "video_link",
                    **({"retry": True} if video.get("analysis") or video.get("analysisStatus") in {"error", "cancelled"} else {}),
                }
                job, created = self.database.create_job("analyze_video", job_payload)
                self._send_json(
                    HTTPStatus.CREATED if created else HTTPStatus.OK,
                    {"ok": True, "reused": False, "created": created, "video": self.database.get_video(resolved.video_id), "job": job},
                )
            elif path.startswith("/api/jobs/") and path.endswith("/cancel"):
                job_id = path[len("/api/jobs/"):-len("/cancel")]
                current = self.database.get_job(job_id)
                if not current or current.get("type") != "analyze_video":
                    raise ApiError(HTTPStatus.NOT_FOUND, "视频分析任务不存在")
                job = self.database.cancel_job(job_id)
                self._send_json(HTTPStatus.OK, {"ok": True, "job": job})
            elif path == "/api/jobs":
                requested_type = payload.get("type")
                job_payload = payload.get("payload")
                if not isinstance(requested_type, str) or not isinstance(job_payload, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "type 与 payload 无效")
                if requested_type == "transcribe_video":
                    video_id = str(job_payload.get("videoId") or "")
                    video = self.database.get_video(video_id)
                    if not video:
                        raise ApiError(HTTPStatus.NOT_FOUND, "视频不存在")
                    if not self.config.auto_transcribe or not self.server.transcriptions:
                        raise ApiError(HTTPStatus.PRECONDITION_REQUIRED, "电脑本地口播识别服务尚未启动")
                    queued = self.database.queue_transcription(video_id, retry=job_payload.get("retry") is True)
                    self.database.prioritize_transcription(video_id)
                    self._send_json(HTTPStatus.OK, {"ok": True, "queued": queued is not None,
                                                  "video": self.database.get_video(video_id)})
                    return
                canonical_type = CANONICAL_JOB_TYPES.get(requested_type)
                if canonical_type == "analyze_video":
                    video = self.database.get_video(str(job_payload.get("videoId") or ""))
                    if not video:
                        raise ApiError(HTTPStatus.NOT_FOUND, "分析目标视频不存在")
                    if str(video.get("accountId") or "") != str(job_payload.get("accountId") or ""):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "分析目标视频与监控账号不匹配")
                    if job_payload.get("forceRegenerate") is not True and video.get("transcriptStatus") == "ready" and all(analysis_section_status(video.get("analysis")).values()):
                        latest = next((job for job in self.database.list_jobs(500) if job.get("type") == "analyze_video" and str(job.get("payload", {}).get("videoId")) == str(video["id"])), None)
                        self._send_json(HTTPStatus.OK, {"ok": True, "reused": True, "created": False, "video": video, "job": latest})
                        return
                    if not analysis_client(self.config, self.server.secrets.load()).configured:
                        raise ApiError(HTTPStatus.PRECONDITION_REQUIRED, "视频分析服务尚未就绪，请检查主机的模型配置或 CodeBuddy 登录")
                    if not self._analysis_capture_ready():
                        raise ApiError(
                            HTTPStatus.PRECONDITION_REQUIRED,
                            ("电脑专用浏览器服务尚未就绪，请检查电脑工作台状态" if self.server.browser else f"主机 Chrome 需要已连接的 v{MINIMUM_ANALYSIS_EXTENSION_VERSION} 或更高版本组件，并具备 AI 视频分析能力"),
                        )
                    job_payload = dict(job_payload)
                    if job_payload.get("forceRegenerate") is True:
                        job_payload["retry"] = True
                    job_payload.setdefault("videoUrl", video.get("url"))
                    job_payload.setdefault("title", video.get("title"))
                    job_payload.setdefault("description", video.get("description"))
                    # Only the host's record for this exact video may fill
                    # metadata that a lazy-rendered detail page omits.
                    job_payload["savedVideoMetadata"] = {
                        "videoId": str(video["id"]),
                        "description": video.get("description") or video.get("title"),
                        **{key: video.get(key) for key in (
                            "coverUrl", "authorName", "authorAvatarUrl", "authorProfileUrl"
                        )},
                    }
                    if video.get("isLinkAnalysis") is True:
                        job_payload["sourceKind"] = "video_link"
                job, created = self.database.create_job(requested_type, job_payload)
                self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"ok": True, "created": created, "job": job})
            elif path in ("/api/qwen", "/api/qwen/config"):
                self._require_local_dashboard("API Key 只能在主机 localhost 页面配置")
                if payload.get("clear") is True:
                    self.server.secrets.clear()
                else:
                    api_key = payload.get("apiKey")
                    if not isinstance(api_key, str) or not 8 <= len(api_key.strip()) <= 512:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "API Key 格式无效")
                    self.server.secrets.save(
                        {
                            "apiKey": api_key.strip(),
                            "model": self.config.qwen_model,
                            "savedAt": utc_now(),
                        }
                    )
                self._send_json(
                    HTTPStatus.OK,
                    {"ok": True, "configured": self.server.secrets.load() is not None, "model": self.config.qwen_model},
                )
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "接口不存在")
        except ApiError as error:
            self._error(error)
        except ValueError as error:
            self._error(ApiError(HTTPStatus.BAD_REQUEST, str(error)))
        except Exception as error:
            print(f"[host-service] POST 未预期错误：{type(error).__name__}", flush=True)
            self._error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "主机服务发生未预期错误"))

    def _analysis_capture_ready(self) -> bool:
        if self.server.browser:
            return bool(self.server.browser.status()["connected"])
        return self.database.connector_supports(
            "analyze_video", min_version=MINIMUM_ANALYSIS_EXTENSION_VERSION,
            fresh_within_seconds=CONNECTOR_FRESHNESS_SECONDS,
        )

    def _handle_connector(self, path: str) -> None:
        if self.server.browser:
            # The host is the sole queue consumer; installed legacy extensions must not race it.
            self._read_json()
            raise ApiError(HTTPStatus.CONFLICT, "采集已改由电脑专用浏览器执行，无需扩展")
        if not self._loopback():
            raise ApiError(HTTPStatus.FORBIDDEN, "connector 仅允许主机 Chrome 访问")
        if path == "/connector/pair":
            payload = self._read_json()
            extension_id = payload.get("extensionId")
            origin_id = _extension_origin_id(self.headers.get("Origin"))
            if not isinstance(extension_id, str) or not EXTENSION_ID_PATTERN.fullmatch(extension_id):
                raise ApiError(HTTPStatus.BAD_REQUEST, "extensionId 无效")
            if not self.config.testing and origin_id != extension_id:
                raise ApiError(HTTPStatus.FORBIDDEN, "扩展来源与 extensionId 不一致")
            connector_id = str(uuid.uuid4())
            connector_token = token_urlsafe(48)
            extension_version = str(payload.get("extensionVersion") or "")
            capabilities = effective_connector_capabilities(
                extension_version,
                payload.get("capabilities") if isinstance(payload.get("capabilities"), list) else [],
            )
            self.database.pair_connector(
                extension_id,
                str(payload.get("label") or "主机 Chrome")[:128],
                connector_id,
                token_hash(connector_token),
                extension_version,
                capabilities,
                str(payload.get("workerId") or ""),
            )
            self._send_json(
                HTTPStatus.CREATED,
                {"ok": True, "connectorId": connector_id, "token": connector_token, "pollSeconds": 45},
            )
            return
        connector = self._connector()
        payload = self._read_json()
        if path == "/connector/jobs/claim":
            requested_capabilities = payload.get("capabilities")
            if requested_capabilities is not None and not isinstance(requested_capabilities, list):
                raise ApiError(HTTPStatus.BAD_REQUEST, "capabilities 必须是数组")
            extension_version = str(payload.get("extensionVersion") or "")
            capabilities = effective_connector_capabilities(
                extension_version,
                requested_capabilities if isinstance(requested_capabilities, list) else [],
            )
            self.database.update_connector_runtime(
                connector["id"],
                extension_version=extension_version,
                capabilities=capabilities,
                worker_id=str(payload.get("workerId") or ""),
                worker_status="polling",
            )
            job = self.database.claim_job(connector["id"], capabilities)
            self.database.update_connector_runtime(
                connector["id"],
                worker_status="running" if job else "idle",
                active_job_id=str(job["id"]) if job else None,
            )
            self._send_json(HTTPStatus.OK, {"ok": True, "job": job})
        elif path == "/connector/heartbeat":
            job_id = payload.get("jobId")
            extension_version = str(payload.get("extensionVersion") or "")
            requested_capabilities = payload.get("capabilities")
            capabilities = effective_connector_capabilities(
                extension_version,
                requested_capabilities if isinstance(requested_capabilities, list) else [],
            ) if isinstance(requested_capabilities, list) else None
            self.database.update_connector_runtime(
                connector["id"],
                extension_version=extension_version,
                capabilities=capabilities,
                worker_id=str(payload.get("workerId") or ""),
                worker_status=str(payload.get("status") or "idle"),
                active_job_id=str(job_id) if job_id else None,
            )
            job = self.database.heartbeat_job(
                connector["id"],
                str(job_id) if job_id else None,
                str(payload.get("claimToken") or "") or None,
            )
            accounts = [
                {
                    "id": account.get("id"),
                    "url": account.get("url"),
                    "name": account.get("name"),
                    "platform": account.get("platform"),
                    "initialSyncStatus": account.get("initialSyncStatus"),
                }
                for account in self.database.state()["accounts"]
                if account.get("platform", "douyin") == "douyin"
            ]
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "job": job,
                    "accounts": accounts,
                    "serverTime": utc_now(),
                },
            )
        elif path == "/connector/events":
            event_id = payload.get("eventId")
            event_type = payload.get("type")
            event_payload = payload.get("payload") or {}
            job_id_value = payload.get("jobId")
            claim_token_value = payload.get("claimToken")
            if not isinstance(event_id, str) or not isinstance(event_type, str) or not isinstance(event_payload, dict):
                raise ApiError(HTTPStatus.BAD_REQUEST, "connector 事件格式无效")
            aliases = {
                "COLLECTION_RESULT": "collection_result",
                "COLLECTION_COMPLETE": "collection_result" if event_payload.get("videos") else "job_completed",
                "BATCH_COMPLETE": "job_completed",
                "COLLECTION_ERROR": "job_failed",
                "analysis_capture": "analysis_media",
            }
            normalized_type = aliases.get(event_type, event_type)
            duplicate, job = self.database.process_connector_event(
                connector["id"],
                str(job_id_value) if job_id_value else None,
                str(claim_token_value) if claim_token_value else None,
                event_id,
                normalized_type,
                event_payload,
            )
            if normalized_type == "analysis_media" and not duplicate and job_id_value:
                self.server.analysis.submit(str(job_id_value), event_payload)
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "acknowledged": True,
                    "eventId": event_id,
                    "duplicate": duplicate,
                    "job": job,
                },
            )
        else:
            raise ApiError(HTTPStatus.NOT_FOUND, "connector 接口不存在")


def create_server(config: HostConfig | None = None) -> HostHTTPServer:
    active_config = config or HostConfig.from_env()
    if config is None and not active_config.testing and "DOUYIN_ANALYSIS_PROVIDER" not in os.environ:
        active_config = replace(active_config, analysis_provider="codebuddy")
    active_config.ensure_directories()
    cleanup_stale_temp(active_config.temp_dir)
    database = Database(active_config)
    database.initialize()
    database.normalize_saved_transcripts()
    database.mark_stale_analysis_failed()
    secrets = SecretStore(active_config.secret_path, testing=active_config.testing)
    analysis = AnalysisManager(active_config, database, secrets)
    analysis.recover_pending_results()
    server = HostHTTPServer(
        (active_config.listen_host, active_config.listen_port), active_config, database, secrets, analysis
    )
    if not active_config.testing:
        server.browser = BrowserManager(active_config, database, analysis)
        server.browser.start()
        # On-demand playback resolves a source through the same dedicated
        # browser, so both listeners share one manager and one memory budget.
        server.previews = PreviewManager(active_config, database, server.browser)
        if active_config.auto_transcribe:
            server.transcriptions = TranscriptionManager(active_config, database, server.browser.capture_transcription_media)
            analysis.local_transcriber = server.transcriptions
            server.transcriptions.start()
    return server


def create_remote_gateway(host: HostHTTPServer, connection: RemoteConnection, port: int = GATEWAY_PORT) -> HostHTTPServer:
    gateway = HostHTTPServer(
        ("127.0.0.1", port), host.config, host.database, host.secrets, host.analysis, connection,
    )
    gateway.browser = host.browser
    # One preview manager serves both listeners, so a source resolved on the
    # local network can be streamed through the remote gateway and back.
    gateway.previews = host.previews
    gateway.transcriptions = host.transcriptions
    return gateway


def main() -> None:
    server = create_server()
    gateway = None
    tunnel = None
    try:
        connection = RemoteConnection.load(server.config)
        if connection:
            gateway = create_remote_gateway(server, connection)
            threading.Thread(target=gateway.serve_forever, daemon=True, name="remote-gateway").start()
            tunnel = TunnelProcess(server.config, connection)
            server.tunnel = tunnel
            tunnel.start()
            print("[remote-host] 仅本机远程入口已启动；通道由后台自动检查和恢复", flush=True)
    except Exception as error:
        # Local history and capture remain available if optional remote setup is
        # broken. No exception text here: encrypted config can contain secrets.
        server.remote_error = f"远程连接启动失败（{type(error).__name__}）；请检查本机连接配置，本机服务继续运行"
        print(f"[remote-host] {server.remote_error}", flush=True)
    print(
        f"[host-service] 已监听 http://{server.config.listen_host}:{server.config.listen_port} "
        f"（数据目录 {server.config.data_dir}，视频分析 {server.config.analysis_provider}）",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        if tunnel:
            tunnel.shutdown()
        if gateway:
            gateway.shutdown()
            gateway.server_close()
        server.shutdown()
        server.server_close()
        server.analysis.shutdown()
        print("[host-service] 已停止", flush=True)


if __name__ == "__main__":
    main()
