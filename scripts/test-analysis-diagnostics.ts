import assert from 'node:assert/strict';
import { formatAnalysisDiagnostics, redactDiagnosticText } from '../lib/analysis-diagnostics.ts';

const fakeDiagnostic = {
  jobId: 'isolated-job', videoId: 'isolated-video', failedStage: 'capture', attemptCount: 3,
  captureAttemptCount: 3,
  attempts: [
    { stage: 'capture', attempt: 1, error: 'download failed https://example.invalid/video?signature=FAKE_URL_SECRET', at: '2026-09-22T00:00:00Z' },
    { stage: 'capture', attempt: 2, error: 'Cookie: fake_session=FAKE_COOKIE_SECRET' },
    { stage: 'capture', attempt: 3, error: 'Authorization: Bearer FAKE_BEARER_SECRET' },
  ],
  completedSteps: ['transcript'], lastError: 'API Key: sk-FAKE_TEST_CREDENTIAL',
  userAction: '请重新登录抖音',
  versions: { host: 'test', analysisModel: 'model-fixture', secret: 'FAKE_VERSION_SECRET' },
  payload: { token: 'FAKE_UNEXPECTED_SECRET' },
};
const diagnostic = formatAnalysisDiagnostics(fakeDiagnostic);
const parsed = JSON.parse(diagnostic);
assert.equal(parsed.attemptCount, 3);
assert.equal(parsed.attempts.length, 3);
assert.deepEqual(parsed.completedSteps, ['transcript']);
assert.equal(parsed.versions.host, 'test');
assert.equal(parsed.userAction, '请重新登录抖音');
for (const secret of ['FAKE_URL_SECRET', 'FAKE_COOKIE_SECRET', 'FAKE_BEARER_SECRET', 'FAKE_TEST_CREDENTIAL', 'FAKE_VERSION_SECRET', 'FAKE_UNEXPECTED_SECRET']) assert.ok(!diagnostic.includes(secret), secret);
assert.ok(!redactDiagnosticText('{"access_token":"FAKE_JSON_SECRET"}').includes('FAKE_JSON_SECRET'));
const missing = JSON.parse(formatAnalysisDiagnostics({ videoId: 'legacy' }));
assert.equal(missing.attemptCount, '未记录');
assert.equal(missing.lastError, '未记录');
assert.equal(missing.attempts.length, 0);
console.log('analysis diagnostics: 15 assertions passed');
