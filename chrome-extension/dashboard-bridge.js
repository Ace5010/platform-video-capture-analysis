const WEB_SOURCE = 'douyin-monitor';
const EXTENSION_SOURCE = 'douyin-monitor-extension';

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== WEB_SOURCE) return;
  chrome.runtime.sendMessage(event.data, () => {
    if (chrome.runtime.lastError) {
      window.postMessage({ source: EXTENSION_SOURCE, type: 'COLLECTION_ERROR', message: chrome.runtime.lastError.message }, window.location.origin);
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  window.postMessage({ source: EXTENSION_SOURCE, ...message }, window.location.origin);
});

window.postMessage({ source: EXTENSION_SOURCE, type: 'BRIDGE_READY' }, window.location.origin);
