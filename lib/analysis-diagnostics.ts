export type AnalysisDiagnostics = {
  jobId?: string;
  videoId?: string;
  failedStage?: string;
  attemptCount?: number;
  captureAttemptCount?: number;
  attempts?: Array<{ stage: string; attempt: number; error: string; at?: string }>;
  completedSteps?: string[];
  lastError?: string;
  userAction?: string;
  versions?: Record<string, string>;
};

export const ANALYSIS_STAGE_LABELS: Record<string, string> = {
  capture: '视频地址获取', download: '完整视频下载', validation: '完整视频校验',
  cloud_asr: '口播转写', upload: '视频上传', model: '视频内容与制作规范分析', save: '结果保存',
  transcript: '口播稿', content: '视频内容分析', remotion: 'Remotion 制作规范', media: '完整视频校验',
};

// Defense in depth: only diagnostic fields are exported; never copy job payloads,
// media URLs, cookies or provider response objects into clipboard diagnostics.
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/(?:https?|oss):\/\/[^\s<>"']+/gi, '[链接已移除]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|Bearer\s+[^\s,;]+)/gi, '[凭据已移除]')
    .replace(/\b(?:cookie|set-cookie|authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|signature)["']?\s*[:=]\s*[^\r\n]+/gi, '[敏感字段已移除]');
}

export function formatAnalysisDiagnostics(value: AnalysisDiagnostics): string {
  const result = {
    jobId: value.jobId || '未记录', videoId: value.videoId || '未记录',
    failedStage: value.failedStage || '未记录',
    attemptCount: Number.isFinite(value.attemptCount) ? value.attemptCount : '未记录',
    captureAttemptCount: Number.isFinite(value.captureAttemptCount) ? value.captureAttemptCount : '未记录',
    attempts: (value.attempts || []).map(({ stage, attempt, error, at }) => ({ stage, attempt, error, at })),
    completedSteps: value.completedSteps || [], lastError: value.lastError || '未记录',
    userAction: value.userAction || '', versions: Object.fromEntries(['host', 'analysisModel', 'asrModel']
      .filter((key) => typeof value.versions?.[key] === 'string').map((key) => [key, value.versions?.[key]])),
  };
  return JSON.stringify(result, (_key, entry: unknown) => typeof entry === 'string' ? redactDiagnosticText(entry) : entry, 2);
}
