"""Optional Cloudflare connection; credentials remain in CurrentUser DPAPI."""

from __future__ import annotations

import ipaddress
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .config import HostConfig
from .security import SecretStore
from .recovery import safe_error


GATEWAY_PORT = 43130  # Loopback only; never add this to the LAN firewall rules.

# Only this connector chooses a source interface. Do not change Windows routes,
# DNS, proxy settings, or the user's VPN. Some TUN proxies reject SRV queries
# and cannot carry cloudflared's QUIC traffic even when ordinary HTTPS works.
_DIRECT_NETWORK_QUERY = r"""
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'
$interfaces = @(Get-NetIPConfiguration | Where-Object {
    $_.NetAdapter.HardwareInterface -and $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway
} | Sort-Object { $_.IPv4Interface.InterfaceMetric })
if ($interfaces.Count -eq 0) { exit 1 }
$bindAddress = $interfaces[0].IPv4Address.IPAddress | Select-Object -First 1
$edges = @('region1.v2.argotunnel.com', 'region2.v2.argotunnel.com') | ForEach-Object {
    @(Resolve-DnsName -Name $_ -Type A -DnsOnly -QuickTimeout |
        Where-Object Type -eq 'A' | Select-Object -ExpandProperty IPAddress -Unique) |
        Select-Object -First 2
}
@{ bindAddress = $bindAddress; edges = @($edges) } | ConvertTo-Json -Compress
"""


def direct_tunnel_arguments() -> list[str]:
    """Read a physical route and official edge A records; change no OS state.

    cloudflared 2026.9.1 accepts static edges without changing its certificate
    checks. The --edge switch is a diagnostic/compatibility interface, so keep
    its use here and recheck it when upgrading the installed local client.
    """
    if os.name != "nt":
        return []
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _DIRECT_NETWORK_QUERY],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=15, check=True, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        details = json.loads(result.stdout)
        bind = ipaddress.IPv4Address(details["bindAddress"])
        if bind.is_loopback or bind.is_link_local or bind.is_multicast or bind.is_unspecified:
            return []
        edges = list(dict.fromkeys(str(ipaddress.IPv4Address(value)) for value in details["edges"]))
        if len(edges) < 2 or len(edges) > 4 or any(
            not ipaddress.ip_address(value).is_global or ipaddress.ip_address(value).is_multicast for value in edges
        ):
            return []
        arguments = ["--edge-bind-address", str(bind)]
        for edge in edges:
            arguments.extend(["--edge", f"{edge}:7844"])
        return arguments
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
        # Standard cloudflared discovery remains available on other networks.
        return []


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
    """Supervise only our connector, never replay capture or paid model jobs."""

    RETRY_DELAYS = (1, 2, 5, 10, 15, 30)
    CHECK_INTERVAL = 2
    STARTUP_GRACE = 30
    UNHEALTHY_GRACE = 10
    STABLE_SECONDS = 60

    def __init__(self, config: HostConfig, connection: RemoteConnection) -> None:
        self.config = config
        self.connection = connection
        self.process: subprocess.Popen | None = None
        self.stopped = threading.Event()
        self.thread: threading.Thread | None = None
        self.error: str | None = None
        self._last_stderr = ""
        self._log_lock = threading.Lock()
        self._status = {"state": "starting", "attempts": 0, "readyConnections": 0, "lastError": None}
        self._failures = 0
        self._metrics_port = 0

    def status(self) -> dict:
        return self._status.copy()

    def _update(self, **values) -> None:
        self._status = {**self._status, **values}

    def start(self) -> None:
        if self.stopped.is_set() or (self.thread and self.thread.is_alive()):
            return
        self.thread = threading.Thread(target=self._run, daemon=True, name="cloudflare-tunnel")
        self.thread.start()

    def _record(self, message: str) -> str:
        message = safe_error(message.replace(self.connection.tunnel_token, "[凭据已隐藏]")).strip()
        log_path = self.config.data_dir / "remote-tunnel.log"
        with self._log_lock:
            try:
                # Keep a small, redacted connection log, never request headers.
                if log_path.exists() and log_path.stat().st_size > 64 * 1024:
                    tail = log_path.read_bytes()[-32 * 1024:].decode("utf-8", errors="ignore")
                    log_path.write_text(tail, encoding="utf-8")
                with log_path.open("a", encoding="utf-8") as log:
                    log.write(f"{datetime.now(timezone.utc).isoformat()} {message}\n")
            except OSError:
                pass
        return message

    def _read_errors(self, process: subprocess.Popen) -> None:
        if process.stderr is None:
            return
        for raw in process.stderr:
            message = self._record(raw)
            if process is self.process:
                self._last_stderr = message

    def _ready_connections(self) -> int:
        # Explicit loopback HTTP bypasses proxy settings and never sends secrets.
        client = http.client.HTTPConnection("127.0.0.1", self._metrics_port, timeout=2)
        try:
            client.request("GET", "/ready")
            response = client.getresponse()
            payload = json.loads(response.read(4096))
            count = payload.get("readyConnections")
            return count if response.status == 200 and type(count) is int and count > 0 else 0
        except (OSError, http.client.HTTPException, ValueError, AttributeError):
            return 0
        finally:
            client.close()

    def _monitor(self, process: subprocess.Popen) -> str:
        unhealthy_since: float | None = time.monotonic()
        healthy_since: float | None = None
        has_connected = False
        next_check = 0.0
        while not self.stopped.wait(0.5):
            code = process.poll()
            if code is not None:
                return f"cloudflared 已退出（代码 {code}）"
            now = time.monotonic()
            if now < next_check:
                continue
            next_check = now + self.CHECK_INTERVAL
            count = self._ready_connections()
            if self.stopped.is_set():
                break
            if count:
                has_connected = True
                if healthy_since is None:
                    healthy_since = now
                    self._record(f"通道已连接（可用连接 {count}，第 {self._status['attempts']} 次启动）")
                unhealthy_since = None
                self.error = None
                self._update(state="connected", readyConnections=count, lastError=None, nextRetrySeconds=0)
                if now - healthy_since >= self.STABLE_SECONDS:
                    self._failures = 0
            else:
                healthy_since = None
                if unhealthy_since is None:
                    unhealthy_since = now
                    self._record("通道暂时断开，等待客户端自动重连")
                self._update(state="reconnecting", readyConnections=0)
                grace = self.UNHEALTHY_GRACE if has_connected else self.STARTUP_GRACE
                if now - unhealthy_since >= grace:
                    return f"连续 {grace} 秒未检测到可用隧道连接，将重新检测网络并启动通道"
        return "主机已请求停止通道"

    @staticmethod
    def _stop_child(process: subprocess.Popen) -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def _run(self) -> None:
        local_binary = Path(__file__).resolve().parents[1] / "data" / "tools" / "cloudflared.exe"
        executable = str(local_binary) if local_binary.is_file() else shutil.which("cloudflared")
        if not executable:
            self.error = self._record("未安装 cloudflared，远程连接尚未启动；请安装项目隧道客户端")
            self._update(state="blocked", lastError=self.error)
            return
        # The token is never a command-line argument or a plaintext file.
        environment = os.environ.copy()
        environment["TUNNEL_TOKEN"] = self.connection.tunnel_token
        delay = 0
        try:
            # A persistent connection must recover after a later network outage;
            # analysis/capture attempts keep their separate, bounded budgets.
            while not self.stopped.wait(delay):
                self._update(state="starting", attempts=self._status["attempts"] + 1, nextRetrySeconds=0)
                reader = None
                reason = ""
                try:
                    network_arguments = [] if self.config.testing else direct_tunnel_arguments()
                    if self.stopped.is_set():
                        return
                    # Give this child its own loopback metrics port, rather than
                    # accidentally treating another project's tunnel as healthy.
                    with socket.socket() as probe:
                        probe.bind(("127.0.0.1", 0))
                        self._metrics_port = probe.getsockname()[1]
                    self._last_stderr = ""
                    self.process = subprocess.Popen(
                        [executable, "tunnel", "--no-autoupdate", "--protocol", "quic", "--loglevel", "warn",
                         "--metrics", f"127.0.0.1:{self._metrics_port}", *network_arguments, "run"],
                        env=environment, stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                        text=True, encoding="utf-8", errors="replace",
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                    )
                    self._record(f"启动通道（第 {self._status['attempts']} 次，PID {self.process.pid}）")
                    reader = threading.Thread(target=self._read_errors, args=(self.process,), daemon=True, name="tunnel-errors")
                    reader.start()
                    reason = self._monitor(self.process)
                except (FileNotFoundError, PermissionError) as error:
                    self.error = self._record(f"无法运行隧道客户端（{type(error).__name__}）；请检查安装或文件权限")
                    self._update(state="blocked", readyConnections=0, lastError=self.error)
                    return
                except Exception as error:
                    reason = f"通道检查或启动失败：{safe_error(error)}"
                finally:
                    if self.process:
                        # Never start another connector until our previous child
                        # has exited; do not terminate any unrelated process.
                        self._stop_child(self.process)
                    if reader:
                        reader.join(timeout=2)
                    self.process = None
                if self.stopped.is_set():
                    return
                if self._last_stderr:
                    reason += f"；最近客户端记录：{self._last_stderr}"
                self.error = self._record(reason)
                delay = self.RETRY_DELAYS[min(self._failures, len(self.RETRY_DELAYS) - 1)]
                self._failures += 1
                self._update(state="waiting", readyConnections=0, lastError=self.error, nextRetrySeconds=delay)
                self._record(f"将在 {delay} 秒后重新启动通道")
        except Exception as error:
            self.error = self._record(f"通道管理停止：{safe_error(error)}；请检查客户端进程后重启工作台")
            self._update(state="blocked", readyConnections=0, lastError=self.error)
        finally:
            if self.stopped.is_set():
                self._update(state="stopped", readyConnections=0, nextRetrySeconds=0)
                self._record("主机停止通道；不再安排重连")

    def shutdown(self) -> None:
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=30)
