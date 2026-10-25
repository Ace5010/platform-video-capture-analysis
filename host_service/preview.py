"""On-demand low-resolution playback: bounded memory prewarm plus range relay.

Nothing here writes media to disk, writes signed CDN addresses to logs or the
database, or starts a paid analysis task. The host keeps a small, capped,
in-memory copy of the bytes it has already relayed so a subsequent range from
the same player can be answered without asking the CDN twice.
"""

from __future__ import annotations

import http.client
import ipaddress
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .browser import PreviewCandidate
from .config import HostConfig
from .media import probe_media_bytes
from .recovery import safe_error

# Only these public media hosts may be relayed. Every redirect hop is rechecked.
MEDIA_HOST_SUFFIXES = (
    "douyinvod.com", "douyinstatic.com", "douyinpic.com",
    "zjcdn.com", "bytecdn.cn", "byteimg.com",
)
MAX_REDIRECTS = 3
CHUNK_BYTES = 64 * 1024
UPSTREAM_TIMEOUT_SECONDS = 20
# Startup reads are tiny. A stalled CDN candidate must not hold the whole
# preview behind the longer timeout used for continuous playback.
PROBE_TIMEOUT_SECONDS = 5
# A resolved resource is re-resolved after this long even without an error, so a
# long-open page cannot keep using an expired signed address.
STALE_GENERATION_SECONDS = 6 * 60 * 60
MAX_PLAY_RECOVERIES = 2


class PreviewError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


class UpstreamRangeUnsupported(PreviewError):
    def __init__(self, message: str = "上游媒体源不支持按范围读取") -> None:
        super().__init__(message, 502)


class GenerationChanged(PreviewError):
    def __init__(self, message: str = "播放源版本已更新，请重新开始播放") -> None:
        super().__init__(message, 409)


def _host_allowed(url: str, *, testing: bool = False) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parsed.username or parsed.password:
        return False
    hostname = (parsed.hostname or "").lower()
    if not hostname or parsed.port not in (None, 443, 80) and not testing:
        return False
    address = None
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        pass
    if address is not None:
        if address.is_private or address.is_loopback:
            # Only an isolated test may serve a verified object from a local
            # fixture host; a production relay never reaches a private address.
            return bool(testing and address.is_loopback and parsed.scheme in ("http", "https"))
        return False
    if parsed.scheme != "https":
        return False
    return any(hostname == suffix or hostname.endswith(f".{suffix}") for suffix in MEDIA_HOST_SUFFIXES)


class _ValidatedRedirects(urllib.request.HTTPRedirectHandler):
    """Follows redirects so every hop is validated before it is used."""

    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        if not _host_allowed(newurl):
            raise PreviewError("媒体源跳转到了不允许的地址", 502)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def allowed_media_url(url: str, *, testing: bool = False) -> bool:
    return _host_allowed(url, testing=testing)


def _open_url(url: str, byte_range: str | None = None, *, timeout: float = UPSTREAM_TIMEOUT_SECONDS):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Referer": "https://www.douyin.com/",
    }
    if byte_range:
        headers["Range"] = byte_range
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        return urllib.request.build_opener(_ValidatedRedirects).open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        raise PreviewError(f"媒体源返回了 {status}", 502) from None
    except (urllib.error.URLError, OSError):
        # Never include the signed request address or exception text.
        raise PreviewError("媒体源连接失败", 502) from None


def _total_from_content_range(value: str) -> int | None:
    tail = value.rsplit("/", 1)[-1].strip() if value else ""
    return int(tail) if tail.isdigit() else None


def _start_from_content_range(value: str) -> int | None:
    try:
        return int(value.split(" ", 1)[1].split("/", 1)[0].split("-", 1)[0])
    except (IndexError, ValueError):
        return None


def _track_probe_limit(header: bytes, budget: int) -> int:
    """Size the prefix around a front-loaded MP4 track table when present.

    A fixed large prefix spends bandwidth identifying tracks whose moov box is
    already near the front. Retain a small amount of following media for probe
    compatibility, and always stay below the existing per-source ceiling.
    """
    cursor = 0
    while cursor + 8 <= len(header):
        size = int.from_bytes(header[cursor:cursor + 4], "big")
        box_type = header[cursor + 4:cursor + 8]
        header_size = 8
        if size == 1:
            if cursor + 16 > len(header):
                break
            size = int.from_bytes(header[cursor + 8:cursor + 16], "big")
            header_size = 16
        if size < header_size:
            break
        if box_type == b"moov":
            desired = cursor + size + 32 * 1024
            return min(budget, max(len(header), ((desired + CHUNK_BYTES - 1) // CHUNK_BYTES) * CHUNK_BYTES))
        cursor += size
    # Only a measured track table needs the larger ceiling. Unknown headers
    # keep the previous small fallback rather than growing all startup reads.
    return min(budget, 512 * 1024)


def _header(response: Any, name: str) -> str:
    try:
        return str(response.headers.get(name) or "")
    except (AttributeError, ValueError):
        return ""


def read_upstream_range(url: str, start: int, length: int, *, testing: bool = False,
                        timeout: float = UPSTREAM_TIMEOUT_SECONDS
                        ) -> tuple[Iterator[bytes], dict[str, Any]]:
    """Open one bounded upstream range and return positioned bytes plus facts.

    ``length`` caps how many bytes this call may read, so a server that ignores
    ``Range`` and answers ``200`` can only ever deliver the bounded slice that
    was asked for instead of the complete file.
    """
    if not _host_allowed(url, testing=testing):
        raise PreviewError("媒体源地址不在允许的范围内", 502)
    if length <= 0:
        raise PreviewError("请求范围无效", 416)
    wanted_end = start + length - 1
    response = _open_url(url, f"bytes={start}-{wanted_end}", timeout=timeout)
    status = int(getattr(response, "status", 200))
    info: dict[str, Any] = {
        "status": status,
        "totalBytes": None,
        "acceptRanges": _header(response, "Accept-Ranges").lower(),
        "etag": _header(response, "ETag") or None,
        "close": response.close,
    }
    skip = start
    if status == 206:
        content_range = _header(response, "Content-Range")
        info["totalBytes"] = _total_from_content_range(content_range)
        upstream_start = _start_from_content_range(content_range)
        if upstream_start is not None:
            skip = max(0, start - upstream_start)
    elif status == 200:
        # Range ignored: the body starts at byte 0, so skip to the offset we
        # actually need while never reading past this call's byte limit.
        length_header = _header(response, "Content-Length")
        if length_header.isdigit():
            info["totalBytes"] = int(length_header)
    elif status == 416:
        response.close()
        raise UpstreamRangeUnsupported("媒体源拒绝了该读取范围")
    else:
        response.close()
        raise PreviewError(f"媒体源返回了 {status}", 502)

    remaining = length

    def iterate() -> Iterator[bytes]:
        nonlocal remaining, skip
        try:
            while remaining > 0:
                chunk = response.read(min(CHUNK_BYTES, remaining + skip))
                if not chunk:
                    return
                if skip:
                    consumed = min(skip, len(chunk))
                    skip -= consumed
                    chunk = chunk[consumed:]
                    if not chunk:
                        continue
                remaining -= len(chunk)
                yield chunk
        except (OSError, http.client.HTTPException):
            raise PreviewError("媒体源传输中断", 502) from None
        finally:
            response.close()

    return iterate(), info


@dataclass
class _CacheEntry:
    """One encoded resource version, with the bytes already relayed for it.

    ``buffer`` is the contiguous prefix from byte 0 (the startup prewarm and
    ordinary sequential playback), capped at 2 MiB. ``tail`` keeps the most
    recent 2 MiB of playback; ``suffix`` preserves up to 64 KiB of already-read
    end metadata. Bytes are never merged
    across the gap, so a byte-range answer can never splice two parts of the
    resource that were not verified to be adjacent.
    """

    url: str
    fingerprint: str
    buffer: bytearray = field(default_factory=bytearray)
    tail: bytearray = field(default_factory=bytearray)
    tail_start: int = 0
    suffix: bytearray = field(default_factory=bytearray)
    prefix_limit: int = 2 * 1024 * 1024
    tail_limit: int = 2 * 1024 * 1024
    total_bytes: int | None = None
    last_used: float = field(default_factory=time.monotonic)
    upstream_supports_range: bool | None = None
    etag: str | None = None

    def add(self, start: int, data: bytes) -> None:
        if not data or start < 0:
            return
        end = start + len(data)
        # Verify every overlap before changing any retained window.
        for begin, existing in ((0, self.buffer), (self.tail_start, self.tail),
                                ((self.total_bytes or 0) - len(self.suffix), self.suffix)):
            overlap_start = max(begin, start)
            overlap_end = min(begin + len(existing), end)
            if overlap_end > overlap_start and data[overlap_start - start:overlap_end - start] \
                    != existing[overlap_start - begin:overlap_end - begin]:
                raise GenerationChanged()
        # Chrome sometimes asks for a small end range during startup. Preserve
        # that already-read metadata separately so seeking does not evict it.
        if self.total_bytes and end == self.total_bytes:
            ending = data[-CHUNK_BYTES:]
            if len(ending) > len(self.suffix):
                self.suffix = bytearray(ending)
        if start <= len(self.buffer) and start < self.prefix_limit:
            amount = min(len(data), self.prefix_limit - start)
            overlap = min(amount, len(self.buffer) - start)
            self.buffer.extend(data[overlap:amount])
            start += amount
            data = data[amount:]
            self._absorb_tail()
            if not data:
                return
        if not self.tail:
            self.tail, self.tail_start = bytearray(data), start
        elif start < self.tail_start:
            self.tail, self.tail_start = bytearray(data), start
        elif start > self.tail_start + len(self.tail):
            # A second gap: replace the previous one instead of pretending the
            # two belong to the same continuous region.
            self.tail, self.tail_start = bytearray(data), start
        else:
            offset = start - self.tail_start
            overlap = min(len(data), max(0, len(self.tail) - offset))
            self.tail.extend(data[overlap:])
        self._absorb_tail()
        excess = len(self.tail) - self.tail_limit
        if excess > 0:
            del self.tail[:excess]
            self.tail_start += excess

    def _absorb_tail(self) -> None:
        """Fold a tail that has become adjacent to the prefix back into it."""
        if self.tail and self.tail_start <= len(self.buffer) < self.tail_start + len(self.tail):
            offset = len(self.buffer) - self.tail_start
            amount = min(len(self.tail) - offset, max(0, self.prefix_limit - len(self.buffer)))
            self.buffer.extend(self.tail[offset:offset + amount])
            del self.tail[:offset + amount]
            self.tail_start += offset + amount

    def slice(self, start: int, stop: int) -> bytes | None:
        if start < 0 or stop < start:
            return None
        if stop <= len(self.buffer):
            return bytes(self.buffer[start:stop])
        if self.tail and start >= self.tail_start and stop <= self.tail_start + len(self.tail):
            return bytes(self.tail[start - self.tail_start:stop - self.tail_start])
        suffix_start = (self.total_bytes or 0) - len(self.suffix)
        if self.suffix and start >= suffix_start and stop <= self.total_bytes:
            return bytes(self.suffix[start - suffix_start:stop - suffix_start])
        return None

    def covers(self, start: int, end: int) -> bool:
        if end < start:
            return False
        if end < len(self.buffer):
            return True
        return (bool(self.tail) and start >= self.tail_start and end < self.tail_start + len(self.tail)) \
            or (bool(self.suffix) and start >= (self.total_bytes or 0) - len(self.suffix) and end < self.total_bytes)

    def stored_bytes(self) -> int:
        return len(self.buffer) + len(self.tail) + len(self.suffix)

    def known_ranges(self) -> list[tuple[int, int]]:
        ranges = []
        if self.buffer:
            ranges.append((0, len(self.buffer)))
        if self.tail:
            ranges.append((self.tail_start, self.tail_start + len(self.tail)))
        if self.suffix:
            ranges.append((self.total_bytes - len(self.suffix), self.total_bytes))
        return sorted(ranges)


class PreviewCache:
    """Process-memory byte cache with a hard global cap and idle eviction."""

    def __init__(self, *, max_bytes: int, idle_seconds: int) -> None:
        self.max_bytes = max(1024 * 1024, int(max_bytes))
        self.idle_seconds = max(1, int(idle_seconds))
        self._lock = threading.Lock()
        self._entries: dict[str, _CacheEntry] = {}
        self._pinned: dict[str, int] = {}

    def create(self, key: str, url: str, fingerprint: str) -> _CacheEntry:
        with self._lock:
            entry = _CacheEntry(url=url, fingerprint=fingerprint)
            self._entries[key] = entry
            self._evict_locked()
            return entry

    def entry(self, key: str) -> _CacheEntry | None:
        with self._lock:
            self._evict_locked()
            entry = self._entries.get(key)
            if entry is not None:
                entry.last_used = time.monotonic()
            return entry

    def keep(self, key: str, entry: _CacheEntry) -> bool:
        with self._lock:
            return self._entries.get(key) is entry

    def store(self, key: str, entry: _CacheEntry, start: int, data: bytes) -> None:
        with self._lock:
            if self._entries.get(key) is not entry:
                return
            entry.add(start, data)
            entry.last_used = time.monotonic()
            self._evict_locked()

    def pin(self, key: str) -> None:
        with self._lock:
            self._pinned[key] = self._pinned.get(key, 0) + 1

    def unpin(self, key: str) -> None:
        with self._lock:
            remaining = self._pinned.get(key, 0) - 1
            if remaining > 0:
                self._pinned[key] = remaining
            else:
                self._pinned.pop(key, None)

    def drop(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)

    def used_bytes(self) -> int:
        with self._lock:
            self._evict_locked()
            return sum(entry.stored_bytes() for entry in self._entries.values())

    def entry_count(self) -> int:
        with self._lock:
            return len(self._entries)

    def _evict_locked(self) -> None:
        now = time.monotonic()
        for key, entry in list(self._entries.items()):
            if self._pinned.get(key):
                continue
            if entry.stored_bytes() and now - entry.last_used > self.idle_seconds:
                self._entries.pop(key, None)
        while sum(entry.stored_bytes() for entry in self._entries.values()) > self.max_bytes:
            candidates = [(entry.last_used, key) for key, entry in self._entries.items()
                          if not self._pinned.get(key) and entry.stored_bytes()]
            if not candidates:
                # Active streams already hold their outgoing byte chunks. Drop
                # cached copies rather than exempting all pinned entries from
                # the shared memory cap indefinitely.
                active = [entry for entry in self._entries.values() if entry.stored_bytes()]
                if not active:
                    return
                oldest = min(active, key=lambda entry: entry.last_used)
                oldest.buffer.clear()
                oldest.tail.clear()
                oldest.suffix.clear()
                continue
            _, oldest = min(candidates)
            self._entries.pop(oldest, None)


@dataclass
class PreviewSource:
    video_id: str
    generation: str
    url: str
    fingerprint: str
    width: int | None = None
    height: int | None = None
    bitrate: int | None = None
    content_length: int | None = None
    codec: str | None = None
    page_duration: float | None = None
    # True when the host could not confirm local decodability and the viewer's
    # own browser has to decide; the page must not promise playback then.
    codec_unverified: bool = False
    audio_codec: str | None = None
    resolve_duration_ms: int = 0
    probe_duration_ms: int = 0
    probe_attempts: list[dict[str, Any]] = field(default_factory=list)
    resolved_at: float = field(default_factory=time.monotonic)

    def public(self) -> dict[str, Any]:
        return {
            "generation": self.generation,
            "width": self.width,
            "height": self.height,
            "bitrate": self.bitrate,
            "codec": self.codec,
            "codecUnverified": self.codec_unverified,
            "audioCodec": self.audio_codec,
            "durationSeconds": self.page_duration,
            "resolveDurationMs": self.resolve_duration_ms,
            "probeDurationMs": self.probe_duration_ms,
            "probeAttempts": self.probe_attempts,
        }


class PreviewManager:
    """Single-flight source resolution, bounded prewarm and range relay."""

    def __init__(self, config: HostConfig, database, browser) -> None:
        self.config = config
        self.database = database
        self.browser = browser
        self.cache = PreviewCache(max_bytes=config.preview_cache_bytes,
                                  idle_seconds=config.preview_cache_idle_seconds)
        self._lock = threading.RLock()
        self._sources: dict[str, PreviewSource] = {}
        self._tasks: dict[str, dict[str, Any]] = {}
        self._errors: dict[str, str] = {}
        self._prefetch: "queue.LifoQueue[tuple[str, str]]" = queue.LifoQueue()
        self._stopping = threading.Event()
        self._worker = threading.Thread(target=self._prefetch_loop, name="preview-prewarm", daemon=True)
        self._worker.start()
        self.prefetch_started = 0
        self.prefetch_replaced = 0
        self.prefetch_failed = 0
        self.prefetch_bytes = 0

    # ---- source resolution -------------------------------------------------

    def _resolve(self, video: dict[str, Any], *, check_cancelled: Callable[[], None] | None = None) -> PreviewSource:
        video_id = str(video["id"])
        started = time.monotonic()
        resolution = self.browser.resolve_preview(
            video_id, str(video.get("url") or f"https://www.douyin.com/video/{video_id}"),
            timeout=self.config.preview_resolve_timeout_seconds, check_cancelled=check_cancelled,
        )
        # The platform does not publish a codec label and lists one entry per
        # variant, so several leading candidates are identified from their real
        # bytes before the best playable one is chosen. Keep the collector's
        # low-resolution preference ahead of the page's potentially larger source.
        ordered: list[Any] = []
        for candidate in [resolution.candidate, *resolution.alternatives, *resolution.played]:
            if candidate.url not in {item.url for item in ordered}:
                ordered.append(candidate)
        probe_started = time.monotonic()
        chosen, prefix, attempts = self._first_playable(ordered)
        metadata = chosen.metadata or {}
        fingerprint = chosen.fingerprint
        with self._lock:
            previous = self._sources.get(video_id)
            generation = previous.generation if previous and previous.fingerprint == fingerprint else uuid.uuid4().hex
            source = PreviewSource(
                video_id=video_id, generation=generation, url=chosen.url, fingerprint=fingerprint,
                width=metadata.get("width"), height=metadata.get("height"), bitrate=metadata.get("bitrate"),
                content_length=metadata.get("contentLength"), codec=metadata.get("codec"),
                page_duration=resolution.page.get("durationSeconds"),
                codec_unverified=metadata.get("codecUnverified") is True,
                audio_codec=metadata.get("audioCodec"),
                resolve_duration_ms=int((probe_started - started) * 1000),
                probe_duration_ms=int((time.monotonic() - probe_started) * 1000),
                probe_attempts=attempts,
            )
            self._sources[video_id] = source
            self._errors.pop(video_id, None)
        if not previous or previous.generation != generation:
            self.cache.drop(self._cache_key(video_id, generation))
        # The verified prefix already fetched for track identification is also
        # the beginning the browser needs. Keep only the chosen source's bytes
        # in the existing capped memory cache; do not fetch them a second time.
        entry = self._entry(source)
        entry.total_bytes = source.content_length
        entry.upstream_supports_range = True
        self.cache.store(self._cache_key(video_id, generation), entry, 0, prefix)
        return source

    def _first_playable(self, candidates: list[Any]) -> tuple[Any, bytes, list[dict[str, Any]]]:
        """Return the first readable preferred codec and its verified prefix.

        When the platform publishes nothing the preferred decoder set covers,
        the best-ranked candidate is used anyway: the viewer's own browser may
        support that codec even though it is outside the host preference set.
        The browser attempts the actual media track rather than a codec label.
        """
        if not candidates:
            raise PreviewError("没有取得经过目标校验的可用播放源", 404)
        errors: list[str] = []
        attempts: list[dict[str, Any]] = []
        identified: tuple[Any, bytes] | None = None
        for index, candidate in enumerate(candidates):
            if index >= self.config.preview_candidate_probe_limit:
                break
            attempt_started = time.monotonic()
            try:
                probe = self._identify_candidate(candidate)
                prefix = probe.pop("_previewPrefix")
                attempts.append({"index": index, "elapsedMs": int((time.monotonic() - attempt_started) * 1000),
                                 "rangeMs": probe.pop("_previewRangeMs"), "trackMs": probe.pop("_previewTrackMs"),
                                 "outcome": "verified"})
                if candidate.metadata.get("codec") in self.config.preview_playable_codecs:
                    return candidate, prefix, attempts
                if identified is None:
                    identified = candidate, prefix
                errors.append("候选编码不在默认支持范围内")
            except Exception as error:
                attempts.append({"index": index, "elapsedMs": int((time.monotonic() - attempt_started) * 1000),
                                 "stage": candidate.metadata.get("probeStage"), "outcome": type(error).__name__,
                                 "reason": safe_error(str(error))[:160],
                                 "containerFormat": safe_error(str(candidate.metadata.get("containerFormat") or ""))[:40]})
                errors.append(f"{type(error).__name__}: {error}"[:160])
        if identified:
            # Nothing passed the local decoder check; keep the first candidate
            # that at least yields a plausible container, and record why.
            candidate, prefix = identified
            candidate.metadata = {**candidate.metadata, "codecUnverified": True}
            return candidate, prefix, attempts
        raise PreviewError(
            "平台提供的候选源都无法读取，已尝试 "
            f"{min(len(candidates), self.config.preview_candidate_probe_limit)} 个候选；"
            f"最后原因：{errors[-1] if errors else '未知'}", 502)

    def _identify_candidate(self, candidate: Any) -> dict[str, Any]:
        """Read the leading bytes and identify the real tracks, codec unchecked."""
        started = time.monotonic()
        candidate.metadata = {**candidate.metadata, "probeStage": "range"}
        collected = self._read_candidate_prefix(candidate)
        range_ms = int((time.monotonic() - started) * 1000)
        candidate.metadata = {**candidate.metadata, "probeStage": "tracks"}
        track_started = time.monotonic()
        probe = probe_media_bytes(collected, timeout=PROBE_TIMEOUT_SECONDS)
        video_stream = next((stream for stream in probe.get("streams") or []
                             if stream.get("codec_type") == "video"), None)
        if video_stream is None:
            raise PreviewError("该候选不含视频流", 502)
        audio_stream = next((stream for stream in probe.get("streams") or []
                             if stream.get("codec_type") == "audio"), None)
        if audio_stream is None:
            raise PreviewError("该候选只有画面，没有声音轨道", 502)
        candidate.metadata = {
            **candidate.metadata,
            "codec": str(video_stream.get("codec_name") or "").lower() or None,
            "width": candidate.metadata.get("width") or video_stream.get("width"),
            "height": candidate.metadata.get("height") or video_stream.get("height"),
            "audioCodec": str(audio_stream.get("codec_name") or "").lower() or None,
        }
        return {**probe, "_previewPrefix": collected, "_previewRangeMs": range_ms,
                "_previewTrackMs": int((time.monotonic() - track_started) * 1000)}

    def _read_candidate_prefix(self, candidate: Any) -> bytes:
        # A platform-provided size allows the startup track table to be read in
        # one round trip. Unknown sizes still use the tiny discovery range.
        declared_size = candidate.metadata.get("contentLength")
        initial_size = 1024
        if isinstance(declared_size, (int, float)) and declared_size > 0:
            initial_size = max(1024, min(CHUNK_BYTES, self.config.preview_probe_bytes,
                                       int(declared_size * self.config.preview_prefetch_max_ratio)))
        chunks, info = read_upstream_range(candidate.url, 0, initial_size, testing=self.config.testing,
                                         timeout=PROBE_TIMEOUT_SECONDS)
        total = info.get("totalBytes")
        if info.get("status") != 206 or not total:
            info["close"]()
            raise UpstreamRangeUnsupported("媒体源不支持可验证的范围读取")
        limit = min(self.config.preview_probe_bytes, int(total * self.config.preview_prefetch_max_ratio))
        if limit < 1024:
            info["close"]()
            raise PreviewError("媒体源太小，无法在受限切片内验证编码", 502)
        if initial_size > limit:
            # A stale size must never enlarge the small-work read budget.
            info["close"]()
            chunks, info = read_upstream_range(candidate.url, 0, 1024, testing=self.config.testing,
                                             timeout=PROBE_TIMEOUT_SECONDS)
            if info.get("status") != 206 or info.get("totalBytes") != total:
                info["close"]()
                raise UpstreamRangeUnsupported("媒体源范围或长度发生变化")
        collected = bytearray(b"".join(chunks))
        candidate.metadata = {**candidate.metadata, "contentLength": total}
        limit = _track_probe_limit(bytes(collected), limit)
        if limit <= len(collected):
            return bytes(collected)
        chunks, remainder = read_upstream_range(candidate.url, len(collected), limit - len(collected), testing=self.config.testing,
                                              timeout=PROBE_TIMEOUT_SECONDS)
        if remainder.get("status") != 206 or remainder.get("totalBytes") != total:
            remainder["close"]()
            raise UpstreamRangeUnsupported("媒体源范围或长度发生变化")
        for chunk in chunks:
            collected.extend(chunk)
        if len(collected) < 1024:
            raise PreviewError("媒体源没有返回可播放的数据", 502)
        return bytes(collected)

    def prepare(self, video_ids: list[str]) -> list[dict[str, Any]]:
        results = []
        for video_id in video_ids:
            video = self.database.get_video(video_id)
            if not video:
                results.append({"videoId": video_id, "status": "error", "message": "作品记录不存在"})
                continue
            source = self._ready_source(video_id, allow_stale=False)
            if source is not None:
                self._enqueue_prefetch(video_id, source.generation)
                results.append({"videoId": video_id, "status": "ready", **source.public()})
                continue
            with self._lock:
                task = self._tasks.get(video_id)
                if task is not None:
                    results.append({"videoId": video_id, "status": "pending", "generation": task["generation"]})
                    continue
                task = {"generation": uuid.uuid4().hex, "started": time.monotonic()}
                self._tasks[video_id] = task
                self._errors.pop(video_id, None)
            # One resolution per request; polling never opens another page.
            threading.Thread(target=self._run_task, args=(video_id, video), name=f"preview-{video_id}",
                             daemon=True).start()
            results.append({"videoId": video_id, "status": "pending", "generation": task["generation"]})
        return results

    def _run_task(self, video_id: str, video: dict[str, Any]) -> None:
        try:
            source = self._resolve(video)
            self._enqueue_prefetch(video_id, source.generation)
        except Exception as error:  # never leaks signed values
            with self._lock:
                # PreviewError carries our own bounded source diagnosis. Keep
                # its sanitized detail rather than returning only the class.
                detail = str(error) if isinstance(error, PreviewError) else error
                self._errors[video_id] = safe_error(detail)[:300]
        finally:
            with self._lock:
                self._tasks.pop(video_id, None)

    def status(self, video_id: str) -> dict[str, Any]:
        with self._lock:
            task = self._tasks.get(video_id)
            error = self._errors.get(video_id)
        if task is not None:
            return {"videoId": video_id, "status": "pending", "generation": task["generation"],
                    "elapsedMs": int((time.monotonic() - task["started"]) * 1000)}
        source = self._ready_source(video_id, allow_stale=False)
        if source is not None:
            return {"videoId": video_id, "status": "ready", **source.public()}
        if error:
            return {"videoId": video_id, "status": "error", "message": error}
        return {"videoId": video_id, "status": "idle"}

    def _ready_source(self, video_id: str, *, allow_stale: bool) -> PreviewSource | None:
        with self._lock:
            source = self._sources.get(video_id)
        if source is None:
            return None
        if not allow_stale and time.monotonic() - source.resolved_at > STALE_GENERATION_SECONDS:
            return None
        return source

    def source_for(self, video_id: str, generation: str) -> PreviewSource | None:
        with self._lock:
            source = self._sources.get(video_id)
        if source is None or source.generation != generation:
            return None
        return source

    def refresh(self, video: dict[str, Any], generation: str) -> PreviewSource:
        """Resolve a bounded replacement source and prove it is the same resource."""
        replacement = self._resolve(video)
        if replacement.generation != generation:
            # A different encoding: restart playback rather than splicing two
            # resource versions into one response.
            raise GenerationChanged()
        return replacement

    def diagnostics(self) -> dict[str, Any]:
        return {
            "cachedBytes": self.cache.used_bytes(),
            "cacheLimitBytes": self.cache.max_bytes,
            "cachedEntries": self.cache.entry_count(),
            "resolvedSources": len(self._sources),
            "activeResolutions": len(self._tasks),
            "prefetchStarted": self.prefetch_started,
            "prefetchReplaced": self.prefetch_replaced,
            "prefetchFailed": self.prefetch_failed,
            "prefetchBytes": self.prefetch_bytes,
        }

    # ---- bounded prewarm ---------------------------------------------------

    def _cache_key(self, video_id: str, generation: str) -> str:
        return f"{video_id}|{self.config.preview_purpose}|{generation}"

    def _entry(self, source: PreviewSource) -> _CacheEntry:
        key = self._cache_key(source.video_id, source.generation)
        entry = self.cache.entry(key)
        if entry is None or entry.fingerprint != source.fingerprint:
            entry = self.cache.create(key, source.url, source.fingerprint)
        else:
            entry.url = source.url
        return entry

    def _enqueue_prefetch(self, video_id: str, generation: str) -> None:
        # Only the most recently requested candidate stays queued; the single
        # worker serialises speculative reads so playback always wins.
        while True:
            try:
                self._prefetch.get_nowait()
                self.prefetch_replaced += 1
            except queue.Empty:
                break
        self._prefetch.put((video_id, generation))

    def _prefetch_loop(self) -> None:
        while not self._stopping.is_set():
            try:
                video_id, generation = self._prefetch.get(timeout=1)
            except queue.Empty:
                continue
            try:
                source = self.source_for(video_id, generation)
                if source is None:
                    continue
                self.prefetch_started += 1
                self.prefetch_bytes += self.prewarm(source)
            except Exception:
                self.prefetch_failed += 1

    def prewarm(self, source: PreviewSource) -> int:
        """Read a bounded prefix so the first player request is served locally."""
        entry = self._entry(source)
        key = self._cache_key(source.video_id, source.generation)
        stored = len(entry.buffer)
        initially_stored = stored
        target_seconds = max(1, self.config.preview_prefetch_seconds)
        min_stop = max(1, self.config.preview_prefetch_initial_bytes)

        def planned_budget() -> int:
            budget = max(0, self.config.preview_prefetch_max_bytes)
            if entry.total_bytes:
                # Speculation stays clearly below the whole file, so a short
                # work is never fetched end to end merely because it is small.
                budget = min(budget, max(0, int(entry.total_bytes * self.config.preview_prefetch_max_ratio)))
            # The speculative budget is a ceiling for this resource, not an
            # allowance per request: bytes already relayed for the player are
            # kept, but speculation never adds on top of them.
            return max(0, min(entry.prefix_limit, budget - len(entry.tail) - len(entry.suffix)))

        def enough_to_start() -> bool:
            if stored < min_stop or not entry.total_bytes:
                return False
            return bool((source.bitrate and stored / max(1, source.bitrate / 8) >= target_seconds)
                        or stored * 5 >= entry.total_bytes)

        while stored < planned_budget() and not enough_to_start():
            request_bytes = min(self.config.preview_prefetch_initial_bytes, planned_budget() - stored)
            if request_bytes <= 0:
                break
            chunks, info = read_upstream_range(entry.url, stored, request_bytes, testing=self.config.testing)
            entry.total_bytes = entry.total_bytes or info["totalBytes"]
            entry.etag = entry.etag or info["etag"]
            if info["status"] != 206:
                entry.upstream_supports_range = False
                info["close"]()
                raise UpstreamRangeUnsupported()
            entry.upstream_supports_range = True
            written = 0
            for chunk in chunks:
                if not chunk:
                    break
                if stored + written >= planned_budget():
                    break
                self.cache.store(key, entry, stored + written, chunk)
                written += len(chunk)
            if written == 0:
                break
            stored += written
            # Enough to start playing? Do not spend the rest of the budget.
            if stored >= min_stop and source.bitrate and entry.total_bytes:
                if stored / max(1, source.bitrate / 8) >= target_seconds:
                    break
            if stored >= min_stop and entry.total_bytes and stored * 5 >= entry.total_bytes:
                break
        return stored - initially_stored

    # ---- range relay -------------------------------------------------------

    def _read_gap(self, entry: _CacheEntry, key: str, start: int, length: int) -> tuple[int, bool]:
        """Fetch one bounded gap upstream, remember it, and report what happened.

        Returns the number of bytes stored and whether the upstream honoured the
        requested offset. A server that ignores ``Range`` still only ever sends
        the bounded slice this call asked for, never the complete file.
        """
        chunks, info = read_upstream_range(entry.url, start, length, testing=self.config.testing)
        honored = info["status"] == 206
        entry.upstream_supports_range = honored
        if entry.total_bytes is None and info["totalBytes"]:
            entry.total_bytes = info["totalBytes"]
        entry.etag = entry.etag or info["etag"]
        written = 0
        for chunk in chunks:
            if not chunk:
                break
            if written >= length:
                break
            if entry.total_bytes and start + written >= entry.total_bytes:
                break
            if not honored and start + written > 0:
                # Without range support only the leading bytes of the resource
                # can be served; a later offset would be silently wrong.
                break
            self.cache.store(key, entry, start + written, chunk)
            written += len(chunk)
        if written == 0:
            raise PreviewError("媒体源没有返回可播放的数据", 502)
        return written, honored

    def _resolve_range(self, entry: _CacheEntry, key: str, start: int, end: int | None) -> tuple[int, int]:
        if entry.total_bytes is None:
            self._read_gap(entry, key, 0, 1)
        total = entry.total_bytes
        if not total:
            raise PreviewError("媒体源没有返回可播放的数据", 502)
        if start >= total:
            raise PreviewError("请求范围超出媒体长度", 416)
        resolved_end = total - 1 if end is None else min(end, total - 1)
        if resolved_end < start:
            raise PreviewError("请求范围无效", 416)
        return resolved_end, total

    def stream(self, video_id: str, generation: str, start: int, end: int | None
               ) -> tuple[PreviewSource, int, int, int, Iterator[bytes]]:
        """Return ``(source, start, end, total, body)`` for one validated range.

        The body is produced lazily: bytes already relayed are replayed from host
        memory, while the remaining range is fetched one bounded block at a time
        as the viewer consumes it. A viewer that leaves or seeks away therefore
        stops the upstream transfer at that point instead of after the whole
        response has been pulled down.
        """
        video = self.database.get_video(video_id)
        if not video:
            raise PreviewError("作品记录不存在", 404)
        source = self.source_for(video_id, generation)
        if source is None:
            raise PreviewError("播放源尚未准备或已更新，请重新开始播放", 409)
        entry = self._entry(source)
        key = self._cache_key(video_id, generation)
        if entry.total_bytes is None and source.content_length:
            entry.total_bytes = source.content_length
        resolved_end, total = self._resolve_range(entry, key, start, end)
        block = max(CHUNK_BYTES * 4, min(self.config.preview_prefetch_max_bytes, 2 * 1024 * 1024))

        def body() -> Iterator[bytes]:
            nonlocal entry
            self.cache.pin(key)
            cursor = start
            recoveries = 0
            try:
                while cursor <= resolved_end:
                    # A warmed prefix may be shorter than a normal relay block.
                    # Serve that available part immediately rather than opening
                    # upstream again for an overlapping full block.
                    cached_end = next((limit for begin, limit in entry.known_ranges()
                                       if begin <= cursor < limit), cursor)
                    chunk = entry.slice(cursor, min(cursor + block, resolved_end + 1, cached_end)) \
                        if cached_end > cursor else None
                    if chunk:
                        yield chunk
                        cursor += len(chunk)
                        continue
                    try:
                        request_bytes = min(block, resolved_end - cursor + 1)
                        chunks, info = read_upstream_range(entry.url, cursor, request_bytes, testing=self.config.testing)
                        written = 0
                        try:
                            entry.upstream_supports_range = info["status"] == 206
                            if not entry.upstream_supports_range and cursor > 0:
                                raise UpstreamRangeUnsupported("该媒体源不支持按范围读取，无法从中间位置继续播放")
                            if info["totalBytes"] is not None and info["totalBytes"] != total:
                                raise GenerationChanged()
                            for chunk in chunks:
                                self.cache.store(key, entry, cursor, chunk)
                                yield chunk
                                cursor += len(chunk)
                                written += len(chunk)
                        finally:
                            info["close"]()
                            chunks.close()
                        if not written:
                            raise PreviewError("媒体源没有返回可播放的数据", 502)
                    except GenerationChanged:
                        raise
                    except PreviewError as error:
                        if error.status == 416 or recoveries >= MAX_PLAY_RECOVERIES:
                            raise
                        recoveries += 1
                        # Opening the iterator succeeds before the CDN is read.
                        # Recover here, at the first byte not yet sent, rather
                        # than retrying only the creation of the lazy iterator.
                        self._recover(video_id, generation)
                        replacement = self.source_for(video_id, generation)
                        if replacement is None:
                            raise GenerationChanged()
                        entry = self._entry(replacement)
                        if (entry.total_bytes or replacement.content_length) != total:
                            raise GenerationChanged()
            except PreviewError as error:
                with self._lock:
                    current = self._sources.get(video_id)
                    if current is not None and current.generation == generation:
                        self._sources.pop(video_id, None)
                        self._errors[video_id] = safe_error(str(error))[:300]
                self.cache.drop(key)
                raise
            finally:
                self.cache.unpin(key)

        return source, start, resolved_end, total, body()

    @staticmethod
    def _missing(entry: _CacheEntry, start: int, end: int) -> list[tuple[int, int]]:
        gaps: list[tuple[int, int]] = []
        cursor = start
        for begin, limit in entry.known_ranges():
            if limit <= cursor:
                continue
            if begin > end:
                break
            if begin > cursor:
                gaps.append((cursor, min(end, begin - 1)))
            cursor = max(cursor, limit)
            if cursor > end:
                break
        if cursor <= end:
            gaps.append((cursor, end))
        return [gap for gap in gaps if gap[0] <= gap[1]]

    def play(self, video_id: str, generation: str, start: int, end: int | None):
        """Serve one playback range, recovering a bounded number of times."""
        last_error: Exception | None = None
        for attempt in range(1, MAX_PLAY_RECOVERIES + 2):
            try:
                return self.stream(video_id, generation, start, end)
            except GenerationChanged:
                raise
            except PreviewError as error:
                last_error = error
                if error.status == 416 or attempt > MAX_PLAY_RECOVERIES:
                    raise
                self._recover(video_id, generation)
        raise last_error or PreviewError("媒体读取失败", 502)

    def _recover(self, video_id: str, generation: str) -> None:
        """Refresh an expired address in place; a new encoding keeps its own id."""
        video = self.database.get_video(video_id)
        if not video:
            raise PreviewError("作品记录不存在", 404)
        with self._lock:
            current = self._sources.get(video_id)
        if current is None:
            raise PreviewError("播放源尚未准备，请重新开始播放", 409)
        self.refresh(video, generation)

    def shutdown(self) -> None:
        self._stopping.set()
