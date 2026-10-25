"""Isolated checks for the 72-hour discovery window and follower observations.

Uses a temporary database and synthetic collection events. No real capture,
browser, paid model or production data is involved.
"""

from __future__ import annotations

import sys
import tempfile
import time
import uuid
from dataclasses import replace
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from host_service.config import HostConfig  # noqa: E402
from host_service.database import DISCOVERY_TTL_SECONDS, Database  # noqa: E402

CONNECTOR_ID = "host-dedicated-browser"
FAILURES: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


def video(video_id: str, *, like: int = 1, published: str = "2026-09-20T00:00:00.000Z") -> dict:
    return {
        "id": video_id, "accountId": "account-a", "title": f"作品 {video_id}",
        "description": f"作品 {video_id}", "url": f"https://www.douyin.com/video/{video_id}",
        "coverUrl": "https://p.douyinpic.com/cover.jpeg", "publishedAt": published,
        "durationSeconds": 30, "likeCount": like, "commentCount": 0,
        "favoriteCount": 0, "shareCount": 0,
    }


def account_payload(mode: str, videos: list[dict], *, followers: dict | None = None,
                    completed: str = "2026-10-01T00:00:00.000Z") -> dict:
    account = {"id": "account-a", "platform": "douyin", "url": "https://www.douyin.com/user/a",
               "name": "账号 A"}
    if followers is not None:
        account.update(followers)
    return {
        "accountId": "account-a", "mode": mode, "account": account, "videos": videos,
        "completedAt": completed,
    }


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="douyin-discoveries-") as temporary:
        root = Path(temporary)
        base = HostConfig.from_env()
        config = replace(base, data_dir=root, db_path=root / "monitor.sqlite3",
            secret_path=root / "secret.dpapi", temp_dir=root / "tmp",
            backup_dir=root / "backups", testing=True)
        database = Database(config)
        database.initialize()
        database.pair_connector(CONNECTOR_ID, "电脑专用浏览器", CONNECTOR_ID, "x" * 64,
                                "0.9.7", ["collect_latest", "archive_account", "analyze_video"],
                                "worker-1")
        database.upsert_account({"id": "account-a", "platform": "douyin",
                                 "url": "https://www.douyin.com/user/a", "name": "账号 A"})

        def emit(event_id: str, mode: str, payload: dict) -> None:
            """Deliver one collection event through a real claimed host job.

            Discovery recording only happens for an executed ``latest`` check, so
            the events carry the same job identity the production queue uses.
            """
            job, created = database.create_job("collect_latest",
                                               {"accountIds": ["account-a"],
                                                "idempotencyKey": f"fixture-{event_id}-{uuid.uuid4().hex}"})
            claimed = database.claim_job(CONNECTOR_ID, ["collect_latest", "archive_account", "analyze_video"])
            if claimed is None or claimed["id"] != job["id"]:
                raise AssertionError(
                    f"fixture job was not claimed for {event_id}: created={created} "
                    f"job={job['id']}/{job['status']} claimed={claimed and claimed['id']}")
            database.process_connector_event(CONNECTOR_ID, job["id"], claimed["claimToken"], event_id,
                                             "collection_result", {**payload, "mode": mode})
            database.process_connector_event(CONNECTOR_ID, job["id"], claimed["claimToken"],
                                             f"{event_id}:completed", "job_completed", {})

        # ---- archive import never enters the window -------------------------
        history = [video(f"70000000000000000{index}") for index in range(3)]
        emit("archive-1", "initial", account_payload("initial", history))
        items, counts = database.recent_discoveries()
        require(items == [] and counts == {}, "an initial archive import must not create discoveries")
        require(len(database.state()["videos"]) == 3, "archive videos must still be saved")

        # ---- a live check registers only what is genuinely new --------------
        fresh = video("7530000000000000001")
        emit("latest-1", "latest", account_payload("latest", [fresh, *history[:2]]))
        items, counts = database.recent_discoveries()
        require([item["videoId"] for item in items] == [fresh["id"]],
                f"only the new work may be registered, got {[item['videoId'] for item in items]}")
        require(counts == {"account-a": 1}, f"per-account count is wrong: {counts}")
        first_discovered = items[0]["discoveredAt"]
        require(items[0]["expiresAt"] > items[0]["discoveredAt"], "expiry must follow the discovery time")

        # ---- a snapshot-only refresh must not extend or duplicate -----------
        emit("latest-2", "latest", account_payload("latest", [video(fresh["id"], like=999), *history[:2]],
                                                   completed="2026-10-01T01:00:00.000Z"))
        items, _ = database.recent_discoveries()
        require([item["videoId"] for item in items] == [fresh["id"]], "a snapshot refresh must not add entries")
        require(items[0]["discoveredAt"] == first_discovered, "a repeated check must not reset the window")

        # ---- a repeated event id is ignored entirely ------------------------
        emit("latest-1", "latest", account_payload("latest", [fresh, *history[:2]]))
        items, _ = database.recent_discoveries()
        require(len(items) == 1, "a duplicate event must not double count")

        # ---- further checks append; older entries survive -------------------
        second = video("7530000000000000002")
        third = video("7530000000000000003")
        emit("latest-3", "latest", account_payload("latest", [third, second, fresh, *history[:2]],
                                                   completed="2026-10-02T10:00:00.000Z"))
        items, counts = database.recent_discoveries()
        require([item["videoId"] for item in items] == [third["id"], second["id"], fresh["id"]],
                f"discoveries must accumulate newest first, got {[item['videoId'] for item in items]}")
        require(counts == {"account-a": 3}, f"accumulated count is wrong: {counts}")

        # ---- a zero-new check keeps everything ------------------------------
        emit("latest-4", "latest", account_payload("latest", [third, second, fresh, *history[:2]],
                                                   completed="2026-10-02T11:00:00.000Z"))
        items, _ = database.recent_discoveries()
        require(len(items) == 3, "a check with no new works must keep existing entries")

        # ---- an old release date still enters the window --------------------
        old_but_new = video("7530000000000000004", published="2024-01-01T00:00:00.000Z")
        emit("latest-5", "latest", account_payload("latest", [old_but_new, third, second, fresh, *history[:2]],
                                                   completed="2026-10-02T12:00:00.000Z"))
        items, _ = database.recent_discoveries()
        require(items[0]["videoId"] == old_but_new["id"],
                "a newly discovered work must enter even with an old release date")
        require(len(items) == 4, "the previously discovered works must remain")

        # ---- the window is measured on server time, not the release date ----
        now = int(time.time())
        just_inside = DISCOVERY_TTL_SECONDS - 1
        items, _ = database.recent_discoveries(now_epoch=now)
        require(len(items) == 4, "entries inside the window must be listed")
        items, _ = database.recent_discoveries(now_epoch=now + DISCOVERY_TTL_SECONDS * 4)
        require(items == [], "entries must leave the window once 72 hours have passed")

        # ---- expiry only ends browsing eligibility -------------------------
        database.purge_expired_discoveries()
        items, _ = database.recent_discoveries()
        require(len(items) == 4, "a lazy purge must not remove valid records")
        state = database.state()
        require(len(state["videos"]) == len(history) + 4, "expiring a discovery must not delete a work")
        require(state["discoveries"][0]["videoId"] == old_but_new["id"], "/api/state must expose discoveries")

        # ---- follower observations replace the whole field group ------------
        observed = [old_but_new, third, second, fresh, *history[:2]]
        emit("followers-1", "latest", account_payload("latest", observed,
            followers={"followerCount": 123456, "followerDisplayText": "123456",
                       "followerCountIsApproximate": False,
                       "followerCountCapturedAt": "2026-10-03T00:00:00.000Z"},
            completed="2026-10-03T00:00:00.000Z"))
        saved = next(item for item in database.state()["accounts"] if item["id"] == "account-a")
        require(saved["followerCount"] == 123456, "an exact follower reading must be saved")
        require(saved["followerCountIsApproximate"] is False, "an exact reading is not approximate")

        # An approximate reading must not leave the older exact integer behind.
        emit("followers-2", "latest", account_payload("latest", observed,
            followers={"followerCount": None, "followerDisplayText": "12.3万",
                       "followerCountIsApproximate": True,
                       "followerCountCapturedAt": "2026-10-03T01:00:00.000Z"},
            completed="2026-10-03T01:00:00.000Z"))
        saved = next(item for item in database.state()["accounts"] if item["id"] == "account-a")
        require(saved["followerCount"] is None, "an approximate reading must clear the stale exact value")
        require(saved["followerDisplayText"] == "12.3万", "the abbreviated text must be kept")
        require(saved["followerCountIsApproximate"] is True, "the approximation flag must be stored")

        # A delayed older snapshot cannot overwrite the newer observation.
        database.upsert_account({"id": "account-a", "followerCount": 111,
            "followerDisplayText": "111", "followerCountIsApproximate": False,
            "followerCountCapturedAt": "2026-10-02T00:00:00.000Z"})
        saved = next(item for item in database.state()["accounts"] if item["id"] == "account-a")
        require(saved["followerDisplayText"] == "12.3万", "a late older response must not overwrite newer data")

        # A capture without a follower observation keeps the stored values.
        emit("followers-3", "latest", account_payload("latest", observed,
            completed="2026-10-03T02:00:00.000Z"))
        saved = next(item for item in database.state()["accounts"] if item["id"] == "account-a")
        require(saved["followerDisplayText"] == "12.3万", "a capture without followers must keep the last reading")
        require(saved["followerCountCapturedAt"] == "2026-10-03T01:00:00.000Z",
                "a capture without followers must keep the original observation time")

        # A real zero is a valid observation and survives the None-skipping merge.
        emit("followers-4", "latest", account_payload("latest", observed,
            followers={"followerCount": 0, "followerDisplayText": "0",
                       "followerCountIsApproximate": False,
                       "followerCountCapturedAt": "2026-10-03T03:00:00.000Z"},
            completed="2026-10-03T03:00:00.000Z"))
        saved = next(item for item in database.state()["accounts"] if item["id"] == "account-a")
        require(saved["followerCount"] == 0, "a real zero must be stored as zero")
        require(saved["followerCountIsApproximate"] is False, "zero is not an approximation")

        # ---- link analysis never pollutes the window ------------------------
        before = len(database.recent_discoveries()[0])
        database.upsert_link_video("7530000000000000009", "https://www.douyin.com/video/7530000000000000009",
                                   "https://www.douyin.com/video/7530000000000000009")
        require(len(database.recent_discoveries()[0]) == before,
                "a link-analysis submission must not enter the discovery window")

        # ---- realtime media state is no longer a download queue -------------
        state = database.state()
        require(all(item["mediaStatus"] == "online" for item in state["videos"]),
                "a missing local copy is the normal state for on-demand playback")
        connection = database.connect()
        try:
            tables = {row["name"] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            connection.close()
        require("video_media" not in tables, "the retired media registry must be dropped on migration")

        # ---- dismiss notifications, preserving all saved business data -----
        displayed_ids = [item["videoId"] for item in database.recent_discoveries()[0]]
        concurrent = video("7530000000000000010")
        emit("concurrent-discovery", "latest", account_payload("latest", [concurrent, *observed]))
        with database.transaction() as connection:
            database._upsert_video(connection, {"id": fresh["id"], "accountId": "account-a",
                "transcript": "保存的完整口播。", "analysis": {"saved": True},
                "analysisUsage": {"estimatedCostCny": 0.2}})
        history_job, _ = database.create_job("analyze_video", {"accountId": "account-a",
            "videoId": fresh["id"], "analysisVersion": "clear-fixture"})
        database.save_analysis_failure(history_job["id"], "隔离测试的历史记录")
        with closing(database.connect()) as connection:
            preserved = {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY id")]
                for table in ("accounts", "videos", "snapshots", "analysis_runs", "jobs")}
            receipts = [tuple(row) for row in connection.execute("SELECT * FROM processed_events ORDER BY event_id")]
            markers = {row["video_id"]: dict(row) for row in connection.execute("SELECT * FROM collection_discoveries")}
        require(database.clear_discoveries(displayed_ids) == 4, "clear must dismiss the complete displayed list")
        items, counts = database.recent_discoveries()
        require([item["videoId"] for item in items] == [concurrent["id"]] and counts == {"account-a": 1},
                "a discovery received after the click must remain visible")
        require(database.clear_discoveries(displayed_ids) == 0, "repeating a clear must be idempotent")
        require(database.clear_discoveries([]) == 0, "an empty clear must be harmless")
        with closing(database.connect()) as connection:
            for table, before_rows in preserved.items():
                require([tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY id")] == before_rows,
                        f"clear must preserve every {table} row, including transcripts, analysis and costs")
            require([tuple(row) for row in connection.execute("SELECT * FROM processed_events ORDER BY event_id")] == receipts,
                    "clear must preserve event receipts")
            for row in connection.execute("SELECT * FROM collection_discoveries"):
                before_row = markers[row["video_id"]]
                require(all(row[key] == value for key, value in before_row.items() if key != "cleared_at"),
                        "clear must preserve marker timestamps and provenance")
                require(bool(row["cleared_at"]) == (row["video_id"] in displayed_ids),
                        "only requested markers may be marked cleared")
        for invalid in (None, "all", [concurrent["id"], "bad-id"], [True], [concurrent["id"]] * 501):
            try:
                database.clear_discoveries(invalid)
                require(False, "invalid clear input must be rejected")
            except ValueError:
                pass
        require(len(database.recent_discoveries()[0]) == 1, "invalid input must not partially clear a valid entry")
        emit("clear-recheck", "latest", account_payload("latest", [concurrent, *observed]))
        emit("latest-1", "latest", account_payload("latest", [fresh, *history[:2]]))
        require([item["videoId"] for item in database.recent_discoveries()[0]] == [concurrent["id"]],
                "rechecking or replaying an old event must not restore a cleared notification")
        reopened = Database(config)
        reopened.initialize()
        require([item["videoId"] for item in reopened.state()["discoveries"]] == [concurrent["id"]],
                "clear must survive database reopen and page reload")
        next_work = video("7530000000000000011")
        emit("after-clear", "latest", account_payload("latest", [next_work, concurrent, *observed]))
        require([item["videoId"] for item in database.recent_discoveries()[0]] == [next_work["id"], concurrent["id"]],
                "a later genuinely new work must still appear")

        # Rebuild only this isolated fixture's markers in the pre-clear schema.
        # Additive migration must keep every legacy row and leave it visible.
        with database.transaction() as connection:
            legacy_rows = [tuple(row) for row in connection.execute(
                "SELECT account_id,video_id,discovered_at,origin_job_id,origin_event_id,origin FROM collection_discoveries")]
            connection.execute("DROP TABLE collection_discoveries")
            connection.execute("CREATE TABLE collection_discoveries (account_id TEXT NOT NULL,video_id TEXT NOT NULL,"
                "discovered_at REAL NOT NULL,origin_job_id TEXT,origin_event_id TEXT,origin TEXT NOT NULL DEFAULT 'manual_latest',"
                "PRIMARY KEY(account_id,video_id))")
            connection.executemany("INSERT INTO collection_discoveries VALUES(?,?,?,?,?,?)", legacy_rows)
        reopened.initialize()
        with closing(reopened.connect()) as connection:
            migrated_rows = [tuple(row)[:-1] for row in connection.execute("SELECT * FROM collection_discoveries")]
            require(migrated_rows == legacy_rows, "migration must keep every legacy marker field")
            require(all(row["cleared_at"] is None for row in connection.execute("SELECT * FROM collection_discoveries")),
                    "legacy discoveries must not be dismissed during migration")
        require(len(reopened.recent_discoveries()[0]) == 6, "migration must keep legacy discovery eligibility")

        # ---- removing an account clears its entries -------------------------
        database.remove_account("account-a")
        items, counts = database.recent_discoveries()
        require(items == [] and counts == {}, "removing an account must clear its discovery entries")


run()
if FAILURES:
    print("Collection discoveries failed:")
    for failure in FAILURES:
        print(f" - {failure}")
    raise SystemExit(1)
print("Collection discoveries passed: 72-hour window, append-only, idempotency, archive/link exclusion, "
      "follower field group, late responses, real zero, persistent clear, concurrency, data preservation, "
      "legacy migration, retired media state and account removal.")
