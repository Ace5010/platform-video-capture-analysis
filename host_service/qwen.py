"""Quality-first Qwen full-video client.

No keyframes, OCR proxy, transcript-only call, transcoding or downscaling exists
in this module.  Small files are sent as their complete Base64 data; larger
files are byte-for-byte uploaded to Bailian's 48-hour private temporary store.
"""

from __future__ import annotations

import base64
import http.client
import json
import mimetypes
import os
import socket
import ssl
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from .config import HostConfig


ANALYSIS_FIELDS = (
    "summary",
    "topic",
    "corePoint",
    "visualContent",
    "personActions",
    "onScreenText",
    "structureNarrative",
)

# Qwen3.8's documented maximums for video-file input. Sending the complete
# source file does not bypass the model's own frame sampler, so requests also
# declare the maximum visual budget instead of accepting its lower default
# per-frame resolution.
QWEN_VIDEO_MIN_PIXELS = 65_536
QWEN_VIDEO_MAX_PIXELS = 2_048_000
QWEN_VIDEO_TOTAL_PIXELS = 819_200_000

# Official qwen3.8-flash list prices for the endpoint used by this app
# (China North 2 / Beijing), checked 2026-08-31. Persist the rate snapshot with
# every run so future price changes never rewrite historical estimates.
QWEN38_FLASH_BEIJING_PRICING = {
    "currency": "CNY",
    "region": "cn-beijing",
    "inputPerMillion": 0.8,
    "cachedInputPerMillion": 0.1,
    "outputPerMillion": 2.7,
    "checkedAt": "2026-08-31",
    "source": "https://help.aliyun.com/zh/model-studio/qwen3-8-flash",
}


class QwenError(RuntimeError):
    pass


class QwenBudgetExceeded(QwenError):
    pass


class QwenNotConfigured(QwenError):
    pass


class QwenUploadLimitExceeded(QwenError):
    """The original bytes must be split without transcoding before upload."""

    def __init__(self, maximum_bytes: int, message: str = "视频超过百炼临时上传单文件上限") -> None:
        super().__init__(message)
        self.maximum_bytes = maximum_bytes


ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {field: {"type": "string", "minLength": 1} for field in ANALYSIS_FIELDS},
    "required": list(ANALYSIS_FIELDS),
    "additionalProperties": False,
}


SYSTEM_PROMPT = """你是严谨的视频内容分析员。你必须基于用户提供的完整原视频逐段理解实际画面，并结合原视频的本地口播识别稿，输出结构化内容分析。不要分析环境音、音乐、语气、开头钩子、高潮设计或结尾引导。不要猜测画面中没有发生的事。只输出符合 JSON Schema 的对象。"""


def validate_analysis(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != set(ANALYSIS_FIELDS):
        raise QwenError("AI 返回结构不完整，请重新分析")
    result: dict[str, str] = {}
    for field in ANALYSIS_FIELDS:
        item = value.get(field)
        if not isinstance(item, str) or not item.strip():
            raise QwenError(f"AI 返回字段 {field} 无效")
        if len(item) > 50_000:
            raise QwenError(f"AI 返回字段 {field} 异常过长")
        result[field] = item.strip()
    return result


def _safe_error_body(raw: bytes) -> str:
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace"))
        if isinstance(payload, dict):
            message = payload.get("message") or payload.get("error") or payload.get("code")
            if isinstance(message, dict):
                message = message.get("message") or message.get("code")
            if isinstance(message, str):
                return message[:600]
    except json.JSONDecodeError:
        pass
    return "千问接口返回错误"


def _is_budget_error(message: str) -> bool:
    lowered = message.lower()
    return any(
        token in lowered
        for token in (
            "context length",
            "context_length",
            "too long",
            "video duration",
            "total_pixels",
            "pixel budget",
            "maximum video",
            "token limit",
        )
    )


class QwenClient:
    def __init__(self, config: HostConfig, secret: dict[str, Any] | None) -> None:
        self.config = config
        self.secret = secret or {}
        self._usage_records: list[dict[str, Any]] = []
        self._model_request_attempts = 0
        self._usage_incomplete = False
        if config.mock_qwen and not config.testing:
            raise RuntimeError("Qwen Mock 只能在 DOUYIN_HOST_TESTING=1 时启用")

    @property
    def configured(self) -> bool:
        return bool(self.secret.get("apiKey")) or (self.config.testing and self.config.mock_qwen)

    def _api_key(self) -> str:
        key = self.secret.get("apiKey")
        if not isinstance(key, str) or not key.strip():
            raise QwenNotConfigured("尚未在主机页面配置千问 API Key")
        return key.strip()

    def _model(self) -> str:
        return str(self.secret.get("model") or self.config.qwen_model)

    def _endpoint(self) -> str:
        endpoint = str(self.secret.get("endpoint") or self.config.qwen_endpoint)
        parsed = urlsplit(endpoint)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not (
            hostname == "dashscope.aliyuncs.com" or hostname.endswith(".maas.aliyuncs.com")
        ):
            raise QwenError("千问接口地址必须是阿里云官方 HTTPS 域名")
        return endpoint

    @staticmethod
    def _usage_integer(value: Any) -> int:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _reported_usage_integer(value: Any) -> int | None:
        """Accept only provider-reported, non-negative integer token counts."""

        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return None
        return value

    def _record_usage(self, response: dict[str, Any]) -> bool:
        usage = response.get("usage")
        if not isinstance(usage, dict):
            self._usage_incomplete = True
            return False
        prompt_tokens = self._reported_usage_integer(usage.get("prompt_tokens"))
        completion_tokens = self._reported_usage_integer(usage.get("completion_tokens"))
        total_tokens = self._reported_usage_integer(usage.get("total_tokens"))
        if (
            prompt_tokens is None
            or completion_tokens is None
            or total_tokens is None
            or total_tokens != prompt_tokens + completion_tokens
            or total_tokens == 0
        ):
            self._usage_incomplete = True
            return False

        details_complete = True
        prompt_details = usage.get("prompt_tokens_details")
        if prompt_details is None:
            prompt_details = {}
        elif not isinstance(prompt_details, dict):
            details_complete = False
            prompt_details = {}
        completion_details = usage.get("completion_tokens_details")
        if completion_details is None:
            completion_details = {}
        elif not isinstance(completion_details, dict):
            details_complete = False
            completion_details = {}

        detail_values: dict[str, int] = {}
        for target, source, container in (
            ("videoTokens", "video_tokens", prompt_details),
            ("imageTokens", "image_tokens", prompt_details),
            ("audioTokens", "audio_tokens", prompt_details),
            ("textTokens", "text_tokens", prompt_details),
            ("cachedTokens", "cached_tokens", prompt_details),
            ("reasoningTokens", "reasoning_tokens", completion_details),
        ):
            raw_value = container.get(source)
            if raw_value is None:
                detail_values[target] = 0
                continue
            parsed_value = self._reported_usage_integer(raw_value)
            if parsed_value is None:
                details_complete = False
                detail_values[target] = 0
            else:
                detail_values[target] = parsed_value
        if detail_values["cachedTokens"] > prompt_tokens or detail_values["reasoningTokens"] > completion_tokens:
            details_complete = False
        if not details_complete:
            self._usage_incomplete = True

        self._usage_records.append(
            {
                "requestId": str(response.get("id") or "")[:256] or None,
                "model": str(response.get("model") or self._model())[:128],
                "promptTokens": prompt_tokens,
                "completionTokens": completion_tokens,
                "totalTokens": total_tokens,
                **detail_values,
            }
        )
        return details_complete

    def usage_summary(self) -> dict[str, Any]:
        """Return exact API token counts plus a clearly labeled list-price estimate."""

        records = list(self._usage_records)
        requested_model = self._model()
        response_models = sorted({str(item.get("model")) for item in records if item.get("model")})
        summary: dict[str, Any] = {
            "provider": "Alibaba Cloud Model Studio",
            "model": requested_model,
            "requestedModel": requested_model,
            "responseModels": response_models,
            "requestCount": len(records),
            "requestIds": [item["requestId"] for item in records if item.get("requestId")],
        }
        for field in (
            "promptTokens",
            "completionTokens",
            "totalTokens",
            "videoTokens",
            "imageTokens",
            "audioTokens",
            "textTokens",
            "cachedTokens",
            "reasoningTokens",
        ):
            summary[field] = sum(self._usage_integer(item.get(field)) for item in records)

        endpoint = str(self.secret.get("endpoint") or self.config.qwen_endpoint)
        endpoint_host = (urlsplit(endpoint).hostname or "").lower()
        summary["attemptedRequestCount"] = self._model_request_attempts
        summary["usageComplete"] = not self._usage_incomplete and self._model_request_attempts == len(records)
        if not summary["usageComplete"]:
            summary.update(
                {
                    "estimatedCostCny": None,
                    "pricing": dict(QWEN38_FLASH_BEIJING_PRICING) if requested_model == "qwen3.8-flash" and endpoint_host == "dashscope.aliyuncs.com" else None,
                    "billingNote": "模型请求可能已被服务端受理，但本机未收到完整用量；费用必须到百炼账单核对。",
                }
            )
            return summary
        if requested_model == "qwen3.8-flash" and endpoint_host == "dashscope.aliyuncs.com":
            pricing = dict(QWEN38_FLASH_BEIJING_PRICING)
            cached_tokens = min(summary["promptTokens"], summary["cachedTokens"])
            uncached_tokens = max(0, summary["promptTokens"] - cached_tokens)
            estimated_cost = (
                uncached_tokens * pricing["inputPerMillion"]
                + cached_tokens * pricing["cachedInputPerMillion"]
                + summary["completionTokens"] * pricing["outputPerMillion"]
            ) / 1_000_000
            summary.update(
                {
                    "estimatedCostCny": round(estimated_cost, 8),
                    "pricing": pricing,
                    "billingNote": "按官网原价估算；免费额度、套餐抵扣、活动优惠及账单舍入可能改变实际扣款。",
                }
            )
        else:
            summary.update(
                {
                    "estimatedCostCny": None,
                    "pricing": None,
                    "billingNote": "当前模型或地域没有内置单价快照，仅记录真实 Token；实际扣款请以百炼账单为准。",
                }
            )
        return summary

    def _json_request(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        payload: dict[str, Any] | None = None,
        timeout: int = 900,
        retry_network_once: bool = False,
    ) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if payload is not None else None
        request = Request(url, data=body, method=method, headers=headers)
        attempts = 2 if retry_network_once else 1
        for attempt in range(attempts):
            try:
                with urlopen(request, timeout=timeout) as response:
                    raw = response.read(4 * 1024 * 1024 + 1)
                    if len(raw) > 4 * 1024 * 1024:
                        raise QwenError("千问响应异常过大")
                    result = json.loads(raw.decode("utf-8"))
                    if not isinstance(result, dict):
                        raise QwenError("千问返回格式无效")
                    return result
            except HTTPError as error:
                raw = error.read(64 * 1024)
                message = _safe_error_body(raw)
                if error.code == 400 and _is_budget_error(message):
                    raise QwenBudgetExceeded("完整视频超过模型视觉预算") from error
                raise QwenError(f"千问接口失败（HTTP {error.code}）：{message}") from error
            except (TimeoutError, socket.timeout, URLError, ConnectionError) as error:
                if attempt + 1 < attempts:
                    time.sleep(0.3)
                    continue
                suffix = "" if attempts > 1 else "；为避免可能重复计费，未自动重发模型请求"
                raise QwenError(f"连接千问接口失败{suffix}") from error
            except json.JSONDecodeError as error:
                raise QwenError("千问返回了无效 JSON") from error
        raise QwenError("千问请求失败")

    def _get_upload_policy(self) -> dict[str, Any]:
        query = urlencode({"action": "getPolicy", "model": self._model()})
        result = self._json_request(
            f"{self.config.upload_policy_endpoint}?{query}",
            "GET",
            {"Authorization": f"Bearer {self._api_key()}", "Content-Type": "application/json"},
            timeout=60,
            retry_network_once=True,
        )
        policy = result.get("data")
        required = {
            "upload_dir",
            "upload_host",
            "oss_access_key_id",
            "signature",
            "policy",
            "x_oss_object_acl",
            "x_oss_forbid_overwrite",
        }
        if not isinstance(policy, dict) or not required.issubset(policy):
            raise QwenError("百炼临时上传凭证格式无效")
        host = urlsplit(str(policy["upload_host"]))
        if host.scheme != "https" or not (host.hostname or "").endswith(".aliyuncs.com"):
            raise QwenError("百炼返回了非官方上传地址")
        return policy

    def _upload_file(self, path: Path) -> str:
        if path.stat().st_size > 1024 * 1024 * 1024:
            raise QwenUploadLimitExceeded(
                1024 * 1024 * 1024,
                "视频超过百炼临时上传 1GB 上限，需要无损连续分段",
            )
        policy = self._get_upload_policy()
        policy_limit = policy.get("max_file_size_mb")
        if policy_limit is not None:
            try:
                if path.stat().st_size > int(policy_limit) * 1024 * 1024:
                    raise QwenUploadLimitExceeded(
                        max(8 * 1024 * 1024, int(policy_limit) * 1024 * 1024),
                        "视频超过当前百炼临时上传凭证的单文件上限，需要无损连续分段",
                    )
            except (TypeError, ValueError):
                pass
        boundary = f"----DouyinMonitor{uuid.uuid4().hex}"
        file_name = f"{uuid.uuid4().hex}{path.suffix or '.mp4'}"
        object_key = f"{str(policy['upload_dir']).rstrip('/')}/{file_name}"
        fields = [
            ("OSSAccessKeyId", str(policy["oss_access_key_id"])),
            ("Signature", str(policy["signature"])),
            ("policy", str(policy["policy"])),
            ("x-oss-object-acl", str(policy["x_oss_object_acl"])),
            ("x-oss-forbid-overwrite", str(policy["x_oss_forbid_overwrite"])),
            ("key", object_key),
            ("success_action_status", "200"),
        ]
        chunks: list[bytes] = []
        for name, value in fields:
            chunks.append(
                (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode("utf-8")
            )
        mime = mimetypes.guess_type(path.name)[0] or "video/mp4"
        file_header = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8")
        closing = f"\r\n--{boundary}--\r\n".encode("utf-8")
        content_length = sum(len(item) for item in chunks) + len(file_header) + path.stat().st_size + len(closing)
        upload_url = urlsplit(str(policy["upload_host"]))
        connection = http.client.HTTPSConnection(upload_url.hostname, upload_url.port or 443, timeout=900, context=ssl.create_default_context())
        try:
            connection.putrequest("POST", upload_url.path or "/")
            connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            connection.putheader("Content-Length", str(content_length))
            connection.putheader("Connection", "close")
            connection.endheaders()
            for chunk in chunks:
                connection.send(chunk)
            connection.send(file_header)
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    connection.send(chunk)
            connection.send(closing)
            response = connection.getresponse()
            try:
                response.read(64 * 1024)
                if response.status != 200:
                    raise QwenError(f"百炼临时视频上传失败（HTTP {response.status}）")
            finally:
                response.close()
        except (OSError, http.client.HTTPException, ssl.SSLError) as error:
            raise QwenError("百炼临时视频上传连接失败") from error
        finally:
            connection.close()
        return f"oss://{object_key}"

    def _video_reference(self, path: Path) -> tuple[str, bool]:
        if self.config.testing and self.config.mock_qwen:
            return "mock://complete-original-video", False
        if path.stat().st_size <= self.config.direct_base64_bytes:
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
            mime = mimetypes.guess_type(path.name)[0] or "video/mp4"
            if not mime.startswith("video/"):
                mime = "video/mp4"
            return f"data:{mime};base64,{encoded}", False
        return self._upload_file(path), True

    def _call(self, content: list[dict[str, Any]], prompt: str) -> dict[str, str]:
        if self.config.testing and self.config.mock_qwen:
            return validate_analysis(
                {
                    "summary": "测试摘要：完整视频分析 Mock 已执行。",
                    "topic": "测试选题",
                    "corePoint": "测试核心观点",
                    "visualContent": "测试画面内容",
                    "personActions": "测试人物行为",
                    "onScreenText": "测试字幕与画面文字",
                    "structureNarrative": "测试结构与叙事逻辑",
                }
            )
        request_content = [*content, {"type": "text", "text": prompt}]
        endpoint = self._endpoint()
        api_key = self._api_key()
        model = self._model()
        self._model_request_attempts += 1
        try:
            response = self._json_request(
                endpoint,
                "POST",
                {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "X-DashScope-OssResourceResolve": "enable",
                },
                {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": request_content},
                    ],
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {"name": "video_analysis", "strict": True, "schema": ANALYSIS_SCHEMA},
                    },
                    # Qwen3.8-Flash supports JSON Schema in thinking mode. Keep
                    # thinking enabled for content-analysis quality and use the
                    # documented minimum visual temperature explicitly.
                    "enable_thinking": True,
                    "temperature": 0.6,
                },
                timeout=1200,
                # A timeout can happen after the provider accepted the request.
                # Never resubmit a billable full-video inference automatically.
                retry_network_once=False,
            )
        except QwenBudgetExceeded:
            # A visual-budget rejection is still a provider attempt with no
            # complete usage receipt. Keep it in the immutable cost audit.
            self._usage_incomplete = True
            raise
        except QwenError:
            self._usage_incomplete = True
            raise
        self._record_usage(response)
        try:
            content_value = response["choices"][0]["message"]["content"]
            if isinstance(content_value, str):
                parsed = json.loads(content_value)
            else:
                parsed = content_value
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
            raise QwenError("千问返回内容不是严格 JSON") from error
        return validate_analysis(parsed)

    def analyze_video(self, path: Path, transcript: str, metadata: dict[str, Any]) -> dict[str, str]:
        video_reference, _temporary = self._video_reference(path)
        prompt = (
            "请完整分析所附原视频。以下本地口播识别稿只用于补足视频模型不读取音轨的问题，"
            "不能替代画面分析。\n"
            f"视频标题：{str(metadata.get('title') or '')[:4000]}\n"
            f"正文文案：{str(metadata.get('description') or '')[:12000]}\n"
            f"原视频口播稿：{transcript or '（未检测到清晰口播）'}\n"
            "分别给出：摘要、选题、核心观点、画面内容、人物行为、字幕及画面文字、内容结构和叙事逻辑。"
        )
        return self._call([self._video_content(video_reference, metadata)], prompt)

    def prepare_video(self, path: Path) -> str:
        """Prepare the complete original file while local ASR runs in parallel."""
        return self._video_reference(path)[0]

    def analyze_prepared_video(
        self, video_reference: str, transcript: str, metadata: dict[str, Any]
    ) -> dict[str, str]:
        return self.analyze_prepared_videos([video_reference], transcript, metadata)

    def analyze_prepared_videos(
        self, video_references: list[str], transcript: str, metadata: dict[str, Any]
    ) -> dict[str, str]:
        if not video_references or len(video_references) > 64:
            raise QwenError("完整视频分段数量无效")
        prompt = (
            "请完整分析所附原视频。以下本地口播识别稿只用于补足视频模型不读取音轨的问题，"
            "不能替代画面分析。\n"
            f"视频标题：{str(metadata.get('title') or '')[:4000]}\n"
            f"正文文案：{str(metadata.get('description') or '')[:12000]}\n"
            f"原视频口播稿：{transcript or '（未检测到清晰口播）'}\n"
            "分别给出：摘要、选题、核心观点、画面内容、人物行为、字幕及画面文字、内容结构和叙事逻辑。"
        )
        return self._call(
            [self._video_content(reference, metadata) for reference in video_references],
            prompt,
        )

    def _video_content(self, reference: str, metadata: dict[str, Any]) -> dict[str, Any]:
        """Build a quality-first full-video input within Qwen3.8 limits.

        At the 2,048,000-pixel per-frame maximum, Qwen's 819,200,000 total
        pixel budget fits 400 full-detail frames. For short videos we use the
        API's 10 fps maximum; for longer videos we reduce only the provider's
        sampling frequency enough to retain the maximum permitted detail per
        sampled frame. The complete original file is still the model input.
        """

        fps = float(self.config.qwen_fps)
        raw_duration = metadata.get("durationSeconds")
        try:
            duration = float(raw_duration)
        except (TypeError, ValueError):
            duration = 0.0
        if duration > 0:
            full_detail_frames = QWEN_VIDEO_TOTAL_PIXELS / QWEN_VIDEO_MAX_PIXELS
            fps = min(fps, max(0.1, full_detail_frames / duration))
        return {
            "type": "video_url",
            "video_url": {"url": reference},
            "fps": round(fps, 3),
            "min_pixels": QWEN_VIDEO_MIN_PIXELS,
            "max_pixels": QWEN_VIDEO_MAX_PIXELS,
            "total_pixels": QWEN_VIDEO_TOTAL_PIXELS,
        }

    def analyze_segments(
        self, segments: list[Path], transcript: str, metadata: dict[str, Any]
    ) -> dict[str, str]:
        segment_results: list[dict[str, str]] = []
        for index, segment in enumerate(segments):
            reference, _temporary = self._video_reference(segment)
            prompt = (
                f"这是原视频按时间连续、无损切分后的第 {index + 1}/{len(segments)} 段。"
                "请只分析本段真实内容；口播稿是全片识别结果，只用于辅助辨识，不可替代本段画面。\n"
                f"标题：{str(metadata.get('title') or '')[:4000]}\n"
                f"正文：{str(metadata.get('description') or '')[:12000]}\n"
                f"全片口播稿：{transcript or '（未检测到清晰口播）'}"
            )
            segment_results.append(
                self._call(
                    [self._video_content(reference, metadata)],
                    prompt,
                )
            )
        integration_prompt = (
            "下面是同一个原视频各连续无损分段的完整视觉分析。请按时间顺序合并，消除重复，"
            "保持具体事实，不新增未观察内容。请以 JSON Schema 输出最终全片分析。\n"
            + json.dumps(segment_results, ensure_ascii=False)
        )
        return self._call([], integration_prompt)
