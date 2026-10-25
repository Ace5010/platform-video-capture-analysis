// Manual acceptance against the running workbench and real platform previews.
// Only creates a temporary login session and bounded preview requests; no collection or AI jobs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const project = resolve('.'), output = resolve('artifacts/playback-sample');
await mkdir(output, { recursive: true });
const session = randomBytes(32).toString('base64url');
const csrf = createHash('sha256').update(`${session}douyin-monitor-csrf-v1`).digest('hex');
execFileSync(join(project, '.venv/Scripts/python.exe'), ['-c', `
import hashlib, os
from host_service.config import HostConfig
from host_service.database import Database
Database(HostConfig.from_env()).create_session(hashlib.sha256(os.environ['CHECK_SESSION'].encode()).hexdigest(), hashlib.sha256(os.environ['CHECK_CSRF'].encode()).hexdigest(), '127.0.0.1', 3600)
`], { windowsHide: true, env: { ...process.env, CHECK_SESSION: session, CHECK_CSRF: csrf } });
const profile = await mkdtemp(join(tmpdir(), 'observer-live-startup-'));
const browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true,
  viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const report = { startedAt: new Date().toISOString(), samples: [], cases: [], errors: [], writes: [] };
const mediaFiles = async () => (await readdir('data/host-service/media').catch(() => [])).filter(name => name.endsWith('.mp4')).sort();
const beforeFiles = await mediaFiles();
try {
  await browser.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'live-playback-acceptance'));
  await browser.addCookies([{ name: 'douyin_monitor_session', value: session, url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.port === '43129' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.writes.push(url.pathname);
  });
  await page.addInitScript(() => {
    let audio;
    const nodes = new WeakMap();
    const frames = new WeakMap();
    const state = { current: null };
    window.startupCheck = {
      start(id) {
        audio ||= new AudioContext();
        state.current = { id, started: performance.now(), firstFrame: null, firstAudible: null,
          maxRms: 0, earlyAudio: [], events: [], samples: 0 };
      },
      result() { return state.current; },
      async resume() { await audio?.resume(); },
    };
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { void audio?.resume(); }, true);
    const videoId = video => video.getAttribute('src')?.match(/previews\/(\d+)\//)?.[1];
    for (const type of ['loadstart', 'loadeddata', 'canplay', 'playing', 'pause', 'volumechange', 'error']) {
      document.addEventListener(type, event => {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        if (type === 'loadstart') {
          frames.delete(video);
          video.requestVideoFrameCallback(() => { frames.set(video, { at: performance.now(), id: videoId(video) }); });
        }
        const current = state.current;
        if (current && videoId(video) === current.id) current.events.push({ type, at: performance.now(),
          muted: video.muted, paused: video.paused, time: video.currentTime,
          frames: video.getVideoPlaybackQuality().totalVideoFrames });
      }, true);
    }
    const sample = () => {
      const current = state.current, video = document.querySelector('.siteVideoPlayer video');
      if (current && video && videoId(video) === current.id) {
        current.samples++;
        if (!nodes.has(video) && audio) {
          const analyser = audio.createAnalyser();
          audio.createMediaElementSource(video).connect(analyser);
          analyser.connect(audio.destination);
          nodes.set(video, { analyser, values: new Float32Array(analyser.fftSize) });
        }
        const quality = video.getVideoPlaybackQuality();
        const rect = video.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const frame = frames.get(video);
        if (frame?.id === current.id && current.firstFrame === null) current.firstFrame = frame.at;
        const audiblePlayback = !video.paused && !video.muted && video.volume > 0 && video.currentTime > .001;
        if (audiblePlayback && (!visible || quality.totalVideoFrames <= quality.droppedVideoFrames)) {
          current.earlyAudio.push({ at: performance.now(), visible, frames: quality.totalVideoFrames, time: video.currentTime });
        }
        if (audiblePlayback && nodes.has(video) && audio.state === 'running') {
          const node = nodes.get(video); node.analyser.getFloatTimeDomainData(node.values);
          const rms = Math.sqrt(node.values.reduce((sum, value) => sum + value * value, 0) / node.values.length);
          current.maxRms = Math.max(current.maxRms, rms);
          if (rms > .0001 && current.firstAudible === null) {
            current.firstAudible = performance.now();
            current.frameAtAudio = { visible, frames: quality.totalVideoFrames, dropped: quality.droppedVideoFrames,
              loading: Boolean(document.querySelector('.siteVideoLoading')), width: video.videoWidth, height: video.videoHeight };
          }
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.locator('.compactVideoRow').first().waitFor({ timeout: 30000 });
  const state = await page.evaluate(async () => {
    const payload = await (await fetch('http://localhost:43129/api/state', { credentials: 'include' })).json();
    return payload.state || payload.data?.state || payload.data || payload;
  });
  const accounts = state.accounts;
  const ordered = state.videos.filter(video => accounts.some(account => account.id === video.accountId))
    .sort((a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || ''));
  const chosen = [], accountIds = new Set();
  const add = video => { if (video && !chosen.some(item => item.id === video.id)) { chosen.push(video); accountIds.add(video.accountId); } };
  for (const video of ordered) { if (!accountIds.has(video.accountId)) add(video); if (chosen.length >= 8) break; }
  // Include very short/long recent videos from additional accounts and sibling works for switching.
  const recentByAccount = accounts.map(account => ordered.find(video => video.accountId === account.id)).filter(Boolean);
  for (const video of [...recentByAccount].sort((a, b) => (a.durationSeconds || Infinity) - (b.durationSeconds || Infinity))) {
    if (!accountIds.has(video.accountId)) { add(video); break; }
  }
  for (const video of [...recentByAccount].sort((a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0))) {
    if (!accountIds.has(video.accountId)) { add(video); break; }
  }
  const siblingAccount = chosen[0].accountId;
  for (const video of ordered.filter(video => video.accountId === siblingAccount).slice(0, 3)) add(video);
  report.samples = chosen.map(video => ({ id: video.id, title: video.title, accountId: video.accountId,
    accountName: accounts.find(account => account.id === video.accountId)?.name, durationSeconds: video.durationSeconds }));
  console.log(`PLAN ${chosen.length} videos, ${accountIds.size} accounts, 3 opening paths plus switching.`);
  const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const selectAccount = async video => {
    const account = accounts.find(account => account.id === video.accountId);
    await page.locator('.railAccount').filter({ has: page.locator('.railAccountTitle', { hasText: account.name }) }).first().press('Enter');
    await page.locator(`[data-video-id="${video.id}"] .compactCoverButton`).waitFor();
  };
  const close = async () => {
    await page.getByRole('button', { name: '关闭视频', exact: true }).click();
    assert.ok(await page.locator('.siteVideoPlayer video').evaluate(video => video.paused && video.muted && !video.getAttribute('src')));
    await page.locator('.compactFeedHeading').hover();
  };
  const run = async (video, mode, keepOpen = false) => {
    const entry = { id: video.id, mode, title: video.title.slice(0, 36), status: 'running' };
    report.cases.push(entry);
    try {
      await page.evaluate(id => window.startupCheck.start(id), video.id);
      const cover = page.locator(`[data-video-id="${video.id}"] .compactCoverButton`);
      if (mode === 'hover-click') {
        await cover.hover();
        await page.waitForFunction(id => { const v = document.querySelector('.siteVideoPlayer.isHover video');
          return v?.currentSrc.includes(`/previews/${id}/`) && !v.paused && v.currentTime > .1; }, video.id, { timeout: 100000 });
        assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.muted), true);
      }
      await cover.click();
      await page.evaluate(() => window.startupCheck.resume());
      await page.waitForFunction(id => {
        const video = document.querySelector('.siteVideoPlayer.isOpen video');
        const error = document.querySelector('.siteVideoPlayer p[role="status"]')?.textContent;
        return error || video?.currentSrc.includes(`/previews/${id}/`) && !video.paused && !video.muted && video.currentTime > .15;
      }, video.id, { timeout: 100000 });
      const error = await page.locator('.siteVideoPlayer p[role="status"]').allTextContents();
      assert.deepEqual(error, [], `player error: ${error.join(' ')}`);
      await page.waitForFunction(() => window.startupCheck.result().firstAudible !== null, null, { timeout: 12000 });
      await page.waitForTimeout(1200);
      const measurement = await page.evaluate(() => {
        const result = window.startupCheck.result(), video = document.querySelector('.siteVideoPlayer video');
        return { ...result, time: video.currentTime, quality: video.getVideoPlaybackQuality().totalVideoFrames, mediaError: video.error?.code || null };
      });
      assert.deepEqual(measurement.earlyAudio, [], 'audible playback must always have visible video frames');
      assert.ok(measurement.frameAtAudio?.visible && !measurement.frameAtAudio.loading && measurement.frameAtAudio.frames > 0);
      assert.ok(measurement.firstFrame !== null && measurement.firstAudible >= measurement.firstFrame - 20, 'first audio cannot precede the presented frame');
      assert.equal(measurement.mediaError, null);
      const source = await page.evaluate(async id => (await (await fetch(`http://localhost:43129/api/previews/${id}/status`, { credentials: 'include' })).json()), video.id);
      Object.assign(entry, { status: 'passed', startupMs: Math.round(measurement.firstAudible - measurement.started),
        frameBeforeAudioMs: Math.round(measurement.firstAudible - measurement.firstFrame), rms: measurement.maxRms,
        codec: source.codec, width: measurement.frameAtAudio.width, height: measurement.frameAtAudio.height, measurement });
      if (mode === 'direct-click') await page.locator('.siteVideoPlayer.isOpen').screenshot({ path: join(output, `${video.id}.png`) });
      if (!keepOpen) await close();
      console.log(`PASS ${mode} ${video.id} ${source.codec} ${entry.width}x${entry.height} audio=${entry.startupMs}ms ${entry.title}`);
    } catch (error) {
      entry.status = 'failed'; entry.error = error.message;
      entry.measurement = await page.evaluate(() => window.startupCheck.result());
      await page.screenshot({ path: join(output, `failure-${video.id}-${mode}.png`) });
      console.log(`FAIL ${mode} ${video.id}: ${error.message.split('\n')[0]}`);
      if (await page.getByRole('button', { name: '关闭视频', exact: true }).count()) await close();
    }
    await save();
  };
  for (const video of chosen) {
    await selectAccount(video);
    for (const mode of ['direct-click', 'hover-click', 'reopen']) await run(video, mode);
  }
  const siblings = chosen.filter(video => video.accountId === siblingAccount);
  if (siblings.length >= 2) {
    await selectAccount(siblings[0]);
    for (const video of [siblings[0], siblings[1], siblings[2], siblings[0]]) await run(video, 'switch', true);
    if (await page.getByRole('button', { name: '关闭视频', exact: true }).count()) await close();
  }
  report.finishedAt = new Date().toISOString();
  report.summary = { videos: chosen.length, accounts: accountIds.size, cases: report.cases.length,
    passed: report.cases.filter(entry => entry.status === 'passed').length, failed: report.cases.filter(entry => entry.status === 'failed').length };
  assert.deepEqual(await mediaFiles(), beforeFiles, 'live playback must not create media files');
  assert.ok(report.writes.every(path => path === '/api/previews/prepare'), 'only preview preparation may be submitted');
  assert.deepEqual(report.errors, []);
  await save();
  console.log('SUMMARY', JSON.stringify(report.summary));
  assert.equal(report.summary.failed, 0, 'every sampled opening path must pass');
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
