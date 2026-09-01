"""Integration checks for the LAN host API, queue, persistence, and mock analysis."""

from __future__ import annotations

import hashlib
import http.client
import json
import sys
import tempfile
import threading
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from host_service import analysis as analysis_module  # noqa: E402
from host_service.analysis import AnalysisManager  # noqa: E402
from host_service.compatibility import (  # noqa: E402
    MINIMUM_ANALYSIS_EXTENSION_VERSION,
    semver_at_least,
)
from host_service.config import HostConfig  # noqa: E402
from host_service.database import Database  # noqa: E402
from host_service.qwen import (  # noqa: E402
    QWEN_VIDEO_MAX_PIXELS,
    QWEN_VIDEO_TOTAL_PIXELS,
    QwenClient,
)
from host_service.server import create_server  # noqa: E402


LOCAL_ORIGIN = "http://localhost:3000"
REMOTE_ORIGIN = "http://192.168.31.99:3000"
EXTENSION_ID = "a" * 32
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
ACCESS_PASSWORD = "test-access-password"
FAKE_API_KEY = "sk-test-key-that-must-be-encrypted"
CURRENT_EXTENSION_VERSION = "0.8.0"


def require(condition: Any, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class ApiClient:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.cookie: str | None = None
        self.csrf: str | None = None

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        origin: str = LOCAL_ORIGIN,
        bearer: str | None = None,
        use_cookie: bool = True,
        csrf: str | None = None,
    ) -> tuple[int, dict[str, Any], list[tuple[str, str]]]:
        headers = {"Origin": origin, "Connection": "close"}
        raw_body: bytes | None = None
        if body is not None:
            raw_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(raw_body))
        if use_cookie and self.cookie:
            headers["Cookie"] = self.cookie
        active_csrf = self.csrf if csrf is None else csrf
        if active_csrf and method != "GET":
            headers["X-CSRF-Token"] = active_csrf
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        connection = http.client.HTTPConnection(self.host, self.port, timeout=10)
        try:
            connection.request(method, path, body=raw_body, headers=headers)
            response = connection.getresponse()
            response_headers = response.getheaders()
            raw = response.read()
            payload = json.loads(raw.decode("utf-8")) if raw else {}
            for name, value in response_headers:
                if name.lower() == "set-cookie":
                    self.cookie = value.split(";", 1)[0]
            if isinstance(payload.get("csrfToken"), str):
                self.csrf = payload["csrfToken"]
            return response.status, payload, response_headers
        finally:
            connection.close()


def create_test_config(root: Path) -> HostConfig:
    base = HostConfig.from_env()
    return replace(
        base,
        listen_host="127.0.0.1",
        listen_port=0,
        data_dir=root,
        db_path=root / "monitor.sqlite3",
        secret_path=root / "qwen-secret.dpapi",
        temp_dir=root / "tmp",
        backup_dir=root / "migration-backups",
        dashboard_port=3000,
        testing=True,
        mock_qwen=False,
    )


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="douyin-host-test-") as temporary:
        root = Path(temporary)
        config = create_test_config(root)
        require(MINIMUM_ANALYSIS_EXTENSION_VERSION == CURRENT_EXTENSION_VERSION, "host extension version floor drifted")
        require(not semver_at_least("0.7.0", CURRENT_EXTENSION_VERSION), "legacy extension passed the version floor")
        require(semver_at_least("0.8.0", CURRENT_EXTENSION_VERSION), "current extension failed the version floor")
        require(semver_at_least("0.9.0", CURRENT_EXTENSION_VERSION), "future extension failed the version floor")
        require(not semver_at_least("0.8.0-beta.1", CURRENT_EXTENSION_VERSION), "prerelease passed the stable floor")
        qwen_client = QwenClient(config, None)
        short_video = qwen_client._video_content("mock://short", {"durationSeconds": 20})
        long_video = qwen_client._video_content("mock://long", {"durationSeconds": 80})
        require(short_video["fps"] == 10.0, "short video did not use the maximum Qwen sampling rate")
        require(long_video["fps"] == 5.0, "long video sampling did not preserve full per-frame detail")
        require(short_video["max_pixels"] == QWEN_VIDEO_MAX_PIXELS, "Qwen frame pixel budget is not maximal")
        require(short_video["total_pixels"] == QWEN_VIDEO_TOTAL_PIXELS, "Qwen total pixel budget is not maximal")
        qwen_client._model_request_attempts = 2
        qwen_client._record_usage({
            "id": "request-one",
            "model": "qwen3.8-flash",
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 100,
                "total_tokens": 1100,
                "prompt_tokens_details": {"cached_tokens": 100, "video_tokens": 800},
                "completion_tokens_details": {"reasoning_tokens": 50},
            },
        })
        qwen_client._record_usage({
            "id": "request-two",
            "model": "qwen3.8-flash",
            "usage": {
                "prompt_tokens": 2000,
                "completion_tokens": 200,
                "total_tokens": 2200,
                "prompt_tokens_details": {"video_tokens": 1800},
                "completion_tokens_details": {"reasoning_tokens": 75},
            },
        })
        usage_summary = qwen_client.usage_summary()
        require(usage_summary["requestCount"] == 2, "Qwen multi-call usage was not aggregated")
        require(usage_summary["videoTokens"] == 2600, "Qwen video token detail was not retained")
        require(usage_summary["reasoningTokens"] == 125, "Qwen reasoning token detail was not retained")
        require(abs(usage_summary["estimatedCostCny"] - 0.00314) < 0.00000001, "Qwen list-price estimate is wrong")

        malformed_usage_client = QwenClient(config, None)
        malformed_usage_client._model_request_attempts = 1
        require(not malformed_usage_client._record_usage({"usage": {}}), "malformed usage was accepted")
        malformed_summary = malformed_usage_client.usage_summary()
        require(malformed_summary["usageComplete"] is False, "malformed usage was reported complete")
        require(malformed_summary["estimatedCostCny"] is None, "malformed usage was misreported as zero cost")
        require(malformed_summary["attemptedRequestCount"] == 1, "attempted request count was lost")

        partial_usage_client = QwenClient(config, None)
        partial_usage_client._model_request_attempts = 2
        partial_usage_client._record_usage({
            "id": "known-request",
            "model": "qwen3.8-flash",
            "usage": {"prompt_tokens": 500, "completion_tokens": 50, "total_tokens": 550},
        })
        partial_usage_client._usage_incomplete = True
        partial_summary = partial_usage_client.usage_summary()
        require(partial_summary["requestCount"] == 1, "known partial token receipt was discarded")
        require(partial_summary["attemptedRequestCount"] == 2, "partial attempt count is wrong")
        require(partial_summary["totalTokens"] == 550, "known partial token subtotal is wrong")
        require(partial_summary["estimatedCostCny"] is None, "partial usage received a misleading estimate")

        zero_request_client = QwenClient(config, None)
        zero_summary = zero_request_client.usage_summary()
        require(zero_summary["usageComplete"] is True, "zero-request failure cannot prove that no model call started")
        require(zero_summary["estimatedCostCny"] == 0, "zero model requests should have zero model cost")
        server = create_server(config)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        client = ApiClient("127.0.0.1", server.server_port)
        try:
            status, payload, _ = client.request("GET", "/health", origin="")
            require(status == 200 and payload.get("ok") is True, "health endpoint failed")

            status, payload, _ = client.request("GET", "/api/auth/status", use_cookie=False)
            require(status == 200 and payload.get("setupRequired") is True, "first-run status is wrong")
            require(payload.get("setupAllowed") is True, "localhost must be allowed to set the first password")

            status, payload, _ = client.request(
                "POST",
                "/api/auth/setup",
                {"password": ACCESS_PASSWORD},
                origin=REMOTE_ORIGIN,
                use_cookie=False,
            )
            require(status == 403, "LAN origin must not be able to perform first-run setup")

            status, payload, _ = client.request(
                "POST", "/api/auth/setup", {"password": ACCESS_PASSWORD}, use_cookie=False
            )
            require(status == 201 and payload.get("authenticated") is True, "localhost password setup failed")
            setup_csrf = client.csrf
            require(bool(client.cookie and setup_csrf), "setup did not establish a protected session")

            status, payload, _ = client.request("GET", "/api/auth/status")
            require(status == 200 and payload.get("authenticated") is True, "session status failed")
            require(client.csrf != setup_csrf, "auth status must issue a fresh CSRF token")

            account = {
                "id": "account-a",
                "platform": "douyin",
                "url": "https://www.douyin.com/user/account-a",
                "name": "监控账号 A",
                "addedAt": "2026-08-01T00:00:00.000Z",
                "initialSyncStatus": "pending",
            }
            status, _, _ = client.request("POST", "/api/accounts/upsert", {"account": account})
            require(status == 200, "account upsert failed")

            status, pair, _ = client.request(
                "POST",
                "/connector/pair",
                {
                    "extensionId": EXTENSION_ID,
                    "extensionVersion": CURRENT_EXTENSION_VERSION,
                    "workerId": "worker-test",
                    "capabilities": ["collect_latest", "archive_account", "analyze_video"],
                },
                origin=EXTENSION_ORIGIN,
                use_cookie=False,
                csrf="",
            )
            require(status == 201 and isinstance(pair.get("token"), str), "extension pairing failed")
            connector_token = pair["token"]

            status, archive_created, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "archive_account", "payload": {"accountId": "account-a"}},
            )
            require(status == 201 and archive_created.get("created") is True, "archive job was not created")
            archive_job_id = archive_created["job"]["id"]

            status, empty_capability_claim, _ = client.request(
                "POST",
                "/connector/jobs/claim",
                {"capabilities": []},
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200 and empty_capability_claim.get("job") is None, "empty capabilities must claim nothing")

            status, claimed, _ = client.request(
                "POST",
                "/connector/jobs/claim",
                {"capabilities": ["archive_account"]},
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200 and claimed.get("job", {}).get("id") == archive_job_id, "archive claim failed")
            archive_claim_token = claimed["job"].get("claimToken")
            require(isinstance(archive_claim_token, str) and archive_claim_token, "archive claim token missing")
            with server.database.transaction() as connection:
                connection.execute("UPDATE jobs SET expires_at=0 WHERE id=?", (archive_job_id,))
            status, heartbeat, _ = client.request(
                "POST",
                "/connector/heartbeat",
                {
                    "jobId": archive_job_id,
                    "claimToken": archive_claim_token,
                    "status": "running",
                    "workerId": "worker-test",
                    "extensionVersion": CURRENT_EXTENSION_VERSION,
                    "capabilities": ["archive_account", "analyze_video"],
                },
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200 and heartbeat.get("job", {}).get("status") == "claimed", "active claim expired despite heartbeat")

            captured_at = "2026-08-30T00:00:00.000Z"
            video = {
                "id": "7530000000000000001",
                "accountId": "account-a",
                "title": "测试视频标题",
                "description": "测试视频正文",
                "url": "https://www.douyin.com/video/7530000000000000001",
                "coverUrl": "https://p.douyinpic.com/cover.jpeg",
                "publishedAt": "2026-08-29T00:00:00.000Z",
                "durationSeconds": 12,
                "playCount": 999999,
                "likeCount": 10,
                "commentCount": 20,
                "favoriteCount": 30,
                "shareCount": 40,
                "capturedAt": captured_at,
            }
            collection_event = {
                "jobId": archive_job_id,
                "claimToken": archive_claim_token,
                "eventId": f"{archive_job_id}:account-a",
                "type": "collection_result",
                "payload": {
                    "accountId": "account-a",
                    "mode": "initial",
                    "account": {
                        "id": "account-a",
                        "platform": "douyin",
                        "url": account["url"],
                        "name": "采集后的账号 A",
                        "avatarUrl": "https://p.douyinpic.com/avatar.jpeg",
                    },
                    "videos": [video],
                    "snapshots": [
                        {
                            "videoId": video["id"],
                            "accountId": "account-a",
                            "capturedAt": captured_at,
                            "likeCount": 10,
                            "commentCount": 20,
                            "favoriteCount": 30,
                            "shareCount": 40,
                        }
                    ],
                    "completedAt": captured_at,
                },
            }
            status, accepted, _ = client.request(
                "POST",
                "/connector/events",
                collection_event,
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200 and accepted.get("duplicate") is False, "collection result was not accepted")
            status, duplicate, _ = client.request(
                "POST",
                "/connector/events",
                collection_event,
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200 and duplicate.get("duplicate") is True, "event idempotency failed")
            status, _, _ = client.request(
                "POST",
                "/connector/events",
                {
                    "jobId": archive_job_id,
                    "claimToken": archive_claim_token,
                    "eventId": f"{archive_job_id}:completed",
                    "type": "job_completed",
                    "payload": {"succeeded": 1, "failed": 0},
                },
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200, "archive completion event failed")
            status, _, _ = client.request(
                "POST",
                "/connector/events",
                {
                    "jobId": archive_job_id,
                    "claimToken": archive_claim_token,
                    "eventId": f"{archive_job_id}:late-old-attempt",
                    "type": "job_failed",
                    "payload": {"message": "late result"},
                },
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 400, "late result from a finished attempt was not fenced")

            legacy_video = dict(video)
            legacy_video.update({"likeCount": 999, "capturedAt": "2026-08-30T06:00:00.000Z"})
            status, legacy_ignored, _ = client.request(
                "POST",
                "/connector/events",
                {
                    "jobId": None,
                    "eventId": "legacy-six-hour-result",
                    "type": "collection_result",
                    "payload": {
                        "accountId": "account-a",
                        "mode": "latest",
                        "videos": [legacy_video],
                        "completedAt": legacy_video["capturedAt"],
                    },
                },
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(
                status == 200 and legacy_ignored.get("job", {}).get("status") == "ignored",
                "legacy jobless scheduled collection was not acknowledged and discarded",
            )

            status, state, _ = client.request("GET", "/api/state")
            require(status == 200 and len(state.get("videos", [])) == 1, "shared video state is incomplete")
            require("playCount" not in state["videos"][0], "removed play-count metric was persisted")
            saved_account = state["accounts"][0]
            require(saved_account.get("addedAt") == account["addedAt"], "collection overwrote preserved account fields")
            require(saved_account.get("initialSyncStatus") == "complete", "initial archive status was not persisted")
            require(saved_account.get("avatarUrl"), "account avatar was not persisted")
            require(len(state.get("snapshots", [])) == 1, "snapshot deduplication failed")
            require(state["videos"][0].get("likeCount") == 10, "legacy scheduled result mutated saved video data")
            require("analyze_video" in state.get("connector", {}).get("capabilities", []), "connector capabilities missing")
            require(
                state.get("connector", {}).get("extensionVersion") == CURRENT_EXTENSION_VERSION,
                "connector extension version was not persisted",
            )

            new_video = dict(video)
            new_video.update(
                {
                    "id": "7530000000000000002",
                    "url": "https://www.douyin.com/video/7530000000000000002",
                    "title": "本轮新增视频",
                    "capturedAt": "2026-08-30T08:00:00.000Z",
                }
            )
            latest_payloads = [
                ("latest-check-with-update", [video, new_video], 1, [new_video["id"]]),
                ("latest-check-without-update", [video, new_video], 0, []),
            ]
            for sequence, (idempotency_key, latest_videos, expected_count, expected_ids) in enumerate(latest_payloads, 1):
                status, latest_created, _ = client.request(
                    "POST",
                    "/api/jobs",
                    {
                        "type": "collect_latest",
                        "payload": {
                            "accountIds": ["account-a"],
                            "idempotencyKey": idempotency_key,
                        },
                    },
                )
                require(status == 201 and latest_created.get("created") is True, "latest collection job was not created")
                latest_job_id = latest_created["job"]["id"]
                status, latest_claimed, _ = client.request(
                    "POST",
                    "/connector/jobs/claim",
                    {"capabilities": ["collect_latest"]},
                    origin=EXTENSION_ORIGIN,
                    bearer=connector_token,
                    use_cookie=False,
                    csrf="",
                )
                latest_claim_token = latest_claimed.get("job", {}).get("claimToken")
                require(status == 200 and latest_claimed.get("job", {}).get("id") == latest_job_id, "latest collection claim failed")
                latest_captured_at = f"2026-08-30T{8 + sequence:02d}:00:00.000Z"
                status, _, _ = client.request(
                    "POST",
                    "/connector/events",
                    {
                        "jobId": latest_job_id,
                        "claimToken": latest_claim_token,
                        "eventId": f"{latest_job_id}:account-a",
                        "type": "collection_result",
                        "payload": {
                            "accountId": "account-a",
                            "mode": "latest",
                            "account": {"id": "account-a", "name": "采集后的账号 A", "url": account["url"]},
                            "videos": [{**item, "capturedAt": latest_captured_at} for item in latest_videos],
                            "completedAt": latest_captured_at,
                        },
                    },
                    origin=EXTENSION_ORIGIN,
                    bearer=connector_token,
                    use_cookie=False,
                    csrf="",
                )
                require(status == 200, "latest collection result failed")
                status, latest_state, _ = client.request("GET", "/api/state")
                latest_account = next(item for item in latest_state["accounts"] if item["id"] == "account-a")
                require(
                    status == 200
                    and latest_account.get("latestCheckNewVideoCount") == expected_count
                    and latest_account.get("latestCheckNewVideoIds") == expected_ids,
                    "latest collection update count was not persisted correctly",
                )
                status, _, _ = client.request(
                    "POST",
                    "/connector/events",
                    {
                        "jobId": latest_job_id,
                        "claimToken": latest_claim_token,
                        "eventId": f"{latest_job_id}:completed",
                        "type": "job_completed",
                        "payload": {"succeeded": 1, "failed": 0},
                    },
                    origin=EXTENSION_ORIGIN,
                    bearer=connector_token,
                    use_cookie=False,
                    csrf="",
                )
                require(status == 200, "latest collection completion failed")

            status, _, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "analyze_video", "payload": {"accountId": "account-a", "videoId": video["id"]}},
            )
            require(status == 428, "analysis must be rejected before Qwen configuration")

            status, _, _ = client.request(
                "POST",
                "/api/qwen/config",
                {"apiKey": FAKE_API_KEY},
                origin=REMOTE_ORIGIN,
            )
            require(status == 403, "LAN origin must not be able to write the API key")
            status, qwen_status, _ = client.request(
                "POST", "/api/qwen/config", {"apiKey": FAKE_API_KEY}
            )
            require(status == 200 and qwen_status.get("configured") is True, "Qwen key configuration failed")
            protected_secret = config.secret_path.read_bytes()
            require(FAKE_API_KEY.encode("utf-8") not in protected_secret, "API key was stored as plaintext")

            with server.database.transaction() as connection:
                connection.execute(
                    "UPDATE connectors SET extension_version='0.7.0',last_seen_at=? WHERE extension_id=?",
                    (datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), EXTENSION_ID),
                )
            status, _, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "analyze_video", "payload": {"accountId": "account-a", "videoId": video["id"]}},
                origin=REMOTE_ORIGIN,
            )
            require(status == 428, "legacy extension must not make analysis available")

            with server.database.transaction() as connection:
                connection.execute(
                    "UPDATE connectors SET extension_version=?,last_seen_at='2020-01-01T00:00:00.000Z' WHERE extension_id=?",
                    (CURRENT_EXTENSION_VERSION, EXTENSION_ID),
                )
            status, _, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "analyze_video", "payload": {"accountId": "account-a", "videoId": video["id"]}},
                origin=REMOTE_ORIGIN,
            )
            require(status == 428, "offline extension must not make analysis available")

            status, heartbeat, _ = client.request(
                "POST",
                "/connector/heartbeat",
                {
                    "jobId": None,
                    "status": "idle",
                    "workerId": "worker-test",
                    "extensionVersion": CURRENT_EXTENSION_VERSION,
                    "capabilities": ["archive_account", "analyze_video"],
                },
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200 and heartbeat.get("ok") is True, "compatible connector heartbeat failed")

            status, analyze_created, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "analyze_video", "payload": {"accountId": "account-a", "videoId": video["id"]}},
                origin=REMOTE_ORIGIN,
            )
            require(status == 201 and analyze_created.get("created") is True, "analysis job was not created from LAN")
            analyze_job = analyze_created["job"]
            require(analyze_job["payload"].get("videoUrl") == video["url"], "analysis job did not bind the saved video URL")
            require(analyze_job["payload"].get("title") == video["title"], "analysis job did not bind saved metadata")
            analysis_expiry = datetime.fromisoformat(analyze_job["expiresAt"].replace("Z", "+00:00"))
            require(
                (analysis_expiry - datetime.now(timezone.utc)).total_seconds() > 6 * 86400,
                "analysis queue should survive a temporary Chrome disconnect for several days",
            )

            status, duplicate_job, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "analyze_video", "payload": {"accountId": "account-a", "videoId": video["id"]}},
                origin=REMOTE_ORIGIN,
            )
            require(status == 200 and duplicate_job.get("created") is False, "analysis job deduplication failed")

            status, claimed_analysis, _ = client.request(
                "POST",
                "/connector/jobs/claim",
                {"extensionVersion": "0.7.0", "capabilities": ["analyze_video"]},
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(
                status == 200 and claimed_analysis.get("job") is None,
                "legacy extension claimed a v0.8 analysis job",
            )

            status, claimed_analysis, _ = client.request(
                "POST",
                "/connector/jobs/claim",
                {"extensionVersion": CURRENT_EXTENSION_VERSION, "capabilities": ["analyze_video"]},
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(
                status == 200 and claimed_analysis.get("job", {}).get("id") == analyze_job["id"],
                "analysis claim failed",
            )
            analysis_claim_token = claimed_analysis["job"].get("claimToken")
            require(isinstance(analysis_claim_token, str) and analysis_claim_token, "analysis claim token missing")

            submitted: list[tuple[str, dict[str, Any]]] = []
            server.analysis.submit = lambda job_id, payload: submitted.append((job_id, dict(payload))) or True  # type: ignore[method-assign]
            media_payload = {
                "videoId": video["id"],
                "accountId": "account-a",
                "videoUrl": "https://v.douyinvod.com/complete-original-video",
                "audioUrl": None,
                "sourceVideoUrl": video["url"],
                "title": video["title"],
                "description": video["description"],
                "mediaMeta": {"page": {"durationSeconds": 12.0, "observedVideoId": video["id"]}},
            }
            status, _, _ = client.request(
                "POST",
                "/connector/events",
                {
                    "jobId": analyze_job["id"],
                    "claimToken": analysis_claim_token,
                    "eventId": f"{analyze_job['id']}:analysis_media",
                    "type": "analysis_media",
                    "payload": media_payload,
                },
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 200 and submitted and submitted[0][0] == analyze_job["id"], "analysis media dispatch failed")

            original_download = analysis_module.download_media
            original_probe = analysis_module.probe_media
            original_has_audio = analysis_module.has_audio_stream
            original_hash = analysis_module.sha256_file
            original_qwen = analysis_module.QwenClient
            original_transcribe = AnalysisManager.__dict__["_transcribe"]
            qwen_observations: dict[str, Any] = {}

            class RecordingQwen:
                def __init__(self, _config: HostConfig, _secret: dict[str, Any] | None) -> None:
                    pass

                def prepare_video(self, path: Path) -> str:
                    qwen_observations["fileName"] = path.name
                    qwen_observations["bytes"] = path.read_bytes()
                    return "mock://complete-original-video"

                def analyze_prepared_videos(
                    self, references: list[str], transcript: str, metadata: dict[str, Any]
                ) -> dict[str, str]:
                    qwen_observations["references"] = list(references)
                    qwen_observations["transcript"] = transcript
                    qwen_observations["metadata"] = dict(metadata)
                    return {
                        "summary": "完整原视频测试摘要",
                        "topic": "测试选题",
                        "corePoint": "测试核心观点",
                        "visualContent": "测试画面内容",
                        "personActions": "测试人物行为",
                        "onScreenText": "测试字幕与画面文字",
                        "structureNarrative": "测试内容结构与叙事逻辑",
                    }

                def analyze_segments(self, *_args: Any, **_kwargs: Any) -> dict[str, str]:
                    raise AssertionError("small mock video must not enter segmentation fallback")

                def usage_summary(self) -> dict[str, Any]:
                    return {
                        "provider": "Alibaba Cloud Model Studio",
                        "model": "qwen3.8-flash",
                        "requestCount": 1,
                        "attemptedRequestCount": 1,
                        "promptTokens": 120000,
                        "completionTokens": 4000,
                        "totalTokens": 124000,
                        "videoTokens": 118000,
                        "imageTokens": 0,
                        "audioTokens": 0,
                        "textTokens": 2000,
                        "cachedTokens": 0,
                        "reasoningTokens": 2000,
                        "usageComplete": True,
                        "estimatedCostCny": 0.1068,
                        "pricing": {"currency": "CNY", "region": "cn-beijing", "checkedAt": "2026-08-31"},
                        "billingNote": "测试原价估算",
                    }

            complete_original = b"complete-original-video-bytes"

            def fake_download(_url: str, destination: Path, _maximum: int, _label: str) -> int:
                destination.write_bytes(complete_original)
                return len(complete_original)

            try:
                analysis_module.download_media = fake_download
                analysis_module.probe_media = lambda _path: {
                    "streams": [{"codec_type": "video"}, {"codec_type": "audio"}],
                    "format": {"duration": "12.0"},
                }
                analysis_module.has_audio_stream = lambda _probe: True
                analysis_module.sha256_file = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
                analysis_module.QwenClient = RecordingQwen
                AnalysisManager._transcribe = staticmethod(lambda _path: "这是完整原视频的本地口播稿")
                mock_manager = AnalysisManager(replace(config, mock_qwen=True), server.database, server.secrets)
                try:
                    mock_manager._run(analyze_job["id"], media_payload)
                finally:
                    mock_manager.shutdown()
            finally:
                analysis_module.download_media = original_download
                analysis_module.probe_media = original_probe
                analysis_module.has_audio_stream = original_has_audio
                analysis_module.sha256_file = original_hash
                analysis_module.QwenClient = original_qwen
                AnalysisManager._transcribe = original_transcribe

            require(qwen_observations.get("bytes") == complete_original, "Qwen branch did not receive the complete downloaded file")
            require(qwen_observations.get("fileName", "").endswith(".mp4"), "video MIME type was not preserved for Qwen")
            require(
                qwen_observations.get("references") == ["mock://complete-original-video"],
                "Qwen request did not use the complete-video reference",
            )
            require(qwen_observations.get("transcript") == "这是完整原视频的本地口播稿", "ASR transcript was not joined")
            require(qwen_observations.get("metadata", {}).get("durationSeconds") == 12.0, "verified duration was not passed to Qwen")

            status, final_state, _ = client.request("GET", "/api/state", origin=REMOTE_ORIGIN)
            require(status == 200, "LAN state read failed")
            final_video = final_state["videos"][0]
            require(final_video.get("transcriptStatus") == "ready", "transcript was not persisted")
            require(final_video.get("transcript", "").endswith("。"), "transcript punctuation was not persisted")
            require(final_video.get("analysisStatus") == "ready", "analysis was not permanently persisted")
            require(final_video.get("analysis", {}).get("summary") == "完整原视频测试摘要", "analysis result is incomplete")
            require(final_video.get("analysisUsage", {}).get("videoTokens") == 118000, "analysis token usage was not persisted")
            require(final_video.get("analysisUsage", {}).get("estimatedCostCny") == 0.1068, "analysis cost estimate was not persisted")
            require(len(final_video.get("analysisRuns", [])) == 1, "first analysis run history is missing")
            require(final_video["analysisRuns"][0].get("status") == "succeeded", "first analysis receipt status is wrong")

            retry_payload = {
                "accountId": "account-a",
                "videoId": video["id"],
                "retry": True,
            }
            status, retry_created, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "analyze_video", "payload": retry_payload},
                origin=REMOTE_ORIGIN,
            )
            require(status == 201 and retry_created.get("created") is True, "analysis retry was not a new attempt")
            retry_job_id = retry_created["job"]["id"]
            require(retry_job_id != analyze_job["id"], "analysis retry reused the old job")
            status, retry_duplicate, _ = client.request(
                "POST",
                "/api/jobs",
                {"type": "analyze_video", "payload": retry_payload},
                origin=REMOTE_ORIGIN,
            )
            require(status == 200 and retry_duplicate["job"]["id"] == retry_job_id, "retry double-click was not deduplicated")

            retry_usage = {
                "provider": "Alibaba Cloud Model Studio",
                "model": "qwen3.8-flash",
                "requestedModel": "qwen3.8-flash",
                "responseModels": ["qwen3.8-flash"],
                "requestCount": 1,
                "attemptedRequestCount": 2,
                "requestIds": ["known-retry-request"],
                "promptTokens": 500,
                "completionTokens": 50,
                "totalTokens": 550,
                "videoTokens": 450,
                "imageTokens": 0,
                "audioTokens": 0,
                "textTokens": 50,
                "cachedTokens": 0,
                "reasoningTokens": 20,
                "usageComplete": False,
                "estimatedCostCny": None,
                "pricing": None,
                "billingNote": "本机未收到全部请求用量，需到账单核对。",
            }
            server.database.save_analysis_failure(retry_job_id, "模拟第二次请求超时", usage=retry_usage)
            status, retry_state, _ = client.request("GET", "/api/state", origin=REMOTE_ORIGIN)
            require(status == 200, "retry state read failed")
            retry_video = retry_state["videos"][0]
            retry_runs = retry_video.get("analysisRuns", [])
            require(len(retry_runs) == 2, "analysis attempts were not retained independently")
            require(retry_runs[0].get("jobId") == retry_job_id and retry_runs[0].get("status") == "failed", "latest failed receipt is wrong")
            require(retry_runs[0].get("usage", {}).get("estimatedCostCny") is None, "incomplete retry usage was mispriced")
            require(retry_runs[1].get("jobId") == analyze_job["id"] and retry_runs[1].get("status") == "succeeded", "successful historical receipt was overwritten")
            require(retry_runs[1].get("usage", {}).get("estimatedCostCny") == 0.1068, "successful historical cost was overwritten")
            require(retry_video.get("analysisStatus") == "error", "failed retry status was hidden by the previous analysis")

            reopened_database = Database(config)
            reopened_database.initialize()
            reopened_video = reopened_database.get_video(video["id"])
            require(reopened_video is not None and len(reopened_video.get("analysisRuns", [])) == 2, "analysis receipts did not survive SQLite reopen")
            require(not any(config.temp_dir.iterdir()), "analysis temporary media was not deleted")

            print(
                "Host validation passed: localhost-only setup/key entry, password session and CSRF, "
                "encrypted key storage, SQLite migration-safe merge/dedupe, authenticated connector queue, "
                "LAN job submission, target-bound full-video analysis, parallel transcript result, persistence, "
                "and temporary-media cleanup."
            )
        finally:
            server.shutdown()
            server.server_close()
            server.analysis.shutdown()
            thread.join(timeout=5)


if __name__ == "__main__":
    run()
