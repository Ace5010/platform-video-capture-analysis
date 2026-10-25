"""Host-owned browser runner; all client devices submit to the same SQLite queue."""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import __version__
from .database import utc_now
from .config import create_task_temp_dir
from .media import download_media, has_audio_stream, media_duration_seconds, mux_original_streams, probe_media, sha256_file, remove_task_dir
from .recovery import AnalysisCancelled, safe_error

CAPABILITIES = ["collect_latest", "archive_account", "analyze_video"]


class CollectionBlocked(RuntimeError):
    """A confirmed login/challenge block needs human intervention."""
PREVIEW_RPC_TIMEOUT_SECONDS = 90


@dataclass
class PreviewCandidate:
    """One target-bound low-resolution source chosen for on-demand playback."""

    url: str
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        """Identity of the encoded resource, independent of the signed token."""
        generator = self.metadata.get("generator") or ""
        if generator:
            return str(generator)[:96]
        parts = [str(self.metadata.get(key) if self.metadata.get(key) is not None else "") for key in
                 ("width", "height", "bitrate", "contentLength", "codec", "contentType")]
        return "|".join(parts)


@dataclass
class PreviewResolution:
    """The chosen source plus the ranked alternatives for the same work."""

    candidate: PreviewCandidate
    alternatives: list[PreviewCandidate] = field(default_factory=list)
    # Sources the page's own player actually streamed: the strongest evidence
    # that the local browser can decode them.
    played: list[PreviewCandidate] = field(default_factory=list)
    page: dict[str, Any] = field(default_factory=dict)


class BrowserManager:
    def __init__(self, config, database, analysis):
        self.config, self.database, self.analysis = config, database, analysis
        self.root = Path(__file__).resolve().parent.parent
        self.connector_id = "host-dedicated-browser"
        self.worker_id = str(uuid.uuid4())
        self.stop_event = threading.Event()
        self.open_event = threading.Event()
        self.process = None
        self.responses = queue.Queue()
        self.thread = None
        self.ready = False
        self.running = False
        self.error = ""
        self.collection_pause = self.database.get_setting("collection_pause") or ""
        self.media_paused = False
        self.active_job = None
        self.rpc_lock = threading.RLock()
        self._transcription_sources = {}
        self._transcription_source_lock = threading.Lock()

    def start(self):
        # Internal identity never receives a browser-visible credential.
        self.database.pair_connector(self.connector_id, "电脑专用浏览器", self.connector_id,
                                     uuid.uuid4().hex, __version__, CAPABILITIES, self.worker_id)
        self.thread = threading.Thread(target=self._loop, name="dedicated-browser", daemon=True)
        self.thread.start()

    def status(self):
        return {"mode": "dedicated_browser", "connected": self.ready, "paired": True,
                "running": self.running, "error": self.collection_pause or self.error, "opening": self.open_event.is_set(),
                "collectionPaused": bool(self.collection_pause),
                "capabilities": CAPABILITIES if self.ready else [],
                "workerStatus": "running" if self.active_job else "idle",
                "mediaPaused": self.media_paused,
                "activeJobId": self.active_job["id"] if self.active_job else None}

    def open(self):
        self.open_event.set()

    def resume_collection(self):
        self.database.set_setting("collection_pause", "")
        self.collection_pause = ""
        self.error = ""

    def _spawn(self):
        if self.process and self.process.poll() is None:
            return
        node = shutil.which("node")
        if not node:
            raise RuntimeError("未找到 Node.js，请在电脑重新安装项目运行环境")
        responses = queue.Queue()
        self.responses = responses
        self.process = subprocess.Popen(
            [node, str(self.root / "scripts/browser-worker.mjs")], cwd=self.root,
            env={**os.environ, "DOUYIN_BROWSER_PROFILE": str(self.config.data_dir / "browser-profile")},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        process = self.process

        def read():
            try:
                for line in process.stdout:
                    try:
                        responses.put(json.loads(line))
                    except ValueError:
                        continue
            finally:
                responses.put({"disconnected": True})
        threading.Thread(target=read, name="browser-responses", daemon=True).start()

    def _heartbeat(self):
        job = self.active_job
        self.database.update_connector_runtime(self.connector_id, extension_version=__version__,
            capabilities=CAPABILITIES, worker_id=self.worker_id,
            worker_status="running" if job else "idle", active_job_id=job["id"] if job else None)
        if job:
            self.database.heartbeat_job(self.connector_id, job["id"], job["claimToken"])

    def _rpc(self, command, timeout=180, check_cancelled=None):
        deadline = time.monotonic() + timeout
        while True:
            if check_cancelled:
                check_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("等待专用浏览器超过本次获取时限")
            if self.rpc_lock.acquire(timeout=min(.1, remaining)):
                break
        try:
            return self._rpc_locked(command, max(.01, deadline - time.monotonic()), check_cancelled)
        finally:
            self.rpc_lock.release()

    def _rpc_locked(self, command, timeout=180, check_cancelled=None):
        if check_cancelled:
            check_cancelled()
        self._spawn()
        command = {**command, "id": uuid.uuid4().hex}
        self.process.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while not self.stop_event.is_set() and time.monotonic() < deadline:
            if check_cancelled:
                try:
                    check_cancelled()
                except AnalysisCancelled:
                    self._stop_process()
                    raise
            try:
                response = self.responses.get(timeout=min(5, max(0.01, deadline - time.monotonic())))
            except queue.Empty:
                self._heartbeat()
                continue
            if response.get("disconnected"):
                self.running = False
                raise RuntimeError("专用浏览器进程已退出，请检查电脑运行环境后重试")
            if response.get("id") != command["id"]:
                continue
            if not response.get("ok"):
                raise RuntimeError(response.get("error") or "专用浏览器执行失败")
            result = response.get("result") or {}
            if "running" in result:
                self.running = result["running"]
            elif command["action"] in ("collect", "capture"):
                self.running = True
            return result
        self._stop_process()
        raise RuntimeError("专用浏览器任务超时或服务停止，请在电脑检查抖音登录、验证码和网络后重试")

    def _event(self, job, kind, payload, suffix=None):
        return self.database.process_connector_event(self.connector_id, job["id"], job["claimToken"],
            f'{job["id"]}:{job["claimToken"]}:{suffix or kind}', kind, payload)

    def execute(self, job):
        self._event(job, "started", {"stage": "browser_capture"})
        payload = job["payload"]
        if job["type"] == "analyze_video":
            self.database.start_host_analysis(job["id"])
            self.analysis.submit(job["id"], payload, capture_media=self.capture_analysis_media)
            return
        mode = "initial" if job["type"] == "archive_account" else "latest"
        requested = set(payload.get("accountIds") or [])
        if payload.get("accountId"):
            requested.add(payload["accountId"])
        accounts = [account for account in self.database.state()["accounts"]
                    if account.get("platform") == "douyin" and (not requested or account["id"] in requested)]
        if mode == "latest" and not requested:
            accounts = [account for account in accounts if account.get("initialSyncStatus") == "complete"]
        if not accounts:
            raise RuntimeError("任务没有匹配到可采集的监控账号")
        self._collect_accounts(job, payload, mode, accounts)

    def capture_analysis_media(self, payload, *, deadline, check_cancelled):
        # Exactly one address capture. AnalysisManager alone owns the
        # three-attempt budget covering capture + download + validation.
        video_id = str(payload["videoId"])
        media = self._rpc({"action": "capture", "payload": {
            "videoId": video_id, "accountId": payload.get("accountId"),
            "videoUrl": f"https://www.douyin.com/video/{video_id}",
            "requireCompleteMetadata": payload.get("sourceKind") == "video_link",
            "savedVideoMetadata": payload.get("savedVideoMetadata"),
        }}, timeout=max(1, min(180, deadline - time.monotonic())), check_cancelled=check_cancelled)
        metadata = media.get("videoMetadata") or {}
        result = {"videoUrl": media["video"]["url"], "audioUrl": (media.get("audio") or {}).get("url"),
            "videoId": video_id, "accountId": payload.get("accountId"),
            "title": metadata.get("title") or payload.get("title"),
            "description": metadata.get("description") or payload.get("description"),
            "authorName": metadata.get("authorName") or payload.get("authorName"),
            "videoMetadata": metadata, "sourceVideoUrl": media["sourceVideoUrl"],
            "mediaMeta": {"video": media["video"]["metadata"],
                          "audio": (media.get("audio") or {}).get("metadata"), "page": media["page"]}}
        return result

    def _collect_accounts(self, job, payload, mode, accounts):
        failures = []
        account_updates = []
        skipped = 0
        discovery_counts: dict[str, int] = {}
        for account_index, account in enumerate(accounts, 1):
            try:
                current = self.database.update_account_if_present({"id": account["id"], "status": "checking", "currentSyncMode": mode, "collectionError": None})
                if current is None:
                    skipped += 1
                    continue
                account = current
                self._event(job, "progress", {"stage": "account_collecting", "accountId": account["id"],
                    "accountName": account["name"], "accountIndex": account_index, "totalAccounts": len(accounts)},
                    f'account-start:{account["id"]}')
                result = self._rpc({"action": "collect", "account": account, "mode": mode}, timeout=1800)
                captured = utc_now()
                videos = [{**video, "accountId": account["id"], "capturedAt": captured}
                          for video in result.get("videos") or []]
                pending = result.get("pendingVideos") or []
                if pending:
                    raise RuntimeError("采集结果仍有未完成视频，已拒绝写入和标记完成")
                if not videos and not (mode == "latest" and result.get("discoveredVideoIds") == []):
                    raise RuntimeError("账号页返回了空视频列表，请检查抖音登录和验证码")
                required = ("title", "description", "coverUrl", "publishedAt", "durationSeconds",
                            "likeCount", "commentCount", "favoriteCount", "shareCount")
                if any(any(video.get(key) is None or video.get(key) == "" for key in required) for video in videos):
                    raise RuntimeError("采集结果字段不完整，已拒绝写入和标记完成")
                updated = {**account, "name": result.get("accountName") or account["name"],
                           "avatarUrl": result.get("accountAvatarUrl") or account.get("avatarUrl")}
                # Follower data is auxiliary: a missing reading keeps the last
                # saved value and must never fail an otherwise complete capture.
                follower = result.get("accountFollowers")
                if isinstance(follower, dict):
                    updated.update(follower)
                self.remember_transcription_sources(account['id'], videos, result.get('transcriptionMedia') or {})
                self._event(job, "collection_result", {"account": updated, "accountId": account["id"],
                    "mode": mode, "videos": videos, "discoveredVideoIds": result.get("discoveredVideoIds") or [],
                    "completedAt": captured}, f'account:{account["id"]}')
                saved = next((item for item in self.database.state()["accounts"] if item["id"] == account["id"]), None)
                if saved is None:
                    skipped += 1
                    continue
                # Account checking no longer waits for any video file: new-works
                # detection, follower refresh and on-demand preview are separate.
                if mode == "latest":
                    # "This run's new findings" and "the rolling 72-hour total"
                    # are separate numbers and must stay separate in the report.
                    account_updates.append({"accountId": account["id"], "accountName": saved["name"],
                                            "newVideoCount": saved.get("latestCheckNewVideoCount", 0),
                                            "discoveryCount": discovery_counts.get(account["id"], 0),
                                            "followersCapturedAt": saved.get("followerCountCapturedAt")})
            except Exception as error:
                message = safe_error(error)
                # A hint listing several possible causes is not evidence of a
                # shared login block. Ordinary account errors still advance.
                if "可能" not in message and any(text in message for text in
                        ("必须重新登录", "登录已失效", "请先登录", "请完成登录", "验证码未通过", "需要完成验证码", "触发风控")):
                    raise CollectionBlocked(message) from error
                current = self.database.update_account_if_present({"id": account["id"], "status": "error", "currentSyncMode": None, "collectionError": safe_error(error)[:500],
                    **({"initialSyncStatus": "error"} if mode == "initial" else {})})
                if current is None:
                    skipped += 1
                    continue
                failures.append(f'{account.get("name", "账号")}：{safe_error(error)}')
        _, discovery_counts = self.database.recent_discoveries()
        self._event(job, "job_failed" if failures else "job_completed",
                    {"message": "；".join(failures), "total": len(accounts),
                     "accountUpdates": account_updates,
                     "newVideoCount": sum(item["newVideoCount"] for item in account_updates),
                     "newDiscoveryCount": sum(item["newVideoCount"] for item in account_updates),
                     "discoveryTotalCount": sum(discovery_counts.values()),
                     "succeeded": len(accounts) - len(failures) - skipped, "failed": len(failures), "skipped": skipped,
                     **({"accountId": accounts[0]["id"], "mode": mode} if len(accounts) == 1 else {})})

    def resolve_preview(self, video_id: str, video_url: str, *, timeout: float = PREVIEW_RPC_TIMEOUT_SECONDS,
                        check_cancelled=None) -> PreviewResolution:
        """Resolve one target-bound low-resolution source for on-demand playback.

        This never downloads media and never starts an analysis task; it only
        reuses the audited target verification and source extraction.
        """
        result = self._rpc({"action": "preview", "payload": {"videoId": video_id, "videoUrl": video_url}},
                           timeout=max(1.0, timeout), check_cancelled=check_cancelled)
        if str(result.get("videoId") or "") != str(video_id):
            raise RuntimeError("预览源视频 ID 校验失败")
        video = result.get("video") or {}
        url = video.get("url")
        if not isinstance(url, str) or not url:
            raise RuntimeError("没有取得经过目标校验的可用播放源")
        metadata = video.get("metadata") if isinstance(video.get("metadata"), dict) else {}
        played = []
        for item in result.get("playedSources") or []:
            if isinstance(item, dict) and isinstance(item.get("url"), str) and item["url"]:
                item_metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
                played.append(PreviewCandidate(url=item["url"], metadata=item_metadata))
        alternatives = []
        for item in result.get("previewCandidates") or []:
            if not isinstance(item, dict):
                continue
            candidate_url = item.get("url")
            if not isinstance(candidate_url, str) or not candidate_url or candidate_url == url:
                continue
            item_metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            alternatives.append(PreviewCandidate(url=candidate_url, metadata=item_metadata))
        page = result.get("page") if isinstance(result.get("page"), dict) else {}
        return PreviewResolution(candidate=PreviewCandidate(url=url, metadata=metadata),
                                 alternatives=alternatives, played=played, page=page)

    def capture_analysis_media(self, payload, *, deadline, check_cancelled):
        # Exactly one address capture. AnalysisManager alone owns the
        # three-attempt budget covering capture + download + validation.
        video_id = str(payload["videoId"])
        media = self._rpc({"action": "capture", "payload": {
            "videoId": video_id, "accountId": payload.get("accountId"),
            "videoUrl": f"https://www.douyin.com/video/{video_id}",
            "purpose": "analysis",
            "requireCompleteMetadata": payload.get("sourceKind") == "video_link",
            "savedVideoMetadata": payload.get("savedVideoMetadata"),
        }}, timeout=max(1, min(180, deadline - time.monotonic())), check_cancelled=check_cancelled)
        metadata = media.get("videoMetadata") or {}
        result = {"videoUrl": media["video"]["url"], "audioUrl": (media.get("audio") or {}).get("url"),
            "videoId": video_id, "accountId": payload.get("accountId"),
            "title": metadata.get("title") or payload.get("title"),
            "description": metadata.get("description") or payload.get("description"),
            "authorName": metadata.get("authorName") or payload.get("authorName"),
            "videoMetadata": metadata, "sourceVideoUrl": media["sourceVideoUrl"],
            "mediaMeta": {"video": media["video"]["metadata"],
                          "audio": (media.get("audio") or {}).get("metadata"), "page": media["page"]}}
        return result

    def remember_transcription_sources(self, account_id, videos, sources):
        """Short-lived private handoff only: signed media URLs never enter SQLite."""
        if not self.config.auto_transcribe or not isinstance(sources, dict):
            return
        allowed = {str(v['id']) for v in videos}
        now = time.monotonic()
        with self._transcription_source_lock:
            self._transcription_sources = {key: value for key, value in self._transcription_sources.items() if value[0] > now}
            for video_id, media in list(sources.items())[:512]:
                if video_id not in allowed or not isinstance(media, dict):
                    continue
                if str(media.get('videoId')) != video_id or str(media.get('accountId')) != str(account_id):
                    continue
                if str((media.get('page') or {}).get('observedVideoId')) != video_id:
                    continue
                source = media.get('audio') or media.get('video')
                if not isinstance(source, dict) or (source.get('metadata') or {}).get('targetBound') is not True:
                    continue
                saved = self.database.get_video(video_id)
                if saved and (saved.get('transcriptStatus') == 'ready' or saved.get('transcript')):
                    continue
                encoded = json.dumps(media)
                if len(encoded) > 32768:
                    continue
                self._transcription_sources.pop(video_id, None)
                self._transcription_sources[video_id] = (now+1800, json.loads(encoded))
            while len(self._transcription_sources) > 512:
                self._transcription_sources.pop(next(iter(self._transcription_sources)))

    def capture_transcription_media(self, video, *, deadline, check_cancelled, force_refresh=False):
        """Resolve complete audio, or a small platform video when audio is muxed."""
        video_id = str(video["id"])
        check_cancelled()
        with self._transcription_source_lock:
            cached = self._transcription_sources.pop(video_id, None)
        if not force_refresh and cached and cached[0] > time.monotonic() and str(cached[1].get('accountId')) == str(video.get('accountId')):
            return {**cached[1], 'origin': 'collection'}
        # Account collection may own the browser for many minutes. Waiting for
        # that lock is queue time, not a failed media lookup; keep the lease alive.
        while not self.rpc_lock.acquire(timeout=.2):
            check_cancelled()
        try:
            check_cancelled()
            result = self._rpc({"action": "capture", "payload": {
                "videoId": video_id, "accountId": video.get("accountId"), "purpose": "transcription",
                "videoUrl": f"https://www.douyin.com/video/{video_id}",
            }}, timeout=180, check_cancelled=check_cancelled)
        finally:
            self.rpc_lock.release()
        if str(result.get("videoId")) != video_id or str((result.get("page") or {}).get("observedVideoId")) != video_id:
            raise RuntimeError("口播音轨目标视频 ID 校验失败")
        return result

    def _loop(self):
        while not self.stop_event.is_set():
            try:
                # A capture already owns this private browser. Do not report
                # it disconnected merely because its RPC is still running.
                if not self.rpc_lock.acquire(blocking=False):
                    self._heartbeat()
                    self.stop_event.wait(1)
                    continue
                try:
                    self._rpc({"action": "status"}, timeout=15)
                finally:
                    self.rpc_lock.release()
                self.ready = True
                self._heartbeat()
                if self.open_event.is_set():
                    self.open_event.clear()
                    self._rpc({"action": "open"}, timeout=60)
                    self.error = ""
                job = None if self.collection_pause else self.database.claim_job(self.connector_id, CAPABILITIES)
                if job:
                    self.active_job = job
                    try:
                        self.execute(job)
                        self.error = ""
                    except Exception as error:
                        self.error = safe_error(error)[:500]
                        if isinstance(error, CollectionBlocked):
                            self.database.defer_collection_job(self.connector_id, job, self.error)
                            self.collection_pause = self.database.get_setting("collection_pause") or ""
                            continue
                        current = self.database.get_job(job["id"])
                        if current and current["status"] in {"claimed", "running"} and current.get("claimToken"):
                            self._event(job, "job_failed", {"message": self.error})
                    finally:
                        self.active_job = None
            except Exception as error:
                self.error = safe_error(error)[:500]
                self.ready = False
            self.stop_event.wait(2)
        self._stop_process()

    def _stop_process(self):
        process = self.process
        if process and process.poll() is None:
            process.stdin.close()  # EOF closes the owned browser context, preserving its profile.
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)
        self.process = None
        self.running = False

    def shutdown(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=12)
