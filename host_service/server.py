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
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .analysis import AnalysisManager
from .config import HostConfig
from .database import CANONICAL_JOB_TYPES, Database, utc_now
from .media import cleanup_stale_temp
from .qwen import QwenClient
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
    if hostname in {"localhost", "127.0.0.1", "::1", socket.gethostname().lower(), socket.getfqdn().lower()}:
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
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
    ) -> None:
        super().__init__(address, HostRequestHandler)
        self.config = config
        self.database = database
        self.secrets = secrets
        self.analysis = analysis


class HostRequestHandler(BaseHTTPRequestHandler):
    server_version = "DouyinMonitorHost/0.1"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    server: HostHTTPServer

    def log_message(self, _format: str, *_args: Any) -> None:
        # Bodies and URLs may contain signed CDN values.  Never log requests.
        return

    @property
    def config(self) -> HostConfig:
        return self.server.config

    @property
    def database(self) -> Database:
        return self.server.database

    def _remote_ip(self) -> str:
        return self.client_address[0].split("%", 1)[0]

    def _loopback(self) -> bool:
        return _is_loopback(self._remote_ip())

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

    def _cors_origin(self) -> str | None:
        origin = self.headers.get("Origin")
        return origin if origin and _private_dashboard_origin(origin, self.config.dashboard_port) else None

    def _require_browser_origin(self) -> None:
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
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-site")
        self.send_header("Connection", "close")
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

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
        if not self.database.validate_session(token_hash(token), token_hash(csrf) if csrf else None):
            raise ApiError(HTTPStatus.UNAUTHORIZED, "登录已失效，请重新登录")
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

    @staticmethod
    def _session_cookie(token: str, max_age: int) -> str:
        return f"{SESSION_COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict"

    def _new_session(self) -> tuple[str, str]:
        session_token = token_urlsafe(32)
        csrf_token = token_urlsafe(32)
        self.database.create_session(
            token_hash(session_token), token_hash(csrf_token), self._remote_ip(), self.config.session_seconds
        )
        return session_token, csrf_token

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
            path = urlsplit(self.path).path
            if path == "/health":
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "service": "douyin-monitor-host",
                        "version": __version__,
                        "hostTime": utc_now(),
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
                    csrf_token = token_urlsafe(32)
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
            if path == "/api/state":
                self._send_json(HTTPStatus.OK, {"ok": True, **self.database.state()})
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
                client = QwenClient(self.config, secret)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "configured": client.configured,
                        "model": str((secret or {}).get("model") or self.config.qwen_model),
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

    def do_POST(self) -> None:
        try:
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
            if path == "/api/migrate":
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
            elif path == "/api/accounts/upsert":
                account = payload.get("account")
                if not isinstance(account, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "account 必须是对象")
                self._send_json(HTTPStatus.OK, {"ok": True, "account": self.database.upsert_account(account)})
            elif path == "/api/accounts/remove":
                removed = self.database.remove_account(str(payload.get("accountId") or ""))
                self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed})
            elif path == "/api/jobs":
                requested_type = payload.get("type")
                job_payload = payload.get("payload")
                if not isinstance(requested_type, str) or not isinstance(job_payload, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "type 与 payload 无效")
                canonical_type = CANONICAL_JOB_TYPES.get(requested_type)
                if canonical_type == "analyze_video":
                    if not QwenClient(self.config, self.server.secrets.load()).configured:
                        raise ApiError(HTTPStatus.PRECONDITION_REQUIRED, "请先在主机 localhost 页面配置 Qwen API Key")
                    if not self.database.connector_supports("analyze_video"):
                        raise ApiError(
                            HTTPStatus.PRECONDITION_REQUIRED,
                            "主机 Chrome 组件尚未加载 AI 视频分析能力，请更新一次组件；之后会自动连接",
                        )
                    video = self.database.get_video(str(job_payload.get("videoId") or ""))
                    if not video:
                        raise ApiError(HTTPStatus.NOT_FOUND, "分析目标视频不存在")
                    if str(video.get("accountId") or "") != str(job_payload.get("accountId") or ""):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "分析目标视频与监控账号不匹配")
                    job_payload = dict(job_payload)
                    job_payload.setdefault("videoUrl", video.get("url"))
                    job_payload.setdefault("title", video.get("title"))
                    job_payload.setdefault("description", video.get("description"))
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

    def _handle_connector(self, path: str) -> None:
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
            self.database.pair_connector(
                extension_id,
                str(payload.get("label") or "主机 Chrome")[:128],
                connector_id,
                token_hash(connector_token),
                str(payload.get("extensionVersion") or ""),
                payload.get("capabilities") if isinstance(payload.get("capabilities"), list) else [],
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
            capabilities = payload.get("capabilities")
            if capabilities is not None and not isinstance(capabilities, list):
                raise ApiError(HTTPStatus.BAD_REQUEST, "capabilities 必须是数组")
            self.database.update_connector_runtime(
                connector["id"],
                extension_version=str(payload.get("extensionVersion") or ""),
                capabilities=capabilities if isinstance(capabilities, list) else [],
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
            self.database.update_connector_runtime(
                connector["id"],
                extension_version=str(payload.get("extensionVersion") or ""),
                capabilities=payload.get("capabilities") if isinstance(payload.get("capabilities"), list) else None,
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
                    "scheduler": {"periodMinutes": 360, "authoritative": True},
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
    active_config.ensure_directories()
    cleanup_stale_temp(active_config.temp_dir)
    database = Database(active_config)
    database.initialize()
    database.mark_stale_analysis_failed()
    secrets = SecretStore(active_config.secret_path, testing=active_config.testing)
    analysis = AnalysisManager(active_config, database, secrets)
    return HostHTTPServer(
        (active_config.listen_host, active_config.listen_port), active_config, database, secrets, analysis
    )


def main() -> None:
    server = create_server()
    print(
        f"[host-service] 已监听 http://{server.config.listen_host}:{server.config.listen_port} "
        f"（数据目录 {server.config.data_dir}，Qwen {server.config.qwen_model}，完整视频 fps={server.config.qwen_fps}）",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        server.analysis.shutdown()
        print("[host-service] 已停止", flush=True)


if __name__ == "__main__":
    main()
