import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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

function movedScroll(row, click = false) {
  const scroller = row.closest('.compactFeedScroll');
  // The short fixture need not overflow. Model a changed scroll position while
  // dispatching its event; restore the native property immediately afterward.
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: scroller.scrollTop + 1 });
  scroller.dispatchEvent(new Event('scroll'));
  delete scroller.scrollTop;
  if (click) row.querySelector('.compactCoverButton').click();
}

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
  await context.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      if (/codecs="(?:hvc1|hev1)"/.test(type)) return '';
      return original.call(this, type);
    };
  });
  await context.route('http://localhost:43129/**', async (route) => {
    const target = new URL(route.request().url());
    target.hostname = '127.0.0.1';
    target.port = String(port);
    const response = await route.fetch({ url: target.href });
    if (target.pathname === '/api/previews/prepare' || /\/api\/previews\/.+\/status$/.test(target.pathname)) {
      const payload = await response.json();
      // Deliberately mismatched metadata checks that a coarse codec label never
      // gates the decoder. The fixture bytes remain H.264; real HEVC is tested separately.
      if (payload.sources) payload.sources.forEach(source => { source.codec = 'hevc'; });
      else if (payload.status === 'ready') payload.codec = 'hevc';
      await route.fulfill({ response, json: payload });
    } else if (target.pathname === '/api/state') {
      const payload = await response.json();
      // Exercise real zero, missing counts and long copy without touching the host records.
      for (const video of payload.videos || []) {
        if (video.id === '1234567890123456700') Object.assign(video, {
          authorName: '播放测试作者', likeCount: 12345, commentCount: 0, favoriteCount: null, shareCount: 67,
          description: '完整视频文案与话题 #预览测试\n'.repeat(40),
        });
        if (video.id === '1234567890123456701') video.authorName = '切换测试作者';
      }
      await route.fulfill({ response, json: payload });
    } else await route.fulfill({ response });
  });
  await context.addCookies([{ name: 'douyin_monitor_session', value: cookie,
    url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const preparedRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/previews/prepare') preparedRequests.push(Date.now());
  });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  const rows = page.locator('.compactVideoRow');
  await rows.first().waitFor({ timeout: 25000 });
  assert.equal(await rows.count(), 3, 'the fixture list shows three works');
  assert.match(await page.locator('.compactFeedHeading').innerText(), /共 3 条/);
  // No local download state may gate playback any more.
  assert.equal(await page.locator('.compactCoverPending').count(), 0, 'no work waits for a download');
  assert.equal(preparedRequests.length, 0, 'listing alone never resolves or prefetches a video');

  const started = Date.now();
  // Reading text exposes inline data without preparing media. Only a cover
  // hover resolves a source, with no click or hover intent timer.
  await rows.first().locator('.compactVideoCopy').hover();
  assert.equal(preparedRequests.length, 0, 'hovering text never resolves video media');
  await rows.first().evaluate(row => {
    row.querySelector('.compactCoverButton').addEventListener('mouseenter', () => { window.hoverStartedAt = Date.now(); }, { once: true });
  });
  await rows.first().locator('.compactCoverButton').hover();
  await page.waitForFunction(() => document.querySelector('.compactCoverPending')?.textContent === '正在加载');
  const hoverStartedAt = await page.evaluate(() => window.hoverStartedAt);
  assert.ok(preparedRequests[0] - hoverStartedAt < 120,
    `prepare starts immediately on mouse enter (${preparedRequests[0] - hoverStartedAt} ms)`);
  await rows.first().evaluate(row => row.closest('.compactFeedScroll').dispatchEvent(new Event('scroll')));
  await page.locator('.siteVideoPlayer.isHover video').waitFor({ timeout: 20000 });
  const hoverShownMs = Date.now() - started;
  assert.ok(await page.locator('.siteVideoPlayer.isHover video').evaluate(video => video.readyState >= 2),
    'hover replaces the cover only once a frame is available');
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

  // Clicking the cover promotes the hovering preview into the viewing window
  // without restarting the media element.
  await rows.first().locator('.compactCoverButton').click();
  await page.locator('.siteVideoPlayer.isOpen video').waitFor({ timeout: 10000 });
  const clicked = await page.locator('.siteVideoPlayer video').evaluate((video) => ({
    time: video.currentTime, paused: video.paused, muted: video.muted, src: video.currentSrc }));
  assert.ok(clicked.time >= hoverTime - 0.6, 'clicking keeps the hover position instead of restarting');
  assert.ok(!clicked.paused && !clicked.muted, 'the viewing window continues with sound');
  const details = page.locator('.siteVideoDetails');
  assert.equal(await page.locator('.siteVideoHeader strong').innerText(), '测试作品 1');
  assert.deepEqual(await details.locator('dt').allTextContents(), ['点赞', '评论', '收藏', '分享']);
  assert.deepEqual(await details.locator('dd').allTextContents(), ['12,345', '0', '—', '67'],
    'the playing work exposes exact counts and distinguishes zero from missing data');
  assert.match(await details.getByRole('link', { name: '打开原视频' }).getAttribute('href'), /1234567890123456700$/);
  assert.ok(await page.locator('.siteVideoPlayer.isOpen').evaluate(player => {
    const stage = player.querySelector('.siteVideoStage').getBoundingClientRect();
    const details = player.querySelector('.siteVideoDetails').getBoundingClientRect();
    const box = player.getBoundingClientRect();
    return details.left >= stage.right - 1 && details.width <= 80
      && [...player.querySelectorAll('.siteVideoStats dd')].every(metric => {
        const rect = metric.getBoundingClientRect();
        return rect.top >= box.top && rect.bottom <= box.bottom;
      });
  }), 'a narrow side rail leaves space for video and keeps all counts visible');
  await mkdir(join(project, 'artifacts', 'detail-hover'), { recursive: true });
  await page.locator('.siteVideoPlayer.isOpen').screenshot({ path: join(project, 'artifacts', 'detail-hover', 'playback-desktop.png') });
  const beforeDrag = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  await page.locator('.siteVideoPlayer video').evaluate(video => { window.dragMediaElement = video; });
  const handle = await page.getByRole('button', { name: '拖动播放窗口' }).boundingBox();
  await page.mouse.move(handle.x + 45, handle.y + 12);
  await page.mouse.down();
  await page.mouse.move(handle.x - 175, handle.y - 108, { steps: 8 });
  await page.mouse.up();
  const afterDrag = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  assert.ok(Math.abs(afterDrag.x - (beforeDrag.x - 220)) < 3 && Math.abs(afterDrag.y - (beforeDrag.y - 120)) < 3,
    'the title bar moves the window freely');
  assert.ok(await page.locator('.siteVideoPlayer video').evaluate(video => window.dragMediaElement === video && !video.paused && !video.muted),
    'dragging preserves the same playing media element and sound');
  assert.equal(preparedRequests.length, 1, 'dragging never resolves another source');
  await page.getByRole('button', { name: '拖动播放窗口' }).press('ArrowLeft');
  assert.ok(Math.abs((await page.locator('.siteVideoPlayer.isOpen').boundingBox()).x - afterDrag.x + 12) < 3,
    'the focused title bar also supports keyboard movement');
  const beforeResize = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  const resizeHandle = await page.getByRole('button', { name: '缩放播放窗口（左上角）' }).boundingBox();
  await page.mouse.move(resizeHandle.x + 7, resizeHandle.y + 7);
  await page.mouse.down();
  await page.mouse.move(resizeHandle.x - 143, resizeHandle.y - 93, { steps: 8 });
  await page.mouse.up();
  const grown = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  assert.ok(grown.width > beforeResize.width + 120 && grown.height > beforeResize.height + 80,
    'the upper-left corner enlarges a window initially anchored at the lower-right');
  assert.ok(Math.abs(grown.x + grown.width - beforeResize.x - beforeResize.width) < 3
    && Math.abs(grown.y + grown.height - beforeResize.y - beforeResize.height) < 3,
    'resizing keeps the opposite corner anchored');
  const shrinkHandle = await page.getByRole('button', { name: '缩放播放窗口（右下角）' }).boundingBox();
  await page.mouse.move(shrinkHandle.x + 7, shrinkHandle.y + 7);
  await page.mouse.down();
  await page.mouse.move(grown.x + 20, grown.y + 20, { steps: 8 });
  await page.mouse.up();
  const shrunk = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  assert.ok(Math.abs(shrunk.width - 360) < 3 && Math.abs(shrunk.height - 280) < 3,
    `minimum size leaves room for the close button and playback controls: ${JSON.stringify(shrunk)}`);
  await page.getByRole('button', { name: '缩放播放窗口（右下角）' }).press('Shift+ArrowRight');
  assert.ok(Math.abs((await page.locator('.siteVideoPlayer.isOpen').boundingBox()).width - shrunk.width - 50) < 3);
  assert.ok(await page.locator('.siteVideoPlayer video').evaluate(video => window.dragMediaElement === video && !video.paused && !video.muted && video.currentTime > 0),
    'enlarging and shrinking preserve playback and sound');
  assert.equal(preparedRequests.length, 1, 'resizing never resolves or loads another source');
  assert.ok(await page.locator('.siteVideoPlayer.isOpen').evaluate(player => {
    const box = player.getBoundingClientRect();
    return ['.siteVideoClose', '.siteVideoFullscreen', '.siteVideoPlay'].every(selector => {
      const button = player.querySelector(selector);
      const rect = button.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20 && rect.left >= box.left && rect.right <= box.right
        && rect.top >= box.top && rect.bottom <= box.bottom;
    }) && player.querySelector('.siteVideoGrip').getBoundingClientRect().height === 24;
  }), 'all controls and correctly sized icons stay inside the resized window');
  assert.ok(await page.locator('.siteVideoPlayer.isOpen').evaluate(player => {
    const stage = player.querySelector('.siteVideoMediaColumn').getBoundingClientRect();
    const details = player.querySelector('.siteVideoDetails').getBoundingClientRect();
    const body = player.querySelector('.siteVideoBody');
    return details.left >= stage.right - 1 && details.width <= 80
      && body.scrollWidth <= body.clientWidth + 1;
  }), 'a compact resized window keeps data beside the video without horizontal overflow');
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.tagName === 'VIDEO');
  await page.evaluate(() => document.exitFullscreen());
  await page.getByLabel('倍速').selectOption('1.5');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.playbackRate), 1.5);
  await page.getByLabel('音量').fill('0.5');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.volume), 0.5);
  await page.waitForTimeout(4500);
  const afterRefresh = await page.locator('.siteVideoPlayer video').evaluate((video) => video.currentTime);
  assert.ok(afterRefresh > clicked.time + 2, 'the list refresh does not reset playback');

  // Hovering another card must not steal playback from an open viewing window.
  await rows.nth(1).hover({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.siteVideoPlayer.isHover').count(), 0, 'hover cannot replace an open player');
  assert.equal(await page.locator('.siteVideoPlayer video').count(), 1, 'only one media element exists');
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.currentSrc), clicked.src);
  assert.deepEqual(await details.locator('dd').allTextContents(), ['12,345', '0', '—', '67'],
    'hovering other text cannot replace the playing video data');

  // A different work plays from its own source generation.
  let releaseSecondPrepare;
  const secondPrepareGate = new Promise(resolve => { releaseSecondPrepare = resolve; });
  await context.route('http://localhost:43129/api/previews/prepare', async route => {
    if (route.request().postData()?.includes('1234567890123456701')) await secondPrepareGate;
    await route.fallback();
  });
  await rows.nth(1).locator('.compactCoverButton').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video?.paused && video.readyState === 0 && !video.getAttribute('src');
  }, null, { timeout: 5000 });
  assert.ok(await page.locator('.siteVideoLoading').isVisible(), 'switching waits for the new target without playing the previous work');
  assert.equal(await page.locator('.siteVideoHeader strong').innerText(), '测试作品 2');
  assert.deepEqual(await details.locator('dd').allTextContents(), ['1', '0', '0', '0'],
    'author, copy and counts switch together with the requested video');
  releaseSecondPrepare();
  await context.unroute('http://localhost:43129/api/previews/prepare');
  await page.waitForFunction((previous) => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video?.currentSrc.includes('/api/previews/') && video.currentSrc !== previous && video.currentTime > 0;
  }, clicked.src, { timeout: 20000 });
  assert.equal(await page.locator('.siteVideoPlayer video').count(), 1, 'only one media element may play');

  const beforeClose = await fixtureState();
  await page.getByRole('button', { name: '关闭视频' }).click();
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate((video) => video.paused), true);
  await page.waitForTimeout(1500);
  const afterClose = await fixtureState();
  const servedAfterClose = afterClose.bytesServed - beforeClose.bytesServed;
  assert.ok(servedAfterClose < 2_000_000,
    `closing must stop reading the source (served ${servedAfterClose} more bytes)`);

  // A previous frame must not make a reopened hover visible before new data.
  await page.locator('.compactFeedHeading').hover();
  await rows.nth(1).locator('.compactCoverButton').hover();
  await page.locator('.siteVideoPlayer.isHover video').waitFor({ timeout: 20000 });
  assert.ok(await page.locator('.siteVideoPlayer.isHover video').evaluate(video => !video.paused && video.readyState >= 2),
    'reopening the same work waits for a playable frame');
  await rows.nth(1).evaluate(movedScroll);
  await page.waitForFunction(() => !document.querySelector('.siteVideoPlayer.isHover'));
  const bounds = await rows.nth(1).locator('.compactCoverButton').boundingBox();
  await page.mouse.move(bounds.x + 10, bounds.y + 10);
  await page.locator('.siteVideoPlayer.isHover video').waitFor({ timeout: 10000 });
  assert.equal(preparedRequests.length, 2, 'movement after scroll resumes from prepared sources');
  // Scrolling cancels a hover imperatively. A click in the same event turn must
  // restore that source even if React batches both updates for the same work.
  await rows.nth(1).evaluate(movedScroll, true);
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video && !video.paused && !video.muted && video.readyState >= 2 && video.currentTime > 0;
  }, null, { timeout: 10000 });
  await page.getByRole('button', { name: '关闭视频' }).click({ force: true });
  await page.locator('.compactFeedHeading').hover();
  await page.waitForFunction(() => !document.querySelector('.siteVideoPlayer.isHover'));

  await ask('RESET_PREVIEWS');
  await rows.nth(1).locator('.compactCoverButton').hover();
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isHover video');
    return video && !video.paused && video.currentTime > 0.1;
  }, null, { timeout: 15000 });
  assert.equal(preparedRequests.length, 3, 'an expired generation refreshes the same target once');
  await page.locator('.compactFeedHeading').hover();

  // Open the untouched third work from the keyboard, with the pointer away
  // from every cover. This must resolve, load and play with actual audio.
  const beforeDirectOpen = preparedRequests.length;
  await rows.nth(2).locator('.compactCoverButton').press('Enter');
  await page.locator('.siteVideoPlayer.isOpen .siteVideoLoading').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video?.currentSrc.includes('/1234567890123456702/') && !video.paused && !video.muted && video.currentTime > 0;
  }, null, { timeout: 15000 });
  assert.equal(preparedRequests.length, beforeDirectOpen + 1, 'direct opening loads an untouched work without hover');
  const audioSignal = await page.locator('.siteVideoPlayer video').evaluate(async video => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    context.createMediaElementSource(video).connect(analyser);
    analyser.connect(context.destination);
    await context.resume();
    const samples = new Float32Array(analyser.fftSize);
    let rms = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      analyser.getFloatTimeDomainData(samples);
      rms = Math.max(rms, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
    }
    return rms;
  });
  assert.ok(audioSignal > 0.001, `the player must decode real audible samples, RMS=${audioSignal}`);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '静音', exact: true }).click();
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.paused && video.muted), true,
    'muting a paused work must not restart playback');
  await page.getByRole('button', { name: '开启声音', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByRole('button', { name: '静音', exact: true }).click();
  const mutedGeneration = await page.locator('.siteVideoPlayer video').evaluate(video => video.currentSrc);
  await ask('RESET_PREVIEWS');
  await page.locator('.siteVideoPlayer video').evaluate(video => video.load());
  await page.waitForFunction(oldSource => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video && video.currentSrc !== oldSource && !video.paused && video.currentTime > 0.1;
  }, mutedGeneration, { timeout: 15000 });
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.muted), true,
    'recovering an expired source must preserve the user mute choice');
  await page.getByRole('button', { name: '开启声音', exact: true }).click();
  const beforeModuleTime = await page.locator('.siteVideoPlayer video').evaluate(video => video.currentTime);
  await page.getByRole('button', { name: '微信读取', exact: true }).click();
  await page.waitForFunction(() => { const v = document.querySelector('.siteVideoPlayer video'); return v && v.paused && !v.getAttribute('src'); });
  await page.getByRole('button', { name: '内容情报台', exact: true }).click();
  await page.waitForFunction(time => { const v = document.querySelector('.siteVideoPlayer video'); return v && v.readyState >= 1 && v.paused && Math.abs(v.currentTime-time) < 1; }, beforeModuleTime);
  assert.equal(await page.locator('.siteVideoPlayer video').evaluate(video => video.paused), true, 'module return never auto plays');
  const movedHandle = await page.getByRole('button', { name: '拖动播放窗口' }).boundingBox();
  await page.mouse.move(movedHandle.x + 30, movedHandle.y + 15);
  await page.mouse.down();
  await page.mouse.move(0, 0, { steps: 5 });
  await page.mouse.up();
  const boundedWindow = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  assert.ok(boundedWindow.x >= 7 && boundedWindow.y >= 7, 'dragging cannot strand the close button off screen');
  await page.setViewportSize({ width: 700, height: 600 });
  await page.waitForTimeout(150);
  const resizedWindow = await page.locator('.siteVideoPlayer.isOpen').boundingBox();
  assert.ok(resizedWindow.x >= 7 && resizedWindow.y >= 7 && resizedWindow.x + resizedWindow.width <= 693 && resizedWindow.y + resizedWindow.height <= 593,
    'the window stays accessible after viewport resize');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '关闭视频' }).click();

  // Link submission is mocked only at the paid-analysis boundary. Registration,
  // state refresh and protected Range streaming run against the isolated host.
  let linkSubmissions = 0;
  await context.route('http://localhost:43129/api/video-links/analyze', async route => {
    const id = JSON.parse(route.request().postData()).shareText.match(/\d{19}/)?.[0];
    assert.ok(['1234567890123456703', '1234567890123456704'].includes(id));
    linkSubmissions++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: await ask(`LINK:${id}`) });
  });
  await page.getByRole('button', { name: '链接分析', exact: true }).click();
  const beforeLinkPrepare = preparedRequests.length;
  await page.getByLabel('抖音视频分享链接或分享文案').fill('https://www.douyin.com/video/1234567890123456703');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isInline video');
    return video?.currentSrc.includes('/1234567890123456703/') && !video.paused && !video.muted && video.currentTime > 0;
  }, null, { timeout: 20000 });
  assert.equal(await page.getByRole('dialog').count(), 0, 'submission keeps playback and results on the page');
  assert.ok(await page.locator('.linkPreview > .previewVideoMetrics').isVisible(),
    'link analysis shows the video counts beside playback without expanding metadata');
  assert.equal(await page.locator('.linkPreview > .previewVideoMetrics dd').count(), 4);
  assert.equal(preparedRequests.length, beforeLinkPrepare + 1, 'a cold link prepares immediately without hovering');
  assert.match(await page.getByRole('tabpanel', { name: '内容分析' }).innerText(), /等待内容分析结果/);
  await page.locator('.siteVideoPlayer video').evaluate(video => { window.linkMediaElement = video; });
  await page.getByRole('tab', { name: '口播稿', exact: true }).click();
  await ask('TRANSCRIPT:1234567890123456703');
  await page.getByRole('tabpanel', { name: '口播稿' }).getByText(/隔离口播结果/).waitFor({ timeout: 12000 });
  assert.ok(await page.locator('.siteVideoPlayer video').evaluate(video => video === window.linkMediaElement && !video.paused),
    'an intermediate transcript updates without replacing the media element');
  if (await page.getByRole('button', { name: '播放', exact: true }).count()) {
    await page.getByRole('button', { name: '播放', exact: true }).click();
  }
  await ask('COMPLETE:1234567890123456703');
  await page.getByRole('tab', { name: '内容分析', exact: true }).click();
  await page.getByRole('tabpanel', { name: '内容分析' }).getByText(/隔离内容结果/).waitFor({ timeout: 12000 });
  assert.match(await page.getByRole('tabpanel', { name: '内容分析' }).innerText(), /具体信息示例[\s\S]*补充解释示例[\s\S]*适用范围示例/);
  await page.getByRole('tab', { name: '制作规范', exact: true }).click();
  assert.equal(await page.getByRole('tabpanel').getByRole('heading', { level: 3 }).count(), 8,
    'all production sections are readable beside playback');
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.locator('.siteVideoPlayer.isInline').evaluate(player => player.scrollIntoView({ block: 'start' }));
  const inlineBounds = await page.locator('.siteVideoPlayer.isInline').boundingBox();
  const headingBounds = await page.locator('.topbar').boundingBox();
  assert.ok(inlineBounds.y >= headingBounds.y + headingBounds.height && inlineBounds.y + inlineBounds.height <= 600,
    'the inline player stays below the sticky heading and keeps controls visible in a short viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await page.locator('.siteVideoPlayer video').evaluate(video => video === window.linkMediaElement),
    'completion and tab changes never remount the playing video');
  assert.equal(preparedRequests.length, beforeLinkPrepare + 1, 'results refresh never starts another source resolution');

  await page.getByLabel('抖音视频分享链接或分享文案').fill('分享文案 https://www.douyin.com/video/1234567890123456704');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isInline video');
    return video?.currentSrc.includes('/1234567890123456704/') && !video.paused && !video.muted && video.currentTime > 0;
  }, null, { timeout: 20000 });
  assert.equal(preparedRequests.length, beforeLinkPrepare + 2, 'a second uncached link uses its own source');
  assert.equal(await page.locator('video').count(), 1, 'switching links leaves only one player');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('tab', { name: '口播稿', exact: true }).click();
  await page.waitForTimeout(4400);
  assert.ok(await page.locator('video').evaluate(video => video.paused), 'refresh and result tabs preserve a user pause');
  await page.getByLabel('抖音视频分享链接或分享文案').fill('https://www.douyin.com/video/1234567890123456703');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await page.getByRole('button', { name: '这条视频已有完整分析，已复用历史结果，点击关闭提示', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isInline video');
    return video?.currentSrc.includes('/1234567890123456703/') && !video.paused && video.currentTime > 0;
  }, null, { timeout: 20000 });
  assert.equal(linkSubmissions, 3, 'two new submissions and one historical reuse make no duplicate analysis submissions');
  assert.equal(await page.getByRole('dialog').count(), 0, 'historical reuse also keeps the player on the page');
  let failedPrepares = 0;
  await context.route('http://localhost:43129/api/previews/prepare', async route => {
    if (!route.request().postData()?.includes('1234567890123456704')) return route.fallback();
    failedPrepares++;
    await route.fulfill({ status: 200, contentType: 'application/json', json: { sources: [
      { videoId: '1234567890123456704', status: 'error', generation: '', message: '隔离取址失败' },
    ] } });
  });
  await page.getByRole('button', { name: /^链接测试作品 4 / }).click();
  await page.waitForTimeout(4400);
  assert.equal(failedPrepares, 1, 'state refresh must not repeatedly resolve a failed inline source');
  await context.unroute('http://localhost:43129/api/previews/prepare');
  await page.getByRole('button', { name: '内容浏览', exact: true }).click();
  assert.equal(await page.locator('.siteVideoPlayer.isInline').count(), 0, 'leaving link analysis removes its stream');
  console.log('Link playback passed: two cold submissions, playback during processing, intermediate transcript, full three-part results, stable source on refresh, exclusive switching, pause preservation, historical reuse and bounded failure retries.');

  // Play promise failures have distinct meanings. These are injected only into
  // the isolated fixture page; browser permissions and real host data stay intact.
  await rows.first().locator('.compactCoverButton').press('Enter');
  await page.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video && !video.paused && video.currentTime > 0;
  }, null, { timeout: 15000 });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    window.fixturePlayFailure = '';
    window.restoreFixturePlay = () => { HTMLMediaElement.prototype.play = original; };
    HTMLMediaElement.prototype.play = function () {
      const name = window.fixturePlayFailure;
      if (name === 'deferred') {
        window.fixturePlayFailure = '';
        return new Promise((_, reject) => {
          window.rejectStalePlay = () => reject(new DOMException('isolated old play', 'NotAllowedError'));
        });
      }
      if (name) return Promise.reject(new DOMException('isolated play failure', name));
      return original.call(this);
    };
  });
  await page.evaluate(() => { window.fixturePlayFailure = 'AbortError'; });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.siteVideoPlayer p[role="status"]').count(), 0,
    'an interrupted play must not be reported as a browser block');
  await page.evaluate(() => { window.fixturePlayFailure = 'NotAllowedError'; });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByText('浏览器限制了自动播放，请点击播放', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixturePlayFailure = 'NotSupportedError'; });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByText('视频加载或解码失败，请重新打开视频', { exact: true }).waitFor();
  assert.equal(await page.getByText('浏览器限制了自动播放，请点击播放', { exact: true }).count(), 0,
    'source/decoder failures must not be labelled as permission failures');
  await page.evaluate(() => { window.fixturePlayFailure = ''; });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.siteVideoPlayer video').paused);
  await page.locator('.siteVideoPlayer p[role="status"]').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.siteVideoPlayer p[role="status"]').count(), 0,
    'successful real playback clears the previous error');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const oldPlaySource = await page.locator('.siteVideoPlayer video').getAttribute('src');
  await page.evaluate(() => { window.fixturePlayFailure = 'deferred'; });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForFunction(() => typeof window.rejectStalePlay === 'function');
  await page.evaluate(() => window.restoreFixturePlay());
  await rows.nth(1).locator('.compactCoverButton').press('Enter');
  await page.waitForFunction(oldSource => {
    const video = document.querySelector('.siteVideoPlayer.isOpen video');
    return video && video.getAttribute('src') !== oldSource && !video.paused && video.currentTime > 0;
  }, oldPlaySource, { timeout: 15000 });
  await page.evaluate(() => window.rejectStalePlay());
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.siteVideoPlayer p[role="status"]').count(), 0,
    'a late failure from the old source cannot overwrite the new player');
  await page.getByRole('button', { name: '关闭视频' }).click();
  console.log('Playback errors passed: abort, permission, source/decoder failure, successful retry and stale promise isolation.');

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
    return video && video.currentSrc.includes('/api/previews/') && !video.paused && !video.muted && video.volume > 0 && video.currentTime > 0;
  }, null, { timeout: 20000 });
  for (const width of [390, 320]) {
    await mobile.setViewportSize({ width, height: 844 });
    await mobile.locator('.siteVideoStats').scrollIntoViewIfNeeded();
    assert.ok(await mobile.locator('.siteVideoPlayer.isOpen').evaluate(player => {
      const body = player.querySelector('.siteVideoBody');
      const box = player.getBoundingClientRect();
      return box.left >= 7 && box.right <= innerWidth - 7 && body.scrollWidth <= body.clientWidth + 1
        && [...player.querySelectorAll('.siteVideoStats dd')].every(metric => {
          const rect = metric.getBoundingClientRect();
          return rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom;
        });
    }), `all four interaction counts remain readable at ${width}px`);
    await mobile.locator('.siteVideoPlayer.isOpen').screenshot({ path: join(project, 'artifacts', 'detail-hover', `playback-${width}.png`) });
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.getByRole('button', { name: '关闭视频' }).tap({ force: true });
  await mobile.getByRole('button', { name: '链接分析', exact: true }).tap();
  await mobile.waitForFunction(() => {
    const video = document.querySelector('.siteVideoPlayer.isInline video');
    return video && !video.paused && !video.muted && video.currentTime > 0;
  }, null, { timeout: 20000 });
  await mobile.getByRole('tab', { name: '口播稿', exact: true }).tap();
  assert.ok(await mobile.getByRole('tabpanel', { name: '口播稿' }).isVisible(), 'link results are accessible on a narrow screen');
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'link playback and result tabs fit a narrow screen');
  await mobile.getByRole('button', { name: '内容浏览', exact: true }).tap();
  console.log(`Playback browser passed: hover ${hoverShownMs} ms, source bound ${sourceBoundMs} ms, `
    + `playing ${playingMs} ms after hover; video details/counts, zero/missing data, long copy, 390/320px layouts, direct cold opening, decoded audio RMS ${audioSignal.toFixed(4)}, drag/resize continuity and bounds, visible close/controls, delayed exclusive switch, stop on close, fullscreen, rehover, mobile tap/link layout.`);
} finally {
  await browser.close();
  await mobileBrowser?.close();
  fixture.stdin.write('STOP\n');
  fixture.stdin.end();
  await rm(profile, { recursive: true, force: true });
  if (mobileProfile) await rm(mobileProfile, { recursive: true, force: true });
}
