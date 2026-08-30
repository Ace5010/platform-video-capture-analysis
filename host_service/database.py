"""SQLite persistence and queue primitives for the host service."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import HostConfig


CANONICAL_JOB_TYPES = {
    "collect_latest": "collect_latest",
    "collection_latest": "collect_latest",
    "collection.latest": "collect_latest",
    "archive_account": "archive_account",
    "archive30": "archive_account",
    "collection_initial": "archive_account",
    "collection.initial": "archive_account",
    "analyze_video": "analyze_video",
    "analysis_capture": "analyze_video",
    "analysis.video": "analyze_video",
}
ACTIVE_JOB_STATUSES = ("queued", "claimed", "running")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _object(value: Any, name: str = "value") -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} 必须是对象")
    return value


def _identifier(value: Any, name: str) -> str:
    if not isinstance(value, (str, int)):
        raise ValueError(f"{name} 无效")
    result = str(value).strip()
    if not result or len(result) > 256:
        raise ValueError(f"{name} 无效")
    return result


def _job_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "type": row["type"],
        "payload": json.loads(row["payload_json"]),
        "status": row["status"],
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "error": row["error"],
        "progress": json.loads(row["progress_json"]) if row["progress_json"] else None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": datetime.fromtimestamp(row["expires_at"], timezone.utc).isoformat().replace("+00:00", "Z"),
        "claimedBy": row["claimed_by"],
        "attemptCount": row["attempt_count"],
    }


class Database:
    def __init__(self, config: HostConfig) -> None:
        self.config = config
        self.path = config.db_path
        self._schema_lock = threading.Lock()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    def initialize(self) -> None:
        self.config.ensure_directories()
        with self._schema_lock, closing(self.connect()) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    csrf_hash TEXT NOT NULL,
                    remote_ip TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    remote_ip TEXT NOT NULL,
                    attempted_at INTEGER NOT NULL,
                    success INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(remote_ip, attempted_at);
                CREATE TABLE IF NOT EXISTS connectors (
                    id TEXT PRIMARY KEY,
                    extension_id TEXT NOT NULL UNIQUE,
                    label TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT,
                    revoked_at TEXT
                );
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY,
                    platform TEXT NOT NULL,
                    url TEXT NOT NULL,
                    name TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_platform_url ON accounts(platform, url);
                CREATE TABLE IF NOT EXISTS videos (
                    id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    source_hash TEXT,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_videos_account ON videos(account_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
                    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    captured_at TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    UNIQUE(video_id, captured_at)
                );
                CREATE INDEX IF NOT EXISTS idx_snapshots_account_time ON snapshots(account_id, captured_at);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    result_json TEXT,
                    progress_json TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    created_epoch INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    claimed_by TEXT REFERENCES connectors(id),
                    claim_until INTEGER,
                    attempt_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_epoch);
                CREATE TABLE IF NOT EXISTS processed_events (
                    connector_id TEXT NOT NULL REFERENCES connectors(id),
                    event_id TEXT NOT NULL,
                    job_id TEXT REFERENCES jobs(id),
                    processed_at TEXT NOT NULL,
                    PRIMARY KEY(connector_id, event_id)
                );
                CREATE TABLE IF NOT EXISTS analysis_runs (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
                    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
                    source_hash TEXT,
                    analysis_version TEXT NOT NULL,
                    status TEXT NOT NULL,
                    transcript TEXT,
                    analysis_json TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(video_id, source_hash, analysis_version)
                );
                """
            )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def get_setting(self, key: str) -> str | None:
        with closing(self.connect()) as connection:
            row = connection.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str, connection: sqlite3.Connection | None = None) -> None:
        now = utc_now()
        if connection is not None:
            connection.execute(
                "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (key, value, now),
            )
            return
        with self.transaction() as transaction:
            self.set_setting(key, value, transaction)

    def create_session(self, token_hash: str, csrf_hash: str, remote_ip: str, ttl: int) -> None:
        now = int(time.time())
        with self.transaction() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
            connection.execute(
                "INSERT INTO sessions(token_hash,csrf_hash,remote_ip,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)",
                (token_hash, csrf_hash, remote_ip, now, now + ttl, now),
            )

    def validate_session(self, session_hash: str, csrf_hash: str | None = None) -> bool:
        now = int(time.time())
        with self.transaction() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
            row = connection.execute(
                "SELECT csrf_hash FROM sessions WHERE token_hash=? AND expires_at>?",
                (session_hash, now),
            ).fetchone()
            if not row or (csrf_hash is not None and row["csrf_hash"] != csrf_hash):
                return False
            connection.execute("UPDATE sessions SET last_seen_at=? WHERE token_hash=?", (now, session_hash))
            return True

    def rotate_session_csrf(self, session_hash: str, csrf_hash: str) -> bool:
        now = int(time.time())
        with self.transaction() as connection:
            changed = connection.execute(
                "UPDATE sessions SET csrf_hash=?,last_seen_at=? WHERE token_hash=? AND expires_at>?",
                (csrf_hash, now, session_hash, now),
            ).rowcount
        return bool(changed)

    def delete_session(self, session_hash: str) -> None:
        with self.transaction() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (session_hash,))

    def login_block_seconds(self, remote_ip: str) -> int:
        now = int(time.time())
        window_start = now - 900
        with closing(self.connect()) as connection:
            rows = connection.execute(
                "SELECT attempted_at FROM login_attempts WHERE remote_ip=? AND success=0 AND attempted_at>=? "
                "ORDER BY attempted_at DESC LIMIT 5",
                (remote_ip, window_start),
            ).fetchall()
        if len(rows) < 5:
            return 0
        return max(1, rows[0]["attempted_at"] + 900 - now)

    def record_login(self, remote_ip: str, success: bool) -> None:
        now = int(time.time())
        with self.transaction() as connection:
            connection.execute(
                "INSERT INTO login_attempts(remote_ip,attempted_at,success) VALUES(?,?,?)",
                (remote_ip, now, 1 if success else 0),
            )
            if success:
                connection.execute("DELETE FROM login_attempts WHERE remote_ip=? AND success=0", (remote_ip,))
            connection.execute("DELETE FROM login_attempts WHERE attempted_at<?", (now - 86400,))

    def pair_connector(self, extension_id: str, label: str, connector_id: str, connector_token_hash: str) -> None:
        with self.transaction() as connection:
            active = connection.execute(
                "SELECT id FROM connectors WHERE extension_id=? AND revoked_at IS NULL", (extension_id,)
            ).fetchone()
            if active:
                connection.execute(
                    "UPDATE connectors SET label=?,token_hash=?,last_seen_at=?,revoked_at=NULL WHERE id=?",
                    (label, connector_token_hash, utc_now(), active["id"]),
                )
                return
            connection.execute(
                "INSERT INTO connectors(id,extension_id,label,token_hash,created_at) VALUES(?,?,?,?,?)",
                (connector_id, extension_id, label, connector_token_hash, utc_now()),
            )

    def connector_by_token(self, connector_token_hash: str) -> dict[str, Any] | None:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT * FROM connectors WHERE token_hash=? AND revoked_at IS NULL", (connector_token_hash,)
            ).fetchone()
        return dict(row) if row else None

    def touch_connector(self, connector_id: str) -> None:
        with self.transaction() as connection:
            connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))

    def connector_status(self) -> dict[str, Any]:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT label,created_at,last_seen_at FROM connectors "
                "WHERE revoked_at IS NULL ORDER BY COALESCE(last_seen_at,created_at) DESC LIMIT 1"
            ).fetchone()
        if not row:
            return {"connected": False, "paired": False, "lastSeenAt": None}
        last_seen = row["last_seen_at"]
        connected = False
        if last_seen:
            try:
                observed = datetime.fromisoformat(str(last_seen).replace("Z", "+00:00"))
                connected = (datetime.now(timezone.utc) - observed).total_seconds() <= 150
            except ValueError:
                connected = False
        return {
            "connected": connected,
            "paired": True,
            "lastSeenAt": last_seen,
            "label": row["label"],
        }

    @staticmethod
    def _upsert_account(connection: sqlite3.Connection, raw: dict[str, Any]) -> dict[str, Any]:
        incoming = dict(_object(raw, "account"))
        account_id = _identifier(incoming.get("id"), "account.id")
        current = connection.execute("SELECT data_json FROM accounts WHERE id=?", (account_id,)).fetchone()
        account = json.loads(current["data_json"]) if current else {}
        account.update({key: value for key, value in incoming.items() if value is not None})
        platform = str(account.get("platform") or "douyin")[:64]
        url = str(account.get("url") or "")[:4096]
        name = str(account.get("name") or "待识别账号")[:512]
        account.update({"id": account_id, "platform": platform, "url": url, "name": name})
        now = utc_now()
        connection.execute(
            "INSERT INTO accounts(id,platform,url,name,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,url=excluded.url,name=excluded.name,"
            "data_json=excluded.data_json,updated_at=excluded.updated_at",
            (account_id, platform, url, name, _compact_json(account), now, now),
        )
        return account

    def upsert_account(self, account: dict[str, Any]) -> dict[str, Any]:
        with self.transaction() as connection:
            return self._upsert_account(connection, account)

    def remove_account(self, account_id: str) -> bool:
        account_id = _identifier(account_id, "accountId")
        with self.transaction() as connection:
            jobs = connection.execute(
                "SELECT id,payload_json FROM jobs WHERE status IN ('queued','claimed')"
            ).fetchall()
            for job in jobs:
                payload = json.loads(job["payload_json"])
                matches_single = str(payload.get("accountId") or "") == account_id
                account_ids = payload.get("accountIds")
                matches_list = isinstance(account_ids, list) and account_id in [str(item) for item in account_ids]
                if matches_single or matches_list:
                    connection.execute(
                        "UPDATE jobs SET status='cancelled',error=?,updated_at=? WHERE id=?",
                        ("监控账号已移除", utc_now(), job["id"]),
                    )
            removed = connection.execute("DELETE FROM accounts WHERE id=?", (account_id,)).rowcount
        return bool(removed)

    @staticmethod
    def _upsert_video(connection: sqlite3.Connection, raw: dict[str, Any]) -> dict[str, Any]:
        video = dict(_object(raw, "video"))
        for removed_metric in ("playCount", "play_count", "viewCount", "view_count"):
            video.pop(removed_metric, None)
        video_id = _identifier(video.get("id"), "video.id")
        account_id = _identifier(video.get("accountId"), "video.accountId")
        exists = connection.execute("SELECT id FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not exists:
            raise ValueError(f"视频 {video_id} 对应的监控账号不存在")
        current = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
        if current:
            merged = json.loads(current["data_json"])
            for removed_metric in ("playCount", "play_count", "viewCount", "view_count"):
                merged.pop(removed_metric, None)
            merged.update(video)
            # A collection result must never erase a saved transcript/analysis.
            for key in ("transcript", "analysis", "analysisStatus", "analysisUpdatedAt", "analysisError"):
                if key not in video or video.get(key) is None:
                    if key in json.loads(current["data_json"]):
                        merged[key] = json.loads(current["data_json"])[key]
            video = merged
        video.update({"id": video_id, "accountId": account_id})
        source_hash = video.get("sourceHash")
        now = utc_now()
        connection.execute(
            "INSERT INTO videos(id,account_id,source_hash,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,"
            "source_hash=COALESCE(excluded.source_hash,videos.source_hash),data_json=excluded.data_json,updated_at=excluded.updated_at",
            (video_id, account_id, str(source_hash) if source_hash else None, _compact_json(video), now, now),
        )
        return video

    @staticmethod
    def _upsert_snapshot(connection: sqlite3.Connection, raw: dict[str, Any]) -> None:
        snapshot = dict(_object(raw, "snapshot"))
        video_id = _identifier(snapshot.get("videoId"), "snapshot.videoId")
        account_id = snapshot.get("accountId")
        if not account_id:
            video = connection.execute("SELECT account_id FROM videos WHERE id=?", (video_id,)).fetchone()
            if not video:
                raise ValueError("snapshot 对应视频不存在")
            account_id = video["account_id"]
            snapshot["accountId"] = account_id
        account_id = _identifier(account_id, "snapshot.accountId")
        captured_at = str(snapshot.get("capturedAt") or utc_now())[:64]
        snapshot["capturedAt"] = captured_at
        connection.execute(
            "INSERT INTO snapshots(video_id,account_id,captured_at,data_json) VALUES(?,?,?,?) "
            "ON CONFLICT(video_id,captured_at) DO UPDATE SET data_json=excluded.data_json,account_id=excluded.account_id",
            (video_id, account_id, captured_at, _compact_json(snapshot)),
        )

    def migrate(self, payload: dict[str, Any]) -> dict[str, int]:
        accounts = payload.get("accounts") or []
        videos = payload.get("videos") or []
        snapshots = payload.get("snapshots") or []
        if not all(isinstance(value, list) for value in (accounts, videos, snapshots)):
            raise ValueError("accounts/videos/snapshots 必须是数组")
        with self.transaction() as connection:
            for account in accounts:
                self._upsert_account(connection, _object(account, "account"))
            for video in videos:
                self._upsert_video(connection, _object(video, "video"))
            for snapshot in snapshots:
                self._upsert_snapshot(connection, _object(snapshot, "snapshot"))
        return {"accounts": len(accounts), "videos": len(videos), "snapshots": len(snapshots)}

    def state(self) -> dict[str, Any]:
        with closing(self.connect()) as connection:
            accounts = [json.loads(row["data_json"]) for row in connection.execute("SELECT data_json FROM accounts ORDER BY created_at")]
            videos = [json.loads(row["data_json"]) for row in connection.execute("SELECT data_json FROM videos ORDER BY created_at")]
            snapshots = [json.loads(row["data_json"]) for row in connection.execute("SELECT data_json FROM snapshots ORDER BY captured_at")]
        return {
            "accounts": accounts,
            "videos": videos,
            "snapshots": snapshots,
            "connector": self.connector_status(),
        }

    def get_video(self, video_id: str) -> dict[str, Any] | None:
        video_id = _identifier(video_id, "videoId")
        with closing(self.connect()) as connection:
            row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
        return json.loads(row["data_json"]) if row else None

    @staticmethod
    def _mark_job_subject_queued(connection: sqlite3.Connection, job_type: str, payload: dict[str, Any]) -> None:
        if job_type in ("collect_latest", "archive_account"):
            account_ids = payload.get("accountIds") if isinstance(payload.get("accountIds"), list) else []
            if payload.get("accountId"):
                account_ids = [payload.get("accountId"), *account_ids]
            for account_id in {str(value) for value in account_ids if value}:
                row = connection.execute("SELECT data_json FROM accounts WHERE id=?", (account_id,)).fetchone()
                if not row:
                    continue
                account = json.loads(row["data_json"])
                account["status"] = "checking"
                account["currentSyncMode"] = "initial" if job_type == "archive_account" else "latest"
                if job_type == "archive_account":
                    account["initialSyncStatus"] = "pending"
                connection.execute(
                    "UPDATE accounts SET data_json=?,updated_at=? WHERE id=?",
                    (_compact_json(account), utc_now(), account_id),
                )
        elif job_type == "analyze_video":
            video_id = str(payload.get("videoId") or "")
            row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if row:
                video = json.loads(row["data_json"])
                video.update({"analysisStatus": "queued", "analysisError": None})
                connection.execute(
                    "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                    (_compact_json(video), utc_now(), video_id),
                )

    @staticmethod
    def _idempotency_key(job_type: str, payload: dict[str, Any]) -> str:
        explicit = payload.get("idempotencyKey")
        if isinstance(explicit, str) and explicit.strip():
            basis = explicit.strip()[:512]
        elif job_type == "analyze_video":
            basis = "|".join(
                (
                    job_type,
                    str(payload.get("accountId") or ""),
                    str(payload.get("videoId") or ""),
                    str(payload.get("sourceHash") or "unknown-source"),
                    str(payload.get("analysisVersion") or "v1"),
                )
            )
        elif job_type == "archive_account":
            basis = f"{job_type}|{payload.get('accountId') or _object(payload.get('account') or {}).get('id')}|v1"
        else:
            # Latest checks remain repeatable; only collapse double-clicks in the
            # same minute.
            minute_bucket = int(time.time()) // 60
            basis = f"{job_type}|{_compact_json(payload.get('accountIds') or payload.get('accountId') or 'all')}|{minute_bucket}"
        return hashlib.sha256(basis.encode("utf-8")).hexdigest()

    def create_job(self, requested_type: str, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        job_type = CANONICAL_JOB_TYPES.get(requested_type)
        if not job_type:
            raise ValueError("不支持的任务类型")
        payload = dict(_object(payload, "payload"))
        if job_type == "archive_account" and isinstance(payload.get("account"), dict):
            account_id = _identifier(payload["account"].get("id"), "account.id")
            payload["accountId"] = account_id
        if job_type == "archive_account":
            _identifier(payload.get("accountId"), "accountId")
        if job_type == "analyze_video":
            _identifier(payload.get("accountId"), "accountId")
            _identifier(payload.get("videoId"), "videoId")
            payload["analysisVersion"] = str(payload.get("analysisVersion") or "v1")[:64]
        key = self._idempotency_key(job_type, payload)
        now_epoch = int(time.time())
        now = utc_now()
        with self.transaction() as connection:
            if job_type == "archive_account" and isinstance(payload.get("account"), dict):
                self._upsert_account(connection, payload["account"])
            existing = connection.execute("SELECT * FROM jobs WHERE idempotency_key=?", (key,)).fetchone()
            if existing:
                if bool(payload.get("retry")) and existing["status"] in ("failed", "expired", "cancelled"):
                    connection.execute(
                        "UPDATE jobs SET payload_json=?,status='queued',result_json=NULL,progress_json=NULL,error=NULL,"
                        "updated_at=?,created_epoch=?,expires_at=?,claimed_by=NULL,claim_until=NULL WHERE id=?",
                        (
                            _compact_json(payload),
                            now,
                            now_epoch,
                            now_epoch + self.config.job_expiry_seconds,
                            existing["id"],
                        ),
                    )
                    self._mark_job_subject_queued(connection, job_type, payload)
                    reset = connection.execute("SELECT * FROM jobs WHERE id=?", (existing["id"],)).fetchone()
                    return _job_dict(reset), True
                return _job_dict(existing), False
            job_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO jobs(id,type,payload_json,status,idempotency_key,created_at,updated_at,created_epoch,expires_at) "
                "VALUES(?,?,?,'queued',?,?,?,?,?)",
                (
                    job_id,
                    job_type,
                    _compact_json(payload),
                    key,
                    now,
                    now,
                    now_epoch,
                    now_epoch + self.config.job_expiry_seconds,
                ),
            )
            self._mark_job_subject_queued(connection, job_type, payload)
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _job_dict(row), True

    def expire_and_requeue(self, connection: sqlite3.Connection) -> None:
        now_epoch = int(time.time())
        now = utc_now()
        connection.execute(
            "UPDATE jobs SET status='expired',error='任务在主机接收前已超过 30 分钟',updated_at=? "
            "WHERE status='queued' AND expires_at<=?",
            (now, now_epoch),
        )
        connection.execute(
            "UPDATE jobs SET status='queued',claimed_by=NULL,claim_until=NULL,updated_at=? "
            "WHERE status='claimed' AND claim_until<=? AND expires_at>?",
            (now, now_epoch, now_epoch),
        )
        connection.execute(
            "UPDATE jobs SET status='expired',error='任务租约已过期且超过 30 分钟',updated_at=? "
            "WHERE status='claimed' AND expires_at<=?",
            (now, now_epoch),
        )

    def list_jobs(self, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(500, int(limit)))
        with self.transaction() as connection:
            self.expire_and_requeue(connection)
            rows = connection.execute("SELECT * FROM jobs ORDER BY created_epoch DESC LIMIT ?", (limit,)).fetchall()
        return [_job_dict(row) for row in rows]

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.transaction() as connection:
            self.expire_and_requeue(connection)
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _job_dict(row) if row else None

    def claim_job(self, connector_id: str, capabilities: list[str] | None = None) -> dict[str, Any] | None:
        allowed = {CANONICAL_JOB_TYPES[item] for item in (capabilities or []) if item in CANONICAL_JOB_TYPES}
        now_epoch = int(time.time())
        with self.transaction() as connection:
            self.expire_and_requeue(connection)
            placeholders = ""
            parameters: list[Any] = []
            where = "status='queued'"
            if allowed:
                placeholders = ",".join("?" for _ in allowed)
                where += f" AND type IN ({placeholders})"
                parameters.extend(sorted(allowed))
            row = connection.execute(
                f"SELECT * FROM jobs WHERE {where} ORDER BY created_epoch LIMIT 1", parameters
            ).fetchone()
            if not row:
                connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))
                return None
            connection.execute(
                "UPDATE jobs SET status='claimed',claimed_by=?,claim_until=?,attempt_count=attempt_count+1,updated_at=? WHERE id=?",
                (connector_id, now_epoch + self.config.claim_lease_seconds, utc_now(), row["id"]),
            )
            connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))
            claimed = connection.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()
        return _job_dict(claimed)

    def heartbeat_job(self, connector_id: str, job_id: str | None) -> dict[str, Any] | None:
        now_epoch = int(time.time())
        with self.transaction() as connection:
            self.expire_and_requeue(connection)
            connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))
            if not job_id:
                return None
            row = connection.execute("SELECT * FROM jobs WHERE id=? AND claimed_by=?", (job_id, connector_id)).fetchone()
            if not row or row["status"] not in ("claimed", "running"):
                return None
            connection.execute(
                "UPDATE jobs SET claim_until=?,updated_at=? WHERE id=?",
                (now_epoch + self.config.claim_lease_seconds, utc_now(), job_id),
            )
            current = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _job_dict(current)

    def process_connector_event(
        self, connector_id: str, job_id: str | None, event_id: str, event_type: str, payload: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        event_id = _identifier(event_id, "eventId")
        if job_id is not None:
            job_id = _identifier(job_id, "jobId")
        payload = dict(_object(payload, "payload"))
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone() if job_id else None
            if job_id and not job:
                raise ValueError("任务不存在")
            if job and job["claimed_by"] != connector_id:
                raise ValueError("任务不属于当前 connector")
            if not job and event_type not in ("collection_result", "job_completed", "job_failed"):
                raise ValueError("此事件必须关联任务")
            try:
                connection.execute(
                    "INSERT INTO processed_events(connector_id,event_id,job_id,processed_at) VALUES(?,?,?,?)",
                    (connector_id, event_id, job_id, utc_now()),
                )
            except sqlite3.IntegrityError:
                current = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone() if job_id else None
                return True, _job_dict(current) if current else {"id": None, "status": "accepted"}

            status = job["status"] if job else "running"
            if event_type in ("started", "progress"):
                status = "running"
                connection.execute(
                    "UPDATE jobs SET status=?,progress_json=?,updated_at=? WHERE id=?",
                    (status, _compact_json(payload), utc_now(), job_id),
                )
            elif event_type == "collection_result":
                account_values = payload.get("accounts") or ([payload["account"]] if isinstance(payload.get("account"), dict) else [])
                for account in account_values:
                    normalized = dict(_object(account, "account"))
                    completed_at = str(payload.get("completedAt") or utc_now())
                    normalized["lastCheckedAt"] = completed_at
                    normalized["lastSuccessAt"] = completed_at
                    normalized["status"] = "ready"
                    normalized["currentSyncMode"] = None
                    video_ids = [str(video.get("id")) for video in payload.get("videos") or [] if video.get("id")]
                    if video_ids:
                        normalized["latestVideoIds"] = video_ids[:3]
                    if payload.get("mode") in ("initial", "archive", "archive30"):
                        normalized["initialSyncStatus"] = "complete"
                        normalized["initialSyncCompletedAt"] = completed_at
                    self._upsert_account(connection, normalized)
                for video in payload.get("videos") or []:
                    self._upsert_video(connection, _object(video, "video"))
                snapshots = payload.get("snapshots")
                if snapshots is None:
                    snapshots = []
                    for video in payload.get("videos") or []:
                        snapshots.append(
                            {
                                "accountId": video.get("accountId") or payload.get("accountId"),
                                "videoId": video.get("id"),
                                "likeCount": video.get("likeCount"),
                                "commentCount": video.get("commentCount"),
                                "favoriteCount": video.get("favoriteCount"),
                                "shareCount": video.get("shareCount"),
                                "capturedAt": payload.get("completedAt") or video.get("capturedAt") or utc_now(),
                            }
                        )
                for snapshot in snapshots:
                    self._upsert_snapshot(connection, _object(snapshot, "snapshot"))
                if job_id:
                    connection.execute(
                        "UPDATE jobs SET status='running',result_json=?,progress_json=?,error=NULL,updated_at=? WHERE id=?",
                        (
                            _compact_json({"lastCollectionResult": payload}),
                            _compact_json({"stage": "account_completed", "accountId": payload.get("accountId")}),
                            utc_now(),
                            job_id,
                        ),
                    )
            elif event_type in ("job_completed", "completed"):
                if job_id:
                    connection.execute(
                        "UPDATE jobs SET status='succeeded',result_json=?,progress_json=NULL,error=NULL,updated_at=? WHERE id=?",
                        (_compact_json(payload), utc_now(), job_id),
                    )
            elif event_type in ("job_failed", "failed"):
                message = str(payload.get("error") or payload.get("message") or "connector 执行失败")[:2000]
                account_id = str(payload.get("accountId") or "")
                if account_id:
                    account_row = connection.execute("SELECT data_json FROM accounts WHERE id=?", (account_id,)).fetchone()
                    if account_row:
                        account = json.loads(account_row["data_json"])
                        account.update({"status": "error", "currentSyncMode": None})
                        if payload.get("mode") in ("initial", "archive", "archive30"):
                            account["initialSyncStatus"] = "error"
                        connection.execute(
                            "UPDATE accounts SET data_json=?,updated_at=? WHERE id=?",
                            (_compact_json(account), utc_now(), account_id),
                        )
                if job and job["type"] == "analyze_video":
                    failed_payload = json.loads(job["payload_json"])
                    failed_video_id = str(failed_payload.get("videoId") or "")
                    video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (failed_video_id,)).fetchone()
                    if video_row:
                        video = json.loads(video_row["data_json"])
                        video.update({"analysisStatus": "error", "analysisError": message})
                        if not video.get("transcript"):
                            video.update({"transcriptStatus": "idle", "transcriptError": None})
                        connection.execute(
                            "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                            (_compact_json(video), utc_now(), failed_video_id),
                        )
                if job_id:
                    connection.execute(
                        "UPDATE jobs SET status='failed',error=?,progress_json=NULL,updated_at=? WHERE id=?",
                        (message, utc_now(), job_id),
                    )
            elif event_type == "analysis_media":
                if not job or job["type"] != "analyze_video":
                    raise ValueError("仅视频分析任务可提交媒体")
                video_id = _identifier(payload.get("videoId"), "videoId")
                job_payload = json.loads(job["payload_json"])
                if video_id != str(job_payload.get("videoId")):
                    raise ValueError("媒体 videoId 与任务目标不一致")
                run_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO analysis_runs(id,job_id,video_id,source_hash,analysis_version,status,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,'running',?,?) ON CONFLICT(job_id) DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at",
                    (
                        run_id,
                        job_id,
                        video_id,
                        str(payload.get("sourceHash") or "") or None,
                        str(job_payload.get("analysisVersion") or "v1"),
                        utc_now(),
                        utc_now(),
                    ),
                )
                connection.execute(
                    "UPDATE jobs SET status='running',progress_json=?,updated_at=? WHERE id=?",
                    (_compact_json({"stage": "media_received"}), utc_now(), job_id),
                )
                video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
                if video_row:
                    video = json.loads(video_row["data_json"])
                    video.update({"analysisStatus": "processing", "analysisError": None})
                    if not video.get("transcript"):
                        video.update({"transcriptStatus": "processing", "transcriptError": None})
                    connection.execute(
                        "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                        (_compact_json(video), utc_now(), video_id),
                    )
            else:
                raise ValueError("不支持的 connector 事件类型")
            current = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone() if job_id else None
        return False, _job_dict(current) if current else {"id": None, "status": "accepted"}

    def save_analysis_success(
        self,
        job_id: str,
        transcript: str,
        analysis: dict[str, Any],
        source_hash: str,
    ) -> None:
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                raise ValueError("任务不存在")
            payload = json.loads(job["payload_json"])
            video_id = _identifier(payload.get("videoId"), "videoId")
            video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if not video_row:
                raise ValueError("分析目标视频不存在")
            updated_at = utc_now()
            video = json.loads(video_row["data_json"])
            video.update(
                {
                    "transcript": transcript,
                    "transcriptStatus": "ready",
                    "transcriptUpdatedAt": updated_at,
                    "transcriptError": None,
                    "analysis": analysis,
                    "analysisStatus": "ready",
                    "analysisUpdatedAt": updated_at,
                    "analysisError": None,
                    "sourceHash": source_hash,
                }
            )
            connection.execute(
                "UPDATE videos SET source_hash=?,data_json=?,updated_at=? WHERE id=?",
                (source_hash, _compact_json(video), updated_at, video_id),
            )
            connection.execute(
                "UPDATE analysis_runs SET source_hash=?,status='succeeded',transcript=?,analysis_json=?,error=NULL,updated_at=? WHERE job_id=?",
                (source_hash, transcript, _compact_json(analysis), updated_at, job_id),
            )
            result = {"videoId": video_id, "transcript": transcript, "analysis": analysis, "sourceHash": source_hash}
            connection.execute(
                "UPDATE jobs SET status='succeeded',result_json=?,progress_json=NULL,error=NULL,updated_at=? WHERE id=?",
                (_compact_json(result), updated_at, job_id),
            )

    def save_analysis_failure(self, job_id: str, message: str, transcript: str | None = None) -> None:
        safe_message = message[:2000]
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                return
            payload = json.loads(job["payload_json"])
            video_id = str(payload.get("videoId") or "")
            video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if video_row:
                video = json.loads(video_row["data_json"])
                if transcript is not None:
                    video.update(
                        {
                            "transcript": transcript,
                            "transcriptStatus": "ready",
                            "transcriptUpdatedAt": utc_now(),
                            "transcriptError": None,
                        }
                    )
                video.update({"analysisStatus": "error", "analysisError": safe_message})
                connection.execute(
                    "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                    (_compact_json(video), utc_now(), video_id),
                )
            connection.execute(
                "UPDATE analysis_runs SET status='failed',transcript=COALESCE(?,transcript),error=?,updated_at=? WHERE job_id=?",
                (transcript, safe_message, utc_now(), job_id),
            )
            connection.execute(
                "UPDATE jobs SET status='failed',error=?,progress_json=NULL,updated_at=? WHERE id=?",
                (safe_message, utc_now(), job_id),
            )

    def update_job_progress(self, job_id: str, stage: str) -> None:
        with self.transaction() as connection:
            connection.execute(
                "UPDATE jobs SET status='running',progress_json=?,updated_at=? WHERE id=?",
                (_compact_json({"stage": stage}), utc_now(), job_id),
            )

    def mark_stale_analysis_failed(self) -> int:
        """Recover tasks interrupted by a service or machine restart."""
        with self.transaction() as connection:
            rows = connection.execute(
                "SELECT job_id FROM analysis_runs WHERE status='running'"
            ).fetchall()
            now = utc_now()
            for row in rows:
                connection.execute(
                    "UPDATE analysis_runs SET status='failed',error='主机服务在分析过程中重启，请重新发起分析',updated_at=? WHERE job_id=?",
                    (now, row["job_id"]),
                )
                connection.execute(
                    "UPDATE jobs SET status='failed',error='主机服务在分析过程中重启，请重新发起分析',updated_at=? WHERE id=?",
                    (now, row["job_id"]),
                )
        return len(rows)
