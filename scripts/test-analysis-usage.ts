import assert from 'node:assert/strict';
import { normalizeAnalysisUsage, analysisUsageSummary, formatEstimatedCost } from '../lib/analysis-usage.ts';

const visual = {
  requestedModel: 'qwen3.8-flash', requestCount: 1, attemptedRequestCount: 1,
  promptTokens: 109311, completionTokens: 4023, totalTokens: 113334,
  videoTokens: 105602, imageTokens: 0, audioTokens: 0, textTokens: 3709,
  cachedTokens: 0, reasoningTokens: 718, usageComplete: true, estimatedCostCny: 0.0983109,
};
const speech = {
  model: 'qwen3-asr-flash-filetrans', attemptedRequestCount: 1, requestCount: 1,
  audioSeconds: 548, estimatedCostCny: 0.12056, usageComplete: true,
};
const combined = { ...visual, cloudAsr: speech, totalEstimatedCostCny: 0.2188709 };
const complete = normalizeAnalysisUsage(combined)!;
assert.equal(complete.totalTokens, 113334);
assert.equal(complete.cloudAsr?.audioSeconds, 548);
assert.equal(complete.estimatedCostCny, 0.0983109);
assert.equal(complete.totalEstimatedCostCny, 0.2188709);
assert.equal(analysisUsageSummary(complete, 'ready'), '本次估算 ¥0.2189');
assert.equal(analysisUsageSummary(complete, 'error'), '本次估算 ¥0.2189', 'failed analysis must still show incurred cost');
assert.equal(analysisUsageSummary(complete, 'processing'), '本次用量统计中');

const missingVisualReceipt = normalizeAnalysisUsage({ ...combined, requestCount: 0, usageComplete: false })!;
assert.equal(missingVisualReceipt.totalEstimatedCostCny, null);
assert.equal(missingVisualReceipt.cloudAsr?.estimatedCostCny, 0.12056, 'preserve known speech cost when visual receipt is missing');
assert.equal(analysisUsageSummary(missingVisualReceipt, 'error'), '本次费用待核对');
for (const incomplete of [
  { ...speech, requestCount: 0, usageComplete: false },
  { ...speech, audioSeconds: null },
  { ...speech, audioSeconds: -1 },
]) {
  const result = normalizeAnalysisUsage({ ...combined, cloudAsr: incomplete })!;
  assert.equal(result.totalEstimatedCostCny, null, 'unknown speech charge must not be omitted from total');
  assert.equal(result.estimatedCostCny, 0.0983109);
}
const inconsistentTokens = normalizeAnalysisUsage({ ...combined, totalTokens: 113335 })!;
assert.equal(inconsistentTokens.usageComplete, false);
assert.equal(inconsistentTokens.totalEstimatedCostCny, null);
assert.equal(normalizeAnalysisUsage(visual)?.totalEstimatedCostCny, 0.0983109, 'old visual-only history keeps its cost');
assert.equal(normalizeAnalysisUsage({ ...combined, cloudAsr: { ...speech, attemptedRequestCount: 0, requestCount: 0, audioSeconds: 0, estimatedCostCny: 0 } })?.totalEstimatedCostCny, 0.0983109, 'reuse adds no new speech charge');
assert.equal(analysisUsageSummary(null, 'ready'), '用量未记录');
assert.equal(analysisUsageSummary(null, 'queued'), '本次用量统计中');
assert.equal(formatEstimatedCost(null), '待账单核对');
assert.equal(formatEstimatedCost(0), '¥0.0000');
assert.equal(formatEstimatedCost(0.0000008), '<¥0.0001', 'a positive tiny charge must not look free');
assert.equal(formatEstimatedCost(0.00264), '¥0.0026');
console.log('Analysis usage passed: exact token/audio units, combined cost, failed attempts, missing receipts, legacy/reused speech, pending state and small-charge precision.');
