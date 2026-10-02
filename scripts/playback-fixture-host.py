"""Authenticated host fixture for the real-browser on-demand playback check.

The fixture runs a tiny local media host that behaves like the platform CDN
(range support, an "ignores Range" mode, and a slow body used to observe
cancellation) and injects the resulting address as the resolved preview source.
Nothing is written to the project media directory and no paid model is used.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import uuid
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from host_service.browser import BrowserManager  # noqa: E402
from host_service.config import HostConfig  # noqa: E402
from host_service.preview import PreviewManager, PreviewSource  # noqa: E402
from host_service.server import create_server  # noqa: E402

FIXTURE_ACCOUNT_ID = "browser-fixture"
FIXTURE_VIDEO_IDS = ["1234567890123456700", "1234567890123456701", "1234567890123456702"]
STALL_AFTER_BYTES = 192 * 1024

state: dict[str, Any] = {
    "cdnUrl": "",
    "rangedRequests": 0,
    "fullRequests": 0,
    "bytesServed": 0,
    "cancelledTransfers": 0,
    "ignoreRange": False,
    "stall": False,
    "stallStarted": False,
    "stallReleased": False,
}
stall_event = threading.Event()


def build_media(path: Path) -> None:
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", "testsrc=size=320x568:rate=30", "-f", "lavfi", "-i", "sine=frequency=440",
        "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-movflags", "+faststart", "-y", str(path)], check=True, timeout=60)


def make_handler(payload: bytes):
    class MediaHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args: Any) -> None:
            return

        def _send(self, body: bool) -> None:
            size = len(payload)
            raw_range = self.headers.get("Range")
            if state["ignoreRange"]:
                raw_range = None
            start, end = 0, size - 1
            if raw_range:
                state["rangedRequests"] += 1
                parsed = raw_range.strip().removeprefix("bytes=").split("-", 1)
                if parsed[0]:
                    start = int(parsed[0])
                    end = int(parsed[1]) if len(parsed) > 1 and parsed[1] else size - 1
                else:
                    start = max(0, size - int(parsed[1]))
                end = min(end, size - 1)
                if start >= size or end < start:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            else:
                state["fullRequests"] += 1
            chunk = payload[start:end + 1]
            status = 206 if raw_range else 200
            self.send_response(status)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(chunk)))
            if raw_range:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if not body:
                return
            try:
                written = 0
                for offset in range(0, len(chunk), 16 * 1024):
                    piece = chunk[offset:offset + 16 * 1024]
                    self.wfile.write(piece)
                    written += len(piece)
                    state["bytesServed"] += len(piece)
                    if state["stall"] and written >= STALL_AFTER_BYTES:
                        # Hold the rest open so the viewer's cancellation is
                        # observable instead of the whole file being streamed.
                        state["stallStarted"] = True
                        stall_event.wait(30)
            except (BrokenPipeError, ConnectionResetError):
                state["cancelledTransfers"] += 1
                state["stallReleased"] = True
                stall_event.set()

        def do_GET(self) -> None:  # noqa: N802
            self._send(body=True)

        def do_HEAD(self) -> None:  # noqa: N802
            self._send(body=False)

    return MediaHandler


with tempfile.TemporaryDirectory(prefix="douyin-playback-fixture-") as temporary:
    root = Path(temporary)
    config = replace(HostConfig.from_env(), listen_host="127.0.0.1", listen_port=0,
        dashboard_port=3000, data_dir=root, db_path=root / "monitor.sqlite3",
        secret_path=root / "secret.dpapi", temp_dir=root / "tmp", backup_dir=root / "backups",
        testing=True)
    server = create_server(config)
    # The fixture serves the resolved object from its own local media host, so
    # the production relay is exercised without touching the real CDN.
    server.browser = BrowserManager(config, server.database, server.analysis)
    server.previews = PreviewManager(config, server.database, server.browser)
    media_path = root / "fixture.mp4"
    build_media(media_path)
    payload = media_path.read_bytes()
    cdn = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(payload))
    cdn.daemon_threads = True
    threading.Thread(target=cdn.serve_forever, daemon=True).start()
    state["cdnUrl"] = f"http://127.0.0.1:{cdn.server_address[1]}/fixture.mp4"

    server.database.upsert_account({"id": FIXTURE_ACCOUNT_ID, "url": "https://www.douyin.com/user/fixture",
        "name": "播放测试账号", "platform": "douyin", "status": "ready", "initialSyncStatus": "complete",
        "followerCount": 123000, "followerDisplayText": "12.3万", "followerCountIsApproximate": False,
        "followerCountCapturedAt": "2026-10-01T00:00:00.000Z"})
    candidate_metadata: dict[str, dict[str, Any]] = {}
    for index, video_id in enumerate(FIXTURE_VIDEO_IDS):
        with server.database.transaction() as connection:
            server.database._upsert_video(connection, {"id": video_id, "accountId": FIXTURE_ACCOUNT_ID,
                "url": f"https://www.douyin.com/video/{video_id}", "title": f"测试作品 {index + 1}",
                "description": f"测试作品 {index + 1}", "publishedAt": "2026-09-28T10:00:00Z",
                "durationSeconds": 8, "likeCount": index, "commentCount": 0,
                "favoriteCount": 0, "shareCount": 0})
        candidate_metadata[video_id] = {"width": 320, "height": 568, "bitrate": 300_000,
            "contentLength": len(payload), "codec": "h264"}

    import host_service.preview as preview_module

    def fixture_resolve(self, video, *, check_cancelled=None):
        video_id = str(video["id"])
        metadata = candidate_metadata[video_id]
        candidate_url = state["cdnUrl"]
        fingerprint = "fixture-320x568"
        with self._lock:
            previous = self._sources.get(video_id)
            generation = previous.generation if previous and previous.fingerprint == fingerprint else uuid.uuid4().hex
            source = PreviewSource(video_id=video_id, generation=generation, url=candidate_url,
                fingerprint=fingerprint, width=metadata["width"], height=metadata["height"],
                bitrate=metadata["bitrate"], content_length=metadata["contentLength"], codec=metadata["codec"])
            self._sources[video_id] = source
            self._errors.pop(video_id, None)
        if not previous or previous.generation != generation:
            self.cache.drop(self._cache_key(video_id, generation))
        return source

    preview_module.PreviewManager._resolve = fixture_resolve

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"READY:{server.server_address[1]}", flush=True)
    try:
        for line in sys.stdin:
            command = line.strip()
            if command == "STATE":
                print(json.dumps({key: value for key, value in state.items() if key != "cdnUrl"}), flush=True)
            elif command == "IGNORE_RANGE":
                state["ignoreRange"] = True
                print("OK", flush=True)
            elif command == "STALL":
                state["stall"] = True
                print("OK", flush=True)
            elif command == "RELEASE":
                state["stallReleased"] = True
                stall_event.set()
                print("OK", flush=True)
            elif command in ("", "STOP"):
                break
    finally:
        stall_event.set()
        cdn.shutdown()
        server.shutdown()
        server.server_close()
        server.analysis.shutdown()
        thread.join(timeout=5)
