"""Optional Cloudflare connection; credentials remain in CurrentUser DPAPI."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .config import HostConfig
from .security import SecretStore
from .recovery import safe_error


GATEWAY_PORT = 43130  # Loopback only; never add this to the LAN firewall rules.


@dataclass(frozen=True, repr=False)
class RemoteConnection:
    origin: str
    tunnel_token: str

    @classmethod
    def load(cls, config: HostConfig) -> "RemoteConnection | None":
        payload = SecretStore(config.data_dir / "remote-connection.dpapi", testing=config.testing).load()
        if not payload:
            return None
        origin = str(payload.get("origin") or "")
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or parsed.port not in (None, 443):
            raise ValueError("远程工作台地址必须是完整的 HTTPS 来源，不含路径")
        tunnel_token = str(payload.get("tunnelToken") or "")
        if not re.fullmatch(r"[A-Za-z0-9_+/=-]{40,4096}", tunnel_token):
            raise ValueError("Cloudflare 隧道凭据无效，请重新配置")
        return cls(origin, tunnel_token)


class TunnelProcess:
    """Only supervises its own child; cloudflared handles transport reconnects."""

    def __init__(self, config: HostConfig, connection: RemoteConnection) -> None:
        self.config = config
        self.connection = connection
        self.process: subprocess.Popen | None = None
        self.stopped = threading.Event()
        self.thread: threading.Thread | None = None
        self.error: str | None = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self._run, daemon=True, name="cloudflare-tunnel")
        self.thread.start()

    def _read_errors(self, process: subprocess.Popen) -> None:
        log_path = self.config.data_dir / "remote-tunnel.log"
        if process.stderr is None:
            return
        for raw in process.stderr:
            message = safe_error(raw.replace(self.connection.tunnel_token, "[凭据已隐藏]")).strip()
            self.error = message
            try:
                # Keep a small, redacted connection log, never request headers.
                if log_path.exists() and log_path.stat().st_size > 64 * 1024:
                    tail = log_path.read_bytes()[-32 * 1024:].decode("utf-8", errors="ignore")
                    log_path.write_text(tail, encoding="utf-8")
                with log_path.open("a", encoding="utf-8") as log:
                    log.write(message + "\n")
            except OSError:
                pass

    def _run(self) -> None:
        local_binary = Path(__file__).resolve().parents[1] / "data" / "tools" / "cloudflared.exe"
        executable = str(local_binary) if local_binary.is_file() else shutil.which("cloudflared")
        if not executable:
            self.error = "未安装 cloudflared，远程连接尚未启动"
            print(f"[remote-host] {self.error}", flush=True)
            return
        # The token is never a command-line argument or a plaintext file.
        environment = os.environ.copy()
        environment["TUNNEL_TOKEN"] = self.connection.tunnel_token
        for attempt in range(3):
            if self.stopped.wait(0 if attempt == 0 else 5 * attempt):
                return
            try:
                self.process = subprocess.Popen(
                    [executable, "tunnel", "--no-autoupdate", "--protocol", "quic", "--loglevel", "warn", "run"],
                    env=environment, stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    text=True, encoding="utf-8", errors="replace",
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                threading.Thread(target=self._read_errors, args=(self.process,), daemon=True, name="tunnel-errors").start()
                self.error = None
                while not self.stopped.wait(0.5):
                    if self.process.poll() is not None:
                        break
                if self.stopped.is_set():
                    return
                self.error = f"cloudflared 已退出（代码 {self.process.returncode}，启动 {attempt + 1}/3）"
            except OSError:
                self.error = f"无法启动 cloudflared（启动 {attempt + 1}/3）"
            print(f"[remote-host] {self.error}", flush=True)

    def shutdown(self) -> None:
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=2)
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
