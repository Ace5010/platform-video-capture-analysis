// Isolated reading interaction and rendering measurements. All host APIs are mocked.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const baseline = process.argv.includes('--baseline');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const videos = [0, 1].map(index => ({ id: `900000000000000000${index}`, accountId: 'motion-fixture',
      title: `阅读测试 ${index + 1}`, description: '用于隔离验证阅读弹窗的打开、切换和关闭。',
      url: `https://www.douyin.com/video/900000000000000000${index}`, authorName: '隔离账号', coverUrl: null,
      publishedAt: `2026-10-${20 - index}T08:00:00Z`, capturedAt: '2026-10-20T08:00:00Z',
      firstSeenAt: '2026-10-20T08:00:00Z', lastSeenAt: '2026-10-20T08:00:00Z', durationSeconds: 120,
      likeCount: 120, commentCount: 12, favoriteCount: 30, shareCount: 6,
      transcript: `完整口播 ${index + 1}\n\n` + '先展示原素材，再比较字幕、画面和具体步骤。保留原始内容，并按实际观看结果检查效果。\n\n'.repeat(180),
      transcriptStatus: 'ready', analysisStatus: 'ready', analysisRuns: [],
      analysis: { summary: `内容摘要 ${index + 1}\n\n` + '逐步演示字幕的位置与导出画质。观察完整步骤，再比较同一画面中的细节。\n\n'.repeat(90) },
    }));
    const state = { accounts: [{ id: 'motion-fixture', name: '隔离账号', platform: 'douyin',
      url: 'https://www.douyin.com/user/motion-fixture', status: 'ready', initialSyncStatus: 'complete' }],
    videos, linkVideos: [], snapshots: [], connector: { connected: true, capabilities: ['analyze_video'] } };
    window.motionRequests = [];
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return nativeFetch(input, init);
      window.motionRequests.push({ path: url.pathname, method: String(init.method || 'GET').toUpperCase() });
      const json = payload => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/auth/status')) return json({ authenticated: true, configured: true, csrfToken: 'isolated-motion' });
      if (url.pathname.endsWith('/state')) return json({ state });
      if (url.pathname.endsWith('/jobs')) return json({ jobs: [] });
      if (url.pathname.endsWith('/qwen/status')) return json({ configured: false });
      return json({ ok: true });
    };
  });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.locator('.compactVideoCopy').first().waitFor();
  await mkdir('artifacts/detail-hover', { recursive: true });
  await page.screenshot({ path: 'artifacts/detail-hover/feed-motion-desktop.png', fullPage: true });
  await page.evaluate(() => { window.motionRequests = []; });
  async function sample(selector, expected, closing = false) {
    return page.evaluate(({ selector, expected, closing }) => new Promise(resolve => {
      const target = document.querySelector(selector);
      const before = performance.now();
      let previous = before, firstTextMs = null, settledMs = null;
      const gaps = [];
      target.click();
      function tick() {
        const now = performance.now();
        gaps.push(now - previous); previous = now;
        const reader = document.querySelector('.readingDialog[open]');
        const body = reader?.querySelector('#reader-panel');
        const ready = closing ? !reader : body?.textContent.includes(expected);
        if (ready && firstTextMs === null) firstTextMs = now - before;
        const opacity = reader && body ? Number(getComputedStyle(reader).opacity) * Number(getComputedStyle(body).opacity) : 0;
        if (ready && settledMs === null && (closing || opacity >= 0.99)) settledMs = now - before;
        if (now - before < 550) return requestAnimationFrame(tick);
        resolve({ firstTextMs, settledMs, maxFrameGapMs: Math.max(...gaps), framesOver32ms: gaps.filter(gap => gap > 32).length });
      }
      requestAnimationFrame(tick);
    }), { selector, expected, closing });
  }
  const measurements = [];
  for (let round = 0; round < 3; round++) {
    const opening = await sample('.compactVideoCopy', '内容摘要 1');
    const transcript = await sample('#reader-tab-transcript', '完整口播 1');
    const content = await sample('#reader-tab-content', '内容摘要 1');
    const closing = await sample('.readerClose', '', true);
    measurements.push({ opening, transcript, content, closing });
    if (!baseline) {
      assert.ok(opening.settledMs !== null && opening.settledMs < 240, 'reader opening uses a short reveal');
      for (const change of [transcript, content]) assert.ok(change.firstTextMs !== null && change.firstTextMs < 100, 'tab content updates without a deliberate wait');
      assert.ok(closing.firstTextMs !== null && closing.firstTextMs < 200, 'close completes promptly');
    }
  }
  if (!baseline) {
    await page.locator('.compactVideoCopy').first().click();
    await page.getByRole('button', { name: '下一条', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#reader-title')?.textContent === '阅读测试 2');
    await page.getByRole('button', { name: '上一条', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#reader-title')?.textContent === '阅读测试 1');
    // Rapid tab changes cannot apply an old queued selection afterward.
    await page.evaluate(() => { document.querySelector('#reader-tab-transcript').click(); document.querySelector('#reader-tab-production').click(); document.querySelector('#reader-tab-content').click(); });
    await page.waitForFunction(() => document.querySelector('#reader-tab-content')?.getAttribute('aria-selected') === 'true');
    await page.waitForTimeout(180);
    assert.match(await page.locator('#reader-panel').innerText(), /内容摘要 1/);
    const backdrop = await page.locator('.readingDialog').evaluate(node => getComputedStyle(node, '::backdrop').backdropFilter);
    assert.equal(backdrop, 'none', 'reader backdrop avoids full-screen blur');
    await page.screenshot({ path: 'artifacts/detail-hover/reader-motion-desktop.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.locator('.readingDialog').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.compactVideoCopy').first().click();
    await page.getByRole('tab', { name: '口播稿', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#reader-panel')?.textContent.includes('完整口播 1'));
    assert.equal(await page.locator('.readingDialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: 'artifacts/detail-hover/reader-motion-mobile.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.locator('.readingDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.compactVideoCopy').first().evaluate(node => document.activeElement === node), true, 'focus returns to the opening control');
  }
  await mkdir('artifacts/detail-hover', { recursive: true });
  await writeFile(`artifacts/detail-hover/reader-motion-${baseline ? 'before' : 'after'}.json`, JSON.stringify(measurements, null, 2));
  assert.deepEqual(errors, []);
  assert.ok((await page.evaluate(() => window.motionRequests)).every(request => request.method === 'GET'), 'reading interactions do not fetch media or create work');
  console.log(JSON.stringify({ mode: baseline ? 'before' : 'after', measurements }));
} finally { await browser.close(); }
