"""Isolated checks for on-demand playback: bounded prewarm, range relay, cleanup.

Everything runs against a local media host that emulates the platform CDN,
including a server that ignores ``Range``. No media is written to the project
data directory, and no paid model or real browser is involved.
"""

from __future__ import annotations

import http.client
import json
import hashlib
import sys
import tempfile
import threading
import time
from dataclasses import replace
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from host_service.config import HostConfig  # noqa: E402
from host_service.preview import PreviewSource, PreviewCache, _CacheEntry, GenerationChanged  # noqa: E402
from host_service.server import create_server, create_remote_gateway  # noqa: E402

PAYLOAD = bytes(range(256)) * 8192  # 2 MiB of deterministic container-like bytes
VIDEO_ID = "1234567890123456789"
OTHER_VIDEO_ID = "1234567890123456790"
ACCOUNT_ID = "preview-account"

# Retain startup bytes and end metadata while a long video is played/seeked.
# Later playback must not grow one entry to the size of the whole resource.
long_payload = bytes(range(251)) * 40_000
entry = _CacheEntry(url="fixture", fingerprint="v1", total_bytes=len(long_payload))
entry.add(len(long_payload) - 4096, long_payload[-4096:])
for offset in range(0, 7 * 1024 * 1024, 64 * 1024):
    entry.add(offset, long_payload[offset:offset + 64 * 1024])
assert entry.slice(0, 128 * 1024) == long_payload[:128 * 1024]
assert entry.slice(len(long_payload) - 4096, len(long_payload)) == long_payload[-4096:]
assert len(entry.buffer) == 2 * 1024 * 1024 and len(entry.tail) <= 2 * 1024 * 1024
assert entry.stored_bytes() <= 4 * 1024 * 1024 + 64 * 1024
try:
    entry.add(0, b"changed version")
    raise AssertionError("overlapping changed bytes must invalidate the resource")
except GenerationChanged:
    pass
clock_value = 100.0
with patch("host_service.preview.time.monotonic", side_effect=lambda: clock_value):
    cache = PreviewCache(max_bytes=32 * 1024 * 1024, idle_seconds=900)
    retained = cache.create("retained", "fixture", "v1")
    cache.store("retained", retained, 0, b"startup")
    clock_value += 180
    assert cache.used_bytes() == 7, "repeat playback within 15 minutes should retain bytes"
    clock_value += 901
    assert cache.used_bytes() == 0, "idle bytes must expire"

state: dict[str, Any] = {"ranged": 0, "full": 0, "served": 0, "ignoreRange": False,
                         "rejectRemaining": 0, "path": "/media.mp4"}


def make_handler(payload: bytes):
    class MediaHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args: Any) -> None:
            return

        def _send(self, body: bool) -> None:
            if self.path == "/expired.mp4" or state["rejectRemaining"]:
                state["rejectRemaining"] = max(0, state["rejectRemaining"] - 1)
                self.send_response(403)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.path != state["path"]:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            size = len(payload)
            raw_range = None if state["ignoreRange"] else self.headers.get("Range")
            start, end = 0, size - 1
            if raw_range:
                state["ranged"] += 1
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
                state["full"] += 1
            chunk = payload[start:end + 1]
            self.send_response(206 if raw_range else 200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(chunk)))
            if raw_range:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if body:
                self.wfile.write(chunk)
                state["served"] += len(chunk)

        def do_GET(self) -> None:  # noqa: N802
            self._send(True)

        def do_HEAD(self) -> None:  # noqa: N802
            self._send(False)

    return MediaHandler


def request(port, method, path, *, cookie=None, csrf=None, range_value=None, body=None,
            origin="http://localhost:3000"):
    headers = {"Origin": origin, "Connection": "close"}
    if cookie:
        headers["Cookie"] = cookie
    if csrf:
        headers["X-CSRF-Token"] = csrf
    if range_value:
        headers["Range"] = range_value
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def wait_for_ready(port, cookie, video_id, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, _, raw = request(port, "GET", f"/api/previews/{video_id}/status", cookie=cookie)
        payload = json.loads(raw)
        if payload.get("status") == "ready":
            return payload
        assert payload.get("status") in ("pending", "idle"), payload
        time.sleep(0.05)
    raise AssertionError("preview source was never resolved")


media = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(PAYLOAD))
media.daemon_threads = True
threading.Thread(target=media.serve_forever, daemon=True).start()
media_url = f"http://127.0.0.1:{media.server_address[1]}/media.mp4"

with tempfile.TemporaryDirectory(prefix="douyin-preview-test-") as temporary:
    root = Path(temporary)
    base = HostConfig.from_env()
    config = replace(base, listen_host="127.0.0.1", listen_port=0, data_dir=root,
        db_path=root / "monitor.sqlite3", secret_path=root / "secret.dpapi", temp_dir=root / "tmp",
        backup_dir=root / "backups", testing=True)
    server = create_server(config)
    # This suite exercises the relay itself. It attaches the same preview
    # manager the production server builds, without starting Chrome.
    from host_service.browser import BrowserManager
    from host_service.preview import PreviewManager

    server.browser = BrowserManager(config, server.database, server.analysis)
    server.previews = PreviewManager(config, server.database, server.browser)
    gateway = create_remote_gateway(server, SimpleNamespace(origin="https://fixture.example"), port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    gateway_thread = threading.Thread(target=gateway.serve_forever, daemon=True)
    thread.start()
    gateway_thread.start()
    try:
        import host_service.preview as preview_module

        actual_open = preview_module._open_url
        received = {"bytes": 0}

        class ObservedResponse:
            def __init__(self, response):
                self.response = response

            def __getattr__(self, name):
                return getattr(self.response, name)

            def read(self, size=-1):
                data = self.response.read(size)
                received["bytes"] += len(data)
                return data

        preview_module._open_url = lambda *args, **kwargs: ObservedResponse(actual_open(*args, **kwargs))

        resolutions = {"count": 0}

        def fixture_resolve(self, video, *, check_cancelled=None):
            resolutions["count"] += 1
            video_id = str(video["id"])
            # The isolated test host serves the verified object itself; the
            # production relay still only accepts the platform's HTTPS hosts.
            fingerprint = f"fixture-{len(PAYLOAD)}"
            with self._lock:
                previous = self._sources.get(video_id)
                generation = previous.generation if previous and previous.fingerprint == fingerprint \
                    else hashlib.sha256(f"{video_id}:{fingerprint}".encode()).hexdigest()[:32]
                source = PreviewSource(video_id=video_id, generation=generation, url=media_url,
                    fingerprint=fingerprint, width=480, height=854, bitrate=400_000,
                    content_length=len(PAYLOAD), codec="h264")
                self._sources[video_id] = source
                self._errors.pop(video_id, None)
            if not previous or previous.generation != generation:
                self.cache.drop(self._cache_key(video_id, generation))
            return source

        preview_module.PreviewManager._resolve = fixture_resolve

        port = server.server_address[1]
        status, headers, raw = request(port, "POST", "/api/auth/setup", body={"password": "preview-test-password"})
        assert status == 201, (status, raw)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        status, _, raw = request(port, "GET", "/api/auth/status", cookie=cookie)
        csrf = json.loads(raw)["csrfToken"]

        server.database.upsert_account({"id": ACCOUNT_ID, "url": "https://www.douyin.com/user/preview",
            "name": "预览测试账号", "platform": "douyin", "status": "ready", "initialSyncStatus": "complete"})
        for video_id, title in ((VIDEO_ID, "预览测试作品"), (OTHER_VIDEO_ID, "另一条作品")):
            with server.database.transaction() as connection:
                server.database._upsert_video(connection, {"id": video_id, "accountId": ACCOUNT_ID,
                    "url": f"https://www.douyin.com/video/{video_id}", "title": title,
                    "description": title, "publishedAt": "2026-09-28T00:00:00Z", "durationSeconds": 60,
                    "likeCount": 0, "commentCount": 0, "favoriteCount": 0, "shareCount": 0})

        # ---- access control -------------------------------------------------
        assert request(port, "GET", f"/api/previews/{VIDEO_ID}/status")[0] == 401
        assert request(port, "POST", "/api/previews/prepare", body={"videoIds": [VIDEO_ID]})[0] == 401
        assert request(port, "GET", "/api/previews/9999999999999999999/status", cookie=cookie)[0] == 404
        assert request(port, "POST", "/api/previews/prepare", cookie=cookie, csrf=csrf,
                       body={"videoIds": ["9999999999999999999"]})[0] == 404
        # Two distinct works exceed the per-request preparation limit.
        with server.database.transaction() as connection:
            server.database._upsert_video(connection, {"id": "1234567890123456791", "accountId": ACCOUNT_ID,
                "url": "https://www.douyin.com/video/1234567890123456791", "title": "第三条作品",
                "description": "第三条作品", "publishedAt": "2026-09-27T00:00:00Z",
                "likeCount": 0, "commentCount": 0, "favoriteCount": 0, "shareCount": 0})
        assert request(port, "POST", "/api/previews/prepare", cookie=cookie, csrf=csrf,
                       body={"videoIds": [VIDEO_ID, OTHER_VIDEO_ID, "1234567890123456791"]})[0] == 400
        assert request(port, "GET", "/api/previews/123/../../secret/status", cookie=cookie)[0] == 404
        assert request(port, "GET", f"/api/previews/{VIDEO_ID}/not-a-generation/media", cookie=cookie)[0] == 404

        # ---- prepare and status --------------------------------------------
        status, _, raw = request(port, "POST", "/api/previews/prepare", cookie=cookie, csrf=csrf,
                                 body={"videoIds": [VIDEO_ID, OTHER_VIDEO_ID]})
        assert status == 202, (status, raw)
        sources = {item["videoId"]: item for item in json.loads(raw)["sources"]}
        assert set(sources) == {VIDEO_ID, OTHER_VIDEO_ID}
        prepared = wait_for_ready(port, cookie, VIDEO_ID)
        generation = prepared["generation"]
        assert prepared["width"] == 480 and prepared["height"] == 854, prepared
        # A second prepare reuses the resolved generation rather than re-opening.
        _, _, raw = request(port, "POST", "/api/previews/prepare", cookie=cookie, csrf=csrf,
                            body={"videoIds": [VIDEO_ID]})
        assert json.loads(raw)["sources"][0]["generation"] == generation

        media_path = f"/api/previews/{VIDEO_ID}/{generation}/media"
        # Measure explicit reads after the speculative worker has settled.
        # Otherwise an unrelated queued prewarm can change the shared CDN byte
        # counter while a fully cached startup range is being asserted.
        server.previews._stopping.set()
        server.previews._worker.join(timeout=5)
        assert not server.previews._worker.is_alive()
        source = server.previews.source_for(VIDEO_ID, generation)
        added = server.previews.prewarm(source)
        stored = server.previews._entry(source).stored_bytes()
        assert 0 <= added <= stored, "prewarm only counts newly read bytes"
        # The speculative prewarm is what the host reads before any player
        # request, and it must stay a small fraction of the whole work.
        ratio_budget = max(1, int(len(PAYLOAD) * config.preview_prefetch_max_ratio))
        assert 0 < stored <= config.preview_prefetch_max_bytes, stored
        assert stored <= ratio_budget + config.preview_prefetch_initial_bytes, (
            f"prewarm stored {stored} bytes, above the bounded budget {ratio_budget}")
        assert stored < len(PAYLOAD) // 4, f"prewarm must stay far below the whole file (stored {stored})"

        # A startup prefix shorter than the relay's normal block must be sent
        # immediately. Opening the CDN again defeats the purpose of prewarming.
        cache_key = server.previews._cache_key(VIDEO_ID, generation)
        server.previews.cache.drop(cache_key)
        entry = server.previews._entry(server.previews.source_for(VIDEO_ID, generation))
        entry.total_bytes = len(PAYLOAD)
        prefix = PAYLOAD[:128 * 1024]
        server.previews.cache.store(cache_key, entry, 0, prefix)
        before_startup = received["bytes"]
        _, _, _, _, startup = server.previews.stream(VIDEO_ID, generation, 0, None)
        try:
            assert next(startup) == prefix, "startup must replay the cached prefix before opening upstream"
            assert received["bytes"] == before_startup, "startup fetched already cached bytes again"
        finally:
            startup.close()

        # An address can expire after the verified startup bytes were cached.
        # Recovery must run while consuming the lazy body, at the same offset.
        source = server.previews.source_for(VIDEO_ID, generation)
        source.url = media_url.replace("/media.mp4", "/expired.mp4")
        server.previews.cache.drop(cache_key)
        entry = server.previews._entry(source)
        entry.total_bytes = len(PAYLOAD)
        server.previews.cache.store(cache_key, entry, 0, prefix)
        before_recovery = resolutions["count"]
        status, headers, body = request(port, "GET", media_path, cookie=cookie,
                                        range_value="bytes=0-262143")
        assert status == 206 and body == PAYLOAD[:262144], "expired source truncated the lazy relay"
        assert int(headers["Content-Length"]) == len(body), "recovered body must match the advertised length"
        assert resolutions["count"] == before_recovery + 1, "expired source must be resolved once"

        # Persistent upstream failures have a bounded retry count, invalidate
        # the unusable address, and never append JSON to an open media body.
        server.previews.cache.drop(cache_key)
        entry = server.previews._entry(server.previews.source_for(VIDEO_ID, generation))
        entry.total_bytes = len(PAYLOAD)
        server.previews.cache.store(cache_key, entry, 0, prefix)
        before_failure = resolutions["count"]
        state["rejectRemaining"] = 20
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        connection.request("GET", media_path, headers={"Cookie": cookie, "Range": "bytes=0-262143",
                                                       "Origin": "http://localhost:3000"})
        response = connection.getresponse()
        try:
            response.read()
            raise AssertionError("persistent upstream failure must terminate the incomplete range")
        except http.client.IncompleteRead as error:
            assert error.partial == prefix, "API error bytes were appended to the MP4 body"
        finally:
            connection.close()
            state["rejectRemaining"] = 0
        assert resolutions["count"] == before_failure + preview_module.MAX_PLAY_RECOVERIES
        assert server.previews.status(VIDEO_ID)["status"] == "error", "failed source stayed reusable"
        fixture_resolve(server.previews, server.database.get_video(VIDEO_ID))

        # A refreshed address for a different encoding must restart the player,
        # never splice new bytes into an already-advertised resource version.
        source = server.previews.source_for(VIDEO_ID, generation)
        source.url = media_url.replace("/media.mp4", "/expired.mp4")
        server.previews.cache.drop(cache_key)
        entry = server.previews._entry(source)
        entry.total_bytes = len(PAYLOAD)
        server.previews.cache.store(cache_key, entry, 0, prefix)

        def changed_resolve(video, *, check_cancelled=None):
            changed = replace(source, generation="f" * 32, fingerprint="changed-encoding", url=media_url)
            server.previews._sources[VIDEO_ID] = changed
            return changed

        with patch.object(server.previews, "_resolve", side_effect=changed_resolve):
            _, _, _, _, changed_body = server.previews.stream(VIDEO_ID, generation, 0, 262143)
            assert next(changed_body) == prefix
            try:
                next(changed_body)
                raise AssertionError("a replacement encoding must not continue the old byte range")
            except GenerationChanged:
                pass
            finally:
                changed_body.close()
        assert server.previews.status(VIDEO_ID)["generation"] == "f" * 32
        fixture_resolve(server.previews, server.database.get_video(VIDEO_ID))

        # A seek fills a later contiguous window over several upstream chunks.
        # Replaying it must return every cached block, including after block one.
        server.previews.cache.drop(server.previews._cache_key(VIDEO_ID, generation))
        server.previews.config = replace(config, preview_prefetch_max_bytes=256 * 1024)
        for _ in range(2):
            status, _, body = request(port, "GET", media_path, cookie=cookie, range_value="bytes=524288-1572863")
            assert status == 206 and body == PAYLOAD[524288:1572864], "seek window was truncated"
        server.previews.config = config

        # ---- range relay ----------------------------------------------------
        status, headers, body = request(port, "GET", media_path, cookie=cookie, range_value="bytes=100-199")
        assert status == 206 and body == PAYLOAD[100:200], (status, len(body))
        assert headers["Content-Range"] == f"bytes 100-199/{len(PAYLOAD)}"
        assert headers["Accept-Ranges"] == "bytes"
        assert headers["Content-Type"] == "video/mp4"
        assert headers["Cache-Control"] == "private, no-store"
        served_after_first = state["served"]
        # The same range must come from host memory instead of the CDN.
        status, headers, body = request(port, "GET", media_path, cookie=cookie, range_value="bytes=100-199")
        assert status == 206 and body == PAYLOAD[100:200]
        assert state["served"] == served_after_first, "a repeated range must reuse the host cache"

        status, _, body = request(port, "GET", media_path, cookie=cookie, range_value=f"bytes=-{256}")
        assert status == 206 and body == PAYLOAD[-256:]
        status, headers, body = request(port, "GET", media_path, cookie=cookie, range_value="bytes=0-")
        assert status == 206 and body == PAYLOAD, "an open-ended range streams the remainder"
        assert headers["Content-Range"] == f"bytes 0-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"
        status, headers, body = request(port, "GET", media_path, cookie=cookie, range_value=f"bytes={len(PAYLOAD)}-")
        assert status == 416 and not body and headers["Content-Range"] == f"bytes */{len(PAYLOAD)}"
        status, headers, body = request(port, "GET", media_path, cookie=cookie, range_value="bytes=500-100")
        assert status == 416
        assert request(port, "GET", media_path, cookie=cookie, range_value="bytes=1-2,4-5")[0] == 416
        status, headers, body = request(port, "HEAD", media_path, cookie=cookie)
        assert status == 200 and not body and headers["Content-Length"] == str(len(PAYLOAD))

        # ---- remote gateway ------------------------------------------------
        remote_port = gateway.server_address[1]
        assert request(remote_port, "GET", media_path, cookie=cookie)[0] == 403
        status, _, body = request(remote_port, "GET", media_path, cookie=cookie, range_value="bytes=10-19",
                                  origin="https://fixture.example")
        assert status == 206 and body == PAYLOAD[10:20]
        assert request(remote_port, "HEAD", media_path, cookie=cookie, origin="https://fixture.example")[0] == 200

        # ---- upstream that ignores Range -----------------------------------
        state["ignoreRange"] = True
        state["full"] = 0
        status, _, body = request(port, "GET", media_path, cookie=cookie, range_value="bytes=0-1023")
        assert status == 206 and body == PAYLOAD[0:1024], "a 200 answer must still be served as the requested slice"
        # A fresh source cannot be prewarmed when Range is unsupported.
        server.previews.cache.drop(server.previews._cache_key(VIDEO_ID, generation))
        state["served"] = 0
        received["bytes"] = 0
        try:
            server.previews.prewarm(server.previews.source_for(VIDEO_ID, generation))
            raise AssertionError("prewarm must stop when the source ignores Range")
        except Exception as error:
            assert "范围" in str(error), error
        assert received["bytes"] == 0, "unsupported Range must close before any speculative body read"
        state["ignoreRange"] = False

        # ---- bounded memory -------------------------------------------------
        diagnostics = server.previews.diagnostics()
        assert diagnostics["cachedBytes"] <= diagnostics["cacheLimitBytes"], diagnostics
        assert diagnostics["cachedBytes"] < len(PAYLOAD), "the cache never holds the whole file"
        # Repeating a full sweep must not grow the cache past its limit.
        for _ in range(3):
            request(port, "GET", media_path, cookie=cookie, range_value="bytes=0-")
        diagnostics = server.previews.diagnostics()
        assert diagnostics["cachedBytes"] <= diagnostics["cacheLimitBytes"], diagnostics

        # ---- retired media paths -------------------------------------------
        assert request(port, "GET", f"/api/media/{VIDEO_ID}", cookie=cookie)[0] == 404
        assert not (root / "media").exists(), "on-demand playback must not create a media directory"
        state_rows = server.database.state()
        assert all(video["mediaStatus"] == "online" for video in state_rows["videos"])
        connection = server.database.connect()
        try:
            tables = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            connection.close()
        assert "video_media" not in tables, "the retired download registry must be dropped"

        # ---- re-check shares the same bounded budget ------------------------
        capped = replace(config, preview_cache_bytes=1024 * 1024)
        assert capped.preview_cache_bytes == 1024 * 1024
        original_cap = server.previews.cache.max_bytes
        server.previews.cache.max_bytes = capped.preview_cache_bytes
        server.previews.cache.drop(server.previews._cache_key(VIDEO_ID, generation))
        _, _, _, _, stream = server.previews.stream(VIDEO_ID, generation, 0, None)
        streamed = bytearray()
        for chunk in stream:
            streamed.extend(chunk)
            assert server.previews.cache.used_bytes() <= capped.preview_cache_bytes, "active playback exceeded memory cap"
        assert bytes(streamed) == PAYLOAD, "memory eviction interrupted active playback"
        server.previews.cache.max_bytes = original_cap
    finally:
        gateway.shutdown()
        gateway.server_close()
        gateway_thread.join(timeout=5)
        server.shutdown()
        server.server_close()
        server.analysis.shutdown()
        thread.join(timeout=5)

media.shutdown()
print("Preview media passed: prepare/status, bounded prewarm, lazy expired-source recovery, bounded failures, "
      "encoding isolation, GET/HEAD/206/416 ranges, "
      "host cache reuse, gateway access control, Range-ignoring upstream, memory cap, retired media paths.")
