"""Cloud ASR protocol checks using simulated HTTP only; no keys or cloud calls."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from host_service import cloud_asr as module  # noqa: E402
from host_service.cloud_asr import CloudAsrClient, CloudAsrError  # noqa: E402
from host_service.config import HostConfig  # noqa: E402
from host_service.qwen import QwenError, QwenUploadLimitExceeded  # noqa: E402


TASK_ID = "00000000-0000-0000-0000-000000000001"
REQUEST_ID = "00000000-0000-0000-0000-000000000002"
RESULT_URL = "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json?Signature=unit-test-only"
REFERENCE = "oss://unit-test-only/full-media.mp4"


def task(status="PENDING", *, seconds=None, result_url=RESULT_URL, task_id=TASK_ID):
    payload = {"request_id": REQUEST_ID, "output": {"task_id": task_id, "task_status": status}}
    if status == "SUCCEEDED":
        payload["output"]["result"] = {"transcription_url": result_url}
    if seconds is not None:
        payload["usage"] = {"seconds": seconds}
    return payload


def transcript(text="这是完整口播，包含 AI 和第二句话。"):
    return {"transcripts": [{"channel_id": 0, "text": text}]}


class Response(io.BytesIO):
    # read1 chunks can split UTF-8 characters; the client must decode once the
    # complete response is assembled instead of corrupting per-chunk text.
    def read1(self, size=-1):
        return self.read(min(size, 7))


class HttpScript:
    def __init__(self, events):
        self.events = list(events)
        self.requests = []
        self.timeouts = []
        self.responses = []

    def open(self, request, *, timeout):
        self.requests.append(request)
        self.timeouts.append(timeout)
        if not self.events:
            raise AssertionError("Unexpected network request")
        event = self.events.pop(0)
        if isinstance(event, Exception):
            raise event
        raw = event if isinstance(event, bytes) else json.dumps(event, ensure_ascii=False).encode("utf-8")
        response = Response(raw)
        self.responses.append(response)
        return response


class Clock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class CloudAsrTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="cloud-asr-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "complete-video.mp4"
        self.original = b"unit-test-only-full-media\x00\xff"
        self.path.write_bytes(self.original)
        self.config = replace(
            HostConfig.from_env(), testing=True, mock_qwen=False,
            qwen_endpoint="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        )
        self.secret = {"apiKey": "unit-test-placeholder", "model": "qwen3.8-flash"}
        self.clock = Clock()
        self.addCleanup(patch.stopall)
        patch.object(module.time, "monotonic", self.clock.monotonic).start()
        patch.object(module.time, "sleep", self.clock.sleep).start()
        self.uploads = []

        def upload(uploader, path):
            self.uploads.append((uploader._model(), path, path.read_bytes()))
            return REFERENCE

        patch.object(module.QwenClient, "_upload_file", upload).start()
        # Safety net: every test must install its own simulated opener.
        patch.object(module, "build_opener", side_effect=AssertionError("Real HTTP is forbidden in this test")).start()

    def client(self, events):
        script = HttpScript(events)
        with patch.object(module, "build_opener", return_value=script):
            client = CloudAsrClient(self.config, self.secret)
        return client, script

    def test_async_full_media_model_binding_headers_and_usage(self):
        client, http = self.client([task(), task("RUNNING"), task("SUCCEEDED", seconds=485), transcript()])
        self.assertEqual(client.transcribe(self.path), transcript()["transcripts"][0]["text"])
        self.assertEqual(self.uploads, [(module.CLOUD_ASR_MODEL, self.path, self.original)])
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.secret["model"], "qwen3.8-flash")
        request = http.requests[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.full_url, "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription")
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["x-dashscope-async"], "enable")
        self.assertEqual(headers["x-dashscope-ossresourceresolve"], "enable")
        self.assertEqual(headers["authorization"], "Bearer unit-test-placeholder")
        self.assertEqual(json.loads(request.data), {
            "model": module.CLOUD_ASR_MODEL, "input": {"file_url": REFERENCE},
            "parameters": {"channel_id": [0], "enable_itn": False},
        })
        self.assertTrue(all(request.method == "GET" for request in http.requests[1:]))
        self.assertTrue(all(request.full_url.endswith(TASK_ID) for request in http.requests[1:-1]))
        self.assertEqual(http.requests[-1].full_url, RESULT_URL.replace("http:", "https:"))
        self.assertFalse(http.requests[-1].has_header("Authorization"))
        self.assertTrue(all(response.closed for response in http.responses))
        usage = client.usage_summary()
        self.assertEqual((usage["source"], usage["model"]), ("cloud_asr", module.CLOUD_ASR_MODEL))
        self.assertEqual(usage["audioSeconds"], 485)
        self.assertEqual(usage["estimatedCostCny"], 0.1067)
        self.assertEqual((usage["attemptedRequestCount"], usage["requestCount"]), (1, 1))
        self.assertEqual(usage["taskIds"], [TASK_ID])
        self.assertEqual(usage["requestIds"], [REQUEST_ID])
        self.assertTrue(usage["usageComplete"])
        self.assertNotIn("totalTokens", usage)
        self.assertFalse(http.events)
        self.assertTrue(all(0 < value <= module.CLOUD_ASR_NETWORK_SECONDS for value in http.timeouts))

    def test_successful_empty_speech(self):
        for result in (transcript(""), transcript("  \n "), {"transcripts": []}):
            with self.subTest(result=result):
                client, _ = self.client([task("SUCCEEDED", seconds=0), result])
                self.assertEqual(client.transcribe(self.path), "")
                self.assertTrue(client.usage_summary()["usageComplete"])
                self.assertEqual(client.usage_summary()["estimatedCostCny"], 0)

    def test_failed_task_is_not_silence_and_error_is_safe(self):
        payload = task("FAILED")
        payload["output"].update(message=RESULT_URL + self.secret["apiKey"], code=REFERENCE)
        client, http = self.client([task(), payload])
        with self.assertRaises(CloudAsrError) as error:
            client.transcribe(self.path)
        self.assertIn("任务失败", str(error.exception))
        self.assertNotIn("Signature", str(error.exception))
        self.assertNotIn(self.secret["apiKey"], str(error.exception))
        self.assertEqual(len(http.requests), 2)
        self.assertIsNone(client.usage_summary()["estimatedCostCny"])

    def test_uncertain_submission_is_never_retried(self):
        for failure in (TimeoutError(RESULT_URL), URLError(self.secret["apiKey"]), HTTPError(RESULT_URL, 503, "unsafe", {}, io.BytesIO(b"unsafe"))):
            with self.subTest(failure=type(failure).__name__):
                client, http = self.client([failure])
                with self.assertRaisesRegex(CloudAsrError, "未自动重发"):
                    client.transcribe(self.path)
                with self.assertRaisesRegex(CloudAsrError, "不能重复提交"):
                    client.transcribe(self.path)
                self.assertEqual(len(http.requests), 1)
                self.assertEqual(client.usage_summary()["attemptedRequestCount"], 1)
                self.assertFalse(client.usage_summary()["usageComplete"])
                self.assertIsNone(client.usage_summary()["audioSeconds"])

    def test_get_transient_errors_retry_only_original_task(self):
        client, http = self.client([
            task(), URLError("unit-test"), task("RUNNING"),
            HTTPError(RESULT_URL, 429, "unit-test", {}, io.BytesIO()),
            task("SUCCEEDED", seconds=9), URLError("unit-test"), transcript(),
        ])
        self.assertTrue(client.transcribe(self.path))
        self.assertEqual(sum(request.method == "POST" for request in http.requests), 1)
        self.assertEqual(client.usage_summary()["requestCount"], 1)

    def test_get_retries_are_finite(self):
        client, http = self.client([task(), *[URLError("unit-test")] * module.CLOUD_ASR_GET_ATTEMPTS])
        with self.assertRaisesRegex(CloudAsrError, "查询暂不可用"):
            client.transcribe(self.path)
        self.assertEqual(len(http.requests), 1 + module.CLOUD_ASR_GET_ATTEMPTS)

    def test_total_deadline_is_not_reset_by_running_responses(self):
        client, http = self.client([task(), task("RUNNING"), task("RUNNING")])
        with patch.object(module, "CLOUD_ASR_DEADLINE_SECONDS", 7):
            with self.assertRaisesRegex(CloudAsrError, "等待超时"):
                client.transcribe(self.path)
        self.assertEqual(self.clock.now, 7)
        self.assertEqual(len(http.requests), 3)
        self.assertIsNone(client.usage_summary()["estimatedCostCny"])

    def test_missing_invalid_or_mismatched_task_fails(self):
        for payload in ({}, {"output": {}}, task("not-a-status"), task([]), task("UNKNOWN"), task(task_id="../unsafe")):
            with self.subTest(payload=payload):
                client, http = self.client([payload])
                with self.assertRaises(CloudAsrError):
                    client.transcribe(self.path)
                self.assertEqual(len(http.requests), 1)
        client, _ = self.client([task(), task("SUCCEEDED", seconds=4, task_id=REQUEST_ID)])
        with self.assertRaisesRegex(CloudAsrError, "不匹配"):
            client.transcribe(self.path)
        self.assertFalse(client.usage_summary()["usageComplete"])

    def test_malformed_result_is_never_empty_speech(self):
        invalid_results = [
            {}, {"transcripts": None}, {"transcripts": ""},
            {"transcripts": [{}]}, {"transcripts": [{"channel_id": 0, "text": None}]},
            {"transcripts": [{"channel_id": 1, "text": "wrong track"}]},
            {"transcripts": [{"channel_id": False, "text": "wrong track"}]},
            {"transcripts": transcript()["transcripts"] * 2}, b'{"transcripts":', b'[]', b'\xff',
        ]
        for payload in invalid_results:
            with self.subTest(payload=payload):
                client, _ = self.client([task("SUCCEEDED", seconds=6), payload])
                with self.assertRaises(CloudAsrError):
                    client.transcribe(self.path)
                self.assertEqual(client.usage_summary()["audioSeconds"], 6)
                self.assertTrue(client.usage_summary()["usageComplete"])

    def test_unsafe_result_url_is_rejected_before_fetch(self):
        for url in (None, "", "http://127.0.0.1/result", "https://evil.example/result", "https://fake.aliyuncs.com/result", "https://x.oss-cn-beijing.aliyuncs.com.evil.example/result", "https://user@x.oss-cn-beijing.aliyuncs.com/result", "https://x.oss-cn-beijing.aliyuncs.com:1234/result", "https://x.oss-cn-beijing.aliyuncs.com/result#fragment"):
            with self.subTest(url=url):
                client, http = self.client([task("SUCCEEDED", seconds=2, result_url=url)])
                with self.assertRaisesRegex(CloudAsrError, "结果地址无效"):
                    client.transcribe(self.path)
                self.assertEqual(len(http.requests), 1)

    def test_redirects_never_forward_authorization_or_signed_urls(self):
        handler = module._RejectRedirects()
        request = Request("https://dashscope.aliyuncs.com/test", headers={"Authorization": "unit-test"})
        self.assertIsNone(handler.redirect_request(request, None, 302, "", {}, "https://evil.example"))
        client, http = self.client([HTTPError(RESULT_URL, 302, "unsafe", {}, io.BytesIO())])
        with self.assertRaisesRegex(CloudAsrError, "HTTP 302"):
            client.transcribe(self.path)
        self.assertEqual(len(http.requests), 1)

    def test_result_download_failure_preserves_known_charge(self):
        client, http = self.client([task("SUCCEEDED", seconds=485), HTTPError(RESULT_URL, 403, "unsafe", {}, io.BytesIO())])
        with self.assertRaises(CloudAsrError) as error:
            client.transcribe(self.path)
        self.assertNotIn("Signature", str(error.exception))
        self.assertTrue(client.usage_summary()["usageComplete"])
        self.assertEqual(client.usage_summary()["estimatedCostCny"], 0.1067)
        self.assertEqual(len(http.requests), 2)

    def test_missing_or_invalid_provider_seconds_is_unknown_cost(self):
        for seconds in (None, True, -1, "485", float("nan"), float("inf")):
            with self.subTest(seconds=seconds):
                client, _ = self.client([task("SUCCEEDED", seconds=seconds), transcript()])
                self.assertTrue(client.transcribe(self.path))
                usage = client.usage_summary()
                self.assertFalse(usage["usageComplete"])
                self.assertIsNone(usage["audioSeconds"])
                self.assertIsNone(usage["estimatedCostCny"])

    def test_oversized_response_is_closed_and_rejected(self):
        client, http = self.client([b"x" * 65])
        with patch.object(module, "CLOUD_ASR_MAX_JSON_BYTES", 64):
            with self.assertRaisesRegex(CloudAsrError, "异常过大"):
                client.transcribe(self.path)
        self.assertTrue(http.responses[0].closed)

    def test_upload_error_is_safe_and_has_no_paid_attempt(self):
        client, http = self.client([])
        with patch.object(module.QwenClient, "_upload_file", side_effect=QwenError(RESULT_URL + self.secret["apiKey"])):
            with self.assertRaises(CloudAsrError) as error:
                client.transcribe(self.path)
        self.assertNotIn("Signature", str(error.exception))
        self.assertNotIn(self.secret["apiKey"], str(error.exception))
        self.assertEqual(client.usage_summary()["attemptedRequestCount"], 0)
        self.assertEqual(client.usage_summary()["estimatedCostCny"], 0)
        self.assertFalse(http.requests)

    def test_upload_limit_is_preserved_for_lossless_split_caller(self):
        client, _ = self.client([])
        with patch.object(module.QwenClient, "_upload_file", side_effect=QwenUploadLimitExceeded(1234)):
            with self.assertRaises(QwenUploadLimitExceeded) as error:
                client.transcribe(self.path)
        self.assertEqual(error.exception.maximum_bytes, 1234)
        self.assertEqual(client.usage_summary()["attemptedRequestCount"], 0)

    def test_workspace_endpoint_uses_same_origin_and_known_region_price(self):
        self.secret["endpoint"] = "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
        client, http = self.client([task("SUCCEEDED", seconds=2), transcript()])
        client.transcribe(self.path)
        self.assertTrue(http.requests[0].full_url.startswith("https://workspace.cn-beijing.maas.aliyuncs.com/"))
        self.assertEqual(client.usage_summary()["estimatedCostCny"], 0.00044)
        self.secret["endpoint"] = "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
        client, _ = self.client([task("SUCCEEDED", seconds=2), transcript()])
        client.transcribe(self.path)
        self.assertTrue(client.usage_summary()["usageComplete"])
        self.assertIsNone(client.usage_summary()["estimatedCostCny"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
