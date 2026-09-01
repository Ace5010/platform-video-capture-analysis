"""Focused checks for local transcript punctuation restoration."""

from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from local_asr.punctuation import restore_punctuation, restore_transcript_text  # noqa: E402


PUNCTUATION = "，。！？；：、…"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def run() -> None:
    segmented = restore_punctuation(
        [
            {"text": "今天我们来看一下", "start": 0.0, "end": 1.2},
            {"text": "这个功能为什么重要", "start": 1.55, "end": 3.0},
            {"text": "最后给大家一个结论", "start": 4.1, "end": 5.2},
        ]
    )
    require("今天我们来看一下，这个功能为什么重要。" in segmented, "segment pauses did not restore punctuation")
    require(segmented.endswith("。"), "segmented transcript must end with a sentence mark")
    require("，，" not in segmented and "。。" not in segmented, "duplicate punctuation was introduced")

    normalized = restore_transcript_text("这是第一句,这是第二句!这是第三句")
    require(normalized == "这是第一句，这是第二句！这是第三句。", "existing punctuation was not normalized")

    legacy = restore_transcript_text("如果你想提高效率那么首先要整理资料然后再开始工作但是不要一次做太多")
    require("，" in legacy and legacy.endswith("。"), "legacy transcript did not receive readable punctuation")
    require("如果你想提高效率" in legacy and "开始工作" in legacy, "legacy transcript words were changed")

    sparse_legacy = (
        "平时我们在手机里面搜索内容可以直接看到结果这些功能背后实际上都有一套共同的处理方式。"
        "但是旧的识别结果只有很少的句号所以整段内容看起来仍然像一堵文字墙需要再次补齐标点"
        "同时不能改写任何一个已经识别出来的字词或调整原来的先后顺序。"
    )
    readable = restore_transcript_text(sparse_legacy)
    source_characters = "".join(character for character in sparse_legacy if character not in PUNCTUATION and not character.isspace())
    output_characters = "".join(character for character in readable if character not in PUNCTUATION and not character.isspace())
    require(source_characters == output_characters, "legacy punctuation restoration changed recognized characters")
    require(sum(readable.count(mark) for mark in PUNCTUATION) >= 4, "sparse legacy transcript still lacks readable punctuation")
    require(not any(sequence in readable for sequence in ("。，", "？。", "！。", "，。")), "mixed punctuation was introduced")
    require(restore_transcript_text(readable) == readable, "legacy punctuation restoration must be idempotent")

    word_safe = restore_transcript_text(
        "手机可以听歌识曲也可以拾取拍照内容云盘存的是文件本身向量就像图书馆里面的书架"
        "这些内容需要完整保留不可以从中文词语中间插入逗号然后再展示给用户"
    )
    require("拾，取" not in word_safe and "书，架" not in word_safe, "punctuation split a Chinese word")

    print("Local ASR validation passed: segment pauses and legacy transcript text receive Chinese punctuation without word loss.")


if __name__ == "__main__":
    run()
