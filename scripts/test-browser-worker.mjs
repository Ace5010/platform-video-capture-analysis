import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  for (const [text, blocked] of [['必须重新登录', true], ['请完成安全验证，拖动滑块', true], ['登录', false]]) {
    await page.setContent(`<html><body><p>${text}</p></body></html>`);
    const profileReady = await collector.executeInTab(tab.id, collector.waitForAccountVideoDom, [20, 1]);
    assert.equal(Boolean(profileReady.blockingReason), blocked, 'only explicit login/challenge pages block the queue');
  }
  await page.setContent('<div id="user_detail_element"><a href="https://www.douyin.com/video/1234567890123456789">拖动滑块的教程</a></div>');
  const normalProfile = await collector.executeInTab(tab.id, collector.waitForAccountVideoDom, [20, 1]);
  assert.equal(normalProfile.ready, true);
  assert.equal(normalProfile.blockingReason, null, 'words in a genuine work card must not pause collection');
  await page.setContent('<html><body><video></video></body></html>');
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
      { id: '1111111111111111111', bit_rate: 2600, format: 'dash', play_addr: {
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
  assert.equal(sources[0].result.videoCandidates[0].containerFormat, 'dash',
    'the platform format label follows a bitrate rendition into its child address');
  assert.deepEqual(sources[0].result.audioCandidates.map((item) => item.url),
    ['https://test.douyinvod.com/original-audio.m4a'], 'music IDs must not exclude target audio');
  await context.unroute('**/*');
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
    <video></video><script>
      document.querySelector('video').play = () => { throw new Error('preview must not wait for site playback'); };
      window._ROUTER_DATA = { target: { aweme_id: '1234567890123456789', video: {
        bit_rate: [{ codec: 'hevc', play_addr: { url_list: ['https://test.douyinvod.com/published-low.mp4'], width: 640, height: 360 } }],
      } }, other: { aweme_id: '9999999999999999999', video: {
        play_addr: { url_list: ['https://test.douyinvod.com/wrong-low.mp4'], width: 480, height: 270 },
      } } };
    </script>` }));
  const previewStarted = Date.now();
  const publishedPreview = await collector.captureFullVideoForAnalysis({ videoId: '1234567890123456789',
    videoUrl: 'https://www.douyin.com/video/1234567890123456789', purpose: 'preview' });
  assert.equal(publishedPreview.video.url, 'https://test.douyinvod.com/published-low.mp4',
    'the target-bound published source must work without waiting for the site player');
  assert.equal(publishedPreview.playedSources.length, 0, 'no site playback is required for a verified published source');
  assert.ok(Date.now() - previewStarted < 5000, 'preview must bypass the site playback timeout');
  const muxedTranscript = await collector.captureFullVideoForAnalysis({ videoId: '1234567890123456789',
    videoUrl: 'https://www.douyin.com/video/1234567890123456789', purpose: 'transcription' });
  assert.equal(muxedTranscript.video.url, publishedPreview.video.url, 'local ASR resolves the complete small muxed source');
  await context.unroute('**/*');
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
    <video></video><script>window._ROUTER_DATA = {target:{aweme_id:'1234567890123456789',
      music:{play_url:{url_list:['https://test.douyinvod.com/background-only.m4a']}},
      video:{play_addr:{url_list:['https://test.douyinvod.com/complete.mp4'],width:640,height:360},
        audio:{play_addr:{url_list:['https://test.douyinvod.com/full-track.m4a']}}}}};</script>` }));
  const audioTranscript = await collector.captureFullVideoForAnalysis({ videoId: '1234567890123456789',
    videoUrl: 'https://www.douyin.com/video/1234567890123456789', purpose: 'transcription' });
  assert.equal(audioTranscript.audio.url, 'https://test.douyinvod.com/full-track.m4a');
  assert.equal(audioTranscript.audio.metadata.targetBound, true);
  assert.equal(audioTranscript.video, null, 'full video audio is preferred over background music');
  await context.unroute('**/*');
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
    <script>window._ROUTER_DATA = { target: { aweme_id: '1234567890123456789', video: {
      play_addr: { url_list: ['https://test.douyinvod.com/no-player-low.mp4'], width: 640, height: 360 },
    } } };</script><h1>播放器稍后加载</h1>` }));
  const beforePlayerStarted = Date.now();
  const beforePlayerPreview = await collector.captureFullVideoForAnalysis({ videoId: '1234567890123456789',
    videoUrl: 'https://www.douyin.com/video/1234567890123456789', purpose: 'preview' });
  assert.equal(beforePlayerPreview.video.url, 'https://test.douyinvod.com/no-player-low.mp4');
  assert.ok(Date.now() - beforePlayerStarted < 5000, 'target-bound metadata must bypass the 18-second missing-player wait');
  await context.unroute('**/*');
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
    <video></video><script>
      let scheduled = false;
      document.querySelector('video').play = () => {
        if (!scheduled) {
          scheduled = true;
          setTimeout(() => { window._ROUTER_DATA = { target: { aweme_id: '1234567890123456789', video: {
            play_addr: { url_list: ['https://test.douyinvod.com/delayed-low.mp4'], width: 640, height: 360 },
          } } }; }, 250);
        }
        return Promise.resolve();
      };
    </script>` }));
  const delayedStarted = Date.now();
  const delayedPreview = await collector.captureFullVideoForAnalysis({ videoId: '1234567890123456789',
    videoUrl: 'https://www.douyin.com/video/1234567890123456789', purpose: 'preview' });
  assert.equal(delayedPreview.video.url, 'https://test.douyinvod.com/delayed-low.mp4',
    'metadata arriving during activation must bypass the decoder wait');
  assert.ok(Date.now() - delayedStarted < 5000, 'late metadata must not consume the 18-second playback wait');
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
        statistics: { aweme_id: '1234567890123456789', digg_count: 80, comment_count: 24,
          collect_count: 10, share_count: trustedEndpoint ? 0 : 999, privateFixture: 'must not be cached' },
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
  assert.equal(await page.evaluate(() => document.querySelector('video').loop), true,
    'media lookup must keep the target video from advancing through recommendations');
  await page.evaluate(() => { document.querySelector('video').pause = () => { document.body.dataset.capturePaused = 'yes'; }; });
  await adapter.scripting.executeScript({ target: { tabId: tab.id }, func: collector.pauseVerifiedVideoPlayback,
    args: ['1234567890123456789'] });
  assert.equal(await page.evaluate(() => document.body.dataset.capturePaused), 'yes',
    'media lookup must stop the target player after choosing a source');
  await publicResponse;
  for (let attempt = 0; attempt < 20 && !worker.tabs.get(tab.id).verifiedMediaRoots.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const cachedRoots = worker.tabs.get(tab.id).verifiedMediaRoots;
  assert.equal(cachedRoots.length, 1, 'only the official target video response is cached');
  assert.deepEqual(Object.keys(cachedRoots[0]).sort(), ['aweme_id', 'music', 'statistics', 'video']);
  assert.deepEqual(cachedRoots[0].statistics, { digg_count: 80, comment_count: 24, collect_count: 10, share_count: 0 },
    'only explicit public counts from the official target response are retained');
  assert.deepEqual(Object.keys(cachedRoots[0].music), ['play_url'], 'music author data is not retained');
  await page.evaluate(() => {
    const share = document.createElement('div');
    share.dataset.e2e = 'video-player-share';
    share.textContent = '分享';
    document.body.append(share);
  });
  const readDetail = () => adapter.scripting.executeScript({ target: { tabId: tab.id },
    func: collector.extractVideoDetailPage, args: ['1234567890123456789'] });
  assert.equal((await readDetail())[0].result.shareCount, 0,
    'a label-only share button uses the explicit zero in the verified public response');
  worker.tabs.get(tab.id).verifiedMediaRoots = [{ aweme_id: '9999999999999999999', statistics: { share_count: 0 } }];
  assert.equal((await readDetail())[0].result.shareCount, null, 'another video cannot supply a zero count');
  worker.tabs.get(tab.id).verifiedMediaRoots = [{ aweme_id: '1234567890123456789', statistics: {} }];
  assert.equal((await readDetail())[0].result.shareCount, null, 'a missing count must remain unknown');
  for (const shareCount of [-1, '0', null, 1.5]) {
    worker.tabs.get(tab.id).verifiedMediaRoots = [{ aweme_id: '1234567890123456789', statistics: { share_count: shareCount } }];
    assert.equal((await readDetail())[0].result.shareCount, null, 'invalid public counts must not become zero');
  }
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
  await context.unroute('**/*');
  let stalledResource;
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).pathname === '/stalled-image.png') { stalledResource = route; return; }
    return route.fulfill({ contentType: 'text/html', body: '<h1>Ready target page</h1><img src="/stalled-image.png">' });
  });
  const slowTab = await adapter.tabs.create({ url: 'https://www.douyin.com/video/1234567890123456789', active: false });
  try {
    await collector.waitForTab(slowTab.id, 3000);
    assert.equal(await worker.tabs.get(slowTab.id).page.locator('h1').textContent(), 'Ready target page',
      'DOM-ready navigation must not wait for unrelated page resources');
  } finally {
    if (stalledResource) await stalledResource.abort().catch(() => {});
    await adapter.tabs.remove(slowTab.id);
  }
  // The preview purpose must pick a small, playable source instead of the
  // highest available quality, and must report an explicit limit when none
  // exists. Only the pure chooser is evaluated in the page: the collector's
  // service-worker bootstrap must not run outside its own context.
  const previewPage = await context.newPage();
  const collectorSource = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
  const chooserSource = collectorSource.slice(
    collectorSource.indexOf('const PREVIEW_SHORT_EDGE_RANGE'),
    collectorSource.indexOf('function createFullVideoCapture'),
  );
  assert.ok(chooserSource.includes('selectPreviewVideoCandidate'), 'the preview chooser must be present');
  await previewPage.evaluate((source) => {
    const factory = new Function(`${source}; return selectPreviewVideoCandidate;`);
    window.__selectPreview = (candidates) => factory()(new Map(candidates.map((candidate, index) => [
      `https://test.douyinvod.com/${index}.mp4`,
      { url: `https://test.douyinvod.com/${index}.mp4`, metadata: { targetBound: true, ...candidate } }])));
    window.__selectPreviewUnbound = () => factory()(new Map([['https://test.douyinvod.com/x.mp4',
      { url: 'https://test.douyinvod.com/x.mp4', metadata: { targetBound: false, width: 640, height: 360 } }]]));
    const rank = new Function(`${source}; return rankPreviewVideoCandidates;`)();
    window.__rankPreview = candidates => rank(candidates.map((metadata, index) => ({
      url: `https://test.douyinvod.com/${index}.mp4`, metadata,
    }))).map(candidate => candidate.metadata);
  }, chooserSource);
  const selectInPage = (candidates) => previewPage.evaluate((list) => {
    const result = window.__selectPreview(list);
    return result ? result.metadata : null;
  }, candidates);
  assert.equal((await selectInPage([
    { width: 1920, height: 1080, bitrate: 4_000_000, contentLength: 40_000_000 },
    { width: 854, height: 480, bitrate: 900_000, contentLength: 9_000_000 },
    { width: 1280, height: 720, bitrate: 2_000_000, contentLength: 20_000_000 },
  ])).width, 854, 'preview must prefer the small short edge, not the highest quality');
  assert.equal((await selectInPage([
    { width: 854, height: 480, bitrate: 2_500_000, contentLength: 25_000_000 },
    { width: 640, height: 360, bitrate: 400_000, contentLength: 4_000_000 },
  ])).width, 640, 'a lower real transfer size wins over a resolution label');
  assert.equal((await selectInPage([
    { width: 854, height: 480, contentLength: 1_000_000, containerFormat: 'dash' },
    { width: 1280, height: 720, contentLength: 2_000_000, containerFormat: 'mp4' },
    { width: 1920, height: 1080, contentLength: 4_000_000, containerFormat: 'mp4' },
  ])).width, 1280, 'an existing combined source precedes silent DASH video variants and keeps the smaller size');
  const separatedFallbacks = await previewPage.evaluate(() => window.__rankPreview([
    { targetBound: true, width: 854, height: 480, contentLength: 1_000_000, containerFormat: 'dash' },
    { targetBound: true, width: 1280, height: 720, contentLength: 2_000_000, containerFormat: 'mp4' },
    { targetBound: true, width: 640, height: 360, contentLength: 500_000, containerFormat: 'dash' },
  ]));
  assert.deepEqual(separatedFallbacks.map(candidate => candidate.width), [1280, 640, 854],
    'separate video tracks remain bounded fallback candidates if the combined address is unreadable');
  assert.equal((await selectInPage([{ width: 640, height: 360, containerFormat: 'dash' }])).width, 640,
    'a DASH-only publication must still reach actual track validation, not be silently discarded');
  assert.equal((await selectInPage([
    { width: 1080, height: 1920, bitrate: 3_000_000, contentLength: 30_000_000 },
  ])).height, 1920, 'a vertical work is measured by its short edge');
  assert.equal((await selectInPage([
    { width: 1920, height: 1080, bitrate: 4_000_000, contentLength: 40_000_000 },
    { width: 1280, height: 720, bitrate: 2_000_000, contentLength: 20_000_000 },
  ])).width, 1280, 'without a target band the nearest existing size is used');
  assert.equal((await selectInPage([{ bitrate: 800_000 }])).bitrate, 800_000,
    'a single unmeasured candidate is still usable');
  assert.equal(await previewPage.evaluate(() => window.__selectPreview([])), null,
    'no target-bound candidate means no preview source');
  assert.equal(await previewPage.evaluate(() => window.__selectPreviewUnbound()), null,
    'an unbound candidate must never be used for preview');
  const alternatives = await previewPage.evaluate(() => window.__rankPreview([
    { targetBound: true, width: 2880, height: 2160, contentLength: 12_000_000 },
    { targetBound: true, width: 768, height: 576, contentLength: 2_000_000 },
    { targetBound: true, width: 1280, height: 720, contentLength: 5_000_000 },
    { targetBound: true, width: 1024, height: 576, contentLength: 3_000_000 },
    { targetBound: false, width: 640, height: 360, contentLength: 1_000_000 },
  ]));
  assert.deepEqual(alternatives.map(candidate => candidate.width), [768, 1024, 1280, 2880],
    'all fallback sources must retain the low-size preference and exact-target binding');
  const mirrors = await previewPage.evaluate(() => window.__rankPreview([
    { targetBound: true, width: 768, height: 576, contentLength: 2_000_000 },
    { targetBound: true, width: 768, height: 576, contentLength: 2_000_000 },
    { targetBound: true, width: 768, height: 576, contentLength: 3_000_000 },
  ]));
  assert.deepEqual(mirrors.map(candidate => candidate.contentLength), [2_000_000, 3_000_000, 2_000_000],
    'a distinct low-size encoding must precede mirrors of an already attempted encoding');
  const bitrateMirrors = await previewPage.evaluate(() => window.__rankPreview([
    { targetBound: true, width: 768, height: 576, bitrate: 168281, quality: 'adapt_lower_540_1' },
    { targetBound: true, width: 768, height: 576, bitrate: 168281, quality: 'adapt_lower_540_1' },
    { targetBound: true, width: 768, height: 576, bitrate: 219470, quality: 'adapt_lower_540_1' },
  ]));
  assert.deepEqual(bitrateMirrors.map(candidate => candidate.bitrate), [168281, 219470, 168281],
    'platform encoding metadata without file size must also postpone mirror addresses');
  await previewPage.close();
  // Follower evidence belongs to one profile and must be discarded on navigation.
  await context.unroute('**/*');
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Account</h1>' }));
  const profileTab = await adapter.tabs.create({ url: 'https://www.douyin.com/user/profile-a', active: false });
  await collector.waitForTab(profileTab.id);
  const profileResponse = (user, query = '') => ({
    url: () => `https://www.douyin.com/aweme/v1/web/user/profile/other/${query}`,
    status: () => 200, headers: () => ({ 'content-type': 'application/json' }),
    body: async () => Buffer.from(JSON.stringify({ user })),
  });
  await worker.rememberPublicAccountProfile(profileTab.id, profileResponse({ sec_uid: 'other', follower_count: 900 }));
  assert.equal(worker.tabs.get(profileTab.id).verifiedProfile, null, 'another account cannot supply followers');
  await worker.rememberPublicAccountProfile(profileTab.id, profileResponse({ follower_count: 900 }));
  assert.equal(worker.tabs.get(profileTab.id).verifiedProfile, null, 'an unbound profile response must be ignored');
  await worker.rememberPublicAccountProfile(profileTab.id, profileResponse({ sec_uid: 'profile-a', follower_count: 0 }));
  assert.equal(worker.tabs.get(profileTab.id).verifiedProfile.follower_count, 0, 'a real zero is preserved');
  await adapter.tabs.update(profileTab.id, { url: 'https://www.douyin.com/user/profile-b' });
  assert.equal(worker.tabs.get(profileTab.id).verifiedProfile, null, 'navigation clears old follower evidence');
  await adapter.tabs.remove(profileTab.id);
  await context.addCookies([{ name: 'test_session', value: 'persistent', domain: 'www.douyin.com', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]);
  await adapter.tabs.remove(tab.id);
  assert.equal(worker.tabs.size, 0, 'temporary task tabs are removed');
  await worker.close();
  const restarted = await worker.ensureBrowser();
  assert.equal((await restarted.cookies('https://www.douyin.com')).find((cookie) => cookie.name === 'test_session')?.value, 'persistent');
  const headed = new BrowserWorker(profile + '-headed');
  try {
    const headedContext = await headed.ensureBrowser();
    await headedContext.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<video></video>' }));
    const backgroundTab = await headed.chromeAdapter().tabs.create({ url: 'about:blank', active: false });
    const backgroundSession = await headedContext.newCDPSession(headed.tabs.get(backgroundTab.id).page);
    const backgroundWindow = await backgroundSession.send('Browser.getWindowForTarget');
    assert.equal(backgroundWindow.bounds.windowState, 'minimized',
      'background task creation must not restore the dedicated browser window');
    const nextBackgroundTab = await headed.chromeAdapter().tabs.create({ url: 'about:blank', active: false });
    const nextBackgroundSession = await headedContext.newCDPSession(headed.tabs.get(nextBackgroundTab.id).page);
    const nextBackgroundWindow = await nextBackgroundSession.send('Browser.getWindowForTarget');
    assert.equal(nextBackgroundWindow.windowId, backgroundWindow.windowId,
      'successive source lookups must reuse the background window');
    assert.equal(nextBackgroundWindow.bounds.windowState, 'minimized');
    await headed.chromeAdapter().tabs.remove(nextBackgroundTab.id);
    await headed.open();
    const loginPage = headedContext.pages().find(page => page !== headed.tabs.get(backgroundTab.id).page);
    const loginSession = await headedContext.newCDPSession(loginPage);
    assert.equal((await loginSession.send('Browser.getWindowForTarget')).bounds.windowState, 'normal',
      'explicit login/open still displays the dedicated browser');
  } finally {
    await headed.close();
    await rm(profile + '-headed', { recursive: true, force: true });
  }
  console.log('Browser driver passed: real Chrome without extension, target-ID guard, tab cleanup and persistent profile across restart.');
} finally {
  await worker.close();
  await rm(profile, { recursive: true, force: true });
}
