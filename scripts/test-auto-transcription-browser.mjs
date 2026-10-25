// All host requests are isolated; no collection, paid APIs or production writes.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('artifacts/auto-transcription', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1467, height: 849 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.asrRequests = [];
    window.asrState = { accounts: [
      { id: 'asr-fixture', name: '测试账号', platform: 'douyin', status: 'ready', initialSyncStatus: 'complete', followerCount: 123456 },
      { id: 'asr-zero', name: '测试账号', platform: 'douyin', status: 'ready', initialSyncStatus: 'complete', followerCount: 0 },
      { id: 'asr-approx', name: '作者名字较长时也能清晰查看的测试账号', platform: 'douyin', status: 'ready', initialSyncStatus: 'complete', followerDisplayText: '4.2万', followerCountIsApproximate: true },
      { id: 'asr-unknown', name: '未知粉丝作者', platform: 'douyin', status: 'ready', initialSyncStatus: 'complete' },
    ],
      videos: ['queued', 'processing', 'ready', 'error', 'idle', 'paused'].map((status, i) => ({
        id: `900000000000000000${i}`, accountId: i === 1 ? 'asr-zero' : i === 3 ? 'asr-approx' : i === 5 ? 'asr-unknown' : 'asr-fixture', title: `视频 ${i + 1}`, authorName: i === 3 ? '作者名字较长时也能清晰查看的测试账号' : '测试账号',
        description: i === 1 ? '这是平台提供的原始简介，介绍安装环境。' : i === 3 ? `视频 ${i + 1}\n额外的原视频说明。` : i === 0 ? `视频 ${i + 1} #AI` : '',
        url: `https://www.douyin.com/video/900000000000000000${i}`, publishedAt: `2026-10-${21 - i}T08:00:00Z`,
        durationSeconds: 120, likeCount: 100, transcriptStatus: status,
        analysisStatus: status === 'ready' ? 'ready' : 'idle',
        analysis: status === 'ready' ? { summary: '已有内容分析' } : null,
        transcript: status === 'ready' ? 'Claude Opus 的完整口播稿。这里保留识别到的内容。' : null,
        transcriptError: status === 'error' ? '视频暂时无法访问' : null,
      })), linkVideos: [], snapshots: [], connector: { connected: true, capabilities: ['analyze_video'] } };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return nativeFetch(input, init);
      const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/auth/status')) return reply({ authenticated: true, configured: true, csrfToken: 'isolated' });
      if (url.pathname.endsWith('/state')) return reply({ state: window.asrState });
      if (url.pathname.endsWith('/qwen/status')) return reply({ configured: false });
      if (url.pathname.endsWith('/jobs') && init.method === 'POST') {
        const body = JSON.parse(init.body); window.asrRequests.push(body);
        const video = window.asrState.videos.find(v => v.id === body.payload.videoId);
        video.transcriptStatus = 'queued'; return reply({ ok: true, queued: true, video });
      }
      if (url.pathname.endsWith('/jobs')) return reply({ jobs: [] });
      return reply({ ok: true });
    };
  });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  const titles = page.locator('.compactVideoCopy'); await titles.first().waitFor();
  const rows = page.locator('.compactVideoRow');
  assert.equal(await page.locator('.compactRowActions').count(), 0, 'reading shortcuts are removed from the feed');
  for (let i = 0; i < 6; i++) {
    assert.equal(await rows.nth(i).getByRole('button').count(), 2, 'only cover playback and the title remain interactive');
    assert.equal(await rows.nth(i).locator('.compactVideoStatus > span').count(), 2, 'transcript and analysis availability are independent');
  }
  assert.deepEqual(await rows.nth(2).locator('.compactVideoStatus > span').allTextContents(), ['有口播稿', '已分析']);
  assert.deepEqual(await rows.nth(4).locator('.compactVideoStatus > span').allTextContents(), ['无口播稿', '未分析']);
  assert.equal(await rows.nth(0).locator('.compactAuthorFollowers').innerText(), '12.3万粉丝');
  assert.equal(await rows.nth(1).locator('.compactAuthorFollowers').innerText(), '0粉丝', 'same author display name must not mix account follower counts');
  assert.equal(await rows.nth(3).locator('.compactAuthorFollowers').innerText(), '约4.2万粉丝');
  assert.equal(await rows.nth(5).locator('.compactAuthorFollowers').innerText(), '粉丝 —');
  assert.equal(await rows.nth(0).locator('.compactVideoSummary').count(), 0, 'the title is not repeated in the description');
  assert.equal(await rows.nth(2).locator('.compactVideoSummary').count(), 0, 'a ready transcript and analysis do not fill an absent source description');
  assert.equal(await rows.nth(1).locator('.compactVideoSummary').innerText(), '这是平台提供的原始简介，介绍安装环境。');
  assert.equal(await rows.nth(3).locator('.compactVideoSummary').innerText(), '额外的原视频说明。');
  for (const [index, expected] of [[0, '口播识别排队中'], [1, '正在识别口播'], [2, 'Claude Opus'], [3, '视频暂时无法访问'], [4, '暂无口播稿'], [5, '口播识别已暂停']]) {
    await titles.nth(index).click();
    await page.getByRole('tab', { name: '口播稿', exact: true }).click();
    await page.waitForFunction(text => document.querySelector('#reader-panel')?.textContent.includes(text), expected);
    if (index === 2) {
      await page.waitForTimeout(200);
      await page.screenshot({ path: 'artifacts/auto-transcription/desktop-ready.png' });
    }
    if (index === 3) {
      await page.getByRole('button', { name: '重试口播识别', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#reader-panel')?.textContent.includes('口播识别排队中'));
    }
    if (index === 4) {
      await page.getByRole('button', { name: '提取口播稿', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#reader-panel')?.textContent.includes('口播识别排队中'));
    }
    if (index === 5) {
      assert.ok(!(await page.locator('#reader-panel').innerText()).includes('失败'));
      await page.waitForTimeout(200);
      await page.screenshot({ path: 'artifacts/auto-transcription/desktop-paused.png' });
      await page.getByRole('button', { name: '继续这条口播识别', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#reader-panel')?.textContent.includes('口播识别排队中'));
    }
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await titles.nth(2).click();
  await page.getByRole('tab', { name: '口播稿', exact: true }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/auto-transcription/mobile-ready.png' });
  assert.equal(await page.locator('.readingDialog').evaluate(n => n.scrollWidth <= n.clientWidth), true);
  const bounds = await page.locator('.readingDialog').boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 845, 'mobile reader fits the viewport');
  const requests = await page.evaluate(() => window.asrRequests);
  assert.deepEqual(requests.map(r => r.type), ['transcribe_video', 'transcribe_video', 'transcribe_video']);
  assert.equal(requests[0].payload.retry, true);
  assert.equal(requests[2].payload.retry, true);
  assert.deepEqual(errors, []);
  console.log('Local transcript UI passed: six states, two availability indicators, no feed shortcuts, title reading, local-only extract/retry, desktop and mobile.');
} finally { await browser.close(); }
