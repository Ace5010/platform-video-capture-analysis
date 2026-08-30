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
    getManifest: () => ({ version: '0.7.0' }),
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

vm.runInContext(`
  captureFullVideoForAnalysis = async ({ videoId, accountId, videoUrl }) => ({
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
  });
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
assert.equal(JSON.stringify(storageData).includes('token=secret'), false, '签名媒体 URL 不得写入扩展持久存储');

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

context.capture = vm.runInContext('createFullVideoCapture(77, 60000)', context);
onHeadersReceived.listener({
  tabId: 77,
  type: 'media',
  url: 'https://v.douyinvod.com/stream?width=1280&height=720&bitrate=1200',
  responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' },
    { name: 'Content-Length', value: '5000000' },
  ],
});
onHeadersReceived.listener({
  tabId: 77,
  type: 'media',
  url: 'https://v.douyinvod.com/stream?width=1920&height=1080&bitrate=2400',
  responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' },
    { name: 'Content-Length', value: '9000000' },
  ],
});
onHeadersReceived.listener({
  tabId: 77,
  type: 'media',
  url: 'https://v.douyinvod.com/media-audio?bitrate=256',
  responseHeaders: [{ name: 'Content-Type', value: 'audio/mp4' }],
});
context.capture.stop();
const selected = await context.capture.promise;
assert.equal(selected.video.metadata.width, 1920);
assert.equal(selected.video.metadata.height, 1080);
assert.equal(selected.audio.metadata.bitrate, 256);

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
assert.equal(vm.runInContext("allowedMediaUrl('http://v.douyinvod.com/insecure')", context), false);

const ackIds = vm.runInContext("normalizeAckIds({ eventIds: ['a', 'b'], eventId: 'c', messageIds: ['a'] })", context);
assert.deepEqual([...ackIds], ['a', 'b', 'c']);

console.log('Connector validation passed: automatic auth repair, stale-lock recovery, authenticated queueing, full-video handoff, URL hygiene, and quality-first stream selection.');
