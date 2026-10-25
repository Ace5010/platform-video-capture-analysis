"""Full native video via the installed, logged-in CodeBuddy process.

Only the child request formatter is adapted. Official CLI authentication,
destination, model routing, and billing remain intact. No keyframes or OCR.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from typing import Any

from .config import HostConfig
from .media import sha256_file
from .qwen import (QwenClient, QwenError, QwenUploadLimitExceeded,
                   QwenAnalysisValidationError, SYSTEM_PROMPT, ANALYSIS_SECTIONS,
                   analysis_schema_for_sections, requested_analysis_sections, validate_analysis)

MODELS = ("minimax-m3", "minimax-m3.1-flash")
MAX_INLINE_VIDEO_BYTES = 40 * 1024 * 1024
MODEL_QUOTA_CODES = {6003, 6004, 6007, 6008, 14019}
ACCOUNT_CODES = {14001, 14012, 14013, 14014, 14015, 14016, 14017, 14018}


def codebuddy_cli(config: HostConfig) -> Path:
    runtime = Path(os.environ.get("OBSERVE_WECHAT_RUNTIME_ROOT") or Path(__file__).resolve().parents[2] / "WeChat-Reader")
    return runtime / "buddy-runtime/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"


def quota_exhausted(report: dict[str, Any]) -> bool:
    """Only explicit provider rejection, never a model-generated error string."""
    codes = set(report.get("errorCodes") or [])
    rejected = any(item.get("type") == "video_response" and item.get("status") == 429 for item in report.get("wire", []))
    return rejected and not codes.intersection(ACCOUNT_CODES) and bool(codes.intersection(MODEL_QUOTA_CODES))


def _amount(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


class CodeBuddyClient(QwenClient):
    """Reuse existing full-video prompts, schema checks and lossless integration."""
    def __init__(self, config: HostConfig, secret: dict[str, Any] | None = None) -> None:
        super().__init__(config, None)
        self.model = MODELS[0]
        self.attempts: list[dict[str, Any]] = []
        self._integration_dir: Path | None = None

    @property
    def configured(self) -> bool:
        return codebuddy_cli(self.config).is_file() and shutil.which("node") is not None

    def _model(self) -> str:
        return self.model

    def prepare_video(self, path: Path) -> str:
        target = path.resolve()
        if not target.is_relative_to(self.config.temp_dir.resolve()) or not target.is_file():
            raise QwenError("CodeBuddy 视频输入必须来自当前任务临时目录")
        if target.stat().st_size > MAX_INLINE_VIDEO_BYTES:
            raise QwenUploadLimitExceeded(MAX_INLINE_VIDEO_BYTES, "完整视频需要按 CodeBuddy 输入上限无损连续分段")
        if not target.stat().st_size:
            raise QwenError("完整视频文件为空")
        self._integration_dir = target.parent
        return str(target)

    def _video_reference(self, path: Path) -> tuple[str, bool]:
        return self.prepare_video(path), False

    def analyze_prepared_videos(self, video_references, transcript, metadata):
        if len(video_references) > 1:
            return self.analyze_segments([Path(path) for path in video_references], transcript, metadata)
        return super().analyze_prepared_videos(video_references, transcript, metadata)

    def _execute(self, payload: dict[str, Any]) -> dict[str, Any]:
        script = Path(__file__).resolve().parents[1] / "scripts/codebuddy-video-worker.mjs"
        process = subprocess.Popen([shutil.which("node") or "node", str(script)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                   start_new_session=os.name != "nt")
        deadline = time.monotonic() + 600
        try:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            while True:
                if self.check_cancelled:
                    self.check_cancelled()
                if time.monotonic() >= deadline:
                    raise QwenError("CodeBuddy 视频分析超时；调用结果及扣费待核对，不自动重发")
                try:
                    stdout, _ = process.communicate(input=data, timeout=1)
                    break
                except subprocess.TimeoutExpired:
                    data = None
            try:
                return json.loads(stdout)
            except (ValueError, TypeError) as error:
                raise QwenError("CodeBuddy 未返回完整执行回执；扣费待核对，不自动重发") from error
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=15)

    def _call(self, content, prompt, requested_sections=None):
        if self.check_cancelled:
            self.check_cancelled()
        if not self.configured:
            raise QwenError("CodeBuddy 运行组件缺失，请检查微信模块的已登录 CLI")
        sections = requested_analysis_sections(requested_sections)
        system = SYSTEM_PROMPT
        if sections != ANALYSIS_SECTIONS:
            system = SYSTEM_PROMPT.rsplit("\n", 1)[0] + "\n本次仅输出以下规范中的缺失分区：\n" + json.dumps(analysis_schema_for_sections(sections), ensure_ascii=False)
        paths = [Path(item["video_url"]["url"]) for item in content if item.get("type") == "video_url"]
        if len(paths) > 1:
            raise QwenError("CodeBuddy 完整视频必须按连续分段顺序分析")
        video = paths[0] if paths else None
        if video:
            self.prepare_video(video)
            contract = analysis_schema_for_sections(sections)
            contract = {**contract, "properties": {**contract["properties"], "_videoInputObserved": {"type": "boolean"}},
                        "required": [*contract["required"], "_videoInputObserved"]}
            system = system.rsplit("\n", 1)[0] + (
                "\n本次输出采用以下完整规范。在根对象增加 _videoInputObserved 布尔值：仅实际看到视频画面时填 true；"
                "没有接收到画面时填 false，禁止根据口播稿、标题或文件名猜测画面。\n"
                + json.dumps(contract, ensure_ascii=False))
        folder = self._integration_dir
        if folder is None:
            raise QwenError("视频输入上下文缺失，已停止文字替代分析")
        for selected in MODELS[MODELS.index(self.model):]:
            self.model = selected
            attempt = {"model": selected, "status": "submitting", "credits": None, "elapsedSeconds": None}
            self.attempts.append(attempt)
            self._model_request_attempts += 1
            try:
                if self.progress_callback:
                    self.progress_callback({"phase": "request", "model": selected})
            except Exception:
                # A cancelled/failed persistence checkpoint precedes HTTP.
                self.attempts.pop()
                self._model_request_attempts -= 1
                raise
            started = time.monotonic()
            try:
                report = self._execute({"cli": str(codebuddy_cli(self.config)), "taskDir": str(folder),
                                        "model": selected, "prompt": prompt, "systemPrompt": system,
                                        "videoPath": str(video) if video else None,
                                        "sha256": sha256_file(video) if video else None})
            except Exception:
                attempt.update(status="outcome_unknown", elapsedSeconds=round(time.monotonic() - started, 3))
                raise
            attempt.update(elapsedSeconds=report.get("elapsedSeconds"), status="failed",
                           errorCodes=report.get("errorCodes") or [])
            records = report.get("records") or []
            for row in records:
                if not isinstance(row, dict) or not isinstance(row.get("usage"), dict):
                    continue
                self._record_usage({"id": row.get("requestId"), "model": row.get("model"), "usage": row["usage"]})
            charges = [_amount(row.get("usage", {}).get("credit")) for row in records]
            if charges and all(value is not None for value in charges):
                attempt["credits"] = round(sum(charges), 6)
            if video:
                sent = [event for event in report.get("wire", []) if event.get("type") == "video_request"]
                if len(sent) != 1 or sent[0].get("videoSha256") != sha256_file(video):
                    raise QwenError("CodeBuddy 未确认完整视频传输，已停止，不保存文字替代结果")
                attempt["videoInput"] = {key: sent[0].get(key) for key in ("videoBytes", "videoSha256", "model")}
            if quota_exhausted(report) and selected != MODELS[-1]:
                attempt["status"] = "quota_exhausted"
                self.model = MODELS[-1]
                if self.progress_callback:
                    self.progress_callback({"phase": "fallback", "model": self.model})
                continue
            if not report.get("complete"):
                if set(report.get("errorCodes") or []).intersection(ACCOUNT_CODES):
                    raise QwenError("CodeBuddy 账户额度或登录状态异常，请在 CodeBuddy 核对后重试")
                raise QwenError("CodeBuddy 分析未完成；请核对登录、额度或执行回执，不自动重发")
            attempt["status"] = "complete"
            if self.progress_callback:
                self.progress_callback({"phase": "content", "model": selected})
            value = report.get("result")
            try:
                if isinstance(value, str):
                    value = value.strip()
                    if value.startswith("```") and value.endswith("```"):
                        value = value.split("\n", 1)[1].rsplit("```", 1)[0].strip()
                    value = json.loads(value)
                if video and (not isinstance(value, dict) or value.pop("_videoInputObserved", None) is not True):
                    raise QwenError("CodeBuddy 模型未确认读到视频画面，已保留用量并停止保存分析")
                return validate_analysis(value, sections)
            except QwenAnalysisValidationError:
                raise
            except (ValueError, TypeError) as error:
                raise QwenAnalysisValidationError("CodeBuddy 返回内容未通过 JSON 结构校验", sections) from error
        raise QwenError("视频分析模型额度已用尽，请稍后再试")

    def usage_summary(self):
        rows = list(self._usage_records)
        summary = {"provider": "CodeBuddy", "model": self.model, "requestedModel": MODELS[0],
                   "responseModels": sorted({str(row["model"]) for row in rows}),
                   "requestCount": len(rows), "attemptedRequestCount": self._model_request_attempts,
                   "requestIds": [row["requestId"] for row in rows if row.get("requestId")],
                   "providerAttempts": [dict(row) for row in self.attempts],
                   "estimatedCostCny": None, "pricing": None,
                   "billingNote": "CodeBuddy 按官方回执记录积分；云端口播另按人民币计费。"}
        for field in ("promptTokens", "completionTokens", "totalTokens", "videoTokens", "imageTokens", "audioTokens", "textTokens", "cachedTokens", "reasoningTokens"):
            summary[field] = sum(row.get(field, 0) for row in rows)
        complete = not self._usage_incomplete and len(rows) == self._model_request_attempts
        summary["usageComplete"] = complete
        known = sum(row["credits"] for row in self.attempts if row["credits"] is not None)
        summary["knownCredits"] = round(known, 6)
        summary["credits"] = round(known, 6) if complete and all(row["credits"] is not None for row in self.attempts) else None
        return summary


def analysis_client(config: HostConfig, secret=None):
    return CodeBuddyClient(config) if config.analysis_provider == "codebuddy" else QwenClient(config, secret)
