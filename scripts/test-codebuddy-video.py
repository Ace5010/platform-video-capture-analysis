"""Isolated native-video/fallback/billing checks. No network or real login."""
import json
import sys
import tempfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_service.codebuddy import CodeBuddyClient, quota_exhausted, MAX_INLINE_VIDEO_BYTES
from host_service.config import HostConfig
from host_service.media import sha256_file
from host_service.qwen import QwenError, QwenAnalysisValidationError, QwenUploadLimitExceeded, mock_analysis
from host_service.recovery import AnalysisCancelled


def rejected(code=14019, status=429):
    return {"complete": False, "errorCodes": [code], "wire": [{"type": "video_response", "status": status, "codes": [code]}]}


assert quota_exhausted(rejected())
for report in [rejected(14018), rejected(14015), rejected(14003), rejected(11115), rejected(14019, 400),
               {"complete": False, "result": "model quota exhausted", "errorCodes": []},
               {**rejected(), "errorCodes": [14019, 14018]}]:
    assert not quota_exhausted(report), report

with tempfile.TemporaryDirectory(prefix="observe-buddy-unit-") as temporary:
    root = Path(temporary)
    cfg = replace(HostConfig.from_env(), testing=True, data_dir=root, temp_dir=root)
    video = root / "complete.mp4"
    video.write_bytes(b"all-original-video-bytes")
    sha = sha256_file(video)

    def transmitted(report):
        return {**report, "wire": [{"type": "video_request", "videoSha256": sha,
                                  "videoBytes": video.stat().st_size, "model": "minimax-m3"}, *report.get("wire", [])]}

    success = transmitted({"complete": True, "result": json.dumps({**mock_analysis(), "_videoInputObserved": True}), "records": [
        {"requestId": "official-request", "model": "minimax-m3.1-flash", "usage": {
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "credit": 0.25,
        }}]})
    with patch.object(CodeBuddyClient, "configured", True):
        client = CodeBuddyClient(cfg)
        with patch.object(client, "_execute", side_effect=[transmitted(rejected()), success]) as execute:
            output = client.analyze_prepared_videos([str(video)], "已保存的完整口播", {"durationSeconds": 10})
            assert output["contentAnalysis"]
            assert [call.args[0]["model"] for call in execute.call_args_list] == ["minimax-m3", "minimax-m3.1-flash"]
            assert all(call.args[0]["sha256"] == sha for call in execute.call_args_list)
            assert all("已保存的完整口播" in call.args[0]["prompt"] for call in execute.call_args_list)
        usage = client.usage_summary()
        assert usage["model"] == "minimax-m3.1-flash" and usage["requestedModel"] == "minimax-m3"
        assert usage["attemptedRequestCount"] == 2 and usage["totalTokens"] == 120
        assert usage["knownCredits"] == 0.25 and usage["credits"] is None and not usage["usageComplete"]
        assert usage["providerAttempts"][0]["status"] == "quota_exhausted"
        assert usage["estimatedCostCny"] is None
        # Continue on GLM after the model-specific quota rejection; no repeated
        # MiniMax request for subsequent lossless segments or schema repair.
        with patch.object(client, "_execute", return_value=success) as execute:
            client.analyze_prepared_videos([str(video)], "", {})
            assert execute.call_args.args[0]["model"] == "minimax-m3.1-flash"

        for failure in [transmitted(rejected(14018)), transmitted(rejected(14003)),
                        transmitted(rejected(11115)), {"complete": True, "records": [], "result": json.dumps(mock_analysis())}]:
            other = CodeBuddyClient(cfg)
            with patch.object(other, "_execute", return_value=failure) as execute:
                try:
                    other.analyze_prepared_videos([str(video)], "", {})
                    raise AssertionError("Failed or missing native video was accepted")
                except QwenError:
                    pass
                assert execute.call_count == 1

        other = CodeBuddyClient(cfg)
        with patch.object(other, "_execute", return_value={**success, "result": "not-json"}):
            try:
                other.analyze_prepared_videos([str(video)], "", {})
                raise AssertionError("Invalid JSON was accepted")
            except QwenAnalysisValidationError:
                pass
            assert other.usage_summary()["credits"] == 0.25, "schema failure lost official charge"
        with patch.object(other, "_execute", side_effect=AnalysisCancelled("cancelled")):
            try:
                other.analyze_prepared_videos([str(video)], "", {})
                raise AssertionError("Cancellation was ignored")
            except AnalysisCancelled:
                pass
            assert other.usage_summary()["credits"] is None
        other = CodeBuddyClient(cfg)
        other.progress_callback = lambda _: (_ for _ in ()).throw(AnalysisCancelled("before submission"))
        with patch.object(other, "_execute") as execute:
            try:
                other.analyze_prepared_videos([str(video)], "", {})
                raise AssertionError("Pre-submit cancellation ignored")
            except AnalysisCancelled:
                pass
            execute.assert_not_called()
            assert other.usage_summary()["attemptedRequestCount"] == 0
        other = CodeBuddyClient(cfg)
        with patch.object(other, "_execute", return_value={**success, "result": json.dumps({**mock_analysis(), "_videoInputObserved": False})}):
            try:
                other.analyze_prepared_videos([str(video)], "", {})
                raise AssertionError("Model without video perception was accepted")
            except QwenError:
                pass
            assert other.usage_summary()["credits"] == 0.25
        # Every continuous segment reaches the native input once; only the
        # final synthesis is text-only. Never expose one segment as full output.
        second = root / "segment-2.mp4"
        second.write_bytes(b"the remaining complete continuous segment")
        other = CodeBuddyClient(cfg)
        seen = []
        def segment_response(payload):
            seen.append(payload)
            result = {**mock_analysis(), **({"_videoInputObserved": True} if payload["videoPath"] else {})}
            report = {**success, "result": json.dumps(result), "wire": []}
            if payload["videoPath"]:
                p = Path(payload["videoPath"])
                report["wire"] = [{"type": "video_request", "videoSha256": sha256_file(p), "videoBytes": p.stat().st_size, "model": payload["model"]}]
            return report
        with patch.object(other, "_execute", side_effect=segment_response), patch('host_service.qwen.probe_media', return_value={"format": {"duration": "5"}}):
            other.analyze_prepared_videos([str(video), str(second)], "full transcript", {"durationSeconds": 10})
        assert [Path(item["videoPath"]).resolve() if item["videoPath"] else None for item in seen] == [video.resolve(), second.resolve(), None]
        assert "1/2" in seen[0]["prompt"] and "2/2" in seen[1]["prompt"]
        assert "全片起点秒数：5.0" in seen[1]["prompt"]
        assert other.usage_summary()["credits"] == 0.75

    with video.open("wb") as output:
        output.truncate(MAX_INLINE_VIDEO_BYTES + 1)
    try:
        CodeBuddyClient(cfg).prepare_video(video)
        raise AssertionError("Oversized full video did not request lossless segmentation")
    except QwenUploadLimitExceeded as error:
        assert error.maximum_bytes == MAX_INLINE_VIDEO_BYTES
    with tempfile.NamedTemporaryFile() as outside:
        try:
            CodeBuddyClient(cfg).prepare_video(Path(outside.name))
            raise AssertionError("Unscoped media path was accepted")
        except QwenError:
            pass

print("CodeBuddy passed: full-byte provenance, explicit quota fallback, account/auth/context failures, no uncertain resend, receipt retention, cancellation and lossless size boundary.")
