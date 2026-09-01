(() => {
  const WEB_SOURCE = 'douyin-monitor';
  const EXTENSION_SOURCE = 'douyin-monitor-extension';
  const BRIDGE_SLOT = '__DOUYIN_MONITOR_DASHBOARD_BRIDGE__';
  const TRUSTED_DASHBOARD = location.protocol === 'http:'
    && location.port === '3000'
    && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  if (!TRUSTED_DASHBOARD) return;

  const previous = globalThis[BRIDGE_SLOT];
  if (previous?.dispose) {
    try { previous.dispose(); } catch { /* replace a stale bridge in place */ }
  }
  let staleReloadScheduled = false;
  const staleReloadKey = '__DOUYIN_MONITOR_BRIDGE_RELOAD_AT__';

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

  function isInvalidatedContext(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ''));
  }

  function postStaleBridge() {
    postToPage({
      type: 'BRIDGE_STALE',
      message: 'Chrome 组件正在自动重新连接',
    });
    // A content script cannot revive an invalidated extension context. A
    // single page reload causes Chrome to inject the current bridge again,
    // which is enough to recover after an extension update/restart without
    // asking the user to refresh the component manually. Guard the reload so
    // a permanently disabled extension cannot create a tight reload loop.
    if (staleReloadScheduled) return;
    let previousReloadAt = 0;
    try { previousReloadAt = Number(sessionStorage.getItem(staleReloadKey) || 0); } catch { /* storage may be blocked */ }
    if (previousReloadAt && Date.now() - previousReloadAt < 15_000) return;
    try { sessionStorage.setItem(staleReloadKey, String(Date.now())); } catch { /* best effort */ }
    staleReloadScheduled = true;
    if (typeof window.setTimeout === 'function') {
      window.setTimeout(() => {
        try { window.location.reload(); } catch { /* the page may have closed */ }
      }, 350);
    }
  }

  function sendToRuntime(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        let runtimeError;
        try {
          runtimeError = chrome.runtime.lastError;
        } catch (error) {
          if (isInvalidatedContext(error)) postStaleBridge();
          else callback(undefined, error);
          return;
        }
        if (runtimeError) {
          if (isInvalidatedContext(runtimeError)) postStaleBridge();
          else callback(undefined, runtimeError);
          return;
        }
        callback(response, null);
      });
      return true;
    } catch (error) {
      if (isInvalidatedContext(error)) postStaleBridge();
      else callback(undefined, error);
      return false;
    }
  }

  function handlePageMessage(event) {
    if (event.source !== window
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
          capabilities: response.capabilities || [],
          connectorState: response.connectorState || null,
          activeJobId: response.activeJobId || null,
          collectionInProgress: Boolean(response.collectionInProgress),
          pendingCount: Array.isArray(response.pendingResults) ? response.pendingResults.length : 0,
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
    });
  }

  function handleRuntimeMessage(message) {
    postToPage(message);
  }

  window.addEventListener('message', handlePageMessage);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  globalThis[BRIDGE_SLOT] = {
    dispose() {
      window.removeEventListener('message', handlePageMessage);
      try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch { /* old context */ }
    },
  };
  postToPage({ type: 'BRIDGE_READY' });
})();
