const SIX_HOURS_MINUTES = 360;
const ALARM_NAME = 'douyin-monitor-six-hour-check';
const ACCOUNT_DOM_WAIT_MS = 25_000;
const DETAIL_DOM_WAIT_MS = 15_000;
const MEDIA_CAPTURE_WAIT_MS = 22_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;
const MAX_VISIBLE_VIDEOS = 20;
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

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSixHourAlarm();
  const stored = await chrome.storage.local.get('pendingResults');
  if (!Array.isArray(stored.pendingResults)) {
    await chrome.storage.local.set({ pendingResults: [] });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void ensureSixHourAlarm();
});

void ensureSixHourAlarm();

async function ensureSixHourAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: SIX_HOURS_MINUTES,
      periodInMinutes: SIX_HOURS_MINUTES,
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void runScheduledCollection();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source !== 'douyin-monitor') return;

  if (message.type === 'PING') {
    void readPendingResults()
      .then((pendingResults) => {
        sendResponse({
          ok: true,
          extensionVersion: chrome.runtime.getManifest().version,
          pendingResults,
        });
      })
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'CHECK_ALL') {
    const accounts = Array.isArray(message.accounts)
      ? message.accounts.filter(isValidAccount)
      : [];
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

    void chrome.storage.local.set({ accounts })
      .then(() => {
        sendResponse({ accepted: true });
        void collectAll(accounts, sender.tab?.id);
      })
      .catch((error) => {
        sendResponse({ accepted: false, error: errorMessage(error) });
        void persistAndDeliver({
          type: 'COLLECTION_ERROR',
          accountId: null,
          message: `保存账号列表失败：${errorMessage(error)}`,
          capturedAt: new Date().toISOString(),
        }, sender.tab?.id);
      });
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

async function runScheduledCollection() {
  try {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const validAccounts = Array.isArray(accounts) ? accounts.filter(isValidAccount) : [];
    if (validAccounts.length) await collectAll(validAccounts);
  } catch (error) {
    await persistAndDeliver({
      type: 'COLLECTION_ERROR',
      accountId: null,
      message: `定时采集启动失败：${errorMessage(error)}`,
      capturedAt: new Date().toISOString(),
    });
  }
}

async function collectAll(accounts, dashboardTabId) {
  const totalAccounts = accounts.length;
  for (let index = 0; index < totalAccounts; index += 1) {
    const account = accounts[index];
    const accountBaseProgress = Math.round(index / totalAccounts * 90);
    const accountProgressSpan = 90 / totalAccounts;

    await sendToDashboard({
      type: 'COLLECTION_STARTED',
      accountId: account.id,
      accountName: account.name || null,
      progress: Math.max(3, accountBaseProgress),
      startedAt: new Date().toISOString(),
    }, dashboardTabId);

    try {
      const result = await collectAccount(account, async ({ stage, completed, total }) => {
        const ratio = total > 0 ? completed / total : 0;
        await sendToDashboard({
          type: 'COLLECTION_PROGRESS',
          accountId: account.id,
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
        videos: result.videos.map((video) => ({ ...video, capturedAt })),
        capturedAt,
        warning: result.warning,
      }, dashboardTabId);
    } catch (error) {
      await persistAndDeliver({
        type: 'COLLECTION_ERROR',
        accountId: account.id,
        accountName: account.name || null,
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
}

async function collectAccount(account, onProgress) {
  const tab = await chrome.tabs.create({ url: account.url, active: false });
  if (!tab.id) throw new Error('无法创建账号采集标签页');

  try {
    await waitForTab(tab.id);
    const readiness = await executeInTab(tab.id, waitForAccountVideoDom, [ACCOUNT_DOM_WAIT_MS]);
    if (!readiness?.ready) {
      const pageLabel = readiness?.title ? `（${readiness.title}）` : '';
      throw new Error(`等待约 25 秒后仍未发现真实 /video/ 作品节点${pageLabel}，可能遇到登录、验证码、风控或页面结构变化`);
    }

    const accountPage = await executeInTab(tab.id, extractAccountPage, [MAX_VISIBLE_VIDEOS]);
    if (!accountPage || !Array.isArray(accountPage.videos)) {
      throw new Error('账号页没有返回可识别的数据结构');
    }
    if (accountPage.videos.length === 0) {
      throw new Error('账号页没有可采集的非置顶可见视频');
    }

    const enrichedVideos = [];
    const total = accountPage.videos.length;
    for (let index = 0; index < total; index += 1) {
      const video = accountPage.videos[index];
      await onProgress({ stage: 'video-detail', completed: index, total });
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

    if (!enrichedVideos.some((video) => !video.detailError)) {
      throw new Error('已发现视频，但所有详情页都未能返回互动数据，请确认 Chrome 登录状态或稍后重试');
    }

    return {
      accountName: accountPage.accountName || account.name || '抖音账号',
      videos: enrichedVideos,
      warning: enrichedVideos.some((video) => video.detailError)
        ? `${enrichedVideos.filter((video) => video.detailError).length} 条视频详情读取失败，已保留账号页可见数据`
        : null,
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
    title: description,
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
  if (typeof videoUrl === 'string') return videoUrl.match(/\/video\/(\d+)/)?.[1] || null;
  return null;
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

async function executeInTab(tabId, func, args = []) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
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

function waitForAccountVideoDom(timeoutMs) {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return element.getClientRects().length > 0 || Boolean(element.querySelector('img, video'));
  };
  const inspect = () => {
    const anchors = [...document.querySelectorAll('a[href*="/video/"]')]
      .filter((anchor) => /\/video\/\d+/.test(anchor.href) && isVisible(anchor));
    return {
      ready: anchors.length > 0,
      count: anchors.length,
      title: document.title,
      url: location.href,
    };
  };
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
    const interval = setInterval(check, 350);
    const timeout = setTimeout(() => finish(inspect()), timeoutMs);
  });
}

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
  for (const anchor of document.querySelectorAll('a[href*="/video/"]')) {
    const match = anchor.href.match(/\/video\/(\d+)/);
    if (!match || seen.has(match[1]) || !isVisible(anchor)) continue;
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

  const accountName = document.querySelector('[data-e2e="user-title"]')?.textContent?.trim()
    || document.querySelector('h1')?.textContent?.trim()
    || document.title.replace(/[-_].*$/, '').trim()
    || '抖音账号';
  return { accountName, videos, pageUrl: location.href };
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
