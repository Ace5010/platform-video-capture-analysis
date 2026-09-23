// Local stdio worker. Chrome uses a separate persistent profile and a private pipe.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import vm from 'node:vm';

export function eventSlot() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); },
  };
}

export class BrowserWorker {
  constructor(profile, options = {}) {
    this.profile = profile;
    this.options = options;
    this.context = null;
    this.tabs = new Map();
    this.nextId = 1;
    this.activeId = null;
    this.updated = eventSlot();
    this.beforeRequest = eventSlot();
    this.headersReceived = eventSlot();
  }

  async ensureBrowser() {
    if (this.context) return this.context;
    this.context = await chromium.launchPersistentContext(this.profile, {
      channel: 'chrome', headless: false, viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN', timeout: 30_000, ...this.options,
    });
    this.context.on('close', () => { this.context = null; this.tabs.clear(); });
    return this.context;
  }

  async open() {
    const context = await this.ensureBrowser();
    const page = context.pages().find((item) => ![...this.tabs.values()].some((tab) => tab.page === item))
      || await context.newPage();
    if (!page.url().startsWith('https://www.douyin.com/')) {
      await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    await page.bringToFront();
    return { running: true };
  }

  describe(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.page.isClosed()) throw new Error('专用浏览器标签页已关闭，请重新发起任务');
    return { id, windowId: 1, active: this.activeId === id, status: tab.status, url: tab.page.url() };
  }

  navigate(id, url) {
    const tab = this.tabs.get(id);
    tab.verifiedMediaRoots = [];
    tab.status = 'loading';
    tab.error = null;
    // Match chrome.tabs: navigation returns before the page finishes loading.
    void tab.page.goto(url, { waitUntil: 'load', timeout: 45_000 }).catch(() => {
      tab.error = '目标视频或账号页未能加载，请在电脑专用浏览器检查登录、验证码和网络后重试';
    }).finally(() => {
      tab.status = 'complete';
      this.updated.emit(id, { status: 'complete' });
    });
  }

  async rememberPublicVideoMedia(id, response) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const targetId = () => {
      try {
        const pageUrl = new URL(tab.page.url());
        if (pageUrl.hostname !== 'www.douyin.com') return null;
        return pageUrl.pathname.match(/^\/video\/(\d+)\/?$/)?.[1]
          || pageUrl.searchParams.get('modal_id');
      } catch { return null; }
    };
    const expectedVideoId = targetId();
    if (!/^\d+$/.test(expectedVideoId || '')) return;
    try {
      const responseUrl = new URL(response.url());
      const publicMediaPaths = ['/aweme/v1/web/aweme/detail/', '/aweme/v1/web/aweme/feed/',
        '/aweme/v1/web/feed/', '/aweme/v1/web/series/aweme/'];
      if (responseUrl.protocol !== 'https:' || responseUrl.hostname !== 'www.douyin.com'
        || (responseUrl.port && responseUrl.port !== '443') || !publicMediaPaths.includes(responseUrl.pathname)
        || response.status() !== 200) return;
      const headers = response.headers();
      if (!headers['content-type']?.toLowerCase().includes('json')
        || Number(headers['content-length']) > 16 * 1024 * 1024) return;
      // Reuse only responses already received by this page. Never fetch an API
      // ourselves or retain account, author, comment or recommendation records.
      const body = await response.body();
      if (body.length > 16 * 1024 * 1024 || this.tabs.get(id) !== tab || targetId() !== expectedVideoId) return;
      const queue = [JSON.parse(body.toString('utf8'))];
      const mediaKeys = ['width', 'height', 'video_width', 'video_height', 'videoWidth', 'videoHeight',
        'bit_rate', 'bitRate', 'bitrate', 'play_addr', 'playAddr', 'download_addr', 'downloadAddr',
        'play_addr_265', 'play_addr_h264', 'play_addr_bytevc1', 'codec_type', 'codecType', 'codec'];
      for (let cursor = 0; cursor < queue.length && cursor < 50000; cursor += 1) {
        const value = queue[cursor];
        if (!value || typeof value !== 'object') continue;
        if ((value.aweme_id === expectedVideoId || value.awemeId === expectedVideoId) && value.video) {
          const video = Object.fromEntries(mediaKeys.filter((key) => Object.hasOwn(value.video, key))
            .map((key) => [key, value.video[key]]));
          const music = Object.fromEntries(['play_url', 'playUrl'].filter((key) => Object.hasOwn(value.music || {}, key))
            .map((key) => [key, value.music[key]]));
          const record = { aweme_id: expectedVideoId, video, music };
          if (Object.keys(video).length && Buffer.byteLength(JSON.stringify(record), 'utf8') <= 2 * 1024 * 1024) {
            tab.verifiedMediaRoots = [...tab.verifiedMediaRoots, record].slice(-4);
          }
        }
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object' && queue.length < 50000) queue.push(child);
        }
      }
    } catch { /* failed or non-JSON public responses supply no media evidence */ }
  }

  chromeAdapter() {
    return {
      runtime: { onInstalled: eventSlot(), onStartup: eventSlot(), onMessage: eventSlot() },
      alarms: { onAlarm: eventSlot() },
      tabs: {
        onUpdated: this.updated,
        create: async ({ url, active }) => {
          const page = await (await this.ensureBrowser()).newPage();
          const id = this.nextId++;
          this.tabs.set(id, { page, status: 'complete', error: null, verifiedMediaRoots: [] });
          const details = (request) => ({ tabId: id, url: request.url(), type: request.resourceType(), timeStamp: Date.now() });
          page.on('request', (request) => this.beforeRequest.emit(details(request)));
          page.on('response', (response) => {
            this.headersReceived.emit({ ...details(response.request()),
              statusCode: response.status(), responseHeaders: Object.entries(response.headers()).map(([name, value]) => ({ name, value })),
            });
            void this.rememberPublicVideoMedia(id, response);
          });
          if (active || this.activeId === null) this.activeId = id;
          if (active) await page.bringToFront();
          if (url && url !== 'about:blank') this.navigate(id, url);
          return this.describe(id);
        },
        get: async (id) => this.describe(id),
        query: async ({ active } = {}) => [...this.tabs.keys()].map((id) => this.describe(id)).filter((tab) => !active || tab.active),
        update: async (id, { url, active }) => {
          this.describe(id);
          if (url) this.navigate(id, url);
          if (active) { this.activeId = id; await this.tabs.get(id).page.bringToFront(); }
          return this.describe(id);
        },
        remove: async (id) => {
          const tab = this.tabs.get(id);
          this.tabs.delete(id);
          if (this.activeId === id) this.activeId = null;
          if (tab) await tab.page.close();
        },
      },
      scripting: { executeScript: async ({ target, func, args = [] }) => {
        this.describe(target.tabId);
        const tab = this.tabs.get(target.tabId);
        if (tab.error) throw new Error(tab.error);
        // Only functions from the local audited collector are evaluated.
        const invocationArgs = func.name === 'extractVerifiedVideoMediaSources'
          ? [args[0], tab.verifiedMediaRoots.filter((record) => record.aweme_id === args[0])]
          : args;
        const result = await tab.page.evaluate(`(${func.toString()})(...${JSON.stringify(invocationArgs)})`);
        return [{ result }];
      } },
      webRequest: { onBeforeRequest: this.beforeRequest, onHeadersReceived: this.headersReceived },
    };
  }

  async collector() {
    // Reload at each task so collector edits take effect without extension reload.
    const source = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
    const sandbox = vm.createContext({ __DOUYIN_HOST_BROWSER__: true, chrome: this.chromeAdapter(),
      URL, URLSearchParams, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval,
      console: { log() {}, warn() {}, error() {} },
    });
    vm.runInContext(source, sandbox, { filename: 'shared-douyin-collector.js' });
    return sandbox;
  }

  async run(command) {
    if (command.action === 'open') return this.open();
    if (command.action === 'status') return { running: Boolean(this.context) };
    if (command.action === 'close') { await this.close(); return { running: false }; }
    if (!['collect', 'capture'].includes(command.action)) throw new Error('不支持的浏览器任务');
    const collector = await this.collector();
    if (command.action === 'collect') {
      return collector.collectAccount(command.account, command.mode, async () => {});
    }
    return collector.captureFullVideoForAnalysis(command.payload);
  }

  async close() { if (this.context) await this.context.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DOUYIN_BROWSER_PROFILE) throw new Error('缺少专用浏览器数据目录');
  const worker = new BrowserWorker(process.env.DOUYIN_BROWSER_PROFILE);
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    let command;
    try {
      command = JSON.parse(line);
      const result = await worker.run(command);
      process.stdout.write(`${JSON.stringify({ id: command.id, ok: true, result })}\n`);
    } catch (error) {
      // Never expose signed media URLs, cookies, browser diagnostics or profile paths.
      const message = String(error.message || '').split('\n')[0].replace(/https?:\/\/\S+/g, '[页面地址]').slice(0, 300);
      process.stdout.write(`${JSON.stringify({ id: command?.id, ok: false, error: message || '专用浏览器执行失败，请检查电脑上的抖音登录和验证码' })}\n`);
    }
  }
  await worker.close();
}
