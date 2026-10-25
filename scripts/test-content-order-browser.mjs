// Isolated, read-only host fixture: cross-account and discovery publication order.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(join(tmpdir(), 'observer-content-order-'));
const browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true,
  viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
try {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = Date.now();
  const videos = Array.from({ length: 14 }, (_, index) => {
    const rank = index + 1;
    return { id: String(9100000000000000000n + BigInt(rank)), accountId: rank % 2 ? 'a' : 'b',
      title: `发布时间顺序 ${rank}`, description: '', url: `https://www.douyin.com/video/${9100000000000000000n + BigInt(rank)}`,
      // Rank 2 is genuinely newer than rank 3 despite the latter's larger clock string.
      publishedAt: rank === 2 ? '2026-10-21T02:00:00Z' : rank === 3 ? '2026-10-21T09:00:00+08:00'
        : rank <= 12 ? `2026-10-${String(23 - rank).padStart(2, '0')}T00:00:00Z` : rank === 13 ? null : 'unknown',
      firstSeenAt: new Date(now + rank * 1000).toISOString(), durationSeconds: 30,
      likeCount: rank, commentCount: 0, favoriteCount: 0, shareCount: 0, transcript: null, analysis: null };
  });
  // The rank-1 publication is newer than the offset/UTC pair.
  videos[0].publishedAt = '2026-10-21T03:00:00Z';
  const discoveries = videos.map((video, index) => ({ videoId: video.id, accountId: video.accountId,
    discoveredAt: new Date(now - (14 - index) * 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }));
  const expired = { ...videos[0], id: '9100000000000000099', title: '过期提醒作品', publishedAt: '2026-10-22T00:00:00Z' };
  const state = { accounts: ['a', 'b'].map(id => ({ id, platform: 'douyin', name: `验收账号${id}`,
    url: `https://www.douyin.com/user/${id}`, status: 'ready', initialSyncStatus: 'complete' })),
    videos: [videos[5], expired, ...videos.filter((_, index) => index !== 5)], discoveries: [
      ...discoveries.reverse(), { videoId: expired.id, accountId: expired.accountId,
        discoveredAt: new Date(now - 300_000_000).toISOString(), expiresAt: new Date(now - 1000).toISOString() },
    ], snapshots: [], linkVideos: [], connector: { connected: true } };
  await page.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'isolated-order'));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return route.continue();
    requests.push({ method: request.method(), path: url.pathname });
    const path = url.pathname.replace(/^\/host/, '');
    const data = path.endsWith('/auth/status') ? { authenticated: true, configured: true, csrfToken: 'isolated-order' }
      : path.endsWith('/state') ? { state } : path.endsWith('/jobs') ? { jobs: [] } : { configured: false };
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:3000', 'Access-Control-Allow-Credentials': 'true' }, body: JSON.stringify(data) });
  });
  await page.goto('http://localhost:3000');
  await page.locator('.compactVideoRow').first().waitFor();
  const ids = () => page.locator('.compactVideoRow').evaluateAll(rows => rows.map(row => row.getAttribute('data-video-id')));
  const ordered = [...videos.slice(0, 12), videos[12], videos[13]].map(video => video.id);
  const allExpected = [expired.id, ...ordered];
  assert.deepEqual(await ids(), allExpected.slice(0, 10), 'all-account page 1 follows publication instants across accounts');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.compactVideoRow')?.getAttribute('data-video-id') === id, allExpected[10]);
  assert.deepEqual(await ids(), allExpected.slice(10), 'global sorting happens before pagination');
  await page.locator('.railDiscoveries').click();
  await page.waitForFunction(() => document.querySelector('.compactFeedHeading strong')?.textContent === '新增检查视频');
  assert.deepEqual(await ids(), ordered.slice(0, 10), 'discovery order follows publication, even when discovery order is reversed');
  await mkdir('artifacts/content-order', { recursive: true });
  await page.screenshot({ path: 'artifacts/content-order/discoveries.png' });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.compactVideoRow')?.getAttribute('data-video-id') === id, ordered[10]);
  assert.deepEqual(await ids(), ordered.slice(10), 'unknown dates stay at the end of the final discovery page');
  await page.locator('.railAll').click();
  await page.waitForFunction(id => document.querySelector('.compactVideoRow')?.getAttribute('data-video-id') === id, allExpected[0]);
  assert.deepEqual(await ids(), allExpected.slice(0, 10), 'switching back keeps newest-first ordering');
  await page.screenshot({ path: 'artifacts/content-order/all.png' });
  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => ['GET', 'OPTIONS'].includes(request.method)), 'browsing never starts collection, analysis or media preparation');
  console.log('Content order browser passed: cross-account publication order, UTC/offset dates, reversed discovery order, pagination, unknown dates, expiry filtering and no writes.');
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
