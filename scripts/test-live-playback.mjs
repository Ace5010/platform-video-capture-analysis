// Real playback verification against the running workbench: hovers and clicks
// an actual monitored work, measures the low-resolution source the host
// resolves, bytes received by Chrome, seek behaviour and stop-on-close.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const project = dirname(fileURLToPath(new URL('.', import.meta.url)));
const baseUrl = process.env.PLAYBACK_BASE_URL || 'http://localhost:3000';
const hostUrl = new URL(baseUrl);
hostUrl.port = '43129';
hostUrl.pathname = '/';
const apiBase = hostUrl.origin;
const session = randomBytes(32).toString('base64url');
const csrf = createHash('sha256').update(`${session}douyin-monitor-csrf-v1`).digest('hex');
execFileSync(join(project, '.venv', 'Scripts', 'python.exe'), ['-c', `
import hashlib, os, sys
sys.path.insert(0, os.environ["DOUYIN_PROJECT"])
from host_service.config import HostConfig
from host_service.database import Database
Database(HostConfig.from_env()).create_session(
    hashlib.sha256(os.environ["DOUYIN_SESSION"].encode()).hexdigest(),
    hashlib.sha256(os.environ["DOUYIN_CSRF"].encode()).hexdigest(), "127.0.0.1", 3600)
`], { stdio: 'inherit', env: { ...process.env, DOUYIN_PROJECT: project, DOUYIN_SESSION: session, DOUYIN_CSRF: csrf } });

const mediaDir = join(project, 'data', 'host-service', 'media');
const listMedia = async () => (await readdir(mediaDir).catch(() => [])).filter((n) => n.endsWith('.mp4'));
const profile = await mkdtemp(join(tmpdir(), 'douyin-real-playback-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: process.env.PLAYBACK_HEADLESS !== '0', viewport: { width: 1440, height: 1000 }, locale: 'zh-CN',
});
let holdPointer = false;
let pointerKeeper;
try {
  await context.addCookies([{ name: 'douyin_monitor_session', value: session,
    url: apiBase, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  await page.bringToFront();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('Video preview failed')) console.log('media warning:', message.text());
  });
  await page.addInitScript(() => {
    window.playbackLifecycle = [];
    for (const type of ['visibilitychange', 'loadstart', 'loadeddata', 'canplay', 'play', 'playing', 'pause', 'emptied', 'error']) {
      document.addEventListener(type, event => {
        if (type !== 'visibilitychange' && event.target?.tagName !== 'VIDEO') return;
        const video = event.target?.tagName === 'VIDEO' ? event.target : null;
        window.playbackLifecycle.push({ type, hidden: document.hidden, at: performance.now(),
          ...(video ? { ready: video.readyState, width: video.videoWidth, height: video.videoHeight,
            paused: video.paused, muted: video.muted, time: video.currentTime,
            quality: video.getVideoPlaybackQuality().totalVideoFrames } : {}) });
        if (type === 'loadstart') video?.requestVideoFrameCallback(() => {
          window.playbackLifecycle.push({ type: 'first-frame', at: performance.now(), ready: video.readyState });
        });
      }, true);
    }
  });
  const transfers = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const mediaRequests = new Set();
  const mediaStarts = [];
  const mediaEnds = [];
  const mediaTiming = new Map();
  let measuredVideoId = null;
  let sourceReadyAt = null;
  let receivedBytes = 0;
  cdp.on('Network.requestWillBeSent', ({requestId, request}) => {
    if (/\/api\/previews\/.+\/media/.test(request.url)) {
      mediaStarts.push({requestId, at:Date.now()});
      mediaTiming.set(requestId, {start:Date.now()});
    }
  });
  cdp.on('Network.loadingFailed', ({requestId, canceled}) => {
    if (mediaRequests.has(requestId)) mediaEnds.push({requestId, canceled, at:Date.now()});
  });
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    if (/\/api\/previews\/.+\/media/.test(response.url)) {
      mediaRequests.add(requestId);
      if (mediaTiming.has(requestId)) mediaTiming.get(requestId).headers = Date.now();
    }
  });
  cdp.on('Network.dataReceived', ({ requestId, encodedDataLength }) => {
    if (mediaRequests.has(requestId)) {
      receivedBytes += encodedDataLength;
      if (mediaTiming.has(requestId)) mediaTiming.get(requestId).firstBytes ||= Date.now();
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/api/previews/')) return;
    if (url.endsWith('/status') || url.endsWith('/prepare')) {
      void response.json().then(payload => {
        if (payload.status === 'ready' && payload.videoId === measuredVideoId
            || payload.sources?.some(source => source.status === 'ready' && source.videoId === measuredVideoId)) sourceReadyAt ||= Date.now();
      }).catch(() => {});
      return;
    }
    const headers = response.headers();
    transfers.push({ status: response.status(),
      length: Number(headers['content-length'] || 0),
      range: headers['content-range'] || null,
      exposed: headers['access-control-expose-headers'] || null });
  });
  const before = await listMedia();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.compactVideoRow').first().waitFor({ timeout: 40000 });
  if (process.env.PLAYBACK_ACCOUNT) {
    await page.locator('#workspace-rail-options button').filter({ hasText: process.env.PLAYBACK_ACCOUNT }).click();
    await page.locator('.compactVideoRow').first().waitFor();
  }
  if (process.env.PLAYBACK_FEED === 'discoveries') {
    await page.locator('.railDiscoveries').click();
    await page.locator('.compactVideoRow').first().waitFor();
  }
  const targetId = process.argv[2];
  const row = targetId ? page.locator(`[data-video-id="${targetId}"]`).first() : page.locator('.compactVideoRow').nth(Number(process.env.PLAYBACK_ROW_INDEX || 0));
  await row.waitFor({ timeout: 30000 });
  const title = await row.locator('.compactVideoCopy').first().innerText();
  console.log('first work:', title.slice(0, 40));
  const inspectedId = targetId || await row.getAttribute('data-video-id');
  const beforeSource = await page.evaluate(async ({apiBase, videoId}) => {
    return (await fetch(`${apiBase}/api/previews/${videoId}/status`, {credentials:'include'})).json();
  }, {apiBase,videoId:inspectedId});
  console.log('source before hover:', beforeSource.status);
  console.log('source before opening details:', JSON.stringify(beforeSource));
  if (process.env.PLAYBACK_EXPECT_COLD === '1') assert.equal(beforeSource.status, 'idle', 'cold acceptance requires an unresolved source');
  if (process.env.PLAYBACK_FROM_ROW_INDEX !== undefined) {
    await page.locator('.compactVideoRow').nth(Number(process.env.PLAYBACK_FROM_ROW_INDEX)).hover();
    await page.waitForFunction(() => {
      const v=document.querySelector('.siteVideoPlayer.isHover video');
      return v && !v.paused && v.currentTime > 0.3;
    }, null, {timeout:45000});
  }
  measuredVideoId = inspectedId;
  sourceReadyAt = null;
  mediaTiming.clear();
  await row.evaluate(row => {
    window.hoverEvents = [];
    const record = event => {
      const bounds = row.getBoundingClientRect();
      window.hoverEvents.push({ type: event.type, at: performance.now(), x: event.clientX,
        y: event.clientY, top: bounds.top, bottom: bounds.bottom,
        hasFocus:document.hasFocus(),relatedTarget:event.relatedTarget?.className,
        scrollTop: row.closest('.compactFeedScroll').scrollTop });
    };
    row.addEventListener('mouseenter', record);
    row.addEventListener('mouseleave', record);
    row.closest('.compactFeedScroll').addEventListener('scroll', record);
  });

  const started = Date.now();
  const directOpen = process.env.PLAYBACK_DIRECT_OPEN === '1';
  if (directOpen) {
    await page.locator('.compactFeedHeading').hover();
    await row.locator('.compactCoverButton').press('Enter');
  } else await row.locator('.compactCoverButton').hover();
  if (!directOpen && process.env.PLAYBACK_KEEP_HOVER === '1') {
    // CDP hover does not move the physical Windows cursor. Native window
    // notifications can restore that cursor's stale coordinates. Reassert the
    // same row position to model a user keeping the pointer on this card.
    const bounds = await row.boundingBox();
    assert.ok(bounds);
    holdPointer = true;
    pointerKeeper = (async () => {
      while (holdPointer) {
        await page.waitForTimeout(150);
        if (holdPointer) await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      }
    })().catch(error => { if (holdPointer) throw error; });
    console.log('holding the pointer on the target row during cold startup');
  }
  const diagnoseStartupFailure = async error => {
    console.log('startup failure diagnostics:', JSON.stringify(await page.evaluate(() => {
      const video = document.querySelector('.siteVideoPlayer video');
      return {hidden:document.hidden, player:document.querySelector('.siteVideoPlayer')?.className,
        src:video?.getAttribute('src'), currentSrc:video?.currentSrc, ready:video?.readyState,
        network:video?.networkState, error:video?.error?.code, paused:video?.paused,
        quality:video?.getVideoPlaybackQuality().totalVideoFrames,
        width:video?.videoWidth, height:video?.videoHeight,
        lifecycle:window.playbackLifecycle, hoverEvents:window.hoverEvents};
    })));
    console.log('startup network diagnostics:', JSON.stringify({sourceReadyAt, media:[...mediaTiming.values()]}));
    console.log('host status on failure:', JSON.stringify(await page.evaluate(async ({apiBase,videoId}) => {
      return (await fetch(`${apiBase}/api/previews/${videoId}/status`,{credentials:'include'})).json();
    }, {apiBase,videoId:inspectedId})));
    await page.screenshot({ path: join(project, 'outputs', `resize-failed-${inspectedId}.png`) });
    throw error;
  };
  await page.locator(`.siteVideoPlayer.${directOpen ? 'isOpen' : 'isHover'} video`).waitFor({ timeout: 40000 }).catch(diagnoseStartupFailure);
  const hoverShown = Date.now() - started;
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer video');
    return Boolean(video?.currentSrc) && video.readyState >= 2;
  }, null, { timeout: 40000 }).catch(diagnoseStartupFailure);
  const sourceBound = Date.now() - started;
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer video');
    return video && !video.paused && video.currentTime > 0;
  }, null, { timeout: 40000 }).catch(diagnoseStartupFailure);
  const playing = Date.now() - started;
  holdPointer = false;
  if (pointerKeeper) await pointerKeeper;
  const media = await page.evaluate(() => {
    const video = document.querySelector('.siteVideoPlayer video');
    return { src: video.currentSrc, width: video.videoWidth, height: video.videoHeight,
      duration: Math.round(video.duration * 10) / 10, currentTime: Math.round(video.currentTime * 10) / 10 };
  });
  console.log('resolved source:', JSON.stringify(media));
  const sourceMetadata = await page.evaluate(async ({apiBase,videoId}) => {
    const response = await fetch(`${apiBase}/api/previews/${videoId}/status`, { credentials: 'include' });
    if (!response.ok) throw new Error(`preview status HTTP ${response.status}`);
    return response.json();
  }, {apiBase,videoId:inspectedId});
  console.log('resolved codec:', sourceMetadata.codec);
  console.log('verified audio codec:', sourceMetadata.audioCodec);
  assert.ok(sourceMetadata.audioCodec, 'a fully playable source must contain a verified audio track');
  console.log('host preparation phases (ms):', JSON.stringify({
    resolve: sourceMetadata.resolveDurationMs, probe: sourceMetadata.probeDurationMs,
    attempts: sourceMetadata.probeAttempts,
  }));
  if (process.env.PLAYBACK_EXPECTED_CODEC) assert.equal(sourceMetadata.codec, process.env.PLAYBACK_EXPECTED_CODEC);
  console.log(`timing: ${directOpen ? 'open' : 'hover'} ${hoverShown} ms, metadata ${sourceBound} ms, playing ${playing} ms`);
  console.log('startup phases (ms after hover):', JSON.stringify({
    sourceReady: sourceReadyAt ? sourceReadyAt - started : null,
    media: [...mediaTiming.values()].map(item => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, value-started]))),
  }));

  if (!directOpen) await row.locator('.compactCoverButton').click();
  await page.locator('.siteVideoPlayer.isOpen video').waitFor({ timeout: 10000 });
  await page.waitForTimeout(4000);
  const afterPlay = await page.evaluate(() => {
    const video = document.querySelector('.siteVideoPlayer video');
    return { currentTime: Math.round(video.currentTime * 10) / 10, paused: video.paused,
      muted: video.muted, playbackRate: video.playbackRate };
  });
  console.log('after 4 s of small-window playback:', JSON.stringify(afterPlay));
  if (afterPlay.paused || afterPlay.muted) console.log('playback diagnostics:', JSON.stringify(await page.evaluate(() => ({
    hidden: document.hidden, player: document.querySelector('.siteVideoPlayer')?.className,
    src: document.querySelector('.siteVideoPlayer video')?.getAttribute('src'), lifecycle: window.playbackLifecycle,
  }))));
  assert.ok(afterPlay.currentTime > media.currentTime && !afterPlay.paused && !afterPlay.muted, 'clicked playback must continue with sound');
  const audioRms = await page.locator('.siteVideoPlayer video').evaluate(async video => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    context.createMediaElementSource(video).connect(analyser);
    analyser.connect(context.destination);
    await context.resume();
    const samples = new Float32Array(analyser.fftSize);
    let rms = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      analyser.getFloatTimeDomainData(samples);
      rms = Math.max(rms, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
    }
    return rms;
  });
  console.log('decoded audio RMS:', audioRms);
  assert.ok(audioRms > 0.0001, 'actual decoded audio must contain a nonzero signal');
  const beforeDrag = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  const handle = await page.getByRole('button', { name: '拖动播放窗口' }).boundingBox();
  await page.locator('.siteVideoPlayer video').evaluate(video => { window.dragMediaElement = video; });
  await page.mouse.move(handle.x + 40, handle.y + 15);
  await page.mouse.down();
  await page.mouse.move(handle.x - 140, handle.y - 65, { steps: 8 });
  await page.mouse.up();
  const afterDrag = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  assert.ok(Math.abs(afterDrag.x - beforeDrag.x + 180) < 3 && Math.abs(afterDrag.y - beforeDrag.y + 80) < 3,
    'the real player window must move with the title bar');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => window.dragMediaElement === video && !video.paused && !video.muted), true,
    'dragging preserves the same playing media element');
  const resize = await page.getByRole('button', { name: '缩放播放窗口（左上角）' }).boundingBox();
  await page.mouse.move(resize.x + 7, resize.y + 7);
  await page.mouse.down();
  await page.mouse.move(resize.x - 93, resize.y - 53, { steps: 8 });
  await page.mouse.up();
  const enlarged = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  assert.ok(enlarged.width > afterDrag.width + 80 && enlarged.height > afterDrag.height + 40,
    'the real playing window can be enlarged');
  await page.getByRole('button', { name: '缩放播放窗口（右下角）' }).press('ArrowLeft');
  assert.ok(Math.abs((await page.locator('.siteVideoPlayer.isOpen').boundingBox()).width - enlarged.width + 20) < 3,
    'the same window can also be reduced');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => window.dragMediaElement === video && !video.paused && !video.muted), true,
    'resizing preserves the playing media element and sound');
  assert.ok(await page.locator('.siteVideoPlayer.isOpen').evaluate(player => {
    const rect = player.getBoundingClientRect();
    const close = player.querySelector('.siteVideoClose').getBoundingClientRect();
    const closeIcon = player.querySelector('.siteVideoClose svg').getBoundingClientRect();
    const grip = player.querySelector('.siteVideoGrip').getBoundingClientRect();
    return close.width > 60 && closeIcon.width === 20 && closeIcon.height === 20 && close.top >= rect.top && close.bottom <= rect.bottom
      && close.right <= rect.right && rect.right <= innerWidth && rect.bottom <= innerHeight && grip.height === 24;
  }), 'the close button stays in the visible window and icons use their intended sizes');
  if (process.env.PLAYBACK_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PLAYBACK_SCREENSHOT_PATH });

  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.tagName === 'VIDEO');
  await page.evaluate(() => document.exitFullscreen());

  // Seek forward: the host must serve the new range without downloading the
  // skipped part of the work.
  const beforeSeek = receivedBytes;
  const seekTarget = await page.locator('.siteVideoPlayer video').evaluate((video) => {
    video.currentTime = Math.min(120, video.duration - 5);
    return video.currentTime;
  });
  await page.waitForFunction((target) => {
    const video = document.querySelector('.siteVideoPlayer video');
    return Math.abs(video.currentTime - target) < 3 && video.readyState >= 2 && !video.paused && !video.seeking;
  }, seekTarget, { timeout: 30000 }).catch(async (error) => {
    console.log('seek diagnostics:', await page.locator('.siteVideoPlayer video').evaluate(v => ({
      time: v.currentTime, ready: v.readyState, paused: v.paused, seeking: v.seeking,
      error: v.error?.code, buffered: Array.from({length:v.buffered.length}, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
    })));
    throw error;
  });
  const seeked = await page.locator('.siteVideoPlayer video').evaluate((video) => Math.round(video.currentTime));
  const afterSeek = receivedBytes;
  console.log(`seek to ${seeked}s served ${((afterSeek - beforeSeek) / 1048576).toFixed(2)} MiB more in ${transfers.length} responses`);

  const beforeClose = receivedBytes;
  await page.getByRole('button', { name: '关闭视频' }).click();
  const closedAt = Date.now();
  const afterClickState = await page.locator('.siteVideoPlayer video').evaluate(v => ({paused:v.paused, srcAttribute:v.getAttribute('src')}));
  await page.waitForTimeout(1000);
  const settledBytes = receivedBytes;
  await page.waitForTimeout(1000);
  const afterClose = receivedBytes;
  console.log(`closed; ${((afterClose - beforeClose) / 1048576).toFixed(2)} MiB after close; total received ${(afterClose / 1048576).toFixed(2)} MiB`);

  const after = await listMedia();
  console.log('media files before/after:', before.length, after.length);
  console.log('total preview responses:', transfers.length,
    'statuses:', JSON.stringify([...new Set(transfers.map((item) => item.status))]));
  console.log('page errors:', JSON.stringify(errors));
  assert.deepEqual(errors, [], 'live playback must have no page errors');
  assert.deepEqual(after, before, 'live playback must not persist media');
  console.log('close diagnostics:', JSON.stringify({afterClickState, startsAfterClose:mediaStarts.filter(r => r.at > closedAt), mediaEnds, settledBytesAfterClose:afterClose-settledBytes}));
  assert.equal(afterClickState.srcAttribute, null, 'closing must remove the source attribute');
  assert.equal(mediaStarts.filter(r => r.at > closedAt).length, 0, 'closing must not start another media request');
  assert.equal(afterClose - settledBytes, 0, 'media transfer must stop after cancellation settles');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate(v => v.paused), true, 'closed media must be paused');
  assert.ok(transfers.some(item => item.status === 206), 'live playback must use ranges');
  console.log(`Live playback passed: ${directOpen ? 'direct cold opening' : 'hover'}, decoded audio, drag/resize continuity, visible close button, continuous click playback, fullscreen, seek, close, Range and no persistent media.`);
  console.log('sample responses:', JSON.stringify(transfers.slice(0, 6)));
} finally {
  holdPointer = false;
  if (pointerKeeper) await pointerKeeper.catch(() => {});
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
