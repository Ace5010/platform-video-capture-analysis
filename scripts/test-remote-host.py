"""Exercise the remote listener against an isolated database, without a tunnel."""

from __future__ import annotations

import http.client
import json
import runpy
import tempfile
import threading
from pathlib import Path
from unittest.mock import Mock, patch

# Reuse the existing host fixture configuration, not production configuration.
helpers = runpy.run_path(str(Path(__file__).with_name("test-host-service.py")))
from host_service.remote import RemoteConnection, TunnelProcess  # noqa: E402
from host_service.security import SecretStore  # noqa: E402
from host_service.server import create_remote_gateway, create_server  # noqa: E402

ORIGIN = "https://workbench.example"
TUNNEL_TOKEN = "t" * 60


def run() -> None:
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

        # No real connector is installed or started by these automated checks.
        tunnel = TunnelProcess(config, connection)
        child = Mock()
        child.stderr = iter([])
        child.poll.return_value = None
        with patch("host_service.remote.shutil.which", return_value="test-cloudflared"), patch("host_service.remote.subprocess.Popen", return_value=child) as popen:
            with patch.object(tunnel.stopped, "wait", side_effect=[False, True]):
                with patch.object(tunnel.stopped, "is_set", return_value=True):
                    tunnel._run()
            args, kwargs = popen.call_args
            assert TUNNEL_TOKEN not in " ".join(args[0])
            assert kwargs["env"]["TUNNEL_TOKEN"] == TUNNEL_TOKEN
            assert "quic" in args[0]
            tunnel.shutdown()
            child.terminate.assert_called_once()
        tunnel = TunnelProcess(config, connection)
        tunnel.stopped.set()
        with patch("host_service.remote.shutil.which", return_value="test-cloudflared"), patch("host_service.remote.subprocess.Popen") as popen:
            tunnel._run()
            popen.assert_not_called()
        log_child = Mock(stderr=iter([f'ERR connection token={TUNNEL_TOKEN}\n', 'ERR DNS operation refused\n']))
        tunnel._read_errors(log_child)
        log = (config.data_dir / "remote-tunnel.log").read_text(encoding="utf-8")
        assert TUNNEL_TOKEN not in log and "DNS operation refused" in log
    print("远程主机检查通过：独立临时数据库、DPAPI、登录/CSRF、本机权限隔离、历史读取、任务提交及通道停止。")


if __name__ == "__main__":
    run()
