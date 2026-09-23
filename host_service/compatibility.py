"""Version and capability gates shared by the host connector endpoints."""

from __future__ import annotations

import re
from typing import Any


MINIMUM_ANALYSIS_EXTENSION_VERSION = "0.9.7"
REQUIRED_ANALYSIS_CAPABILITY = "analyze_video"
CONNECTOR_FRESHNESS_SECONDS = 150
_ANALYSIS_CAPABILITY_ALIASES = frozenset(
    {REQUIRED_ANALYSIS_CAPABILITY, "analysis_capture", "analysis.video"}
)
_SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


def _parse_semver(value: Any) -> tuple[int, int, int, str | None] | None:
    if not isinstance(value, str):
        return None
    match = _SEMVER_PATTERN.fullmatch(value.strip())
    if not match:
        return None
    return int(match[1]), int(match[2]), int(match[3]), match[4]


def semver_at_least(version: Any, minimum: str) -> bool:
    candidate = _parse_semver(version)
    floor = _parse_semver(minimum)
    if not candidate or not floor:
        return False
    if candidate[:3] != floor[:3]:
        return candidate[:3] > floor[:3]
    candidate_prerelease = candidate[3]
    floor_prerelease = floor[3]
    if candidate_prerelease == floor_prerelease:
        return True
    if candidate_prerelease is None:
        return True
    if floor_prerelease is None:
        return False
    return candidate_prerelease >= floor_prerelease


def is_analysis_connector_compatible(version: Any, capabilities: Any) -> bool:
    normalized = capabilities if isinstance(capabilities, list) else []
    return semver_at_least(version, MINIMUM_ANALYSIS_EXTENSION_VERSION) and (
        REQUIRED_ANALYSIS_CAPABILITY in normalized
    )


def effective_connector_capabilities(version: Any, capabilities: Any) -> list[str]:
    normalized = list(
        dict.fromkeys(item for item in (capabilities or []) if isinstance(item, str) and item)
    ) if isinstance(capabilities, list) else []
    if is_analysis_connector_compatible(version, normalized):
        return normalized
    return [item for item in normalized if item not in _ANALYSIS_CAPABILITY_ALIASES]
