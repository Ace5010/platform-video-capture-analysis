// Every host request is intercepted; no real chats, database or paid calls.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const output = new URL('../outputs/wechat-summary-recovery/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reason = '全天消息存在遗漏或冲突，未发布总结';
try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, locale: 'zh-CN' });
    await context.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'isolated-test'));
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    let polls = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) {
        return route.continue();
      }
      requests.push({ path: url.pathname, method: route.request().method() });
      let body = { ok: true };
      if (url.pathname.endsWith('/auth/status')) body = { authenticated: true, configured: true, csrfToken: 'isolated' };
      else if (url.pathname.endsWith('/state')) body = { state: { accounts: [], videos: [], snapshots: [], linkVideos: [] } };
      else if (url.pathname.endsWith('/jobs')) body = { jobs: [] };
      else if (url.pathname.endsWith('/wechat/context')) body = { groups: [{ id: 'test', name: '测试群',
        start: 1792857600, end: 1792900002 }], members: [], batches: [], read_jobs: [] };
      else if (url.pathname.endsWith('/wechat/days')) body = { days: [{ date: '2026-10-25', ready: true,
        summarizable: true, complete: false, partial: true, coverage_end: 1792900002 }] };
      else if (url.pathname.endsWith('/wechat/summary')) body = { status: 'ready', people: {}, summary: {
        format_version: 3, notes: [], topics: [{ title: '已有总结保留', navigation_title: '已有总结',
          summary: '已有结果继续可读。', blocks: [], comparisons: [], quotes: [],
          discussion_complete: true, discussion_count: 12 }] } };
      else if (url.pathname.endsWith('/wechat/generation')) {
        polls++;
        body = { job: { id: 'fixture', date: '2026-10-25', model: 'deepseek-v4.1-flash',
          status: polls === 1 ? 'running' : 'failed', started_at: '2026-10-25T03:46:57Z',
          ...(polls === 1 ? {} : { error: reason, credits: 0.22, elapsed_seconds: 24.75 }) } };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('http://localhost:3000/?module=wechat&view=reading', { waitUntil: 'domcontentloaded' });
    await page.locator('.wxJobStatus', { hasText: reason }).waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.wxTopicReading h2').innerText(), '已有总结保留');
    assert.equal(await page.locator('.wxJobStatus').innerText(), reason);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-failure-reading.png`, output)) });
    await page.getByRole('button', { name: '读取管理', exact: true }).click();
    await page.locator('.wxHistory > summary').click();
    const record = page.locator('.wxHistory .wxRecord').first();
    await record.getByText(reason, { exact: true }).waitFor();
    assert.match(await record.innerText(), /0\.22 积分/);
    assert.match(await record.innerText(), /生成失败/);
    await record.getByText(reason, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${name}-failure-history.png`, output)) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(requests.filter(request => request.method !== 'GET'), []);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('WeChat summary UI passed: running-to-failed polling, exact reason, retained summary and official credits at desktop/mobile sizes; no host writes.');
} finally {
  await browser.close();
}
