"""Byte preservation and upload deadlines with simulated HTTPS connections."""

from __future__ import annotations

import io
import json
import sqlite3
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from host_service import qwen as module  # noqa: E402
from host_service.config import HostConfig  # noqa: E402
from host_service.qwen import (  # noqa: E402
    QwenClient, QwenError, QwenAnalysisValidationError, QwenPartialAnalysisError, validate_analysis,
    mock_analysis, analysis_section_status, CONTENT_ANALYSIS_DESCRIPTIONS,
)


POLICY = {
    "upload_dir": "unit-test", "upload_host": "https://unit-test.oss-cn-beijing.aliyuncs.com/",
    "oss_access_key_id": "test-only", "signature": "test-only", "policy": "test-only",
    "x_oss_object_acl": "private", "x_oss_forbid_overwrite": "true",
}


class Socket:
    def __init__(self):
        self.timeout = 60
        self.timeouts = []

    def settimeout(self, value):
        self.timeout = value
        self.timeouts.append(value)


class Connection:
    def __init__(self, clock, *, send_delay=0, response_delay=0, status=200, disconnect=False):
        self.clock = clock
        self.sock = Socket()
        self.response_sock = self.sock
        self.timeout = None
        self.headers = {}
        self.body = []
        self.closed = False
        self.send_delay = send_delay
        self.response_delay = response_delay
        self.disconnect = disconnect
        self.response = io.BytesIO(b"ok")
        self.response.status = status
        self.response.fp = SimpleNamespace(raw=SimpleNamespace(_sock=self.response_sock))

        def read1(size):
            self.delay(self.response_delay)
            return self.response.read(min(size, 1))

        self.response.read1 = read1

    def delay(self, value):
        self.clock[0] += min(value, self.response_sock.timeout)
        if value >= self.response_sock.timeout:
            raise TimeoutError("unit-test-only")

    def putrequest(self, method, path):
        self.request = (method, path)

    def putheader(self, key, value):
        self.headers[key] = value

    def endheaders(self):
        pass

    def send(self, chunk):
        if self.disconnect:
            raise ConnectionResetError("Signature=unit-test-only")
        self.delay(self.send_delay)
        self.body.append(chunk)

    def getresponse(self):
        # With Connection: close, HTTPResponse owns the socket from now on.
        self.sock = None
        return self.response

    def close(self):
        self.closed = True


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="qwen-upload-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "full-video.mp4"
        self.original = bytes(range(256)) * 4097
        self.path.write_bytes(self.original)
        self.config = replace(HostConfig.from_env(), testing=True, mock_qwen=False)
        self.client = QwenClient(self.config, {"apiKey": "unit-test-placeholder"})
        self.clock = [0.0]
        self.addCleanup(patch.stopall)
        patch.object(module.time, "monotonic", lambda: self.clock[0]).start()
        patch.object(self.client, "_get_upload_policy", return_value=POLICY).start()
        patch.object(module.http.client, "HTTPSConnection", side_effect=AssertionError("Real network forbidden")).start()

    def run_upload(self, connection):
        with patch.object(module.http.client, "HTTPSConnection", return_value=connection) as constructor:
            try:
                return self.client._upload_file(self.path)
            finally:
                self.assertEqual(constructor.call_count, 1)
                self.assertLessEqual(constructor.call_args.kwargs["timeout"], 60)
                self.assertTrue(connection.closed)

    def test_success_preserves_every_original_byte_once(self):
        connection = Connection(self.clock)
        reference = self.run_upload(connection)
        self.assertTrue(reference.startswith("oss://unit-test/"))
        self.assertEqual(connection.request, ("POST", "/"))
        body = b"".join(connection.body)
        self.assertEqual(body.count(self.original), 1)
        self.assertEqual(int(connection.headers["Content-Length"]), len(body))
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertTrue(connection.response.closed)
        self.assertTrue(all(0 < value <= 60 for value in connection.response_sock.timeouts))
        self.assertEqual(self.client.usage_summary()["attemptedRequestCount"], 0)

    def test_slow_upload_has_one_total_deadline(self):
        connection = Connection(self.clock, send_delay=2)
        with patch.object(module, "QWEN_UPLOAD_DEADLINE_SECONDS", 5):
            with self.assertRaisesRegex(QwenError, "未自动重复上传"):
                self.run_upload(connection)
        self.assertEqual(self.clock[0], 5)
        self.assertEqual(connection.response_sock.timeouts[-1], 1)

    def test_slow_response_has_same_deadline_and_closes_response(self):
        connection = Connection(self.clock, response_delay=2)
        with patch.object(module, "QWEN_UPLOAD_DEADLINE_SECONDS", 5):
            with self.assertRaisesRegex(QwenError, "未自动重复上传"):
                self.run_upload(connection)
        self.assertEqual(self.clock[0], 5)
        self.assertEqual(connection.response_sock.timeouts[-1], 1)
        self.assertTrue(connection.response.closed)

    def test_idle_send_is_bounded_and_never_retried(self):
        connection = Connection(self.clock, send_delay=1000)
        with self.assertRaisesRegex(QwenError, "未自动重复上传"):
            self.run_upload(connection)
        self.assertEqual(self.clock[0], 60)

    def test_connection_error_is_safe_and_never_retried(self):
        connection = Connection(self.clock, disconnect=True)
        with self.assertRaises(QwenError) as error:
            self.run_upload(connection)
        self.assertNotIn("Signature", str(error.exception))
        self.assertEqual(self.clock[0], 0)

    def test_failed_http_status_closes_response(self):
        connection = Connection(self.clock, status=403)
        with self.assertRaisesRegex(QwenError, "HTTP 403"):
            self.run_upload(connection)
        self.assertTrue(connection.response.closed)


class AnalysisSectionTests(unittest.TestCase):
    def setUp(self):
        self.config = replace(HostConfig.from_env(), testing=True, mock_qwen=False)
        self.client = QwenClient(self.config, {"apiKey": "unit-test-placeholder"})

    def response(self, value, finish_reason="stop"):
        return {"choices": [{"finish_reason": finish_reason, "message": {"content": json.dumps(value, ensure_ascii=False)}}]}

    def test_one_call_returns_content_and_production(self):
        plan = mock_analysis()
        with patch.object(self.client, "_stream_request", return_value=self.response(plan)) as request:
            self.assertEqual(self.client._call([], "模拟完整媒体"), plan)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(analysis_section_status(plan), {"contentAnalysis": True, "remotion": True})

    def test_independent_valid_content_survives_invalid_production(self):
        plan = mock_analysis()
        plan["shotTimeline"] = ""
        with patch.object(self.client, "_stream_request", return_value=self.response(plan)) as request:
            with self.assertRaises(QwenPartialAnalysisError) as caught:
                self.client._call([], "模拟完整媒体")
        self.assertEqual(request.call_count, 1, "invalid structured output is not silently regenerated")
        self.assertEqual(caught.exception.completed_sections, ["contentAnalysis"])
        self.assertEqual(caught.exception.partial_analysis["contentAnalysis"], plan["contentAnalysis"])
        self.assertNotIn("projectSettings", caught.exception.partial_analysis)
        self.assertIn("remotion", caught.exception.section_errors)

    def test_independent_valid_production_survives_invalid_content(self):
        plan = mock_analysis()
        del plan["contentAnalysis"]["scopeAndLimits"]
        with self.assertRaises(QwenPartialAnalysisError) as caught:
            validate_analysis(plan)
        self.assertEqual(caught.exception.completed_sections, ["remotion"])
        self.assertNotIn("contentAnalysis", caught.exception.partial_analysis)
        self.assertEqual(caught.exception.partial_analysis["shotTimeline"], plan["shotTimeline"])

    def test_content_requires_all_five_fields(self):
        for field in CONTENT_ANALYSIS_DESCRIPTIONS:
            with self.subTest(field=field):
                plan = mock_analysis(["contentAnalysis"])
                del plan["contentAnalysis"][field]
                with self.assertRaises(QwenError):
                    validate_analysis(plan, ["contentAnalysis"])

    def test_optional_details_may_be_empty_without_extra_model_calls(self):
        plan = mock_analysis()
        plan["contentAnalysis"] = {field: "作者解释了按项目整理收藏的方法。" if field == "quickOverview" else ""
                                   for field in CONTENT_ANALYSIS_DESCRIPTIONS}
        with patch.object(self.client, "_stream_request", return_value=self.response(plan)) as request:
            self.assertEqual(self.client._call([], "模拟完整媒体"), plan)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(analysis_section_status(plan), {"contentAnalysis": True, "remotion": True})
        plan["contentAnalysis"]["quickOverview"] = " "
        with self.assertRaises(QwenError):
            validate_analysis(plan)

    def test_no_partial_results_from_truncated_response(self):
        with patch.object(self.client, "_stream_request", return_value=self.response(mock_analysis(), "length")) as request:
            with self.assertRaises(QwenError) as caught:
                self.client._call([], "模拟完整媒体")
        self.assertNotIsInstance(caught.exception, QwenPartialAnalysisError)
        self.assertNotIsInstance(caught.exception, QwenAnalysisValidationError)
        self.assertEqual(request.call_count, 1)

    def test_finished_invalid_json_is_explicitly_recoverable(self):
        response = {"choices": [{"finish_reason": "stop", "message": {"content": "not-json"}}]}
        with patch.object(self.client, "_stream_request", return_value=response) as request:
            with self.assertRaises(QwenAnalysisValidationError) as caught:
                self.client._call([], "模拟完整媒体", ["contentAnalysis"])
        self.assertEqual(caught.exception.partial_analysis, {})
        self.assertEqual(set(caught.exception.section_errors), {"contentAnalysis"})
        self.assertEqual(request.call_count, 1, "the caller owns bounded local recovery")

    def test_finished_invalid_fields_are_explicitly_recoverable(self):
        with patch.object(self.client, "_stream_request", return_value=self.response({"schemaVersion": module.ANALYSIS_VERSION})):
            with self.assertRaises(QwenAnalysisValidationError) as caught:
                self.client._call([], "模拟完整媒体")
        self.assertEqual(set(caught.exception.section_errors), {"contentAnalysis", "remotion"})

    def test_stream_failure_never_claims_a_confirmed_completed_request(self):
        with patch.object(self.client, "_stream_request", side_effect=QwenError("流式连接中断或超时")):
            with self.assertRaises(QwenError) as caught:
                self.client._call([], "模拟完整媒体")
        self.assertNotIsInstance(caught.exception, QwenAnalysisValidationError)

    def test_unknown_root_fields_and_versions_fail_closed(self):
        for plan in ({**mock_analysis(), "Signature=private": "secret"}, {**mock_analysis(), "schemaVersion": "unknown"}):
            with self.assertRaises(QwenError) as caught:
                validate_analysis(plan)
            self.assertNotIsInstance(caught.exception, QwenPartialAnalysisError)
            self.assertNotIn("private", str(caught.exception))

    def test_local_repair_requests_only_missing_content(self):
        plan = mock_analysis(["contentAnalysis"])
        with patch.object(self.client, "_stream_request", return_value=self.response(plan)) as request:
            result = self.client.analyze_prepared_video("data:video/mp4;base64,AAAA", "原口播", {"requestedSections": ["contentAnalysis"]})
        self.assertEqual(result, plan)
        self.assertEqual(request.call_count, 1)
        sent = request.call_args.args[2]
        last_contract = json.loads(sent["messages"][0]["content"].rsplit("\n", 1)[1])
        self.assertEqual(set(last_contract["required"]), {"schemaVersion", "contentAnalysis"})
        self.assertEqual(sent["messages"][1]["content"][0]["type"], "video_url", "repair still uses complete video")

    def test_old_complete_results_are_reusable_without_schema_migration(self):
        for version in ("remotion-plan-v1", "remotion-plan-v2"):
            plan = {**mock_analysis(), "schemaVersion": version, "contentAnalysis": "原有分析全文"}
            self.assertEqual(analysis_section_status(plan), {"contentAnalysis": True, "remotion": True})
        self.assertFalse(analysis_section_status({"summary": "原有摘要", "visualContent": "原有画面描述"})["contentAnalysis"])
        legacy = {field: "原有分析" for field in ("summary", "topic", "corePoint", "visualContent", "personActions", "onScreenText", "structureNarrative")}
        self.assertTrue(analysis_section_status(legacy)["contentAnalysis"])
        self.assertEqual(analysis_section_status(None), {"contentAnalysis": False, "remotion": False})

    def test_cancelled_call_never_counts_or_submits_a_new_request(self):
        self.client.check_cancelled = lambda: (_ for _ in ()).throw(RuntimeError("任务已取消"))
        with patch.object(self.client, "_stream_request") as request:
            with self.assertRaisesRegex(RuntimeError, "任务已取消"):
                self.client._call([], "模拟完整媒体")
        self.assertEqual(request.call_count, 0)
        self.assertEqual(self.client.usage_summary()["attemptedRequestCount"], 0)

    def test_checkpoint_failure_before_http_does_not_invent_usage(self):
        self.client.progress_callback = lambda _: (_ for _ in ()).throw(sqlite3.OperationalError("mock database locked"))
        with patch.object(self.client, "_stream_request") as request:
            with self.assertRaises(sqlite3.OperationalError):
                self.client._call([], "模拟完整媒体")
        self.assertEqual(request.call_count, 0)
        usage = self.client.usage_summary()
        self.assertEqual(usage["attemptedRequestCount"], 0)
        self.assertTrue(usage["usageComplete"])
        self.assertEqual(self.client._response_diagnostics, [])

    def test_cancel_after_checkpoint_rolls_back_only_the_unsent_attempt(self):
        # An earlier real attempt remains recorded while the next reservation
        # is cancelled between checkpointing and submission.
        previous = {"attempt": 1, "stage": "complete"}
        self.client._model_request_attempts = 1
        self.client._response_diagnostics = [previous]
        with patch.object(self.client, "check_cancelled", side_effect=[None, RuntimeError("任务已取消")]), patch.object(self.client, "_stream_request") as request:
            with self.assertRaisesRegex(RuntimeError, "任务已取消"):
                self.client._call([], "模拟完整媒体")
        self.assertEqual(request.call_count, 0)
        self.assertEqual(self.client.usage_summary()["attemptedRequestCount"], 1)
        self.assertEqual(self.client._response_diagnostics, [previous])

    def test_segment_only_partial_is_not_published_as_complete_video(self):
        partial = mock_analysis(["contentAnalysis"])
        problem = QwenPartialAnalysisError(partial, ["contentAnalysis"], {"remotion": "缺失制作字段"})
        with patch.object(module, "probe_media", return_value={"format": {"duration": "10"}}), patch.object(self.client, "_video_reference", return_value=("mock://video", False)), patch.object(self.client, "_call", side_effect=problem) as call:
            with self.assertRaises(QwenError) as caught:
                self.client.analyze_segments([Path("first.mp4"), Path("second.mp4")], "口播", {})
        self.assertNotIsInstance(caught.exception, QwenPartialAnalysisError)
        self.assertEqual(call.call_count, 1)

    def test_segment_repair_keeps_requested_sections_for_all_calls(self):
        plan = mock_analysis(["contentAnalysis"])
        with patch.object(module, "probe_media", return_value={"format": {"duration": "10"}}), patch.object(self.client, "_video_reference", return_value=("mock://video", False)), patch.object(self.client, "_call", return_value=plan) as call:
            self.assertEqual(self.client.analyze_segments([Path("one.mp4")], "口播", {"requestedSections": ["contentAnalysis"]}), plan)
        self.assertEqual(call.call_count, 2)
        self.assertTrue(all(item.args[2] == ["contentAnalysis"] for item in call.call_args_list))


if __name__ == "__main__":
    unittest.main(verbosity=2)
