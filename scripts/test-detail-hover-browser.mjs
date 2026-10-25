// Browser regression with isolated host responses: no production data or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(join(tmpdir(), 'observer-detail-hover-'));
const browser = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN',
});
const errors = [];
async function setup(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const videos = [
      { id: '9000000000000000001', title: '悬停验收甲', likeCount: 120, commentCount: 12, favoriteCount: 30, shareCount: 6 },
      { id: '9000000000000000002', title: '悬停验收乙', likeCount: 0, commentCount: 0, favoriteCount: 0, shareCount: 0 },
      { id: '9000000000000000003', title: '悬停验收丙', likeCount: null, commentCount: null, favoriteCount: null, shareCount: null },
    ].map((video, index) => ({ ...video, accountId: 'hover-fixture',
      url: `https://www.douyin.com/video/${video.id}`, coverUrl: null, durationSeconds: 90,
      publishedAt: `2026-10-${20 - index}T08:00:00Z`, firstSeenAt: '2026-10-20T08:00:00Z',
      capturedAt: '2026-10-20T08:00:00Z', lastSeenAt: '2026-10-20T08:00:00Z',
      authorName: '隔离验收账号', description: `资讯简介 ${index + 1}：对比同一段素材的字幕位置和导出画质，保留完整步骤与实际观看结果。`,
      transcript: index === 0 ? '这是已经保存的完整口播。先展示素材，再逐项比较字幕和画面。' : null,
      analysis: index === 0 ? { summary: '已经保存的内容摘要：对比字幕和画面。' } : null, analysisRuns: [], analysisStatus: index === 0 ? 'ready' : 'idle',
    }));
    const state = { accounts: [{ id: 'hover-fixture', platform: 'douyin', name: '隔离验收账号',
      url: 'https://www.douyin.com/user/hover-fixture', status: 'ready', initialSyncStatus: 'complete' }],
    videos, snapshots: [], linkVideos: [], connector: { connected: true, capabilities: ['analyze_video'] } };
    window.detailHoverRequests = [];
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return nativeFetch(input, init);
      const method = String(init.method || 'GET').toUpperCase();
      window.detailHoverRequests.push({ path: url.pathname, method });
      const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/auth/status')) return json({ authenticated: true, configured: true, csrfToken: 'isolated-hover' });
      if (url.pathname.endsWith('/state')) return json({ state });
      if (url.pathname.endsWith('/qwen/status')) return json({ configured: false });
      if (url.pathname.endsWith('/jobs')) return json({ jobs: [] });
      if (url.pathname.endsWith('/status')) return json({ status: 'pending', elapsedMs: 0 });
      return json({ ok: true, sources: [] });
    };
  });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.locator('.compactVideoRow').first().waitFor();
  await page.waitForTimeout(500); // Initial list reveal completes before pointer assertions.
  await page.evaluate(() => { window.detailHoverRequests = []; });
}
const snapshot = page => page.evaluate(() => ({
  title: document.querySelector('.compactVideoRow[data-selected="true"] .compactVideoCopy')?.textContent,
  selected: document.querySelector('.compactVideoRow[data-selected="true"]')?.getAttribute('data-video-id'),
  metrics: [...document.querySelectorAll('.compactVideoRow[data-selected="true"] .compactVideoMetrics dd')].map(node => node.textContent),
}));
async function waitSelected(page, id) {
  await page.waitForFunction(id => document.querySelector('.compactVideoRow[data-selected="true"]')?.getAttribute('data-video-id') === id, id);
}
try {
  const page = await browser.newPage();
  await setup(page);
  const rows = page.locator('.compactVideoRow');
  assert.equal(await page.locator('.contentBrowser .videoPreviewPane').count(), 0, 'the permanent right pane is removed');
  assert.ok(await page.locator('.compactFeed').evaluate(feed => Math.abs(feed.getBoundingClientRect().width - feed.closest('.contentBrowser').getBoundingClientRect().width) < 1));
  const copyBounds = () => page.evaluate(() => [...document.querySelectorAll('.compactVideoCopy,.compactVideoSummary')].map(node => {
    const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height];
  }));
  const beforeHover = await copyBounds();
  const assertPersistentData = async target => {
    assert.equal(await target.getByRole('button', { name: '分析此视频', exact: true }).count(), 0, 'the feed has no unsolicited analysis action');
    for (const row of await target.locator('.compactVideoRow').all()) {
      assert.equal(await row.locator('.compactVideoMeta').isVisible(), true, 'author and publication metadata remain visible');
      assert.equal(await row.locator('.compactVideoMetrics').isVisible(), true, 'all interaction data is visible without selection');
      assert.equal(await row.locator('.compactVideoMetrics > div').count(), 4);
      assert.ok(await row.evaluate(node => {
        const meta = node.querySelector('.compactVideoMeta').getBoundingClientRect();
        const metrics = node.querySelector('.compactVideoMetrics').getBoundingClientRect();
        return metrics.top >= meta.bottom - 1 || meta.top >= metrics.bottom - 1
          || metrics.left >= meta.right - 1 || meta.left >= metrics.right - 1;
      }), 'metadata and metrics never overlap');
      assert.ok(await row.evaluate(node => {
        const meta = node.querySelector('.compactVideoMeta').getBoundingClientRect();
        const metrics = node.querySelector('.compactVideoMetrics').getBoundingClientRect();
        return metrics.bottom <= meta.top + 1 || metrics.right <= meta.left + 1;
      }), 'interaction data precedes author and publication details at every viewport');
      if (target.viewportSize().width >= 1100) assert.ok(await row.evaluate(node => {
        const meta = node.querySelector('.compactVideoMeta').getBoundingClientRect();
        const metrics = node.querySelector('.compactVideoMetrics').getBoundingClientRect();
        return Math.abs((metrics.top + metrics.bottom) / 2 - (meta.top + meta.bottom) / 2) < 1;
      }), 'desktop author, publication time and metrics share one line');
    }
  };
  await assertPersistentData(page);
  await rows.nth(1).locator('.compactVideoCopy').hover();
  assert.deepEqual(await snapshot(page), { title: '悬停验收乙', selected: '9000000000000000002', metrics: ['0', '0', '0', '0'] });
  assert.equal(await rows.nth(1).locator('.compactRowInfo').evaluate(node => getComputedStyle(node).visibility), 'visible');
  const emphasis = await rows.nth(1).evaluate(row => {
    const rowStyle = getComputedStyle(row), infoStyle = getComputedStyle(row.querySelector('.compactRowInfo'));
    return { background: rowStyle.backgroundColor, marker: rowStyle.boxShadow, animation: infoStyle.animationName, opacity: infoStyle.opacity };
  });
  assert.equal(emphasis.background, 'rgb(230, 243, 236)');
  assert.match(emphasis.marker, /4px/);
  assert.equal(emphasis.animation, 'none');
  assert.equal(emphasis.opacity, '1', 'hover motion must not delay the visibility of values');
  assert.deepEqual(await copyBounds(), beforeHover, 'hover preserves every title and summary position');
  await assertPersistentData(page);
  assert.equal((await page.evaluate(() => window.detailHoverRequests)).filter(request => request.method === 'POST').length, 0, 'text browsing never prepares media or starts work');

  // A quick entry switches immediately; leaving retains that item without a delayed change.
  const firstBounds = await rows.nth(0).locator('.compactVideoCopy').boundingBox();
  const detailBounds = await page.locator('.compactFeedHeading').boundingBox();
  await page.mouse.move(firstBounds.x + firstBounds.width / 2, firstBounds.y + firstBounds.height / 2);
  await page.mouse.move(detailBounds.x + detailBounds.width / 2, detailBounds.y + detailBounds.height / 2);
  await page.waitForTimeout(220);
  assert.equal((await snapshot(page)).title, '悬停验收甲');
  await rows.nth(0).locator('.compactVideoCopy').hover();
  await rows.nth(2).locator('.compactVideoCopy').hover();
  await waitSelected(page, '9000000000000000003');
  assert.equal((await snapshot(page)).title, '悬停验收丙');
  assert.ok((await snapshot(page)).metrics.every(value => value !== '0'), 'unknown metrics stay distinct from real zeros');

  // Detail selection still follows the pointer when the existing player is open.
  await rows.nth(0).locator('.compactCoverButton').click();
  await page.locator('.siteVideoPlayer.isOpen').waitFor();
  await rows.nth(1).hover({ position: { x: 15, y: 25 } });
  await waitSelected(page, '9000000000000000002');
  assert.equal(await page.locator('.siteVideoPlayer.isOpen').count(), 1);
  assert.deepEqual(await page.locator('.siteVideoStats dd').allTextContents(), ['120', '12', '30', '6'], 'player data remains on the playing video');
  assert.ok(await page.locator('.siteVideoDetails').evaluate(node => node.getBoundingClientRect().width <= 80));
  await mkdir('artifacts/detail-hover', { recursive: true });
  await page.screenshot({ path: 'artifacts/detail-hover/workbench-player.png', fullPage: true, animations: 'disabled' });
  await page.locator('.siteVideoClose').click();
  await rows.nth(0).locator('.compactVideoCopy').hover();
  await waitSelected(page, '9000000000000000001');
  assert.deepEqual((await snapshot(page)).metrics, ['120', '12', '30', '6']);
  await page.locator('.compactFeedHeading').hover();
  await page.waitForTimeout(220);
  assert.equal((await snapshot(page)).title, '悬停验收甲');
  await page.screenshot({ path: 'artifacts/detail-hover/desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1100, height: 800 });
  await assertPersistentData(page);
  await rows.nth(1).locator('.compactVideoCopy').hover();
  await waitSelected(page, '9000000000000000002');
  await page.locator('.compactFeedHeading').hover();
  await page.screenshot({ path: 'artifacts/detail-hover/desktop-compact.png', fullPage: true, animations: 'disabled' });

  await rows.nth(0).locator('.compactVideoCopy').click();
  const reader = page.locator('.readingDialog');
  await reader.waitFor({ state: 'visible' });
  await reader.getByRole('tab', { name: '口播稿', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#reader-panel')?.textContent.includes('已经保存的完整口播'));
  assert.match(await reader.locator('#reader-panel').innerText(), /已经保存的完整口播/);
  await reader.getByRole('tab', { name: '内容分析', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#reader-panel')?.textContent.includes('字幕和画面'));
  assert.match(await reader.locator('#reader-panel').innerText(), /字幕和画面/);
  assert.ok(await reader.locator('.readerRecordDetails .previewMetadata').isVisible(), 'collection metadata remains available');
  assert.ok(await reader.locator('.analysisCosts').isVisible(), 'saved analysis billing remains available');
  await reader.getByRole('button', { name: '关闭阅读，返回列表' }).click();
  await reader.waitFor({ state: 'hidden' });

  const mobile = await browser.browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  await setup(mobilePage);
  await assertPersistentData(mobilePage);
  assert.equal(await mobilePage.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches), false);
  await mobilePage.locator('.compactVideoCopy').nth(1).tap();
  await mobilePage.locator('.readingDialog').waitFor({ state: 'visible' });
  assert.equal((await snapshot(mobilePage)).title, '悬停验收乙');
  await mobilePage.getByRole('button', { name: '关闭阅读，返回列表' }).tap();
  await mobilePage.locator('.readingDialog').waitFor({ state: 'hidden' });
  await mobilePage.screenshot({ path: 'artifacts/detail-hover/mobile.png', fullPage: true, animations: 'disabled' });
  await mobilePage.setViewportSize({ width: 320, height: 844 });
  await assertPersistentData(mobilePage);
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobilePage.screenshot({ path: 'artifacts/detail-hover/mobile-320.png', fullPage: true, animations: 'disabled' });
  await mobilePage.locator('.compactCoverButton').first().tap();
  assert.ok(await mobilePage.locator('.siteVideoPlayer.isOpen').evaluate(player => {
    const box = player.getBoundingClientRect();
    return ['.siteVideoClose', '.siteVideoPlay', '.siteVideoFullscreen', '.siteVideoVolume input', '.siteVideoSpeed select'].every(selector => {
      const rect = player.querySelector(selector).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom;
    });
  }), 'all playback controls remain fully inside the 320px screen player');
  const requests = [...await page.evaluate(() => window.detailHoverRequests), ...await mobilePage.evaluate(() => window.detailHoverRequests)];
  assert.ok(requests.every(request => request.method === 'GET' || request.path.endsWith('/previews/prepare')), `unexpected writes: ${JSON.stringify(requests.filter(request => request.method !== 'GET'))}`);
  assert.deepEqual(errors, []);
  await mobile.close();
  console.log('Persistent data passed: every row always shows metadata and all four metrics, no overlay or analysis CTA, stable hover geometry, correct player side data, saved reading/billing access, 1440/1100/390/320 layouts, and no analysis/collection calls.');
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
