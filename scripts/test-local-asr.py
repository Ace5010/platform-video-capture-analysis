"""Focused checks for local transcript punctuation restoration."""

from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from local_asr.punctuation import restore_punctuation, restore_transcript_text  # noqa: E402


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

    print("Local ASR validation passed: segment pauses and legacy transcript text receive Chinese punctuation without word loss.")


if __name__ == "__main__":
    run()

