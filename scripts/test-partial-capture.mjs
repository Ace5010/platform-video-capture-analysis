import assert from 'node:assert/strict';
import { BrowserWorker } from './browser-worker.mjs';

const collector = await new BrowserWorker('unused').collector();
const video = { id: '7000000000000000001', url: 'https://www.douyin.com/video/7000000000000000001', title: 'test', description: 'test', coverUrl: 'https://example.com/cover', publishedAt: '2026-09-01', durationSeconds: 1, likeCount: 0, commentCount: 0, favoriteCount: 0, shareCount: 0 };
let calls = [];
collector.collectVideoDetails = async (_url, active) => {
  calls.push(active);
  if (calls.length === 1) throw new Error('页面未加载');
  return video;
};
assert.equal(collector.hasCompletePublicData(await collector.collectVideoWithRetries({ id: video.id, url: video.url }, 'account')), true);
assert.deepEqual(calls, [false, true]);
calls = [];
collector.collectVideoDetails = async (_url, active) => { calls.push(active); return { ...video, shareCount: null }; };
await assert.rejects(collector.collectVideoWithRetries({ id: video.id, url: video.url }, 'account'), /分享数/);
assert.equal(calls.length, 3);
assert.equal(collector.hasCompletePublicData({ ...video, shareCount: null }), false);
calls = [];
collector.collectVideoDetails = async () => { calls.push(1); throw new Error('详情页已跳转到其他视频'); };
await assert.rejects(collector.collectVideoWithRetries({ id: video.id, url: video.url }, 'account'), /跳转到其他视频/);
assert.equal(calls.length, 1);
console.log('Complete capture retry passed: bounded attempts, foreground retry, exact missing fields, zero counts accepted, wrong target stops.');
