"""Durable serial local-ASR queue; no visual-model or cloud fallback calls."""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from .config import create_task_temp_dir
from .media import download_media, media_duration_seconds, remove_task_dir, _tool_path
from .recovery import AnalysisCancelled, safe_error


class TranscriptionManager:
    def __init__(self, config, database, capture_media):
        self.config, self.database, self.capture_media = config, database, capture_media
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._loop, name="local-transcription", daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=15)

    def _loop(self):
        while not self.stop_event.is_set():
            try:
                job = self.database.claim_transcription()
                if job:
                    self.run_job(job)
                    continue
            except Exception:
                # The job remains durable if SQLite is temporarily unavailable.
                pass
            self.stop_event.wait(1)

    def _run_local(self, path, directory, check, *, video=None):
        root = self.config.local_asr_dir
        output = directory / "transcript.json"
        context = directory / 'video-context.json'
        context.write_text(json.dumps({key: (video or {}).get(key) or '' for key in ('title', 'description')},ensure_ascii=False),encoding='utf-8')
        process = subprocess.Popen(
            [str(root / ".venv/Scripts/python.exe"), "-u", str(root / "transcribe.py"), str(path), "--output", str(output), '--context-file', str(context)],
            cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        deadline = time.monotonic()+900
        try:
            while True:
                check()
                if time.monotonic() >= deadline:
                    raise RuntimeError("本地口播识别超过 15 分钟，请检查视频长度和电脑负载")
                try:
                    _, stderr = process.communicate(timeout=.5)
                    break
                except subprocess.TimeoutExpired:
                    continue
            if process.returncode:
                details = safe_error((stderr or b"").decode("utf-8", errors="replace")[-700:])
                raise RuntimeError(f"本地口播识别失败：{details}")
            result = json.loads(output.read_text(encoding="utf-8"))
            if not isinstance(result.get("text"), str):
                raise RuntimeError("本地模型没有返回完整口播结果")
            return result
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    def run_job(self, job):
        video_id, token, video = job["videoId"], job["claimToken"], job["video"]
        directory = None
        last_heartbeat = 0.0

        def check():
            nonlocal last_heartbeat
            if self.stop_event.is_set():
                raise AnalysisCancelled("主机正在停止，口播任务保留待继续")
            if time.monotonic()-last_heartbeat >= 15:
                if not self.database.renew_transcription(video_id, token):
                    raise AnalysisCancelled("口播任务领取已失效")
                last_heartbeat = time.monotonic()

        try:
            root = self.config.local_asr_dir
            if not all((root / name).is_file() for name in ("transcribe.py", "hotwords.json", ".venv/Scripts/python.exe")):
                raise RuntimeError("未找到 D 盘本地识别模型或热词文件，请检查本地部署目录")
            check()
            directory = create_task_temp_dir(self.config, "transcript-"+video_id)
            deadline = time.monotonic()+420
            for attempt in range(2):
                options = {'force_refresh': True} if attempt else {}
                media = self.capture_media(video, deadline=deadline, check_cancelled=check, **options)
                deadline = time.monotonic()+420
                if str(media.get("videoId")) != video_id or str((media.get("page") or {}).get("observedVideoId")) != video_id:
                    raise RuntimeError("口播音轨未通过目标视频校验")
                audio = media.get("audio")
                source = audio or media.get("video")
                if not source or (source.get("metadata") or {}).get("targetBound") is not True:
                    raise RuntimeError("未取得绑定目标视频的完整音轨来源")
                path = directory / ("source.m4a" if audio else "source.mp4")
                try:
                    download_media(source["url"], path, self.config.max_audio_bytes if audio else self.config.max_video_bytes,
                                   "口播音轨", expected_video_id=video_id, deadline=deadline, check_cancelled=check)
                    break
                except Exception as error:
                    if attempt or media.get('origin') != 'collection' or not re.search(r'HTTP (?:401|403|404|410)\b', str(error)):
                        raise
                    # A signed source can expire before its queue turn. Refresh
                    # once on an explicit expiry/denial; never fall back to cloud.
                    path.unlink(missing_ok=True)
                    check()
            check()
            probe_process = subprocess.run([_tool_path("ffprobe"), "-v", "error", "-show_entries",
                "format=duration:stream=codec_type", "-of", "json", str(path)], capture_output=True,
                text=True, encoding="utf-8", timeout=30, check=False)
            if probe_process.returncode:
                raise RuntimeError("口播媒体完整性检查失败")
            probe = json.loads(probe_process.stdout)
            actual = media_duration_seconds(probe)
            expected = float(video.get("durationSeconds") or 0)
            if not actual or expected <= 0 or abs(actual-expected) > max(2, expected*.02):
                raise RuntimeError("口播音轨时长与目标视频不一致，未保存不完整结果")
            if not any(s.get("codec_type") == "audio" for s in probe.get("streams", [])):
                if audio:
                    raise RuntimeError("平台返回的独立音轨不包含音频")
                result = {"text": "", "audio_seconds": 0, "vocabulary": []}
            else:
                result = self._run_local(path, directory, check, video=video)
                if abs(float(result.get("audio_seconds") or 0)-actual) > max(2, actual*.02):
                    raise RuntimeError("本地识别未覆盖完整音轨")
            check()
            metadata = {key: result[key] for key in ("model", "runtime", "vocabulary", "context_prompt", "context_prompt_supported", "audio_seconds", "inference_seconds", "total_seconds") if key in result}
            metadata['media_origin'] = media.get('origin') or 'video_page'
            self.database.finish_transcription(video_id, token, result["text"], metadata=metadata)
        except AnalysisCancelled:
            self.database.release_transcription(video_id, token)
        except Exception as error:
            self.database.finish_transcription(video_id, token, error=safe_error(error))
        finally:
            if directory:
                remove_task_dir(directory, self.config.temp_dir)
