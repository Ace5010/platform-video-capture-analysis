"""On-demand low-resolution playback: bounded memory prewarm plus range relay.

Nothing here writes media to disk, writes signed CDN addresses to logs or the
database, or starts a paid analysis task. The host keeps a small, capped,
in-memory copy of the bytes it has already relayed so a subsequent range from
the same player can be answered without asking the CDN twice.
"""

from __future__ import annotations

import ipaddress
import queue
import threading
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .browser import PreviewCandidate
from .config import HostConfig
from .recovery import safe_error

# Only these public media hosts may be relayed. Every redirect hop is rechecked.
MEDIA_HOST_SUFFIXES = (
    "douyinvod.com", "douyinstatic.com", "douyinpic.com",
    "zjcdn.com", "bytecdn.cn", "byteimg.com",
)
MAX_REDIRECTS = 3
CHUNK_BYTES = 64 * 1024
UPSTREAM_TIMEOUT_SECONDS = 20
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


def _open_url(url: str, byte_range: str | None = None):
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
    return urllib.request.build_opener(_ValidatedRedirects).open(request, timeout=UPSTREAM_TIMEOUT_SECONDS)


def _total_from_content_range(value: str) -> int | None:
    tail = value.rsplit("/", 1)[-1].strip() if value else ""
    return int(tail) if tail.isdigit() else None


def _start_from_content_range(value: str) -> int | None:
    try:
        return int(value.split(" ", 1)[1].split("/", 1)[0].split("-", 1)[0])
    except (IndexError, ValueError):
        return None


def _header(response: Any, name: str) -> str:
    try:
        return str(response.headers.get(name) or "")
    except (AttributeError, ValueError):
        return ""


def read_upstream_range(url: str, start: int, length: int, *, testing: bool = False
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
    response = _open_url(url, f"bytes={start}-{wanted_end}")
    status = int(getattr(response, "status", 200))
    info: dict[str, Any] = {
        "status": status,
        "totalBytes": None,
        "acceptRanges": _header(response, "Accept-Ranges").lower(),
        "etag": _header(response, "ETag") or None,
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
        finally:
            response.close()

    return iterate(), info


@dataclass
class _CacheEntry:
    """One encoded resource version, with the bytes already relayed for it.

    ``buffer`` is the contiguous prefix from byte 0 (the startup prewarm and
    ordinary sequential playback). ``tail`` holds one later contiguous block,
    which is what a seek or a suffix range produces. Bytes are never merged
    across the gap, so a byte-range answer can never splice two parts of the
    resource that were not verified to be adjacent.
    """

    url: str
    fingerprint: str
    buffer: bytearray = field(default_factory=bytearray)
    tail: bytearray = field(default_factory=bytearray)
    tail_start: int = 0
    total_bytes: int | None = None
    last_used: float = field(default_factory=time.monotonic)
    upstream_supports_range: bool | None = None
    etag: str | None = None

    def add(self, start: int, data: bytes) -> None:
        if not data or start < 0:
            return
        end = start + len(data)
        if start < len(self.buffer):
            overlap = min(len(data), len(self.buffer) - start)
            if data[:overlap] != bytes(self.buffer[start:start + overlap]):
                # The bytes at this offset changed, so this is not the resource
                # version the player already received. Refuse to splice them.
                raise GenerationChanged()
        if start == len(self.buffer):
            self.buffer.extend(data)
            self._absorb_tail()
            return
        if start < len(self.buffer):
            return
        if not self.tail:
            self.tail, self.tail_start = bytearray(data), start
            return
        if start < self.tail_start:
            self.tail, self.tail_start = bytearray(data), start
            return
        if start > self.tail_start + len(self.tail):
            # A second gap: replace the previous one instead of pretending the
            # two belong to the same continuous region.
            self.tail, self.tail_start = bytearray(data), start
            return
        offset = start - self.tail_start
        if offset < len(self.tail):
            overlap = min(len(data), len(self.tail) - offset)
            if data[:overlap] != bytes(self.tail[offset:offset + overlap]):
                raise GenerationChanged()
        self.tail.extend(data[overlap:])
        self._absorb_tail()

    def _absorb_tail(self) -> None:
        """Fold a tail that has become adjacent to the prefix back into it."""
        if self.tail and self.tail_start == len(self.buffer):
            self.buffer.extend(self.tail)
            self.tail = bytearray()
            self.tail_start = 0

    def slice(self, start: int, stop: int) -> bytes | None:
        if start < 0 or stop < start:
            return None
        if stop <= len(self.buffer):
            return bytes(self.buffer[start:stop])
        if self.tail and start >= self.tail_start and stop <= self.tail_start + len(self.tail):
            return bytes(self.tail[start - self.tail_start:stop - self.tail_start])
        return None

    def covers(self, start: int, end: int) -> bool:
        if end < start:
            return False
        if end < len(self.buffer):
            return True
        return bool(self.tail) and start >= self.tail_start and end < self.tail_start + len(self.tail)

    def stored_bytes(self) -> int:
        return len(self.buffer) + len(self.tail)

    def known_ranges(self) -> list[tuple[int, int]]:
        ranges = []
        if self.buffer:
            ranges.append((0, len(self.buffer)))
        if self.tail:
            ranges.append((self.tail_start, self.tail_start + len(self.tail)))
        return ranges


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
                return
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
    resolved_at: float = field(default_factory=time.monotonic)

    def public(self) -> dict[str, Any]:
        return {
            "generation": self.generation,
            "width": self.width,
            "height": self.height,
            "bitrate": self.bitrate,
            "codec": self.codec,
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
        candidate: PreviewCandidate = self.browser.resolve_preview(
            video_id, str(video.get("url") or f"https://www.douyin.com/video/{video_id}"),
            timeout=self.config.preview_resolve_timeout_seconds, check_cancelled=check_cancelled,
        )
        metadata = candidate.metadata or {}
        fingerprint = candidate.fingerprint
        with self._lock:
            previous = self._sources.get(video_id)
            generation = previous.generation if previous and previous.fingerprint == fingerprint else uuid.uuid4().hex
            source = PreviewSource(
                video_id=video_id, generation=generation, url=candidate.url, fingerprint=fingerprint,
                width=metadata.get("width"), height=metadata.get("height"), bitrate=metadata.get("bitrate"),
                content_length=metadata.get("contentLength"), codec=metadata.get("codec"),
            )
            self._sources[video_id] = source
            self._errors.pop(video_id, None)
        if not previous or previous.generation != generation:
            self.cache.drop(self._cache_key(video_id, generation))
        return source

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
                self._errors[video_id] = safe_error(error)[:300]
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
        stored = entry.stored_bytes()
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
            return budget

        while stored < planned_budget():
            request_bytes = min(self.config.preview_prefetch_initial_bytes, planned_budget() - stored)
            if request_bytes <= 0:
                break
            chunks, info = read_upstream_range(entry.url, stored, request_bytes, testing=self.config.testing)
            entry.total_bytes = entry.total_bytes or info["totalBytes"]
            entry.etag = entry.etag or info["etag"]
            if info["status"] != 206:
                entry.upstream_supports_range = False
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
        return stored

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
            self.cache.pin(key)
            cursor = start
            try:
                while cursor <= resolved_end:
                    chunk = entry.slice(cursor, min(cursor + block, resolved_end + 1))
                    if chunk:
                        yield chunk
                        cursor += len(chunk)
                        if entry.covers(cursor, resolved_end):
                            break
                        continue
                    request_bytes = min(block, resolved_end - cursor + 1)
                    written, honored = self._read_gap(entry, key, cursor, request_bytes)
                    if not honored and cursor > 0:
                        raise UpstreamRangeUnsupported("该媒体源不支持按范围读取，无法从中间位置继续播放")
                    chunk = entry.slice(cursor, cursor + written)
                    if not chunk:
                        # A later range was requested first; report it instead
                        # of serving bytes that are not the requested offset.
                        raise PreviewError("内存预热缓存不完整，请重新开始播放", 409)
                    yield chunk
                    cursor += len(chunk)
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
