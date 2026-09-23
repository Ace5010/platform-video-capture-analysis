"""Integration checks for the LAN host API, queue, persistence, and mock analysis."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from host_service import analysis as analysis_module  # noqa: E402
from host_service import media as media_module  # noqa: E402
from host_service import qwen as qwen_module  # noqa: E402
from host_service.analysis import AnalysisManager  # noqa: E402
from host_service.compatibility import (  # noqa: E402
    MINIMUM_ANALYSIS_EXTENSION_VERSION,
    semver_at_least,
)
from host_service.config import HostConfig  # noqa: E402
from host_service.database import Database  # noqa: E402
from host_service.douyin_links import extract_douyin_url, resolve_douyin_video_link  # noqa: E402
from host_service.qwen import (  # noqa: E402
    ANALYSIS_DESCRIPTIONS,
    ANALYSIS_VERSION,
    QwenError,
    validate_analysis,
    QWEN_VIDEO_MAX_PIXELS,
    QWEN_VIDEO_TOTAL_PIXELS,
    QwenClient,
    mock_analysis,
)
from host_service.server import create_server  # noqa: E402
from local_asr.server import _is_verified_douyin_play_url  # noqa: E402


LOCAL_ORIGIN = "http://localhost:3000"
REMOTE_ORIGIN = "http://192.168.31.99:3000"
EXTENSION_ID = "a" * 32
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
ACCESS_PASSWORD = "test-access-password"
FAKE_API_KEY = "sk-test-key-that-must-be-encrypted"
CURRENT_EXTENSION_VERSION = "0.9.7"


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


def check_lossless_segmentation(root: Path) -> None:
    """Exercise actual stream copy plus bounded failure/cleanup in isolated media."""
    media_root = root / "segmentation-checks"
    media_root.mkdir()
    original = media_root / "original.mp4"
    subprocess.run(
        [
            media_module._tool_path("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
            "-t", "485", "-c:v", "mpeg4", "-g", "1", "-c:a", "aac", str(original),
        ],
        check=True, capture_output=True, timeout=60,
    )
    limit = int(original.stat().st_size * 0.7)
    destination = media_root / "successful"
    segments = media_module.lossless_segments_below_limit(original, destination, maximum_bytes=limit)
    require(len(segments) >= 2, "short original did not proceed beyond its initial single segment")
    require(all(path.stat().st_size <= limit for path in segments), "segment exceeded the upload limit")
    require(not (destination / "attempt-0").exists(), "oversized first attempt was not cleaned")
    require(len(list(destination.iterdir())) == 1, "unsuccessful segment attempts were retained")

    def packet_hashes(paths: list[Path]) -> dict[int, list[str]]:
        result: dict[int, list[str]] = {}
        for path in paths:
            probe = subprocess.run(
                [
                    media_module._tool_path("ffprobe"), "-v", "error", "-show_packets",
                    "-show_data_hash", "sha256", "-show_entries", "packet=stream_index,data_hash",
                    "-of", "json", str(path),
                ],
                check=True, capture_output=True, text=True, encoding="utf-8", timeout=60,
            )
            for packet in json.loads(probe.stdout)["packets"]:
                result.setdefault(packet["stream_index"], []).append(packet["data_hash"])
        return result

    original_packets = packet_hashes([original])
    require(len(original_packets) == 2, "lossless fixture lacks a video or audio stream")
    require(packet_hashes(segments) == original_packets, "segmentation changed, dropped, duplicated or reordered original packets")
    extracted = media_module.prepare_cloud_audio(original, media_module.probe_media(original), media_root / "complete-audio.m4a")
    require(extracted is not None and extracted != original, "AAC was not extracted for cloud ASR")
    require(packet_hashes([extracted]) == {0: original_packets[1]}, "cloud ASR extraction changed or omitted original audio packets")
    require(media_module.prepare_cloud_audio(original, {"streams": [{"codec_type": "video"}]}, media_root / "absent.m4a") is None, "no-audio video was not detected")
    require(media_module.prepare_cloud_audio(original, {"streams": [{"codec_type": "audio", "codec_name": "opus"}]}, media_root / "unused.m4a") == original, "unsupported copy container did not preserve complete media")

    below_limit = media_module.lossless_segments_below_limit(
        original, media_root / "budget-rejection", maximum_bytes=original.stat().st_size * 2,
    )
    require(len(below_limit) >= 2, "visual-budget fallback accepted the unchanged full video")

    attempts: list[int] = []
    def unsplittable(_path: Path, attempt_dir: Path, seconds: int) -> list[Path]:
        attempts.append(seconds)
        attempt_dir.mkdir(parents=True)
        segment = attempt_dir / "segment-0000.mp4"
        segment.write_bytes(b"oversized")
        return [segment]

    failed_destination = media_root / "unsplittable"
    with patch.object(media_module, "lossless_segments", side_effect=unsplittable):
        try:
            media_module.lossless_segments_below_limit(original, failed_destination, maximum_bytes=1)
        except RuntimeError:
            pass
        else:
            raise AssertionError("unsplittable oversized media was accepted")
    require(attempts[0] == 600 and attempts[-1] == 1 and len(attempts) <= 11, "segment retries are not bounded down to one second")
    require(not any(failed_destination.iterdir()), "exhausted segmentation left temporary media")

    def failed_ffmpeg(_path: Path, attempt_dir: Path, _seconds: int) -> list[Path]:
        attempt_dir.mkdir(parents=True)
        (attempt_dir / "segment-0000.mp4").write_bytes(b"partial")
        raise RuntimeError("simulated FFmpeg failure")

    error_destination = media_root / "ffmpeg-error"
    with patch.object(media_module, "lossless_segments", side_effect=failed_ffmpeg):
        try:
            media_module.lossless_segments_below_limit(original, error_destination, maximum_bytes=1)
        except RuntimeError as error:
            require(str(error) == "simulated FFmpeg failure", "FFmpeg failure was masked")
        else:
            raise AssertionError("FFmpeg failure was swallowed")
    require(not any(error_destination.iterdir()), "FFmpeg failure left partial temporary media")


def check_empty_transcript_migration(root: Path) -> None:
    database = Database(create_test_config(root / "transcript-history"))
    database.initialize()
    old_time = "2026-09-14T14:46:00Z"
    for index, raw in enumerate((None, "", "   ")):
        video_id = f"753000000000000001{index}"
        url = f"https://www.douyin.com/video/{video_id}"
        video = database.upsert_link_video(video_id, url, url)
        job, _created = database.create_job("analyze_video", {"accountId": video["accountId"], "videoId": video_id})
        database.save_analysis_failure(job["id"], "collection failed before ASR")
        with database.transaction() as connection:
            connection.execute("UPDATE analysis_runs SET transcript_raw=?,transcript=?,updated_at=? WHERE job_id=?", (raw, raw, old_time, job["id"]))
            connection.execute("UPDATE jobs SET result_json=?,updated_at=? WHERE id=?", (json.dumps({"transcriptRaw": raw, "transcript": raw, "error": "original failure"}), old_time, job["id"]))

    def snapshot() -> tuple[list[tuple[Any, ...]], list[tuple[Any, ...]]]:
        # Database.transaction closes its SQLite connection in finally; a
        # sqlite3 connection context alone would leave Windows file handles open.
        with database.transaction() as connection:
            runs = [tuple(row) for row in connection.execute("SELECT * FROM analysis_runs ORDER BY id")]
            jobs = [tuple(row) for row in connection.execute("SELECT * FROM jobs ORDER BY id")]
        return runs, jobs

    original = snapshot()
    for stamp in ("2026-09-15T00:24:00Z", "2026-09-15T00:25:00Z"):
        with patch("host_service.database.utc_now", return_value=stamp):
            database.normalize_saved_transcripts()
        require(snapshot() == original, "restart rewrote empty transcript history or its failure timestamp")

    video_id = "7530000000000000020"
    url = f"https://www.douyin.com/video/{video_id}"
    video = database.upsert_link_video(video_id, url, url)
    job, _created = database.create_job("analyze_video", {"accountId": video["accountId"], "videoId": video_id})
    database.save_analysis_failure(job["id"], "model failed after ASR")
    source = "历史口播原文"
    with database.transaction() as connection:
        connection.execute("UPDATE analysis_runs SET transcript_raw='',transcript=?,updated_at=? WHERE job_id=?", (source, old_time, job["id"]))
        connection.execute("UPDATE jobs SET result_json=?,updated_at=? WHERE id=?", (json.dumps({"transcriptRaw": "", "transcript": source}), old_time, job["id"]))
    with patch("host_service.database.restore_transcript_text", return_value=source + "。"):
        with patch("host_service.database.utc_now", return_value="2026-09-15T00:26:00Z"):
            database.normalize_saved_transcripts()
        with database.transaction() as connection:
            row = connection.execute("SELECT transcript_raw,transcript FROM analysis_runs WHERE job_id=?", (job["id"],)).fetchone()
            require(row["transcript_raw"] == source and row["transcript"] == source + "。", "legacy nonempty transcript was not migrated")
        normalized = snapshot()
        with patch("host_service.database.utc_now", return_value="2026-09-15T00:27:00Z"):
            database.normalize_saved_transcripts()
        require(snapshot() == normalized, "legacy raw transcript migration was not idempotent")


def check_transcript_checkpoint(root: Path) -> None:
    config = create_test_config(root / "cloud-checkpoint")
    database = Database(config)
    database.initialize()
    video_id = "7530000000000000030"
    url = f"https://www.douyin.com/video/{video_id}"
    video = database.upsert_link_video(video_id, url, url)
    job, _created = database.create_job("analyze_video", {"accountId": video["accountId"], "videoId": video_id})
    usage = {"attemptedRequestCount": 1, "usageComplete": False,
             "cloudAsr": {"model": "qwen3-asr-flash-filetrans", "audioSeconds": 485, "usageComplete": True, "estimatedCostCny": 0.1067}}
    database.save_analysis_transcript(job["id"], "已经云端识别完成。", usage)
    with database.transaction() as connection:
        row = connection.execute("SELECT status,transcript,usage_json FROM analysis_runs WHERE job_id=?", (job["id"],)).fetchone()
        require(row["status"] == "running" and row["transcript"] == "已经云端识别完成。", "speech checkpoint prematurely completed analysis")
        require(json.loads(row["usage_json"]) == usage, "cloud usage checkpoint lost exact receipt")
    restarted = Database(config)
    restarted.initialize()
    require(restarted.mark_stale_analysis_failed() == 1, "interrupted checkpoint did not recover")
    recovered = restarted.get_video(video_id)
    require(recovered["transcriptStatus"] == "ready" and recovered["transcript"] == "已经云端识别完成。", "restart lost completed cloud speech")
    require(recovered["analysisUsage"] == usage and recovered["analysisStatus"] == "error", "restart lost cloud charge or unknown in-flight video charge")
    manager = AnalysisManager(config, restarted, None)
    try:
        require(manager._saved_transcript(video_id) == "已经云端识别完成。", "restart would resubmit cloud speech")
    finally:
        manager.shutdown()


def check_qwen_streaming(config: HostConfig) -> None:
    plan = mock_analysis()
    usage = {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200,
             "completion_tokens_details": {"reasoning_tokens": 100}, "prompt_tokens_details": {"video_tokens": 900}}

    def event(choices: list[dict[str, Any]], receipt: dict[str, Any] | None = None) -> bytes:
        data = {"id": "stream-test", "model": "qwen3.8-flash", "choices": choices, "usage": receipt}
        return b"data: " + json.dumps(data, ensure_ascii=False).encode("utf-8") + b"\r\n\r\n"

    def wire(value: Any = plan, reason: str | None = "stop", *, receipt: bool = True, done: bool = True) -> bytes:
        text = json.dumps(value, ensure_ascii=False)
        parts = [b": keep-alive\r\n\r\n", event([{"index": 0, "delta": {"reasoning_content": "仅用于测试的思考"}}])]
        parts.extend(event([{"index": 0, "delta": {"content": text[index:index + 37]}}]) for index in range(0, len(text), 37))
        parts.append(event([{"index": 0, "delta": {}, "finish_reason": reason}]))
        if receipt:
            parts.append(event([], usage))
        if done:
            parts.append(b"data: [DONE]\n\n")
        return b"".join(parts)

    class StreamResponse:
        def __init__(self, data: bytes, split: int = 7, fail_at_end: bool = False) -> None:
            self.chunks = [data[index:index + split] for index in range(0, len(data), split)]
            self.closed = False
            self.fail_at_end = fail_at_end

        def __enter__(self) -> "StreamResponse":
            return self

        def __exit__(self, *_args: Any) -> None:
            self.closed = True

        def read1(self, _maximum: int) -> bytes:
            if self.chunks:
                return self.chunks.pop(0)
            if self.fail_at_end:
                raise TimeoutError("simulated connection timeout")
            return b""

    def invoke(data: bytes, *, fail_at_end: bool = False, expected_error: str | None = None) -> QwenClient:
        client = QwenClient(config, {"apiKey": FAKE_API_KEY})
        response = StreamResponse(data, fail_at_end=fail_at_end)
        with patch.object(qwen_module, "urlopen", return_value=response) as opened:
            try:
                result = client._call([{"type": "video_url", "video_url": {"url": "mock://complete-original-video"}}], "测试")
            except QwenError as error:
                require(expected_error is not None and expected_error in str(error), f"unexpected stream failure: {error}")
            else:
                require(expected_error is None, "incomplete Qwen stream was accepted")
                require(result == plan, "split UTF-8 SSE events did not reconstruct the complete schema")
            require(opened.call_count == 1, "billable SSE request was automatically retried")
            sent = json.loads(opened.call_args.args[0].data)
            require(sent["response_format"] == {"type": "json_object"}, "video input incorrectly relies on unsupported provider JSON Schema constraints")
            system_prompt = sent["messages"][0]["content"]
            require(json.dumps(qwen_module.ANALYSIS_SCHEMA, ensure_ascii=False) in system_prompt,
                    "multimodal prompt is missing the complete output contract")
            require(sent["stream"] is True and sent["stream_options"]["include_usage"] is True, "SSE usage was not requested")
            require(sent["enable_thinking"] is True and sent["thinking_budget"] == 8192, "reasoning budget was not bounded")
            require("reasoning_effort" not in sent and sent["max_completion_tokens"] == 65536, "conflicting or unbounded output settings")
            require(sent["messages"][1]["content"][0]["video_url"]["url"] == "mock://complete-original-video", "streaming replaced the complete video input")
        require(response.closed, "SSE response was not closed")
        return client

    complete = invoke(wire())
    summary = complete.usage_summary()
    require(summary["requestCount"] == 1 and summary["usageComplete"] is True, "final SSE usage was not retained exactly once")
    require(summary["totalTokens"] == 1200 and summary["reasoningTokens"] == 100, "SSE token receipt changed")
    require(summary["requestIds"] == ["stream-test"], "SSE request ID was not preserved")
    require(summary["responseDiagnostics"][0]["stage"] == "complete", "successful schema validation not recorded")
    for value, kind in ((None, "null"), ([], "array"), ("private upstream text", "string"), (True, "boolean"), (42, "number")):
        failed = invoke(wire(value), expected_error="根内容")
        diagnostic = failed.usage_summary()["responseDiagnostics"][0]
        require(diagnostic["responseType"] == kind and diagnostic["stage"] == "schema", "non-object JSON cause lost")
        require(failed.usage_summary()["totalTokens"] == 1200, "non-object JSON lost its receipt")
        require("private" not in json.dumps(diagnostic), "diagnostic leaked model content")
    require(qwen_module._diagnostic_request_id("https://private/?token=secret") is None, "diagnostic leaked upstream URL")
    require(qwen_module._diagnostic_request_id("chatcmpl-00000000-0000-4000-8000-000000000001") == "chatcmpl-00000000-0000-4000-8000-000000000001", "provider UUID lost")
    # Multiple events in a single network read must work too.
    # A UTF-8 code point and CRLF may be split at any byte boundary.
    for split in (1, 2, 13, 4096):
        fragmented = StreamResponse(wire(), split=split)
        with patch.object(qwen_module, "urlopen", return_value=fragmented):
            require(QwenClient(config, {"apiKey": FAKE_API_KEY})._call([], "测试") == plan, "network fragmentation changed the result")
    joined_response = StreamResponse(wire(), split=len(wire()))
    progress: list[dict[str, Any]] = []
    progress_client = QwenClient(config, {"apiKey": FAKE_API_KEY})
    progress_client.progress_callback = progress.append
    with patch.object(qwen_module, "urlopen", return_value=joined_response):
        require(progress_client._call([], "测试") == plan, "coalesced SSE events were lost")
    require([item["phase"] for item in progress] == ["request", "reasoning", "content"], "stream request and phase changes were not observable")
    require(all(set(item) == {"phase", "reasoningChars", "contentChars"} for item in progress), "progress exposed generated content")

    for reason in ("length", "tool_calls", None):
        failed = invoke(wire(reason=reason), expected_error="长度上限" if reason == "length" else "未正常完成")
        require(failed.usage_summary()["totalTokens"] == 1200, "failed completion lost its actual usage receipt")
    missing_end = invoke(wire(done=False), expected_error="完整结束前中断")
    require(missing_end.usage_summary()["totalTokens"] == 1200, "truncated stream discarded received token usage")
    require(missing_end.usage_summary()["usageComplete"] is False, "truncated stream was reported fully billed")
    interrupted = invoke(wire(receipt=False, done=False), fail_at_end=True, expected_error="未自动重发")
    require(interrupted.usage_summary()["estimatedCostCny"] is None, "interrupted request was shown as zero cost")
    no_receipt = invoke(wire(receipt=False))
    require(no_receipt.usage_summary()["usageComplete"] is False and no_receipt.usage_summary()["estimatedCostCny"] is None, "missing receipt was treated as zero cost")
    invoke(wire({"schemaVersion": ANALYSIS_VERSION, "contentAnalysis": "缺少制作字段"}), expected_error="结构不完整")
    for invalid in ([], {"schemaVersion": ANALYSIS_VERSION, "secret-model-field": "private"}):
        try:
            validate_analysis(invalid)
        except QwenError as error:
            message = str(error)
            require("secret-model-field" not in message and "private" not in message, "schema error leaked arbitrary model data")
            require("根内容" in message if isinstance(invalid, list) else "缺少字段：contentAnalysis" in message and "多余字段：1 个" in message, "schema diagnostic lacks a safe cause")
        else:
            raise AssertionError("invalid schema was accepted")
    invoke(b"data: {broken json}\n\n", expected_error="无效 JSON")
    with patch.object(qwen_module, "QWEN_STREAM_MAX_BYTES", 8):
        invoke(wire(), expected_error="异常过大")
    with patch.object(qwen_module.time, "monotonic", side_effect=[0, 0, 601]):
        invoke(wire(), expected_error="超过 10 分钟")

    # Exercise the real SSE parser, manager and SQLite persistence together.
    # Only network/media are faked; no live credentials or production data.
    from types import SimpleNamespace
    isolated = create_test_config(config.data_dir / "stream-persistence")
    database = Database(isolated)
    database.initialize()
    video_id = "7530000000000000099"
    video = database.upsert_link_video(video_id, f"https://www.douyin.com/video/{video_id}", "fixture")
    payload = {"accountId": video["accountId"], "videoId": video_id, "videoUrl": "https://test.douyinvod.com/video.mp4", "retry": True}
    seed, _ = database.create_job("analyze_video", payload)
    database.save_analysis_failure(seed["id"], "previous paid failure", "已保存口播。", {"estimatedCostCny": 0.1})
    manager = AnalysisManager(isolated, database, SimpleNamespace(load=lambda: {"apiKey": FAKE_API_KEY}))
    cases = [(wire(None), "failed", True, 2), (wire([]), "failed", True, 2),
             (wire({"schemaVersion": ANALYSIS_VERSION}), "failed", True, 2),
             (wire(reason="length"), "failed", True, 1), (wire(done=False), "failed", False, 1),
             (wire(receipt=False, done=False), "failed", False, 1),
             (wire(receipt=False), "succeeded", False, 1), (wire(), "succeeded", True, 1)]
    try:
        for data, expected_status, receipt_complete, expected_requests in cases:
            # Each parser case starts from incomplete analysis; complete
            # historical results are now reused without a new model request.
            with database.transaction() as connection:
                raw = connection.execute("SELECT data_json FROM videos WHERE id=?", (video_id,)).fetchone()
                current = json.loads(raw["data_json"])
                current.pop("analysis", None)
                connection.execute("UPDATE videos SET data_json=? WHERE id=?", (json.dumps(current), video_id))
            job, created = database.create_job("analyze_video", payload)
            require(created, "explicit retry reused an old model result")
            response = StreamResponse(data)
            with patch.object(analysis_module, "download_media", side_effect=lambda url, path, *args, **kwargs: path.write_bytes(b"complete-video")), \
                 patch.object(analysis_module, "probe_media", return_value={"streams": [{"codec_type": "video", "width": 1920, "height": 1080}], "format": {"duration": "12"}}), \
                 patch.object(QwenClient, "prepare_video", return_value="mock://complete-original-video"), \
                 patch.object(analysis_module, "CloudAsrClient") as cloud, \
                 patch.object(manager, "_wait", return_value=None), \
                 patch.object(qwen_module, "urlopen", side_effect=lambda *_args, **_kwargs: StreamResponse(data)) as opened:
                manager._run(job["id"], payload)
            require(opened.call_count == expected_requests and cloud.call_count == 0, "retry re-transcribed or re-sent an uncertain billable request")
            with database.transaction() as connection:
                row = connection.execute("SELECT * FROM analysis_runs WHERE job_id=?", (job["id"],)).fetchone()
            require(row["status"] == expected_status and row["transcript"] == "已保存口播。", "result/transcript not persisted correctly")
            require((row["analysis_json"] is not None) == (expected_status == "succeeded"), "invalid output saved as success")
            saved_usage = json.loads(row["usage_json"])
            require(saved_usage["usageComplete"] == receipt_complete, "persisted receipt completeness incorrect")
            require(saved_usage["analysisInput"]["transcriptReused"] and saved_usage["analysisInput"]["videoId"] == video_id, "full-video evidence missing")
            require(saved_usage["attemptedRequestCount"] == expected_requests, "request attempt missing")
            require(saved_usage["totalTokens"] == (1200 * expected_requests if saved_usage["requestCount"] else 0), "failed result lost received tokens")
            require((saved_usage["estimatedCostCny"] is not None) == receipt_complete, "unknown cost was reported as known")
            require(saved_usage["responseDiagnostics"][0]["stage"] == ("complete" if expected_status == "succeeded" else "finish" if b'"length"' in data else "stream" if b'[DONE]' not in data else "schema"), "persisted failure stage incorrect")
            require(not list(isolated.temp_dir.iterdir()), "temporary media survived result/failure")
        with database.transaction() as connection:
            original = connection.execute("SELECT error,usage_json FROM analysis_runs WHERE job_id=?", (seed["id"],)).fetchone()
        require(original["error"] == "previous paid failure" and json.loads(original["usage_json"])["estimatedCostCny"] == 0.1, "retry overwrote paid history")
    finally:
        manager.shutdown()


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="douyin-host-test-") as temporary:
        root = Path(temporary)
        config = create_test_config(root)
        check_lossless_segmentation(root)
        check_empty_transcript_migration(root)
        check_transcript_checkpoint(root)
        check_qwen_streaming(config)
        require(MINIMUM_ANALYSIS_EXTENSION_VERSION == CURRENT_EXTENSION_VERSION, "host extension version floor drifted")
        require(not semver_at_least("0.7.0", CURRENT_EXTENSION_VERSION), "legacy extension passed the version floor")
        require(not semver_at_least("0.8.0", CURRENT_EXTENSION_VERSION), "legacy extension passed the version floor")
        require(not semver_at_least("0.9.0", CURRENT_EXTENSION_VERSION), "broken extension passed the version floor")
        require(not semver_at_least("0.9.1", CURRENT_EXTENSION_VERSION), "broken extension passed the version floor")
        require(not semver_at_least("0.9.2", CURRENT_EXTENSION_VERSION), "incomplete extension passed the version floor")
        require(semver_at_least("0.9.7", CURRENT_EXTENSION_VERSION), "current extension failed the version floor")
        require(semver_at_least("0.10.0", CURRENT_EXTENSION_VERSION), "future extension failed the version floor")
        require(not semver_at_least("0.9.7-beta.1", CURRENT_EXTENSION_VERSION), "prerelease passed the stable floor")
        shared_text = "打开抖音看看【测试视频】 https://www.douyin.com/video/7530000000000000001 复制此链接"
        require(extract_douyin_url(shared_text).endswith("7530000000000000001"), "share text URL extraction failed")
        resolved_direct = resolve_douyin_video_link(shared_text)
        require(
            resolved_direct.video_id == "7530000000000000001"
            and resolved_direct.canonical_url.endswith("/video/7530000000000000001"),
            "direct Douyin video link resolution failed",
        )
        verified_play_url = (
            "https://www.douyin.com/aweme/v1/play/"
            "?aid=6383&__vid=7530000000000000001&sign=test"
        )
        require(
            _is_verified_douyin_play_url(verified_play_url, "7530000000000000001"),
            "target-bound Douyin play URL was rejected",
        )
        require(
            not _is_verified_douyin_play_url(verified_play_url, "9999999999999999999"),
            "Douyin play URL accepted the wrong target video ID",
        )
        require(
            not _is_verified_douyin_play_url(
                "https://evil.example/aweme/v1/play/?__vid=7530000000000000001",
                "7530000000000000001",
            ),
            "untrusted play URL host was accepted",
        )
        qwen_client = QwenClient(config, None)
        plan = mock_analysis()
        require(validate_analysis(plan) == plan, "valid Remotion plan rejected")
        concise_content = {field: "作者说明收藏夹可以按项目分类。" if field == "quickOverview" else ""
                           for field in qwen_module.CONTENT_ANALYSIS_DESCRIPTIONS}
        concise_plan = {**plan, "contentAnalysis": concise_content}
        require(validate_analysis(concise_plan) == concise_plan, "optional empty content details were rejected")
        require(all(qwen_module.analysis_section_status(concise_plan).values()), "valid concise content would trigger paid backfill")
        long_summary = "作者解释方法、必要条件和关键例子。\n\n" * 80 + "最后说明适用例外。"
        detailed_plan = {**plan, "contentAnalysis": {**concise_content, "quickOverview": long_summary}}
        require(validate_analysis(detailed_plan)["contentAnalysis"]["quickOverview"] == long_summary, "detailed summary was shortened during validation")
        for key in concise_content:
            for invalid_value in (None, [], "字" * 50_001):
                try:
                    validate_analysis({"schemaVersion": ANALYSIS_VERSION, "contentAnalysis": {**concise_content, key: invalid_value}}, ["contentAnalysis"])
                except QwenError:
                    pass
                else:
                    raise AssertionError(f"invalid content field {key} accepted")
        for invalid_content in ({**concise_content, "quickOverview": " "},
                                {key: value for key, value in concise_content.items() if key != "visualDemonstrations"},
                                {**concise_content, "extra": "unexpected"}):
            try:
                validate_analysis({"schemaVersion": ANALYSIS_VERSION, "contentAnalysis": invalid_content}, ["contentAnalysis"])
            except QwenError:
                pass
            else:
                raise AssertionError("content schema lost required core/keys or strict extra-field validation")
        for invalid in ({"summary": "legacy"}, {**plan, "schemaVersion": "unknown"}, {**plan, "shotTimeline": " "}, {**plan, "assetList": []}):
            try:
                validate_analysis(invalid)
            except QwenError:
                pass
            else:
                raise AssertionError("invalid or legacy model output accepted as new plan")
        captured_calls = []
        def capture_plan(content, prompt, _sections=None):
            captured_calls.append((content, prompt))
            return plan
        with patch.object(qwen_client, "_call", side_effect=capture_plan):
            qwen_client.analyze_prepared_videos(["mock://one", "mock://two"], "口播稿", {"width": 1080, "durationSeconds": 12, "segmentDurationsSeconds": [5, 7]})
        require(len(captured_calls[0][0]) == 2 and "1080" in captured_calls[0][1] and "制作规范" in captured_calls[0][1], "prepared plan lost media or production context")
        captured_calls.clear()
        with patch.object(qwen_client, "_call", side_effect=capture_plan), patch.object(qwen_client, "_video_reference", return_value=("mock://segment", False)), patch("host_service.qwen.probe_media", side_effect=[{"format": {"duration": "5"}}, {"format": {"duration": "7"}}]):
            qwen_client.analyze_segments([Path("one.mp4"), Path("two.mp4")], "口播稿", {"durationSeconds": 12})
        require(len(captured_calls) == 3, "segment plans not integrated")
        require("全片起点秒数：5.0" in captured_calls[1][1], "second segment lost global offset")
        require(captured_calls[2][0] == [] and "全片交接方案" in captured_calls[2][1], "segment integration contract wrong")
        with patch.dict(os.environ, {"DOUYIN_QWEN_FPS": ""}):
            require(HostConfig.from_env().qwen_fps == 1, "Qwen default sampling should be one frame per second")
        with patch.dict(os.environ, {"DOUYIN_QWEN_FPS": "4"}):
            require(HostConfig.from_env().qwen_fps == 4, "explicit Qwen sampling override was ignored")
        default_sampling = QwenClient(replace(config, qwen_fps=1), None)
        short_video = default_sampling._video_content("mock://short", {"durationSeconds": 20})
        long_video = default_sampling._video_content("mock://long", {"durationSeconds": 480})
        require(short_video["fps"] == 1.0, "short video default sampling is excessive")
        require(long_video["fps"] == 0.5, "long video did not adapt to approximately 240 frames")
        override_sampling = QwenClient(replace(config, qwen_fps=4), None)
        require(override_sampling._video_content("mock://override", {"durationSeconds": 20})["fps"] == 4.0, "Qwen sampling override was lost")
        require(override_sampling._video_content("mock://override-long", {"durationSeconds": 480})["fps"] == 0.5, "override bypassed long-video visual budget")
        require(short_video["max_pixels"] == QWEN_VIDEO_MAX_PIXELS == 921600, "Qwen frame pixel budget is not 720p-sized")
        require(short_video["total_pixels"] == QWEN_VIDEO_TOTAL_PIXELS == 240 * 921600, "Qwen total visual budget changed")
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
            require(client.csrf == setup_csrf, "opening another tab must preserve the session CSRF token")
            client.request("GET", "/api/auth/status")
            require(client.csrf == setup_csrf, "repeated status reads must not invalidate existing tabs")

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
            extra_videos = [{**new_video, "id": f"753000000000000008{index}", "url": f"https://www.douyin.com/video/753000000000000008{index}", "publishedAt": "2026-08-01T00:00:00Z"} for index in range(3)]
            latest_five = [video, new_video, *extra_videos]
            latest_payloads = [
                ("latest-check-with-update", [*latest_five, new_video, video], 4, [new_video["id"], *[item["id"] for item in extra_videos]]),
                ("latest-check-without-update", [*latest_five, video], 0, []),
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
                require(latest_account.get("latestVideoIds") == [item["id"] for item in latest_five], "latest five IDs were truncated or not deduplicated")
                require(len(latest_state["videos"]) == 5, "repeat collection created duplicate video records")
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

            status, active_link_job, _ = client.request(
                "POST",
                "/api/video-links/analyze",
                {"shareText": f"复制此链接打开抖音 {video['url']} 查看视频"},
                origin=REMOTE_ORIGIN,
            )
            require(status == 200 and active_link_job.get("created") is False, "active monitored analysis was not reused")
            require(
                active_link_job.get("job", {}).get("payload", {}).get("sourceKind") == "video_link",
                "active analysis job was not upgraded to strict link metadata mode",
            )

            status, _, _ = client.request(
                "POST",
                "/connector/events",
                {
                    "jobId": analyze_job["id"],
                    "claimToken": analysis_claim_token,
                    "eventId": f"{analyze_job['id']}:incomplete-analysis-media",
                    "type": "analysis_media",
                    "payload": {
                        "videoId": video["id"],
                        "accountId": "account-a",
                        "videoUrl": "https://v.douyinvod.com/complete-original-video",
                        "videoMetadata": {"title": "只有标题"},
                    },
                },
                origin=EXTENSION_ORIGIN,
                bearer=connector_token,
                use_cookie=False,
                csrf="",
            )
            require(status == 400, "link analysis accepted incomplete metadata from an already-claimed job")

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
                "authorName": "测试博主",
                "videoMetadata": {
                    "title": video["title"],
                    "description": video["description"],
                    "coverUrl": video["coverUrl"],
                    "authorName": "测试博主",
                    "authorAvatarUrl": "https://example.com/avatar.jpg",
                    "authorProfileUrl": account["url"],
                },
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
            original_cloud_asr = analysis_module.CloudAsrClient
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
                        "schemaVersion": ANALYSIS_VERSION,
                        **{field: f"完整原视频制作方案：{description}" for field, description in ANALYSIS_DESCRIPTIONS.items()},
                        "contentAnalysis": mock_analysis()["contentAnalysis"],
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

            class RecordingAsr:
                def __init__(self, *_args: Any) -> None:
                    pass

                def transcribe(self, path: Path) -> str:
                    require(path.read_bytes() == complete_original, "cloud ASR did not receive complete audio/video")
                    return "这是完整原视频的云端口播稿"

                def usage_summary(self) -> dict[str, Any]:
                    return {"model": "qwen3-asr-flash-filetrans", "audioSeconds": 12, "usageComplete": True, "estimatedCostCny": 0.00264}

            download_video_ids: list[str | None] = []

            def fake_download(
                _url: str,
                destination: Path,
                _maximum: int,
                _label: str,
                *,
                expected_video_id: str | None = None,
                **_kwargs: Any,
            ) -> int:
                download_video_ids.append(expected_video_id)
                destination.write_bytes(complete_original)
                return len(complete_original)

            try:
                analysis_module.download_media = fake_download
                analysis_module.probe_media = lambda _path, **_kwargs: {
                    "streams": [{"codec_type": "video", "width": 1080, "height": 1920, "avg_frame_rate": "30/1", "r_frame_rate": "30/1"}, {"codec_type": "audio"}],
                    "format": {"duration": "12.0"},
                }
                analysis_module.has_audio_stream = lambda _probe: True
                analysis_module.sha256_file = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
                analysis_module.QwenClient = RecordingQwen
                analysis_module.CloudAsrClient = RecordingAsr
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
                analysis_module.CloudAsrClient = original_cloud_asr

            require(qwen_observations.get("bytes") == complete_original, "Qwen branch did not receive the complete downloaded file")
            require(download_video_ids == [video["id"]], "video download was not bound to the target video ID")
            require(qwen_observations.get("fileName", "").endswith(".mp4"), "video MIME type was not preserved for Qwen")
            require(
                qwen_observations.get("references") == ["mock://complete-original-video"],
                "Qwen request did not use the complete-video reference",
            )
            require(qwen_observations.get("transcript") == "这是完整原视频的云端口播稿", "ASR transcript was not joined")
            require(qwen_observations.get("metadata", {}).get("durationSeconds") == 12.0, "verified duration was not passed to Qwen")
            require(qwen_observations.get("metadata", {}).get("width") == 1080 and qwen_observations["metadata"].get("avgFrameRate") == "30/1", "measured production metadata missing")
            require(qwen_observations.get("metadata", {}).get("authorName") == "测试博主", "video author was not passed to Qwen")

            status, final_state, _ = client.request("GET", "/api/state", origin=REMOTE_ORIGIN)
            require(status == 200, "LAN state read failed")
            final_video = final_state["videos"][0]
            require(final_video.get("transcriptStatus") == "ready", "transcript was not persisted")
            require(final_video.get("transcript", "").endswith("。"), "transcript punctuation was not persisted")
            require(final_video.get("analysisStatus") == "ready", "analysis was not permanently persisted")
            require(final_video.get("analysis", {}).get("schemaVersion") == ANALYSIS_VERSION, "analysis result is incomplete")
            require(final_video.get("analysisUsage", {}).get("videoTokens") == 118000, "analysis token usage was not persisted")
            require(final_video.get("analysisUsage", {}).get("estimatedCostCny") == 0.1068, "analysis cost estimate was not persisted")
            require(final_video.get("authorName") == "测试博主", "video author metadata was not persisted")
            require(len(final_video.get("analysisRuns", [])) == 1, "first analysis run history is missing")
            require(final_video["analysisRuns"][0].get("status") == "succeeded", "first analysis receipt status is wrong")

            status, reused_link, _ = client.request(
                "POST",
                "/api/video-links/analyze",
                {"shareText": f"复制此链接打开抖音 {video['url']} 查看视频"},
                origin=REMOTE_ORIGIN,
            )
            require(status == 200 and reused_link.get("reused") is True, "completed monitored video was not reused for link analysis")
            with patch.object(server.secrets, "load", return_value=None), patch.object(
                server.database, "connector_supports", return_value=False
            ):
                status, offline_reuse, _ = client.request(
                    "POST", "/api/video-links/analyze", {"shareText": video["url"]}, origin=REMOTE_ORIGIN
                )
                require(status == 200 and offline_reuse.get("reused") is True, "history reuse required Qwen or an online connector")
                status, _, _ = client.request(
                    "POST", "/api/video-links/analyze",
                    {"shareText": "https://www.douyin.com/video/7530000000000000099"}, origin=REMOTE_ORIGIN
                )
                require(status == 428, "fresh analysis bypassed its Qwen prerequisite")
            status, link_state, _ = client.request("GET", "/api/state", origin=REMOTE_ORIGIN)
            require(status == 200 and len(link_state.get("linkVideos", [])) == 1, "link analysis history was not separated")
            require(len(link_state.get("accounts", [])) == 1, "link analysis created a visible monitored account")
            require(any(item.get("id") == video["id"] for item in link_state.get("videos", [])), "reused video left monitoring data")

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
            require(status == 200 and retry_created.get("reused") is True, "complete history unnecessarily submitted a paid retry")
            # Only a separately explicit paid regeneration bypasses reuse.
            status, retry_created, _ = client.request(
                "POST", "/api/jobs", {"type": "analyze_video", "payload": {**retry_payload, "forceRegenerate": True}}, origin=REMOTE_ORIGIN)
            require(status == 201 and retry_created.get("created") is True, "explicit force regeneration was not dispatched")
            require(retry_created["job"]["payload"].get("forceRegenerate") is True, "explicit regeneration flag was lost")
            retry_job_id = retry_created["job"]["id"]
            require(retry_job_id != analyze_job["id"], "analysis retry reused the old job")
            require(
                retry_created["job"].get("payload", {}).get("sourceKind") == "video_link",
                "link-analysis retry did not retain its strict metadata mode",
            )
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
            require(reopened_video.get("analysis", {}).get("schemaVersion") == ANALYSIS_VERSION, "production plan lost after failed retry and reopen")
            require(reopened_database.remove_account("account-a") is True, "monitored account removal failed")
            preserved_link_state = reopened_database.state()
            require(not preserved_link_state.get("accounts"), "removed monitored account remained visible")
            require(not preserved_link_state.get("videos"), "link-only video remained in monitored video data")
            require(len(preserved_link_state.get("linkVideos", [])) == 1, "link analysis history was deleted with monitored account")
            preserved_link_video = reopened_database.get_video(video["id"])
            require(preserved_link_video is not None and len(preserved_link_video.get("analysisRuns", [])) == 2, "link analysis receipts were deleted with monitored account")
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
