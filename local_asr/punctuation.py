"""Local punctuation restoration for Chinese ASR output.

The recognizer remains the source of every word. A local CT-Transformer only
predicts punctuation; its output is rejected unless the non-punctuation
characters exactly match the recognizer text. No transcript leaves the host.
"""

from __future__ import annotations

import os
import re
import threading
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


_PUNCTUATION_TRANSLATION = str.maketrans(
    {
        ",": "，",
        ".": "。",
        "!": "！",
        "?": "？",
        ";": "；",
        ":": "：",
    }
)
_PUNCTUATION = frozenset("，。！？；：、")
_SENTENCE_END = frozenset("。！？；")
_CLAUSE_MARKERS = (
    "也就是说",
    "换句话说",
    "这意味着",
    "除此之外",
    "与此同时",
    "但是",
    "不过",
    "所以",
    "因此",
    "然后",
    "同时",
    "而且",
    "另外",
    "其实",
    "如果",
    "因为",
    "那么",
    "接下来",
    "最后",
    "首先",
    "其次",
)
_PUNCTUATOR: Any | None = None
_PUNCTUATOR_FAILED = False
_PUNCTUATOR_LOCK = threading.Lock()
_PUNCTUATOR_RUN_LOCK = threading.Lock()


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).replace("\u200b", "").replace("\ufeff", "")
    text = text.translate(_PUNCTUATION_TRANSLATION)
    text = text.replace("……", "…")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s*([，。！？；：、…])\s*", r"\1", text)
    # Chinese ASR sometimes inserts spaces between adjacent Han characters
    # while leaving useful spaces around Latin words and numbers intact.
    text = re.sub(r"(?<=[\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])", "", text)
    # A punctuation model can occasionally append a mark next to one already
    # inferred from an ASR pause. Keep the stronger sentence mark and discard
    # only the impossible mixed sequence (for example "。，" or "？。").
    text = re.sub(r"([。！？；])[，。！？；：、]+", r"\1", text)
    text = re.sub(r"[，：、]+([。！？；])", r"\1", text)
    text = re.sub(r"([，。！？；：、])\1+", r"\1", text)
    return text


def _ends_with_punctuation(text: str) -> bool:
    return bool(text) and text[-1] in _PUNCTUATION.union({"…"})


def _segment_value(segment: Any, key: str) -> Any:
    if isinstance(segment, Mapping):
        return segment.get(key)
    return getattr(segment, key, None)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def punctuation_model_path() -> Path:
    configured = (os.environ.get("DOUYIN_PUNCTUATION_MODEL") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parents[1] / "data" / "models" / "punctuation" / "model.int8.onnx"


def _get_local_punctuator() -> Any | None:
    global _PUNCTUATOR, _PUNCTUATOR_FAILED
    if _PUNCTUATOR is not None:
        return _PUNCTUATOR
    if _PUNCTUATOR_FAILED:
        return None
    with _PUNCTUATOR_LOCK:
        if _PUNCTUATOR is not None:
            return _PUNCTUATOR
        model_path = punctuation_model_path()
        if not model_path.is_file():
            _PUNCTUATOR_FAILED = True
            return None
        try:
            import sherpa_onnx

            config = sherpa_onnx.OfflinePunctuationConfig(
                model=sherpa_onnx.OfflinePunctuationModelConfig(
                    ct_transformer=str(model_path),
                    num_threads=2,
                    debug=False,
                    provider="cpu",
                )
            )
            _PUNCTUATOR = sherpa_onnx.OfflinePunctuation(config)
        except (ImportError, RuntimeError, ValueError, OSError):
            _PUNCTUATOR_FAILED = True
            return None
    return _PUNCTUATOR


def _recognized_characters(text: str) -> str:
    return "".join(
        character
        for character in text
        if character not in _PUNCTUATION and character != "…" and not character.isspace()
    )


def _has_readable_punctuation(text: str) -> bool:
    """Avoid running the model repeatedly over an already restored transcript."""

    plain_length = len(_recognized_characters(text))
    if plain_length == 0:
        return True
    mark_count = sum(text.count(mark) for mark in _PUNCTUATION.union({"…"}))
    longest_run = max(
        (len(_recognized_characters(part)) for part in re.split(r"[，。！？；：、…]", text)),
        default=plain_length,
    )
    minimum_marks = max(1, (plain_length + 59) // 60)
    return mark_count >= minimum_marks and longest_run <= 48


def _restore_with_local_model(text: str) -> str | None:
    punctuator = _get_local_punctuator()
    if punctuator is None:
        return None
    # Keep punctuation inferred from ASR segment pauses. CT-Transformer accepts
    # existing marks and fills the gaps around them; stripping them here would
    # throw away the recognizer's stronger timing signal.
    if not text.strip():
        return None
    try:
        with _PUNCTUATOR_RUN_LOCK:
            restored = _clean_text(punctuator.add_punctuation(text))
    except (RuntimeError, ValueError, OSError):
        return None
    if _recognized_characters(restored) != _recognized_characters(text):
        return None
    return restored


def _insert_clause_marks(text: str, minimum_prefix: int = 8) -> str:
    """Add commas before discourse markers, including in lightly punctuated text."""

    if not text:
        return text
    result: list[str] = []
    cursor = 0
    run_length = 0
    while cursor < len(text):
        marker = next((item for item in _CLAUSE_MARKERS if text.startswith(item, cursor)), None)
        if marker:
            if run_length >= minimum_prefix and result and result[-1] not in _PUNCTUATION:
                result.append("，")
                run_length = 0
            result.append(marker)
            run_length += len(marker)
            cursor += len(marker)
            continue
        character = text[cursor]
        result.append(character)
        run_length = 0 if character in _PUNCTUATION or character == "…" else run_length + 1
        cursor += 1
    return "".join(result)


def restore_transcript_text(text: str | None) -> str:
    """Restore punctuation locally without changing recognized characters."""

    cleaned = _clean_text(text)
    if not cleaned:
        return ""
    if not _has_readable_punctuation(cleaned):
        restored = _restore_with_local_model(cleaned)
        cleaned = restored if restored is not None else _insert_clause_marks(cleaned)
    if not _ends_with_punctuation(cleaned):
        cleaned = f"{cleaned}。"
    return cleaned


def restore_punctuation(segments: Iterable[Any]) -> str:
    """Restore punctuation using ASR segment text, timing gaps, and boundaries."""

    output = ""
    previous_end: float | None = None
    for segment in segments:
        text = _clean_text(_segment_value(segment, "text"))
        if not text:
            continue
        start = _number(_segment_value(segment, "start"))
        end = _number(_segment_value(segment, "end"))
        if output and not _ends_with_punctuation(output):
            gap = start - previous_end if start is not None and previous_end is not None else None
            if gap is not None and gap >= 0.85:
                output += "。"
            elif gap is not None and gap >= 0.25:
                output += "，"
            elif len(output) - max(output.rfind(mark) for mark in _SENTENCE_END) >= 36:
                output += "，"
        output += text
        previous_end = end if end is not None else previous_end

    return restore_transcript_text(output)
