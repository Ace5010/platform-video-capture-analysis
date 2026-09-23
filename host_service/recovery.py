"""Bounded recovery and safe diagnostics shared by analysis and its browser."""
from __future__ import annotations

import re
from typing import Any
from local_asr.server import ApiError


class AnalysisCancelled(RuntimeError):
    pass


def safe_error(error: Any) -> str:
    """Do not persist URLs, request headers, tokens, or opaque credentials."""
    value = str(error) if isinstance(error, (str, ValueError, RuntimeError, OSError, ApiError)) else type(error).__name__
    value = re.sub(r"(?i)(?:https?|oss)://[^\s\"'<>]+", "[地址已隐藏]", value)
    # Whole header tail (including JSON-like quoted keys) is intentionally
    # removed: cookie values commonly contain spaces and many semicolons.
    value = re.sub(r"(?im)[\"']?(?:cookie|set-cookie|authorization|x-api-key)[\"']?\s*[:=].*$", "[敏感请求头已隐藏]", value)
    value = re.sub(r"(?i)[\"']?(?:api[_ -]?key|access[_ -]?token|token|signature|credential|password)[\"']?\s*[:=]\s*([\"']).*?\1", "[凭据已隐藏]", value)
    value = re.sub(r"(?i)(?:bearer\s+|sk-)[a-z0-9._~+/-]+", "[凭据已隐藏]", value)
    value = re.sub(r"(?i)(?:api[_ -]?key|access[_ -]?token|token|signature|credential|password)\s*[\"']?\s*[:=].*$", "[凭据已隐藏]", value)
    return value[:1500] or "未知错误，根因尚未确定"


def requires_user_action(error: Any) -> bool:
    # CDN 403/404 may be an expired signed address: reacquire it. Only an
    # explicit page/configuration observation is a terminal access decision.
    value = str(error)
    return any(marker in value for marker in (
        "视频已删除", "作品已删除", "作品不存在", "无访问权限", "该视频为私密", "必须重新登录",
        "登录已失效", "请先登录", "需要完成验证码", "磁盘空间不足", "超过主机安全上限", "缺少 ff",
    ))


def user_action_for(error: Any, stage: str) -> str:
    value = str(error)
    if any(word in value for word in ("登录", "验证码", "私密", "访问权限")):
        return "在电脑的抖音登录窗口核对登录、验证码与该视频的访问权限，再重试。"
    if any(word in value for word in ("删除", "不存在")):
        return "打开原视频核对作品是否仍公开可访问。"
    if any(word in value for word in ("计费", "账单", "提交结果未确认", "断流", "超时")) and stage in {"model", "cloud_asr"}:
        return "先在百炼核对原请求或任务与账单；提交状态不确定时不会自动重发。"
    if stage == "save":
        return "检查主机磁盘空间和数据库文件权限；不要删除数据库。"
    return "可复制诊断信息排查；根因尚未确定时请先核对原视频与电脑主机状态。"
