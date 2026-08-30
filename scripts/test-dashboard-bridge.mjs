import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bridgeSource = await readFile(new URL('../chrome-extension/dashboard-bridge.js', import.meta.url), 'utf8');
const postedMessages = [];
let pageMessageListener = null;
const locationObject = {
  protocol: 'http:',
  hostname: 'localhost',
  port: '3000',
  origin: 'http://localhost:3000',
};

const windowObject = {
  location: locationObject,
  addEventListener(type, listener) {
    if (type === 'message') pageMessageListener = listener;
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
      onMessage: { addListener() {} },
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

console.log('Dashboard bridge validation passed: invalidated extension contexts are ignored safely.');
