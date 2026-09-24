"""Exercise the remote listener against an isolated database, without a tunnel."""

from __future__ import annotations

import http.client
import json
import runpy
import subprocess
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

# Reuse the existing host fixture configuration, not production configuration.
helpers = runpy.run_path(str(Path(__file__).with_name("test-host-service.py")))
from host_service.remote import RemoteConnection, TunnelProcess, direct_tunnel_arguments  # noqa: E402
from host_service.security import SecretStore  # noqa: E402
from host_service.server import create_remote_gateway, create_server  # noqa: E402

ORIGIN = "https://workbench.example"
TUNNEL_TOKEN = "t" * 60


class SimulatedTime:
    def __init__(self, stop_at=30):
        self.now = 0.0
        self.stop_at = stop_at
        self.stopped = False
        self.waits = []

    def wait(self, seconds):
        self.waits.append(seconds)
        self.now += seconds
        if self.now >= self.stop_at:
            self.set()
        return self.stopped

    def is_set(self):
        return self.stopped

    def set(self):
        self.stopped = True


class SimulatedChild:
    def __init__(self, clock, lifetime, pid):
        self.clock = clock
        self.exit_at = clock.now + lifetime if lifetime is not None else float("inf")
        self.pid = pid
        self.stderr = iter([])
        self.terminations = 0
        self.returncode = None

    def poll(self):
        if self.returncode is None and self.clock.now >= self.exit_at:
            self.returncode = 1
        return self.returncode

    def terminate(self):
        self.terminations += 1
        self.returncode = -15

    def wait(self, timeout):
        assert self.poll() is not None, "unbounded child wait"
        return self.returncode


def check_supervision(config, connection, network_args):
    def simulate(lifetimes, *, stop_at=30, ready=lambda _clock, _children: 4, grace=5, stable=5):
        tunnel = TunnelProcess(replace(config, testing=False), connection)
        clock = SimulatedTime(stop_at)
        tunnel.stopped = clock
        children = []
        starts = []

        def launch(*args, **kwargs):
            assert not children or children[-1].poll() is not None, "overlapping tunnel processes"
            command = args[0]
            assert TUNNEL_TOKEN not in " ".join(command)
            assert kwargs["env"]["TUNNEL_TOKEN"] == TUNNEL_TOKEN
            assert command[-1] == "run" and "quic" in command and "--no-tls-verify" not in command
            assert all(argument in command for argument in network_args)
            assert command[command.index("--metrics") + 1].startswith("127.0.0.1:")
            child = SimulatedChild(clock, lifetimes[min(len(children), len(lifetimes) - 1)], 100 + len(children))
            children.append(child)
            starts.append(clock.now)
            return child

        with patch("host_service.remote.time.monotonic", side_effect=lambda: clock.now), \
             patch("host_service.remote.direct_tunnel_arguments", return_value=network_args) as discover, \
             patch("host_service.remote.subprocess.Popen", side_effect=launch), \
             patch.object(tunnel, "_ready_connections", side_effect=lambda: ready(clock, children)), \
             patch.object(tunnel, "CHECK_INTERVAL", 1), patch.object(tunnel, "UNHEALTHY_GRACE", grace), \
             patch.object(tunnel, "STARTUP_GRACE", grace), \
             patch.object(tunnel, "STABLE_SECONDS", stable):
            tunnel._run()
        assert discover.call_count == len(children), "each restart must refresh the network path"
        assert tunnel.status()["state"] == "stopped"
        assert not children or children[-1].poll() is not None
        return tunnel, clock, children, starts

    # More than three exits must not silently disable remote access; delay is capped.
    _, clock, children, _ = simulate([0.5], stop_at=1500)
    retry_waits = [wait for wait in clock.waits if wait >= 1]
    assert len(children) > 3 and retry_waits[:6] == [1, 2, 5, 10, 15, 30]
    assert max(retry_waits) == 30

    # Later recovery reuses the host; healthy time resets accumulated backoff.
    tunnel, clock, children, starts = simulate([0.5, 0.5, 8, None], stop_at=50)
    assert len(children) == 4 and [wait for wait in clock.waits if wait >= 1] == [1, 2, 1]
    assert children[-1].terminations == 1 and all(child.terminations == 0 for child in children[:-1])

    # Temporary disconnection recovers without restarting; no DNS-warning false alarm.
    _, _, children, _ = simulate([None], stop_at=9, ready=lambda clock, _: 0 if clock.now < 4 else 4)
    assert len(children) == 1

    # A living but disconnected process is replaced only after the grace period.
    _, _, children, starts = simulate([None], stop_at=13, ready=lambda _clock, children: 0 if len(children) == 1 else 4)
    assert len(children) == 2 and starts[1] >= 6
    assert all(child.terminations == 1 for child in children)

    # Shutdown during backoff prevents another spawn.
    _, _, children, _ = simulate([0.5], stop_at=0.7)
    assert len(children) == 1
    tunnel = TunnelProcess(config, connection)
    tunnel.stopped.set()
    with patch("host_service.remote.subprocess.Popen") as popen:
        tunnel._run()
        popen.assert_not_called()
    tunnel = TunnelProcess(replace(config, testing=False), connection)
    with patch("host_service.remote.direct_tunnel_arguments", side_effect=lambda: (tunnel.stopped.set() or [])), \
         patch("host_service.remote.subprocess.Popen") as popen:
        tunnel._run()
        popen.assert_not_called()

    # Stop retrying installation/permission failures that require user action.
    tunnel = TunnelProcess(config, connection)
    with patch("host_service.remote.subprocess.Popen", side_effect=PermissionError("denied")) as popen:
        tunnel._run()
        assert popen.call_count == 1 and tunnel.status()["state"] == "blocked"

    # Malformed or timed-out readiness checks cannot be reported as connected.
    tunnel = TunnelProcess(config, connection)
    for status, payload, expected in [(200, {"readyConnections": 4}, 4), (503, {"readyConnections": 4}, 0),
                                       (200, {"readyConnections": 0}, 0), (200, {"readyConnections": "4"}, 0),
                                       (200, {"readyConnections": True}, 0), (200, [], 0)]:
        client = Mock()
        client.getresponse.return_value = Mock(status=status, read=Mock(return_value=json.dumps(payload).encode()))
        with patch("host_service.remote.http.client.HTTPConnection", return_value=client):
            assert tunnel._ready_connections() == expected
            client.close.assert_called_once()
    with patch("host_service.remote.http.client.HTTPConnection") as connection_mock:
        connection_mock.return_value.request.side_effect = TimeoutError("test timeout")
        assert tunnel._ready_connections() == 0
        connection_mock.return_value.close.assert_called_once()

    # Logs preserve lifecycle evidence while stripping raw credentials and headers.
    log_child = Mock(stderr=iter([f'ERR raw {TUNNEL_TOKEN}\n', 'ERR Cookie: session=secret-session\n', 'ERR DNS operation refused\n']))
    tunnel._read_errors(log_child)
    log = (config.data_dir / "remote-tunnel.log").read_text(encoding="utf-8")
    assert TUNNEL_TOKEN not in log and "secret-session" not in log and "DNS operation refused" in log
    assert "代码 1" in log and "通道已连接" in log and "不再安排重连" in log


def run() -> None:
    # Read-only adapter selection and A-record compatibility, with no real DNS.
    valid_network = {"bindAddress": "192.168.31.188", "edges": ["198.41.192.7", "198.41.192.27", "198.41.200.13", "198.41.200.23"]}
    with patch("host_service.remote.os.name", "nt"), patch("host_service.remote.subprocess.run") as network_query:
        network_query.return_value = Mock(stdout=json.dumps(valid_network))
        network_args = direct_tunnel_arguments()
        assert network_args[:2] == ["--edge-bind-address", "192.168.31.188"]
        assert network_args.count("--edge") == 4
        assert "198.41.192.7:7844" in network_args
        assert network_query.call_args.kwargs["timeout"] == 15
        command = network_query.call_args.args[0][-1]
        assert "Get-NetIPConfiguration" in command and "Resolve-DnsName" in command
        assert not any(word in command for word in ("Set-", "Remove-", "New-Net", "Disable-", "Stop-"))
        for invalid in (
            {**valid_network, "bindAddress": "127.0.0.1"},
            {**valid_network, "bindAddress": "169.254.1.2"},
            {**valid_network, "edges": ["127.0.0.1", "198.41.192.7"]},
            {**valid_network, "edges": ["224.0.0.1", "198.41.192.7"]},
            {**valid_network, "edges": ["198.41.192.7"]},
            {**valid_network, "edges": ["198.41.192.7", "198.41.192.7"]},
            {},
        ):
            network_query.return_value = Mock(stdout=json.dumps(invalid))
            assert direct_tunnel_arguments() == []
        network_query.return_value = Mock(stdout="not json")
        assert direct_tunnel_arguments() == []
        network_query.side_effect = subprocess.TimeoutExpired("powershell", 15)
        assert direct_tunnel_arguments() == []
    with tempfile.TemporaryDirectory(prefix="douyin-remote-check-") as temporary:
        config = helpers["create_test_config"](Path(temporary))
        assert RemoteConnection.load(config) is None
        store = SecretStore(config.data_dir / "remote-connection.dpapi", testing=True)
        store.save({"origin": ORIGIN, "tunnelToken": TUNNEL_TOKEN})
        connection = RemoteConnection.load(config)
        assert connection and connection.tunnel_token == TUNNEL_TOKEN
        assert TUNNEL_TOKEN not in repr(connection)
        assert TUNNEL_TOKEN.encode() not in store.path.read_bytes()
        host = create_server(config)
        gateway = create_remote_gateway(host, connection, port=0)
        assert gateway.server_address[0] == "127.0.0.1"
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (host, gateway)]
        for thread in threads:
            thread.start()
        cookie = ""
        csrf = ""

        def remote(method: str, path: str, body=None, **overrides):
            headers = {"Origin": ORIGIN,
                       "X-Workbench-Client-IP": "198.51.100.9", "Connection": "close"}
            if cookie:
                headers["Cookie"] = cookie
            if csrf:
                headers["X-CSRF-Token"] = csrf
            headers.update(overrides)
            raw = json.dumps(body).encode() if body is not None else None
            if raw:
                headers.update({"Content-Type": "application/json", "Content-Length": str(len(raw))})
            client = http.client.HTTPConnection("127.0.0.1", gateway.server_port, timeout=5)
            try:
                client.request(method, path, body=raw, headers=headers)
                response = client.getresponse()
                return response.status, json.loads(response.read()), dict(response.getheaders())
            finally:
                client.close()

        try:
            for path in ("/api/auth/status", "/api/state", "/health"):
                assert remote("GET", path, **{"Origin": ""})[0] == 403
                assert remote("GET", path, **{"Origin": "http://localhost:3000"})[0] == 403
            status, result, _ = remote("GET", "/api/auth/status")
            assert status == 200 and result["localHost"] is False and result["setupAllowed"] is False
            assert remote("GET", "/api/state")[0] == 401
            local = helpers["ApiClient"]("127.0.0.1", host.server_port)
            assert local.request("GET", "/health", origin="")[1]["remote"]["state"] == "not_configured"
            host.tunnel = Mock(status=Mock(return_value={"state": "connected", "readyConnections": 4}))
            assert local.request("GET", "/health", origin="")[1]["remote"]["readyConnections"] == 4
            assert "remote" not in remote("GET", "/health")[1], "local diagnostics leaked into remote health"
            assert "remote" not in remote("GET", "/health", **{"X-Workbench-Client-IP": "127.0.0.1"})[1]
            assert local.request("POST", "/api/auth/setup", {"password": helpers["ACCESS_PASSWORD"]})[0] == 201
            status, result, response_headers = remote("POST", "/api/auth/login", {"password": helpers["ACCESS_PASSWORD"]})
            assert status == 200
            cookie = response_headers["Set-Cookie"].split(";", 1)[0]
            csrf = result["csrfToken"]
            assert all(flag in response_headers["Set-Cookie"] for flag in ("HttpOnly", "Secure", "SameSite=Strict"))
            assert "Access-Control-Allow-Origin" not in response_headers
            for path in ("/api/auth/setup", "/api/qwen/config", "/api/qwen", "/api/migrate", "/api/browser/open", "/connector/pair", "/connector/poll"):
                assert remote("POST", path, {})[0] == 403, path
                assert remote("POST", path, {}, **{"X-Workbench-Client-IP": "127.0.0.1"})[0] == 403, path
            assert remote("GET", "/api/qwen/status")[1]["configurable"] is False
            assert remote("POST", "/api/accounts/upsert", {"account": {}}, **{"X-CSRF-Token": ""})[0] == 403

            account = {"id": "remote-fixture", "name": "远程模拟账号", "platform": "douyin", "url": "https://www.douyin.com/user/remote-fixture"}
            assert local.request("POST", "/api/accounts/upsert", {"account": account})[0] == 200
            status, result, _ = remote("GET", "/api/state")
            assert status == 200 and result["accounts"][0]["id"] == account["id"]
            assert remote("GET", "/api/jobs")[1]["jobs"] == [], "browsing started a task"
            status, result, _ = remote("POST", "/api/jobs", {"type": "collect_latest", "payload": {"accountId": account["id"], "url": account["url"]}})
            assert status == 201, result
            assert local.request("GET", "/api/jobs")[1]["jobs"][0]["id"] == result["job"]["id"]
            # Stopping remote access leaves the same host/database available.
            status, _, response_headers = remote("POST", "/api/auth/logout", {})
            assert status == 200 and "Max-Age=0" in response_headers["Set-Cookie"] and "Secure" in response_headers["Set-Cookie"]
            assert remote("GET", "/api/state")[0] == 401
            shared_browser = Mock()
            gateway.browser = shared_browser
            gateway.shutdown()
            gateway.server_close()
            shared_browser.shutdown.assert_not_called()
            assert local.request("GET", "/api/state")[0] == 200
        finally:
            gateway.shutdown()
            gateway.server_close()
            host.shutdown()
            host.server_close()
            host.analysis.shutdown()
            for thread in threads:
                thread.join(timeout=2)

        # No real connector or public endpoint is used by these automated checks.
        with patch("host_service.remote.shutil.which", return_value="fixture-cloudflared"):
            check_supervision(config, connection, network_args)
    print("远程主机检查通过：隔离数据库、权限、历史读取、连续退出恢复、断连宽限、卡住恢复、间隔上限、取消及日志脱敏。")


if __name__ == "__main__":
    run()
