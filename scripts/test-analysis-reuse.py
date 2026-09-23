"""Cloud speech/retry regression: full video, parallel work, errors and billing."""
import sys
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service import analysis as module
from host_service.config import HostConfig


def check(saved, expected_reuse, *, failure=None, speechless=False):
    with tempfile.TemporaryDirectory(prefix="douyin-analysis-reuse-") as directory:
        root = Path(directory)
        config = replace(HostConfig.from_env(), data_dir=root, temp_dir=root / "tmp", testing=True)
        database = Mock()
        database.get_video.return_value = saved
        client = Mock()
        upload_started = threading.Event()
        asr_started = threading.Event()

        def upload(path):
            assert path.read_bytes() == b"complete-video"
            upload_started.set()
            if not expected_reuse and not speechless:
                assert asr_started.wait(3), "cloud ASR was not parallel with upload"
            if failure == "upload":
                raise RuntimeError("上传失败")
            return "mock://complete"

        client.prepare_video.side_effect = upload
        def complete_analysis(*_args):
            client.progress_callback({"phase": "reasoning"})
            client.progress_callback({"phase": "content"})
            return {"contentAnalysis": "fixture"}

        client.analyze_prepared_videos.side_effect = complete_analysis
        client.usage_summary.return_value = {"requestCount": 1, "usageComplete": True, "estimatedCostCny": 0.1}
        cloud = Mock()

        def transcribe(path):
            assert path.read_bytes() == b"complete-video"
            asr_started.set()
            assert upload_started.wait(3), "upload was not parallel with cloud ASR"
            if failure == "asr":
                raise RuntimeError("云端口播识别失败")
            return "新识别的口播。"

        cloud.transcribe.side_effect = transcribe
        cloud.usage_summary.return_value = {"audioSeconds": 12, "requestCount": 1, "usageComplete": failure != "asr", "estimatedCostCny": None if failure == "asr" else 0.00264}
        manager = module.AnalysisManager(config, database, SimpleNamespace(load=lambda: None))
        try:
            with patch.object(module, "download_media", side_effect=lambda url, path, *args, **kwargs: path.write_bytes(b"complete-video")) as download, \
                 patch.object(module, "probe_media", return_value={"streams": [{"codec_type": "video"}, {"codec_type": "audio"}], "format": {"duration": "12"}}), \
                 patch.object(module, "QwenClient", return_value=client), \
                 patch.object(module, "prepare_cloud_audio", side_effect=lambda path, *_args: None if speechless else path), \
                 patch.object(module, "CloudAsrClient", return_value=cloud):
                manager._run("fixture-job", {"videoId": "1234567890", "videoUrl": "https://test.douyinvod.com/video.mp4"})
                assert download.call_args.kwargs["expected_video_id"] == "1234567890"
                assert cloud.transcribe.call_count == (0 if expected_reuse or speechless else 1)
                expected = saved["transcript"].strip() if expected_reuse else "" if speechless else "新识别的口播。"
                assert database.save_analysis_transcript.call_count == (0 if expected_reuse or speechless or failure == "asr" else 1)
                if failure:
                    database.save_analysis_failure.assert_called_once()
                    database.save_analysis_success.assert_not_called()
                    client.analyze_prepared_videos.assert_not_called()
                    failure_args = database.save_analysis_failure.call_args.args
                    assert failure_args[2] == (expected if failure == "upload" else None)
                    assert failure_args[3]["cloudAsr"] == cloud.usage_summary.return_value
                    assert not list(config.temp_dir.iterdir())
                    return
                assert client.analyze_prepared_videos.call_args.args[:2] == (["mock://complete"], expected)
                database.save_analysis_success.assert_called_once()
                database.save_analysis_failure.assert_not_called()
                stages = [call.args[1] for call in database.update_job_progress.call_args_list]
                assert "qwen_reasoning" in stages and "qwen_receiving_output" in stages
                assert ("cloud_asr_and_secure_upload" in stages) == (not expected_reuse)
                usage = database.save_analysis_success.call_args.args[4]
                if not expected_reuse and not speechless:
                    assert usage["totalEstimatedCostCny"] == 0.10264
                    assert usage["cloudAsr"]["audioSeconds"] == 12
                else:
                    assert "cloudAsr" not in usage
                assert not list(config.temp_dir.iterdir()), "temporary media was retained"
        finally:
            manager.shutdown()


ready = {"id": "1234567890", "transcriptStatus": "ready", "transcript": "已经完成的口播。"}
check(ready, True)
check(None, False)
check({**ready, "id": "9999999999"}, False)
check({**ready, "transcriptStatus": "error"}, False)
check({**ready, "transcript": ""}, True)
check({**ready, "transcript": "  "}, True)
check({**ready, "transcript": None}, False)
check(None, False, failure="asr")
check(None, False, failure="upload")
check(None, False, speechless=True)
print("Cloud pipeline passed: parallel upload/ASR, same-video reuse, wrong-target rejection, ASR/upload failure, billing, no-audio, full-video input and cleanup.")

# Recovery regressions share this existing isolated pipeline test command.
import json
import sqlite3
import unittest
from contextlib import ExitStack
from host_service.database import Database
from host_service.qwen import QwenError, QwenPartialAnalysisError, mock_analysis
from host_service.recovery import safe_error


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="douyin-recovery-")
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.config = replace(HostConfig.from_env(), data_dir=root, db_path=root / "isolated.sqlite3", temp_dir=root / "tmp", testing=True)
        self.database = Database(self.config)
        self.database.initialize()
        self.video_id = "7530000000000000099"
        video = self.database.upsert_link_video(self.video_id, f"https://www.douyin.com/video/{self.video_id}", "fixture")
        self.payload = {"accountId": video["accountId"], "videoId": self.video_id, "sourceKind": "video_link"}
        self.job, _ = self.database.create_job("analyze_video", self.payload)
        self.manager = module.AnalysisManager(self.config, self.database, SimpleNamespace(load=lambda: None))
        self.addCleanup(self.manager.shutdown)
        self.plan = mock_analysis()
        self.client = Mock()
        self.client.prepare_video.return_value = "mock://uploaded-complete-video"
        self.client.analyze_prepared_videos.return_value = self.plan
        self.client.usage_summary.return_value = {"attemptedRequestCount": 1, "requestCount": 1, "usageComplete": True, "estimatedCostCny": .1}
        self.cloud = Mock()
        self.cloud.transcribe.return_value = "完整口播，不删改文字。"
        self.cloud.usage_summary.return_value = {"attemptedRequestCount": 1, "audioSeconds": 12, "usageComplete": True, "estimatedCostCny": .00264}
        self.capture_count = 0
        self.capture = Mock(side_effect=self.media)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.download = self.stack.enter_context(patch.object(module, "download_media", side_effect=lambda _url, path, *_args, **_kwargs: path.write_bytes(b"complete-video")))
        self.probe = self.stack.enter_context(patch.object(module, "probe_media", return_value={"streams": [{"codec_type": "video"}, {"codec_type": "audio"}], "format": {"duration": "12"}}))
        self.stack.enter_context(patch.object(module, "prepare_cloud_audio", side_effect=lambda path, *_args: path))
        self.stack.enter_context(patch.object(module, "QwenClient", return_value=self.client))
        self.stack.enter_context(patch.object(module, "CloudAsrClient", return_value=self.cloud))
        self.stack.enter_context(patch.object(self.manager, "_wait", side_effect=lambda job, _seconds: self.manager._check_cancelled(job)))

    def media(self, *_args, **_kwargs):
        self.capture_count += 1
        return {**self.payload, "videoUrl": f"https://test.douyinvod.com/fresh-{self.capture_count}.mp4",
                "videoMetadata": {"title": "标题", "coverUrl": "https://example.com/cover", "authorName": "作者", "authorAvatarUrl": "https://example.com/avatar", "authorProfileUrl": "https://www.douyin.com/user/test"},
                "mediaMeta": {"page": {"durationSeconds": 12, "observedVideoId": self.video_id}}}

    def run_job(self):
        self.manager._run(self.job["id"], self.payload, capture_media=self.capture)
        self.assertEqual(list(self.config.temp_dir.iterdir()), [], "temporary media survived terminal cleanup")
        return self.database.get_job(self.job["id"])

    def seed(self, *, analysis=None, transcript="已有口播。"):
        if transcript is not None:
            self.database.save_analysis_transcript(self.job["id"], transcript, {})
        if analysis:
            self.database.save_analysis_checkpoint(self.job["id"], analysis, {}, "old-hash")

    def test_capture_fails_twice_then_third_continues_once(self):
        errors = iter([RuntimeError("首轮播放器尚未就绪"), RuntimeError("次轮媒体地址尚未就绪")])
        def capture(*args, **kwargs):
            error = next(errors, None)
            if error:
                raise error
            return self.media(*args, **kwargs)
        self.capture.side_effect = capture
        with patch.object(self.database, "update_job_progress", wraps=self.database.update_job_progress) as progress:
            result = self.run_job()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.capture.call_count, 3)
        self.assertEqual(self.download.call_count, 1)
        self.client.analyze_prepared_videos.assert_called_once()
        messages = [call.kwargs.get("message") for call in progress.call_args_list]
        self.assertIn("正在重新获取视频，尝试 2/3", messages)
        self.assertIn("正在重新获取视频，尝试 3/3", messages)

    def test_download_failure_reopens_target_and_gets_fresh_address(self):
        count = 0
        def download(_url, path, *_args, **_kwargs):
            nonlocal count
            count += 1
            if count < 3:
                raise RuntimeError("完整视频 CDN 返回 HTTP 403")
            path.write_bytes(b"complete-video")
        self.download.side_effect = download
        self.assertEqual(self.run_job()["status"], "succeeded")
        self.assertEqual(self.capture.call_count, 3)
        self.assertEqual(len({call.args[0] for call in self.download.call_args_list}), 3)
        self.assertTrue(all(call.kwargs["expected_video_id"] == self.video_id for call in self.download.call_args_list))

    def test_incomplete_media_restarts_capture(self):
        self.probe.side_effect = [RuntimeError("文件不完整"), RuntimeError("文件不完整"), self.probe.return_value]
        self.assertEqual(self.run_job()["status"], "succeeded")
        self.assertEqual(self.capture.call_count, 3)

    def test_three_failures_stop_and_preserve_history_with_safe_diagnostics(self):
        self.seed(analysis=self.plan)
        self.capture.side_effect = RuntimeError("下载失败 https://cdn.example/video?token=FAKE_PRIVATE\nCookie: session=FAKE_PRIVATE")
        result = self.run_job()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.capture.call_count, 3)
        diagnostics = result["result"]["diagnostics"]
        self.assertEqual(diagnostics["attemptCount"], 3)
        self.assertEqual(len(diagnostics["attempts"]), 3)
        self.assertIn("transcript", diagnostics["completedSteps"])
        self.assertIn("content", diagnostics["completedSteps"])
        self.assertNotIn("FAKE_PRIVATE", json.dumps(diagnostics))
        self.assertEqual(self.database.get_video(self.video_id)["analysis"], self.plan)
        self.cloud.transcribe.assert_not_called()
        self.client.analyze_prepared_videos.assert_not_called()

    def test_known_deleted_video_stops_after_one_attempt(self):
        self.capture.side_effect = RuntimeError("视频已删除")
        result = self.run_job()
        self.assertEqual(self.capture.call_count, 1)
        self.assertEqual(result["result"]["diagnostics"]["attemptCount"], 1)

    def test_cancel_during_retry_wait_prevents_next_capture(self):
        self.capture.side_effect = RuntimeError("播放器尚未加载")
        def cancel(job, _seconds):
            self.database.cancel_job(job)
            self.manager._check_cancelled(job)
        self.manager._wait.side_effect = cancel
        result = self.run_job()
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["result"]["diagnostics"]["captureAttemptCount"], 1)
        self.assertEqual(self.capture.call_count, 1)

    def test_cancel_before_execution_never_acquires_media(self):
        self.database.cancel_job(self.job["id"])
        self.assertEqual(self.run_job()["status"], "cancelled")
        self.capture.assert_not_called()

    def test_upload_recovery_reuses_valid_media_and_completed_asr(self):
        self.client.prepare_video.side_effect = [RuntimeError("暂时上传失败"), RuntimeError("暂时上传失败"), "mock://uploaded"]
        self.assertEqual(self.run_job()["status"], "succeeded")
        self.assertEqual(self.capture.call_count, 1)
        self.assertEqual(self.client.prepare_video.call_count, 3)
        self.cloud.transcribe.assert_called_once()

    def test_model_uncertain_timeout_is_never_resent(self):
        self.client.analyze_prepared_videos.side_effect = QwenError("视频模型请求超时；请核对账单")
        result = self.run_job()
        self.assertEqual(result["status"], "failed")
        self.client.analyze_prepared_videos.assert_called_once()
        self.assertEqual(self.database.get_video(self.video_id)["transcriptStatus"], "ready")
        self.assertEqual(result["result"]["diagnostics"]["failedStage"], "model")

    def test_partial_finished_result_repairs_only_failed_section(self):
        content = {"schemaVersion": self.plan["schemaVersion"], "contentAnalysis": self.plan["contentAnalysis"]}
        remotion = {key: value for key, value in self.plan.items() if key != "contentAnalysis"}
        seen = []
        def model(_refs, _transcript, metadata):
            seen.append(list(metadata["requestedSections"]))
            if len(seen) == 1:
                raise QwenPartialAnalysisError(content, ["contentAnalysis"], {"remotion": "制作字段不完整"})
            self.assertEqual(self.database.get_video(self.video_id)["analysis"]["contentAnalysis"], content["contentAnalysis"])
            return remotion
        self.client.analyze_prepared_videos.side_effect = model
        self.assertEqual(self.run_job()["status"], "succeeded")
        self.assertEqual(seen, [["contentAnalysis", "remotion"], ["remotion"]])
        self.assertEqual(self.capture.call_count, 1)
        self.assertEqual(self.database.get_video(self.video_id)["analysis"], self.plan)

    def test_partial_repair_failure_keeps_completed_content(self):
        content = {"schemaVersion": self.plan["schemaVersion"], "contentAnalysis": self.plan["contentAnalysis"]}
        self.client.analyze_prepared_videos.side_effect = [QwenPartialAnalysisError(content, ["contentAnalysis"], {"remotion": "制作字段不完整"}), QwenError("第二次请求超时，费用待核对")]
        result = self.run_job()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.client.analyze_prepared_videos.call_count, 2)
        diagnostics = result["result"]["diagnostics"]
        self.assertEqual(diagnostics["attemptCount"], 2)
        self.assertEqual([item["attempt"] for item in diagnostics["attempts"] if item["stage"] == "model"], [1, 2])
        self.assertEqual(diagnostics["lastError"], "第二次请求超时，费用待核对")
        self.assertEqual(self.capture.call_count, 1)
        self.assertEqual(self.database.get_video(self.video_id)["analysis"], content)

    def test_save_retries_never_regenerate_paid_result(self):
        original = self.database.save_analysis_success
        count = 0
        def save(*args):
            nonlocal count
            count += 1
            if count < 3:
                raise sqlite3.OperationalError("database is locked")
            return original(*args)
        with patch.object(self.database, "save_analysis_success", side_effect=save):
            self.assertEqual(self.run_job()["status"], "succeeded")
        self.assertEqual(count, 3)
        self.client.analyze_prepared_videos.assert_called_once()

    def test_exhausted_save_keeps_pending_result_and_replays_only_persistence(self):
        with patch.object(self.database, "save_analysis_success", side_effect=sqlite3.OperationalError("database is locked")):
            self.assertEqual(self.run_job()["status"], "failed")
        pending = list((self.config.data_dir / "pending-analysis-results").glob("*.json"))
        self.assertEqual(len(pending), 1)
        self.assertNotIn("douyinvod", pending[0].read_text(encoding="utf-8"))
        self.assertEqual(self.manager.recover_pending_results(), 1)
        self.assertEqual(self.database.get_job(self.job["id"])["status"], "succeeded")
        self.client.analyze_prepared_videos.assert_called_once()

    def test_metadata_save_failure_never_restarts_capture(self):
        with patch.object(self.database, "save_analysis_media_metadata", side_effect=sqlite3.OperationalError("database is locked")):
            self.assertEqual(self.run_job()["status"], "failed")
        self.assertEqual(self.capture.call_count, 1)
        self.client.analyze_prepared_videos.assert_not_called()

    def test_old_pending_recovery_keeps_newer_success_and_recovers_old_receipt(self):
        # A receives its paid result but SQLite cannot save it. B then
        # succeeds before the service restarts and replays A's pending file.
        with patch.object(self.database, "save_analysis_success", side_effect=sqlite3.OperationalError("database is locked")):
            self.assertEqual(self.run_job()["status"], "failed")
        newer, created = self.database.create_job("analyze_video", {**self.payload, "retry": True, "forceRegenerate": True})
        self.assertTrue(created)
        newer_plan = {**self.plan, "contentAnalysis": {**self.plan["contentAnalysis"], "quickOverview": "后续任务的新内容结论"}}
        newer_usage = {"estimatedCostCny": .2, "usageComplete": True, "requestCount": 1}
        self.database.save_analysis_success(newer["id"], "后续任务的新口播。", newer_plan, "newer-source-hash", newer_usage)
        before = self.database.get_video(self.video_id)
        self.assertEqual(self.manager.recover_pending_results(), 1)
        after = self.database.get_video(self.video_id)
        for key in ("analysis", "transcript", "analysisUsage", "sourceHash", "analysisUpdatedAt", "transcriptUpdatedAt", "analysisStatus"):
            self.assertEqual(after[key], before[key], f"old pending result replaced newer {key}")
        old_run = next(run for run in after["analysisRuns"] if run["jobId"] == self.job["id"])
        self.assertEqual(old_run["status"], "succeeded")
        self.assertEqual(old_run["usage"]["estimatedCostCny"], .1)
        with self.database.transaction() as connection:
            old = connection.execute("SELECT analysis_json,source_hash FROM analysis_runs WHERE job_id=?", (self.job["id"],)).fetchone()
        self.assertEqual(json.loads(old["analysis_json"]), self.plan)
        self.assertNotEqual(old["source_hash"], "newer-source-hash")
        self.assertEqual(list((self.config.data_dir / "pending-analysis-results").glob("*.json")), [])
        self.client.analyze_prepared_videos.assert_called_once()

    def test_partial_checkpoint_save_failure_has_durable_result_without_new_call(self):
        content = {"schemaVersion": self.plan["schemaVersion"], "contentAnalysis": self.plan["contentAnalysis"]}
        self.client.analyze_prepared_videos.side_effect = QwenPartialAnalysisError(content, ["contentAnalysis"], {"remotion": "制作字段不完整"})
        with patch.object(self.database, "save_analysis_checkpoint", side_effect=sqlite3.OperationalError("database is locked")):
            result = self.run_job()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["result"]["diagnostics"]["failedStage"], "save")
        self.client.analyze_prepared_videos.assert_called_once()
        self.assertEqual(self.manager.recover_pending_results(), 1)
        self.assertEqual(self.database.get_video(self.video_id)["analysis"], content)

    def test_cancelled_in_flight_model_retains_late_result_and_receipt(self):
        def model(*_args):
            self.database.cancel_job(self.job["id"])
            return self.plan
        self.client.analyze_prepared_videos.side_effect = model
        self.assertEqual(self.run_job()["status"], "cancelled")
        video = self.database.get_video(self.video_id)
        self.assertEqual(video["analysis"], self.plan)
        self.assertEqual(video["analysisRuns"][0]["status"], "cancelled")
        self.assertTrue(video["analysisRuns"][0]["usage"])

    def test_only_missing_transcript_does_not_call_video_model_or_upload(self):
        self.seed(analysis=self.plan, transcript=None)
        self.assertEqual(self.run_job()["status"], "succeeded")
        self.cloud.transcribe.assert_called_once()
        self.client.prepare_video.assert_not_called()
        self.client.analyze_prepared_videos.assert_not_called()
        self.assertEqual(self.database.get_video(self.video_id)["analysis"], self.plan)

    def test_explicit_force_regenerates_two_sections_but_reuses_transcript(self):
        self.seed(analysis=self.plan)
        self.payload["forceRegenerate"] = True
        self.assertEqual(self.run_job()["status"], "succeeded")
        self.client.analyze_prepared_videos.assert_called_once()
        self.assertEqual(self.client.analyze_prepared_videos.call_args.args[2]["requestedSections"], ["contentAnalysis", "remotion"])
        self.cloud.transcribe.assert_not_called()

    def test_optional_content_details_do_not_trigger_model_backfill(self):
        concise_plan = {**self.plan, "contentAnalysis": {
            key: "作者说明按项目整理收藏夹的方法。" if key == "quickOverview" else ""
            for key in self.plan["contentAnalysis"]
        }}
        self.seed(analysis=concise_plan)
        self.assertEqual(self.run_job()["status"], "succeeded")
        self.client.prepare_video.assert_not_called()
        self.client.analyze_prepared_videos.assert_not_called()
        self.cloud.transcribe.assert_not_called()
        self.assertEqual(self.database.get_video(self.video_id)["analysis"], concise_plan)

    def test_failed_force_preserves_complete_old_analysis(self):
        self.seed(analysis=self.plan)
        self.payload["forceRegenerate"] = True
        self.client.analyze_prepared_videos.side_effect = QwenError("模型请求超时，请核对账单")
        self.assertEqual(self.run_job()["status"], "failed")
        self.assertEqual(self.database.get_video(self.video_id)["analysis"], self.plan)
        self.client.analyze_prepared_videos.assert_called_once()

    def test_diagnostic_sanitization_covers_headers_json_and_spaced_secrets(self):
        values = ["{'Cookie': 'session=FAKE_PRIVATE', 'Authorization': 'Bearer FAKE_PRIVATE'}",
                  '{"apiKey": "FAKE_PRIVATE SECRET WITH SPACES"}',
                  'service rejected API Key: FAKE_PRIVATE_VALUE',
                  'api key=FAKE_PRIVATE_VALUE',
                  'access token=FAKE_PRIVATE_VALUE',
                  'token=FAKE_PRIVATE SECRET WITH SPACES',
                  'failed https://cdn.example/?signature=FAKE_PRIVATE']
        for value in values:
            cleaned = safe_error(RuntimeError(value))
            self.assertNotIn("FAKE_PRIVATE", cleaned)
            self.assertNotIn("SECRET WITH SPACES", cleaned)


class DownloadDeadlineTests(unittest.TestCase):
    def download(self, *, declared="4", parts=None, slow=False):
        from host_service import media
        from local_asr.server import ApiError
        with tempfile.TemporaryDirectory(prefix="douyin-download-test-") as directory:
            path = Path(directory) / "original.mp4"
            clock = [0.0]
            response = Mock()
            response.status = 200
            response.getheader.side_effect = lambda name: {"Content-Type": "video/mp4", "Content-Length": declared}.get(name)
            chunks = iter(parts or [b"full", b""])
            def read(_maximum):
                if slow:
                    clock[0] += 6
                return next(chunks)
            response.read1.side_effect = read
            response.read.side_effect = AssertionError("buffered read may hide a slow trickle beyond its total deadline")
            connection = Mock()
            with patch.object(media, "_validate_download_target", return_value=object()), \
                 patch.object(media, "_open_download", return_value=(connection, response)) as opened, \
                 patch.object(media.time, "monotonic", side_effect=lambda: clock[0]), \
                 patch.object(media.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)):
                if slow or declared != "4":
                    with self.assertRaises(ApiError):
                        media.download_media("https://fixture.douyinvod.com/video", path, 1024, deadline=5)
                    self.assertFalse(path.exists())
                else:
                    self.assertEqual(media.download_media("https://fixture.douyinvod.com/video", path, 1024, deadline=5), 4)
                    self.assertEqual(path.read_bytes(), b"full")
                self.assertEqual(opened.call_count, 1, "download layer must not multiply full capture attempts")
                self.assertEqual(opened.call_args.kwargs["deadline"], 5)
                response.close.assert_called_once()
                connection.close.assert_called_once()

    def test_slow_trickle_stops_at_total_deadline(self):
        self.download(slow=True)

    def test_declared_length_mismatch_is_incomplete(self):
        self.download(declared="9")

    def test_complete_original_bytes_are_preserved_once(self):
        self.download()


unittest.main(argv=[sys.argv[0]], verbosity=2)
