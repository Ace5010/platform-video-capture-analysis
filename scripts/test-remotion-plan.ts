import assert from 'node:assert/strict';
import { isRemotionPlan, isVideoContentAnalysis, videoContentAnalysis, videoContentReading, formatRemotionPlan, REMOTION_PLAN_SECTIONS, CONTENT_ANALYSIS_SECTIONS } from '../lib/remotion-plan.ts';

const plan = {
  schemaVersion: 'remotion-plan-v1',
  projectSettings: '【实测】1080×1920，30 fps，12 秒。总帧数 360。',
  assetList: 'A001：录屏，来源待确认。',
  shotTimeline: 'S001：[0,12) 秒；from=0，durationInFrames=360，使用 A001。',
  visualDesign: 'S001：字幕底部居中，白字。',
  motionAndTransitions: 'S001：静态录屏，末尾硬切。',
  audioAndCaptions: '无逐字时间戳，制作时校对字幕。',
  productionSteps: '建立 Composition，编排 S001，预览首末帧并试渲染。',
  uncertainties: 'A001 原素材与字体待确认。',
};
assert.equal(isRemotionPlan({ summary: '旧版分析', topic: '旧选题' }), false);
assert.equal(isRemotionPlan({ ...plan, schemaVersion: 'future-version' }), false);
for (const [key] of REMOTION_PLAN_SECTIONS) {
  assert.equal(isRemotionPlan({ ...plan, [key]: '  ' }), false, `empty ${key}`);
  assert.equal(isRemotionPlan({ ...plan, [key]: undefined }), false, `missing ${key}`);
}
assert.ok(isRemotionPlan(plan));
const exported = formatRemotionPlan(plan, '复现测试', 'https://www.douyin.com/video/123', '测试口播。');
for (const [key, label] of REMOTION_PLAN_SECTIONS) {
  assert.ok(exported.includes(`## ${label}\n\n${plan[key]}`));
}
assert.ok(exported.includes('测试口播。'));
assert.ok(exported.includes('https://www.douyin.com/video/123'));
console.log('Remotion plan compatibility and handoff export tests passed.');

const combined = {...plan, schemaVersion: 'remotion-plan-v2', contentAnalysis: '这是一段融合的视频内容分析。'};
assert.ok(isRemotionPlan(combined));
assert.equal(isRemotionPlan({...combined, contentAnalysis: ''}), true, 'complete production remains readable when content fails');
assert.equal(isRemotionPlan({...combined, contentAnalysis: undefined}), true);
assert.equal(videoContentAnalysis(combined), combined.contentAnalysis);
assert.equal(videoContentAnalysis({summary:'摘要', topic:'主题', visualContent:'画面', corePoint:'摘要'}), '摘要\n\n主题\n\n画面');
assert.equal(videoContentAnalysis(plan), '', 'historical production plan must not be mislabeled as content analysis');
assert.equal(formatRemotionPlan(combined, '标题', '链接', null).includes(combined.contentAnalysis), false, 'production export must stay separate');
console.log('Combined content analysis and separate production specification tests passed.');

const content = {
  quickOverview: '视频演示两个设置的导出速度；只展示同一台电脑的一次对比。',
  keyInformation: '【画面展示】作者更改设置后导出同一个片段。',
  claimsAndEvidence: '【作者说法】速度翻倍。【AI解释/推断】画面只支持这次导出耗时更少，不能证明普遍翻倍。',
  visualDemonstrations: '【画面展示】并列显示两次导出用时；没有展示重复测量。',
  scopeAndLimits: '【未核实】硬件与缓存条件未提供，不能推广到其他设备。',
};
const structured = { ...plan, schemaVersion: 'remotion-plan-v3', contentAnalysis: content };
assert.ok(isVideoContentAnalysis(content));
assert.ok(isRemotionPlan(structured));
const reading = videoContentReading(structured);
assert.equal(reading.overview, content.quickOverview);
assert.equal(reading.legacy, false);
assert.equal(reading.sections.length, 1);
assert.equal(reading.sections[0].label, '具体信息与演示');
for (const [key] of CONTENT_ANALYSIS_SECTIONS) {
  assert.ok(videoContentAnalysis(structured).includes(content[key]), `saved ${key} remains readable and exportable`);
}
for (const [key] of CONTENT_ANALYSIS_SECTIONS) {
  assert.equal(isVideoContentAnalysis({ ...content, [key]: '' }), key !== 'quickOverview');
  assert.equal(isVideoContentAnalysis({ ...content, [key]: undefined }), false, `missing ${key} is still invalid`);
  assert.equal(isVideoContentAnalysis({ ...content, [key]: null }), false, `non-text ${key} is still invalid`);
}
assert.equal(isVideoContentAnalysis({ ...content, quickOverview: '  ' }), false);
const conciseContent = { quickOverview: '作者说明收藏夹可以按项目分类。', keyInformation: '', claimsAndEvidence: '', visualDemonstrations: '', scopeAndLimits: '' };
const conciseReading = videoContentReading({ contentAnalysis: conciseContent });
assert.equal(conciseReading.complete, true, 'no extra demonstration is a valid complete result, not paid backfill work');
assert.deepEqual(conciseReading.sections, [], 'empty supplemental fields do not render placeholder sections');
assert.equal(videoContentAnalysis({ contentAnalysis: conciseContent }), `主要内容\n${conciseContent.quickOverview}`);
const detailedSummary = Array.from({ length: 12 }, (_, index) => `第${index + 1}项内容：作者解释了这一步的原因、适用条件和例子。`).join('\n\n') + '\n\n最后，作者说明了前述方法的关键例外。';
const detailedResult = { contentAnalysis: { ...conciseContent, quickOverview: detailedSummary, visualDemonstrations: '作者连续操作两次，列表先按时间排列，再改为按项目排列。' } };
assert.equal(videoContentReading(detailedResult).overview, detailedSummary, 'information-rich summaries must not be truncated by a sentence or preview limit');
assert.equal(videoContentAnalysis(detailedResult), `主要内容\n${detailedSummary}\n\n具体信息与演示\n${detailedResult.contentAnalysis.visualDemonstrations}`);
assert.equal(isVideoContentAnalysis({ ...content, injectedField: 'unexpected' }), false);
assert.equal(videoContentReading({ title: '看起来很详细的标题' }).available, false, 'metadata cannot fabricate an overview');
assert.equal(videoContentReading(plan).available, false, 'production-only history has no content overview');
const legacyReading = videoContentReading(combined);
assert.equal(legacyReading.legacy, true);
assert.equal(legacyReading.sections[0].text, combined.contentAnalysis, 'saved old prose is retained verbatim');
const headedProse = '视频内容分析：\n\n核心内容：作者实测两个导出设置，并展示同一片段的耗时。\n\n测试只执行一次。';
assert.equal(videoContentReading({ contentAnalysis: headedProse }).overview, '核心内容：作者实测两个导出设置，并展示同一片段的耗时。', 'skip a standalone analysis label in the overview');
assert.equal(videoContentReading({ contentAnalysis: headedProse }).sections[0].text, headedProse, 'overview extraction never rewrites the full saved analysis');
assert.equal(videoContentReading({ summary: '视频内容分析：', contentAnalysis: headedProse }).overview, '核心内容：作者实测两个导出设置，并展示同一片段的耗时。', 'a heading-only summary must not hide the actual content');
assert.equal(videoContentReading({ contentAnalysis: '## 视频内容分析\n**核心内容：**\n\n作者展示了导出耗时。' }).overview, '作者展示了导出耗时。', 'skip markdown headings as well');
assert.equal(videoContentReading({ contentAnalysis: '视频内容分析：' }).overview, '', 'do not invent content for a heading-only legacy record');
assert.equal(videoContentReading({ contentAnalysis: '视频内容分析：\n\n一、核心内容\n\n作者展示了导出耗时。' }).overview, '作者展示了导出耗时。', 'skip a numbered standalone section label');
assert.equal(videoContentReading({ summary: '旧摘要', visualContent: '演示画面' }).overview, '旧摘要');
assert.equal(videoContentReading({ summary: '旧摘要', visualContent: '演示画面' }).sections[0].text, '演示画面');
assert.equal(videoContentReading({ summary: '旧摘要', visualContent: '演示画面' }).complete, false, 'readable fragments are not a complete analysis');
assert.equal(videoContentReading(Object.fromEntries(['summary', 'topic', 'corePoint', 'visualContent', 'personActions', 'onScreenText', 'structureNarrative'].map(key => [key, `原文${key}`]))).complete, true);
assert.equal(isVideoContentAnalysis({ ...content, keyInformation: '字'.repeat(50_001) }), false, 'front end shares the schema length limit');
assert.ok(!formatRemotionPlan(structured, '标题', '链接', null).includes(content.quickOverview));
console.log('Structured reading, original legacy text, and independent result section tests passed.');
