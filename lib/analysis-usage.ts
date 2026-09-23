type CloudAsrUsage = {
  model: string;
  attemptedRequestCount: number;
  requestCount: number;
  audioSeconds: number | null;
  estimatedCostCny: number | null;
  usageComplete: boolean;
  billingNote: string;
};

export type AnalysisUsage = {
  provider: string;
  model: string;
  requestedModel: string;
  responseModels: string[];
  requestCount: number;
  attemptedRequestCount: number;
  requestIds: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  videoTokens: number;
  imageTokens: number;
  audioTokens: number;
  textTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  usageComplete: boolean;
  estimatedCostCny: number | null;
  cloudAsr: CloudAsrUsage | null;
  totalEstimatedCostCny: number | null;
  billingNote: string;
  pricing: {
    currency: string;
    region: string;
    inputPerMillion: number;
    cachedInputPerMillion: number;
    outputPerMillion: number;
    checkedAt: string;
    source: string;
  } | null;
};

export function normalizeAnalysisUsage(value: unknown): AnalysisUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const validInteger = (item: unknown) => typeof item === 'number' && Number.isInteger(item) && item >= 0;
  const number = (item: unknown): number => validInteger(item) ? Number(item) : 0;
  const finiteNumber = (item: unknown): number => typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : 0;
  const pricingRaw = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing as Record<string, unknown> : null;
  const requestCount = number(raw.requestCount);
  const attemptedRequestCount = number(raw.attemptedRequestCount ?? raw.requestCount);
  const promptTokens = number(raw.promptTokens);
  const completionTokens = number(raw.completionTokens);
  const totalTokens = number(raw.totalTokens);
  const tokenFieldsValid = [
    raw.requestCount,
    raw.attemptedRequestCount ?? raw.requestCount,
    raw.promptTokens,
    raw.completionTokens,
    raw.totalTokens,
    raw.videoTokens,
    raw.imageTokens,
    raw.audioTokens,
    raw.textTokens,
    raw.cachedTokens,
    raw.reasoningTokens,
  ].every(validInteger);
  const positiveUsageComplete = totalTokens > 0
    && totalTokens === promptTokens + completionTokens
    && attemptedRequestCount === requestCount;
  const zeroRequestComplete = attemptedRequestCount === 0
    && requestCount === 0
    && promptTokens === 0
    && completionTokens === 0
    && totalTokens === 0;
  const usageComplete = raw.usageComplete === true
    && tokenFieldsValid
    && (positiveUsageComplete || zeroRequestComplete);
  const estimatedCost = !usageComplete || raw.estimatedCostCny == null || !Number.isFinite(Number(raw.estimatedCostCny))
    ? null
    : Math.max(0, Number(raw.estimatedCostCny));
  const nonnegativeAmount = (item: unknown): number | null => typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : null;
  const cloudRaw = raw.cloudAsr && typeof raw.cloudAsr === 'object' ? raw.cloudAsr as Record<string, unknown> : null;
  const cloudAttempts = number(cloudRaw?.attemptedRequestCount);
  const cloudRequests = number(cloudRaw?.requestCount);
  const audioSeconds = nonnegativeAmount(cloudRaw?.audioSeconds);
  const cloudUsageComplete = cloudRaw?.usageComplete === true
    && validInteger(cloudRaw.attemptedRequestCount) && validInteger(cloudRaw.requestCount)
    && cloudAttempts === cloudRequests && (cloudAttempts === 0 || audioSeconds !== null);
  const cloudAsr: CloudAsrUsage | null = cloudRaw && (cloudAttempts > 0 || cloudRequests > 0) ? {
    model: String(cloudRaw.model || 'qwen3-asr-flash-filetrans'),
    attemptedRequestCount: cloudAttempts,
    requestCount: cloudRequests,
    audioSeconds,
    estimatedCostCny: cloudUsageComplete ? nonnegativeAmount(cloudRaw.estimatedCostCny) : null,
    usageComplete: cloudUsageComplete,
    billingNote: String(cloudRaw.billingNote || '云端口播按音频时长计费，实际扣款以百炼账单为准。'),
  } : null;
  const totalEstimatedCost = cloudAsr
    ? usageComplete && cloudAsr.usageComplete && estimatedCost !== null && cloudAsr.estimatedCostCny !== null
      ? nonnegativeAmount(raw.totalEstimatedCostCny) : null
    : estimatedCost;
  return {
    provider: String(raw.provider || 'Alibaba Cloud Model Studio'),
    model: String(raw.model || 'qwen3.8-flash'),
    requestedModel: String(raw.requestedModel || raw.model || 'qwen3.8-flash'),
    responseModels: Array.isArray(raw.responseModels) ? raw.responseModels.map(String).filter(Boolean) : [],
    requestCount,
    attemptedRequestCount,
    requestIds: Array.isArray(raw.requestIds) ? raw.requestIds.map(String).filter(Boolean) : [],
    promptTokens,
    completionTokens,
    totalTokens,
    videoTokens: number(raw.videoTokens),
    imageTokens: number(raw.imageTokens),
    audioTokens: number(raw.audioTokens),
    textTokens: number(raw.textTokens),
    cachedTokens: number(raw.cachedTokens),
    reasoningTokens: number(raw.reasoningTokens),
    usageComplete,
    estimatedCostCny: estimatedCost,
    cloudAsr,
    totalEstimatedCostCny: totalEstimatedCost,
    billingNote: String(raw.billingNote || '实际扣款以百炼账单为准。'),
    pricing: pricingRaw ? {
      currency: String(pricingRaw.currency || 'CNY'),
      region: String(pricingRaw.region || ''),
      inputPerMillion: finiteNumber(pricingRaw.inputPerMillion),
      cachedInputPerMillion: finiteNumber(pricingRaw.cachedInputPerMillion),
      outputPerMillion: finiteNumber(pricingRaw.outputPerMillion),
      checkedAt: String(pricingRaw.checkedAt || ''),
      source: String(pricingRaw.source || ''),
    } : null,
  };
}

export function formatTokenCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(value)));
}

export function formatEstimatedCost(value: number | null) {
  if (value == null) return '待账单核对';
  if (value > 0 && value < 0.0001) return '<¥0.0001';
  return `¥${value.toFixed(4)}`;
}

export function formatCloudAudioSeconds(value: number | null) {
  return value === null ? '待回执' : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)} 秒`;
}

export function analysisRequestCountLabel(usage: AnalysisUsage) {
  if (usage.attemptedRequestCount === 0) return '未发起';
  if (usage.usageComplete) return `${usage.requestCount} 次`;
  return `${usage.requestCount}/${usage.attemptedRequestCount} 次有回执`;
}

export function analysisUsageSummary(usage: AnalysisUsage | null, status: string): string {
  if (['queued', 'processing', 'claimed', 'running'].includes(status)) return '本次用量统计中';
  if (!usage) return '用量未记录';
  if (usage.totalEstimatedCostCny === null) return '本次费用待核对';
  return `本次估算 ${formatEstimatedCost(usage.totalEstimatedCostCny)}`;
}
