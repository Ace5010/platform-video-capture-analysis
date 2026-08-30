import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bridgeSource = await readFile(new URL('../chrome-extension/dashboard-bridge.js', import.meta.url), 'utf8');
const postedMessages = [];
let pageMessageListener = null;
let reloadCalls = 0;
const locationObject = {
  protocol: 'http:',
  hostname: 'localhost',
  port: '3000',
  origin: 'http://localhost:3000',
  reload() { reloadCalls += 1; },
};

const windowObject = {
  location: locationObject,
  setTimeout,
  addEventListener(type, listener) {
    if (type === 'message') pageMessageListener = listener;
  },
  removeEventListener(type, listener) {
    if (type === 'message' && pageMessageListener === listener) pageMessageListener = null;
  },
  postMessage(message) {
    postedMessages.push(structuredClone(message));
  },
};

const context = vm.createContext({
  window: windowObject,
  location: locationObject,
  chrome: {
    runtime: {
      sendMessage() {
        throw new Error('Extension context invalidated.');
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
  },
  structuredClone,
  String,
  RegExp,
});

vm.runInContext(bridgeSource, context, { filename: 'dashboard-bridge.js' });
assert.equal(typeof pageMessageListener, 'function');

assert.doesNotThrow(() => {
  pageMessageListener({
    source: windowObject,
    origin: locationObject.origin,
    data: { source: 'douyin-monitor', type: 'PING' },
  });
});

assert.equal(
  postedMessages.some((message) => message.type === 'COLLECTION_ERROR'),
  false,
  '扩展刷新导致的上下文失效不应再变成未捕获异常或采集错误',
);
assert.equal(
  postedMessages.some((message) => message.type === 'BRIDGE_STALE'),
  true,
  '扩展上下文失效后没有通知网页自动重连',
);
await new Promise((resolve) => setTimeout(resolve, 400));
assert.equal(reloadCalls, 1, '扩展上下文失效后没有自动刷新页面以重新注入桥接');

console.log('Dashboard bridge validation passed: invalidated contexts trigger safe automatic reconnection.');
