"""One asynchronous cloud transcription of the complete supplied media.

The upload is bound to the ASR model. A paid submission is never retried;
only reads of the same task/result can be retried within a fixed deadline.
Protocol: https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
"""

from __future__ import annotations

import http.client
import json
import math
import re
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import HostConfig
from .qwen import QwenClient, QwenError, QwenUploadLimitExceeded
from .recovery import AnalysisCancelled, requires_user_action, safe_error


CLOUD_ASR_MODEL = "qwen3-asr-flash-filetrans"
CLOUD_ASR_DEADLINE_SECONDS = 600
CLOUD_ASR_NETWORK_SECONDS = 60
CLOUD_ASR_POLL_SECONDS = 3
CLOUD_ASR_GET_ATTEMPTS = 3
CLOUD_ASR_MAX_JSON_BYTES = 16 * 1024 * 1024
CLOUD_ASR_PRICING = {
    "currency": "CNY",
    "region": "cn-beijing",
    "perSecond": 0.00022,
    "checkedAt": "2026-09-15",
    "source": "https://help.aliyun.com/zh/model-studio/model-pricing",
}
_UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


class CloudAsrError(RuntimeError):
    pass


class _TransientReadError(CloudAsrError):
    pass


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Neither bearer credentials nor signed result URLs follow redirects.
        return None


class CloudAsrClient:
    def __init__(self, config: HostConfig, secret: dict[str, Any] | None) -> None:
        self.config = config
        self._uploader = QwenClient(config, {**(secret or {}), "model": CLOUD_ASR_MODEL})
        self._opener = build_opener(_RejectRedirects())
        self._used = False
        self._attempted = 0
        self._seconds: int | float | None = None
        self._task_id: str | None = None
        self._request_ids: list[str] = []
        self._endpoint_host = ""
        self.check_cancelled = lambda: None
        self.retry_callback = lambda attempt, error: None

    @staticmethod
    def _remaining(deadline: float) -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise CloudAsrError("云端口播识别等待超时；未自动重复提交，请核对百炼任务与账单")
        return remaining

    @staticmethod
    def _result_url(value: Any) -> str:
        try:
            parsed = urlsplit(value if isinstance(value, str) else "")
            host = (parsed.hostname or "").lower()
            if (
                parsed.scheme not in {"http", "https"}
                or not host.endswith(".aliyuncs.com")
                or ".oss-" not in host
                or parsed.username is not None
                or parsed.password is not None
                or parsed.port not in {None, 80, 443}
                or not parsed.path
                or parsed.fragment
            ):
                raise ValueError
        except (ValueError, TypeError):
            raise CloudAsrError("云端口播返回的结果地址无效") from None
        # The official response example uses HTTP OSS URLs. OSS signatures
        # cover the resource, not the scheme; fetch the same resource via TLS.
        return urlunsplit(("https", host, parsed.path, parsed.query, ""))

    def _json_request(self, request: Request, deadline: float) -> dict[str, Any]:
        self.check_cancelled()
        try:
            timeout = min(CLOUD_ASR_NETWORK_SECONDS, self._remaining(deadline))
            with self._opener.open(request, timeout=timeout) as response:
                chunks: list[bytes] = []
                size = 0
                read = getattr(response, "read1", response.read)
                while True:
                    self.check_cancelled()
                    remaining = self._remaining(deadline)
                    # HTTPResponse's socket timeout is per read. Reduce it as
                    # the total deadline approaches, including slow bodies.
                    sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                    if sock is not None:
                        sock.settimeout(min(CLOUD_ASR_NETWORK_SECONDS, remaining))
                    chunk = read(min(64 * 1024, CLOUD_ASR_MAX_JSON_BYTES + 1 - size))
                    self._remaining(deadline)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > CLOUD_ASR_MAX_JSON_BYTES:
                        raise CloudAsrError("云端口播响应异常过大")
                    chunks.append(chunk)
        except HTTPError as exc:
            status = exc.code
            exc.close()
            if status == 429 or 500 <= status < 600:
                raise _TransientReadError(f"云端口播服务暂不可用（HTTP {status}）") from None
            if status in {401, 403}:
                raise CloudAsrError("云端口播请求未获授权，请检查百炼密钥与模型权限") from None
            raise CloudAsrError(f"云端口播请求失败（HTTP {status}）") from None
        except (URLError, OSError, http.client.HTTPException):
            raise _TransientReadError("云端口播网络请求未完成") from None
        try:
            payload = json.loads(b"".join(chunks).decode("utf-8"))
        except (ValueError, UnicodeError):
            raise CloudAsrError("云端口播返回的 JSON 不完整或无效") from None
        if not isinstance(payload, dict):
            raise CloudAsrError("云端口播返回结构无效：根内容必须是 JSON 对象")
        return payload

    def _sleep(self, deadline: float, delay: float | None = None) -> None:
        target = min(deadline, time.monotonic() + (CLOUD_ASR_POLL_SECONDS if delay is None else delay))
        while time.monotonic() < target:
            self.check_cancelled()
            time.sleep(min(0.1, target - time.monotonic()))
        self.check_cancelled()
        self._remaining(deadline)

    def _get(self, request: Request, deadline: float) -> dict[str, Any]:
        for attempt in range(CLOUD_ASR_GET_ATTEMPTS):
            try:
                return self._json_request(request, deadline)
            except _TransientReadError as error:
                self.retry_callback(attempt + 1, safe_error(error))
                if attempt + 1 == CLOUD_ASR_GET_ATTEMPTS:
                    raise CloudAsrError("云端口播查询暂不可用；未自动重复提交，请核对百炼任务与账单") from None
                self._sleep(deadline, CLOUD_ASR_POLL_SECONDS * (attempt + 1))
        raise CloudAsrError("云端口播查询未完成")

    def _record_usage(self, payload: dict[str, Any]) -> None:
        usage = payload.get("usage")
        seconds = usage.get("seconds") if isinstance(usage, dict) else None
        if (
            isinstance(seconds, (int, float))
            and not isinstance(seconds, bool)
            and math.isfinite(seconds)
            and seconds >= 0
        ):
            self._seconds = seconds

    def _task_output(self, payload: dict[str, Any]) -> dict[str, Any]:
        output = payload.get("output")
        if not isinstance(output, dict):
            raise CloudAsrError("云端口播任务响应缺少 output")
        task_id = output.get("task_id")
        if not isinstance(task_id, str) or not _UUID.fullmatch(task_id):
            raise CloudAsrError("云端口播任务编号无效")
        if self._task_id is not None and task_id != self._task_id:
            raise CloudAsrError("云端口播返回的任务编号不匹配")
        self._task_id = task_id
        status = output.get("task_status")
        if not isinstance(status, str) or status not in {"PENDING", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"}:
            raise CloudAsrError("云端口播返回的任务状态无效")
        if status in {"SUCCEEDED", "FAILED"}:
            self._record_usage(payload)
        if status == "FAILED":
            # The provider's message can echo signed media URLs. Do not expose it.
            raise CloudAsrError("云端口播识别任务失败；未自动重复提交，请核对百炼任务详情")
        if status == "UNKNOWN":
            raise CloudAsrError("云端口播任务不存在或已过期；未自动重复提交")
        return output

    @staticmethod
    def _transcript(payload: dict[str, Any]) -> str:
        transcripts = payload.get("transcripts")
        if not isinstance(transcripts, list):
            raise CloudAsrError("云端口播结果缺少 transcripts")
        if not transcripts:
            return ""
        # We request only channel 0. Never silently substitute a different
        # track, concatenate duplicate channels, or interpret malformed output
        # as a speechless video.
        if len(transcripts) != 1 or not isinstance(transcripts[0], dict):
            raise CloudAsrError("云端口播结果的音轨结构无效")
        transcript = transcripts[0]
        if transcript.get("channel_id") != 0 or isinstance(transcript.get("channel_id"), bool):
            raise CloudAsrError("云端口播结果的音轨编号不匹配")
        text = transcript.get("text")
        if not isinstance(text, str):
            raise CloudAsrError("云端口播结果缺少完整文本")
        return text.strip()

    def transcribe(self, path: Path) -> str:
        self.check_cancelled()
        if self._used:
            raise CloudAsrError("同一云端口播任务不能重复提交")
        self._used = True
        try:
            endpoint = urlsplit(self._uploader._endpoint())
            if endpoint.username is not None or endpoint.password is not None or endpoint.port not in {None, 443}:
                raise CloudAsrError("云端口播接口地址无效")
            self._endpoint_host = (endpoint.hostname or "").lower()
            origin = f"https://{self._endpoint_host}"
            api_key = self._uploader._api_key()
            # Even small files need a model-bound OSS reference for filetrans.
            deadline = time.monotonic() + CLOUD_ASR_DEADLINE_SECONDS
            for attempt in range(1, 4):
                self.check_cancelled()
                try:
                    reference = self._uploader._upload_file(Path(path))
                    break
                except QwenUploadLimitExceeded:
                    raise
                except (QwenError, OSError, http.client.HTTPException) as error:
                    self.retry_callback(attempt, "云端口播文件上传未完成")
                    if requires_user_action(error) or attempt == 3:
                        raise
                    self._sleep(deadline, 2 * attempt)
        except QwenUploadLimitExceeded:
            raise
        except (QwenError, OSError, ValueError, http.client.HTTPException):
            raise CloudAsrError("云端口播文件上传或配置失败，请检查网络与百炼配置") from None
        if not isinstance(reference, str) or not reference.startswith("oss://"):
            raise CloudAsrError("云端口播临时文件引用无效")
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        body = {
            "model": CLOUD_ASR_MODEL,
            "input": {"file_url": reference},
            "parameters": {"channel_id": [0], "enable_itn": False},
        }
        request = Request(
            f"{origin}/api/v1/services/audio/asr/transcription",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={**headers, "X-DashScope-Async": "enable", "X-DashScope-OssResourceResolve": "enable"},
            method="POST",
        )
        self.check_cancelled()
        self._attempted += 1
        try:
            payload = self._json_request(request, deadline)
        except _TransientReadError:
            raise CloudAsrError("云端口播提交结果未确认；为避免重复计费，未自动重发，请核对百炼任务与账单") from None
        request_id = payload.get("request_id")
        if isinstance(request_id, str) and _UUID.fullmatch(request_id):
            self._request_ids.append(request_id)
        output = self._task_output(payload)
        while output["task_status"] != "SUCCEEDED":
            self._sleep(deadline)
            output = self._task_output(self._get(Request(
                f"{origin}/api/v1/tasks/{self._task_id}", headers=headers, method="GET"
            ), deadline))
        result = output.get("result")
        result_url = self._result_url(result.get("transcription_url") if isinstance(result, dict) else None)
        # The signed result URL is already authorized. Never send our API key.
        return self._transcript(self._get(Request(result_url, method="GET"), deadline))

    def usage_summary(self) -> dict[str, Any]:
        complete = self._attempted == 0 or self._seconds is not None
        seconds = self._seconds if self._seconds is not None else (0 if self._attempted == 0 else None)
        beijing = self._endpoint_host == "dashscope.aliyuncs.com" or self._endpoint_host.endswith(".cn-beijing.maas.aliyuncs.com")
        pricing = dict(CLOUD_ASR_PRICING) if beijing else None
        cost = round(seconds * CLOUD_ASR_PRICING["perSecond"], 8) if complete and pricing is not None else None
        if self._attempted == 0:
            cost = 0.0
        return {
            "source": "cloud_asr",
            "provider": "Alibaba Cloud Model Studio",
            "model": CLOUD_ASR_MODEL,
            "attemptedRequestCount": self._attempted,
            "requestCount": int(self._seconds is not None),
            "audioSeconds": seconds,
            "estimatedCostCny": cost,
            "usageComplete": complete,
            "requestIds": list(self._request_ids),
            "taskIds": [self._task_id] if self._task_id else [],
            "pricing": pricing,
            "billingNote": (
                "按百炼返回的音频秒数与公开单价估算，实际费用以百炼账单为准。"
                if complete else "云端口播可能已被受理，但未收到完整用量；费用必须到百炼账单核对。"
            ),
        }
