export const REMOTION_PLAN_VERSION = 'remotion-plan-v3';

export const CONTENT_ANALYSIS_SECTIONS = [
  ['quickOverview', '主要内容'],
  ['keyInformation', '具体信息'],
  ['claimsAndEvidence', '补充解释'],
  ['visualDemonstrations', '测试、操作与画面结果'],
  ['scopeAndLimits', '必要提醒'],
] as const;

export type VideoContentAnalysis = Record<typeof CONTENT_ANALYSIS_SECTIONS[number][0], string>;
export type ContentReadingSection = { key: string; label: string; text: string };
export type VideoContentReading = {
  overview: string;
  sections: ContentReadingSection[];
  legacy: boolean;
  available: boolean;
  complete: boolean;
};

export const REMOTION_PLAN_SECTIONS = [
  ['projectSettings', '工程设置'],
  ['assetList', '素材清单'],
  ['shotTimeline', '逐镜头时间线'],
  ['visualDesign', '画面、图层与字幕规范'],
  ['motionAndTransitions', '动效与转场实现'],
  ['audioAndCaptions', '音轨与字幕对齐'],
  ['productionSteps', 'Remotion 制作与验收步骤'],
  ['uncertainties', '待确认项与复现差异'],
] as const;

export type RemotionPlan = {
  schemaVersion: 'remotion-plan-v1' | 'remotion-plan-v2' | typeof REMOTION_PLAN_VERSION;
  contentAnalysis?: string | VideoContentAnalysis;
} & Record<typeof REMOTION_PLAN_SECTIONS[number][0], string>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isVideoContentAnalysis(value: unknown): value is VideoContentAnalysis {
  const source = record(value);
  return source !== null && Object.keys(source).length === CONTENT_ANALYSIS_SECTIONS.length
    && text(source.quickOverview).length > 0
    && CONTENT_ANALYSIS_SECTIONS.every(([key]) => typeof source[key] === 'string' && source[key].length <= 50_000);
}

export function isRemotionPlan(value: unknown): value is RemotionPlan {
  const source = record(value);
  if (!source) return false;
  const supported = source.schemaVersion === 'remotion-plan-v1' || source.schemaVersion === 'remotion-plan-v2'
    || source.schemaVersion === REMOTION_PLAN_VERSION;
  // Result sections are independent: a missing content analysis must never
  // hide a complete production specification saved by an earlier attempt.
  return supported && REMOTION_PLAN_SECTIONS.every(([key]) =>
    typeof source[key] === 'string' && source[key].trim().length > 0);
}

const LEGACY_CONTENT_SECTIONS = [
  ['summary', '已有摘要'], ['topic', '主题'], ['corePoint', '主要观点'],
  ['visualContent', '画面内容'], ['personActions', '人物与操作'],
  ['onScreenText', '画面文字'], ['structureNarrative', '内容组织'],
] as const;

function legacyOverviewExcerpt(prose: string): string {
  const isHeading = (line: string) => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) return true;
    const label = trimmed.replace(/^\*\*(.*?)\*\*[:：]?$/, '$1')
      .replace(/^(?:[一二三四五六七八九十百]+|\d+)[、.．]\s*/, '').replace(/[:：]$/, '').trim();
    return /^(?:视频内容分析|内容分析|核心内容|核心信息|主要观点|观点与依据|画面演示|适用范围|限制与未知|快速概览|摘要|主题|结论)$/.test(label);
  };
  const paragraph = prose.split(/\n\s*\n/)
    .map((part) => part.split('\n').filter((line) => !isHeading(line)).join('\n').trim())
    .find(Boolean) || '';
  return paragraph.length <= 220 ? paragraph : `${paragraph.slice(0, 220)}…`;
}

export function videoContentReading(value: unknown): VideoContentReading {
  const source = record(value);
  if (!source) return { overview: '', sections: [], legacy: false, available: false, complete: false };
  if (isVideoContentAnalysis(source.contentAnalysis)) {
    const content = source.contentAnalysis;
    // Keep saved wording intact, including older evidence labels. Empty optional
    // details are intentional; they must not trigger a paid "missing section" repair.
    const details = [content.keyInformation, content.visualDemonstrations, content.claimsAndEvidence, content.scopeAndLimits]
      .map((item) => item.trim()).filter(Boolean).join('\n\n');
    return {
      overview: content.quickOverview.trim(),
      sections: details ? [{ key: 'details', label: '具体信息与演示', text: details }] : [],
      legacy: false, available: true, complete: true,
    };
  }
  const prose = text(source.contentAnalysis);
  if (prose) {
    // This is an extract of saved prose, never an inferred summary from a title.
    const excerpt = legacyOverviewExcerpt(text(source.summary)) || legacyOverviewExcerpt(prose);
    return { overview: excerpt, sections: [{ key: 'legacyAnalysis', label: '已有内容分析', text: prose }], legacy: true, available: true, complete: true };
  }
  const seen = new Set<string>();
  const sections = LEGACY_CONTENT_SECTIONS.flatMap(([key, label]) => {
    const content = text(source[key]);
    if (!content || seen.has(content)) return [];
    seen.add(content);
    return [{ key, label, text: content }];
  });
  return { overview: text(source.summary), sections: sections.filter(section => section.key !== 'summary'), legacy: true, available: sections.length > 0,
    complete: LEGACY_CONTENT_SECTIONS.every(([key]) => text(source[key]).length > 0) };
}

export function videoContentAnalysis(value: unknown): string {
  const source = record(value);
  if (!source) return '';
  if (isVideoContentAnalysis(source.contentAnalysis)) {
    const reading = videoContentReading(value);
    return [`主要内容\n${reading.overview}`, ...reading.sections.map((section) => `${section.label}\n${section.text}`)].join('\n\n');
  }
  if (text(source.contentAnalysis)) return text(source.contentAnalysis);
  return ['summary', 'topic', 'corePoint', 'visualContent', 'personActions', 'onScreenText', 'structureNarrative']
    .map((key) => typeof source[key] === 'string' ? source[key].trim() : '')
    .filter((text, index, all) => text && all.indexOf(text) === index)
    .join('\n\n');
}

export function formatRemotionPlan(plan: RemotionPlan, title: string, url: string, transcript: string | null): string {
  return [
    `# Remotion 视频复现制作方案：${title}`,
    `参考视频：${url}`,
    '本文件是制作交接方案。观察结果、复现建议和待确认项以各章节标注为准。',
    ...REMOTION_PLAN_SECTIONS.map(([key, label]) => `## ${label}\n\n${plan[key]}`),
    `## 完整口播稿（无逐字时间戳）\n\n${transcript ?? '尚未生成口播稿。'}`,
  ].join('\n\n');
}
