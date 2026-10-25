// Real Chrome, synthetic state, and intercepted host requests. No production
// database, collection queue, platform media or paid model is touched.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(join(tmpdir(), 'observer-discovery-ui-'));
const output = resolve('outputs');
await mkdir(output, { recursive: true });
const browser = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN', reducedMotion: 'reduce',
});

function fixture(count) {
  const state = {
    accounts: [{ id: 'test-account', platform: 'douyin', name: '隔离测试账号',
      url: 'https://www.douyin.com/user/test-account', status: 'ready', initialSyncStatus: 'complete' }],
    videos: [], snapshots: [], discoveries: [], linkVideos: [],
    connector: { connected: true, capabilities: ['collect_latest', 'archive_account', 'analyze_video'] },
  };
  const add = () => {
    const id = String(7530000000000000000n + BigInt(state.videos.length + 1));
    const index = state.videos.length + 1;
    state.videos.push({ id, accountId: 'test-account', title: `测试作品 ${index}`,
      description: `测试作品 ${index}`, url: `https://www.douyin.com/video/${id}`,
      publishedAt: new Date(Date.now() - index * 1000).toISOString(), durationSeconds: 30,
      likeCount: index, commentCount: 2, favoriteCount: 3, shareCount: 4, mediaStatus: 'online',
      transcript: `第 ${index} 条保存的完整口播。`, transcriptStatus: 'ready',
      analysis: { summary: `第 ${index} 条保存的视频分析。` }, analysisStatus: 'complete' });
    state.snapshots.push({ id: `snapshot-${id}`, videoId: id, accountId: 'test-account',
      capturedAt: new Date().toISOString(), likeCount: index, commentCount: 2, favoriteCount: 3, shareCount: 4 });
    state.discoveries.push({ videoId: id, accountId: 'test-account',
      discoveredAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 259_200_000).toISOString() });
    return id;
  };
  for (let index = 0; index < count; index++) add();
  return { state, add, requests: [], rejectClear: false, holdClear: null, staleNextState: null };
}

async function attach(page, test) {
  const diagnostics = [];
  page.on('pageerror', error => diagnostics.push(error.message));
  page.on('requestfailed', request => diagnostics.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  await page.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'isolated-test'));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const isHost = url.port === '43129' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/host/');
    if (!isHost) return route.continue();
    const headers = {
      'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:3000',
      'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    const reply = (body, status = 200) => route.fulfill({ status, headers, body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return reply({});
    const path = url.pathname.replace(/^\/host/, '');
    const body = request.postData() ? request.postDataJSON() : null;
    test.requests.push({ path, method: request.method(), body, headers: request.headers() });
    if (path === '/api/auth/status') return reply({ authenticated: true, configured: true, csrfToken: 'isolated-csrf' });
    if (path === '/api/state') {
      const state = test.staleNextState || structuredClone(test.state);
      test.staleNextState = null;
      return reply({ state });
    }
    if (path === '/api/qwen/status') return reply({ configured: false });
    if (path === '/api/jobs' && request.method() === 'GET') return reply({ jobs: [] });
    if (path === '/api/discoveries/clear') {
      assert.equal(request.method(), 'POST');
      assert.equal(request.headers()['x-csrf-token'], 'isolated-csrf');
      assert.ok(Array.isArray(body.videoIds) && body.videoIds.length <= 500);
      if (test.holdClear) await test.holdClear;
      if (test.rejectClear) return reply({ message: '模拟失败' }, 500);
      const before = test.state.discoveries.length;
      test.state.discoveries = test.state.discoveries.filter(item => !body.videoIds.includes(item.videoId));
      return reply({ ok: true, clearedCount: before - test.state.discoveries.length });
    }
    if (path.startsWith('/api/previews/')) return reply({ status: 'error', sources: [], message: '隔离测试不读取媒体' });
    return reply({ message: `不应发起的请求 ${path}` }, 500);
  });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('.railDiscoveries').waitFor({ state: 'attached', timeout: 30000 });
  } catch (error) {
    await page.screenshot({ path: join(output, 'discovery-clear-ui-failure.png') });
    console.error({ diagnostics, requests: test.requests.map(request => `${request.method} ${request.path}`),
      page: (await page.locator('body').innerText()).slice(0, 2400) });
    throw error;
  }
}

async function selectDiscovery(page) {
  if (page.viewportSize().width <= 980) {
    await page.locator('.mobileAccountSwitch').waitFor();
    if (!(await page.locator('.railDiscoveries').isVisible())) await page.locator('.mobileAccountSwitch').click();
  } else await page.locator('.railDiscoveries').waitFor();
  await page.locator('.railDiscoveries').click();
  await page.getByRole('button', { name: '清除', exact: true }).waitFor();
}
async function expectCount(page, count) {
  await page.waitForFunction(expected => document.querySelector('.railDiscoveries span')?.textContent === `${expected} 条`, count);
}
const clearRequests = test => test.requests.filter(request => request.path === '/api/discoveries/clear');
const assertOnlyClearWrites = test => assert.ok(test.requests
  .filter(request => request.method === 'POST').every(request => request.path === '/api/discoveries/clear'),
  'clear must not submit collection, analysis or removal jobs');

try {
  const test = fixture(3);
  const page = await browser.newPage();
  await attach(page, test);
  assert.equal(await page.getByRole('button', { name: '清除', exact: true }).count(), 0,
    'clear is scoped to the discovery view');
  await selectDiscovery(page);
  await expectCount(page, 3);
  await page.screenshot({ path: join(output, 'discovery-clear-isolated-desktop.png') });

  // A failed request keeps the displayed entries and permits a retry.
  test.rejectClear = true;
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '清除失败：模拟失败' }).waitFor();
  await expectCount(page, 3);
  assert.equal(await page.getByRole('button', { name: '清除', exact: true }).isEnabled(), true);
  test.rejectClear = false;

  // Keep the request pending while a new discovery arrives. The click captures
  // the original list, and the busy button prevents accidental repeats.
  let release;
  test.holdClear = new Promise(resolve => { release = resolve; });
  const originalRows = structuredClone({ videos: test.state.videos, snapshots: test.state.snapshots });
  await page.getByRole('button', { name: '清除', exact: true }).click();
  const busy = page.getByRole('button', { name: '清除中…', exact: true });
  await busy.waitFor();
  assert.equal(await busy.isDisabled(), true);
  const concurrentId = test.add();
  release();
  test.holdClear = null;
  await expectCount(page, 1);
  assert.deepEqual(test.state.discoveries.map(item => item.videoId), [concurrentId]);
  assert.deepEqual(test.state.videos.slice(0, 3), originalRows.videos);
  assert.deepEqual(test.state.snapshots.slice(0, 3), originalRows.snapshots);
  assert.equal(clearRequests(test).length, 2);
  assert.equal(clearRequests(test).at(-1).body.videoIds.length, 3);

  // Simulate an old poll response arriving after a successful clear. It must
  // not put cleared entries back into the current page.
  test.staleNextState = structuredClone(test.state);
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await expectCount(page, 0);
  await page.getByText('暂无新增检查视频', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '清除', exact: true }).isDisabled(), true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selectDiscovery(page);
  await expectCount(page, 0);
  assert.equal(await page.getByRole('button', { name: '清除', exact: true }).isDisabled(), true);
  await page.locator('.railAll').click();
  assert.equal(await page.locator('.compactVideoRow').count(), 4);
  await page.locator('.compactVideoCopy').first().click();
  assert.match(await page.getByRole('dialog').innerText(), /保存的视频分析/);
  await page.getByRole('dialog').getByRole('tab', { name: '口播稿', exact: true }).click();
  await page.getByRole('dialog').getByText(/保存的完整口播。/).waitFor();
  assertOnlyClearWrites(test);
  await page.close();

  // The clear covers the entire list across pagination and bounded API batches.
  const many = fixture(501);
  const manyPage = await browser.newPage();
  await attach(manyPage, many);
  await selectDiscovery(manyPage);
  await expectCount(manyPage, 501);
  await manyPage.getByRole('button', { name: '清除', exact: true }).click();
  await expectCount(manyPage, 0);
  assert.deepEqual(clearRequests(many).map(request => request.body.videoIds.length), [500, 1]);
  assert.equal(many.state.videos.length, 501);
  assertOnlyClearWrites(many);
  await manyPage.close();

  for (const width of [390, 320]) {
    const mobile = fixture(2);
    const mobilePage = await browser.newPage();
    await mobilePage.setViewportSize({ width, height: 844 });
    await attach(mobilePage, mobile);
    await selectDiscovery(mobilePage);
    const bounds = await mobilePage.getByRole('button', { name: '清除', exact: true }).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 844);
    assert.ok(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `clear button must not introduce overflow at ${width}px`);
    await mobilePage.screenshot({ path: join(output, `discovery-clear-isolated-${width}.png`) });
    await mobilePage.getByRole('button', { name: '清除', exact: true }).click();
    await expectCount(mobilePage, 0);
    assertOnlyClearWrites(mobile);
    await mobilePage.close();
  }
  console.log('Discovery clear UI passed: failure retry, busy state, concurrent discoveries, stale polls, reload persistence, saved works/results, 501-item completeness, and 390/320px layout.');
} finally {
  await browser.close();
  assert.equal(dirname(profile), tmpdir());
  await rm(profile, { recursive: true, force: true });
}
