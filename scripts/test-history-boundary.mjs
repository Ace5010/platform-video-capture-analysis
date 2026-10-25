import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWorker } from './browser-worker.mjs';

const ids = Array.from({ length: 14 }, (_, index) => String(1234567890123456700n + BigInt(index)));
const items = ids.map((id, index) => ({
  aweme_id: id, desc: `作品 ${index + 1}`, item_title: `作品 ${index + 1}`,
  create_time: 1720000000 - index * 1000, is_top: index === 1 ? 1 : 0,
  author: { sec_uid: 'fixture', nickname: '测试账号' },
  statistics: { digg_count: 0, comment_count: 0, collect_count: 0, share_count: 0 },
  video: { duration: 12000, cover: { url_list: ['https://example.test/cover.jpg'] },
    play_addr: { url_list: [`https://test.douyinvod.com/${id}.mp4`], width: 640, height: 360 } },
  music: { play_url: { url_list: ['https://test.douyinvod.com/background.m4a'] } },
}));
const page = (values, more) => ({ page: { status_code: 0, aweme_list: values, has_more: more ? 1 : 0 } });
const profileHtml = `<!doctype html><html><body><h1>测试账号</h1><div id="user_detail_element"></div>
<script>
const pages = ${JSON.stringify([page(items.slice(0, 6), true), page(items.slice(6), false)])};
window.__DOUYIN_MONITOR_PUBLIC_POSTS_V3__ = [pages[0]];
const root = document.querySelector('#user_detail_element');
function append(values) { for (const item of values) { const li = document.createElement('li');
  li.innerHTML = '<a href="https://www.douyin.com/video/' + item.aweme_id + '"><img src="https://example.test/cover.jpg"></a>';
  // The page may omit its visual pin marker; the API flag must still win.
  root.append(li); } }
append(pages[0].page.aweme_list);
window.scrollTo = () => { if (window.__DOUYIN_MONITOR_PUBLIC_POSTS_V3__.length === 1) {
  window.__DOUYIN_MONITOR_PUBLIC_POSTS_V3__.push(pages[1]); append(pages[1].page.aweme_list); } };
</script></body></html>`;

const profile = await mkdtemp(join(tmpdir(), 'douyin-history-test-'));
const worker = new BrowserWorker(profile, { headless: true });
try {
  const context = await worker.ensureBrowser();
  let detailPages = 0;
  context.on('page', p => p.on('framenavigated', frame => { if (frame === p.mainFrame() && /\/video\//.test(frame.url())) detailPages++; }));
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: profileHtml }));
  const collector = await worker.collector();
  const account = { id: 'fixture', name: '测试账号', url: 'https://www.douyin.com/user/fixture',
    collectedHistoryIds: [ids[1], ids[12], ids[13]] };
  const result = await collector.collectAccount(account, 'latest', async () => {});
  assert.equal(result.videos.length, 12, 'pinned old work must not stop discovery before the trusted boundary');
  assert.equal(result.videos[0].id, ids[0]);
  assert.equal(result.videos.at(-1).id, ids[12]);
  assert.equal(result.videos.some((video) => video.id === ids[1]), false);
  assert.equal(Object.keys(result.transcriptionMedia).length, result.videos.length, 'account response supplies per-work media without detail visits');
  assert.equal(result.transcriptionMedia[ids[0]].video.url, `https://test.douyinvod.com/${ids[0]}.mp4`);
  assert.equal(result.transcriptionMedia[ids[0]].audio, null, 'background music cannot replace the voiceover');
  assert.equal(result.videos.some(v => Object.hasOwn(v, '_transcriptionMedia')), false, 'media handoff is separate from persistent video metadata');
  assert.equal(detailPages, 0, 'complete account metadata and media are collected in one visit');
  const zero = await collector.collectAccount({ ...account, collectedHistoryIds: [ids[0]] }, 'latest', async () => {});
  assert.equal(zero.videos.length, 5, 'zero new works still refresh the recent interaction window');
  const missing = await collector.collectAccount({ ...account, collectedHistoryIds: ['9999999999999999999'] }, 'latest', async () => {});
  assert.equal(missing.videos.length, 13, 'missing boundary scans until the confirmed list end');
  console.log('History boundary passed: over five new works, second page, pinned, zero new and missing boundary.');
} finally {
  await worker.close();
  await rm(profile, { recursive: true, force: true });
}
