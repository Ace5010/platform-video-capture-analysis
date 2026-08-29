const SIX_HOURS_MINUTES = 360;
const ALARM_NAME = 'douyin-monitor-six-hour-check';
const SCHEDULER_STATE_KEY = 'schedulerState';
const COLLECTION_LOCK_KEY = 'collectionLock';
const COLLECTION_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ACCOUNT_DOM_WAIT_MS = 25_000;
const DETAIL_DOM_WAIT_MS = 15_000;
const MEDIA_CAPTURE_WAIT_MS = 22_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;
const INITIAL_HISTORY_VIDEOS = 30;
const LATEST_CHECK_VIDEOS = 3;
const DASHBOARD_URL_PATTERNS = ['http://localhost/*', 'http://127.0.0.1/*'];
const MEDIA_URL_PATTERNS = [
  'https://*.douyinvod.com/*',
  'https://*.douyinstatic.com/*',
  'https://*.douyinpic.com/*',
  'https://*.zjcdn.com/*',
  'https://*.bytecdn.cn/*',
  'https://*.byteimg.com/*',
];
const TRANSCRIBE_ENDPOINT = 'http://127.0.0.1:43128/transcribe';

let pendingResultsMutation = Promise.resolve();
let collectionInProgress = false;

chrome.runtime.onInstalled.addListener(async () => {
  await initializeScheduler({ allowCatchUp: true });
  const stored = await chrome.storage.local.get('pendingResults');
  if (!Array.isArray(stored.pendingResults)) {
    await chrome.storage.local.set({ pendingResults: [] });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void initializeScheduler({ allowCatchUp: true });
});

void initializeScheduler({ allowCatchUp: true });

async function ensureSixHourAlarm() {
  let existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: SIX_HOURS_MINUTES,
      periodInMinutes: SIX_HOURS_MINUTES,
    });
    existing = await chrome.alarms.get(ALARM_NAME);
  }
  return existing;
}

function emptySchedulerState() {
  return {
    enabled: true,
    alarmRegistered: false,
    periodMinutes: SIX_HOURS_MINUTES,
    monitoredAccountCount: 0,
    registeredAt: null,
    checkedAt: null,
    nextRunAt: null,
    lastAttemptAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    lastRunStatus: 'never',
    lastTrigger: null,
    lastError: null,
    missedRunRecoveredAt: null,
  };
}

function normalizeSchedulerState(value) {
  const fallback = emptySchedulerState();
  if (!value || typeof value !== 'object') return fallback;
  return {
    ...fallback,
    ...value,
    enabled: value.enabled !== false,
    alarmRegistered: value.alarmRegistered === true,
    periodMinutes: SIX_HOURS_MINUTES,
    monitoredAccountCount: Number.isFinite(Number(value.monitoredAccountCount))
      ? Math.max(0, Number(value.monitoredAccountCount))
      : 0,
  };
}

function alarmNextRunAt(alarm) {
  const scheduledTime = Number(alarm?.scheduledTime);
  if (!Number.isFinite(scheduledTime)) return null;
  const futureTime = scheduledTime > Date.now()
    ? scheduledTime
    : Date.now() + SIX_HOURS_MINUTES * 60 * 1000;
  return new Date(futureTime).toISOString();
}

async function readSchedulerState() {
  const stored = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
  return normalizeSchedulerState(stored[SCHEDULER_STATE_KEY]);
}

async function saveSchedulerState(patch, dashboardTabId) {
  const current = await readSchedulerState();
  const alarm = await ensureSixHourAlarm();
  const definedPatch = Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value !== undefined));
  const next = {
    ...current,
    ...definedPatch,
    enabled: true,
    alarmRegistered: Boolean(alarm),
    periodMinutes: SIX_HOURS_MINUTES,
    registeredAt: current.registeredAt || new Date().toISOString(),
    nextRunAt: alarmNextRunAt(alarm),
  };
  await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: next });
  await sendToDashboard({ type: 'SCHEDULER_STATE', schedulerState: next }, dashboardTabId);
  return next;
}

async function getSchedulerSnapshot() {
  const stored = await chrome.storage.local.get(['accounts', SCHEDULER_STATE_KEY]);
  const accounts = Array.isArray(stored.accounts) ? stored.accounts.filter(isValidAccount) : [];
  return saveSchedulerState({
    monitoredAccountCount: accounts.filter((account) => account.initialSyncStatus === 'complete').length,
    checkedAt: new Date().toISOString(),
  });
}

async function initializeScheduler({ allowCatchUp = false } = {}) {
  const stored = await chrome.storage.local.get(['accounts', SCHEDULER_STATE_KEY]);
  const previous = normalizeSchedulerState(stored[SCHEDULER_STATE_KEY]);
  const previousNextRun = previous.nextRunAt ? Date.parse(previous.nextRunAt) : Number.NaN;
  const wasOverdue = Number.isFinite(previousNextRun) && previousNextRun <= Date.now();
  const existingAlarm = await chrome.alarms.get(ALARM_NAME);
  const alarm = existingAlarm || await ensureSixHourAlarm();
  const accounts = Array.isArray(stored.accounts) ? stored.accounts.filter(isValidAccount) : [];
  const scheduledAccounts = accounts.filter((account) => account.initialSyncStatus === 'complete');
  const state = await saveSchedulerState({
    alarmRegistered: Boolean(alarm),
    monitoredAccountCount: scheduledAccounts.length,
    checkedAt: new Date().toISOString(),
  });
  if (allowCatchUp && !existingAlarm && wasOverdue && scheduledAccounts.length) {
    void runScheduledCollection('catch-up');
  }
  return state;
}

async function syncAccountsAndScheduler(incomingAccounts, dashboardTabId) {
  const stored = await chrome.storage.local.get('accounts');
  const previousAccounts = Array.isArray(stored.accounts) ? stored.accounts : [];
  const previousById = new Map(previousAccounts.map((account) => [account?.id, account]));
  const accounts = incomingAccounts.map((incoming) => {
    const previous = previousById.get(incoming.id);
    const preserveCompleted = previous?.initialSyncStatus === 'complete' && incoming.initialSyncStatus !== 'complete';
    return preserveCompleted ? {
      ...previous,
      ...incoming,
      initialSyncStatus: 'complete',
      initialSyncCompletedAt: previous.initialSyncCompletedAt || incoming.initialSyncCompletedAt || null,
      syncMode: 'latest',
    } : incoming;
  });
  await chrome.storage.local.set({ accounts });
  return saveSchedulerState({
    monitoredAccountCount: accounts.filter((account) => account.initialSyncStatus === 'complete').length,
    checkedAt: new Date().toISOString(),
  }, dashboardTabId);
}

async function acquireCollectionLock(trigger) {
  if (collectionInProgress) return null;
  collectionInProgress = true;
  try {
    const stored = await chrome.storage.local.get(COLLECTION_LOCK_KEY);
    const existing = stored[COLLECTION_LOCK_KEY];
    const existingStartedAt = existing?.startedAt ? Date.parse(existing.startedAt) : Number.NaN;
    if (existing?.token && Number.isFinite(existingStartedAt) && Date.now() - existingStartedAt < COLLECTION_LOCK_MAX_AGE_MS) {
      collectionInProgress = false;
      return null;
    }
    const token = createMessageId();
    await chrome.storage.local.set({
      [COLLECTION_LOCK_KEY]: { token, trigger, startedAt: new Date().toISOString() },
    });
    return token;
  } catch (error) {
    collectionInProgress = false;
    throw error;
  }
}

async function releaseCollectionLock(token) {
  if (!token) return;
  try {
    const stored = await chrome.storage.local.get(COLLECTION_LOCK_KEY);
    if (stored[COLLECTION_LOCK_KEY]?.token === token) {
      await chrome.storage.local.remove(COLLECTION_LOCK_KEY);
    }
  } finally {
    collectionInProgress = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void runScheduledCollection('alarm');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source !== 'douyin-monitor') return;

  if (message.type === 'PING') {
    void Promise.all([readPendingResults(), getSchedulerSnapshot()])
      .then(([pendingResults, schedulerState]) => {
        sendResponse({
          ok: true,
          extensionVersion: chrome.runtime.getManifest().version,
          pendingResults,
          schedulerState,
        });
      })
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'SYNC_ACCOUNTS') {
    const accounts = Array.isArray(message.accounts)
      ? message.accounts.filter(isValidAccount)
      : [];
    void syncAccountsAndScheduler(accounts, sender.tab?.id)
      .then((schedulerState) => sendResponse({ ok: true, schedulerState }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'CHECK_ALL') {
    const accounts = Array.isArray(message.accounts)
      ? message.accounts.filter(isValidAccount)
      : [];
    const allAccounts = Array.isArray(message.allAccounts)
      ? message.allAccounts.filter(isValidAccount)
      : accounts;
    if (!accounts.length) {
      sendResponse({ accepted: false, error: '没有可采集的抖音账号' });
      void persistAndDeliver({
        type: 'COLLECTION_ERROR',
        accountId: null,
        message: '没有可采集的抖音账号',
        capturedAt: new Date().toISOString(),
      }, sender.tab?.id);
      return;
    }

    let lockToken = null;
    let responseSent = false;
    void (async () => {
      lockToken = await acquireCollectionLock('manual');
      if (!lockToken) {
        sendResponse({ accepted: false, error: '已有采集任务正在运行，请等待当前任务完成' });
        responseSent = true;
        return;
      }
      await syncAccountsAndScheduler(allAccounts, sender.tab?.id);
      sendResponse({ accepted: true });
      responseSent = true;
      await collectAll(accounts, sender.tab?.id);
    })()
      .catch((error) => {
        if (!responseSent) sendResponse({ accepted: false, error: errorMessage(error) });
        void persistAndDeliver({
          type: 'COLLECTION_ERROR',
          accountId: null,
          message: `采集任务启动失败：${errorMessage(error)}`,
          capturedAt: new Date().toISOString(),
        }, sender.tab?.id);
      })
      .finally(() => releaseCollectionLock(lockToken));
    return true;
  }

  if (message.type === 'EXTRACT_TRANSCRIPT') {
    const video = message.video && typeof message.video === 'object' ? message.video : {};
    const requestedUrl = message.videoUrl || video.url || message.url;
    const videoId = normalizeVideoId(message.videoId || video.id, requestedUrl);
    if (!videoId) {
      sendResponse({ accepted: false, error: '缺少有效的视频 ID' });
      return;
    }
    sendResponse({ accepted: true, videoId });
    void extractTranscript({
      videoId,
      accountId: typeof message.accountId === 'string' ? message.accountId : null,
      videoUrl: normalizeVideoUrl(requestedUrl, videoId),
      dashboardTabId: sender.tab?.id,
    });
    return;
  }

  if (['ACK', 'ACK_RESULT', 'ACK_RESULTS', 'ACK_PENDING_RESULTS'].includes(message.type)) {
    const messageIds = normalizeAckIds(message);
    void acknowledgePendingResults(messageIds)
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }
});

async function runScheduledCollection(trigger = 'alarm') {
  const lockToken = await acquireCollectionLock(trigger);
  if (!lockToken) {
    await saveSchedulerState({
      lastRunStatus: 'skipped',
      lastError: '到点时已有采集任务运行，本轮由当前采集结果替代',
      checkedAt: new Date().toISOString(),
    });
    return;
  }
  const startedAt = new Date().toISOString();
  try {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const scheduledAccounts = Array.isArray(accounts)
      ? accounts
        .filter((account) => isValidAccount(account) && account.initialSyncStatus === 'complete')
        .map((account) => ({ ...account, syncMode: 'latest' }))
      : [];
    await saveSchedulerState({
      monitoredAccountCount: scheduledAccounts.length,
      lastAttemptAt: startedAt,
      lastRunStatus: scheduledAccounts.length ? 'running' : 'waiting',
      lastTrigger: trigger,
      lastError: scheduledAccounts.length ? null : '暂无已完成首次建档的账号',
      checkedAt: startedAt,
    });
    if (!scheduledAccounts.length) return;

    const summary = await collectAll(scheduledAccounts);
    const completedAt = new Date().toISOString();
    const lastRunStatus = summary.failed === 0 ? 'success' : summary.succeeded > 0 ? 'partial' : 'error';
    await saveSchedulerState({
      lastCompletedAt: completedAt,
      lastSuccessAt: summary.succeeded > 0 ? completedAt : undefined,
      lastRunStatus,
      lastTrigger: trigger,
      lastError: summary.failed > 0 ? `${summary.failed} 个账号采集失败` : null,
      missedRunRecoveredAt: trigger === 'catch-up' ? completedAt : undefined,
      checkedAt: completedAt,
    });
  } catch (error) {
    const capturedAt = new Date().toISOString();
    await saveSchedulerState({
      lastCompletedAt: capturedAt,
      lastRunStatus: 'error',
      lastTrigger: trigger,
      lastError: errorMessage(error),
      checkedAt: capturedAt,
    });
    await persistAndDeliver({
      type: 'COLLECTION_ERROR',
      accountId: null,
      message: `定时采集启动失败：${errorMessage(error)}`,
      capturedAt,
    });
  } finally {
    await releaseCollectionLock(lockToken);
  }
}

function collectionModeForAccount(account) {
  if (account?.syncMode === 'initial' || account?.syncMode === 'latest') return account.syncMode;
  return account?.initialSyncStatus === 'complete' ? 'latest' : 'initial';
}

async function markAccountInitialized(accountId, capturedAt) {
  const stored = await chrome.storage.local.get('accounts');
  const accounts = Array.isArray(stored.accounts) ? stored.accounts : [];
  await chrome.storage.local.set({
    accounts: accounts.map((account) => account?.id === accountId ? {
      ...account,
      initialSyncStatus: 'complete',
      initialSyncCompletedAt: capturedAt,
      syncMode: 'latest',
    } : account),
  });
}

async function collectAll(accounts, dashboardTabId) {
  const totalAccounts = accounts.length;
  let succeeded = 0;
  let failed = 0;
  const errors = [];
  for (let index = 0; index < totalAccounts; index += 1) {
    const account = accounts[index];
    const accountBaseProgress = Math.round(index / totalAccounts * 90);
    const accountProgressSpan = 90 / totalAccounts;

    await sendToDashboard({
      type: 'COLLECTION_STARTED',
      accountId: account.id,
      accountName: account.name || null,
      mode: collectionModeForAccount(account),
      progress: Math.max(3, accountBaseProgress),
      startedAt: new Date().toISOString(),
    }, dashboardTabId);

    try {
      const mode = collectionModeForAccount(account);
      const result = await collectAccount(account, mode, async ({ stage, completed, total }) => {
        const ratio = total > 0 ? completed / total : 0;
        await sendToDashboard({
          type: 'COLLECTION_PROGRESS',
          accountId: account.id,
          mode,
          stage,
          completed,
          total,
          progress: Math.min(95, Math.max(3, Math.round(accountBaseProgress + ratio * accountProgressSpan))),
        }, dashboardTabId);
      });

      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error('账号页返回了空视频列表，未写入任何伪造数据');
      }

      const capturedAt = new Date().toISOString();
      await persistAndDeliver({
        type: 'COLLECTION_RESULT',
        accountId: account.id,
        accountName: result.accountName,
        accountAvatarUrl: result.accountAvatarUrl,
        mode,
        videos: result.videos.map((video) => ({ ...video, capturedAt })),
        capturedAt,
        warning: result.warning,
      }, dashboardTabId);
      if (mode === 'initial') await markAccountInitialized(account.id, capturedAt);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      errors.push({ accountId: account.id, message: errorMessage(error) });
      await persistAndDeliver({
        type: 'COLLECTION_ERROR',
        accountId: account.id,
        accountName: account.name || null,
        mode: collectionModeForAccount(account),
        message: `${account.name || '账号'}：${errorMessage(error)}`,
        capturedAt: new Date().toISOString(),
      }, dashboardTabId);
    }
  }

  await sendToDashboard({
    type: 'COLLECTION_PROGRESS',
    accountId: null,
    stage: 'complete',
    completed: totalAccounts,
    total: totalAccounts,
    progress: 100,
  }, dashboardTabId);
  return { total: totalAccounts, succeeded, failed, errors };
}

async function collectAccount(account, mode, onProgress) {
  const targetCount = mode === 'initial' ? INITIAL_HISTORY_VIDEOS : LATEST_CHECK_VIDEOS;
  const tab = await chrome.tabs.create({ url: account.url, active: false });
  if (!tab.id) throw new Error('无法创建账号采集标签页');

  try {
    await waitForTab(tab.id);
    const readiness = await executeInTab(tab.id, waitForAccountVideoDom, [ACCOUNT_DOM_WAIT_MS, targetCount]);
    if (!readiness?.ready) {
      const pageLabel = readiness?.title ? `（${readiness.title}）` : '';
      throw new Error(`等待约 25 秒后仍未发现真实 /video/ 作品节点${pageLabel}，可能遇到登录、验证码、风控或页面结构变化`);
    }

    const accountPage = await executeInTab(tab.id, extractAccountPageV3, [targetCount], 'MAIN');
    if (!accountPage || !Array.isArray(accountPage.videos)) {
      throw new Error('账号页没有返回可识别的数据结构');
    }
    const expectedAccountKey = accountProfileKeyFromUrl(account.url);
    const observedAccountKey = accountProfileKeyFromUrl(accountPage.pageUrl);
    if (expectedAccountKey && observedAccountKey !== expectedAccountKey) {
      throw new Error(`账号页已跳转到其他主页（${accountPage.pageUrl || '未知地址'}），已停止写入`);
    }
    if (accountPage.scoped !== true) {
      throw new Error('未能定位当前账号的作品列表，已停止以避免混入推荐或页脚视频');
    }
    if (accountPage.videos.length === 0) {
      throw new Error('账号页没有可采集的非置顶可见视频');
    }

    if (accountPage.hasMore === true && accountPage.videos.length < targetCount) {
      throw new Error(`账号仍有更多作品，但本轮只完整读取到 ${accountPage.videos.length}/${targetCount} 条，已停止写入半成品`);
    }

    const enrichedVideos = [];
    const total = accountPage.videos.length;
    for (let index = 0; index < total; index += 1) {
      const video = accountPage.videos[index];
      await onProgress({ stage: 'video-detail', completed: index, total });
      if (video.dataComplete === true) {
        enrichedVideos.push({
          ...video,
          accountId: account.id,
          transcript: null,
          detailError: null,
        });
        await onProgress({ stage: 'video-detail', completed: index + 1, total });
        continue;
      }
      try {
        const details = await collectVideoDetails(video.url);
        enrichedVideos.push(mergeVideoDetails(video, details, account.id));
      } catch (error) {
        enrichedVideos.push({
          ...video,
          accountId: account.id,
          transcript: null,
          detailError: errorMessage(error),
        });
      }
      await onProgress({ stage: 'video-detail', completed: index + 1, total });
    }

    const incompleteVideos = enrichedVideos.filter((video) => !hasCompletePublicData(video));
    if (incompleteVideos.length > 0) {
      throw new Error(`${incompleteVideos.length} 条视频仍缺少封面、文案或公开互动数据，已停止整批写入`);
    }

    return {
      accountName: accountPage.accountName || account.name || '抖音账号',
      accountAvatarUrl: accountPage.accountAvatarUrl || account.avatarUrl || null,
      videos: enrichedVideos,
      warning: null,
    };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function collectVideoDetails(videoUrl) {
  const tab = await chrome.tabs.create({ url: videoUrl, active: false });
  if (!tab.id) throw new Error('无法创建视频详情标签页');

  try {
    await waitForTab(tab.id);
    const readiness = await executeInTab(tab.id, waitForVideoDetailDom, [DETAIL_DOM_WAIT_MS]);
    if (!readiness?.ready) {
      throw new Error('视频详情页未出现 data-e2e 数据节点');
    }
    const expectedVideoId = videoIdFromUrl(videoUrl);
    const observedVideoId = videoIdFromUrl(readiness.url);
    if (expectedVideoId && observedVideoId !== expectedVideoId) {
      throw new Error(`详情页已跳转到其他视频（${observedVideoId}），已停止写入`);
    }
    const details = await executeInTab(tab.id, extractVideoDetailPage);
    if (!details) throw new Error('视频详情页没有返回数据');
    return details;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function mergeVideoDetails(video, details, accountId) {
  const description = details.description || video.description || '';
  return {
    ...video,
    accountId,
    title: video.title || description,
    description,
    coverUrl: details.coverUrl || video.coverUrl || null,
    playCount: valueOrFallback(details.playCount, video.playCount),
    likeCount: valueOrFallback(details.likeCount, video.likeCount),
    commentCount: valueOrFallback(details.commentCount, video.commentCount),
    favoriteCount: valueOrFallback(details.favoriteCount, video.favoriteCount),
    shareCount: valueOrFallback(details.shareCount, video.shareCount),
    publishedAt: details.publishedAt || video.publishedAt || null,
    publishedAtText: details.publishedAtText || video.publishedAtText || null,
    durationSeconds: valueOrFallback(details.durationSeconds, video.durationSeconds),
    transcript: null,
    detailError: null,
  };
}

function valueOrFallback(value, fallback) {
  return value !== null && value !== undefined ? value : (fallback ?? null);
}

function hasCompletePublicData(video) {
  return Boolean(video?.title)
    && Boolean(video?.description)
    && Boolean(video?.coverUrl)
    && Boolean(video?.publishedAt)
    && video?.durationSeconds !== null
    && video?.durationSeconds !== undefined
    && video?.likeCount !== null
    && video?.likeCount !== undefined
    && video?.commentCount !== null
    && video?.commentCount !== undefined
    && video?.favoriteCount !== null
    && video?.favoriteCount !== undefined
    && video?.shareCount !== null
    && video?.shareCount !== undefined;
}

async function extractTranscript({ videoId, accountId, videoUrl, dashboardTabId }) {
  let tab;
  let mediaCapture;
  try {
    await sendTranscriptProgress({
      videoId,
      accountId,
      stage: 'opening-video',
      progress: 10,
    }, dashboardTabId);

    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!tab.id) throw new Error('无法创建口播提取标签页');
    mediaCapture = createMediaCapture(tab.id, MEDIA_CAPTURE_WAIT_MS);

    await chrome.tabs.update(tab.id, { url: videoUrl });
    await waitForTab(tab.id);
    await sendTranscriptProgress({
      videoId,
      accountId,
      stage: 'capturing-media',
      progress: 30,
    }, dashboardTabId);

    await executeInTab(tab.id, activateVideoPlayback, [10_000]);
    const mediaUrl = await mediaCapture.promise;
    if (!mediaUrl) {
      throw new Error('未捕获到视频详情页的媒体音频 CDN 请求');
    }

    await sendTranscriptProgress({
      videoId,
      accountId,
      stage: 'transcribing',
      progress: 65,
    }, dashboardTabId);

    const transcript = await requestLocalTranscription({ videoId, videoUrl, mediaUrl });
    const completedAt = new Date().toISOString();
    await persistAndDeliver({
      type: 'TRANSCRIPT_RESULT',
      accountId,
      videoId,
      transcript,
      completedAt,
    }, dashboardTabId);
  } catch (error) {
    await persistAndDeliver({
      type: 'TRANSCRIPT_ERROR',
      accountId,
      videoId,
      message: errorMessage(error),
      capturedAt: new Date().toISOString(),
    }, dashboardTabId);
  } finally {
    mediaCapture?.stop();
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function sendTranscriptProgress({ videoId, accountId, stage, progress }, dashboardTabId) {
  await sendToDashboard({
    type: 'TRANSCRIPT_PROGRESS',
    accountId,
    videoId,
    stage,
    progress,
  }, dashboardTabId);
}

function createMediaCapture(tabId, timeoutMs) {
  let bestCandidate = null;
  let settled = false;
  let resolvePromise;

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const consider = (details, contentType = '') => {
    if (details.tabId !== tabId) return;
    const score = scoreMediaCandidate(details.url, details.type, contentType);
    if (score <= 0) return;
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = { url: details.url, score };
    }
    if (score >= 90) finish();
  };

  const onBeforeRequest = (details) => consider(details);
  const onHeadersReceived = (details) => {
    const contentTypeHeader = details.responseHeaders?.find((header) => header.name?.toLowerCase() === 'content-type');
    consider(details, contentTypeHeader?.value || '');
  };

  const removeListeners = () => {
    if (chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) {
      chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    }
    if (chrome.webRequest.onHeadersReceived.hasListener(onHeadersReceived)) {
      chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
    }
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    removeListeners();
    resolvePromise(bestCandidate?.url || null);
  };

  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: MEDIA_URL_PATTERNS, types: ['media', 'xmlhttprequest', 'other'] },
  );
  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: MEDIA_URL_PATTERNS, types: ['media', 'xmlhttprequest', 'other'] },
    ['responseHeaders'],
  );

  const timer = setTimeout(finish, timeoutMs);
  return { promise, stop: finish };
}

function scoreMediaCandidate(urlValue, requestType, contentTypeValue) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    return 0;
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowedHost = hostname.endsWith('.douyinvod.com')
    || hostname.endsWith('.douyinstatic.com')
    || hostname.endsWith('.douyinpic.com')
    || hostname.endsWith('.zjcdn.com')
    || hostname.endsWith('.bytecdn.cn')
    || hostname.endsWith('.byteimg.com');
  if (!allowedHost) return 0;

  const url = urlValue.toLowerCase();
  const contentType = String(contentTypeValue).toLowerCase();
  if (contentType.startsWith('audio/')) return 100;
  if (/(?:media-audio|audio|mp4a|music|ies-music|mime_type=audio)/.test(url)) return 100;
  if (/\.(mp3|m4a|aac|wav|ogg)(?:\?|$)/.test(url)) return 95;
  if (contentType.startsWith('video/')) return 75;
  if (requestType === 'media' && (hostname.endsWith('.douyinvod.com') || hostname.endsWith('.zjcdn.com'))) return 70;
  if (hostname.endsWith('.douyinvod.com') || hostname.endsWith('.zjcdn.com')) return 45;
  return 0;
}

async function requestLocalTranscription({ videoId, videoUrl, mediaUrl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        audioUrl: mediaUrl,
        url: mediaUrl,
        mediaUrl,
        videoUrl,
        referer: videoUrl,
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`本地转写服务返回 ${response.status}${responseText ? `：${responseText.slice(0, 180)}` : ''}`);
    }

    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = { text: responseText };
    }
    const transcript = payload?.transcript
      ?? payload?.text
      ?? payload?.result?.transcript
      ?? payload?.result?.text;
    if (typeof transcript !== 'string' || !transcript.trim()) {
      throw new Error('本地转写服务没有返回有效文本');
    }
    return transcript.trim();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('本地转写超过 180 秒，已停止等待');
    }
    if (error instanceof TypeError) {
      throw new Error('无法连接本地转写服务，请确认 127.0.0.1:43128 已启动');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function persistAndDeliver(message, dashboardTabId) {
  const envelope = {
    ...message,
    messageId: message.messageId || createMessageId(),
  };
  await mutatePendingResults((current) => [...current, envelope]);
  await sendToDashboard(envelope, dashboardTabId);
  return envelope;
}

async function readPendingResults() {
  await pendingResultsMutation.catch(() => {});
  const stored = await chrome.storage.local.get('pendingResults');
  return Array.isArray(stored.pendingResults) ? stored.pendingResults : [];
}

async function acknowledgePendingResults(messageIds) {
  if (!messageIds.length) return 0;
  const idSet = new Set(messageIds);
  let removed = 0;
  await mutatePendingResults((current) => {
    const next = current.filter((item) => {
      const shouldRemove = idSet.has(item?.messageId);
      if (shouldRemove) removed += 1;
      return !shouldRemove;
    });
    return next;
  });
  return removed;
}

function mutatePendingResults(mutator) {
  const operation = pendingResultsMutation.then(async () => {
    const stored = await chrome.storage.local.get('pendingResults');
    const current = Array.isArray(stored.pendingResults) ? stored.pendingResults : [];
    const next = mutator(current);
    await chrome.storage.local.set({ pendingResults: next });
    return next;
  });
  pendingResultsMutation = operation.catch(() => {});
  return operation;
}

async function sendToDashboard(message, preferredTabId) {
  if (preferredTabId) {
    try {
      await chrome.tabs.sendMessage(preferredTabId, message);
      return true;
    } catch {
      // The original dashboard may have reloaded; fall through to discovered tabs.
    }
  }

  const tabs = await chrome.tabs.query({ url: DASHBOARD_URL_PATTERNS });
  let delivered = false;
  for (const tab of tabs) {
    if (!tab.id || tab.id === preferredTabId) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      delivered = true;
    } catch {
      // Pending terminal messages remain in storage and will sync on the next PING.
    }
  }
  return delivered;
}

function normalizeAckIds(message) {
  const candidates = [
    ...(Array.isArray(message.messageIds) ? message.messageIds : []),
    ...(Array.isArray(message.ids) ? message.ids : []),
    message.messageId,
  ];
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value))];
}

function normalizeVideoId(videoId, videoUrl) {
  if (typeof videoId === 'string' && /^\d+$/.test(videoId)) return videoId;
  if (typeof videoId === 'number' && Number.isSafeInteger(videoId) && videoId > 0) return String(videoId);
  if (typeof videoUrl === 'string') return videoIdFromUrl(videoUrl);
  return null;
}

function videoIdFromUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    const pathMatch = parsed.pathname.match(/\/video\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    const modalId = parsed.searchParams.get('modal_id');
    return /^\d+$/.test(modalId || '') ? modalId : null;
  } catch {
    return value.match(/\/video\/(\d+)/)?.[1]
      || value.match(/[?&]modal_id=(\d+)/)?.[1]
      || null;
  }
}

function accountProfileKeyFromUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.pathname.match(/^\/user\/([^/]+)/)?.[1] || null;
  } catch {
    return value.match(/\/user\/([^/?#]+)/)?.[1] || null;
  }
}

function normalizeVideoUrl(videoUrl, videoId) {
  if (typeof videoUrl === 'string') {
    try {
      const parsed = new URL(videoUrl);
      if (parsed.protocol === 'https:' && parsed.hostname.endsWith('douyin.com') && /\/video\/\d+/.test(parsed.pathname)) {
        return `https://www.douyin.com/video/${videoId}`;
      }
    } catch {
      // Fall back to the canonical URL below.
    }
  }
  return `https://www.douyin.com/video/${videoId}`;
}

function isValidAccount(account) {
  if (!account || typeof account.id !== 'string' || typeof account.url !== 'string') return false;
  try {
    const url = new URL(account.url);
    return url.protocol === 'https:'
      && url.hostname === 'www.douyin.com'
      && url.pathname.includes('/user/');
  } catch {
    return false;
  }
}

function createMessageId() {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function executeInTab(tabId, func, args = [], world = 'ISOLATED') {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args,
  });
  return execution?.result;
}

async function waitForTab(tabId, timeoutMs = 45_000) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    const timeout = setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish();
      })
      .catch((error) => finish(error));
  });
}

function waitForAccountVideoDom(timeoutMs, minimumVideos = 1) {
  try { window.performance?.setResourceTimingBufferSize?.(5000); } catch { /* optional diagnostic buffer */ }
  const findAccountRoot = () => {
    const preferredRoots = [
      document.querySelector('#user_detail_element'),
      document.querySelector('[data-e2e="user-detail"]'),
      document.querySelector('[data-e2e="user-post-list"]'),
    ].filter(Boolean);
    return preferredRoots.find((root) => root.querySelector('a[href*="/video/"]'))
      || preferredRoots[0]
      || null;
  };
  const inspect = () => {
    const root = findAccountRoot();
    const anchors = [...(root || document.body).querySelectorAll('a[href*="/video/"]')]
      .filter((anchor) => !anchor.closest('footer, .user-page-footer'))
      .filter((anchor) => /\/video\/\d+/.test(anchor.href));
    const unique = [...new Map(anchors.map((anchor) => [anchor.href.match(/\/video\/(\d+)/)?.[1], anchor])).values()]
      .filter(Boolean);
    const nonPinned = unique.filter((anchor) => {
      const card = anchor.closest('li') || anchor.parentElement;
      return !card?.querySelector('[aria-label*="置顶"]')
        && !/(^|\n)\s*置顶\s*(\n|$)/.test(card?.innerText || card?.textContent || '');
    });
    return {
      ready: nonPinned.length > 0,
      enough: nonPinned.length >= minimumVideos,
      count: unique.length,
      nonPinnedCount: nonPinned.length,
      scoped: Boolean(root),
      title: document.title,
      url: location.href,
    };
  };
  const requestMore = () => {
    const root = findAccountRoot();
    const anchors = [...(root || document.body).querySelectorAll('a[href*="/video/"]')]
      .filter((anchor) => !anchor.closest('footer, .user-page-footer'));
    const last = anchors.at(-1);
    try { last?.scrollIntoView({ block: 'end' }); } catch { /* keep polling */ }
    try { window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)); } catch { /* keep polling */ }
  };
  const immediate = inspect();
  if (immediate.enough) return Promise.resolve(immediate);
  requestMore();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      observer.disconnect();
      resolve(result);
    };
    const check = () => {
      const result = inspect();
      if (result.enough) finish(result);
      else requestMore();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const interval = setInterval(check, 350);
    const timeout = setTimeout(() => finish(inspect()), timeoutMs);
  });
}

async function extractAccountPageV3(maxVideos) {
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).trim().replace(/,/g, '').toLowerCase();
    const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*(亿|万|w|k)?/i);
    if (!match) return null;
    const multiplier = match[2] === '亿' ? 100_000_000
      : (match[2] === '万' || match[2] === 'w') ? 10_000
        : match[2] === 'k' ? 1_000 : 1;
    const result = Number(match[1]) * multiplier;
    return Number.isFinite(result) ? Math.round(result) : null;
  };
  const timestampOrNull = (value) => {
    const number = numberOrNull(value);
    if (!number || number <= 0) return null;
    const milliseconds = number > 10_000_000_000 ? number : number * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const durationSecondsOrNull = (value) => {
    const number = numberOrNull(value);
    if (number === null || number < 0) return null;
    return number > 1000 ? Math.round(number / 1000) : Math.round(number);
  };
  const urlFrom = (...candidates) => candidates
    .flat(Infinity)
    .find((value) => typeof value === 'string' && /^https?:\/\//.test(value)) || null;
  const objectFrom = (value) => {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const completePublicData = (video) => Boolean(video.title)
    && Boolean(video.description)
    && Boolean(video.coverUrl)
    && Boolean(video.publishedAt)
    && video.durationSeconds !== null
    && video.likeCount !== null
    && video.commentCount !== null
    && video.favoriteCount !== null
    && video.shareCount !== null;
  const pageAccountKey = location.pathname.match(/^\/user\/([^/]+)/)?.[1] || null;
  const domAccountName = document.querySelector('[data-e2e="user-title"]')?.textContent?.trim()
    || document.querySelector('h1')?.textContent?.trim()
    || document.title.replace(/[-_].*$/, '').trim()
    || '抖音账号';
  const findAccountRoot = () => {
    const candidates = [
      document.querySelector('#user_detail_element'),
      document.querySelector('[data-e2e="user-detail"]'),
      document.querySelector('[data-e2e="user-post-list"]'),
    ];
    const selectedWorkTab = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
      .find((tab) => /作品/.test(tab.textContent || tab.getAttribute('aria-label') || ''));
    const controlledPanelId = selectedWorkTab?.getAttribute('aria-controls');
    if (controlledPanelId) candidates.push(document.getElementById(controlledPanelId));
    return candidates.find((candidate) => candidate?.querySelector('a[href*="/video/"]')) || null;
  };
  const accountRoot = findAccountRoot();
  const scopedToAccountPage = Boolean(accountRoot && accountRoot !== document.body);
  if (!accountRoot) {
    return {
      accountName: domAccountName,
      videos: [],
      pageUrl: location.href,
      scoped: false,
      rootId: null,
      hasMore: false,
      playCountUnavailable: true,
    };
  }

  const capturedEntries = Array.isArray(window.__DOUYIN_MONITOR_PUBLIC_POSTS_V3__)
    ? window.__DOUYIN_MONITOR_PUBLIC_POSTS_V3__
    : [];
  const apiItems = new Map();
  const apiOrder = [];
  let apiAccountName = null;
  let apiAccountAvatarUrl = null;
  let hasMore = false;
  for (const entry of capturedEntries) {
    const page = entry?.page || entry;
    if (!page || page.status_code !== 0 || !Array.isArray(page.aweme_list)) continue;
    hasMore = page.has_more === 1;
    for (const item of page.aweme_list) {
      const id = String(item?.aweme_id || '');
      if (!/^\d+$/.test(id)) continue;
      const authorKey = item?.author?.sec_uid || null;
      if (pageAccountKey && authorKey && authorKey !== pageAccountKey) continue;
      if (!apiItems.has(id)) apiOrder.push(id);
      apiItems.set(id, item);
      if (!apiAccountName && typeof item?.author?.nickname === 'string') {
        apiAccountName = item.author.nickname.trim();
      }
      if (!apiAccountAvatarUrl) {
        apiAccountAvatarUrl = urlFrom(
          item?.author?.avatar_thumb?.url_list,
          item?.author?.avatar_medium?.url_list,
          item?.author?.avatar_larger?.url_list,
        );
      }
    }
  }

  const findCard = (anchor) => {
    const listItem = anchor.closest('li');
    if (listItem) return listItem;
    let current = anchor;
    let candidate = anchor;
    for (let depth = 0; depth < 7 && current.parentElement; depth += 1) {
      current = current.parentElement;
      const links = current.querySelectorAll('a[href*="/video/"]');
      if (links.length === 1) candidate = current;
      else if (links.length > 1) break;
    }
    return candidate;
  };
  const imageUrlFrom = (card, anchor) => {
    const image = anchor.querySelector('img') || card.querySelector('img');
    const source = anchor.querySelector('source') || card.querySelector('source');
    const direct = [image?.currentSrc, image?.src, source?.src]
      .find((value) => typeof value === 'string' && /^https?:\/\//.test(value));
    if (direct) return direct;
    return getComputedStyle(card).backgroundImage
      .match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/)?.[1] || null;
  };
  const cleanImageDescription = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    for (const prefix of [`${domAccountName}：`, `${domAccountName}:`]) {
      if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
    }
    return text;
  };
  const likeCountFromCard = (card) => {
    const semantic = card.querySelector('.author-card-user-video-like, [class*="author-card-user-video-like"]');
    const semanticValue = numberOrNull(semantic?.textContent);
    if (semanticValue !== null) return semanticValue;
    const lines = (card.innerText || card.textContent || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const exact = line.match(/^(\d+(?:\.\d+)?\s*(?:亿|万|w|k)?)$/i);
      const parsed = exact ? numberOrNull(exact[1]) : null;
      if (parsed !== null) return parsed;
    }
    return null;
  };
  const isPinnedCard = (card) => Boolean(card.querySelector('[aria-label*="置顶"]'))
    || /(^|\n)\s*置顶\s*(\n|$)/.test(card.innerText || card.textContent || '');

  const domItems = new Map();
  const domOrder = [];
  for (const anchor of accountRoot.querySelectorAll('a[href*="/video/"]')) {
    if (anchor.closest('footer, .user-page-footer')) continue;
    const id = anchor.href.match(/\/video\/(\d+)/)?.[1];
    if (!id || domItems.has(id)) continue;
    const card = findCard(anchor);
    const image = anchor.querySelector('img') || card.querySelector('img');
    const description = cleanImageDescription(
      anchor.getAttribute('aria-label') || image?.getAttribute('alt') || '',
    );
    domOrder.push(id);
    domItems.set(id, {
      id,
      description,
      coverUrl: imageUrlFrom(card, anchor),
      likeCount: likeCountFromCard(card),
      isPinned: isPinnedCard(card),
    });
  }

  const fromApi = (item) => {
    const id = String(item.aweme_id);
    const stats = item.statistics || {};
    const video = item.video || {};
    const seriesPlayInfo = objectFrom(item.series_play_info);
    const prefix = typeof seriesPlayInfo?.item_title_prefix?.text === 'string'
      ? seriesPlayInfo.item_title_prefix.text.trim()
      : '';
    const description = typeof item.desc === 'string' ? item.desc.trim() : '';
    const itemTitle = typeof item.item_title === 'string' && item.item_title.trim()
      ? item.item_title.trim()
      : typeof item.preview_title === 'string' && item.preview_title.trim()
        ? item.preview_title.trim()
        : description;
    const title = prefix && !itemTitle.startsWith(prefix)
      ? `${prefix} | ${itemTitle}`
      : itemTitle;
    const rawPlayCount = numberOrNull(stats.play_count);
    const result = {
      id,
      title,
      description,
      url: `https://www.douyin.com/video/${id}`,
      coverUrl: urlFrom(video.cover?.url_list, video.origin_cover?.url_list, video.dynamic_cover?.url_list),
      publishedAt: timestampOrNull(item.create_time),
      publishedAtText: null,
      playCount: rawPlayCount !== null && rawPlayCount > 0 ? rawPlayCount : null,
      likeCount: numberOrNull(stats.digg_count),
      commentCount: numberOrNull(stats.comment_count),
      favoriteCount: numberOrNull(stats.collect_count),
      shareCount: numberOrNull(stats.share_count),
      durationSeconds: durationSecondsOrNull(video.duration),
      capturedAt: new Date().toISOString(),
      isPinned: item.is_top === 1 || item.is_top === true,
      dataSource: 'profile-api',
      dataComplete: false,
    };
    result.dataComplete = completePublicData(result);
    return result;
  };

  const seen = new Set();
  const videos = [];
  for (const id of apiOrder) {
    const item = apiItems.get(id);
    const apiVideo = fromApi(item);
    const domVideo = domItems.get(id);
    if (apiVideo.isPinned || domVideo?.isPinned) continue;
    if (domVideo) {
      apiVideo.coverUrl ||= domVideo.coverUrl;
      apiVideo.description ||= domVideo.description;
      apiVideo.title ||= domVideo.description;
      apiVideo.likeCount ??= domVideo.likeCount;
      apiVideo.dataComplete = completePublicData(apiVideo);
    }
    seen.add(id);
    videos.push(apiVideo);
    if (videos.length >= maxVideos) break;
  }

  for (const id of domOrder) {
    if (seen.has(id) || videos.length >= maxVideos) continue;
    const domVideo = domItems.get(id);
    if (domVideo.isPinned) continue;
    const video = {
      id,
      title: domVideo.description,
      description: domVideo.description,
      url: `https://www.douyin.com/video/${id}`,
      coverUrl: domVideo.coverUrl,
      publishedAt: null,
      publishedAtText: null,
      playCount: null,
      likeCount: domVideo.likeCount,
      commentCount: null,
      favoriteCount: null,
      shareCount: null,
      durationSeconds: null,
      capturedAt: new Date().toISOString(),
      dataSource: 'profile-dom',
      dataComplete: false,
    };
    seen.add(id);
    videos.push(video);
  }

  return {
    accountName: apiAccountName || domAccountName,
    accountAvatarUrl: apiAccountAvatarUrl || urlFrom(
      [...document.querySelectorAll('img')]
        .find((image) => image.getAttribute('alt') === `${domAccountName}头像`)?.currentSrc,
      [...document.querySelectorAll('img')]
        .find((image) => image.getAttribute('alt') === `${domAccountName}头像`)?.src,
    ),
    videos,
    pageUrl: location.href,
    scoped: scopedToAccountPage,
    rootId: accountRoot.id || null,
    hasMore,
    capturedPageCount: capturedEntries.length,
    apiBackedCount: videos.filter((video) => video.dataSource === 'profile-api').length,
    completeCount: videos.filter((video) => video.dataComplete).length,
    playCountUnavailable: videos.some((video) => video.playCount === null),
  };
}

// Kept as a DOM-only fallback reference while v0.4.0 is validated against live pages.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function extractAccountPage(maxVideos) {
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).trim().replace(/,/g, '').toLowerCase();
    const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*(亿|万|w|k)?/i);
    if (!match) return null;
    const multiplier = match[2] === '亿' ? 100_000_000
      : (match[2] === '万' || match[2] === 'w') ? 10_000
        : match[2] === 'k' ? 1_000 : 1;
    const result = Number(match[1]) * multiplier;
    return Number.isFinite(result) ? Math.round(result) : null;
  };
  const timestampOrNull = (value) => {
    const number = numberOrNull(value);
    if (!number || number <= 0) return null;
    const milliseconds = number > 10_000_000_000 ? number : number * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const urlFrom = (...candidates) => {
    const flattened = candidates.flat(Infinity);
    return flattened.find((value) => typeof value === 'string' && /^https?:\/\//.test(value)) || null;
  };
  const durationSecondsOrNull = (value) => {
    const number = numberOrNull(value);
    if (number === null || number < 0) return null;
    return number > 1000 ? Math.round(number / 1000) : Math.round(number);
  };
  const decodeText = (text) => {
    try { return decodeURIComponent(text); } catch { return text; }
  };
  const parseCandidate = (candidate) => {
    const trimmed = candidate.trim();
    const attempts = [trimmed];
    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) attempts.push(trimmed.slice(objectStart, objectEnd + 1));
    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) attempts.push(trimmed.slice(arrayStart, arrayEnd + 1));
    for (const attempt of attempts) {
      try { return JSON.parse(attempt); } catch { /* continue */ }
    }
    return null;
  };

  const structured = new Map();
  const roots = [];
  for (const script of document.scripts) {
    const text = script.textContent?.trim();
    if (!text || text.length < 20) continue;
    for (const candidate of [text, decodeText(text)]) {
      const parsed = parseCandidate(candidate);
      if (parsed) roots.push(parsed);
    }
  }

  const visited = new WeakSet();
  const walk = (value) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const rawId = value.aweme_id ?? value.awemeId ?? value.aweme_id_str;
    if (rawId !== null && rawId !== undefined && /^\d+$/.test(String(rawId))) {
      const id = String(rawId);
      const stats = value.statistics || value.stats || {};
      const video = value.video || {};
      const previous = structured.get(id) || {};
      structured.set(id, {
        ...previous,
        id,
        description: typeof value.desc === 'string' ? value.desc.trim() : (previous.description || ''),
        coverUrl: urlFrom(
          video.cover?.url_list,
          video.cover?.urlList,
          video.origin_cover?.url_list,
          video.dynamic_cover?.url_list,
          value.cover?.url_list,
          previous.coverUrl,
        ),
        playCount: numberOrNull(stats.play_count ?? stats.playCount ?? previous.playCount),
        likeCount: numberOrNull(stats.digg_count ?? stats.diggCount ?? stats.like_count ?? previous.likeCount),
        commentCount: numberOrNull(stats.comment_count ?? stats.commentCount ?? previous.commentCount),
        favoriteCount: numberOrNull(stats.collect_count ?? stats.collectCount ?? previous.favoriteCount),
        shareCount: numberOrNull(stats.share_count ?? stats.shareCount ?? previous.shareCount),
        publishedAt: timestampOrNull(value.create_time ?? value.createTime ?? previous.publishedAt),
        durationSeconds: durationSecondsOrNull(video.duration ?? value.duration ?? previous.durationSeconds),
        isPinned: value.is_top === 1
          || value.is_top === true
          || value.isTop === 1
          || value.isTop === true
          || value.is_pinned === true
          || previous.isPinned === true,
      });
    }
    if (Array.isArray(value)) value.forEach(walk);
    else Object.values(value).forEach(walk);
  };
  roots.forEach(walk);

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && (element.getClientRects().length > 0 || Boolean(element.querySelector('img, video')));
  };
  const accountName = document.querySelector('[data-e2e="user-title"]')?.textContent?.trim()
    || document.querySelector('h1')?.textContent?.trim()
    || document.title.replace(/[-_].*$/, '').trim()
    || '抖音账号';
  const findAccountRoot = () => {
    const candidates = [
      document.querySelector('#user_detail_element'),
      document.querySelector('[data-e2e="user-detail"]'),
      document.querySelector('[data-e2e="user-post-list"]'),
    ];
    const selectedWorkTab = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
      .find((tab) => /作品/.test(tab.textContent || tab.getAttribute('aria-label') || ''));
    const controlledPanelId = selectedWorkTab?.getAttribute('aria-controls');
    if (controlledPanelId) candidates.push(document.getElementById(controlledPanelId));
    return candidates.find((candidate) => candidate?.querySelector('a[href*="/video/"]')) || null;
  };
  const accountRoot = findAccountRoot();
  const scopedToAccountPage = Boolean(accountRoot && accountRoot !== document.body);
  const anchorScope = accountRoot || document.body;
  const findCard = (anchor) => {
    let current = anchor;
    let candidate = anchor;
    for (let depth = 0; depth < 7 && current.parentElement; depth += 1) {
      current = current.parentElement;
      const links = current.querySelectorAll('a[href*="/video/"]');
      if (links.length === 1) candidate = current;
      else if (links.length > 1) break;
    }
    return candidate;
  };
  const imageUrlFrom = (card, anchor) => {
    const image = anchor.querySelector('img') || card.querySelector('img');
    const source = anchor.querySelector('source') || card.querySelector('source');
    const candidates = [image?.currentSrc, image?.src, source?.src]
      .filter((value) => typeof value === 'string' && /^https?:\/\//.test(value));
    if (candidates.length) return candidates[0];
    const background = getComputedStyle(card).backgroundImage;
    return background.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/)?.[1] || null;
  };
  const metricFromCard = (card) => {
    const selectors = [
      '[data-e2e="video-play-count"]',
      '[data-e2e="video-views"]',
      '[data-e2e*="play-count"]',
      '[aria-label*="播放"]',
    ];
    for (const selector of selectors) {
      const element = card.querySelector(selector);
      const value = numberOrNull(element?.getAttribute('aria-label') || element?.textContent);
      if (value !== null) return value;
    }
    const text = card.textContent || '';
    const labeled = text.match(/(?:播放|观看)\s*([\d.,]+\s*(?:亿|万|w|k)?)/i);
    if (labeled) return numberOrNull(labeled[1]);
    const lines = (card.innerText || text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const value = lines[index].match(/^(\d+(?:\.\d+)?\s*(?:亿|万|w|k)?)$/i);
      const parsed = value ? numberOrNull(value[1]) : null;
      if (parsed !== null) return parsed;
    }
    return null;
  };

  const seen = new Set();
  const videos = [];
  for (const anchor of anchorScope.querySelectorAll('a[href*="/video/"]')) {
    if (anchor.closest('footer, .user-page-footer')) continue;
    const match = anchor.href.match(/\/video\/(\d+)/);
    if (!match || seen.has(match[1]) || !isVisible(anchor)) continue;
    if (!scopedToAccountPage) {
      const imageAlt = anchor.querySelector('img')?.getAttribute('alt')?.trim() || '';
      const anchorText = anchor.textContent?.trim() || '';
      if (!accountName || (!imageAlt.startsWith(accountName) && !anchorText.includes(accountName))) continue;
    }
    const id = match[1];
    const card = findCard(anchor);
    const data = structured.get(id) || {};
    const cardText = card.innerText || card.textContent || '';
    const isPinned = data.isPinned === true || /(^|\n)\s*置顶\s*(\n|$)/.test(cardText);
    seen.add(id);
    if (isPinned) continue;

    const image = anchor.querySelector('img') || card.querySelector('img');
    const ariaDescription = anchor.getAttribute('aria-label')?.trim();
    const imageDescription = image?.getAttribute('alt')?.trim();
    const description = data.description || ariaDescription || imageDescription || '';
    const playCount = metricFromCard(card);
    videos.push({
      id,
      title: description,
      description,
      url: `https://www.douyin.com/video/${id}`,
      coverUrl: imageUrlFrom(card, anchor) || data.coverUrl || null,
      publishedAt: data.publishedAt || null,
      publishedAtText: null,
      playCount: playCount !== null ? playCount : (data.playCount ?? null),
      likeCount: data.likeCount ?? null,
      commentCount: data.commentCount ?? null,
      favoriteCount: data.favoriteCount ?? null,
      shareCount: data.shareCount ?? null,
      durationSeconds: data.durationSeconds ?? null,
      capturedAt: new Date().toISOString(),
    });
    if (videos.length >= maxVideos) break;
  }

  return {
    accountName,
    videos,
    pageUrl: location.href,
    scoped: scopedToAccountPage,
    rootId: accountRoot?.id || null,
  };
}

function waitForVideoDetailDom(timeoutMs) {
  const selectors = [
    '[data-e2e="video-player-digg"]',
    '[data-e2e="feed-comment-icon"]',
    '[data-e2e="video-player-comment"]',
    '[data-e2e="video-player-collect"]',
    '[data-e2e="video-player-share"]',
    '[data-e2e="detail-video-publish-time"]',
    '[data-e2e="video-publish-time"]',
    '[data-e2e="video-duration"]',
  ];
  const inspect = () => ({
    ready: Boolean(document.querySelector('h1, [data-e2e="video-desc"], [data-e2e*="video-desc"]'))
      && selectors.some((selector) => document.querySelector(selector)),
    title: document.title,
    url: location.href,
  });
  const immediate = inspect();
  if (immediate.ready) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      observer.disconnect();
      resolve(result);
    };
    const check = () => {
      const result = inspect();
      if (result.ready) finish(result);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const interval = setInterval(check, 300);
    const timeout = setTimeout(() => finish(inspect()), timeoutMs);
  });
}

function extractVideoDetailPage() {
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).trim().replace(/,/g, '').toLowerCase();
    const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*(亿|万|w|k)?/i);
    if (!match) return null;
    const multiplier = match[2] === '亿' ? 100_000_000
      : (match[2] === '万' || match[2] === 'w') ? 10_000
        : match[2] === 'k' ? 1_000 : 1;
    const result = Number(match[1]) * multiplier;
    return Number.isFinite(result) ? Math.round(result) : null;
  };
  const textFrom = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.getAttribute('aria-label') || element?.getAttribute('title') || element?.textContent;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };
  const metricFrom = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      for (const value of [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]) {
        const parsed = numberOrNull(value);
        if (parsed !== null) return parsed;
      }
    }
    return null;
  };
  const parsePublishedAt = (text) => {
    if (!text) return null;
    const exact = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!exact) return null;
    const date = new Date(
      Number(exact[1]),
      Number(exact[2]) - 1,
      Number(exact[3]),
      Number(exact[4] || 0),
      Number(exact[5] || 0),
    );
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const parseDurationSeconds = (text) => {
    if (!text) return null;
    const parts = text.match(/\d+/g)?.map(Number);
    if (!parts?.length || parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  };

  const publishedAtText = textFrom([
    '[data-e2e="detail-video-publish-time"]',
    '[data-e2e="video-publish-time"]',
    '[data-e2e="video-time"]',
    '[data-e2e*="publish-time"]',
  ]);
  const durationText = textFrom([
    '[data-e2e="video-duration"]',
    '[data-e2e*="duration"]',
  ]);
  const videoElement = document.querySelector('video');
  const nativeDuration = Number(videoElement?.duration);
  const description = textFrom([
    'h1',
    '[data-e2e="video-desc"]',
    '[data-e2e="video-title"]',
    '[data-e2e*="video-desc"]',
  ]) || '';

  return {
    description,
    coverUrl: videoElement?.poster && /^https?:\/\//.test(videoElement.poster) ? videoElement.poster : null,
    playCount: metricFrom([
      '[data-e2e="video-player-play-count"]',
      '[data-e2e="video-play-count"]',
      '[data-e2e*="play-count"]',
    ]),
    likeCount: metricFrom([
      '[data-e2e="video-player-digg"]',
      '[data-e2e="video-digg"]',
    ]),
    commentCount: metricFrom([
      '[data-e2e="feed-comment-icon"]',
      '[data-e2e="video-player-comment"]',
      '[data-e2e="video-comment"]',
    ]),
    favoriteCount: metricFrom([
      '[data-e2e="video-player-collect"]',
      '[data-e2e="video-collect"]',
    ]),
    shareCount: metricFrom([
      '[data-e2e="video-player-share"]',
      '[data-e2e="video-share"]',
    ]),
    publishedAt: parsePublishedAt(publishedAtText),
    publishedAtText,
    durationSeconds: parseDurationSeconds(durationText)
      ?? (Number.isFinite(nativeDuration) && nativeDuration >= 0 ? Math.round(nativeDuration) : null),
  };
}

function activateVideoPlayback(timeoutMs) {
  const findVideo = () => document.querySelector('video');
  const immediate = findVideo();
  const waitForVideo = immediate ? Promise.resolve(immediate) : new Promise((resolve) => {
    let settled = false;
    const finish = (video) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve(video);
    };
    const interval = setInterval(() => {
      const video = findVideo();
      if (video) finish(video);
    }, 250);
    const timeout = setTimeout(() => finish(null), timeoutMs);
  });

  return waitForVideo.then(async (video) => {
    if (!video) return { found: false };
    video.muted = true;
    video.preload = 'auto';
    try { await video.play(); } catch { /* media requests may already be active */ }
    return { found: true, currentSrc: video.currentSrc || video.src || null };
  });
}
