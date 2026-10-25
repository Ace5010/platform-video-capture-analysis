"""Checks target-source track identification and bounded startup reuse.

Builds two short real MP4s (H.264 and HEVC) and serves them from a local test
host, then verifies codec preferences (including a deliberately restricted
test configuration), real track metadata and reuse without whole downloads.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from host_service.config import HostConfig  # noqa: E402
from host_service.preview import PreviewError, PreviewManager, PreviewSource, _track_probe_limit  # noqa: E402
from host_service.browser import PreviewCandidate, PreviewResolution  # noqa: E402

FAILURES: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


front_header = (24).to_bytes(4, "big") + b"ftyp" + bytes(16) + (20_000).to_bytes(4, "big") + b"moov"
require(_track_probe_limit(front_header, 512 * 1024) == 64 * 1024,
        "a small front track table needs a small probe instead of a fixed half MiB")
require(_track_probe_limit(front_header, 10_000) == 10_000, "track sizing must preserve the small-work ratio ceiling")
extended_header = (1).to_bytes(4, "big") + b"moov" + (20_000).to_bytes(8, "big")
require(_track_probe_limit(extended_header, 512 * 1024) == 64 * 1024, "extended box sizes must be read")
require(_track_probe_limit(bytes(1024), 512 * 1024) == 512 * 1024,
        "unrecognized headers retain the bounded probe fallback")
require(_track_probe_limit(bytes(1024), 2 * 1024 * 1024) == 512 * 1024,
        "a larger track-table ceiling must not enlarge unidentified probes")
long_header = (28).to_bytes(4, "big") + b"ftyp" + bytes(20) + (814_043).to_bytes(4, "big") + b"moov"
require(_track_probe_limit(long_header, 2 * 1024 * 1024) == 13 * 64 * 1024,
        "a measured long-video track table must be read completely within the ceiling")
require(_track_probe_limit(long_header, 128 * 1024) == 128 * 1024,
        "long-video metadata still obeys the small-work ratio budget")


def build_media(path: Path, codec: str, duration: int = 12, *, audio: bool = True) -> None:
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
               "-f", "lavfi", "-i", f"testsrc=size=320x568:rate=25"]
    if audio:
        command += ["-f", "lavfi", "-i", "sine=frequency=440", "-c:a", "aac"]
    command += ["-t", str(duration), "-c:v", "libx264" if codec == "h264" else "libx265",
               "-pix_fmt", "yuv420p"]
    command += ["-movflags", "+faststart"]
    command += ["-y", str(path)]
    subprocess.run(command, check=True, timeout=180)


def pad_track_table(source: Path, destination: Path, table_size: int = 814_043) -> None:
    """Preserve a real clip with a track table larger than the old 512 KiB cap."""
    original = source.read_bytes()
    start = 0
    while original[start + 4:start + 8] != b"moov":
        start += int.from_bytes(original[start:start + 4], "big")
    size = int.from_bytes(original[start:start + 4], "big")
    table = bytearray(original[start:start + size])
    padding = table_size - size
    for kind, width in ((b"stco", 4), (b"co64", 8)):
        cursor = 0
        while (cursor := table.find(kind, cursor)) >= 0:
            count = int.from_bytes(table[cursor + 8:cursor + 12], "big")
            for index in range(count):
                offset = cursor + 12 + index * width
                value = int.from_bytes(table[offset:offset + width], "big")
                table[offset:offset + width] = (value + padding).to_bytes(width, "big")
            cursor += 4
    table[:4] = (size + padding).to_bytes(4, "big")
    table = table[:8] + padding.to_bytes(4, "big") + b"free" + bytes(padding - 8) + table[8:]
    # Trailing padding keeps the metadata read below the same 20% ceiling.
    trailer_size = max(4 * 1024 * 1024, table_size * 5)
    trailer = trailer_size.to_bytes(4, "big") + b"free" + bytes(trailer_size - 8)
    destination.write_bytes(original[:start] + table + original[start + size:] + trailer)


class Served:
    def __init__(self, files: dict[str, Path]) -> None:
        self.files = files
        self.requests: list[tuple[str, int]] = []
        self.header_delays: dict[str, float] = {}
        self.body_delays: dict[str, float] = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: Any) -> None:
                return

            def _send(self, body: bool) -> None:
                key = self.path.strip("/").split("?")[0]
                path = outer.files.get(key)
                if path is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                time.sleep(outer.header_delays.get(key, 0))
                payload = path.read_bytes()
                size = len(payload)
                start, end = 0, size - 1
                raw_range = self.headers.get("Range")
                if raw_range:
                    parsed = raw_range.strip().removeprefix("bytes=").split("-", 1)
                    if parsed[0]:
                        start = int(parsed[0])
                        end = int(parsed[1]) if len(parsed) > 1 and parsed[1] else size - 1
                    else:
                        start = max(0, size - int(parsed[1]))
                    end = min(end, size - 1)
                outer.requests.append((key, end - start + 1))
                chunk = payload[start:end + 1]
                self.send_response(206 if raw_range else 200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(chunk)))
                if raw_range:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if body:
                    time.sleep(outer.body_delays.get(key, 0))
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass  # The bounded probe deliberately abandons stalled responses.

            def do_GET(self) -> None:  # noqa: N802
                self._send(body=True)

            def do_HEAD(self) -> None:  # noqa: N802
                self._send(body=False)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, key: str) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/{key}"


with tempfile.TemporaryDirectory(prefix="douyin-preview-codec-") as temporary:
    root = Path(temporary)
    h264 = root / "h264.mp4"
    hevc = root / "hevc.mp4"
    video_only = root / "video-only.mp4"
    long_header_clip = root / "long-header.mp4"
    build_media(h264, "h264")
    build_media(hevc, "hevc")
    build_media(video_only, "hevc", audio=False)
    pad_track_table(h264, long_header_clip)
    served = Served({"h264.mp4": h264, "hevc.mp4": hevc, "video-only.mp4": video_only,
                     "long-header.mp4": long_header_clip, "slow.mp4": hevc})

    import host_service.preview as preview_module

    real_read = preview_module.read_upstream_range
    real_allowed = preview_module._host_allowed

    def local_read(url, start, length, *, testing=False, **kwargs):
        preview_module._host_allowed = lambda value, testing=False: value == url or real_allowed(value, testing=testing)
        try:
            return real_read(url, start, length, testing=True, **kwargs)
        finally:
            preview_module._host_allowed = real_allowed

    preview_module.read_upstream_range = local_read

    base = HostConfig.from_env()
    config = replace(base, data_dir=root, db_path=root / "m.sqlite3", secret_path=root / "s.dpapi",
                     temp_dir=root / "tmp", backup_dir=root / "b", testing=True,
                     preview_playable_codecs=("h264",))

    class FakeDatabase:
        def get_video(self, video_id):
            return {"id": video_id, "url": f"https://www.douyin.com/video/{video_id}"}

    class FakeBrowser:
        def __init__(self, resolution: PreviewResolution) -> None:
            self.resolution = resolution

        def resolve_preview(self, video_id, video_url, *, timeout=None, check_cancelled=None):
            return self.resolution

    def candidates(*specs):
        return [PreviewCandidate(url=served.url(key), metadata=metadata) for key, metadata in specs]

    def manager(browser) -> PreviewManager:
        return PreviewManager(config, FakeDatabase(), browser)

    long_resolution = PreviewResolution(candidate=candidates(("long-header.mp4", {}))[0])
    instance = manager(FakeBrowser(long_resolution))
    served.requests.clear()
    try:
        with patch.object(instance, "config", replace(config, preview_probe_bytes=512 * 1024)):
            try:
                instance._resolve({"id": "7000000000000000009"})
                require(False, "the old cap must reproduce truncated track-table rejection")
            except PreviewError:
                pass
        served.requests.clear()
        source = instance._resolve({"id": "7000000000000000009"})
        require(source.codec == "h264" and source.audio_codec == "aac",
                "the complete bounded long-video header must identify both real tracks")
        probed = sum(size for _, size in served.requests)
        require(512 * 1024 < probed <= 2 * 1024 * 1024,
                "only measured long metadata may exceed the old cap")
        require(probed <= long_header_clip.stat().st_size * config.preview_prefetch_max_ratio,
                "long-video header verification must retain the 20% ratio cap")
    finally:
        instance.shutdown()

    # Longer works can legitimately have a front track table beyond 2 MiB.
    # Read its measured size within the existing 4 MiB / 20% limits.
    large_table_clip = root / "large-table.mp4"
    pad_track_table(h264, large_table_clip, table_size=3 * 1024 * 1024)
    served.files["large-table.mp4"] = large_table_clip
    instance = manager(FakeBrowser(PreviewResolution(candidate=candidates(("large-table.mp4", {}))[0])))
    try:
        with patch.object(instance, "config", replace(config, preview_probe_bytes=2 * 1024 * 1024)):
            try:
                instance._resolve({"id": "7000000000000000011"})
                require(False, "a 2 MiB ceiling must reproduce truncated long-video metadata")
            except PreviewError:
                pass
        instance.config = replace(config, preview_probe_bytes=base.preview_probe_bytes)
        served.requests.clear()
        source = instance._resolve({"id": "7000000000000000011"})
        require(source.codec == "h264" and source.audio_codec == "aac", "default limits must identify a long video's full track table")
        require(sum(size for _, size in served.requests) <= 4 * 1024 * 1024, "long metadata reads must remain bounded")
    finally:
        instance.shutdown()

    # 1. The explicitly H.264-only test configuration skips HEVC preferences.
    served.requests.clear()
    resolution = PreviewResolution(
        candidate=candidates(("hevc.mp4", {"width": 320, "height": 568, "bitrate": 200_000}))[0],
        alternatives=candidates(("h264.mp4", {"width": 320, "height": 568, "bitrate": 300_000})),
    )
    instance = manager(FakeBrowser(resolution))
    try:
        source = instance._resolve({"id": "7000000000000000001", "url": "https://www.douyin.com/video/1"})
        require(source.url == served.url("h264.mp4"), f"an unplayable codec must be skipped, got {source.url}")
        require(source.codec == "h264", f"the real codec must be recorded, got {source.codec}")
        require(source.width == 320 and source.height == 568, "the measured size must be kept")
        original = h264.stat().st_size
        probed = sum(size for _, size in served.requests)
        require(probed <= (config.preview_probe_bytes + config.preview_prefetch_initial_bytes) * 3,
                f"verification must stay bounded, read {probed} bytes")
        require(probed < original * 4, "verification must not download the whole work")
    finally:
        instance.shutdown()

    # The real dashboard's default must select a compatible audiovisual source
    # even when the smaller first candidate is HEVC (accepted as audio-only by
    # some normal Windows Chrome installations).
    served.requests.clear()
    instance = manager(FakeBrowser(resolution))
    instance.config = replace(config, preview_playable_codecs=base.preview_playable_codecs)
    try:
        source = instance._resolve({"id": "7000000000000000010"})
        require(source.codec == "h264" and source.audio_codec == "aac",
                "the default browser source must prefer H.264 over a lower-bitrate HEVC rendition")
    finally:
        instance.shutdown()

    # An explicitly HEVC-capable preference still uses the smallest HEVC source
    # and reuses its verified prefix without another upstream download.
    served.requests.clear()
    resolution.candidate.metadata["contentLength"] = hevc.stat().st_size
    instance = manager(FakeBrowser(resolution))
    instance.config = replace(config, preview_playable_codecs=("h264", "hevc"))
    try:
        source = instance._resolve({"id": "7000000000000000005", "url": "https://www.douyin.com/video/5"})
        require(source.codec == "hevc", "a published HEVC source must not trigger a scan of larger variants")
        require(all(key == "hevc.mp4" for key, _ in served.requests), "only the selected low source needs probing")
        require(len(served.requests) == 1, "known-size startup track verification should use one upstream round trip")
        prefix_size = sum(size for _, size in served.requests)
        before_playback = len(served.requests)
        _, _, _, _, body = instance.stream(source.video_id, source.generation, 0, None)
        try:
            require(next(body) == hevc.read_bytes()[:prefix_size], "the validated prefix must be reusable for playback")
            require(len(served.requests) == before_playback, "playback must not download the probe prefix again")
        finally:
            body.close()
    finally:
        instance.shutdown()

    # 2. A codec outside the test preference is still offered for the viewer's
    # actual decoder. No candidate is invented and nothing is transcoded.
    served.requests.clear()
    hevc_only = PreviewResolution(
        candidate=candidates(("hevc.mp4", {"width": 320, "height": 568}))[0], alternatives=[])
    instance = manager(FakeBrowser(hevc_only))
    try:
        source = instance._resolve({"id": "7000000000000000002", "url": "https://www.douyin.com/video/2"})
        require(source.codec == "hevc", f"the real codec must be reported, got {source.codec}")
        require(source.codec_unverified is True, "an unconfirmed codec must be marked unverified")
        require(instance.status("7000000000000000002")["codecUnverified"] is True,
                "the status read must expose the unverified codec")
        require(source.width == 320 and source.height == 568, "the measured size must be kept")
    finally:
        instance.shutdown()

    # 2b. Nothing readable at all: report the failure instead of a fake source.
    empty = PreviewResolution(candidate=PreviewCandidate(url=served.url("missing.mp4"),
                                                         metadata={"width": 320, "height": 568}), alternatives=[])
    instance = manager(FakeBrowser(empty))
    try:
        try:
            instance._resolve({"id": "7000000000000000004", "url": "https://www.douyin.com/video/4"})
            require(False, "an unreadable source must not be offered")
        except PreviewError as error:
            require("候选" in str(error) or "读取" in str(error), f"the limit must be explained: {error}")
    finally:
        instance.shutdown()

    # 3. A decodable first candidate is used directly.
    served.requests.clear()
    good = PreviewResolution(
        candidate=candidates(("h264.mp4", {"width": 320, "height": 568}))[0],
        alternatives=[], played=candidates(("hevc.mp4", {"width": 1080, "height": 1920})))
    instance = manager(FakeBrowser(good))
    try:
        source = instance._resolve({"id": "7000000000000000003", "url": "https://www.douyin.com/video/3"})
        require(source.url == served.url("h264.mp4"), "a decodable candidate must be used")
        require(all(key == "h264.mp4" for key, _ in served.requests),
                "the page's larger source must not override the selected preview")
        require(sum(size for _, size in served.requests) <= h264.stat().st_size * config.preview_prefetch_max_ratio,
                "codec verification must not prefetch a complete small work")
    finally:
        instance.shutdown()

    video_only_first = PreviewResolution(
        candidate=candidates(("video-only.mp4", {"contentLength": video_only.stat().st_size}))[0],
        alternatives=candidates(("hevc.mp4", {"contentLength": hevc.stat().st_size})))
    instance = manager(FakeBrowser(video_only_first))
    try:
        source = instance._resolve({"id": "7000000000000000007", "url": "https://www.douyin.com/video/7"})
        require(source.url == served.url("hevc.mp4"), "a video-only rendition cannot silently replace an audiovisual source")
        require(source.public()["audioCodec"] == "aac", "the chosen source must have a verified audio track")
        require(source.public()["probeAttempts"][0]["reason"] == "该候选只有画面，没有声音轨道",
                "startup diagnostics must distinguish silent tracks from an unreadable or timed-out source")
    finally:
        instance.shutdown()
    instance = manager(FakeBrowser(PreviewResolution(candidate=video_only_first.candidate)))
    try:
        try:
            instance._resolve({"id": "7000000000000000008", "url": "https://www.douyin.com/video/8"})
            require(False, "a video-only source must not be reported as fully playable")
        except PreviewError:
            pass
        with patch.object(instance, "_resolve", side_effect=PreviewError(
                "候选源缺少音轨 https://cdn.example/video.mp4?signature=private-value")):
            instance._run_task("7000000000000000008", {"id": "7000000000000000008"})
        failed = instance.status("7000000000000000008")
        require(failed["status"] == "error" and "缺少音轨" in failed["message"],
                "asynchronous source failures must retain their actual diagnosis")
        require("cdn.example" not in failed["message"] and "private-value" not in failed["message"],
                "source failure diagnostics must still redact signed addresses")
    finally:
        instance.shutdown()

    # A target-bound alternate is tried promptly when the first CDN address
    # stalls, both before headers and while returning the bounded body.
    require(preview_module.PROBE_TIMEOUT_SECONDS < preview_module.UPSTREAM_TIMEOUT_SECONDS,
            "startup verification must not inherit the continuous playback timeout")
    original_probe_timeout = preview_module.PROBE_TIMEOUT_SECONDS
    preview_module.PROBE_TIMEOUT_SECONDS = 0.25
    try:
        for delays in (served.header_delays, served.body_delays):
            delays["slow.mp4"] = 0.7
            slow = PreviewResolution(
                candidate=candidates(("slow.mp4", {"contentLength": hevc.stat().st_size}))[0],
                alternatives=candidates(("h264.mp4", {"contentLength": h264.stat().st_size})))
            instance = manager(FakeBrowser(slow))
            try:
                source = instance._resolve({"id": "7000000000000000006", "url": "https://www.douyin.com/video/6"})
                require(source.url == served.url("h264.mp4"), "stalled candidates must yield to an existing alternate")
                attempts = source.public()["probeAttempts"]
                require(attempts[0]["stage"] == "range" and attempts[0]["elapsedMs"] < 650,
                        "slow range headers/body must stop at the startup deadline")
                require(attempts[-1]["outcome"] == "verified", "the alternate must still pass real track verification")
                require("http" not in json.dumps(attempts), "diagnostics must not expose signed media addresses")
            finally:
                instance.shutdown()
                delays.clear()
    finally:
        preview_module.PROBE_TIMEOUT_SECONDS = original_probe_timeout

    served.server.shutdown()

if FAILURES:
    print("Preview codec verification failed:")
    for failure in FAILURES:
        print(f" - {failure}")
    raise SystemExit(1)
print("Preview codec verification passed: codec preferences, real track metadata, "
      "bounded adaptive prefix, HEVC selection and immediate startup reuse.")
