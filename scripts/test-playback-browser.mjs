import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWorker } from './browser-worker.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const python = join(project, '.venv', 'Scripts', 'python.exe');
const fixture = spawn(python, [join(project, 'scripts', 'playback-fixture-host.py')], {
  cwd: project, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let fixtureError = '';
fixture.stderr.on('data', (data) => { fixtureError += String(data).slice(0, 2000); });
const lines = createInterface({ input: fixture.stdout });
const waiters = [];
lines.on('line', (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
});
function nextLine(timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const entry = (line) => { clearTimeout(timer); resolve(line); };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(entry);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`fixture timeout: ${label} ${fixtureError}`));
    }, timeoutMs);
    waiters.push(entry);
  });
}
async function ask(command, timeoutMs = 20000) {
  fixture.stdin.write(`${command}\n`);
  return nextLine(timeoutMs, command);
}
const ready = await Promise.race([
  nextLine(90000, 'startup'),
  new Promise((_, reject) => fixture.on('exit', (code) => reject(new Error(`fixture host exited ${code}: ${fixtureError}`)))),
]);
assert.ok(String(ready).startsWith('READY:'), `fixture did not become ready: ${ready}`);
const port = Number(String(ready).slice(6));
const fixtureState = async () => JSON.parse(await ask('STATE'));

const profile = await mkdtemp(join(tmpdir(), 'douyin-playback-browser-'));
const browser = new BrowserWorker(profile, { headless: true });
let mobileBrowser;
let mobileProfile;
try {
  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'playback-fixture-password' }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie')?.match(/douyin_monitor_session=([^;]+)/)?.[1];
  assert.ok(cookie);
  const context = await browser.ensureBrowser();
  await context.route('http://localhost:43129/**', async (route) => {
    const target = new URL(route.request().url());
    target.hostname = '127.0.0.1';
    target.port = String(port);
    await route.fulfill({ response: await route.fetch({ url: target.href }) });
  });
  await context.addCookies([{ name: 'douyin_monitor_session', value: cookie,
    url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  const rows = page.locator('.compactVideoRow');
  await rows.first().waitFor({ timeout: 25000 });
  assert.equal(await rows.count(), 3, 'the fixture list shows three works');
  assert.match(await page.locator('.compactFeedHeading').innerText(), /共 3 条/);
  // No local download state may gate playback any more.
  assert.equal(await page.locator('.compactCoverPending').count(), 0, 'no work waits for a download');

  const started = Date.now();
  await rows.first().hover();
  await page.locator('.siteVideoPlayer.isHover video').waitFor({ timeout: 20000 });
  const hoverShownMs = Date.now() - started;
  await page.waitForFunction(() => Boolean(document.querySelector('.siteVideoPlayer video')?.currentSrc),
    null, { timeout: 20000 });
  const sourceBoundMs = Date.now() - started;
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer video');
    return video?.currentSrc.includes('/api/previews/') && video.currentTime > 0;
  }, null, { timeout: 20000 });
  const playingMs = Date.now() - started;
  const hoverTime = await page.locator('.siteVideoPlayer video').evaluate((video) => video.currentTime);
  const firstState = await fixtureState();
  assert.ok(firstState.rangedRequests > 0, 'the relay asked the media host for a bounded range');
  assert.ok(firstState.bytesServed < 1_500_000,
    `hover must not fetch the whole file (served ${firstState.bytesServed} bytes)`);

  // Clicking the cover promotes the hovering preview into the small window
  // without restarting the media element.
  await rows.first().locator('.compactCoverButton').click();
  await page.locator('.siteVideoPlayer.isOpen video').waitFor({ timeout: 10000 });
  const clicked = await page.locator('.siteVideoPlayer video').evaluate((video) => ({
    time: video.currentTime, paused: video.paused, muted: video.muted, src: video.currentSrc }));
  assert.ok(clicked.time >= hoverTime - 0.6, 'clicking keeps the hover position instead of restarting');
  assert.ok(!clicked.paused && !clicked.muted, 'the small window continues with sound');
  await page.getByLabel('倍速').selectOption('1.5');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.playbackRate), 1.5);
  await page.getByLabel('音量').fill('0.5');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.volume), 0.5);
  await page.waitForTimeout(4500);
  const afterRefresh = await page.locator('.siteVideoPlayer video').evaluate((video) => video.currentTime);
  assert.ok(afterRefresh > clicked.time + 2, 'the list refresh does not reset playback');

  // Hovering another card must not steal playback from an open small window.
  await rows.nth(1).hover();
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.siteVideoPlayer.isHover').count(), 0, 'hover cannot replace an open player');
  assert.equal(await page.locator('.siteVideoPlayer video').count(), 1, 'only one media element exists');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.currentSrc), clicked.src);

  // A different work plays from its own source generation.
  await rows.nth(1).locator('.compactCoverButton').click();
  await page.waitForFunction((previous) => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video?.currentSrc.includes('/api/previews/') && video.currentSrc !== previous && video.currentTime > 0;
  }, clicked.src, { timeout: 20000 });
  assert.equal(await page.locator('.siteVideoPlayer video').count(), 1, 'only one media element may play');

  const beforeClose = await fixtureState();
  await page.getByRole('button', { name: '关闭视频' }).click({ force: true });
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.paused), true);
  await page.waitForTimeout(1500);
  const afterClose = await fixtureState();
  const servedAfterClose = afterClose.bytesServed - beforeClose.bytesServed;
  assert.ok(servedAfterClose < 2_000_000,
    `closing must stop reading the source (served ${servedAfterClose} more bytes)`);

  mobileProfile = await mkdtemp(join(tmpdir(), 'douyin-playback-mobile-'));
  mobileBrowser = new BrowserWorker(mobileProfile, { headless: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobileContext = await mobileBrowser.ensureBrowser();
  await mobileContext.route('http://localhost:43129/**', async (route) => {
    const target = new URL(route.request().url());
    target.hostname = '127.0.0.1';
    target.port = String(port);
    await route.fulfill({ response: await route.fetch({ url: target.href }) });
  });
  await mobileContext.addCookies([{ name: 'douyin_monitor_session', value: cookie,
    url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const mobile = await mobileContext.newPage();
  await mobile.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await mobile.locator('.compactVideoRow').first().waitFor({ timeout: 25000 });
  await mobile.locator('.compactCoverButton').first().tap();
  await mobile.locator('.siteVideoPlayer.isOpen video').waitFor({ timeout: 15000 });
  await mobile.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video && video.currentSrc.includes('/api/previews/') && !video.paused && video.currentTime > 0;
  }, null, { timeout: 20000 });
  await mobile.getByRole('button', { name: '关闭视频' }).tap({ force: true });
  console.log(`Playback browser passed: hover ${hoverShownMs} ms, source bound ${sourceBoundMs} ms, `
    + `playing ${playingMs} ms after hover; continuity, exclusive switch, stop on close, mobile tap.`);
} finally {
  await browser.close();
  await mobileBrowser?.close();
  fixture.stdin.write('STOP\n');
  fixture.stdin.end();
  await rm(profile, { recursive: true, force: true });
  if (mobileProfile) await rm(mobileProfile, { recursive: true, force: true });
}
