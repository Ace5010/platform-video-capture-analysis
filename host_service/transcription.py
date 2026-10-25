"""Durable serial local-ASR queue; no visual-model or cloud fallback calls."""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from .config import create_task_temp_dir
from .media import download_media, media_duration_seconds, remove_task_dir, _tool_path
from .recovery import AnalysisCancelled, safe_error, requires_user_action


def local_error(stderr):
    """Keep the actual exception, rather than the beginning of its traceback."""
    lines = [line.strip() for line in stderr.decode('utf-8', errors='replace').splitlines() if line.strip()]
    if not lines:
        return '本地识别进程异常退出，未返回错误详情'
    last = lines[-1]
    try:
        value = json.loads(last)
        if isinstance(value, dict) and value.get('error_type'):
            last = f"{value['error_type']}: {value.get('reason', '')}"
    except (ValueError, TypeError):
        pass
    return safe_error(last)[:420]


def retryable_media_error(error):
    if isinstance(error, AnalysisCancelled) or requires_user_action(error):
        return False
    return any(marker in str(error) for marker in (
        '无法连接', '下载中断', '下载超过', '连接超过', 'CDN 域名解析失败', 'CDN 没有可用地址',
        '文件不完整', '媒体完整性检查失败',
        '时长与目标视频不一致', '独立音轨不包含音频', 'CDN 未返回可识别',
    )) or bool(re.search(r'HTTP (?:401|403|404|408|410|429|5\d\d)\b', str(error)))


class LocalASRError(RuntimeError):
    def __init__(self, detail):
        super().__init__('本地口播识别失败：' + detail)
        match = re.search(r'(?:^|\.)([A-Za-z][A-Za-z0-9_]*):', detail)
        self.kind = match.group(1) if match else 'ProcessError'
        self.attempts = []
        self.diagnostics = {}


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
        deadline = time.monotonic()+900
        attempts = []
        for chunk_seconds in (28, 14, 7):
            check()
            started = time.monotonic()
            try:
                result = self._run_local_once(path, directory, check, video=video,
                                              chunk_seconds=chunk_seconds, deadline=deadline)
                attempts.append({'chunk_seconds': chunk_seconds, 'status': 'complete',
                                 'elapsed_seconds': round(time.monotonic()-started, 2)})
                result.update(local_attempts=attempts, recovery_attempts=int(result.get('recovery_attempts') or 0)+len(attempts)-1,
                              recovery_errors=list(result.get('recovery_errors') or [])+
                                              [{'error_type':a['error_type']} for a in attempts if 'error_type' in a])
                return result
            except LocalASRError as error:
                attempts.append({'chunk_seconds': chunk_seconds, 'status': 'failed',
                                 'error_type': error.kind, 'error': safe_error(error),
                                 'diagnostics': error.diagnostics,
                                 'elapsed_seconds': round(time.monotonic()-started, 2)})
                error.attempts = attempts
                if error.kind not in {'OutputTruncated', 'OutputRepetition'} or chunk_seconds == 7 or time.monotonic() >= deadline:
                    raise
                # Reuse the complete verified file and identical vocabulary.
                # Incomplete model output is never published or stitched in.
        raise RuntimeError('本地口播识别未完成')

    def _run_local_once(self, path, directory, check, *, video=None, chunk_seconds=28, deadline=None):
        root = self.config.local_asr_dir
        output = directory / "transcript.json"
        output.unlink(missing_ok=True)
        output.with_suffix('.txt').unlink(missing_ok=True)
        context = directory / 'video-context.json'
        context.write_text(json.dumps({key: (video or {}).get(key) or '' for key in ('title', 'description')},ensure_ascii=False),encoding='utf-8')
        process = subprocess.Popen(
            [str(root / ".venv/Scripts/python.exe"), "-u", str(root / "transcribe.py"), str(path), "--output", str(output),
             '--context-file', str(context), '--chunk-seconds', str(chunk_seconds)],
            cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        deadline = deadline or time.monotonic()+900
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
                details = local_error(stderr or b'')
                error = LocalASRError(details)
                try:
                    final = json.loads((stderr or b'').decode('utf-8', errors='replace').splitlines()[-1])
                    for key in ('failed_range', 'recovery_trace'):
                        if key in final:
                            error.diagnostics[key] = json.loads(safe_error(json.dumps(final[key], ensure_ascii=False)))
                except (ValueError, TypeError, IndexError):
                    pass
                raise error
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

    def _acquire_media(self, video, directory, check, attempts):
        video_id = str(video['id'])
        deadline = None
        force_video = False
        failed_sources = set()
        def source_key(candidate):
            parsed = urlsplit(str(candidate.get('url') or ''))
            return parsed.hostname, parsed.path
        for attempt in range(3):
            check()
            options = {'force_refresh': True} if attempt else {}
            if force_video:
                options['prefer_video'] = True
            media = self.capture_media(video, deadline=time.monotonic()+180, check_cancelled=check, **options)
            if str(media.get('videoId')) != video_id or str((media.get('page') or {}).get('observedVideoId')) != video_id:
                raise RuntimeError('口播音轨未通过目标视频校验')
            audio = media.get('audio') if not force_video else None
            source = audio or media.get('video')
            if not audio and source and source_key(source) in failed_sources:
                alternatives = [candidate for candidate in media.get('previewCandidates', [])
                                if isinstance(candidate, dict)
                                and (candidate.get('metadata') or {}).get('targetBound') is True
                                and (candidate.get('metadata') or {}).get('sourceRole') == 'play'
                                and source_key(candidate) not in failed_sources]
                if alternatives:
                    # The browser already bound every candidate to this video.
                    # Fresh signatures on the same stalled CDN path are not a
                    # new transport route; try another existing rendition.
                    source = alternatives[0]
            if not source or (source.get('metadata') or {}).get('targetBound') is not True:
                raise RuntimeError('未取得绑定目标视频的完整音轨来源')
            if deadline is None:
                # Browser queue time is excluded. Transfers and retries share
                # a finite seven-minute budget, at most 140 seconds per try.
                deadline = time.monotonic()+420
            path = directory / (f'source-{attempt}.m4a' if audio else f'source-{attempt}.mp4')
            record = {'attempt': attempt+1, 'source': 'audio' if audio else 'video',
                      'source_role': (source.get('metadata') or {}).get('sourceRole'),
                      'origin': media.get('origin') or 'video_page'}
            attempts.append(record)
            try:
                download_media(source['url'], path, self.config.max_audio_bytes if audio else self.config.max_video_bytes,
                               '口播音轨', expected_video_id=video_id,
                               deadline=min(deadline, time.monotonic()+140), check_cancelled=check)
                check()
                probe_process = subprocess.run([_tool_path('ffprobe'), '-v', 'error', '-show_entries',
                    'format=duration:stream=codec_type', '-of', 'json', str(path)], capture_output=True,
                    text=True, encoding='utf-8', timeout=30, check=False)
                if probe_process.returncode:
                    raise RuntimeError('口播媒体完整性检查失败')
                probe = json.loads(probe_process.stdout)
                actual = media_duration_seconds(probe)
                expected = float(video.get('durationSeconds') or 0)
                record.update(expected_seconds=expected, actual_seconds=actual)
                if not actual or expected <= 0 or abs(actual-expected) > max(2, expected*.02):
                    force_video = bool(audio) or force_video
                    raise RuntimeError(f'口播音轨时长与目标视频不一致（预期 {expected:g} 秒，实际 {actual or 0:g} 秒）')
                if audio and not any(s.get('codec_type') == 'audio' for s in probe.get('streams', [])):
                    force_video = True
                    raise RuntimeError('平台返回的独立音轨不包含音频')
                record['status'] = 'complete'
                return path, probe, actual, media
            except Exception as error:
                failed_sources.add(source_key(source))
                record.update(status='failed', error=safe_error(error)[:500], error_type=type(error).__name__,
                              cause_type=type(error.__cause__).__name__ if error.__cause__ else None)
                if attempt >= 2 or not retryable_media_error(error) or time.monotonic() >= deadline:
                    raise
                # One fresh audio lookup, then try a verified complete low-res
                # video. Never substitute a background-music resource.
                if attempt == 1:
                    force_video = True
                path.unlink(missing_ok=True)
                check()
                if self.stop_event.wait(.5 * (attempt+1)):
                    check()
        raise RuntimeError('口播媒体获取未完成')

    def run_job(self, job):
        video_id, token, video = job["videoId"], job["claimToken"], job["video"]
        directory = None
        last_heartbeat = 0.0
        started = time.monotonic()
        attempts = []
        stage = 'prepare'

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
            stage = 'media'
            path, probe, actual, media = self._acquire_media(video, directory, check, attempts)
            if not any(s.get("codec_type") == "audio" for s in probe.get("streams", [])):
                result = {"text": "", "audio_seconds": 0, "vocabulary": []}
            else:
                stage = 'local_asr'
                result = self._run_local(path, directory, check, video=video)
                if abs(float(result.get("audio_seconds") or 0)-actual) > max(2, actual*.02):
                    raise RuntimeError("本地识别未覆盖完整音轨")
            check()
            metadata = {key: result[key] for key in ("model", "runtime", "vocabulary", "context_prompt", "context_prompt_supported", "audio_seconds", "inference_seconds", "total_seconds") if key in result}
            metadata['media_origin'] = media.get('origin') or 'video_page'
            metadata.update(media_attempts=attempts, pipeline_seconds=round(time.monotonic()-started, 2))
            for key in ('recovery_attempts', 'recovery_errors', 'local_attempts', 'recovery_vocabulary', 'recovery_context_prompt', 'audio_coverage'):
                if key in result:
                    metadata[key] = result[key]
            stage = 'save'
            self.database.finish_transcription(video_id, token, result["text"], metadata=metadata)
        except AnalysisCancelled:
            self.database.release_transcription(video_id, token)
        except Exception as error:
            self.database.finish_transcription(video_id, token, error=safe_error(error), metadata={
                'pipeline_stage': stage, 'media_attempts': attempts,
                'local_attempts': getattr(error, 'attempts', []),
                'pipeline_seconds': round(time.monotonic()-started, 2)})
        finally:
            if directory:
                remove_task_dir(directory, self.config.temp_dir)
