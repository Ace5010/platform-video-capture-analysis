import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWorker } from './browser-worker.mjs';

const profile = await mkdtemp(join(tmpdir(), 'douyin-browser-test-'));
const worker = new BrowserWorker(profile, { headless: true });
try {
  const context = await worker.ensureBrowser();
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body><video></video></body></html>' }));
  const collector = await worker.collector();
  const adapter = worker.chromeAdapter();
  const tab = await adapter.tabs.create({ url: 'https://www.douyin.com/video/1234567890123456789', active: true });
  await collector.waitForTab(tab.id);
  const ready = await collector.waitForAnalysisVideoReady(tab.id, '1234567890123456789');
  assert.equal(ready.ready, true, 'real Chrome DOM is reachable without extension');
  const wrong = await collector.waitForAnalysisVideoReady(tab.id, '9999999999999999999');
  assert.equal(wrong.targetMatches, false, 'wrong video must remain rejected');
  const page = worker.tabs.get(tab.id).page;
  await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.src = 'https://example.org/embedded';
    const loaded = new Promise((resolve) => { frame.onload = resolve; });
    document.body.append(frame);
    await loaded;
    const target = { aweme_id: '1234567890123456789', video: {
      play_addr: { url_list: ['https://test.douyinvod.com/original.mp4'], width: 1920, height: 1080 },
      frame: frame.contentWindow,
    } };
    const unsafeValue = {
      valueOf() { throw new Error('metadata valueOf must not run'); },
      toString() { throw new Error('metadata toString must not run'); },
    };
    const urls = target.video.play_addr.url_list;
    Object.defineProperty(urls, '1', { enumerable: true, get() { throw new Error('array getter must not run'); } });
    urls.push(urls);
    const circularUrl = { url: null };
    circularUrl.url = circularUrl;
    urls.push(circularUrl);
    target.video.bit_rate = [
      { id: '1111111111111111111', bit_rate: 2600, play_addr: {
        url_list: ['https://test.douyinvod.com/original-4k.mp4'], width: 3840, height: 2160,
      } },
      { width: unsafeValue, height: unsafeValue, bit_rate: unsafeValue, gear_name: unsafeValue,
        codec_type: unsafeValue, mime_type: unsafeValue },
    ];
    target.music = { id: '2222222222222222222', play_url: { url_list: ['https://test.douyinvod.com/original-audio.m4a'] } };
    target.recommendation = { aweme_id: '9999999999999999999', video: {
      play_addr: { url_list: ['https://test.douyinvod.com/nested-wrong.mp4'], width: 7680, height: 4320 },
    } };
    target.identity = { id: unsafeValue };
    Object.defineProperty(target, 'broken', { enumerable: true, get() { throw new Error('getter must not run'); } });
    window._ROUTER_DATA = { frame: frame.contentWindow, self: window, node: document.body, target,
      unrelated: { aweme_id: '9999999999999999999', video: { play_addr: { url_list: ['https://test.douyinvod.com/wrong.mp4'] } } } };
    window._ROUTER_DATA.circular = window._ROUTER_DATA;
  });
  const sources = await adapter.scripting.executeScript({ target: { tabId: tab.id },
    func: collector.extractVerifiedVideoMediaSources, args: ['1234567890123456789'] });
  assert.deepEqual(sources[0].result.videoCandidates.map((item) => item.url),
    ['https://test.douyinvod.com/original-4k.mp4', 'https://test.douyinvod.com/original.mp4'],
    'cross-origin frames, throwing accessors, cycles and coercion must not abort target-only extraction');
  assert.equal(sources[0].result.videoCandidates[0].width, 3840, 'the highest original quality is retained');
  assert.deepEqual(sources[0].result.audioCandidates.map((item) => item.url),
    ['https://test.douyinvod.com/original-audio.m4a'], 'music IDs must not exclude target audio');
  await context.unroute('**/*');
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <h1>Original source appears after playback</h1>
    <div data-e2e="player-container" class="video_1234567890123456789"><video></video></div>
    <script>
      const video = document.querySelector('video');
      Object.defineProperty(video, 'currentSrc', { value: 'https://test.douyinvod.com/player-720.mp4' });
      Object.defineProperty(video, 'videoWidth', { value: 1280 });
      Object.defineProperty(video, 'videoHeight', { value: 720 });
      video.play = () => {
        setTimeout(() => { window._ROUTER_DATA = { target: { aweme_id: '1234567890123456789', video: {
          play_addr: { url_list: ['https://test.douyinvod.com/late-original-4k.mp4'], width: 3840, height: 2160 },
          bit_rate: [{ play_addr: { url_list: ['https://test.douyinvod.com/late-analysis-1080.mp4'], width: 1920, height: 1080 } }],
        } } }; }, 200);
        return Promise.resolve();
      };
    </script>` }));
  const lateCapture = await collector.captureFullVideoForAnalysis({ videoId: '1234567890123456789',
    videoUrl: 'https://www.douyin.com/video/1234567890123456789' });
  assert.equal(lateCapture.video.url, 'https://test.douyinvod.com/late-analysis-1080.mp4',
    'capture must wait for the complete 1080p source instead of prematurely choosing the 720p player or 4K');
  assert.equal(lateCapture.video.metadata.width, 1920);
  assert.equal(lateCapture.video.metadata.sourceKind, 'structured');
  assert.equal(lateCapture.video.metadata.targetBound, true);
  await context.unroute('**/*');
  await context.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.startsWith('/aweme/')) {
      const trustedEndpoint = requestUrl.hostname === 'www.douyin.com'
        && requestUrl.pathname === '/aweme/v1/web/aweme/detail/';
      const targetRecord = { aweme_id: '1234567890123456789', author: { privateFixture: 'must not be cached' },
        video: { width: trustedEndpoint ? 3840 : 7680, height: trustedEndpoint ? 2160 : 4320,
          play_addr: { url_list: ['https://test.douyinvod.com/api-player-720.mp4'], width: 1280, height: 720 },
          bit_rate: [{ play_addr: { url_list: [trustedEndpoint
            ? 'https://test.douyinvod.com/api-original-4k.mp4' : 'https://test.douyinvod.com/untrusted-8k.mp4'],
          width: trustedEndpoint ? 3840 : 7680, height: trustedEndpoint ? 2160 : 4320 } },
          { bit_rate: 2400, play_addr: { url_list: [trustedEndpoint
            ? 'https://test.douyinvod.com/api-analysis-1080.mp4' : 'https://test.douyinvod.com/untrusted-1080.mp4'],
          width: 1920, height: 1080 } }],
        }, music: { author: 'must not be cached', play_url: { url_list: ['https://test.douyinvod.com/api-original-audio.m4a'] } },
      };
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ aweme_detail: targetRecord, unrelated: { aweme_id: '9999999999999999999', video: {
          play_addr: { url_list: ['https://test.douyinvod.com/other-video-8k.mp4'], width: 7680, height: 4320 },
        } } }) });
    }
    return route.fulfill({ contentType: 'text/html', body: `
      <h1>Original sources arrive only in public API responses</h1>
      <div data-e2e="player-container" class="video_1234567890123456789"><video></video></div>
      <script>
        const video = document.querySelector('video');
        Object.defineProperty(video, 'currentSrc', { value: 'https://test.douyinvod.com/player-720.mp4' });
        Object.defineProperty(video, 'videoWidth', { value: 1280 });
        Object.defineProperty(video, 'videoHeight', { value: 720 });
        let requested = false;
        video.play = () => {
          if (!requested) {
            requested = true;
            for (const url of ['https://www.douyin.com/aweme/v1/web/aweme/detail/',
              'https://www.douyin.com/aweme/v1/web/account/private/',
              'https://untrusted.example/aweme/v1/web/aweme/detail/']) fetch(url).catch(() => {});
          }
          return Promise.resolve();
        };
      </script>` });
  });
  const apiCapture = await collector.captureFullVideoForAnalysis({ videoId: '1234567890123456789',
    videoUrl: 'https://www.douyin.com/video/1234567890123456789' });
  assert.equal(apiCapture.video.url, 'https://test.douyinvod.com/api-analysis-1080.mp4',
    'official public responses supply the verified complete 1080p source when globals are absent');
  assert.equal(apiCapture.video.metadata.width, 1920);
  assert.equal(apiCapture.video.metadata.height, 1080);
  assert.equal(apiCapture.video.metadata.sourceKind, 'structured');
  assert.equal(apiCapture.video.metadata.targetBound, true);
  assert.equal(apiCapture.audio.url, 'https://test.douyinvod.com/api-original-audio.m4a');
  assert.equal(worker.tabs.size, 1, 'capture removes the response cache with its temporary tab');
  await page.goto('https://www.douyin.com/video/1234567890123456789');
  const publicResponse = page.waitForResponse((response) => response.url().includes('/aweme/v1/web/aweme/detail/'));
  await adapter.scripting.executeScript({ target: { tabId: tab.id }, func: collector.activateVerifiedVideoPlayback,
    args: ['1234567890123456789'] });
  await publicResponse;
  for (let attempt = 0; attempt < 20 && !worker.tabs.get(tab.id).verifiedMediaRoots.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const cachedRoots = worker.tabs.get(tab.id).verifiedMediaRoots;
  assert.equal(cachedRoots.length, 1, 'only the official target video response is cached');
  assert.deepEqual(Object.keys(cachedRoots[0]).sort(), ['aweme_id', 'music', 'video']);
  assert.deepEqual(Object.keys(cachedRoots[0].music), ['play_url'], 'music author data is not retained');
  await adapter.tabs.update(tab.id, { url: 'https://www.douyin.com/video/9999999999999999999' });
  assert.equal(worker.tabs.get(tab.id).verifiedMediaRoots.length, 0, 'navigation clears response evidence for the previous target');
  await collector.waitForTab(tab.id);
  await context.unroute('**/*');
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <h1>Target description</h1><meta property="og:image" content="https://example.com/cover">
    <div data-e2e="player-container" class="video_1234567890123456789"><video></video></div>
    <div data-e2e="video-player-digg">1</div><div data-e2e="video-player-comment">0</div>
    <div data-e2e="video-player-collect">0</div><div data-e2e="video-player-share">0</div>
    <div data-e2e="video-publish-time">2026-09-01 08:00</div>
    <script>
      const video = document.querySelector('video');
      let duration = NaN;
      Object.defineProperty(video, 'duration', {get: () => duration});
      video.play = () => { setTimeout(() => {duration = 282.769}, 400); return Promise.resolve(); };
    </script>` }));
  const details = await collector.collectVideoDetails('https://www.douyin.com/video/1234567890123456789');
  assert.equal(details.durationSeconds, 283, 'capture must activate and wait for media metadata in the same attempt');
  assert.equal(details.shareCount, 0, 'zero is a valid count');
  await context.addCookies([{ name: 'test_session', value: 'persistent', domain: 'www.douyin.com', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]);
  await adapter.tabs.remove(tab.id);
  assert.equal(worker.tabs.size, 0, 'temporary task tabs are removed');
  await worker.close();
  const restarted = await worker.ensureBrowser();
  assert.equal((await restarted.cookies('https://www.douyin.com')).find((cookie) => cookie.name === 'test_session')?.value, 'persistent');
  console.log('Browser driver passed: real Chrome without extension, target-ID guard, tab cleanup and persistent profile across restart.');
} finally {
  await worker.close();
  await rm(profile, { recursive: true, force: true });
}
