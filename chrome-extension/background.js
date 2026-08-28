const SIX_HOURS_MINUTES = 360;
const ALARM_NAME = 'douyin-monitor-six-hour-check';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: SIX_HOURS_MINUTES, periodInMinutes: SIX_HOURS_MINUTES });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  if (accounts.length) await collectAll(accounts);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.source !== 'douyin-monitor') return;
  if (message.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'CHECK_ALL') {
    const accounts = Array.isArray(message.accounts) ? message.accounts : [];
    chrome.storage.local.set({ accounts });
    collectAll(accounts, sender.tab?.id).catch((error) => {
      sendToDashboard({ type: 'COLLECTION_ERROR', message: error.message || String(error) }, sender.tab?.id);
    });
    sendResponse({ accepted: true });
    return true;
  }
});

async function collectAll(accounts, dashboardTabId) {
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    sendToDashboard({ type: 'COLLECTION_PROGRESS', progress: Math.max(3, Math.round(index / accounts.length * 90)) }, dashboardTabId);
    try {
      const result = await collectAccount(account);
      sendToDashboard({
        type: 'COLLECTION_RESULT',
        accountId: account.id,
        accountName: result.accountName,
        videos: result.videos,
        capturedAt: new Date().toISOString(),
      }, dashboardTabId);
    } catch (error) {
      sendToDashboard({ type: 'COLLECTION_ERROR', message: `${account.name || '账号'}：${error.message || error}` }, dashboardTabId);
    }
  }
  sendToDashboard({ type: 'COLLECTION_PROGRESS', progress: 100 }, dashboardTabId);
}

async function collectAccount(account) {
  const tab = await chrome.tabs.create({ url: account.url, active: false });
  try {
    await waitForTab(tab.id);
    await delay(3500);
    const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractAccountPage });
    if (!execution?.result) throw new Error('页面没有返回可识别的数据');
    const videos = execution.result.videos.map((video) => ({ ...video, accountId: account.id, transcript: null }));
    return { accountName: execution.result.accountName, videos };
  } finally {
    if (tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function extractAccountPage() {
  const decodeText = (text) => {
    try { return decodeURIComponent(text); } catch { return text; }
  };
  const parsedRoots = [];
  for (const script of document.scripts) {
    const text = script.textContent?.trim();
    if (!text || text.length < 20) continue;
    const candidates = [text, decodeText(text)];
    for (const candidate of candidates) {
      if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
      try { parsedRoots.push(JSON.parse(candidate)); } catch { /* ignore non-JSON scripts */ }
    }
  }

  const found = new Map();
  const visited = new WeakSet();
  const walk = (value) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if ((value.aweme_id || value.awemeId) && (value.statistics || value.stats || value.video)) {
      const id = String(value.aweme_id || value.awemeId);
      const stats = value.statistics || value.stats || {};
      found.set(id, {
        id,
        title: value.desc || value.title || '未命名视频',
        description: value.desc || '',
        url: `https://www.douyin.com/video/${id}`,
        publishedAt: new Date(Number(value.create_time || value.createTime || 0) * 1000 || Date.now()).toISOString(),
        playCount: numberOrNull(stats.play_count ?? stats.playCount),
        likeCount: numberOrZero(stats.digg_count ?? stats.diggCount ?? stats.like_count),
        commentCount: numberOrZero(stats.comment_count ?? stats.commentCount),
        capturedAt: new Date().toISOString(),
      });
    }
    if (Array.isArray(value)) value.forEach(walk);
    else Object.values(value).forEach(walk);
  };
  parsedRoots.forEach(walk);

  if (!found.size) {
    for (const anchor of document.querySelectorAll('a[href*="/video/"]')) {
      const match = anchor.href.match(/\/video\/(\d+)/);
      if (!match || found.has(match[1])) continue;
      const text = (anchor.getAttribute('aria-label') || anchor.textContent || '').trim();
      found.set(match[1], {
        id: match[1], title: text || '待识别标题', description: text, url: anchor.href,
        publishedAt: new Date().toISOString(), playCount: null, likeCount: 0, commentCount: 0,
        capturedAt: new Date().toISOString(),
      });
    }
  }

  const accountName = document.querySelector('h1')?.textContent?.trim()
    || document.querySelector('[data-e2e="user-title"]')?.textContent?.trim()
    || document.title.replace(/[-_].*$/, '').trim()
    || '抖音账号';

  return { accountName, videos: [...found.values()].slice(0, 20) };

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
}

function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, 45000);
    const listener = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendToDashboard(message, preferredTabId) {
  if (preferredTabId) {
    try { await chrome.tabs.sendMessage(preferredTabId, message); return; } catch { /* find another dashboard */ }
  }
  const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'http://127.0.0.1/*'] });
  for (const tab of tabs) {
    try { await chrome.tabs.sendMessage(tab.id, message); } catch { /* stale tab */ }
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
