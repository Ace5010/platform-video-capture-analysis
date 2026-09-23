"""Background full-video analysis pipeline."""

from __future__ import annotations

import concurrent.futures
import json
import os
import sqlite3
import threading
import time
from collections.abc import Callable
from typing import Any

from . import __version__
from .cloud_asr import CLOUD_ASR_MODEL, CloudAsrClient
from .config import HostConfig, create_task_temp_dir
from .database import Database, utc_now
from .media import (
    download_media,
    has_audio_stream,
    lossless_segments_below_limit,
    media_duration_seconds,
    mux_original_streams,
    probe_media,
    prepare_cloud_audio,
    remove_task_dir,
    sha256_file,
)
from .qwen import QwenAnalysisValidationError, QwenBudgetExceeded, QwenClient, QwenPartialAnalysisError, QwenUploadLimitExceeded, analysis_section_status
from .security import SecretStore
from .recovery import AnalysisCancelled, requires_user_action, safe_error, user_action_for


_MEDIA_SUFFIXES = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-flv": ".flv",
    "video/x-msvideo": ".avi",
    "video/x-matroska": ".mkv",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
}
CAPTURE_ATTEMPTS = 3
CAPTURE_DEADLINE_SECONDS = 420
RETRY_DELAYS = (2, 5)


def _media_suffix(metadata: Any, fallback: str) -> str:
    if not isinstance(metadata, dict):
        return fallback
    content_type = str(metadata.get("contentType") or "").split(";", 1)[0].strip().lower()
    return _MEDIA_SUFFIXES.get(content_type, fallback)


class AnalysisManager:
    """Serializes expensive analysis jobs while parallelizing ASR and upload."""

    def __init__(self, config: HostConfig, database: Database, secrets: SecretStore) -> None:
        self.config = config
        self.database = database
        self.secrets = secrets
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-analysis")
        self._active: set[str] = set()
        self._lock = threading.Lock()

    def submit(self, job_id: str, payload: dict[str, Any], *, capture_media: Callable | None = None) -> bool:
        with self._lock:
            if job_id in self._active:
                return False
            self._active.add(job_id)
        self._executor.submit(self._run_and_release, job_id, dict(payload), capture_media)
        return True

    def _run_and_release(self, job_id: str, payload: dict[str, Any], capture_media: Callable | None = None) -> None:
        try:
            self._run(job_id, payload, capture_media=capture_media)
        finally:
            with self._lock:
                self._active.discard(job_id)

    def _saved_transcript(self, video_id: str) -> str | None:
        # A public video ID identifies the same recording across different
        # playback resolutions/CDN URLs. A completed transcript remains
        # useful when only the subsequent model request failed.
        saved = self.database.get_video(video_id)
        if not saved or saved.get("id") != video_id or saved.get("transcriptStatus") != "ready":
            return None
        transcript = saved.get("transcript")
        # An empty ready transcript is a completed speechless recording, too.
        return transcript.strip() if isinstance(transcript, str) else None

    def _check_cancelled(self, job_id: str) -> None:
        job = self.database.get_job(job_id)
        if isinstance(job, dict) and job.get("status") in {"cancelled", "expired"}:
            raise AnalysisCancelled("用户已取消任务；已完成结果和已发生用量保留")

    def _wait(self, job_id: str, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self._check_cancelled(job_id)
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        self._check_cancelled(job_id)

    def _save(self, operation: Callable, record: Callable) -> Any:
        # A database retry repeats only the transaction, never its cloud work.
        for attempt in range(1, 4):
            try:
                return operation()
            except (sqlite3.OperationalError, OSError) as error:
                record("save", attempt, error)
                if attempt == 3:
                    raise
                time.sleep(0.1 * attempt)

    def _obtain_media(self, job_id, original_payload, task_dir, capture_media, diagnostics):
        """One budget: fresh page/URL, original bytes, identity and completeness."""
        def record(stage, attempt, error):
            diagnostics["failedStage"] = stage
            diagnostics["attempts"].append({"stage": stage, "attempt": attempt, "error": safe_error(error), "at": utc_now()})
        for attempt in range(1, CAPTURE_ATTEMPTS + 1):
            self._check_cancelled(job_id)
            stage = "capture"
            if attempt > 1:
                self.database.update_job_progress(job_id, "retrying_video_capture", attempt=attempt, maxAttempts=3,
                    message=f"正在重新获取视频，尝试 {attempt}/3", diagnostics=diagnostics)
                self._wait(job_id, RETRY_DELAYS[attempt - 2])
            diagnostics["attemptCount"] = attempt
            attempt_dir = task_dir / f"capture-{attempt}"
            attempt_dir.mkdir()
            deadline = time.monotonic() + CAPTURE_DEADLINE_SECONDS

            def check_deadline():
                self._check_cancelled(job_id)
                if time.monotonic() >= deadline:
                    raise RuntimeError("本次视频获取已超过时限")
            try:
                self.database.update_job_progress(job_id, "browser_capture", attempt=attempt, maxAttempts=3)
                payload = capture_media(original_payload, deadline=deadline, check_cancelled=check_deadline) if capture_media else original_payload
                check_deadline()
                video_id = str(original_payload.get("videoId") or "")
                if not video_id or str(payload.get("videoId") or "") != video_id:
                    raise ValueError("媒体 videoId 与任务目标不一致")
                video_url = payload.get("videoUrl")
                if not isinstance(video_url, str) or not video_url:
                    raise ValueError("未取得目标完整视频地址")
                media_meta = payload.get("mediaMeta") if isinstance(payload.get("mediaMeta"), dict) else {}
                observed = (media_meta.get("page") or {}).get("observedVideoId")
                if observed is not None and str(observed) != video_id:
                    raise ValueError("媒体来源页面与目标视频 ID 不一致")
                stage = "download"
                self.database.update_job_progress(job_id, "downloading_original_video", attempt=attempt, maxAttempts=3)
                downloaded = attempt_dir / f"original-video{_media_suffix(media_meta.get('video'), '.mp4')}"
                download_media(video_url, downloaded, self.config.max_video_bytes, "完整原视频", expected_video_id=video_id,
                               deadline=deadline, check_cancelled=check_deadline)
                stage = "validation"
                check_deadline()
                probe = probe_media(downloaded, timeout=deadline - time.monotonic())
                duration = media_duration_seconds(probe)
                if duration is None:
                    raise RuntimeError("完整视频缺少有效时长，无法通过完整性检查")
                expected = (media_meta.get("page") or {}).get("durationSeconds")
                if isinstance(expected, (int, float)) and expected > 1 and abs(duration - float(expected)) > max(2, expected * .03):
                    raise RuntimeError("下载的视频时长与目标页面不一致，已拒绝不完整媒体")
                analysis_media = downloaded
                audio_url = payload.get("audioUrl")
                if not has_audio_stream(probe) and isinstance(audio_url, str) and audio_url:
                    stage = "download"
                    audio = attempt_dir / f"original-audio{_media_suffix(media_meta.get('audio'), '.m4a')}"
                    download_media(audio_url, audio, self.config.max_audio_bytes, "原视频音频", deadline=deadline, check_cancelled=check_deadline)
                    check_deadline()
                    stage = "validation"
                    analysis_media = attempt_dir / "original-muxed.mp4"
                    mux_original_streams(downloaded, audio, analysis_media, timeout=deadline - time.monotonic())
                    check_deadline()
                    probe = probe_media(analysis_media, timeout=deadline - time.monotonic())
                    merged_duration = media_duration_seconds(probe)
                    if not has_audio_stream(probe) or merged_duration is None or abs(merged_duration - duration) > max(2, duration * .03):
                        raise RuntimeError("分离媒体无损封装后的音画完整性检查失败")
                check_deadline()
                if capture_media:
                    stage = "save"
                    self._save(lambda: self.database.save_analysis_media_metadata(job_id, payload), record)
                diagnostics["completedSteps"].append("media")
                return payload, analysis_media, probe, duration
            except AnalysisCancelled:
                raise
            except Exception as error:
                record(stage, attempt, error)
                if stage == "save" or requires_user_action(error) or attempt == CAPTURE_ATTEMPTS or capture_media is None:
                    raise
                # All failed attempt files live below this task's directory;
                # the terminal cleanup removes them together, even on cancel.
        raise RuntimeError("视频获取重试已结束")

    def _preserve_pending_result(self, job_id: str, result: dict[str, Any]) -> None:
        """Durable non-media checkpoint when SQLite itself is unavailable."""
        directory = self.config.data_dir / "pending-analysis-results"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{job_id}.json"
        temporary = path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as output:
            json.dump(result, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)

    def recover_pending_results(self) -> int:
        """Only replay local persistence, never submit cloud work at startup."""
        recovered = 0
        directory = self.config.data_dir / "pending-analysis-results"
        if not directory.is_dir():
            return 0
        for path in directory.glob("*.json"):
            try:
                result = json.loads(path.read_text(encoding="utf-8"))
                job = self.database.get_job(result.get("jobId", ""))
                if not job or str(job["payload"].get("videoId")) != str(result.get("videoId")):
                    continue
                if self.database.restore_superseded_analysis_history(result):
                    path.unlink()
                    recovered += 1
                    continue
                transcript, analysis = result.get("transcript"), result.get("analysis")
                sections = analysis_section_status(analysis)
                video = self.database.get_video(result["videoId"])
                merged = {**((video or {}).get("analysis") or {}), **(analysis or {})}
                if transcript is not None and all(analysis_section_status(merged).values()):
                    self.database.save_analysis_success(job["id"], transcript, merged, result.get("sourceHash") or "", result.get("usage"))
                else:
                    if analysis and any(sections.values()):
                        self.database.save_analysis_checkpoint(job["id"], analysis, result.get("usage"), result.get("sourceHash") or "")
                    self.database.save_analysis_failure(job["id"], "已恢复保存完成的结果，尚有分区未完成", transcript,
                                                        result.get("usage"), result.get("diagnostics"))
                path.unlink()
                recovered += 1
            except (ValueError, KeyError, TypeError, OSError, sqlite3.Error):
                # Preserve the only durable copy until persistence succeeds.
                continue
        return recovered

    def _run(self, job_id: str, payload: dict[str, Any], *, capture_media: Callable | None = None) -> None:
        task_dir = create_task_temp_dir(self.config, job_id)
        transcript: str | None = None
        qwen: QwenClient | None = None
        cloud_asr: CloudAsrClient | None = None
        input_evidence: dict[str, Any] = {}
        diagnostics = {"jobId": job_id, "videoId": str(payload.get("videoId") or ""), "failedStage": "capture",
                       "attemptCount": 0, "attempts": [], "completedSteps": [], "lastError": "", "userAction": "",
                       "versions": {"host": __version__, "analysisModel": self.config.qwen_model, "asrModel": CLOUD_ASR_MODEL}}
        stage = "capture"
        model_attempt = 0
        analysis = None
        source_hash = ""

        def record(step, attempt, error):
            diagnostics["failedStage"] = step
            diagnostics["attempts"].append({"stage": step, "attempt": attempt, "error": safe_error(error), "at": utc_now()})

        def save(operation):
            nonlocal stage
            try:
                return self._save(operation, record)
            except (sqlite3.OperationalError, OSError):
                stage = "save"
                raise

        def upload(path):
            for attempt in range(1, 4):
                self._check_cancelled(job_id)
                try:
                    return qwen.prepare_video(path)
                except QwenUploadLimitExceeded:
                    raise
                except Exception as error:
                    record("upload", attempt, error)
                    if requires_user_action(error) or attempt == 3:
                        raise
                    self.database.update_job_progress(job_id, "retrying_upload", attempt=attempt + 1, maxAttempts=3, message=f"正在重新准备视频上传，尝试 {attempt + 1}/3")
                    self._wait(job_id, RETRY_DELAYS[attempt - 1])

        def usage_summary() -> dict[str, Any] | None:
            if qwen is None:
                return None
            usage = qwen.usage_summary()
            usage["analysisInput"] = dict(input_evidence)
            if cloud_asr is not None:
                speech_usage = cloud_asr.usage_summary()
                usage["cloudAsr"] = speech_usage
                visual_cost = usage.get("estimatedCostCny")
                speech_cost = speech_usage.get("estimatedCostCny")
                usage["totalEstimatedCostCny"] = (
                    round(visual_cost + speech_cost, 8)
                    if usage.get("usageComplete") and speech_usage.get("usageComplete")
                    and isinstance(visual_cost, (int, float)) and isinstance(speech_cost, (int, float))
                    else None
                )
            return usage
        try:
            previous = self.database.get_video(diagnostics["videoId"])
            previous_sections = analysis_section_status(previous.get("analysis") if isinstance(previous, dict) else None)
            requested = [section for section in ("contentAnalysis", "remotion") if not previous_sections.get(section)]
            if payload.get("forceRegenerate") is True:
                requested = ["contentAnalysis", "remotion"]
            for section, ready in previous_sections.items():
                if ready:
                    diagnostics["completedSteps"].append("content" if section == "contentAnalysis" else "remotion")
            transcript = self._saved_transcript(diagnostics["videoId"])
            if transcript is not None:
                diagnostics["completedSteps"].append("transcript")
            payload, analysis_media, video_probe, actual_duration = self._obtain_media(job_id, payload, task_dir, capture_media, diagnostics)
            video_id = str(payload["videoId"])
            source_hash = sha256_file(analysis_media)
            video_stream = next((stream for stream in video_probe.get("streams", []) if stream.get("codec_type") == "video"), {})
            metadata = {
                "title": payload.get("title"),
                "description": payload.get("description"),
                "authorName": payload.get("authorName"),
                # Use the duration measured from the downloaded original, not
                # untrusted page text, to spend Qwen's visual budget without
                # silently trading frame detail for excessive sampling.
                "durationSeconds": actual_duration,
                "width": video_stream.get("width"),
                "height": video_stream.get("height"),
                "avgFrameRate": video_stream.get("avg_frame_rate"),
                "nominalFrameRate": video_stream.get("r_frame_rate"),
            }
            secret = self.secrets.load()
            qwen = QwenClient(self.config, secret)
            qwen.check_cancelled = lambda: self._check_cancelled(job_id)
            last_model_phase = ""

            def report_model_progress(progress: dict[str, Any]) -> None:
                nonlocal last_model_phase
                phase = str(progress.get("phase") or "")
                if phase == "request" and transcript is not None:
                    self._check_cancelled(job_id)
                    save(lambda: self.database.save_analysis_transcript(job_id, transcript, usage_summary()))
                if phase in ("reasoning", "content") and phase != last_model_phase:
                    self.database.update_job_progress(job_id, "qwen_receiving_output" if phase == "content" else "qwen_reasoning")
                    last_model_phase = phase

            qwen.progress_callback = report_model_progress
            saved_transcript = transcript
            # Reuse every already valid section; do not regenerate paid history
            # simply because the output schema gained a newer presentation.
            if requested:
                metadata["requestedSections"] = requested
            input_evidence.update(
                videoId=video_id, sourceHash=source_hash, inputMode="complete_video",
                durationSeconds=actual_duration, width=video_stream.get("width"),
                height=video_stream.get("height"), transcriptReused=saved_transcript is not None,
            )
            self.database.update_job_progress(job_id, "secure_video_upload" if saved_transcript is not None else "cloud_asr_and_secure_upload")
            # Qwen's visual model does not listen to the audio track. Transcribe
            # the complete original audio in the cloud while uploading video.
            if saved_transcript is None:
                stage = "cloud_asr"
                for audio_attempt in range(1, 4):
                    self._check_cancelled(job_id)
                    try:
                        cloud_audio = prepare_cloud_audio(analysis_media, video_probe, task_dir / "complete-audio.m4a")
                        break
                    except (RuntimeError, OSError) as error:
                        record("cloud_asr", audio_attempt, error)
                        if requires_user_action(error) or audio_attempt == 3:
                            raise
                        self._wait(job_id, RETRY_DELAYS[audio_attempt - 1])
                if cloud_audio is not None:
                    cloud_asr = CloudAsrClient(self.config, secret)
                    cloud_asr.check_cancelled = lambda: self._check_cancelled(job_id)
                    cloud_asr.retry_callback = lambda attempt, error: record("cloud_asr", attempt, error)
                else:
                    saved_transcript = ""
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as parallel:
                transcript_future = parallel.submit(cloud_asr.transcribe, cloud_audio) if cloud_asr is not None else None
                upload_future = parallel.submit(upload, analysis_media) if requested else parallel.submit(lambda: None)
                if transcript_future is not None:
                    finished, _pending = concurrent.futures.wait(
                        (transcript_future, upload_future), return_when=concurrent.futures.FIRST_COMPLETED,
                    )
                    if upload_future in finished and transcript_future not in finished:
                        self.database.update_job_progress(job_id, "cloud_asr")
                stage = "cloud_asr"
                transcript = transcript_future.result() if transcript_future is not None else saved_transcript
                if "transcript" not in diagnostics["completedSteps"]:
                    diagnostics["completedSteps"].append("transcript")
                if cloud_asr is not None:
                    # Persist the paid, completed ASR before waiting for visual
                    # inference so process interruption cannot lose its receipt.
                    stage = "save"
                    save(lambda: self.database.save_analysis_transcript(job_id, transcript, usage_summary()))
                if not upload_future.done():
                    self.database.update_job_progress(job_id, "secure_video_upload")
                stage = "upload"
                try:
                    prepared_references = [upload_future.result()]
                except QwenUploadLimitExceeded as upload_limit:
                    self.database.update_job_progress(job_id, "lossless_continuous_segmentation")
                    segment_paths = lossless_segments_below_limit(
                        analysis_media,
                        task_dir / "upload-segments",
                        maximum_bytes=upload_limit.maximum_bytes,
                    )
                    prepared_references = [upload(path) for path in segment_paths]
                    metadata["segmentDurationsSeconds"] = [media_duration_seconds(probe_media(path)) for path in segment_paths]

            self._check_cancelled(job_id)
            stage = "model"
            analysis = {}
            for model_attempt in range(1, 3) if requested else []:
                self._check_cancelled(job_id)
                self.database.update_job_progress(job_id, "qwen_full_video_analysis", attempt=model_attempt, maxAttempts=2)
                try:
                    try:
                        generated = qwen.analyze_prepared_videos(prepared_references, transcript, metadata)
                    except QwenBudgetExceeded:
                        self._check_cancelled(job_id)
                        self.database.update_job_progress(job_id, "lossless_continuous_segmentation")
                        segment_paths = lossless_segments_below_limit(analysis_media, task_dir / "budget-segments", maximum_bytes=64 * 1024 * 1024)
                        generated = qwen.analyze_segments(segment_paths, transcript, metadata)
                    analysis.update(generated)
                    break
                except QwenAnalysisValidationError as partial:
                    analysis.update(partial.partial_analysis)
                    if analysis:
                        save(lambda: self.database.save_analysis_checkpoint(job_id, analysis, usage_summary(), source_hash))
                    for section in partial.completed_sections:
                        key = "content" if section == "contentAnalysis" else "remotion"
                        if key not in diagnostics["completedSteps"]:
                            diagnostics["completedSteps"].append(key)
                    record("model", model_attempt, partial)
                    if model_attempt == 2:
                        raise
                    # Complete response, known billed outcome: repair only
                    # missing fields once. A timeout/stream interruption never
                    # enters this branch and is never resubmitted.
                    metadata["requestedSections"] = list(partial.section_errors)
                    self.database.update_job_progress(job_id, "retrying_analysis_section", message="已保存完成分区，正在恢复缺失分区，尝试 2/2", attempt=2, maxAttempts=2)
                    self._wait(job_id, RETRY_DELAYS[0])
            for section, ready in analysis_section_status(analysis).items():
                key = "content" if section == "contentAnalysis" else "remotion"
                if ready and key not in diagnostics["completedSteps"]:
                    diagnostics["completedSteps"].append(key)
            stage = "save"
            # Keep the returned paid result durable even if all SQLite retries
            # fail. This file contains text/results/receipts, never media URLs.
            save(lambda: self.database.save_analysis_success(job_id, transcript, analysis, source_hash, usage_summary()))
        except Exception as error:
            if isinstance(error, QwenPartialAnalysisError):
                analysis = {**(analysis or {}), **error.partial_analysis}
                for section in error.completed_sections:
                    key = "content" if section == "contentAnalysis" else "remotion"
                    if key not in diagnostics["completedSteps"]:
                        diagnostics["completedSteps"].append(key)
                try:
                    save(lambda: self.database.save_analysis_checkpoint(job_id, analysis, usage_summary(), source_hash))
                except (sqlite3.OperationalError, OSError):
                    stage = "save"
            if isinstance(error, AnalysisCancelled):
                message = str(error)
            else:
                message = safe_error(error)
            if stage == "capture" and diagnostics["attempts"]:
                stage = diagnostics["attempts"][-1]["stage"]
            if not isinstance(error, AnalysisCancelled) and (not diagnostics["attempts"] or diagnostics["attempts"][-1]["error"] != message):
                record(stage, model_attempt if stage == "model" else 1, error)
            diagnostics.update({"failedStage": stage, "lastError": message, "userAction": "" if isinstance(error, AnalysisCancelled) else user_action_for(error, stage)})
            diagnostics["captureAttemptCount"] = diagnostics["attemptCount"]
            if stage not in {"capture", "download", "validation"}:
                diagnostics["attemptCount"] = max((item["attempt"] for item in diagnostics["attempts"] if item["stage"] == stage), default=1)
            usage = usage_summary()
            try:
                save(lambda: self.database.save_analysis_failure(job_id, message, transcript, usage, diagnostics))
            except (sqlite3.OperationalError, OSError):
                stage = "save"
            if stage == "save":
                self._preserve_pending_result(job_id, {"jobId": job_id, "videoId": diagnostics["videoId"], "transcript": transcript,
                    "analysis": analysis, "sourceHash": source_hash, "usage": usage, "diagnostics": diagnostics})
        finally:
            remove_task_dir(task_dir, self.config.temp_dir)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=False)
