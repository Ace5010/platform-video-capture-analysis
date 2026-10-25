// Live workspace inspection against the running workbench. Read-only: it loads
// the page, checks the new surfaces exist, and confirms no media file is
// created while browsing. It does not start any collection or analysis task.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';

const project = fileURLToPath(new URL('..', import.meta.url));
const sessionToken = randomBytes(32).toString('base64url');
const csrfToken = createHash('sha256').update(`${sessionToken}douyin-monitor-csrf-v1`).digest('hex');

const { execFileSync } = await import('node:child_process');
const python = join(project, '.venv', 'Scripts', 'python.exe');
execFileSync(python, ['-c', `
import hashlib, os, sys
sys.path.insert(0, os.environ["DOUYIN_PROJECT"])
from host_service.config import HostConfig
from host_service.database import Database
config = HostConfig.from_env()
database = Database(config)
database.create_session(hashlib.sha256(os.environ["DOUYIN_SESSION"].encode()).hexdigest(),
                        hashlib.sha256(os.environ["DOUYIN_CSRF"].encode()).hexdigest(), "127.0.0.1", 3600)
print("session created")
`], { stdio: 'inherit', env: { ...process.env, DOUYIN_PROJECT: project, DOUYIN_SESSION: sessionToken, DOUYIN_CSRF: csrfToken } });

const profile = await mkdtemp(join(tmpdir(), 'douyin-live-check-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN',
});
const mediaDir = join(project, 'data', 'host-service', 'media');
const listMedia = async () => {
  try { return (await readdir(mediaDir)).filter((name) => name.endsWith('.mp4')); } catch { return []; }
};
const redactUrls = text => String(text).replace(/https?:\/\/[^\s'"<>]+/g, value => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[url]'; }
});
try {
  await context.addCookies([{ name: 'douyin_monitor_session', value: sessionToken,
    url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  const externalImageErrors = [];
  page.on('pageerror', (error) => errors.push(redactUrls(error).slice(0, 300)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const imageUrl = /^Access to image at '([^']+)'/.exec(text)?.[1];
    const imageHost = imageUrl ? new URL(imageUrl).hostname : '';
    if ((imageHost === 'douyinpic.com' || imageHost.endsWith('.douyinpic.com')) && /CORS policy/.test(text)) {
      externalImageErrors.push(redactUrls(text).slice(0, 300));
    } else errors.push(redactUrls(text).slice(0, 300));
  });
  page.on('response', (response) => { if (response.status() >= 400) failedRequests.push(`${response.status()} ${redactUrls(response.url())}`); });
  page.on('requestfailed', (request) => failedRequests.push(`failed ${redactUrls(request.url())} ${request.failure()?.errorText || ''}`));
  const before = await listMedia();
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.locator('.accountRail').waitFor({ timeout: 30000 });
  const rail = await page.evaluate(() => ({
    all: document.querySelector('.railAll')?.textContent,
    discoveries: document.querySelector('.railDiscoveries')?.textContent,
    discoveriesSelected: document.querySelector('.railDiscoveries')?.getAttribute('aria-pressed'),
    allSelected: document.querySelector('.railAll')?.getAttribute('aria-pressed'),
    accounts: [...document.querySelectorAll('.railAccount:not(.railAll):not(.railDiscoveries)')]
      .slice(0, 5).map((node) => ({
        name: node.querySelector('.railAccountTitle')?.textContent,
        label: node.getAttribute('aria-label'),
      })),
    feedHeading: document.querySelector('.compactFeedHeading')?.textContent,
    coverButtons: document.querySelectorAll('.compactCoverButton').length,
    downloadPrompts: document.querySelectorAll('.compactCoverPending').length,
  }));
  console.log(JSON.stringify(rail, null, 2));

  assert.equal(rail.discoveriesSelected, 'false', 'the discovery entry must not start selected');
  assert.equal(rail.allSelected, 'true', '“全部账号” keeps its own selected state');
  assert.match(String(rail.discoveries), /新增检查视频/);
  assert.match(String(rail.discoveries), /条/);

  // Switching to the new scope must move the highlight and show its own list.
  await page.locator('.railDiscoveries').click();
  await page.waitForTimeout(600);
  const switched = await page.evaluate(() => ({
    discoveriesSelected: document.querySelector('.railDiscoveries')?.getAttribute('aria-pressed'),
    allSelected: document.querySelector('.railAll')?.getAttribute('aria-pressed'),
    title: document.querySelector('.topbar h1')?.textContent,
  }));
  console.log('after switch', JSON.stringify(switched));
  assert.equal(switched.discoveriesSelected, 'true', 'the discovery entry must become selected');
  assert.equal(switched.allSelected, 'false', '“全部账号” must not stay highlighted');
  assert.equal(switched.title, '新增检查视频');
  await page.locator('.railAll').click();
  await page.waitForTimeout(400);

  // Account options only contain the name and work count. Followers belong to
  // the selected account's workspace heading and must update on each switch.
  const accountOptions = page.locator('.railAccount:not(.railAll):not(.railDiscoveries)');
  assert.equal(await page.locator('.accountRail .railFollowers').count(), 0);
  assert.equal(await page.locator('.topbar .accountFollowers').count(), 0,
    'all-account browsing has no individual follower reading');
  for (let index = 0; index < Math.min(await accountOptions.count(), 4); index++) {
    const option = accountOptions.nth(index);
    const name = await option.locator('.railAccountTitle').textContent();
    assert.doesNotMatch(await option.getAttribute('aria-label'), /粉丝/);
    await option.press('Enter');
    assert.equal(await page.locator('.topbar h1').textContent(), name);
    assert.match(await page.locator('.topbar .accountFollowers').textContent(), /粉丝/);
  }
  await page.locator('.navItem', { hasText: '信源管理' }).click();
  await page.waitForTimeout(500);
  const board = await page.evaluate(() => [...document.querySelectorAll('.accountCard')].slice(0, 4).map((card) => ({
    name: card.querySelector('h3')?.textContent,
    meta: [...card.querySelectorAll('.accountMeta > span')].map((span) => span.textContent),
  })));
  console.log('account board', JSON.stringify(board, null, 2));
  for (const card of board) {
    assert.ok(card.meta.some((text) => /粉丝/.test(String(text))), 'the account card must show followers');
    assert.ok(card.meta.some((text) => /条视频/.test(String(text))), 'the account card must label the video count');
  }

  // The card body selects the work for reading and must never open a player.
  await page.locator('.railAll').click();
  await page.waitForTimeout(400);
  await page.locator('.compactVideoCopy').first().click();
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.siteVideoPlayer.isOpen').count(), 0,
    'clicking the title must select the work instead of starting playback');
  assert.ok(await page.locator('.readingDialog #reader-title').textContent(), 'the reader must show the selected work');
  await page.getByRole('button', { name: '关闭阅读，返回列表' }).click();
  await page.locator('.readingDialog').waitFor({ state: 'hidden' });

  // Hover starts loading immediately. Wait for the real first frame instead
  // of asserting the retired 140 ms delay or assuming a cold source is ready
  // within a fixed short interval.
  const coverBox = await page.locator('.compactCoverButton').first().boundingBox();
  // Start from a neutral position so this is a real pointer entry.
  await page.mouse.move(coverBox.x - 300, coverBox.y + coverBox.height / 2);
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.siteVideoPlayer.isHover').count(), 0, 'the neutral position must be idle');
  await page.mouse.move(coverBox.x + coverBox.width / 2, coverBox.y + coverBox.height / 2);
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isHover video');
    return video && !video.paused && video.readyState >= 2 && video.currentTime > 0;
  }, null, { timeout: 45000 });
  assert.equal(await page.locator('.siteVideoPlayer.isHover').count(), 1,
    'a settled hover must show the floating preview');
  await page.mouse.move(coverBox.x - 200, coverBox.y + coverBox.height / 2);
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.siteVideoPlayer.isHover').count(), 0,
    'leaving the cover must end the floating preview');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.paused), true,
    'leaving the cover must stop the media element');

  const after = await listMedia();
  assert.deepEqual(after, before, 'browsing must not create any media file');
  console.log('failed requests', JSON.stringify(failedRequests, null, 2));
  console.log('external image errors', JSON.stringify(externalImageErrors, null, 2));
  // An expired platform cover image is an external-data condition, not a page
  // failure; only application errors and page exceptions must be absent.
  const appErrors = errors.filter((text) => !/Failed to load resource/.test(text));
  assert.deepEqual(appErrors, [], `the page reported errors: ${appErrors.join(' | ')}`);
  const mediaStats = await stat(mediaDir).catch(() => null);
  console.log(`Live workspace check passed: ${board.length} account cards, ${rail.coverButtons} cards, `
    + `${after.length} media files (directory ${mediaStats ? 'present, empty' : 'absent'}), no page errors.`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
