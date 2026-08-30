"""Configuration for the host service.

Runtime data deliberately lives outside the Git checkout.  Environment
variables are optional and mainly exist for tests and advanced installations.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def default_data_dir() -> Path:
    explicit = os.environ.get("DOUYIN_HOST_DATA_DIR") or os.environ.get("DOUYIN_DATA_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "DouyinMonitor" / "host-service"
    return Path.home() / ".douyin-monitor" / "host-service"


@dataclass(frozen=True)
class HostConfig:
    listen_host: str
    listen_port: int
    data_dir: Path
    db_path: Path
    secret_path: Path
    temp_dir: Path
    backup_dir: Path
    dashboard_port: int
    session_seconds: int
    job_expiry_seconds: int
    analysis_job_expiry_seconds: int
    claim_lease_seconds: int
    max_request_bytes: int
    max_video_bytes: int
    max_audio_bytes: int
    direct_base64_bytes: int
    qwen_model: str
    qwen_fps: int
    qwen_endpoint: str
    upload_policy_endpoint: str
    testing: bool
    mock_qwen: bool

    @classmethod
    def from_env(cls) -> "HostConfig":
        data_dir = default_data_dir()
        temp_dir = data_dir / "tmp"
        return cls(
            listen_host=os.environ.get("DOUYIN_HOST_LISTEN", "0.0.0.0"),
            listen_port=_env_int("DOUYIN_HOST_PORT", 43129, 1024, 65535),
            data_dir=data_dir,
            db_path=data_dir / "monitor.sqlite3",
            secret_path=data_dir / "qwen-secret.dpapi",
            temp_dir=temp_dir,
            backup_dir=data_dir / "migration-backups",
            dashboard_port=_env_int("DOUYIN_DASHBOARD_PORT", 3000, 1, 65535),
            session_seconds=_env_int("DOUYIN_SESSION_SECONDS", 7 * 86400, 900, 30 * 86400),
            job_expiry_seconds=_env_int("DOUYIN_JOB_EXPIRY_SECONDS", 1800, 60, 86400),
            analysis_job_expiry_seconds=_env_int("DOUYIN_ANALYSIS_JOB_EXPIRY_SECONDS", 7 * 86400, 3600, 30 * 86400),
            claim_lease_seconds=_env_int("DOUYIN_CLAIM_LEASE_SECONDS", 120, 30, 900),
            max_request_bytes=_env_int("DOUYIN_MAX_REQUEST_BYTES", 16 * 1024 * 1024, 4096, 64 * 1024 * 1024),
            # The visual model accepts public videos up to 2GB.  Bailian's
            # temporary upload is 1GB, so larger local files are losslessly
            # split before upload rather than compressed or downscaled.
            max_video_bytes=_env_int("DOUYIN_MAX_VIDEO_BYTES", 2 * 1024 * 1024 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
            max_audio_bytes=_env_int("DOUYIN_MAX_AUDIO_BYTES", 128 * 1024 * 1024, 8 * 1024 * 1024, 512 * 1024 * 1024),
            # Alibaba limits the encoded Base64 Data URI to <10MB. Base64 adds
            # about 33%, so keep the original binary at a safe 7MiB ceiling.
            direct_base64_bytes=_env_int("DOUYIN_QWEN_BASE64_BYTES", 7 * 1024 * 1024, 0, 7 * 1024 * 1024),
            qwen_model=os.environ.get("DOUYIN_QWEN_MODEL", "qwen3.8-flash").strip() or "qwen3.8-flash",
            # Qwen accepts up to 10 sampled frames per second. The client
            # dynamically lowers this cap only when a video's duration would
            # otherwise force the service to reduce per-frame resolution.
            qwen_fps=_env_int("DOUYIN_QWEN_FPS", 10, 1, 10),
            qwen_endpoint=os.environ.get(
                "DOUYIN_QWEN_ENDPOINT",
                "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            ).strip(),
            upload_policy_endpoint="https://dashscope.aliyuncs.com/api/v1/uploads",
            testing=_env_bool("DOUYIN_HOST_TESTING"),
            mock_qwen=_env_bool("DOUYIN_QWEN_MOCK"),
        )

    def ensure_directories(self) -> None:
        for directory in (self.data_dir, self.temp_dir, self.backup_dir):
            directory.mkdir(parents=True, exist_ok=True)


def create_task_temp_dir(config: HostConfig, job_id: str) -> Path:
    config.temp_dir.mkdir(parents=True, exist_ok=True)
    safe_prefix = "".join(character for character in job_id if character.isalnum())[:16]
    return Path(tempfile.mkdtemp(prefix=f"job-{safe_prefix}-", dir=config.temp_dir))
