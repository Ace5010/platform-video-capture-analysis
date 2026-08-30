import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const extensionSource = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
const storageData = {
  accounts: [
    { id: 'account-a', url: 'https://www.douyin.com/user/a', initialSyncStatus: 'complete' },
    { id: 'account-b', url: 'https://www.douyin.com/user/b', initialSyncStatus: 'pending' },
    { id: 'account-c', url: 'https://www.douyin.com/user/c', initialSyncStatus: 'complete' },
  ],
  pendingResults: [],
};
const alarms = new Map();
const deliveredMessages = [];
let keepAliveCalls = 0;

function eventSlot() {
  return {
    listener: null,
    addListener(listener) {
      this.listener = listener;
    },
    removeListener(listener) {
      if (this.listener === listener) this.listener = null;
    },
    hasListener(listener) {
      return this.listener === listener;
    },
  };
}

function storageGet(keys) {
  if (typeof keys === 'string') return { [keys]: storageData[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, storageData[key] ?? fallback]));
  }
  return { ...storageData };
}

const runtimeOnMessage = eventSlot();
const chrome = {
  runtime: {
    id: 'scheduler-test-extension',
    onInstalled: eventSlot(),
    onStartup: eventSlot(),
    onMessage: runtimeOnMessage,
    getManifest: () => ({ version: '0.7.0' }),
    getPlatformInfo: async () => {
      keepAliveCalls += 1;
      return { os: 'win' };
    },
  },
  alarms: {
    onAlarm: eventSlot(),
    get: async (name) => alarms.get(name),
    create: async (name, info) => {
      alarms.set(name, {
        name,
        periodInMinutes: info.periodInMinutes,
        scheduledTime: Date.now() + info.delayInMinutes * 60 * 1000,
      });
    },
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
    sendMessage: async (_tabId, message) => {
      deliveredMessages.push(structuredClone(message));
    },
    create: async () => { throw new Error('测试不应启动真实采集'); },
    remove: async () => undefined,
  },
  scripting: { executeScript: async () => [] },
  webRequest: {
    onBeforeRequest: eventSlot(),
    onHeadersReceived: eventSlot(),
  },
};

async function fetchMock(url) {
  const pathname = new URL(url).pathname;
  const payload = pathname === '/connector/pair'
    ? { token: 'scheduler-test-token' }
    : pathname === '/connector/jobs/claim'
      ? { job: null }
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
vm.runInContext(extensionSource, context, { filename: 'background.js' });

for (let attempt = 0; attempt < 50 && !storageData.schedulerState; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

assert.equal(alarms.get('douyin-monitor-six-hour-check')?.periodInMinutes, 360);
assert.equal(storageData.schedulerState?.alarmRegistered, true);
assert.equal(storageData.schedulerState?.monitoredAccountCount, 2);
assert.ok(Date.parse(storageData.schedulerState?.nextRunAt) > Date.now());

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`消息无响应：${message.type}`)), 1000);
    const sendResponse = (response) => {
      clearTimeout(timeout);
      resolve(response);
    };
    runtimeOnMessage.listener(message, {
      id: chrome.runtime.id,
      tab: { id: 7, url: 'http://localhost:3000/' },
    }, sendResponse);
  });
}

const ping = await sendMessage({ source: 'douyin-monitor', type: 'PING' });
assert.equal(ping.ok, true);
assert.equal(ping.extensionVersion, '0.7.0');
assert.equal(ping.schedulerState.monitoredAccountCount, 2);

const synced = await sendMessage({
  source: 'douyin-monitor',
  type: 'SYNC_ACCOUNTS',
  accounts: [
    { id: 'account-a', url: 'https://www.douyin.com/user/a', initialSyncStatus: 'pending' },
    { id: 'account-b', url: 'https://www.douyin.com/user/b', initialSyncStatus: 'complete' },
  ],
});
assert.equal(synced.ok, true);
assert.deepEqual(storageData.accounts.map((account) => account.id), ['account-a', 'account-b']);
assert.equal(storageData.accounts[0].initialSyncStatus, 'complete');
assert.equal(storageData.schedulerState.monitoredAccountCount, 2);

storageData.pendingResults.push({ messageId: 'ack-by-event-id', type: 'COLLECTION_RESULT' });
const acknowledged = await sendMessage({
  source: 'douyin-monitor',
  type: 'ACK_RESULTS',
  eventIds: ['ack-by-event-id'],
});
assert.equal(acknowledged.ok, true);
assert.equal(storageData.pendingResults.some((item) => item.messageId === 'ack-by-event-id'), false);

const manualLock = await vm.runInContext("acquireCollectionLock('manual', 'manual-test-run')", context);
await vm.runInContext("runScheduledCollection('alarm')", context);
assert.equal(storageData.schedulerState.lastRunStatus, 'queued');
assert.ok(storageData.scheduledCatchUp?.queuedAt);
delete storageData.scheduledCatchUp;
context.manualLock = manualLock;
await vm.runInContext('releaseCollectionLock(manualLock)', context);

context.batchAccounts = [
  { id: 'batch-a', name: '账号A', url: 'https://www.douyin.com/user/batch-a', initialSyncStatus: 'complete', syncMode: 'latest' },
  { id: 'batch-b', name: '账号B', url: 'https://www.douyin.com/user/batch-b', initialSyncStatus: 'complete', syncMode: 'latest' },
  { id: 'batch-c', name: '账号C', url: 'https://www.douyin.com/user/batch-c', initialSyncStatus: 'complete', syncMode: 'latest' },
];
vm.runInContext(`
  collectAccount = async (account, mode, onProgress) => {
    await onProgress({ stage: 'video-detail', completed: 1, total: 1 });
    if (account.id === 'batch-b') throw new Error('模拟单账号失败');
    return {
      accountName: account.name,
      accountAvatarUrl: null,
      videos: [{ id: account.id + '-video', accountId: account.id, url: 'https://www.douyin.com/video/123' }],
      warning: null,
    };
  };
`, context);

const batchSummary = await vm.runInContext(`
  keepServiceWorkerAliveUntil(
    () => collectAll(batchAccounts, 7, { runId: 'test-run' }),
    null,
  )
`, context);
assert.equal(batchSummary.total, 3);
assert.equal(batchSummary.succeeded, 2);
assert.equal(batchSummary.failed, 1);
assert.deepEqual(
  deliveredMessages.filter((message) => message.type === 'COLLECTION_STARTED').map((message) => message.accountId),
  ['batch-a', 'batch-b', 'batch-c'],
);
assert.equal(deliveredMessages.filter((message) => message.type === 'COLLECTION_BATCH_COMPLETED').length, 1);
assert.equal(deliveredMessages.some((message) => message.type?.startsWith('COLLECTION_') && 'progress' in message), false);
assert.ok(keepAliveCalls >= 1);

console.log('Scheduler validation passed: alarm, status snapshot, account sync, multi-account continuation, and semantic batch completion.');
