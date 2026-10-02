"""Inspect and clean project-managed persistent media (no business data is removed).

Run with ``--inspect`` to print the manifest, ``--backup`` to make a consistent
SQLite copy, ``--purge`` to retire media registrations and delete the listed
files, and ``--verify`` to confirm the post-cleanup state. Every phase is
repeatable and reports failures item by item instead of claiming success.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from host_service.config import HostConfig  # noqa: E402
from host_service.database import utc_now  # noqa: E402

MEDIA_REPORT = "media-cleanup-report.json"


def _is_reparse_point(path: Path) -> bool:
    try:
        return bool(path.lstat().st_file_attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
    except (AttributeError, OSError):
        return path.is_symlink()


def _media_root(config: HostConfig) -> Path:
    return (config.data_dir / "media").resolve()


def _registered_paths(connection: sqlite3.Connection) -> dict[str, dict]:
    rows = connection.execute("SELECT video_id,status,relative_path,size_bytes FROM video_media").fetchall()
    return {str(row["video_id"]): dict(row) for row in rows}


def collect_manifest(config: HostConfig) -> dict:
    media_root = _media_root(config)
    known_video_ids = set()
    registered: dict[str, dict] = {}
    if config.db_path.is_file():
        connection = sqlite3.connect(config.db_path)
        connection.row_factory = sqlite3.Row
        try:
            known_video_ids = {str(row["id"]) for row in connection.execute("SELECT id FROM videos")}
            registered = _registered_paths(connection)
        finally:
            connection.close()
    files = []
    total = 0
    outside = []
    if media_root.is_dir():
        for entry in sorted(media_root.iterdir()):
            if _is_reparse_point(entry):
                outside.append({"name": entry.name, "reason": "重解析点/符号链接，拒绝跟随"})
                continue
            if not entry.is_file():
                outside.append({"name": entry.name, "reason": "不是普通文件，未纳入清理范围"})
                continue
            size = entry.stat().st_size
            total += size
            stem = entry.stem
            files.append({
                "name": entry.name,
                "bytes": size,
                "videoId": stem if stem.isdigit() else None,
                "registered": registered.get(stem, {}).get("status"),
                "videoExists": stem in known_video_ids,
            })
    return {
        "dataDir": str(config.data_dir),
        "mediaRoot": str(media_root),
        "fileCount": len(files),
        "totalBytes": total,
        "files": files,
        "skipped": outside,
        "registryCount": len(registered),
    }


def backup_database(config: HostConfig, label: str) -> Path:
    config.ensure_directories()
    destination = config.backup_dir / f"{label}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}.sqlite3"
    source = sqlite3.connect(config.db_path)
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    return destination


def purge(config: HostConfig, manifest: dict) -> dict:
    deleted = 0
    deleted_bytes = 0
    failures = []
    free_before = shutil.disk_usage(str(config.data_dir)).free
    for entry in manifest["files"]:
        path = Path(manifest["mediaRoot"]) / entry["name"]
        try:
            size = path.stat().st_size
            path.unlink()
            deleted += 1
            deleted_bytes += size
        except FileNotFoundError:
            deleted += 1
        except OSError as error:
            failures.append({"name": entry["name"], "error": type(error).__name__})
    with sqlite3.connect(config.db_path) as connection:
        connection.execute("DELETE FROM video_media")
        connection.commit()
    free_after = shutil.disk_usage(str(config.data_dir)).free
    return {
        "deletedFiles": deleted,
        "deletedBytes": deleted_bytes,
        "failedFiles": failures,
        "freeBytesBefore": free_before,
        "freeBytesAfter": free_after,
        "freeDeltaBytes": free_after - free_before,
        "cleanedAt": utc_now(),
    }


def verify(config: HostConfig) -> dict:
    media_root = _media_root(config)
    remaining = [entry.name for entry in media_root.iterdir()] if media_root.is_dir() else []
    with sqlite3.connect(config.db_path) as connection:
        counts = {
            "accounts": connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
            "videos": connection.execute("SELECT COUNT(*) FROM videos").fetchone()[0],
            "snapshots": connection.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0],
            "analysis_runs": connection.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0],
            "jobs": connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0],
            "video_media": connection.execute("SELECT COUNT(*) FROM video_media").fetchone()[0],
        }
    return {"remainingFiles": remaining, "counts": counts,
            "freeBytes": shutil.disk_usage(str(config.data_dir)).free}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--backup", action="store_true")
    parser.add_argument("--purge", action="store_true")
    parser.add_argument("--verify", action="store_true")
    arguments = parser.parse_args()
    config = HostConfig.from_env()
    report_path = Path(__file__).resolve().parents[1] / MEDIA_REPORT
    manifest = collect_manifest(config)
    if arguments.inspect:
        print(json.dumps({key: value for key, value in manifest.items() if key != "files"},
                         ensure_ascii=False, indent=2))
        print("sample =", json.dumps(manifest["files"][:3], ensure_ascii=False))
        report_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        print("manifest written =", report_path)
    if arguments.backup:
        print("backup =", backup_database(config, "pre-media-cleanup"))
    if arguments.purge:
        print("purge =", json.dumps(purge(config, manifest), ensure_ascii=False))
    if arguments.verify:
        print("verify =", json.dumps(verify(config), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
