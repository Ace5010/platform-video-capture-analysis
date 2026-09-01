"""Background full-video analysis pipeline."""

from __future__ import annotations

import concurrent.futures
import shutil
import threading
from http import HTTPStatus
from pathlib import Path
from typing import Any

from local_asr.server import ApiError, _transcribe_file

from .config import HostConfig, create_task_temp_dir
from .database import Database
from .media import (
    download_media,
    has_audio_stream,
    lossless_segments_below_limit,
    media_duration_seconds,
    mux_original_streams,
    probe_media,
    remove_task_dir,
    sha256_file,
)
from .qwen import QwenBudgetExceeded, QwenClient, QwenUploadLimitExceeded
from .security import SecretStore


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

    def submit(self, job_id: str, payload: dict[str, Any]) -> bool:
        with self._lock:
            if job_id in self._active:
                return False
            self._active.add(job_id)
        self._executor.submit(self._run_and_release, job_id, dict(payload))
        return True

    def _run_and_release(self, job_id: str, payload: dict[str, Any]) -> None:
        try:
            self._run(job_id, payload)
        finally:
            with self._lock:
                self._active.discard(job_id)

    @staticmethod
    def _transcribe(path: Path) -> str:
        try:
            result = _transcribe_file(path)
            return str(result.get("text") or "").strip()
        except ApiError as error:
            if error.status == HTTPStatus.UNPROCESSABLE_ENTITY:
                # A genuinely speechless video is allowed; all other ASR
                # failures stop analysis instead of degrading to text-only.
                return ""
            raise

    def _run(self, job_id: str, payload: dict[str, Any]) -> None:
        task_dir = create_task_temp_dir(self.config, job_id)
        transcript: str | None = None
        qwen: QwenClient | None = None
        try:
            video_url = payload.get("videoUrl")
            if not isinstance(video_url, str) or not video_url:
                raise ValueError("扩展未提供完整原视频地址")
            self.database.update_job_progress(job_id, "downloading_original_video")
            media_meta = payload.get("mediaMeta") if isinstance(payload.get("mediaMeta"), dict) else {}
            downloaded_video = task_dir / f"original-video{_media_suffix(media_meta.get('video'), '.mp4')}"
            download_media(video_url, downloaded_video, self.config.max_video_bytes, "完整原视频")
            video_probe = probe_media(downloaded_video)
            expected_duration = (media_meta.get("page") or {}).get("durationSeconds")
            actual_duration = media_duration_seconds(video_probe)
            if isinstance(expected_duration, (int, float)) and expected_duration > 1 and actual_duration:
                tolerance = max(2.0, float(expected_duration) * 0.03)
                if abs(actual_duration - float(expected_duration)) > tolerance:
                    raise RuntimeError("下载的视频时长与目标页面不一致，已拒绝不完整媒体")

            analysis_media = downloaded_video
            audio_url = payload.get("audioUrl")
            if not has_audio_stream(video_probe) and isinstance(audio_url, str) and audio_url:
                downloaded_audio = task_dir / f"original-audio{_media_suffix(media_meta.get('audio'), '.m4a')}"
                download_media(audio_url, downloaded_audio, self.config.max_audio_bytes, "原视频音频")
                merged = task_dir / "original-muxed.mp4"
                mux_original_streams(downloaded_video, downloaded_audio, merged)
                probe_media(merged)
                analysis_media = merged

            source_hash = sha256_file(analysis_media)
            metadata = {
                "title": payload.get("title"),
                "description": payload.get("description"),
                # Use the duration measured from the downloaded original, not
                # untrusted page text, to spend Qwen's visual budget without
                # silently trading frame detail for excessive sampling.
                "durationSeconds": actual_duration,
            }
            qwen = QwenClient(self.config, self.secrets.load())
            self.database.update_job_progress(job_id, "local_asr_and_secure_upload")
            # The same complete local media file feeds both branches.  The
            # model request itself waits for ASR because Qwen3.8 Flash does not
            # consume the video's audio track.
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as parallel:
                transcript_future = parallel.submit(self._transcribe, analysis_media)
                upload_future = parallel.submit(qwen.prepare_video, analysis_media)
                transcript = transcript_future.result()
                try:
                    prepared_references = [upload_future.result()]
                except QwenUploadLimitExceeded as upload_limit:
                    self.database.update_job_progress(job_id, "lossless_continuous_segmentation")
                    segment_paths = lossless_segments_below_limit(
                        analysis_media,
                        task_dir / "upload-segments",
                        maximum_bytes=upload_limit.maximum_bytes,
                    )
                    prepared_references = [qwen.prepare_video(path) for path in segment_paths]

            self.database.update_job_progress(job_id, "qwen_full_video_analysis")
            try:
                analysis = qwen.analyze_prepared_videos(prepared_references, transcript, metadata)
            except QwenBudgetExceeded:
                self.database.update_job_progress(job_id, "lossless_continuous_segmentation")
                segment_paths = lossless_segments_below_limit(
                    analysis_media,
                    task_dir / "budget-segments",
                    maximum_bytes=64 * 1024 * 1024,
                )
                analysis = qwen.analyze_segments(segment_paths, transcript, metadata)
            self.database.save_analysis_success(job_id, transcript, analysis, source_hash, qwen.usage_summary())
        except Exception as error:
            # Never include exception detail that could contain a signed URL or
            # API credential.  Expected errors expose their already-safe text.
            if isinstance(error, (ApiError, ValueError, RuntimeError)):
                message = str(error)
            else:
                message = "视频分析发生未预期错误"
            usage = qwen.usage_summary() if qwen is not None else None
            self.database.save_analysis_failure(job_id, message, transcript, usage)
        finally:
            remove_task_dir(task_dir, self.config.temp_dir)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=False)
