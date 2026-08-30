"""Strict, size-limited Douyin media download and lossless media operations."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import shutil
import subprocess
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any

from local_asr.server import ApiError, _open_download, _validate_download_target


def download_media(url: str, destination: Path, max_bytes: int, media_name: str = "视频") -> int:
    """Download one already-validated Douyin CDN URL without following unsafe redirects."""
    from urllib.parse import urljoin

    current_url = url
    for redirect_index in range(5):
        target = _validate_download_target(current_url)
        connection, response = _open_download(target)
        try:
            if response.status in (301, 302, 303, 307, 308):
                if redirect_index >= 4:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name} CDN 重定向次数过多")
                location = response.getheader("Location")
                if not location:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name} CDN 返回无效重定向")
                current_url = urljoin(current_url, location)
                continue
            if response.status != HTTPStatus.OK:
                raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name} CDN 返回 HTTP {response.status}")
            declared = response.getheader("Content-Length")
            if declared:
                try:
                    declared_size = int(declared)
                except ValueError as error:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name} CDN 文件大小无效") from error
                if declared_size <= 0:
                    raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name}文件为空")
                if declared_size > max_bytes:
                    raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"{media_name}超过主机安全上限")
                free_bytes = shutil.disk_usage(destination.parent).free
                required_bytes = declared_size * 2 + 2 * 1024 * 1024 * 1024
                if free_bytes < required_bytes:
                    raise ApiError(HTTPStatus.INSUFFICIENT_STORAGE, f"磁盘空间不足，无法安全处理{media_name}")
            content_type = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
            if content_type and not (
                content_type.startswith("video/")
                or content_type.startswith("audio/")
                or content_type in {"application/octet-stream", "binary/octet-stream"}
            ):
                raise ApiError(HTTPStatus.BAD_GATEWAY, f"CDN 未返回可识别的{media_name}文件")
            total = 0
            with destination.open("xb") as output:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"{media_name}超过主机安全上限")
                    output.write(chunk)
            if total == 0:
                raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name}文件为空")
            return total
        except ApiError:
            destination.unlink(missing_ok=True)
            raise
        except (OSError, http.client.HTTPException) as error:
            destination.unlink(missing_ok=True)
            raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name}下载中断") from error
        finally:
            response.close()
            connection.close()
    raise ApiError(HTTPStatus.BAD_GATEWAY, f"{media_name} CDN 重定向次数过多")


def _tool_path(name: str) -> str:
    executable = shutil.which(name)
    if executable:
        return executable
    raise RuntimeError(f"缺少 {name}，请先安装 FFmpeg")


def probe_media(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            _tool_path("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "format=duration,format_name:stream=index,codec_type,codec_name,width,height",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("下载的媒体无法通过完整性检查")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("ffprobe 返回无效结果") from error
    streams = data.get("streams") or []
    if not any(stream.get("codec_type") == "video" for stream in streams):
        raise RuntimeError("采集结果不是完整视频文件")
    return data


def has_audio_stream(probe: dict[str, Any]) -> bool:
    return any(stream.get("codec_type") == "audio" for stream in probe.get("streams") or [])


def media_duration_seconds(probe: dict[str, Any]) -> float | None:
    try:
        duration = float((probe.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        return None
    return duration if duration > 0 else None


def mux_original_streams(video_path: Path, audio_path: Path, output_path: Path) -> None:
    """Combine original encoded streams.  `-c copy` forbids quality loss."""
    result = subprocess.run(
        [
            _tool_path("ffmpeg"),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-i",
            str(audio_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-y",
            str(output_path),
        ],
        capture_output=True,
        timeout=300,
        check=False,
    )
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        output_path.unlink(missing_ok=True)
        raise RuntimeError("原始视频与音频无损封装失败")


def lossless_segments(path: Path, destination: Path, segment_seconds: int = 600) -> list[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    pattern = destination / "segment-%04d.mp4"
    result = subprocess.run(
        [
            _tool_path("ffmpeg"),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-map",
            "0",
            "-c",
            "copy",
            "-f",
            "segment",
            "-segment_time",
            str(segment_seconds),
            "-reset_timestamps",
            "1",
            str(pattern),
        ],
        capture_output=True,
        timeout=900,
        check=False,
    )
    segments = sorted(destination.glob("segment-*.mp4"))
    if result.returncode != 0 or len(segments) < 2 or any(item.stat().st_size == 0 for item in segments):
        raise RuntimeError("视频超过模型预算，但无损连续分段失败")
    return segments


def lossless_segments_below_limit(
    path: Path,
    destination: Path,
    maximum_bytes: int = 1024 * 1024 * 1024,
    maximum_segments: int = 64,
) -> list[Path]:
    """Split by stream copy until every continuous segment fits the upload cap."""
    seconds = 600
    for attempt in range(6):
        attempt_dir = destination / f"attempt-{attempt}"
        segments = lossless_segments(path, attempt_dir, seconds)
        if len(segments) <= maximum_segments and all(item.stat().st_size <= maximum_bytes for item in segments):
            return segments
        shutil.rmtree(attempt_dir, ignore_errors=True)
        seconds //= 2
        if seconds < 30:
            break
    raise RuntimeError("视频超过临时上传上限，无法在 64 段内完成无损连续分段")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cleanup_stale_temp(root: Path, maximum_age_seconds: int = 86400) -> int:
    root.mkdir(parents=True, exist_ok=True)
    resolved_root = root.resolve()
    cutoff = time.time() - maximum_age_seconds
    removed = 0
    for child in root.iterdir():
        try:
            resolved_child = child.resolve()
            if resolved_child.parent != resolved_root or child.stat().st_mtime >= cutoff:
                continue
            if child.is_dir():
                shutil.rmtree(child)
            elif child.is_file():
                child.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def remove_task_dir(path: Path, root: Path) -> None:
    resolved_path = path.resolve()
    resolved_root = root.resolve()
    if resolved_path.parent != resolved_root or not path.name.startswith("job-"):
        raise RuntimeError("拒绝清理非任务临时目录")
    shutil.rmtree(path, ignore_errors=True)
