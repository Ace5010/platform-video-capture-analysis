const WEB_SOURCE = 'douyin-monitor';
const EXTENSION_SOURCE = 'douyin-monitor-extension';
const TRUSTED_DASHBOARD = location.protocol === 'http:'
  && location.port === '3000'
  && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

function postToPage(message) {
  if (!TRUSTED_DASHBOARD) return;
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

function isInvalidatedContext(error) {
  return /extension context invalidated/i.test(String(error?.message || error || ''));
}

function sendToRuntime(message, callback) {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      let runtimeError;
      try {
        runtimeError = chrome.runtime.lastError;
      } catch (error) {
        if (!isInvalidatedContext(error)) callback(undefined, error);
        return;
      }
      if (runtimeError) {
        if (!isInvalidatedContext(runtimeError)) callback(undefined, runtimeError);
        return;
      }
      callback(response, null);
    });
    return true;
  } catch (error) {
    if (!isInvalidatedContext(error)) callback(undefined, error);
    return false;
  }
}

window.addEventListener('message', (event) => {
  if (!TRUSTED_DASHBOARD
    || event.source !== window
    || event.origin !== window.location.origin
    || event.data?.source !== WEB_SOURCE) return;

  if (event.data.type === 'PING') {
    sendToRuntime(event.data, (response, runtimeError) => {
      if (runtimeError) {
        postRuntimeError(runtimeError.message);
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
        schedulerState: response.schedulerState || null,
      });
      for (const pendingResult of response.pendingResults || []) {
        postToPage(pendingResult);
      }
    });
    return;
  }

  sendToRuntime(event.data, (response, runtimeError) => {
    const requestedVideoId = event.data.videoId || event.data.video?.id || null;
    if (runtimeError) {
      postRuntimeError(
        runtimeError.message,
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
      return;
    }
    if (response?.schedulerState) postToPage({ type: 'SCHEDULER_STATE', schedulerState: response.schedulerState });
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!TRUSTED_DASHBOARD) return;
  postToPage(message);
});

if (TRUSTED_DASHBOARD) postToPage({ type: 'BRIDGE_READY' });
