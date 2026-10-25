// First-frame acceptance with a real Chrome decoder and an isolated Range host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const baseline = process.argv.includes('--baseline');
const fixture = spawn('.venv/Scripts/python.exe', ['scripts/playback-fixture-host.py'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
fixture.stderr.on('data', data => { stderr += String(data).slice(0, 2000); });
const lines = createInterface({ input: fixture.stdout });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`fixture startup: ${stderr}`)), 90000);
  lines.once('line', line => { clearTimeout(timer); resolve(Number(line.replace('READY:', ''))); });
  fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exit ${code}: ${stderr}`)); });
});
const profile = await mkdtemp(join(tmpdir(), 'observer-first-frame-'));
const browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 } });
try {
  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'isolated-playback-test' }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie').match(/douyin_monitor_session=([^;]+)/)[1];
  await browser.addCookies([{ name: 'douyin_monitor_session', value: cookie, url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  await browser.route('http://localhost:43129/**', async route => {
    const url = new URL(route.request().url()); url.hostname = '127.0.0.1'; url.port = String(port);
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.log('pageerror:', error.message); });
  await page.addInitScript(() => {
    window.startupEvents = [];
    window.frameDelay = 0;
    window.holdFrames = false;
    window.dropFrameCallbacks = false;
    const ids = new WeakMap(); let nextId = 0;
    const id = video => { if (!ids.has(video)) ids.set(video, ++nextId); return ids.get(video); };
    const record = (type, video) => window.startupEvents.push({ type, at: performance.now(), element: id(video),
      source: video.getAttribute('src')?.match(/previews\/(\d+)\//)?.[1], time: video.currentTime,
      paused: video.paused, muted: video.muted, frames: video.getVideoPlaybackQuality().totalVideoFrames,
      visible: video.getBoundingClientRect().width > 0, loading: Boolean(document.querySelector('.siteVideoLoading')) });
    const nativeFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
    const nativeQuality = HTMLVideoElement.prototype.getVideoPlaybackQuality;
    const frameReadyAfter = new WeakMap();
    HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
      const quality = nativeQuality.call(this);
      return performance.now() < (frameReadyAfter.get(this) || 0)
        ? { creationTime: quality.creationTime, totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0 } : quality;
    };
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      const delay = window.frameDelay, hold = window.holdFrames, drop = window.dropFrameCallbacks;
      return nativeFrame.call(this, (now, metadata) => {
        if (hold || drop) return;
        setTimeout(() => { record('confirmed-frame', this); callback(now, metadata); }, delay);
      });
    };
    for (const type of ['loadstart', 'loadeddata', 'canplay', 'playing', 'volumechange', 'pause', 'emptied']) {
      document.addEventListener(type, event => {
        if (!(event.target instanceof HTMLVideoElement)) return;
        const video = event.target; record(type, video);
        if (type === 'loadstart') {
          const hold = window.holdFrames, delay = window.frameDelay;
          if (hold || delay) frameReadyAfter.set(video, Infinity);
          nativeFrame.call(video, () => {
            frameReadyAfter.set(video, hold ? Infinity : performance.now() + delay);
            record('native-frame', video);
          });
        }
      }, true);
    }
  });
  await page.goto('http://localhost:3000');
  const covers = page.locator('.compactCoverButton');
  await covers.first().waitFor();
  await page.locator('.compactFeedHeading').hover();
  await covers.first().press('Enter');
  await page.waitForFunction(() => window.startupEvents.some(e => e.type === 'native-frame'));
  await page.waitForFunction(() => { const v = document.querySelector('.siteVideoPlayer video'); return v && !v.paused && !v.muted && v.currentTime > .1; }).catch(async error => {
    console.log('startup failure:', await page.evaluate(() => ({ events: window.startupEvents, status: [...document.querySelectorAll('[role="status"]')].map(n => n.textContent) })));
    throw error;
  });
  const cold = await page.evaluate(() => window.startupEvents);
  console.log('cold startup:', JSON.stringify(cold));
  await page.getByRole('button', { name: '关闭视频', exact: true }).click();
  await covers.nth(1).hover();
  await page.waitForFunction(() => { const v = document.querySelector('.siteVideoPlayer.isHover video'); return v && v.currentTime > .1; }).catch(async error => {
    console.log('hover failure:', await page.evaluate(() => ({ events: window.startupEvents, player: document.querySelector('.siteVideoPlayer')?.className, media: (() => { const v = document.querySelector('.siteVideoPlayer video'); return { ready: v.readyState, paused: v.paused, time: v.currentTime, source: v.getAttribute('src')?.match(/previews\/(\d+)\//)?.[1] }; })() })));
    throw error;
  });
  await page.locator('.siteVideoPlayer video').evaluate(video => { window.hoverElement = video; });
  await covers.nth(1).click();
  const sameElement = await page.locator('.siteVideoPlayer video').evaluate(video => video === window.hoverElement);
  console.log('hover promotion preserves media element:', sameElement);
  if (!baseline) assert.ok(sameElement, 'opening the hover keeps its decoded frame, media element and clock');
  await page.getByRole('button', { name: '关闭视频', exact: true }).click();
  await page.locator('.compactFeedHeading').hover();
  await page.evaluate(() => { window.frameDelay = 700; window.startupEvents = []; });
  await covers.nth(2).press('Enter');
  await page.waitForFunction(() => window.startupEvents.some(e => e.type === 'native-frame'));
  const beforeConfirmation = await page.locator('.siteVideoPlayer video').evaluate(video => ({ muted: video.muted, paused: video.paused, time: video.currentTime }));
  console.log('while first-frame confirmation is delayed:', JSON.stringify(beforeConfirmation));
  if (!baseline) {
    assert.ok(beforeConfirmation.muted && beforeConfirmation.paused && beforeConfirmation.time < .05,
      'audio and clock wait together for the first presented frame, preserving the opening speech');
    await page.waitForFunction(() => { const v = document.querySelector('.siteVideoPlayer video'); return v && !v.paused && !v.muted && v.currentTime > .1; });
    const events = await page.evaluate(() => window.startupEvents);
    const confirmed = events.find(e => e.type === 'confirmed-frame');
    const audiblePlay = events.find(e => e.type === 'playing' && !e.muted);
    assert.ok(confirmed && audiblePlay && audiblePlay.at >= confirmed.at, 'sound only starts after a confirmed frame');
    assert.equal(await page.locator('.siteVideoLoading').count(), 0);
    await mkdir('artifacts/playback-startup', { recursive: true });
    await page.screenshot({ path: 'artifacts/playback-startup/desktop.png' });
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    await page.evaluate(() => { window.startupEvents = []; });
    await covers.first().press('Enter');
    await page.waitForFunction(() => window.startupEvents.some(e => e.type === 'native-frame'));
    await page.getByRole('button', { name: '静音', exact: true }).click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.muted && !video.paused), true, 'a mute chosen while loading survives frame readiness');
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    await covers.nth(1).press('Enter');
    await page.waitForFunction(() => window.startupEvents.filter(e => e.type === 'native-frame').length >= 2);
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.paused && video.muted && !video.getAttribute('src')), true, 'a late frame cannot restart or unmute a closed player');
    await page.evaluate(() => { window.startupEvents = []; });
    await covers.first().hover();
    await page.waitForFunction(() => window.startupEvents.some(e => e.type === 'native-frame'));
    await covers.first().click();
    assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.muted && video.paused && video.currentTime === 0), true, 'promoting a decoded but unconfirmed hover does not bypass the audio gate');
    await page.waitForFunction(() => { const v = document.querySelector('.siteVideoPlayer video'); return v && !v.paused && !v.muted && v.currentTime > .1; });
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    await page.locator('.compactFeedHeading').hover();
    await page.evaluate(() => { window.dropFrameCallbacks = true; });
    await covers.nth(1).press('Enter');
    await page.waitForFunction(() => { const v = document.querySelector('.siteVideoPlayer video'); return v && !v.paused && !v.muted && v.currentTime > .1; }, null, { timeout: 4000 }).catch(async error => {
      console.log('missing callback with decoded frame:', await page.locator('.siteVideoPlayer video').evaluate(video => ({ ready: video.readyState, frames: video.getVideoPlaybackQuality().totalVideoFrames, paused: video.paused, muted: video.muted, width: video.videoWidth })));
      throw error;
    });
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    await page.evaluate(() => { window.dropFrameCallbacks = false; });
    await page.evaluate(() => { window.holdFrames = true; });
    await covers.nth(1).press('Enter');
    await page.getByText('视频画面加载超时，请重新打开或查看原视频', { exact: true }).waitFor({ timeout: 18000 });
    assert.equal(await page.getByRole('button', { name: '播放', exact: true }).count(), 1, 'a failed startup displays the stopped playback state');
    await page.locator('.siteVideoPlayer.isOpen').screenshot({ path: 'artifacts/playback-startup/frame-timeout.png' });
    assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.muted && video.paused && video.currentTime === 0), true, 'missing video frames produce a visible error and never audio-only playback');
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    await page.evaluate(() => { window.holdFrames = false; HTMLVideoElement.prototype.requestVideoFrameCallback = undefined; });
    await covers.nth(2).press('Enter');
    await page.waitForFunction(() => { const v = document.querySelector('.siteVideoPlayer video'); return v && !v.paused && !v.muted && v.currentTime > .1; });
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    assert.deepEqual(errors, []);
  }
  await mkdir('artifacts/playback-startup', { recursive: true });
  await writeFile(`artifacts/playback-startup/${baseline ? 'before' : 'after'}.json`, JSON.stringify({ cold, sameElement, beforeConfirmation, errors }, null, 2));
  console.log(`Playback first-frame ${baseline ? 'baseline recorded' : 'regression passed'}.`);
} finally {
  await browser.close(); fixture.stdin.end('STOP\n');
  await rm(profile, { recursive: true, force: true });
}
