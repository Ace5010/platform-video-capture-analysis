"""Lightweight punctuation restoration for local Chinese ASR output.

The recognizer remains the source of the words.  This module only restores
readable Chinese punctuation from segment boundaries and pauses; it does not
call a remote model or rewrite the recognized wording.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
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


def _insert_clause_marks(text: str, minimum_prefix: int = 8) -> str:
    """Add commas before clear discourse markers in an unsegmented transcript."""

    if not text or any(mark in text for mark in _PUNCTUATION):
        return text
    result: list[str] = []
    cursor = 0
    last_break = 0
    while cursor < len(text):
        marker = next((item for item in _CLAUSE_MARKERS if text.startswith(item, cursor)), None)
        if marker and cursor - last_break >= minimum_prefix:
            result.append(text[last_break:cursor].rstrip())
            result.append("，")
            last_break = cursor
            cursor += len(marker)
            continue
        cursor += 1
    result.append(text[last_break:])
    return "".join(result)


def restore_transcript_text(text: str | None) -> str:
    """Normalize an already concatenated transcript and guarantee punctuation."""

    cleaned = _clean_text(text)
    if not cleaned:
        return ""
    if not any(mark in cleaned for mark in _PUNCTUATION):
        cleaned = _insert_clause_marks(cleaned)
        # Without segment timing, split very long clauses at the nearest comma
        # so an older saved transcript remains readable instead of one wall of
        # text. The words and their order are unchanged.
        if "，" in cleaned:
            pieces = cleaned.split("，")
            rebuilt: list[str] = []
            current: list[str] = []
            current_length = 0
            for piece in pieces:
                if current and current_length + 1 + len(piece) >= 42:
                    rebuilt.append("".join(current) + "。")
                    current = []
                    current_length = 0
                if current:
                    current.append("，")
                    current_length += 1
                current.append(piece)
                current_length += len(piece)
            if current:
                rebuilt.append("".join(current))
            cleaned = "".join(rebuilt)
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
