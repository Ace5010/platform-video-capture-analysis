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

from local_asr.punctuation import restore_transcript_text

from .compatibility import CONNECTOR_FRESHNESS_SECONDS, semver_at_least
from .config import HostConfig
from .recovery import safe_error


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
LINK_VIDEO_ACCOUNT_ID = "__video_link_analysis__"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _normalize_video_transcript(video: dict[str, Any]) -> dict[str, Any]:
    transcript = video.get("transcript")
    if isinstance(transcript, str) and transcript.strip():
        video["transcript"] = restore_transcript_text(transcript)
    return video


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


def _connector_capabilities(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    allowed = set(CANONICAL_JOB_TYPES.values()) | {"sync_accounts"}
    return sorted({str(value) for value in values if str(value) in allowed})


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
        "claimToken": row["claim_token"],
        "attemptCount": row["attempt_count"],
    }


def _analysis_run_dict(row: sqlite3.Row) -> dict[str, Any]:
    usage: dict[str, Any] | None = None
    if row["usage_json"]:
        try:
            candidate = json.loads(row["usage_json"])
            if isinstance(candidate, dict):
                usage = candidate
        except (TypeError, json.JSONDecodeError):
            usage = None
    return {
        "id": row["id"],
        "jobId": row["job_id"],
        "status": row["status"],
        "usage": usage,
        "error": row["error"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
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
                    revoked_at TEXT,
                    extension_version TEXT,
                    capabilities_json TEXT NOT NULL DEFAULT '[]',
                    worker_id TEXT,
                    worker_status TEXT,
                    active_job_id TEXT
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
                    claim_token TEXT,
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
                    transcript_raw TEXT,
                    transcript TEXT,
                    analysis_json TEXT,
                    usage_json TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_analysis_runs_video_created
                    ON analysis_runs(video_id, created_at DESC);
                """
            )
            connector_columns = {row["name"] for row in connection.execute("PRAGMA table_info(connectors)")}
            for column, definition in {
                "extension_version": "TEXT",
                "capabilities_json": "TEXT NOT NULL DEFAULT '[]'",
                "worker_id": "TEXT",
                "worker_status": "TEXT",
                "active_job_id": "TEXT",
            }.items():
                if column not in connector_columns:
                    connection.execute(f"ALTER TABLE connectors ADD COLUMN {column} {definition}")
            job_columns = {row["name"] for row in connection.execute("PRAGMA table_info(jobs)")}
            if "claim_token" not in job_columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN claim_token TEXT")
            analysis_run_columns = {row["name"] for row in connection.execute("PRAGMA table_info(analysis_runs)")}
            if "transcript_raw" not in analysis_run_columns:
                connection.execute("ALTER TABLE analysis_runs ADD COLUMN transcript_raw TEXT")
            if "usage_json" not in analysis_run_columns:
                connection.execute("ALTER TABLE analysis_runs ADD COLUMN usage_json TEXT")
            analysis_runs_sql_row = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='analysis_runs'"
            ).fetchone()
            analysis_runs_sql = str(analysis_runs_sql_row["sql"] or "") if analysis_runs_sql_row else ""
            if "UNIQUE(video_id, source_hash, analysis_version)" in analysis_runs_sql:
                # Older builds treated an analysis result as a mutable cache
                # entry. Rebuild the table so every user-triggered retry can
                # keep its own permanent run and usage receipt.
                connection.execute("BEGIN IMMEDIATE")
                try:
                    connection.execute(
                        """
                        CREATE TABLE analysis_runs_history_migration (
                            id TEXT PRIMARY KEY,
                            job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
                            video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
                            source_hash TEXT,
                            analysis_version TEXT NOT NULL,
                            status TEXT NOT NULL,
                            transcript_raw TEXT,
                            transcript TEXT,
                            analysis_json TEXT,
                            usage_json TEXT,
                            error TEXT,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL
                        )
                        """
                    )
                    connection.execute(
                        """
                        INSERT INTO analysis_runs_history_migration(
                            id,job_id,video_id,source_hash,analysis_version,status,transcript_raw,transcript,
                            analysis_json,usage_json,error,created_at,updated_at
                        )
                        SELECT id,job_id,video_id,source_hash,analysis_version,status,transcript_raw,transcript,
                            analysis_json,usage_json,error,created_at,updated_at FROM analysis_runs
                        """
                    )
                    connection.execute("DROP TABLE analysis_runs")
                    connection.execute("ALTER TABLE analysis_runs_history_migration RENAME TO analysis_runs")
                    connection.execute(
                        "CREATE INDEX idx_analysis_runs_video_created ON analysis_runs(video_id, created_at DESC)"
                    )
                    connection.execute("COMMIT")
                except Exception:
                    connection.execute("ROLLBACK")
                    raise

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

    def pair_connector(
        self,
        extension_id: str,
        label: str,
        connector_id: str,
        connector_token_hash: str,
        extension_version: str = "",
        capabilities: list[str] | None = None,
        worker_id: str = "",
    ) -> None:
        normalized_capabilities = _connector_capabilities(capabilities)
        with self.transaction() as connection:
            active = connection.execute(
                "SELECT id FROM connectors WHERE extension_id=? AND revoked_at IS NULL", (extension_id,)
            ).fetchone()
            if active:
                connection.execute(
                    "UPDATE connectors SET label=?,token_hash=?,last_seen_at=?,revoked_at=NULL,extension_version=?,"
                    "capabilities_json=?,worker_id=?,worker_status='idle',active_job_id=NULL WHERE id=?",
                    (
                        label,
                        connector_token_hash,
                        utc_now(),
                        extension_version[:64] or None,
                        _compact_json(normalized_capabilities),
                        worker_id[:256] or None,
                        active["id"],
                    ),
                )
                return
            connection.execute(
                "INSERT INTO connectors(id,extension_id,label,token_hash,created_at,last_seen_at,extension_version,"
                "capabilities_json,worker_id,worker_status) VALUES(?,?,?,?,?,?,?,?,?,'idle')",
                (
                    connector_id,
                    extension_id,
                    label,
                    connector_token_hash,
                    utc_now(),
                    utc_now(),
                    extension_version[:64] or None,
                    _compact_json(normalized_capabilities),
                    worker_id[:256] or None,
                ),
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

    def update_connector_runtime(
        self,
        connector_id: str,
        *,
        extension_version: str = "",
        capabilities: list[str] | None = None,
        worker_id: str = "",
        worker_status: str = "",
        active_job_id: str | None = None,
    ) -> None:
        normalized_capabilities = _connector_capabilities(capabilities)
        with self.transaction() as connection:
            connection.execute(
                "UPDATE connectors SET last_seen_at=?,extension_version=COALESCE(NULLIF(?,''),extension_version),"
                "capabilities_json=CASE WHEN ? THEN ? ELSE capabilities_json END,"
                "worker_id=COALESCE(NULLIF(?,''),worker_id),worker_status=COALESCE(NULLIF(?,''),worker_status),"
                "active_job_id=? WHERE id=?",
                (
                    utc_now(),
                    extension_version[:64],
                    1 if capabilities is not None else 0,
                    _compact_json(normalized_capabilities),
                    worker_id[:256],
                    worker_status[:64],
                    active_job_id,
                    connector_id,
                ),
            )

    def connector_status(self) -> dict[str, Any]:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT label,created_at,last_seen_at,extension_version,capabilities_json,worker_status,active_job_id FROM connectors "
                "WHERE revoked_at IS NULL ORDER BY COALESCE(last_seen_at,created_at) DESC LIMIT 1"
            ).fetchone()
        if not row:
            return {"connected": False, "paired": False, "lastSeenAt": None, "capabilities": []}
        last_seen = row["last_seen_at"]
        connected = False
        if last_seen:
            try:
                observed = datetime.fromisoformat(str(last_seen).replace("Z", "+00:00"))
                connected = (
                    datetime.now(timezone.utc) - observed
                ).total_seconds() <= CONNECTOR_FRESHNESS_SECONDS
            except ValueError:
                connected = False
        return {
            "connected": connected,
            "paired": True,
            "lastSeenAt": last_seen,
            "label": row["label"],
            "extensionVersion": row["extension_version"],
            "capabilities": json.loads(row["capabilities_json"] or "[]"),
            "workerStatus": row["worker_status"],
            "activeJobId": row["active_job_id"],
        }

    def connector_supports(
        self,
        capability: str,
        *,
        min_version: str | None = None,
        fresh_within_seconds: int | None = None,
    ) -> bool:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                "SELECT capabilities_json,extension_version,last_seen_at FROM connectors WHERE revoked_at IS NULL"
            ).fetchall()
        now = datetime.now(timezone.utc)
        for row in rows:
            if capability not in json.loads(row["capabilities_json"] or "[]"):
                continue
            if min_version and not semver_at_least(row["extension_version"], min_version):
                continue
            if fresh_within_seconds is not None:
                try:
                    observed = datetime.fromisoformat(str(row["last_seen_at"] or "").replace("Z", "+00:00"))
                except (TypeError, ValueError):
                    continue
                if observed.tzinfo is None:
                    observed = observed.replace(tzinfo=timezone.utc)
                if (now - observed).total_seconds() > max(0, fresh_within_seconds):
                    continue
            return True
        return False

    @staticmethod
    def _upsert_account(connection: sqlite3.Connection, raw: dict[str, Any]) -> dict[str, Any]:
        incoming = dict(_object(raw, "account"))
        account_id = _identifier(incoming.get("id"), "account.id")
        current = connection.execute("SELECT data_json FROM accounts WHERE id=?", (account_id,)).fetchone()
        account = json.loads(current["data_json"]) if current else {}
        account.update({key: value for key, value in incoming.items()
                        if value is not None or key in ("currentSyncMode", "collectionError")})
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

    def acknowledge_account_updates(self, accounts: list[dict[str, Any]]) -> None:
        with self.transaction() as connection:
            for item in accounts:
                account_id = _identifier(_object(item, "account").get("id"), "account.id")
                row = connection.execute("SELECT data_json FROM accounts WHERE id=?", (account_id,)).fetchone()
                if not row:
                    continue
                account = json.loads(row["data_json"])
                checked_at = account.get("lastCheckedAt")
                # A click only acknowledges the check the device actually displayed.
                if checked_at and checked_at == item.get("lastCheckedAt"):
                    account["updatesReadAt"] = checked_at
                    self._upsert_account(connection, account)

    def upsert_link_video(self, video_id: str, canonical_url: str, source_url: str) -> dict[str, Any]:
        video_id = _identifier(video_id, "videoId")
        now = utc_now()
        with self.transaction() as connection:
            current = connection.execute(
                "SELECT account_id,data_json FROM videos WHERE id=?",
                (video_id,),
            ).fetchone()
            if current:
                video = json.loads(current["data_json"])
                video.update(
                    {
                        "id": video_id,
                        "accountId": str(current["account_id"]),
                        "isLinkAnalysis": True,
                        "linkSourceUrl": source_url,
                        "linkLastSubmittedAt": now,
                    }
                )
                video.setdefault("linkAddedAt", now)
                video.setdefault("url", canonical_url)
            else:
                self._upsert_account(
                    connection,
                    {
                        "id": LINK_VIDEO_ACCOUNT_ID,
                        "platform": "douyin",
                        "url": "https://www.douyin.com/",
                        "name": "视频链接分析",
                        "hidden": True,
                        "sourceKind": "video_link_internal",
                        "addedAt": now,
                        "initialSyncStatus": "complete",
                    },
                )
                video = {
                    "id": video_id,
                    "accountId": LINK_VIDEO_ACCOUNT_ID,
                    "title": "正在读取视频信息…",
                    "description": "",
                    "url": canonical_url,
                    "coverUrl": None,
                    "publishedAt": None,
                    "durationSeconds": None,
                    "likeCount": None,
                    "commentCount": None,
                    "favoriteCount": None,
                    "shareCount": None,
                    "capturedAt": now,
                    "firstSeenAt": now,
                    "lastSeenAt": now,
                    "transcript": None,
                    "transcriptStatus": "idle",
                    "analysis": None,
                    "analysisStatus": "idle",
                    "isLinkAnalysis": True,
                    "linkSourceUrl": source_url,
                    "linkAddedAt": now,
                    "linkLastSubmittedAt": now,
                }
            return self._upsert_video(connection, video)

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
            preserved_link_videos = []
            for row in connection.execute("SELECT id,data_json FROM videos WHERE account_id=?", (account_id,)):
                video = json.loads(row["data_json"])
                if video.get("isLinkAnalysis") is True:
                    preserved_link_videos.append((str(row["id"]), video))
            if preserved_link_videos:
                now = utc_now()
                self._upsert_account(
                    connection,
                    {
                        "id": LINK_VIDEO_ACCOUNT_ID,
                        "platform": "douyin",
                        "url": "https://www.douyin.com/",
                        "name": "视频链接分析",
                        "hidden": True,
                        "sourceKind": "video_link_internal",
                        "addedAt": now,
                        "initialSyncStatus": "complete",
                    },
                )
                for video_id, video in preserved_link_videos:
                    video["accountId"] = LINK_VIDEO_ACCOUNT_ID
                    connection.execute(
                        "UPDATE videos SET account_id=?,data_json=?,updated_at=? WHERE id=?",
                        (LINK_VIDEO_ACCOUNT_ID, _compact_json(video), now, video_id),
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
        current = connection.execute("SELECT data_json,created_at FROM videos WHERE id=?", (video_id,)).fetchone()
        first_seen = (json.loads(current["data_json"]).get("firstSeenAt") or current["created_at"]) if current else (video.get("firstSeenAt") or utc_now())
        if current:
            merged = json.loads(current["data_json"])
            for removed_metric in ("playCount", "play_count", "viewCount", "view_count"):
                merged.pop(removed_metric, None)
            merged.update(video)
            # A collection result must never erase a saved transcript/analysis.
            for key in ("transcript", "analysis", "analysisUsage", "analysisStatus", "analysisUpdatedAt", "analysisError"):
                if key not in video or video.get(key) is None:
                    if key in json.loads(current["data_json"]):
                        merged[key] = json.loads(current["data_json"])[key]
            video = merged
        video.update({"id": video_id, "accountId": account_id, "firstSeenAt": first_seen})
        _normalize_video_transcript(video)
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
        self.reconcile_collection_statuses()
        with closing(self.connect()) as connection:
            accounts = [
                account
                for row in connection.execute("SELECT data_json FROM accounts ORDER BY created_at")
                if not (account := json.loads(row["data_json"])).get("hidden")
            ]
            video_rows = connection.execute("SELECT account_id,data_json,created_at FROM videos ORDER BY created_at").fetchall()
            all_videos = [
                (str(row["account_id"]), _normalize_video_transcript({**json.loads(row["data_json"]),
                    "firstSeenAt": json.loads(row["data_json"]).get("firstSeenAt") or row["created_at"]}))
                for row in video_rows
            ]
            runs_by_video: dict[str, list[dict[str, Any]]] = {}
            for row in connection.execute(
                "SELECT id,job_id,video_id,status,usage_json,error,created_at,updated_at "
                "FROM analysis_runs ORDER BY created_at DESC,id DESC"
            ):
                runs_by_video.setdefault(str(row["video_id"]), []).append(_analysis_run_dict(row))
            for _, video in all_videos:
                video["analysisRuns"] = runs_by_video.get(str(video.get("id") or ""), [])
            videos = [video for account_id, video in all_videos if account_id != LINK_VIDEO_ACCOUNT_ID]
            link_videos = [video for _, video in all_videos if video.get("isLinkAnalysis") is True]
            snapshots = [
                json.loads(row["data_json"])
                for row in connection.execute(
                    "SELECT data_json FROM snapshots WHERE account_id!=? ORDER BY captured_at",
                    (LINK_VIDEO_ACCOUNT_ID,),
                )
            ]
        return {
            "accounts": accounts,
            "videos": videos,
            "linkVideos": link_videos,
            "snapshots": snapshots,
            "connector": self.connector_status(),
        }

    def reconcile_collection_statuses(self) -> None:
        """Repair stale account flags without changing captured videos or counts."""
        with self.transaction() as connection:
            jobs = connection.execute(
                "SELECT status,payload_json,error FROM jobs WHERE type IN ('collect_latest','archive_account') "
                "ORDER BY created_epoch DESC,created_at DESC"
            ).fetchall()
            for row in connection.execute("SELECT id,data_json FROM accounts").fetchall():
                account = json.loads(row["data_json"])
                if account.get("status") != "checking":
                    continue
                relevant = []
                for job in jobs:
                    payload = json.loads(job["payload_json"])
                    ids = payload.get("accountIds") or ([payload["accountId"]] if payload.get("accountId") else [])
                    if not ids or row["id"] in ids:
                        relevant.append(job)
                if any(job["status"] in ("queued", "claimed", "running") for job in relevant):
                    continue
                account["status"] = "error"
                account["currentSyncMode"] = None
                account["collectionError"] = (relevant[0]["error"] if relevant else None) or "采集已中断，请重新检查"
                self._upsert_account(connection, account)

    def get_video(self, video_id: str) -> dict[str, Any] | None:
        video_id = _identifier(video_id, "videoId")
        with closing(self.connect()) as connection:
            row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if not row:
                return None
            video = _normalize_video_transcript(json.loads(row["data_json"]))
            run_rows = connection.execute(
                "SELECT id,job_id,video_id,status,usage_json,error,created_at,updated_at "
                "FROM analysis_runs WHERE video_id=? ORDER BY created_at DESC,id DESC",
                (video_id,),
            ).fetchall()
            video["analysisRuns"] = [_analysis_run_dict(run) for run in run_rows]
        return video

    def normalize_saved_transcripts(self) -> int:
        """Persist punctuation on transcripts created before restoration was enabled."""

        changed = 0
        with self.transaction() as connection:
            # The original job result predates transcript migration and still
            # holds the recognizer's exact wording. Prefer it as the clean
            # source so improved punctuation rules can replace older heuristic
            # marks instead of stacking more punctuation on top of them.
            normalized_by_video: dict[str, str] = {}
            runs = connection.execute(
                "SELECT analysis_runs.id,analysis_runs.video_id,analysis_runs.status,analysis_runs.transcript_raw,analysis_runs.transcript,"
                "analysis_runs.job_id,jobs.result_json FROM analysis_runs "
                "LEFT JOIN jobs ON jobs.id=analysis_runs.job_id ORDER BY analysis_runs.updated_at"
            ).fetchall()
            for row in runs:
                has_raw = isinstance(row["transcript_raw"], str) and bool(row["transcript_raw"].strip())
                source = row["transcript_raw"] if has_raw else row["transcript"]
                result: dict[str, Any] | None = None
                if row["result_json"]:
                    try:
                        candidate = json.loads(row["result_json"])
                        result = candidate if isinstance(candidate, dict) else None
                    except json.JSONDecodeError:
                        result = None
                    raw_transcript = (result.get("transcriptRaw") or result.get("transcript")) if result else None
                    if isinstance(raw_transcript, str) and raw_transcript.strip():
                        source = raw_transcript
                # Failed-before-ASR and speechless runs have nothing to
                # normalize. Do not turn every restart into a new update to
                # their immutable historical failure/completion time.
                if not isinstance(source, str) or not source.strip():
                    continue
                normalized = restore_transcript_text(source)
                if normalized != row["transcript"] or not has_raw:
                    connection.execute(
                        "UPDATE analysis_runs SET transcript_raw=?,transcript=?,updated_at=? WHERE id=?",
                        (row["transcript_raw"] if has_raw else source, normalized, utc_now(), row["id"]),
                    )
                if result is not None and (result.get("transcript") != normalized or not result.get("transcriptRaw")):
                    if not result.get("transcriptRaw"):
                        result["transcriptRaw"] = source
                    result["transcript"] = normalized
                    connection.execute(
                        "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                        (_compact_json(result), utc_now(), row["job_id"]),
                    )
                if row["status"] == "succeeded" and normalized:
                    normalized_by_video[row["video_id"]] = normalized

            rows = connection.execute("SELECT id,data_json FROM videos").fetchall()
            for row in rows:
                video = json.loads(row["data_json"])
                before = video.get("transcript")
                source = normalized_by_video.get(row["id"])
                if source:
                    video["transcript"] = source
                else:
                    _normalize_video_transcript(video)
                if video.get("transcript") == before:
                    continue
                connection.execute(
                    "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                    (_compact_json(video), utc_now(), row["id"]),
                )
                changed += 1
        return changed

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
                video.update({"analysisStatus": "queued", "analysisError": None, "analysisUsage": None})
                connection.execute(
                    "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                    (_compact_json(video), utc_now(), video_id),
                )

    @staticmethod
    def _ensure_analysis_run(
        connection: sqlite3.Connection,
        job_id: str,
        payload: dict[str, Any],
        status: str = "queued",
    ) -> None:
        now = utc_now()
        connection.execute(
            "INSERT INTO analysis_runs(id,job_id,video_id,source_hash,analysis_version,status,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING",
            (
                str(uuid.uuid4()),
                job_id,
                _identifier(payload.get("videoId"), "videoId"),
                str(payload.get("sourceHash") or "") or None,
                str(payload.get("analysisVersion") or "v1")[:64],
                status,
                now,
                now,
            ),
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

    def _latest_analysis_job(
        self,
        connection: sqlite3.Connection,
        base_key: str,
    ) -> sqlite3.Row | None:
        rows = connection.execute(
            "SELECT * FROM jobs WHERE type='analyze_video' ORDER BY created_epoch DESC,created_at DESC,id DESC"
        ).fetchall()
        for row in rows:
            try:
                candidate_payload = json.loads(row["payload_json"])
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(candidate_payload, dict) and self._idempotency_key("analyze_video", candidate_payload) == base_key:
                return row
        return None

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
        job_ttl = self.config.analysis_job_expiry_seconds if job_type == "analyze_video" else self.config.job_expiry_seconds
        with self.transaction() as connection:
            self.expire_and_requeue(connection)

            def upgrade_active_link_analysis(row: sqlite3.Row) -> sqlite3.Row:
                if (
                    job_type != "analyze_video"
                    or payload.get("sourceKind") != "video_link"
                    or row["status"] not in ACTIVE_JOB_STATUSES
                ):
                    return row
                current_payload = json.loads(row["payload_json"])
                if current_payload.get("sourceKind") == "video_link":
                    return row
                current_payload["sourceKind"] = "video_link"
                connection.execute(
                    "UPDATE jobs SET payload_json=?,updated_at=? WHERE id=?",
                    (_compact_json(current_payload), now, row["id"]),
                )
                return connection.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()

            if job_type == "archive_account" and isinstance(payload.get("account"), dict):
                self._upsert_account(connection, payload["account"])
            existing = connection.execute("SELECT * FROM jobs WHERE idempotency_key=?", (key,)).fetchone()
            if job_type == "analyze_video" and bool(payload.get("retry")):
                latest = self._latest_analysis_job(connection, key)
                if latest and latest["status"] in ACTIVE_JOB_STATUSES:
                    return _job_dict(upgrade_active_link_analysis(latest)), False
                if latest:
                    key = hashlib.sha256(f"{key}|retry-of|{latest['id']}".encode("utf-8")).hexdigest()
                    repeated = connection.execute("SELECT * FROM jobs WHERE idempotency_key=?", (key,)).fetchone()
                    if repeated:
                        return _job_dict(upgrade_active_link_analysis(repeated)), False
            elif job_type == "archive_account" and payload.get("retry") and existing:
                latest = next((row for row in connection.execute(
                    "SELECT * FROM jobs WHERE type='archive_account' ORDER BY created_epoch DESC,created_at DESC,id DESC"
                ).fetchall() if self._idempotency_key("archive_account", json.loads(row["payload_json"])) == key), existing)
                if latest["status"] in ACTIVE_JOB_STATUSES:
                    return _job_dict(latest), False
                result = json.loads(latest["result_json"] or "{}")
                if latest["status"] == "succeeded" and not result.get("partial"):
                    return _job_dict(latest), False
                key = hashlib.sha256(f"{key}|retry-of|{latest['id']}".encode("utf-8")).hexdigest()
            elif existing:
                return _job_dict(upgrade_active_link_analysis(existing)), False
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
                    now_epoch + job_ttl,
                ),
            )
            if job_type == "analyze_video":
                self._ensure_analysis_run(connection, job_id, payload)
            self._mark_job_subject_queued(connection, job_type, payload)
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _job_dict(row), True

    def expire_and_requeue(self, connection: sqlite3.Connection) -> None:
        now_epoch = int(time.time())
        now = utc_now()
        expired_analysis_jobs = connection.execute(
            "SELECT id,payload_json FROM jobs WHERE status='queued' AND type='analyze_video' AND expires_at<=?",
            (now_epoch,),
        ).fetchall()
        connection.execute(
            "UPDATE jobs SET status='expired',error='AI 分析任务等待主机 Chrome 超时',updated_at=? "
            "WHERE status='queued' AND type='analyze_video' AND expires_at<=?",
            (now, now_epoch),
        )
        connection.execute(
            "UPDATE jobs SET status='expired',error='任务等待主机 Chrome 超时',updated_at=? "
            "WHERE status='queued' AND type!='analyze_video' AND expires_at<=?",
            (now, now_epoch),
        )
        connection.execute(
            "UPDATE jobs SET status='queued',claimed_by=NULL,claim_until=NULL,claim_token=NULL,progress_json=NULL,"
            "error=NULL,updated_at=? WHERE status IN ('claimed','running') AND claimed_by IS NOT NULL AND claim_until<=?",
            (now, now_epoch),
        )
        for job in expired_analysis_jobs:
            message = "AI 分析任务等待主机 Chrome 超时"
            connection.execute(
                "UPDATE analysis_runs SET status='expired',error=?,updated_at=? WHERE job_id=? AND status='queued'",
                (message, now, job["id"]),
            )
            try:
                video_id = str(json.loads(job["payload_json"]).get("videoId") or "")
            except (TypeError, json.JSONDecodeError):
                video_id = ""
            video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if video_row:
                video = json.loads(video_row["data_json"])
                if video.get("analysisStatus") == "queued":
                    video.update({"analysisStatus": "error", "analysisError": message, "analysisUsage": None})
                    connection.execute(
                        "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                        (_compact_json(video), now, video_id),
                    )

    def list_jobs(self, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(500, int(limit)))
        with self.transaction() as connection:
            self.expire_and_requeue(connection)
            rows = connection.execute("SELECT * FROM jobs ORDER BY created_epoch DESC,rowid DESC LIMIT ?", (limit,)).fetchall()
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
            if not allowed:
                connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))
                return None
            placeholders = ""
            parameters: list[Any] = []
            where = "status='queued'"
            placeholders = ",".join("?" for _ in allowed)
            where += f" AND type IN ({placeholders})"
            parameters.extend(sorted(allowed))
            row = connection.execute(
                f"SELECT * FROM jobs WHERE {where} ORDER BY created_epoch LIMIT 1", parameters
            ).fetchone()
            if not row:
                connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))
                return None
            claim_token = str(uuid.uuid4())
            job_ttl = self.config.analysis_job_expiry_seconds if row["type"] == "analyze_video" else self.config.job_expiry_seconds
            connection.execute(
                "UPDATE jobs SET status='claimed',claimed_by=?,claim_until=?,claim_token=?,expires_at=?,"
                "attempt_count=attempt_count+1,updated_at=? WHERE id=?",
                (
                    connector_id,
                    now_epoch + self.config.claim_lease_seconds,
                    claim_token,
                    max(int(row["expires_at"]), now_epoch + job_ttl),
                    utc_now(),
                    row["id"],
                ),
            )
            connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))
            claimed = connection.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()
        return _job_dict(claimed)

    def heartbeat_job(self, connector_id: str, job_id: str | None, claim_token: str | None = None) -> dict[str, Any] | None:
        now_epoch = int(time.time())
        with self.transaction() as connection:
            self.expire_and_requeue(connection)
            connection.execute("UPDATE connectors SET last_seen_at=? WHERE id=?", (utc_now(), connector_id))
            if not job_id:
                return None
            row = connection.execute("SELECT * FROM jobs WHERE id=? AND claimed_by=?", (job_id, connector_id)).fetchone()
            if not row or row["status"] not in ("claimed", "running"):
                return None
            if not claim_token or row["claim_token"] != claim_token:
                raise ValueError("任务领取凭据已失效，旧执行已被隔离")
            job_ttl = self.config.analysis_job_expiry_seconds if row["type"] == "analyze_video" else self.config.job_expiry_seconds
            connection.execute(
                "UPDATE jobs SET claim_until=?,expires_at=?,updated_at=? WHERE id=?",
                (
                    now_epoch + self.config.claim_lease_seconds,
                    max(int(row["expires_at"]), now_epoch + job_ttl),
                    utc_now(),
                    job_id,
                ),
            )
            current = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _job_dict(current)

    def process_connector_event(
        self,
        connector_id: str,
        job_id: str | None,
        claim_token: str | None,
        event_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> tuple[bool, dict[str, Any]]:
        event_id = _identifier(event_id, "eventId")
        if job_id is not None:
            job_id = _identifier(job_id, "jobId")
        payload = dict(_object(payload, "payload"))
        with self.transaction() as connection:
            processed = connection.execute(
                "SELECT 1 FROM processed_events WHERE connector_id=? AND event_id=?",
                (connector_id, event_id),
            ).fetchone()
            if processed:
                current = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone() if job_id else None
                return True, _job_dict(current) if current else {"id": None, "status": "accepted"}
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone() if job_id else None
            if job_id and not job:
                raise ValueError("任务不存在")
            if job and job["claimed_by"] != connector_id:
                raise ValueError("任务不属于当前 connector")
            if job and (not claim_token or job["claim_token"] != claim_token):
                raise ValueError("任务领取凭据已失效，旧执行结果已拒绝")
            if job and job["status"] not in ("claimed", "running"):
                raise ValueError("任务已结束，拒绝迟到的执行结果")
            if not job and event_type not in ("collection_result", "job_completed", "job_failed"):
                raise ValueError("此事件必须关联任务")
            connection.execute(
                "INSERT INTO processed_events(connector_id,event_id,job_id,processed_at) VALUES(?,?,?,?)",
                (connector_id, event_id, job_id, utc_now()),
            )

            # Manual collection is now queue-only. A pre-v0.8 extension may
            # still replay an old six-hour alarm without a host job. Acknowledge
            # and discard that legacy event so it cannot mutate saved data or
            # remain stuck in the connector outbox.
            if job is None:
                return False, {
                    "id": None,
                    "status": "ignored",
                    "ignoredReason": "unsolicited_collection_disabled",
                }

            status = job["status"] if job else "running"
            if event_type in ("started", "progress"):
                status = "running"
                connection.execute(
                    "UPDATE jobs SET status=?,progress_json=?,updated_at=? WHERE id=?",
                    (status, _compact_json(payload), utc_now(), job_id),
                )
            elif event_type == "collection_result":
                if payload.get("pendingVideos"):
                    raise ValueError("不允许提交未完成的采集结果")
                account_values = payload.get("accounts") or ([payload["account"]] if isinstance(payload.get("account"), dict) else [])
                for account in account_values:
                    normalized = dict(_object(account, "account"))
                    account_id = _identifier(normalized.get("id"), "account.id")
                    completed_at = str(payload.get("completedAt") or utc_now())
                    normalized["lastCheckedAt"] = completed_at
                    normalized["lastSuccessAt"] = completed_at
                    normalized["pendingVideos"] = []  # Clear legacy incomplete records after a full capture.
                    normalized["status"] = "ready"
                    normalized["collectionError"] = None
                    normalized["currentSyncMode"] = None
                    account_videos = [
                        video for video in payload.get("videos") or []
                        if str(video.get("accountId") or payload.get("accountId") or "") == account_id
                    ]
                    video_ids = list(dict.fromkeys(str(video.get("id")) for video in account_videos if video.get("id")))
                    if video_ids:
                        normalized["latestVideoIds"] = video_ids[:5]
                    if payload.get("mode") in ("initial", "archive", "archive30"):
                        normalized["initialSyncStatus"] = "complete"
                        normalized["initialSyncCompletedAt"] = completed_at
                    elif payload.get("mode") == "latest":
                        placeholders = ",".join("?" for _ in video_ids)
                        existing_video_ids = {
                            str(row["id"])
                            for row in connection.execute(
                                f"SELECT id FROM videos WHERE account_id=? AND id IN ({placeholders})",
                                (account_id, *video_ids),
                            )
                        } if video_ids else set()
                        new_video_ids = [video_id for video_id in video_ids if video_id not in existing_video_ids]
                        normalized["latestCheckNewVideoCount"] = len(new_video_ids)
                        normalized["latestCheckNewVideoIds"] = new_video_ids
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
                        "UPDATE jobs SET status='succeeded',result_json=?,progress_json=NULL,error=NULL,claimed_by=NULL,"
                        "claim_until=NULL,claim_token=NULL,updated_at=? WHERE id=?",
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
                        video.update({"analysisStatus": "error", "analysisError": message, "analysisUsage": None})
                        if not video.get("transcript"):
                            video.update({"transcriptStatus": "idle", "transcriptError": None})
                        connection.execute(
                            "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                            (_compact_json(video), utc_now(), failed_video_id),
                        )
                    connection.execute(
                        "UPDATE analysis_runs SET status='failed',usage_json=NULL,error=?,updated_at=? "
                        "WHERE job_id=? AND status NOT IN ('succeeded','failed','expired','cancelled')",
                        (message, utc_now(), job_id),
                    )
                if job_id:
                    connection.execute(
                        "UPDATE jobs SET status='failed',error=?,result_json=?,progress_json=NULL,claimed_by=NULL,claim_until=NULL,"
                        "claim_token=NULL,updated_at=? WHERE id=?",
                        (message, _compact_json(payload), utc_now(), job_id),
                    )
            elif event_type == "analysis_media":
                if not job or job["type"] != "analyze_video":
                    raise ValueError("仅视频分析任务可提交媒体")
                video_id = _identifier(payload.get("videoId"), "videoId")
                job_payload = json.loads(job["payload_json"])
                if video_id != str(job_payload.get("videoId")):
                    raise ValueError("媒体 videoId 与任务目标不一致")
                video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
                video = json.loads(video_row["data_json"]) if video_row else None
                metadata = payload.get("videoMetadata") if isinstance(payload.get("videoMetadata"), dict) else {}
                if video and video.get("isLinkAnalysis") is True:
                    required_metadata = {
                        "标题": metadata.get("title"),
                        "封面": metadata.get("coverUrl"),
                        "博主名称": metadata.get("authorName"),
                        "博主头像": metadata.get("authorAvatarUrl"),
                        "博主主页": metadata.get("authorProfileUrl"),
                    }
                    missing = [label for label, value in required_metadata.items() if not isinstance(value, str) or not value.strip()]
                    if missing:
                        raise ValueError(f"视频链接分析未取得完整页面信息：{'、'.join(missing)}")
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
                    "UPDATE jobs SET status='running',progress_json=?,claimed_by=NULL,claim_until=NULL,claim_token=NULL,updated_at=? WHERE id=?",
                    (_compact_json({"stage": "media_received"}), utc_now(), job_id),
                )
                if video:
                    for key in (
                        "title",
                        "description",
                        "coverUrl",
                        "publishedAt",
                        "durationSeconds",
                        "likeCount",
                        "commentCount",
                        "favoriteCount",
                        "shareCount",
                        "authorName",
                        "authorAvatarUrl",
                        "authorProfileUrl",
                    ):
                        value = metadata.get(key)
                        if value is not None and value != "":
                            video[key] = value
                    if video.get("isLinkAnalysis") is True:
                        video["capturedAt"] = utc_now()
                        video["lastSeenAt"] = video["capturedAt"]
                    video.update({"analysisStatus": "processing", "analysisError": None, "analysisUsage": None})
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

    def save_analysis_transcript(self, job_id: str, transcript: str, usage: dict[str, Any]) -> None:
        """Checkpoint completed cloud speech without completing the video job."""
        raw_transcript = str(transcript or "").strip()
        restored = restore_transcript_text(raw_transcript)
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                raise ValueError("任务不存在")
            payload = json.loads(job["payload_json"])
            video_id = _identifier(payload.get("videoId"), "videoId")
            self._ensure_analysis_run(connection, job_id, payload, status="running")
            row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if not row:
                raise ValueError("分析目标视频不存在")
            updated_at = utc_now()
            video = json.loads(row["data_json"])
            video.update({"transcript": restored, "transcriptStatus": "ready", "transcriptUpdatedAt": updated_at,
                          "transcriptError": None, "analysisUsage": usage})
            connection.execute("UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                               (_compact_json(video), updated_at, video_id))
            connection.execute(
                "UPDATE analysis_runs SET status=?,transcript_raw=?,transcript=?,usage_json=?,updated_at=? WHERE job_id=?",
                ("cancelled" if job["status"] == "cancelled" else "running", raw_transcript, restored, _compact_json(usage), updated_at, job_id),
            )

    def save_analysis_success(
        self,
        job_id: str,
        transcript: str,
        analysis: dict[str, Any],
        source_hash: str,
        usage: dict[str, Any],
    ) -> None:
        raw_transcript = str(transcript or "").strip()
        transcript = restore_transcript_text(transcript)
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                raise ValueError("任务不存在")
            payload = json.loads(job["payload_json"])
            video_id = _identifier(payload.get("videoId"), "videoId")
            self._ensure_analysis_run(connection, job_id, payload, status="running")
            video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if not video_row:
                raise ValueError("分析目标视频不存在")
            updated_at = utc_now()
            video = json.loads(video_row["data_json"])
            # A targeted completion can return only one requested section.
            analysis = {**(video.get("analysis") or {}), **analysis}
            video.update(
                {
                    "transcript": transcript,
                    "transcriptStatus": "ready",
                    "transcriptUpdatedAt": updated_at,
                    "transcriptError": None,
                    "analysis": analysis,
                    "analysisUsage": usage,
                    "analysisStatus": "ready",
                    "analysisUpdatedAt": updated_at,
                    "analysisError": None,
                    "analysisDiagnostics": None,
                    "sourceHash": source_hash,
                }
            )
            connection.execute(
                "UPDATE videos SET source_hash=?,data_json=?,updated_at=? WHERE id=?",
                (source_hash, _compact_json(video), updated_at, video_id),
            )
            connection.execute(
                "UPDATE analysis_runs SET source_hash=?,status=?,transcript_raw=?,transcript=?,analysis_json=?,usage_json=?,error=NULL,updated_at=? WHERE job_id=?",
                (source_hash, "cancelled" if job["status"] == "cancelled" else "succeeded", raw_transcript, transcript, _compact_json(analysis), _compact_json(usage), updated_at, job_id),
            )
            result = {"videoId": video_id, "transcriptRaw": raw_transcript, "transcript": transcript, "analysis": analysis, "analysisUsage": usage, "sourceHash": source_hash}
            cancelled = job["status"] == "cancelled"
            if cancelled:
                video.update({"analysisStatus": "ready", "analysisError": None})
            connection.execute(
                "UPDATE jobs SET status=?,result_json=?,progress_json=NULL,error=NULL,updated_at=? WHERE id=?",
                ("cancelled" if cancelled else "succeeded", _compact_json(result), updated_at, job_id),
            )

    def save_analysis_failure(
        self,
        job_id: str,
        message: str,
        transcript: str | None = None,
        usage: dict[str, Any] | None = None,
        diagnostics: dict[str, Any] | None = None,
    ) -> None:
        safe_message = safe_error(message)
        raw_transcript = str(transcript).strip() if transcript is not None else None
        if transcript is not None:
            transcript = restore_transcript_text(transcript)
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                return
            payload = json.loads(job["payload_json"])
            cancelled = job["status"] == "cancelled"
            video_id = str(payload.get("videoId") or "")
            self._ensure_analysis_run(connection, job_id, payload, status="running")
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
                video.update({"analysisStatus": "cancelled" if cancelled else "error", "analysisError": safe_message, "analysisUsage": usage})
                if diagnostics is not None:
                    video["analysisDiagnostics"] = diagnostics
                connection.execute(
                    "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                    (_compact_json(video), utc_now(), video_id),
                )
            connection.execute(
                "UPDATE analysis_runs SET status=?,transcript_raw=COALESCE(?,transcript_raw),"
                "transcript=COALESCE(?,transcript),usage_json=?,error=?,updated_at=? WHERE job_id=?",
                ("cancelled" if cancelled else "failed", raw_transcript, transcript, _compact_json(usage) if usage is not None else None, safe_message, utc_now(), job_id),
            )
            connection.execute(
                "UPDATE jobs SET status=?,error=?,result_json=COALESCE(?,result_json),progress_json=NULL,updated_at=? WHERE id=?",
                ("cancelled" if cancelled else "failed", safe_message,
                 _compact_json({"diagnostics": diagnostics}) if diagnostics is not None else None, utc_now(), job_id),
            )

    def update_job_progress(self, job_id: str, stage: str, **detail: Any) -> None:
        with self.transaction() as connection:
            connection.execute(
                "UPDATE jobs SET status='running',progress_json=?,updated_at=? WHERE id=? AND status IN ('queued','claimed','running')",
                (_compact_json({"stage": stage, **detail}), utc_now(), job_id),
            )

    def start_host_analysis(self, job_id: str) -> None:
        """Hand the full capture/download attempt budget to the analysis worker."""
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] not in ACTIVE_JOB_STATUSES:
                return
            payload = json.loads(row["payload_json"])
            self._ensure_analysis_run(connection, job_id, payload, status="running")
            connection.execute("UPDATE analysis_runs SET status='running',updated_at=? WHERE job_id=?", (utc_now(), job_id))
            connection.execute("UPDATE jobs SET status='running',claimed_by=NULL,claim_until=NULL,claim_token=NULL,updated_at=? WHERE id=?", (utc_now(), job_id))

    def save_analysis_media_metadata(self, job_id: str, media: dict[str, Any]) -> None:
        """Persist public metadata, never CDN addresses or temporary media."""
        with self.transaction() as connection:
            job = connection.execute("SELECT payload_json FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                raise ValueError("任务不存在")
            video_id = str(json.loads(job["payload_json"]).get("videoId"))
            if str(media.get("videoId")) != video_id:
                raise ValueError("媒体 videoId 与任务目标不一致")
            row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if not row:
                raise ValueError("分析目标视频不存在")
            video = json.loads(row["data_json"])
            metadata = media.get("videoMetadata") or {}
            if video.get("isLinkAnalysis") is True:
                required = ("title", "coverUrl", "authorName", "authorAvatarUrl", "authorProfileUrl")
                if any(not isinstance(metadata.get(key), str) or not metadata[key].strip() for key in required):
                    raise ValueError("视频链接分析未取得完整页面信息")
            for key in ("title", "description", "coverUrl", "publishedAt", "durationSeconds", "likeCount", "commentCount", "favoriteCount", "shareCount", "authorName", "authorAvatarUrl", "authorProfileUrl"):
                if metadata.get(key) is not None and metadata.get(key) != "":
                    video[key] = metadata[key]
            video.update({"analysisStatus": "processing", "analysisError": None})
            if video.get("isLinkAnalysis") is True:
                video.update({"capturedAt": utc_now(), "lastSeenAt": utc_now()})
            connection.execute("UPDATE videos SET data_json=?,updated_at=? WHERE id=?", (_compact_json(video), utc_now(), video_id))

    def save_analysis_checkpoint(self, job_id: str, analysis: dict[str, Any], usage: dict[str, Any] | None, source_hash: str) -> None:
        """Save validated independent sections without declaring all complete."""
        with self.transaction() as connection:
            job = connection.execute("SELECT payload_json FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                raise ValueError("任务不存在")
            video_id = str(json.loads(job["payload_json"]).get("videoId"))
            row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
            if not row:
                raise ValueError("分析目标视频不存在")
            video = json.loads(row["data_json"])
            merged = {**(video.get("analysis") or {}), **analysis}
            video.update({"analysis": merged, "analysisUsage": usage, "analysisUpdatedAt": utc_now(), "sourceHash": source_hash})
            connection.execute("UPDATE videos SET source_hash=?,data_json=?,updated_at=? WHERE id=?", (source_hash, _compact_json(video), utc_now(), video_id))
            connection.execute("UPDATE analysis_runs SET analysis_json=?,usage_json=?,source_hash=?,updated_at=? WHERE job_id=?", (_compact_json(merged), _compact_json(usage), source_hash, utc_now(), job_id))

    def restore_superseded_analysis_history(self, result: dict[str, Any]) -> bool:
        """Recover an older paid receipt without replacing newer video results.

        SQLite queue insertion order is unambiguous even when both tasks were
        created within the same timestamp. This runs during startup recovery,
        before new browser/analysis work is dispatched.
        """
        job_id = str(result.get("jobId") or "")
        with self.transaction() as connection:
            job = connection.execute("SELECT rowid AS queue_order,* FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job:
                return False
            payload = json.loads(job["payload_json"])
            video_id = str(payload.get("videoId") or "")
            if video_id != str(result.get("videoId") or ""):
                raise ValueError("恢复结果与任务视频不一致")
            newer = connection.execute(
                "SELECT 1 FROM jobs newer JOIN analysis_runs run ON run.job_id=newer.id "
                "WHERE newer.rowid>? AND run.video_id=? AND (run.analysis_json IS NOT NULL OR run.transcript IS NOT NULL) LIMIT 1",
                (job["queue_order"], video_id),
            ).fetchone()
            if not newer:
                return False
            self._ensure_analysis_run(connection, job_id, payload)
            transcript = result.get("transcript")
            raw_transcript = str(transcript).strip() if transcript is not None else None
            restored = restore_transcript_text(raw_transcript) if raw_transcript is not None else None
            analysis = result.get("analysis")
            usage = result.get("usage")
            diagnostics = result.get("diagnostics") or {}
            complete = {"transcript", "content", "remotion"}.issubset(set(diagnostics.get("completedSteps") or []))
            status = "cancelled" if job["status"] == "cancelled" else "succeeded" if complete else "failed"
            message = None if status == "succeeded" else safe_error(diagnostics.get("lastError") or "已恢复旧任务结果；当前视频保留更新任务的结果")
            now = utc_now()
            connection.execute(
                "UPDATE analysis_runs SET status=?,transcript_raw=COALESCE(?,transcript_raw),transcript=COALESCE(?,transcript),"
                "analysis_json=COALESCE(?,analysis_json),usage_json=?,source_hash=COALESCE(?,source_hash),error=?,updated_at=? WHERE job_id=?",
                (status, raw_transcript, restored, _compact_json(analysis) if analysis else None,
                 _compact_json(usage) if usage is not None else None, result.get("sourceHash") or None, message, now, job_id),
            )
            connection.execute(
                "UPDATE jobs SET status=?,result_json=?,progress_json=NULL,error=?,updated_at=? WHERE id=?",
                (status, _compact_json({"videoId": video_id, "transcript": restored, "analysis": analysis,
                                       "analysisUsage": usage, "sourceHash": result.get("sourceHash"), "diagnostics": diagnostics}), message, now, job_id),
            )
        return True

    def cancel_job(self, job_id: str) -> dict[str, Any] | None:
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            if row["status"] in ACTIVE_JOB_STATUSES:
                connection.execute("UPDATE jobs SET status='cancelled',error='用户已取消任务',progress_json=NULL,claimed_by=NULL,claim_until=NULL,claim_token=NULL,updated_at=? WHERE id=?", (utc_now(), job_id))
                connection.execute("UPDATE analysis_runs SET status='cancelled',error='用户已取消任务',updated_at=? WHERE job_id=?", (utc_now(), job_id))
                payload = json.loads(row["payload_json"])
                video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (str(payload.get("videoId")),)).fetchone()
                if video_row:
                    video = json.loads(video_row["data_json"])
                    video.update({"analysisStatus": "cancelled", "analysisError": "用户已取消任务；已完成结果保留"})
                    connection.execute("UPDATE videos SET data_json=?,updated_at=? WHERE id=?", (_compact_json(video), utc_now(), str(payload.get("videoId"))))
            current = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _job_dict(current)

    def mark_stale_analysis_failed(self) -> int:
        """Recover tasks interrupted by a service or machine restart."""
        with self.transaction() as connection:
            rows = connection.execute(
                "SELECT analysis_runs.job_id,analysis_runs.usage_json,jobs.payload_json FROM analysis_runs "
                "LEFT JOIN jobs ON jobs.id=analysis_runs.job_id WHERE analysis_runs.status='running'"
            ).fetchall()
            now = utc_now()
            for row in rows:
                message = "主机服务在分析过程中重启，请重新发起分析"
                connection.execute(
                    "UPDATE analysis_runs SET status='failed',error=?,updated_at=? WHERE job_id=?",
                    (message, now, row["job_id"]),
                )
                connection.execute(
                    "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?",
                    (message, now, row["job_id"]),
                )
                try:
                    payload = json.loads(row["payload_json"] or "{}")
                    video_id = str(payload.get("videoId") or "") if isinstance(payload, dict) else ""
                except json.JSONDecodeError:
                    video_id = ""
                video_row = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
                if video_row:
                    usage = None
                    if row["usage_json"]:
                        try:
                            usage_candidate = json.loads(row["usage_json"])
                            usage = usage_candidate if isinstance(usage_candidate, dict) else None
                        except json.JSONDecodeError:
                            usage = None
                    video = json.loads(video_row["data_json"])
                    video.update({"analysisStatus": "error", "analysisError": message, "analysisUsage": usage})
                    connection.execute(
                        "UPDATE videos SET data_json=?,updated_at=? WHERE id=?",
                        (_compact_json(video), now, video_id),
                    )
        return len(rows)
