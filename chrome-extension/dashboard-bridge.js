const WEB_SOURCE = 'douyin-monitor';
const EXTENSION_SOURCE = 'douyin-monitor-extension';

function postToPage(message) {
  window.postMessage({ ...message, source: EXTENSION_SOURCE }, window.location.origin);
}

function postRuntimeError(message, accountId = null, videoId = null) {
  postToPage({
    type: videoId ? 'TRANSCRIPT_ERROR' : 'COLLECTION_ERROR',
    accountId,
    videoId,
    message,
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== WEB_SOURCE) return;

  if (event.data.type === 'PING') {
    chrome.runtime.sendMessage(event.data, (response) => {
      if (chrome.runtime.lastError) {
        postRuntimeError(chrome.runtime.lastError.message);
        return;
      }
      if (!response?.ok) {
        postRuntimeError(response?.error || 'Chrome 采集组件没有响应');
        return;
      }
      postToPage({
        type: 'BRIDGE_READY',
        extensionVersion: response.extensionVersion,
        pendingCount: Array.isArray(response.pendingResults) ? response.pendingResults.length : 0,
      });
      for (const pendingResult of response.pendingResults || []) {
        postToPage(pendingResult);
      }
    });
    return;
  }

  chrome.runtime.sendMessage(event.data, (response) => {
    const requestedVideoId = event.data.videoId || event.data.video?.id || null;
    if (chrome.runtime.lastError) {
      postRuntimeError(
        chrome.runtime.lastError.message,
        event.data.accountId || null,
        requestedVideoId,
      );
      return;
    }
    if (response?.accepted === false || response?.ok === false) {
      postRuntimeError(
        response.error || 'Chrome 采集组件拒绝了请求',
        event.data.accountId || null,
        requestedVideoId,
      );
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  postToPage(message);
});

postToPage({ type: 'BRIDGE_READY' });
