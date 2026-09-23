import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
const storageData = {
  accounts: [
    { id: 'account-a', name: '账号A', url: 'https://www.douyin.com/user/a', initialSyncStatus: 'complete' },
    { id: 'account-b', name: '账号B', url: 'https://www.douyin.com/user/b', initialSyncStatus: 'complete' },
  ],
  pendingResults: [],
  connectorEventOutbox: [],
  connectorToken: 'connector-test-token',
};
const alarms = new Map();
const postedEvents = [];
const requestRecords = [];
let rejectedConnectorToken = null;

function eventSlot() {
  return {
    listener: null,
    addListener(listener) { this.listener = listener; },
    removeListener(listener) { if (this.listener === listener) this.listener = null; },
    hasListener(listener) { return this.listener === listener; },
  };
}

function storageGet(keys) {
  if (typeof keys === 'string') return { [keys]: storageData[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
  return { ...storageData };
}

const onBeforeRequest = eventSlot();
const onHeadersReceived = eventSlot();
const chrome = {
  runtime: {
    id: 'connector-test-extension',
    onInstalled: eventSlot(),
    onStartup: eventSlot(),
    onMessage: eventSlot(),
    getManifest: () => ({ version: '0.9.4' }),
    getPlatformInfo: async () => ({ os: 'win' }),
  },
  alarms: {
    onAlarm: eventSlot(),
    get: async (name) => alarms.get(name),
    create: async (name, info) => alarms.set(name, {
      name,
      scheduledTime: Date.now() + Number(info.delayInMinutes || 1) * 60_000,
      periodInMinutes: info.periodInMinutes,
    }),
    clear: async (name) => alarms.delete(name),
  },
  storage: {
    local: {
      get: async (keys) => storageGet(keys),
      set: async (patch) => Object.assign(storageData, structuredClone(patch)),
      remove: async (key) => { delete storageData[key]; },
    },
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => undefined,
    create: async () => { throw new Error('完整采集已在此测试中替换，不应创建标签页'); },
    remove: async () => undefined,
  },
  scripting: { executeScript: async () => [] },
  webRequest: { onBeforeRequest, onHeadersReceived },
};

async function fetchMock(url, options = {}) {
  const pathname = new URL(url).pathname;
  const body = options.body ? JSON.parse(options.body) : {};
  requestRecords.push({ pathname, authorization: options.headers?.Authorization || null, body });
  if (rejectedConnectorToken && options.headers?.Authorization === `Bearer ${rejectedConnectorToken}`) {
    return {
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'stale connector token' }),
    };
  }
  if (pathname === '/connector/events') postedEvents.push(structuredClone(body));
  const payload = pathname === '/connector/jobs/claim' ? { job: null }
    : pathname === '/connector/pair' ? { token: 'paired-test-token' }
      : pathname === '/connector/heartbeat' ? { job: body.jobId ? { id: body.jobId, status: 'claimed' } : null, accounts: storageData.accounts }
      : {};
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

const context = vm.createContext({
  chrome,
  console,
  crypto: webcrypto,
  URL,
  Date,
  Math,
  Object,
  Array,
  Map,
  Set,
  Promise,
  Number,
  String,
  Boolean,
  RegExp,
  Error,
  TypeError,
  JSON,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  structuredClone,
  fetch: fetchMock,
  FormData,
  Blob,
  AbortController,
});
vm.runInContext(source, context, { filename: 'background.js' });

for (let attempt = 0; attempt < 100 && !storageData.connectorState; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(alarms.get('douyin-monitor-connector-poll')?.periodInMinutes, 1);
assert.equal(requestRecords.some((record) => record.pathname === '/connector/jobs/claim'), true);
assert.equal(
  requestRecords
    .filter((record) => record.pathname === '/connector/heartbeat' || record.pathname === '/connector/jobs/claim')
    .every((record) => record.body.extensionVersion === '0.9.4'),
  true,
  'connector heartbeat and claim did not report extension v0.9.4',
);
assert.equal(
  requestRecords.filter((record) => record.pathname !== '/connector/pair')
    .every((record) => record.authorization === 'Bearer connector-test-token'),
  true,
);

rejectedConnectorToken = 'stale-connector-token';
storageData.connectorToken = rejectedConnectorToken;
requestRecords.length = 0;
await vm.runInContext('pollConnectorQueue()', context);
assert.equal(storageData.connectorToken, 'paired-test-token', 'stale connector token was not replaced immediately');
assert.equal(requestRecords.some((record) => record.pathname === '/connector/pair'), true);
assert.equal(
  requestRecords.find((record) => record.pathname === '/connector/pair')?.body.extensionVersion,
  '0.9.4',
  'connector pairing did not report extension v0.9.4',
);
assert.equal(
  requestRecords.some((record) => record.pathname === '/connector/heartbeat' && record.authorization === 'Bearer paired-test-token'),
  true,
  'heartbeat was not retried with the repaired connector token',
);
rejectedConnectorToken = null;

vm.runInContext(`
  collectAccount = async (account) => ({
    accountName: account.name,
    accountAvatarUrl: 'https://example.invalid/avatar.jpg',
    videos: [{
      id: account.id + '-video',
      accountId: account.id,
      title: account.name + '视频',
      description: '正文',
      url: 'https://www.douyin.com/video/1234567890',
      coverUrl: 'https://example.invalid/cover.jpg',
      publishedAt: '2026-08-29T00:00:00.000Z',
      durationSeconds: 10,
      likeCount: 1,
      commentCount: 2,
      favoriteCount: 3,
      shareCount: 4,
    }],
    warning: null,
  });
`, context);
context.latestJob = {
  id: 'job-latest-all',
  type: 'collect_latest',
  payload: { accountIds: ['account-a', 'account-b'] },
};
await vm.runInContext("executeConnectorJob(latestJob, 'connector-test-token')", context);

const collectionEvents = postedEvents.filter((event) => event.type === 'collection_result');
assert.equal(collectionEvents.length, 2);
assert.deepEqual(collectionEvents.map((event) => event.payload.accountId), ['account-a', 'account-b']);
assert.equal(collectionEvents.every((event) => event.payload.videos.length === 1), true);
assert.equal(collectionEvents.every((event) => event.payload.snapshots.length === 1), true);
assert.equal(postedEvents.some((event) => event.type === 'job_completed' && event.jobId === 'job-latest-all'), true);
assert.equal(storageData.pendingResults.length, 0, '后端确认 collection_result 后才应 ACK 本地 pendingResults');
assert.equal(storageData.connectorEventOutbox.length, 0);

context.captureRequests = [];
vm.runInContext(`
  captureFullVideoForAnalysis = async ({ videoId, accountId, videoUrl, requireCompleteMetadata }) => {
    captureRequests.push({ videoId, accountId, videoUrl, requireCompleteMetadata });
    return {
      videoId,
      accountId,
      sourceVideoUrl: videoUrl,
      video: {
        url: 'https://v.douyinvod.com/full-video?token=secret',
        metadata: { width: 1920, height: 1080, contentType: 'video/mp4' },
      },
      audio: {
        url: 'https://v.douyinvod.com/full-audio?token=secret',
        metadata: { contentType: 'audio/mp4' },
      },
      page: { observedVideoId: videoId, videoWidth: 1920, videoHeight: 1080 },
    };
  };
`, context);
context.analysisJob = {
  id: 'job-analysis',
  type: 'analyze_video',
  payload: {
    accountId: 'account-a',
    videoId: '1234567890',
    title: '标题',
    description: '正文',
    videoUrl: 'https://www.douyin.com/video/1234567890',
  },
};
await vm.runInContext("executeConnectorJob(analysisJob, 'connector-test-token')", context);
const mediaEvent = postedEvents.find((event) => event.type === 'analysis_media');
assert.equal(mediaEvent.payload.videoId, '1234567890');
assert.equal(mediaEvent.payload.videoUrl.includes('full-video'), true);
assert.equal(mediaEvent.payload.audioUrl.includes('full-audio'), true);
assert.equal(context.captureRequests[0].requireCompleteMetadata, false);
assert.equal(JSON.stringify(storageData).includes('token=secret'), false, '签名媒体 URL 不得写入扩展持久存储');

context.linkAnalysisJob = {
  id: 'job-link-analysis-existing-account',
  type: 'analyze_video',
  payload: {
    accountId: 'account-a',
    videoId: '1234567890',
    videoUrl: 'https://www.douyin.com/video/1234567890',
    sourceKind: 'video_link',
  },
};
await vm.runInContext("executeConnectorJob(linkAnalysisJob, 'connector-test-token')", context);
assert.equal(context.captureRequests[1].requireCompleteMetadata, true);
assert.equal(vm.runInContext(`hasCompleteVideoLinkMetadata({
  description: '标题',
  coverUrl: 'https://example.invalid/cover.jpg',
  authorName: '博主',
  authorAvatarUrl: 'https://example.invalid/avatar.jpg',
  authorProfileUrl: 'https://www.douyin.com/user/author-id',
})`, context), true);
assert.equal(vm.runInContext(`hasCompleteVideoLinkMetadata({
  description: '标题',
  coverUrl: null,
  authorName: '博主',
  authorAvatarUrl: 'https://example.invalid/avatar.jpg',
  authorProfileUrl: 'https://www.douyin.com/user/author-id',
})`, context), false);

const workerInstanceId = vm.runInContext('WORKER_INSTANCE_ID', context);
storageData.collectionLock = {
  token: 'stale-lock-token',
  ownerId: workerInstanceId,
  runId: 'stale-analysis-job',
  trigger: 'connector:analyze_video',
  startedAt: new Date(Date.now() - 21 * 60_000).toISOString(),
  heartbeatAt: new Date(Date.now() - 2 * 60_000).toISOString(),
};
vm.runInContext("collectionInProgress = true; activeConnectorJob = { id: 'stale-analysis-job', claimToken: 'old-claim' }", context);
await vm.runInContext('handleCollectionWatchdog()', context);
assert.equal(storageData.collectionLock, undefined, 'stale connector lock was not released');
assert.equal(vm.runInContext('collectionInProgress', context), false);
assert.equal(vm.runInContext('activeConnectorJob', context), null);

context.capture = vm.runInContext("createFullVideoCapture(77, 60000, '1234567890')", context);
onHeadersReceived.listener({
  tabId: 77,
  type: 'media',
  url: 'https://v.douyinvod.com/stream?width=1280&height=720&bitrate=1200&__vid=1234567890',
  responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' },
    { name: 'Content-Length', value: '5000000' },
  ],
});
onHeadersReceived.listener({
  tabId: 77,
  type: 'media',
  url: 'https://v.douyinvod.com/stream?width=1920&height=1080&bitrate=2400&__vid=1234567890',
  responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' },
    { name: 'Content-Length', value: '9000000' },
  ],
});
onHeadersReceived.listener({
  tabId: 77,
  type: 'media',
  url: 'https://v.douyinvod.com/media-audio?bitrate=256&__vid=1234567890',
  responseHeaders: [{ name: 'Content-Type', value: 'audio/mp4' }],
});
context.capture.stop();
const selected = await context.capture.promise;
assert.equal(selected.video.metadata.width, 1920);
assert.equal(selected.video.metadata.height, 1080);
assert.equal(selected.audio.metadata.bitrate, 256);

context.delayedCapture = vm.runInContext('createFullVideoCapture(78, 20)', context);
const beforeTargetActivation = await Promise.race([
  context.delayedCapture.promise.then(() => 'settled'),
  new Promise((resolve) => setTimeout(() => resolve('pending'), 35)),
]);
assert.equal(
  beforeTargetActivation,
  'pending',
  'media capture timeout must not start before the target video page is ready',
);
context.delayedCapture.markTargetActivated();
context.delayedCapture.considerCurrentSource(
  'https://v5-dy-ov-experiment.zjcdn.com/video/tos/cn/full?mime_type=video_mp4&__vid=1234567890',
  { width: 2160, height: 3840 },
);
assert.equal(context.delayedCapture.hasVideoCandidate(), true);
const delayedDiagnostics = context.delayedCapture.diagnostics();
assert.equal(delayedDiagnostics.videoCandidates, 1);
assert.equal(delayedDiagnostics.rejectedMediaUrls, 0);
const delayedSelected = await context.delayedCapture.promise;
assert.equal(delayedSelected.video.metadata.width, 2160);
assert.equal(delayedSelected.video.metadata.height, 3840);

const unboundCapture = vm.runInContext("createFullVideoCapture(79, 60000, '1234567890')", context);
const sendUnbound = (url) => onHeadersReceived.listener({ tabId: 79, type: 'media', url,
  responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '814337' }] });
sendUnbound('https://v.douyinvod.com/video/preload.mp4');
assert.equal(unboundCapture.hasVideoCandidate(), false, 'preloaded media is not proof of target ownership');
unboundCapture.markTargetActivated();
sendUnbound('https://v.douyinvod.com/video/after-playback.mp4');
sendUnbound('https://v.douyinvod.com/video/other.mp4?__vid=9999999999');
assert.equal(unboundCapture.hasVideoCandidate(), false, 'playback does not bind unrelated network requests to the target');
unboundCapture.stop();
assert.equal((await unboundCapture.promise).video, null, 'unverified media must never be returned as a successful capture');

const mergedCapture = vm.runInContext("createFullVideoCapture(80, 60000, '1234567890')", context);
const mergedSourceUrl = 'https://v.douyinvod.com/video/verified-original.mp4';
mergedCapture.considerStructuredSources({ videoCandidates: [{ url: mergedSourceUrl, width: 3840, height: 2160, bitrate: 5000 }] });
onHeadersReceived.listener({ tabId: 80, type: 'media', url: mergedSourceUrl,
  responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '9000000' }] });
onBeforeRequest.listener({ tabId: 80, type: 'media', url: mergedSourceUrl });
mergedCapture.considerCurrentSource(mergedSourceUrl, { width: 1280, height: 720 });
mergedCapture.stop();
const mergedSelected = (await mergedCapture.promise).video;
assert.equal(mergedSelected.metadata.sourceKind, 'structured', 'late network events retain verified source provenance');
assert.equal(mergedSelected.metadata.targetBound, true);
assert.equal(mergedSelected.metadata.width, 3840, 'late metadata must not downgrade the original resolution');
assert.equal(mergedSelected.metadata.contentLength, 9000000, 'late response headers supplement missing metadata');

async function chooseAnalysisResolution(videoCandidates) {
  const capture = vm.runInContext("createFullVideoCapture(81, 60000, '1234567890')", context);
  capture.considerStructuredSources({ videoCandidates: videoCandidates.map((candidate, index) => ({
    url: `https://v.douyinvod.com/video/analysis-resolution-${index}.mp4`, ...candidate,
  })) });
  capture.stop();
  return (await capture.promise).video;
}
const preferred1080 = await chooseAnalysisResolution([
  { width: 3840, height: 2160, bitrate: 8000 },
  { width: 1920, height: 1080, bitrate: 2400 },
  { width: 1920, height: 1080, bitrate: 1200 },
  { width: 1280, height: 720, bitrate: 4000 },
]);
assert.equal(preferred1080.metadata.width, 1920, 'analysis prefers 1080p over 4K and 720p');
assert.equal(preferred1080.metadata.bitrate, 2400, 'the higher bitrate wins at the same resolution');
const preferredPortrait = await chooseAnalysisResolution([
  { width: 1440, height: 1440, bitrate: 8000 },
  { width: 1080, height: 2160, bitrate: 8000 },
  { width: 1080, height: 1920, bitrate: 2400 },
  { width: 720, height: 1280, bitrate: 1200 },
]);
assert.equal(preferredPortrait.metadata.width, 1080);
assert.equal(preferredPortrait.metadata.height, 1920, 'portrait selection applies both the short-edge and total-pixel limits');
const nearestLarger = await chooseAnalysisResolution([
  { width: 3840, height: 2160, bitrate: 8000 },
  { width: 2560, height: 1440, bitrate: 3000 },
]);
assert.equal(nearestLarger.metadata.width, 2560, 'without a source at or below 1080p, choose the closest larger resolution');
const bestLower = await chooseAnalysisResolution([{ width: 960, height: 540 }, { width: 1280, height: 720 }]);
assert.equal(bestLower.metadata.width, 1280, 'videos below 1080p retain their best available resolution');
const only4k = await chooseAnalysisResolution([{ width: 3840, height: 2160 }]);
assert.equal(only4k.metadata.width, 3840, 'a 4K-only video remains usable without adding transcoding');

context.window = {
  _ROUTER_DATA: {
    loaderData: {
      target: {
        aweme_id: '1234567890',
        video: {
          width: 1920,
          height: 1080,
          bit_rate: [
            {
              bit_rate: 1200,
              gear_name: '720p',
              play_addr: { url_list: ['https://v.douyinvod.com/target-720'] },
            },
            {
              bit_rate: 2600,
              gear_name: '1080p',
              play_addr: { url_list: ['https://v.douyinvod.com/target-1080'] },
            },
          ],
          cover: { url_list: ['https://p.douyinpic.com/not-a-video'] },
        },
        music: {
          play_url: { url_list: ['https://a.zjcdn.com/target-audio'] },
        },
      },
      unrelated: {
        aweme_id: '9999999999',
        video: { play_addr: { url_list: ['https://v.douyinvod.com/unrelated'] } },
      },
    },
  },
};
context.location = { href: 'https://www.douyin.com/video/1234567890' };
context.document = { querySelectorAll: () => [] };
const structuredSources = vm.runInContext("extractVerifiedVideoMediaSources('1234567890')", context);
assert.equal(structuredSources.videoCandidates[0].url.includes('target-1080'), true);
assert.equal(structuredSources.videoCandidates.some((candidate) => candidate.url.includes('unrelated')), false);
assert.equal(structuredSources.videoCandidates.some((candidate) => candidate.url.includes('not-a-video')), false);
assert.equal(structuredSources.audioCandidates[0].url.includes('target-audio'), true);
vm.runInContext(`
  const extractionTarget = window._ROUTER_DATA.loaderData.target;
  const extractionUnsafeValue = {
    valueOf() { throw new Error('metadata valueOf must not run'); },
    toString() { throw new Error('metadata toString must not run'); },
  };
  const extractionUrls = extractionTarget.video.bit_rate[1].play_addr.url_list;
  Object.defineProperty(extractionUrls, '1', { enumerable: true, get() { throw new Error('array getter must not run'); } });
  extractionUrls.push(extractionUrls);
  const extractionCircularUrl = {};
  extractionCircularUrl.url = extractionCircularUrl;
  extractionUrls.push(extractionCircularUrl);
  extractionTarget.video.bit_rate[1].id = '5555555555';
  extractionTarget.video.bit_rate.push({ width: extractionUnsafeValue, height: extractionUnsafeValue,
    bit_rate: extractionUnsafeValue, gear_name: extractionUnsafeValue, codec: extractionUnsafeValue,
    mime_type: extractionUnsafeValue });
  extractionTarget.music.id = '7777777777';
  extractionTarget.identity = { id: extractionUnsafeValue };
  extractionTarget.recommendations = [
    { aweme_id: '9999999999', video: { play_addr: {
      url_list: ['https://v.douyinvod.com/nested-unrelated'], width: 3840, height: 2160,
    } } },
    { id: '8888888888', video: { play_addr: {
      url_list: ['https://v.douyinvod.com/generic-id-unrelated'], width: 7680, height: 4320,
    } } },
  ];
`, context);
const guardedSources = vm.runInContext("extractVerifiedVideoMediaSources('1234567890')", context, { timeout: 2000 });
assert.deepEqual(JSON.parse(JSON.stringify(guardedSources)), JSON.parse(JSON.stringify(structuredSources)),
  'unsafe accessors, cyclic URL containers and other works must preserve every target video quality and audio source');
assert.equal(vm.runInContext("allowedMediaUrl('http://v.douyinvod.com/insecure')", context), false);
assert.equal(
  vm.runInContext("MEDIA_URL_PATTERNS.includes('https://www.douyin.com/aweme/v1/play/*')", context),
  true,
  'verified Douyin play proxy is missing from the webRequest capture filter',
);
const verifiedPlayUrl = 'https://www.douyin.com/aweme/v1/play/?aid=6383&__vid=1234567890&sign=test';
assert.equal(vm.runInContext(`isVerifiedDouyinPlayUrl('${verifiedPlayUrl}', '1234567890')`, context), true);
assert.equal(vm.runInContext(`isVerifiedDouyinPlayUrl('${verifiedPlayUrl}', '9999999999')`, context), false);
assert.equal(vm.runInContext("isVerifiedDouyinPlayUrl('https://www.douyin.com/aweme/v1/play/?__vid=1234567890&__vid=9999999999', '1234567890')", context), false);
assert.equal(vm.runInContext("isVerifiedDouyinPlayUrl('https://www.douyin.com/aweme/v1/play/other?__vid=1234567890', '1234567890')", context), false);
assert.equal(vm.runInContext("isVerifiedDouyinPlayUrl('https://evil.example/aweme/v1/play/?__vid=1234567890', '1234567890')", context), false);
context.verifiedXhrPlayCandidate = vm.runInContext(
  `fullMediaCandidate('${verifiedPlayUrl}', 'xmlhttprequest', '', [], null, '1234567890')`,
  context,
);
assert.equal(context.verifiedXhrPlayCandidate?.kind, 'video');
assert.equal(
  vm.runInContext(`fullMediaCandidate('${verifiedPlayUrl}', 'other', '', [], null, '9999999999')`, context),
  null,
);
context.proxyCapture = vm.runInContext("createFullVideoCapture(79, 60000, '1234567890')", context);
context.proxyCapture.markTargetActivated();
context.proxyCapture.considerCurrentSource(verifiedPlayUrl, { width: 2160, height: 3840 });
assert.equal(context.proxyCapture.hasVideoCandidate(), true);
context.proxyCapture.stop();
const proxySelected = await context.proxyCapture.promise;
assert.equal(proxySelected.video.url, verifiedPlayUrl);

const ackIds = vm.runInContext("normalizeAckIds({ eventIds: ['a', 'b'], eventId: 'c', messageIds: ['a'] })", context);
assert.deepEqual([...ackIds], ['a', 'b', 'c']);

// A hidden tab may keep HTMLMediaElement.play() pending indefinitely. The
// activation helper must still return so the network capture can finish.
const hangingVideo = {
  getClientRects: () => [{}],
  muted: false,
  preload: '',
  currentSrc: 'https://v.douyinvod.com/target-video',
  videoWidth: 1280,
  videoHeight: 720,
  duration: 10,
  play: () => new Promise(() => {}),
};
context.document = { querySelectorAll: () => [hangingVideo] };
context.location = { href: 'https://www.douyin.com/video/1234567890', pathname: '/video/1234567890' };
const activationStartedAt = Date.now();
const activation = await vm.runInContext("activateVerifiedVideoPlayback('1234567890', 100)", context);
assert.equal(activation.targetMatches, true);
assert.equal(Date.now() - activationStartedAt < 4_000, true, 'hanging background-tab play() blocked page execution');

const sourceOnlyVideo = {
  ...hangingVideo,
  currentSrc: '',
  querySelectorAll: () => [{
    src: 'https://v5-dy-ov-experiment.zjcdn.com/video/tos/cn/full?mime_type=video_mp4&__vid=1234567890',
  }],
};
context.document = { querySelectorAll: () => [sourceOnlyVideo] };
const sourceOnlyActivation = vm.runInContext("activateVerifiedVideoPlayback('1234567890')", context);
assert.equal(sourceOnlyActivation.currentSrc, null);
assert.equal(sourceOnlyActivation.sourceUrls.length, 1);
assert.equal(sourceOnlyActivation.sourceUrls[0].includes('zjcdn.com'), true);

const visibleEmptyVideo = {
  getClientRects: () => [{}],
  muted: false,
  preload: '',
  currentSrc: '',
  src: '',
  videoWidth: 0,
  videoHeight: 0,
  duration: Number.NaN,
  querySelectorAll: () => [],
  play: () => Promise.resolve(),
};
const hiddenTargetVideo = {
  ...hangingVideo,
  getClientRects: () => [],
  currentSrc: 'https://v5-dy-ov-experiment.zjcdn.com/video/tos/cn/full?mime_type=video_mp4&__vid=1234567890',
  querySelectorAll: () => [],
};
context.document = { querySelectorAll: () => [hiddenTargetVideo, visibleEmptyVideo] };
const hiddenTargetActivation = vm.runInContext("activateVerifiedVideoPlayback('1234567890')", context);
assert.equal(hiddenTargetActivation.currentSrc, hiddenTargetVideo.currentSrc);
assert.equal(hiddenTargetActivation.videoWidth, 1280);

const targetProfileUrl = 'https://www.douyin.com/user/MS4wLjABAAAA-target-author';
const targetAvatarUrl = 'https://p3-pc.douyinpic.com/aweme/100x100/target-avatar.jpeg';
const targetCoverUrl = 'https://p3-pc-sign.douyinpic.com/target-cover.jpeg';
const targetAuthorAnchor = {
  href: targetProfileUrl,
  textContent: '目标博主',
  getAttribute: (name) => (name === 'href' ? targetProfileUrl : null),
  querySelector: () => null,
};
const targetAvatar = {
  getAttribute: (name) => (name === 'src' ? targetAvatarUrl : null),
};
const targetAuthorRoot = {
  querySelectorAll: (selector) => (selector === 'a[href*="/user/"]' ? [targetAuthorAnchor] : []),
  querySelector: (selector) => (selector === 'img[src], img[data-src]' ? targetAvatar : null),
};
const selfNavigationAnchor = {
  href: 'https://www.douyin.com/user/self?from_nav=1',
  textContent: '我的',
  getAttribute: (name) => (name === 'href' ? '/user/self?from_nav=1' : null),
};
const metadataNodes = {
  video: { poster: '', duration: 24 },
  h1: { textContent: '目标视频标题', getAttribute: () => null },
  'meta[name="lark:url:video_cover_image_url"]': {
    getAttribute: (name) => (name === 'content' ? targetCoverUrl : null),
  },
  'a[data-e2e*="author"][href*="/user/"]': selfNavigationAnchor,
};
context.document = {
  querySelector: (selector) => metadataNodes[selector] || null,
  querySelectorAll: (selector) => {
    if (selector === '[data-e2e="user-info"]') return [targetAuthorRoot];
    if (selector === 'script[type="application/ld+json"]') {
      return [{
        textContent: JSON.stringify({
          '@type': 'BreadcrumbList',
          itemListElement: [
            { position: 1, name: '抖音', item: 'https://www.douyin.com' },
            { position: 2, name: '目标博主', item: targetProfileUrl },
            { position: 3, name: '视频作品', item: 'https://www.douyin.com/video/1234567890' },
          ],
        }),
      }];
    }
    return [];
  },
};
context.location = { href: 'https://www.douyin.com/video/1234567890', pathname: '/video/1234567890' };
const extractedTargetMetadata = vm.runInContext("extractVideoDetailPage('1234567890')", context);
assert.equal(extractedTargetMetadata.authorName, '目标博主');
assert.equal(extractedTargetMetadata.authorProfileUrl, targetProfileUrl);
assert.equal(extractedTargetMetadata.authorAvatarUrl, targetAvatarUrl);
assert.equal(extractedTargetMetadata.coverUrl, targetCoverUrl);

const recommendedProfileUrl = 'https://www.douyin.com/user/MS4wLjABAAAA-recommended-author';
const recommendedAuthorAnchor = {
  href: recommendedProfileUrl,
  textContent: '推荐视频博主',
  getAttribute: (name) => (name === 'href' ? recommendedProfileUrl : null),
  querySelector: () => null,
};
const recommendedAuthorRoot = {
  querySelectorAll: (selector) => (selector === 'a[href*="/user/"]' ? [recommendedAuthorAnchor] : []),
  querySelector: () => ({ getAttribute: (name) => (name === 'src' ? 'https://p3-pc.douyinpic.com/recommended-avatar.jpeg' : null) }),
};
const wrongPosterVideo = {
  poster: 'https://p3-pc-sign.douyinpic.com/wrong-recommended-cover.jpeg',
  duration: 90,
  currentSrc: 'https://v.douyinvod.com/wrong?__vid=9999999999',
  querySelectorAll: () => [],
  closest: () => ({ classList: { contains: () => false } }),
};
const targetPosterVideo = {
  poster: 'https://p3-pc-sign.douyinpic.com/target-player-cover.jpeg',
  duration: 24,
  currentSrc: '',
  querySelectorAll: () => [],
  closest: () => ({ classList: { contains: (value) => value === 'video_1234567890' } }),
};
context.document = {
  querySelector: (selector) => (selector === 'h1' ? metadataNodes.h1 : null),
  querySelectorAll: (selector) => {
    if (selector === 'video') return [wrongPosterVideo, targetPosterVideo];
    if (selector === '[data-e2e="user-info"]') return [recommendedAuthorRoot];
    if (selector === 'script[type="application/ld+json"]') {
      return [{
        textContent: JSON.stringify({
          '@graph': [{
            '@type': 'BreadcrumbList',
            itemListElement: [
              { position: 1, name: '抖音', item: 'https://www.douyin.com' },
              { position: 2, item: { '@id': targetProfileUrl, name: '图谱目标博主' } },
              { position: 3, name: '视频作品', item: 'https://www.douyin.com/video/1234567890' },
            ],
          }],
        }),
      }];
    }
    return [];
  },
};
context.location = { href: 'https://www.douyin.com/video/1234567890', pathname: '/video/1234567890' };
const guardedTargetMetadata = vm.runInContext("extractVideoDetailPage('1234567890')", context);
assert.equal(guardedTargetMetadata.authorName, '图谱目标博主');
assert.equal(guardedTargetMetadata.authorProfileUrl, targetProfileUrl);
assert.equal(guardedTargetMetadata.authorAvatarUrl, null, 'recommended author avatar leaked into target metadata');
assert.equal(guardedTargetMetadata.coverUrl, targetPosterVideo.poster);
assert.equal(guardedTargetMetadata.durationSeconds, 24);
context.location = { href: 'https://www.douyin.com/video/9999999999', pathname: '/video/9999999999' };
assert.equal(vm.runInContext("extractVideoDetailPage('1234567890')", context), null);
context.location = { href: 'https://www.douyin.com/video/1234567890', pathname: '/video/1234567890' };
context.document = {
  querySelector: (selector) => (selector === 'h1' ? metadataNodes.h1 : null),
  querySelectorAll: (selector) => {
    if (selector === 'video') return [targetPosterVideo];
    if (selector === '[data-e2e="user-info"]') return [recommendedAuthorRoot];
    return [];
  },
};
const noBreadcrumbMetadata = vm.runInContext("extractVideoDetailPage('1234567890')", context);
assert.equal(noBreadcrumbMetadata.authorName, null);
assert.equal(noBreadcrumbMetadata.authorProfileUrl, null);
assert.equal(noBreadcrumbMetadata.authorAvatarUrl, null);

const completeMetadata = {
  description: '目标标题', coverUrl: targetCoverUrl, authorName: '目标博主',
  authorAvatarUrl: targetAvatarUrl, authorProfileUrl: targetProfileUrl,
};
const activationUpdates = [];
let activeMetadataTab = 41;
chrome.tabs.get = async () => ({ id: 42, windowId: 7 });
chrome.tabs.query = async (query) => {
  assert.equal(query.windowId, 7);
  return [{ id: activeMetadataTab }];
};
chrome.tabs.update = async (id, update) => {
  assert.equal(update.active, true);
  activationUpdates.push(id);
  activeMetadataTab = id;
};
context.metadataReads = [];
context.onMetadataRead = () => {};
vm.runInContext(`executeUntilPageCondition = async () => {
  onMetadataRead();
  const result = metadataReads.shift();
  if (result?.failure) throw new Error(result.failure);
  return result;
}`, context);
context.metadataReads = [completeMetadata];
assert.equal((await vm.runInContext("readVideoMetadataWithActivation(42, '1234567890', true)", context)).authorName, '目标博主');
assert.deepEqual(activationUpdates, [], 'complete background metadata must not activate a tab');
context.metadataReads = [{ description: '标题' }, completeMetadata];
await vm.runInContext("readVideoMetadataWithActivation(42, '1234567890', true)", context);
assert.deepEqual(activationUpdates.splice(0), [42, 41], 'fallback must restore the previous tab');
context.metadataReads = [{ description: '标题' }, completeMetadata];
context.onMetadataRead = () => { if (activeMetadataTab === 42) activeMetadataTab = 99; };
await vm.runInContext("readVideoMetadataWithActivation(42, '1234567890', true)", context);
assert.deepEqual(activationUpdates.splice(0), [42], 'fallback must not override the user switching tabs');
activeMetadataTab = 41;
context.onMetadataRead = () => {};
context.metadataReads = [{ description: '标题' }, { failure: 'page closed' }];
await assert.rejects(vm.runInContext("readVideoMetadataWithActivation(42, '1234567890', true)", context), /page closed/);
assert.deepEqual(activationUpdates.splice(0), [42, 41], 'fallback must restore focus after extraction failure');
context.metadataReads = [null];
assert.equal(await vm.runInContext("readVideoMetadataWithActivation(42, '1234567890', true)", context), null);
assert.deepEqual(activationUpdates, [], 'a mismatched target must not trigger activation');

console.log('Connector validation passed: automatic auth repair, stale-lock recovery, authenticated queueing, full-video handoff, URL hygiene, verified 1080p stream preference, and metadata activation with focus restoration.');

context.savedMetadataForRetry = { ...completeMetadata, videoId: '1234567890' };
context.metadataReads = [{ description: '新的标题' }];
const restoredRetry = await vm.runInContext("readVideoMetadataWithActivation(42, '1234567890', true, savedMetadataForRetry)", context);
assert.equal(restoredRetry.authorName, completeMetadata.authorName);
assert.equal(restoredRetry.description, '新的标题');
assert.deepEqual(activationUpdates, [], 'complete saved target metadata should avoid unnecessary activation');
assert.equal(vm.runInContext("mergeSavedVideoMetadata(null, savedMetadataForRetry, '1234567890')", context), null);
assert.equal(vm.runInContext("mergeSavedVideoMetadata({description:'标题'}, savedMetadataForRetry, '9999999999').authorName", context), undefined);
console.log('Saved target metadata fallback passed: same-video only, fresh values win, switched-page guard retained.');

context.location = { href: 'https://www.douyin.com/video/1234567890', pathname: '/video/1234567890' };
context.document = { querySelector: selector => selector === 'video' ? {} : null };
assert.equal(vm.runInContext("inspectAnalysisVideoReady('1234567890').ready", context), true, 'player must not depend on social controls');
assert.equal(vm.runInContext("inspectAnalysisVideoReady('9999999999').ready", context), false);
context.document = { querySelector: () => null };
assert.equal(vm.runInContext("inspectAnalysisVideoReady('1234567890').ready", context), false);
activeMetadataTab = 41;
context.metadataReads = [{ready:false,targetMatches:true}, {ready:true,targetMatches:true}];
assert.equal((await vm.runInContext("waitForAnalysisVideoReady(42, '1234567890')", context)).ready, true);
assert.deepEqual(activationUpdates.splice(0), [42,41]);
context.metadataReads = [{ready:false,targetMatches:false}];
assert.equal((await vm.runInContext("waitForAnalysisVideoReady(42, '1234567890')", context)).targetMatches, false);
assert.deepEqual(activationUpdates, []);
context.metadataReads = [{ready:false,targetMatches:true}, {failure:'page closed'}];
await assert.rejects(vm.runInContext("waitForAnalysisVideoReady(42, '1234567890')", context), /page closed/);
assert.deepEqual(activationUpdates.splice(0), [42,41]);
console.log('Analysis player readiness passed: no social controls required, active retry, target guard, focus restoration.');

assert.equal(vm.runInContext("LATEST_CHECK_VIDEOS", context), 5);
