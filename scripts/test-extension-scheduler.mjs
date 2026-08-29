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

function eventSlot() {
  return {
    listener: null,
    addListener(listener) {
      this.listener = listener;
    },
    removeListener() {},
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
    onInstalled: eventSlot(),
    onStartup: eventSlot(),
    onMessage: runtimeOnMessage,
    getManifest: () => ({ version: '0.5.0' }),
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
    create: async () => { throw new Error('测试不应启动真实采集'); },
    remove: async () => undefined,
  },
  scripting: { executeScript: async () => [] },
  webRequest: { onBeforeRequest: eventSlot() },
};

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
  fetch,
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
    runtimeOnMessage.listener(message, { tab: { id: 7 } }, sendResponse);
  });
}

const ping = await sendMessage({ source: 'douyin-monitor', type: 'PING' });
assert.equal(ping.ok, true);
assert.equal(ping.extensionVersion, '0.5.0');
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

console.log('Scheduler validation passed: alarm, status snapshot, account sync, removal, and completed-state preservation.');
