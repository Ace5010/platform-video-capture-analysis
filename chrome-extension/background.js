const SIX_HOURS_MINUTES = 360;
const ALARM_NAME = 'douyin-monitor-six-hour-check';
const WATCHDOG_ALARM_NAME = 'douyin-monitor-collection-watchdog';
const CONNECTOR_ALARM_NAME = 'douyin-monitor-connector-poll';
const WATCHDOG_DELAY_MINUTES = 1;
const CONNECTOR_POLL_MINUTES = 1;
const SCHEDULER_STATE_KEY = 'schedulerState';
const COLLECTION_LOCK_KEY = 'collectionLock';
const SCHEDULED_CATCH_UP_KEY = 'scheduledCatchUp';
const CONNECTOR_TOKEN_KEY = 'connectorToken';
const CONNECTOR_STATE_KEY = 'connectorState';
const CONNECTOR_OUTBOX_KEY = 'connectorEventOutbox';
const COLLECTION_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SERVICE_WORKER_KEEPALIVE_MS = 20_000;
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
const CONNECTOR_BASE_URL = 'http://127.0.0.1:43129';
const CONNECTOR_REQUEST_TIMEOUT_MS = 15_000;

let pendingResultsMutation = Promise.resolve();
let collectionLockMutation = Promise.resolve();
let connectorOutboxMutation = Promise.resolve();
let collectionInProgress = false;
let connectorPollInProgress = false;
let schedulerInitializationPromise = null;
const WORKER_INSTANCE_ID = createMessageId();

chrome.runtime.onInstalled.addListener(async () => {
  await Promise.all([
    initializeScheduler({ allowCatchUp: true }),
    initializeConnector(),
  ]);
  const stored = await chrome.storage.local.get('pendingResults');
  if (!Array.isArray(stored.pendingResults)) {
    await chrome.storage.local.set({ pendingResults: [] });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void initializeScheduler({ allowCatchUp: true });
  void initializeConnector();
});

void initializeScheduler({ allowCatchUp: true });
void initializeConnector();

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

async function ensureConnectorAlarm() {
  let existing = await chrome.alarms.get(CONNECTOR_ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(CONNECTOR_ALARM_NAME, {
      delayInMinutes: CONNECTOR_POLL_MINUTES,
      periodInMinutes: CONNECTOR_POLL_MINUTES,
    });
    existing = await chrome.alarms.get(CONNECTOR_ALARM_NAME);
  }
  return existing;
}

async function initializeConnector() {
  await ensureConnectorAlarm();
  const stored = await chrome.storage.local.get(CONNECTOR_OUTBOX_KEY);
  if (!Array.isArray(stored[CONNECTOR_OUTBOX_KEY])) {
    await chrome.storage.local.set({ [CONNECTOR_OUTBOX_KEY]: [] });
  }
  void pollConnectorQueue();
}

async function saveConnectorState(patch) {
  const stored = await chrome.storage.local.get(CONNECTOR_STATE_KEY);
  const current = stored[CONNECTOR_STATE_KEY] && typeof stored[CONNECTOR_STATE_KEY] === 'object'
    ? stored[CONNECTOR_STATE_KEY]
    : {};
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value !== undefined)),
    checkedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [CONNECTOR_STATE_KEY]: next });
  return next;
}

async function connectorRequest(path, { token, body, timeoutMs = CONNECTOR_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${CONNECTOR_BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload = {};
    if (responseText) {
      try { payload = JSON.parse(responseText); } catch { payload = {}; }
    }
    if (!response.ok) {
      const error = new Error(`主机任务服务返回 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('主机任务服务响应超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureConnectorToken() {
  const stored = await chrome.storage.local.get(CONNECTOR_TOKEN_KEY);
  if (typeof stored[CONNECTOR_TOKEN_KEY] === 'string' && stored[CONNECTOR_TOKEN_KEY]) {
    return stored[CONNECTOR_TOKEN_KEY];
  }
  const response = await connectorRequest('/connector/pair', {
    body: {
      extensionId: chrome.runtime.id || null,
      extensionVersion: chrome.runtime.getManifest().version,
      workerId: WORKER_INSTANCE_ID,
      capabilities: ['collect_latest', 'archive_account', 'analyze_video'],
    },
  });
  const token = response?.token || response?.connectorToken;
  if (typeof token !== 'string' || !token) {
    await saveConnectorState({ connected: false, paired: false, lastError: '等待主机完成扩展配对' });
    return null;
  }
  await chrome.storage.local.set({ [CONNECTOR_TOKEN_KEY]: token });
  await saveConnectorState({ connected: true, paired: true, lastError: null });
  return token;
}

function mutateConnectorOutbox(mutator) {
  const operation = connectorOutboxMutation.then(async () => {
    const stored = await chrome.storage.local.get(CONNECTOR_OUTBOX_KEY);
    const current = Array.isArray(stored[CONNECTOR_OUTBOX_KEY]) ? stored[CONNECTOR_OUTBOX_KEY] : [];
    const next = mutator(current);
    await chrome.storage.local.set({ [CONNECTOR_OUTBOX_KEY]: next });
    return next;
  });
  connectorOutboxMutation = operation.catch(() => {});
  return operation;
}

async function enqueueConnectorEvent(event, { pendingMessageId = null } = {}) {
  if (!event || !Object.hasOwn(event, 'jobId') || !event.eventId || !event.type) {
    throw new Error('任务事件缺少幂等标识');
  }
  await mutateConnectorOutbox((current) => {
    const withoutDuplicate = current.filter((item) => (item?.event || item)?.eventId !== event.eventId);
    return [...withoutDuplicate, { event, pendingMessageId }];
  });
}

async function readConnectorOutbox() {
  await connectorOutboxMutation.catch(() => {});
  const stored = await chrome.storage.local.get(CONNECTOR_OUTBOX_KEY);
  return Array.isArray(stored[CONNECTOR_OUTBOX_KEY]) ? stored[CONNECTOR_OUTBOX_KEY] : [];
}

async function flushConnectorOutbox(token) {
  const events = await readConnectorOutbox();
  for (const record of events) {
    const event = record?.event || record;
    try {
      await connectorRequest('/connector/events', { token, body: event });
      await mutateConnectorOutbox((current) => current.filter((item) => (item?.event || item)?.eventId !== event.eventId));
      if (record?.pendingMessageId) {
        await acknowledgePendingResults([record.pendingMessageId]);
      }
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        await chrome.storage.local.remove(CONNECTOR_TOKEN_KEY);
        await saveConnectorState({ connected: false, paired: false, lastError: '扩展配对已失效，正在重新配对' });
      } else {
        await saveConnectorState({ connected: false, lastError: errorMessage(error) });
      }
      return false;
    }
  }
  return true;
}

async function sendConnectorHeartbeat(token, jobId = null, status = 'idle') {
  const response = await connectorRequest('/connector/heartbeat', {
    token,
    body: {
      workerId: WORKER_INSTANCE_ID,
      extensionVersion: chrome.runtime.getManifest().version,
      jobId,
      status,
      sentAt: new Date().toISOString(),
    },
  });
  if (Array.isArray(response?.accounts)) {
    const accounts = response.accounts.map(normalizeConnectorAccount).filter(Boolean);
    await syncAccountsAndScheduler(accounts);
  }
  return response;
}

async function pollConnectorQueue() {
  if (connectorPollInProgress) return;
  connectorPollInProgress = true;
  try {
    const token = await ensureConnectorToken();
    if (!token) return;
    if (!await flushConnectorOutbox(token)) return;
    await sendConnectorHeartbeat(token, null, collectionInProgress ? 'busy' : 'idle');
    if (collectionInProgress) return;
    const response = await connectorRequest('/connector/jobs/claim', {
      token,
      body: {
        workerId: WORKER_INSTANCE_ID,
        extensionVersion: chrome.runtime.getManifest().version,
        capabilities: ['collect_latest', 'archive_account', 'analyze_video'],
      },
    });
    const job = response?.job;
    if (!job) {
      await saveConnectorState({ connected: true, paired: true, activeJobId: null, lastError: null });
      return;
    }
    if (typeof job.id !== 'string' || typeof job.type !== 'string') {
      throw new Error('主机任务服务返回了无效任务');
    }
    await saveConnectorState({ connected: true, paired: true, activeJobId: job.id, lastError: null });
    await executeConnectorJob(job, token);
    await saveConnectorState({ connected: true, activeJobId: null, lastCompletedJobId: job.id, lastError: null });
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await chrome.storage.local.remove(CONNECTOR_TOKEN_KEY);
      await saveConnectorState({ connected: false, paired: false, activeJobId: null, lastError: '扩展配对已失效，正在重新配对' });
    } else {
      await saveConnectorState({ connected: false, activeJobId: null, lastError: errorMessage(error) });
    }
  } finally {
    connectorPollInProgress = false;
  }
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

function initializeScheduler(options = {}) {
  if (schedulerInitializationPromise) return schedulerInitializationPromise;
  schedulerInitializationPromise = initializeSchedulerOnce(options)
    .finally(() => {
      schedulerInitializationPromise = null;
    });
  return schedulerInitializationPromise;
}

async function initializeSchedulerOnce({ allowCatchUp = false } = {}) {
  const stored = await chrome.storage.local.get([
    'accounts',
    SCHEDULER_STATE_KEY,
    COLLECTION_LOCK_KEY,
    SCHEDULED_CATCH_UP_KEY,
  ]);
  const previous = normalizeSchedulerState(stored[SCHEDULER_STATE_KEY]);
  const previousNextRun = previous.nextRunAt ? Date.parse(previous.nextRunAt) : Number.NaN;
  const wasOverdue = Number.isFinite(previousNextRun) && previousNextRun <= Date.now();
  const existingAlarm = await chrome.alarms.get(ALARM_NAME);
  const alarm = existingAlarm || await ensureSixHourAlarm();
  const accounts = Array.isArray(stored.accounts) ? stored.accounts.filter(isValidAccount) : [];
  const scheduledAccounts = accounts.filter((account) => account.initialSyncStatus === 'complete');
  const existingLock = stored[COLLECTION_LOCK_KEY];
  const orphanedLock = Boolean(existingLock?.token && existingLock.ownerId !== WORKER_INSTANCE_ID);
  if (orphanedLock) {
    await chrome.storage.local.remove(COLLECTION_LOCK_KEY);
    collectionInProgress = false;
  }
  const state = await saveSchedulerState({
    alarmRegistered: Boolean(alarm),
    monitoredAccountCount: scheduledAccounts.length,
    checkedAt: new Date().toISOString(),
  });
  if (previous.lastRunStatus === 'running' && scheduledAccounts.length && !collectionInProgress && (!existingLock?.token || orphanedLock)) {
    void runScheduledCollection('recovery', {
      runId: existingLock?.runId,
      completedAccountIds: Array.isArray(existingLock?.completedAccountIds) ? existingLock.completedAccountIds : [],
    });
  } else if (allowCatchUp && !existingAlarm && wasOverdue && scheduledAccounts.length) {
    void runScheduledCollection('catch-up');
  } else if (stored[SCHEDULED_CATCH_UP_KEY] && !collectionInProgress && (!existingLock?.token || orphanedLock)) {
    void runPendingScheduledCatchUp();
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

async function acquireCollectionLock(trigger, runId = createMessageId()) {
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
      [COLLECTION_LOCK_KEY]: {
        token,
        ownerId: WORKER_INSTANCE_ID,
        runId,
        trigger,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        plannedAccountIds: [],
        completedAccountIds: [],
      },
    });
    await scheduleCollectionWatchdog();
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
    await chrome.alarms.clear(WATCHDOG_ALARM_NAME);
  } finally {
    collectionInProgress = false;
  }
  void runPendingScheduledCatchUp();
}

async function queueScheduledCatchUp(trigger) {
  const queuedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [SCHEDULED_CATCH_UP_KEY]: {
      trigger,
      queuedAt,
    },
  });
  await saveSchedulerState({
    lastAttemptAt: queuedAt,
    lastRunStatus: 'queued',
    lastTrigger: trigger,
    lastError: '到点时已有采集任务，已排队并将在当前任务结束后补采全部监控账号',
    checkedAt: queuedAt,
  });
}

async function runPendingScheduledCatchUp() {
  if (collectionInProgress) return false;
  const stored = await chrome.storage.local.get(SCHEDULED_CATCH_UP_KEY);
  const pending = stored[SCHEDULED_CATCH_UP_KEY];
  if (!pending) return false;
  await chrome.storage.local.remove(SCHEDULED_CATCH_UP_KEY);
  void runScheduledCollection('queued-catch-up');
  return true;
}

async function scheduleCollectionWatchdog() {
  await chrome.alarms.create(WATCHDOG_ALARM_NAME, { delayInMinutes: WATCHDOG_DELAY_MINUTES });
}

function mutateCollectionLock(token, mutator) {
  const operation = collectionLockMutation.then(async () => {
    const stored = await chrome.storage.local.get(COLLECTION_LOCK_KEY);
    const current = stored[COLLECTION_LOCK_KEY];
    if (!current || current.token !== token) return null;
    const next = mutator(current);
    await chrome.storage.local.set({ [COLLECTION_LOCK_KEY]: next });
    return next;
  });
  collectionLockMutation = operation.catch(() => {});
  return operation;
}

async function touchCollectionLock(token) {
  if (!token) return;
  await mutateCollectionLock(token, (current) => ({
    ...current,
    heartbeatAt: new Date().toISOString(),
  }));
  await scheduleCollectionWatchdog();
}

async function setCollectionPlan(token, accounts) {
  if (!token) return;
  await mutateCollectionLock(token, (current) => ({
    ...current,
    plannedAccountIds: accounts.map((account) => account.id),
  }));
}

async function checkpointCollectionAccount(token, accountId) {
  if (!token || !accountId) return;
  await mutateCollectionLock(token, (current) => ({
    ...current,
    completedAccountIds: [...new Set([...(current.completedAccountIds || []), accountId])],
    heartbeatAt: new Date().toISOString(),
  }));
}

async function handleCollectionWatchdog() {
  const stored = await chrome.storage.local.get([COLLECTION_LOCK_KEY, SCHEDULER_STATE_KEY]);
  const lock = stored[COLLECTION_LOCK_KEY];
  if (!lock?.token) {
    await chrome.alarms.clear(WATCHDOG_ALARM_NAME);
    return;
  }
  if (lock.ownerId === WORKER_INSTANCE_ID && collectionInProgress) {
    await scheduleCollectionWatchdog();
    return;
  }

  await chrome.storage.local.remove(COLLECTION_LOCK_KEY);
  collectionInProgress = false;
  if (lock.trigger === 'manual') {
    await persistAndDeliver({
      type: 'COLLECTION_ERROR',
      accountId: null,
      message: '上一次手动采集被 Chrome 中断，锁已自动释放，请重新检查',
      capturedAt: new Date().toISOString(),
    });
    void runPendingScheduledCatchUp();
    return;
  }
  const schedulerState = normalizeSchedulerState(stored[SCHEDULER_STATE_KEY]);
  if (schedulerState.lastRunStatus === 'running') {
    void runScheduledCollection('recovery', {
      runId: lock.runId,
      completedAccountIds: Array.isArray(lock.completedAccountIds) ? lock.completedAccountIds : [],
    });
  } else {
    void runPendingScheduledCatchUp();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void runScheduledCollection('alarm');
    return;
  }
  if (alarm.name === WATCHDOG_ALARM_NAME) {
    void handleCollectionWatchdog();
    return;
  }
  if (alarm.name === CONNECTOR_ALARM_NAME) void pollConnectorQueue();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source !== 'douyin-monitor') return;
  if (!isTrustedDashboardSender(sender)) {
    sendResponse({ accepted: false, ok: false, error: '仅允许本机工作台调用 Chrome 采集组件' });
    return;
  }

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
    const runId = createMessageId();
    let responseSent = false;
    void (async () => {
      lockToken = await acquireCollectionLock('manual', runId);
      if (!lockToken) {
        sendResponse({ accepted: false, error: '已有采集任务正在运行，请等待当前任务完成' });
        responseSent = true;
        return;
      }
      await syncAccountsAndScheduler(allAccounts, sender.tab?.id);
      await setCollectionPlan(lockToken, accounts);
      sendResponse({ accepted: true });
      responseSent = true;
      await keepServiceWorkerAliveUntil(
        () => collectAll(accounts, sender.tab?.id, { runId, lockToken }),
        lockToken,
      );
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

function isTrustedDashboardSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const senderUrl = sender.tab?.url || sender.url;
  if (typeof senderUrl !== 'string') return false;
  try {
    const parsed = new URL(senderUrl);
    return parsed.protocol === 'http:'
      && parsed.port === '3000'
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

async function runScheduledCollection(trigger = 'alarm', resume = {}) {
  const runId = resume.runId || createMessageId();
  const lockToken = await acquireCollectionLock(trigger, runId);
  if (!lockToken) {
    await queueScheduledCatchUp(trigger);
    return;
  }
  const startedAt = new Date().toISOString();
  try {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const allScheduledAccounts = Array.isArray(accounts)
      ? accounts
        .filter((account) => isValidAccount(account) && account.initialSyncStatus === 'complete')
        .map((account) => ({ ...account, syncMode: 'latest' }))
      : [];
    const completedAccountIds = new Set(Array.isArray(resume.completedAccountIds) ? resume.completedAccountIds : []);
    const scheduledAccounts = allScheduledAccounts.filter((account) => !completedAccountIds.has(account.id));
    await setCollectionPlan(lockToken, allScheduledAccounts);
    await saveSchedulerState({
      monitoredAccountCount: allScheduledAccounts.length,
      lastAttemptAt: startedAt,
      lastRunStatus: allScheduledAccounts.length ? 'running' : 'waiting',
      lastTrigger: trigger,
      lastError: allScheduledAccounts.length ? null : '暂无已完成首次建档的账号',
      checkedAt: startedAt,
    });
    if (!allScheduledAccounts.length) return;
    if (!scheduledAccounts.length && trigger === 'recovery') {
      const recoveredAt = new Date().toISOString();
      await saveSchedulerState({
        lastCompletedAt: recoveredAt,
        lastSuccessAt: recoveredAt,
        lastRunStatus: 'success',
        lastTrigger: trigger,
        lastError: null,
        missedRunRecoveredAt: recoveredAt,
        checkedAt: recoveredAt,
      });
      return;
    }

    const summary = await keepServiceWorkerAliveUntil(
      () => collectAll(scheduledAccounts, undefined, { runId, lockToken }),
      lockToken,
    );
    const completedAt = new Date().toISOString();
    const lastRunStatus = summary.failed === 0 ? 'success' : summary.succeeded > 0 ? 'partial' : 'error';
    await saveSchedulerState({
      lastCompletedAt: completedAt,
      lastSuccessAt: summary.failed === 0 ? completedAt : undefined,
      lastRunStatus,
      lastTrigger: trigger,
      lastError: summary.failed > 0 ? `${summary.failed} 个账号采集失败` : null,
      missedRunRecoveredAt: trigger === 'catch-up' || trigger === 'recovery' ? completedAt : undefined,
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

function normalizeConnectorAccount(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : typeof value.accountId === 'string' ? value.accountId : null;
  const url = typeof value.url === 'string'
    ? value.url
    : typeof value.profileUrl === 'string'
      ? value.profileUrl
      : typeof value.profile_url === 'string'
        ? value.profile_url
        : null;
  if (!id || !url) return null;
  const initialSyncStatus = value.initialSyncStatus === 'complete'
    || value.initial_sync_status === 'complete'
    || Boolean(value.initialSyncCompletedAt || value.initial_sync_completed_at)
    ? 'complete'
    : 'pending';
  const account = {
    ...value,
    id,
    url,
    name: value.name || value.nickname || value.accountName || '抖音账号',
    avatarUrl: value.avatarUrl || value.avatar_url || null,
    initialSyncStatus,
    initialSyncCompletedAt: value.initialSyncCompletedAt || value.initial_sync_completed_at || null,
    syncMode: initialSyncStatus === 'complete' ? 'latest' : 'initial',
  };
  return isValidAccount(account) ? account : null;
}

function canonicalConnectorJobType(type) {
  const aliases = {
    collect_latest: 'collect_latest',
    collection_latest: 'collect_latest',
    archive_account: 'archive_account',
    archive30: 'archive_account',
    analyze_video: 'analyze_video',
    analysis_capture: 'analyze_video',
    sync_accounts: 'sync_accounts',
  };
  return aliases[type] || null;
}

async function resolveConnectorAccounts(payload, mode) {
  const stored = await chrome.storage.local.get('accounts');
  const storedAccounts = Array.isArray(stored.accounts)
    ? stored.accounts.map(normalizeConnectorAccount).filter(Boolean)
    : [];
  const incoming = [
    ...(Array.isArray(payload?.accounts) ? payload.accounts : []),
    ...(payload?.account && typeof payload.account === 'object' ? [payload.account] : []),
  ].map(normalizeConnectorAccount).filter(Boolean);
  const byId = new Map(storedAccounts.map((account) => [account.id, account]));
  for (const account of incoming) {
    byId.set(account.id, { ...byId.get(account.id), ...account });
  }

  const requestedIds = [...new Set([
    ...(Array.isArray(payload?.accountIds) ? payload.accountIds : []),
    ...(typeof payload?.accountId === 'string' ? [payload.accountId] : []),
    ...incoming.map((account) => account.id),
  ].filter((value) => typeof value === 'string' && value))];
  let accounts = requestedIds.length
    ? requestedIds.map((id) => byId.get(id)).filter(Boolean)
    : [...byId.values()];
  if (mode === 'latest' && requestedIds.length === 0) {
    accounts = accounts.filter((account) => account.initialSyncStatus === 'complete');
  }
  accounts = accounts.map((account) => ({
    ...account,
    syncMode: mode,
  }));
  if (mode === 'initial' && accounts.length > 1) accounts = accounts.slice(0, 1);
  if (!accounts.length) throw new Error('任务没有匹配到可采集的监控账号');
  return accounts;
}

async function executeConnectorJob(job, token) {
  const type = canonicalConnectorJobType(job.type);
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  if (!type) {
    const event = {
      jobId: job.id,
      eventId: `${job.id}:unsupported`,
      type: 'job_failed',
      occurredAt: new Date().toISOString(),
      payload: { message: `不支持的主机任务类型：${job.type}` },
    };
    await enqueueConnectorEvent(event);
    await flushConnectorOutbox(token);
    return;
  }
  if (type === 'sync_accounts') {
    const accounts = Array.isArray(payload.accounts)
      ? payload.accounts.map(normalizeConnectorAccount).filter(Boolean)
      : [];
    await syncAccountsAndScheduler(accounts);
    await enqueueConnectorEvent({
      jobId: job.id,
      eventId: `${job.id}:completed`,
      type: 'job_completed',
      occurredAt: new Date().toISOString(),
      payload: { syncedAccountCount: accounts.length },
    });
    await flushConnectorOutbox(token);
    return;
  }

  let lockToken = null;
  const heartbeat = setInterval(() => {
    void sendConnectorHeartbeat(token, job.id, 'running').catch(() => {});
  }, SERVICE_WORKER_KEEPALIVE_MS);
  try {
    lockToken = await acquireCollectionLock(`connector:${type}`, job.id);
    if (!lockToken) throw new Error('Chrome 正在执行另一项采集任务，本任务将等待主机重新派发');
    await sendConnectorHeartbeat(token, job.id, 'running');

    if (type === 'collect_latest' || type === 'archive_account') {
      const mode = type === 'archive_account' ? 'initial' : 'latest';
      const accounts = await resolveConnectorAccounts(payload, mode);
      await setCollectionPlan(lockToken, accounts);
      const summary = await keepServiceWorkerAliveUntil(
        () => collectAll(accounts, undefined, {
          runId: job.id,
          lockToken,
          connectorJobId: job.id,
        }),
        lockToken,
      );
      await enqueueConnectorEvent({
        jobId: job.id,
        eventId: `${job.id}:${summary.failed ? 'failed' : 'completed'}`,
        type: summary.failed ? 'job_failed' : 'job_completed',
        occurredAt: new Date().toISOString(),
        payload: {
          total: summary.total,
          succeeded: summary.succeeded,
          failed: summary.failed,
          errors: summary.errors,
        },
      });
      await flushConnectorOutbox(token);
      return;
    }

    const videoId = normalizeVideoId(payload.videoId, payload.videoUrl || payload.url);
    if (!videoId) throw new Error('视频分析任务缺少有效的视频 ID');
    const media = await captureFullVideoForAnalysis({
      videoId,
      accountId: typeof payload.accountId === 'string' ? payload.accountId : null,
      videoUrl: normalizeVideoUrl(payload.videoUrl || payload.url, videoId),
    });
    await connectorRequest('/connector/events', {
      token,
      body: {
        jobId: job.id,
        eventId: `${job.id}:analysis_media`,
        type: 'analysis_media',
        occurredAt: new Date().toISOString(),
        payload: {
          videoUrl: media.video.url,
          audioUrl: media.audio?.url || null,
          videoId,
          accountId: typeof payload.accountId === 'string' ? payload.accountId : null,
          title: typeof payload.title === 'string' ? payload.title : null,
          description: typeof payload.description === 'string' ? payload.description : null,
          sourceVideoUrl: media.sourceVideoUrl,
          mediaMeta: {
            video: media.video.metadata,
            audio: media.audio?.metadata || null,
            page: media.page,
          },
        },
      },
      timeoutMs: 30_000,
    });
  } catch (error) {
    await enqueueConnectorEvent({
      jobId: job.id,
      eventId: `${job.id}:failed`,
      type: 'job_failed',
      occurredAt: new Date().toISOString(),
      payload: { message: errorMessage(error) },
    });
    await flushConnectorOutbox(token);
    throw error;
  } finally {
    clearInterval(heartbeat);
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

function withoutPlayMetrics(video) {
  const sanitized = { ...(video || {}) };
  delete sanitized.playCount;
  delete sanitized.play_count;
  delete sanitized.viewCount;
  delete sanitized.view_count;
  return sanitized;
}

async function collectAll(accounts, dashboardTabId, {
  runId = createMessageId(),
  lockToken = null,
  connectorJobId = null,
} = {}) {
  const totalAccounts = accounts.length;
  let succeeded = 0;
  let failed = 0;
  const errors = [];
  const startedAt = new Date().toISOString();
  await sendToDashboard({
    type: 'COLLECTION_BATCH_STARTED',
    runId,
    totalAccounts,
    startedAt,
  }, dashboardTabId);

  for (let index = 0; index < totalAccounts; index += 1) {
    const account = accounts[index];

    await sendToDashboard({
      type: 'COLLECTION_STARTED',
      runId,
      accountId: account.id,
      accountName: account.name || null,
      mode: collectionModeForAccount(account),
      accountIndex: index + 1,
      totalAccounts,
      startedAt: new Date().toISOString(),
    }, dashboardTabId);

    try {
      const mode = collectionModeForAccount(account);
      const result = await collectAccount(account, mode, async ({ stage, completed, total }) => {
        await sendToDashboard({
          type: 'COLLECTION_ACCOUNT_PROGRESS',
          runId,
          accountId: account.id,
          accountName: account.name || null,
          mode,
          stage,
          accountIndex: index + 1,
          totalAccounts,
          completedVideos: completed,
          totalVideos: total,
        }, dashboardTabId);
      });

      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error('账号页返回了空视频列表，未写入任何伪造数据');
      }

      const capturedAt = new Date().toISOString();
      await persistAndDeliver({
        type: 'COLLECTION_RESULT',
        runId,
        connectorJobId,
        messageId: `${runId}:${account.id}:${mode}:result`,
        accountId: account.id,
        accountName: result.accountName,
        accountAvatarUrl: result.accountAvatarUrl,
        accountUrl: account.url,
        mode,
        videos: result.videos.map((video) => ({ ...withoutPlayMetrics(video), capturedAt })),
        capturedAt,
        warning: result.warning,
      }, dashboardTabId);
      if (mode === 'initial') await markAccountInitialized(account.id, capturedAt);
      await checkpointCollectionAccount(lockToken, account.id);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      errors.push({ accountId: account.id, message: errorMessage(error) });
      try {
        await persistAndDeliver({
          type: 'COLLECTION_ERROR',
          runId,
          connectorJobId,
          messageId: `${runId}:${account.id}:${collectionModeForAccount(account)}:error`,
          accountId: account.id,
          accountName: account.name || null,
          accountUrl: account.url,
          mode: collectionModeForAccount(account),
          message: `${account.name || '账号'}：${errorMessage(error)}`,
          capturedAt: new Date().toISOString(),
        }, dashboardTabId);
      } catch (deliveryError) {
        errors.push({ accountId: account.id, message: `失败状态保存失败：${errorMessage(deliveryError)}` });
      }
    }
  }

  const completedAt = new Date().toISOString();
  const summary = { total: totalAccounts, succeeded, failed, errors };
  await sendToDashboard({
    type: 'COLLECTION_BATCH_COMPLETED',
    runId,
    totalAccounts,
    succeeded,
    failed,
    startedAt,
    completedAt,
  }, dashboardTabId);
  return summary;
}

async function keepServiceWorkerAliveUntil(task, lockToken) {
  await chrome.runtime.getPlatformInfo().catch(() => {});
  await touchCollectionLock(lockToken).catch(() => {});
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {});
    void touchCollectionLock(lockToken).catch(() => {});
  }, SERVICE_WORKER_KEEPALIVE_MS);
  try {
    return await task();
  } finally {
    clearInterval(keepAlive);
  }
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

function extractVerifiedVideoMediaSources(expectedVideoId) {
  const targetId = String(expectedVideoId || '');
  const videoCandidates = new Map();
  const audioCandidates = new Map();
  if (!/^\d+$/.test(targetId)) return { videoCandidates: [], audioCandidates: [] };

  const numberOrNull = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return number;
    }
    return null;
  };
  const normalizedMediaUrl = (value) => {
    if (typeof value !== 'string' || !value || value.length > 8192) return null;
    try {
      const parsed = new URL(value, location.href);
      const hostname = parsed.hostname.toLowerCase();
      const allowedHost = [
        'douyinvod.com',
        'douyinstatic.com',
        'douyinpic.com',
        'zjcdn.com',
        'bytecdn.cn',
        'byteimg.com',
      ].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
      if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443') || !allowedHost) return null;
      return parsed.href;
    } catch {
      return null;
    }
  };
  const metadataFrom = (value, inherited = {}) => {
    if (!value || typeof value !== 'object') return inherited;
    return {
      width: numberOrNull(value.width, value.video_width, value.videoWidth, inherited.width),
      height: numberOrNull(value.height, value.video_height, value.videoHeight, inherited.height),
      bitrate: numberOrNull(value.bit_rate, value.bitRate, value.bitrate, value.bandwidth, inherited.bitrate),
      contentLength: numberOrNull(value.data_size, value.dataSize, value.file_size, value.fileSize, inherited.contentLength),
      quality: String(value.gear_name || value.gearName || value.quality_type || value.qualityType || value.quality || inherited.quality || ''),
      codec: String(value.codec_type || value.codecType || value.codec || inherited.codec || '') || null,
    };
  };
  const addCandidate = (kind, rawUrl, metadata) => {
    const url = normalizedMediaUrl(rawUrl);
    if (!url) return;
    const candidate = { url, ...metadataFrom(metadata) };
    const score = (candidate.width || 0) * (candidate.height || 0) * 1_000_000
      + (candidate.bitrate || 0) * 1_000
      + (candidate.contentLength || 0);
    const destination = kind === 'audio' ? audioCandidates : videoCandidates;
    const previous = destination.get(url);
    if (!previous || score >= previous.score) destination.set(url, { ...candidate, score });
  };
  const urlsFrom = (value) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap((item) => urlsFrom(item)).slice(0, 64);
    if (!value || typeof value !== 'object') return [];
    const values = [];
    for (const key of ['url_list', 'urlList', 'urls', 'url', 'src', 'main_url', 'mainUrl']) {
      if (Object.hasOwn(value, key)) values.push(...urlsFrom(value[key]));
    }
    return values.slice(0, 64);
  };
  const collectMediaTree = (root) => {
    const queue = [{ value: root, path: '', metadata: {} }];
    const seen = new WeakSet();
    let visited = 0;
    while (queue.length && visited < 60_000) {
      const current = queue.shift();
      const value = current.value;
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      const metadata = metadataFrom(value, current.metadata);
      const path = current.path.toLowerCase();
      const mime = String(value.mime_type || value.mimeType || value.format || '').toLowerCase();
      const imagePath = /(?:cover|avatar|poster|thumb|image|logo|sticker)/.test(path);
      const audioPath = /(?:^|\.)(?:audio|music|sound)(?:\.|$)/.test(path) || mime.startsWith('audio/');
      const videoPath = /(?:^|\.)(?:video|bit_rate|bitrate)(?:\.|$)/.test(path) || mime.startsWith('video/');
      const addressPath = /(?:play_addr|playaddr|play_url|playurl|download_addr|downloadaddr|url_list|urllist|\.urls?$|\.src$)/.test(path);
      if (!imagePath && (addressPath || mime.startsWith('video/') || mime.startsWith('audio/'))) {
        const kind = audioPath && !videoPath ? 'audio' : 'video';
        for (const url of urlsFrom(value)) addCandidate(kind, url, metadata);
      }
      for (const [key, child] of Object.entries(value)) {
        const childPath = current.path ? `${current.path}.${key}` : key;
        if (typeof child === 'string') {
          const lowered = childPath.toLowerCase();
          if (!/(?:cover|avatar|poster|thumb|image|logo|sticker)/.test(lowered)
            && /(?:play_addr|playaddr|play_url|playurl|download_addr|downloadaddr|url_list|urllist|\.url$|\.src$)/.test(lowered)) {
            const kind = /(?:^|\.)(?:audio|music|sound)(?:\.|$)/.test(lowered)
              && !/(?:^|\.)(?:video|bit_rate|bitrate)(?:\.|$)/.test(lowered)
              ? 'audio'
              : 'video';
            addCandidate(kind, child, metadata);
          }
        } else if (child && typeof child === 'object') {
          queue.push({ value: child, path: childPath, metadata });
        }
      }
    }
  };
  const objectMatchesTarget = (value, keyHint) => {
    if (String(keyHint || '') === targetId) return true;
    if (!value || typeof value !== 'object') return false;
    for (const key of ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId', 'group_id', 'groupId', 'id']) {
      if (Object.hasOwn(value, key) && String(value[key] || '') === targetId) return true;
    }
    return false;
  };
  const scanRoot = (root) => {
    const queue = [{ value: root, key: '' }];
    const seen = new WeakSet();
    let visited = 0;
    let matches = 0;
    while (queue.length && visited < 150_000 && matches < 32) {
      const { value, key } = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (objectMatchesTarget(value, key)) {
        collectMediaTree(value);
        matches += 1;
      }
      for (const [childKey, child] of Object.entries(value)) {
        if (child && typeof child === 'object') queue.push({ value: child, key: childKey });
      }
    }
  };
  const parseStructuredText = (raw) => {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 16 * 1024 * 1024) return null;
    const candidates = [raw.trim()];
    try { candidates.push(decodeURIComponent(raw.trim())); } catch { /* not URI encoded */ }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch { /* try the next representation */ }
    }
    return null;
  };

  const roots = [];
  for (const key of ['_ROUTER_DATA', '__INITIAL_STATE__', '__SSR_DATA__', '__NEXT_DATA__', '__NUXT__', 'RENDER_DATA']) {
    try {
      const value = window[key];
      if (value && typeof value === 'object') roots.push(value);
      else {
        const parsed = parseStructuredText(value);
        if (parsed) roots.push(parsed);
      }
    } catch { /* ignore inaccessible page globals */ }
  }
  const scripts = [...document.querySelectorAll(
    'script[type="application/json"], script#__NEXT_DATA__, script[id*="RENDER_DATA"], script[id*="SSR"], script[id*="STATE"]',
  )].slice(0, 40);
  for (const script of scripts) {
    const parsed = parseStructuredText(script.textContent || '');
    if (parsed) roots.push(parsed);
  }
  for (const root of roots) scanRoot(root);

  const clean = (values) => [...values.values()]
    .sort((left, right) => right.score - left.score)
    .map((value) => {
      const candidate = { ...value };
      delete candidate.score;
      return candidate;
    })
    .slice(0, 64);
  return { videoCandidates: clean(videoCandidates), audioCandidates: clean(audioCandidates) };
}

function allowedMediaUrl(urlValue) {
  try {
    const parsed = new URL(urlValue);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443')) return false;
    return hostname === 'douyinvod.com'
      || hostname.endsWith('.douyinvod.com')
      || hostname === 'douyinstatic.com'
      || hostname.endsWith('.douyinstatic.com')
      || hostname === 'douyinpic.com'
      || hostname.endsWith('.douyinpic.com')
      || hostname === 'zjcdn.com'
      || hostname.endsWith('.zjcdn.com')
      || hostname === 'bytecdn.cn'
      || hostname.endsWith('.bytecdn.cn')
      || hostname === 'byteimg.com'
      || hostname.endsWith('.byteimg.com');
  } catch {
    return false;
  }
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function numberFromSearch(searchParams, keys) {
  for (const key of keys) {
    const value = searchParams.get(key);
    if (value === null) continue;
    const match = String(value).match(/\d+(?:\.\d+)?/);
    const parsed = match ? Number(match[0]) : 0;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function responseHeaderValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const target = name.toLowerCase();
  return headers.find((header) => header?.name?.toLowerCase() === target)?.value || '';
}

function fullMediaCandidate(urlValue, requestType, contentTypeValue = '', responseHeaders = [], pageMetadata = null) {
  if (!allowedMediaUrl(urlValue)) return null;
  let parsed;
  try { parsed = new URL(urlValue); } catch { return null; }
  const loweredUrl = urlValue.toLowerCase();
  const contentType = String(contentTypeValue || responseHeaderValue(responseHeaders, 'content-type')).toLowerCase();
  const audioMarker = contentType.startsWith('audio/')
    || /(?:media-audio|mime_type=audio|\baudio\b|mp4a|ies-music)/.test(loweredUrl)
    || /\.(?:mp3|m4a|aac|wav|ogg)(?:\?|$)/.test(loweredUrl);
  const videoMarker = contentType.startsWith('video/')
    || /(?:mime_type=video|\bvideo\b|\.mp4(?:\?|$)|\.m4v(?:\?|$))/.test(loweredUrl)
    || requestType === 'media';
  if (!audioMarker && !videoMarker) return null;

  const width = positiveNumber(
    pageMetadata?.width,
    numberFromSearch(parsed.searchParams, ['vwidth', 'width', 'video_width', 'vw']),
  );
  const height = positiveNumber(
    pageMetadata?.height,
    numberFromSearch(parsed.searchParams, ['vheight', 'height', 'video_height', 'vh']),
  );
  const bitrate = positiveNumber(
    pageMetadata?.bitrate,
    numberFromSearch(parsed.searchParams, ['bitrate', 'video_bitrate', 'br', 'vbr', 'bandwidth']),
  );
  const contentLength = positiveNumber(
    pageMetadata?.contentLength,
    responseHeaderValue(responseHeaders, 'content-length'),
  );
  const qualityText = `${pageMetadata?.quality || ''} ${parsed.pathname} ${parsed.search}`.toLowerCase();
  const qualityHint = /(?:origin|source|original|4k|2160)/.test(qualityText) ? 5
    : /(?:2k|1440|uhd)/.test(qualityText) ? 4
      : /1080|fullhd|fhd/.test(qualityText) ? 3
        : /720|hd/.test(qualityText) ? 2
          : /540|sd/.test(qualityText) ? 1
            : 0;
  const metadata = {
    contentType: contentType || null,
    requestType: requestType || null,
    contentLength: contentLength || null,
    width: width || null,
    height: height || null,
    bitrate: bitrate || null,
    qualityHint: qualityHint || null,
    codec: pageMetadata?.codec || null,
    targetBound: pageMetadata?.targetBound === true,
    sourceKind: pageMetadata?.sourceKind || 'network',
  };
  if (audioMarker) {
    return {
      kind: 'audio',
      url: urlValue,
      metadata,
      score: bitrate * 1_000_000 + contentLength,
    };
  }
  const pixels = width && height ? width * height : 0;
  return {
    kind: 'video',
    url: urlValue,
    metadata,
    score: pixels * 1_000_000 + bitrate * 1_000 + qualityHint * 100_000 + contentLength,
  };
}

function createFullVideoCapture(tabId, timeoutMs) {
  const videoCandidates = new Map();
  const audioCandidates = new Map();
  let targetActivated = false;
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });

  const consider = (details, contentType = '', pageMetadata = null) => {
    if (details.tabId !== tabId) return;
    const candidateMetadata = pageMetadata || {
      targetBound: targetActivated,
      sourceKind: targetActivated ? 'target-network' : 'preload-network',
    };
    const candidate = fullMediaCandidate(
      details.url,
      details.type,
      contentType,
      details.responseHeaders,
      candidateMetadata,
    );
    if (!candidate) return;
    videoCandidates.delete(candidate.url);
    audioCandidates.delete(candidate.url);
    const destination = candidate.kind === 'video' ? videoCandidates : audioCandidates;
    const previous = destination.get(candidate.url);
    if (!previous || candidate.score >= previous.score) destination.set(candidate.url, candidate);
  };
  const onBeforeRequest = (details) => consider(details);
  const onHeadersReceived = (details) => consider(
    details,
    responseHeaderValue(details.responseHeaders, 'content-type'),
  );
  const removeListeners = () => {
    if (chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) {
      chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    }
    if (chrome.webRequest.onHeadersReceived.hasListener(onHeadersReceived)) {
      chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
    }
  };
  const best = (candidates) => {
    const values = [...candidates.values()];
    const structured = values.filter((candidate) => candidate.metadata.sourceKind === 'structured');
    const targetBound = values.filter((candidate) => candidate.metadata.targetBound === true);
    const eligible = structured.length ? structured : targetBound.length ? targetBound : values;
    return eligible.sort((left, right) => right.score - left.score)[0] || null;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    removeListeners();
    resolvePromise({ video: best(videoCandidates), audio: best(audioCandidates) });
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
  return {
    promise,
    stop: finish,
    markTargetActivated() {
      targetActivated = true;
    },
    considerCurrentSource(url, pageMetadata) {
      if (typeof url !== 'string' || !url) return;
      consider({ tabId, url, type: 'media', responseHeaders: [] }, 'video/mp4', {
        ...pageMetadata,
        targetBound: true,
        sourceKind: 'current-source',
      });
    },
    considerStructuredSources(sources) {
      for (const source of sources?.videoCandidates || []) {
        consider({ tabId, url: source.url, type: 'media', responseHeaders: [] }, 'video/mp4', {
          ...source,
          targetBound: true,
          sourceKind: 'structured',
        });
      }
      for (const source of sources?.audioCandidates || []) {
        consider({ tabId, url: source.url, type: 'media', responseHeaders: [] }, 'audio/mp4', {
          ...source,
          targetBound: true,
          sourceKind: 'structured',
        });
      }
    },
  };
}

async function captureFullVideoForAnalysis({ videoId, accountId, videoUrl }) {
  let tab;
  let capture;
  try {
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!tab.id) throw new Error('无法创建完整视频采集标签页');
    capture = createFullVideoCapture(tab.id, MEDIA_CAPTURE_WAIT_MS);
    await chrome.tabs.update(tab.id, { url: videoUrl });
    await waitForTab(tab.id);
    const readiness = await executeInTab(tab.id, waitForVideoDetailDom, [DETAIL_DOM_WAIT_MS]);
    const observedFromReady = videoIdFromUrl(readiness?.url);
    if (!readiness?.ready) throw new Error('目标视频详情页没有完成加载');
    if (observedFromReady !== videoId) {
      throw new Error(`目标视频校验失败，页面实际打开的是 ${observedFromReady || '未知视频'}`);
    }
    capture.markTargetActivated();
    const structuredSources = await executeInTab(
      tab.id,
      extractVerifiedVideoMediaSources,
      [videoId],
      'MAIN',
    );
    capture.considerStructuredSources(structuredSources);

    const page = await executeInTab(tab.id, activateVerifiedVideoPlayback, [videoId, 10_000]);
    if (!page?.targetMatches) {
      throw new Error(`目标视频校验失败，播放页实际是 ${page?.observedVideoId || '未知视频'}`);
    }
    capture.considerCurrentSource(page.currentSrc, {
      width: page.videoWidth,
      height: page.videoHeight,
    });
    const selected = await capture.promise;
    const finalPage = await executeInTab(tab.id, inspectVerifiedVideoTarget, [videoId]);
    if (!finalPage?.targetMatches) {
      throw new Error(`采集期间页面切换到了 ${finalPage?.observedVideoId || '未知视频'}，已丢弃媒体地址`);
    }
    if (!selected.video) throw new Error('没有捕获到目标视频的完整视觉媒体流');
    return {
      accountId,
      videoId,
      sourceVideoUrl: videoUrl,
      video: {
        url: selected.video.url,
        metadata: selected.video.metadata,
      },
      audio: selected.audio ? {
        url: selected.audio.url,
        metadata: selected.audio.metadata,
      } : null,
      page: {
        videoWidth: page.videoWidth || null,
        videoHeight: page.videoHeight || null,
        durationSeconds: page.durationSeconds || null,
        observedVideoId: page.observedVideoId,
      },
    };
  } finally {
    capture?.stop();
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
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
  const connectorEvent = connectorEventFromCollectionEnvelope(envelope);
  if (connectorEvent) {
    await enqueueConnectorEvent(connectorEvent, { pendingMessageId: envelope.messageId });
  }
  await sendToDashboard(envelope, dashboardTabId);
  return envelope;
}

function connectorEventFromCollectionEnvelope(envelope) {
  if (envelope?.type === 'COLLECTION_RESULT') {
    const videos = Array.isArray(envelope.videos) ? envelope.videos : [];
    return {
      jobId: envelope.connectorJobId || null,
      eventId: envelope.messageId,
      type: 'collection_result',
      occurredAt: envelope.capturedAt || new Date().toISOString(),
      payload: {
        accountId: envelope.accountId,
        mode: envelope.mode,
        account: {
          id: envelope.accountId,
          name: envelope.accountName || null,
          url: envelope.accountUrl || null,
          avatarUrl: envelope.accountAvatarUrl || null,
        },
        videos,
        snapshots: videos.map((video) => ({
          videoId: video.id,
          likeCount: video.likeCount ?? null,
          commentCount: video.commentCount ?? null,
          favoriteCount: video.favoriteCount ?? null,
          shareCount: video.shareCount ?? null,
          capturedAt: video.capturedAt || envelope.capturedAt || null,
        })),
        completedAt: envelope.capturedAt || null,
      },
    };
  }
  if (envelope?.type === 'COLLECTION_ERROR') {
    return {
      jobId: envelope.connectorJobId || null,
      eventId: envelope.messageId,
      type: 'job_failed',
      occurredAt: envelope.capturedAt || new Date().toISOString(),
      payload: {
        accountId: envelope.accountId || null,
        mode: envelope.mode || null,
        message: envelope.message || '采集失败',
      },
    };
  }
  return null;
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

  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: DASHBOARD_URL_PATTERNS });
  } catch {
    return false;
  }
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
    ...(Array.isArray(message.eventIds) ? message.eventIds : []),
    ...(Array.isArray(message.ids) ? message.ids : []),
    message.messageId,
    message.eventId,
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

function activateVerifiedVideoPlayback(expectedVideoId, timeoutMs) {
  const observedVideoId = () => location.pathname.match(/\/video\/(\d+)/)?.[1]
    || new URL(location.href).searchParams.get('modal_id')
    || null;
  const currentObservedId = observedVideoId();
  if (currentObservedId !== expectedVideoId) {
    return Promise.resolve({
      targetMatches: false,
      observedVideoId: currentObservedId,
      pageUrl: location.href,
    });
  }
  const findVideo = () => [...document.querySelectorAll('video')]
    .find((candidate) => candidate.getClientRects().length > 0)
    || document.querySelector('video');
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
    const finalObservedId = observedVideoId();
    if (!video || finalObservedId !== expectedVideoId) {
      return {
        targetMatches: false,
        observedVideoId: finalObservedId,
        pageUrl: location.href,
      };
    }
    video.muted = true;
    video.preload = 'auto';
    try { await video.play(); } catch { /* network media requests may already be active */ }
    const duration = Number(video.duration);
    return {
      targetMatches: true,
      observedVideoId: finalObservedId,
      pageUrl: location.href,
      currentSrc: video.currentSrc || video.src || null,
      videoWidth: Number(video.videoWidth) || null,
      videoHeight: Number(video.videoHeight) || null,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  });
}

function inspectVerifiedVideoTarget(expectedVideoId) {
  const observedVideoId = location.pathname.match(/\/video\/(\d+)/)?.[1]
    || new URL(location.href).searchParams.get('modal_id')
    || null;
  return {
    targetMatches: observedVideoId === expectedVideoId,
    observedVideoId,
    pageUrl: location.href,
  };
}
