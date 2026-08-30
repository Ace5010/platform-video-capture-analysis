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
from host_service.config import HostConfig  # noqa: E402
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
        qwen_client = QwenClient(config, None)
        short_video = qwen_client._video_content("mock://short", {"durationSeconds": 20})
        long_video = qwen_client._video_content("mock://long", {"durationSeconds": 80})
        require(short_video["fps"] == 10.0, "short video did not use the maximum Qwen sampling rate")
        require(long_video["fps"] == 5.0, "long video sampling did not preserve full per-frame detail")
        require(short_video["max_pixels"] == QWEN_VIDEO_MAX_PIXELS, "Qwen frame pixel budget is not maximal")
        require(short_video["total_pixels"] == QWEN_VIDEO_TOTAL_PIXELS, "Qwen total pixel budget is not maximal")
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
                    "extensionVersion": "0.7.0",
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
                    "extensionVersion": "0.7.0",
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

            status, state, _ = client.request("GET", "/api/state")
            require(status == 200 and len(state.get("videos", [])) == 1, "shared video state is incomplete")
            require("playCount" not in state["videos"][0], "removed play-count metric was persisted")
            saved_account = state["accounts"][0]
            require(saved_account.get("addedAt") == account["addedAt"], "collection overwrote preserved account fields")
            require(saved_account.get("initialSyncStatus") == "complete", "initial archive status was not persisted")
            require(saved_account.get("avatarUrl"), "account avatar was not persisted")
            require(len(state.get("snapshots", [])) == 1, "snapshot deduplication failed")
            require("analyze_video" in state.get("connector", {}).get("capabilities", []), "connector capabilities missing")

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
                {"capabilities": ["analyze_video"]},
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
