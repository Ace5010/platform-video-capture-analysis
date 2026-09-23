import assert from 'node:assert/strict';

import { browseContentVideos, collectionAccountScope } from '../lib/content-browse.ts';

type FixtureVideo = {
  id: string;
  accountId: string;
  publishedAt: string | null;
  firstSeenAt: string;
  transcript: string | null;
  analysis: unknown;
  isLinkAnalysis?: boolean;
};

function video(id: string, accountId: string, day: number | null, overrides: Partial<FixtureVideo> = {}): FixtureVideo {
  return {
    id,
    accountId,
    publishedAt: day === null ? null : `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`,
    firstSeenAt: '2026-09-23T00:00:00Z',
    transcript: null,
    analysis: null,
    ...overrides,
  };
}

// The old account deliberately omits latestVideoIds; no database or network is used.
const accounts = Object.freeze([
  { id: 'account-a', latestVideoIds: ['a2', 'a6', 'a4', 'a1', 'a5', 'a3'] },
  { id: 'account-b' },
  { id: 'account-c', latestVideoIds: [] },
]);
const videos = Object.freeze([
  video('a3', 'account-a', 3),
  video('a1', 'account-a', 1, { firstSeenAt: '2099-01-01T00:00:00Z', transcript: ' \n\t ' }),
  video('a7', 'account-a', 7),
  video('a4', 'account-a', 4, { transcript: '只完成口播，其他分区仍未完成。' }),
  video('a2', 'account-a', 2, { analysis: { overview: '已保存的视频内容分析。' } }),
  video('a6', 'account-a', 6),
  video('a5', 'account-a', 5),
  video('a-unknown', 'account-a', null, { firstSeenAt: '2100-01-01T00:00:00Z' }),
  ...[5, 1, 7, 3, 6, 2, 4].map((day) => video(`b${day}`, 'account-b', 10 + day)),
  ...[2, 3, 1].map((day) => video(`c${day}`, 'account-c', 20 + day)),
  video('link-same-account', 'account-a', 29, { isLinkAnalysis: true, transcript: '已监控视频通过分享链接补充的分析。' }),
  video('link-only', '__video_link_analysis__', 28, { isLinkAnalysis: true }),
  video('not-monitored', 'removed-account', 27, { analysis: { overview: '仍保存的旧结果。' } }),
].map((item) => Object.freeze(item)));
const originalVideos = JSON.stringify(videos);
const originalAccounts = JSON.stringify(accounts);
const ids = (items: readonly FixtureVideo[]) => items.map((item) => item.id);

const all = browseContentVideos(videos, accounts, { accountId: '', scope: 'all', result: 'all' });
assert.equal(all.length, 19);
assert.deepEqual([...new Set(all.map((item) => item.accountId))].sort(), ['account-a', 'account-b', 'account-c']);
assert.ok(ids(all).includes('link-same-account'), 'a monitored video remains visible after analysis through its share link');
assert.ok(!ids(all).includes('link-only'), 'an independent link does not become monitored account content');
assert.ok(!ids(all).includes('not-monitored'));

assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-a', scope: 'all', result: 'all',
})), ['link-same-account', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1', 'a-unknown']);
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-b', scope: 'all', result: 'all',
})), ['b7', 'b6', 'b5', 'b4', 'b3', 'b2', 'b1']);
assert.deepEqual(browseContentVideos(videos, accounts, {
  accountId: 'removed-account', scope: 'all', result: 'all',
}), []);

// Saved check results take precedence over the newest publication dates and stop at five IDs.
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-a', scope: 'latest', result: 'all',
})), ['a6', 'a5', 'a4', 'a2', 'a1']);
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-b', scope: 'latest', result: 'all',
})), ['b7', 'b6', 'b5', 'b4', 'b3']);
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-c', scope: 'latest', result: 'all',
})), ['c3', 'c2', 'c1']);
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: '', scope: 'latest', result: 'all',
})), ['c3', 'c2', 'c1', 'b7', 'b6', 'b5', 'b4', 'b3', 'a6', 'a5', 'a4', 'a2', 'a1']);

// A completed transcript remains readable even if later analysis sections failed.
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: '', scope: 'all', result: 'available',
})), ['link-same-account', 'a4', 'a2']);
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-a', scope: 'all', result: 'missing',
})), ['a7', 'a6', 'a5', 'a3', 'a1', 'a-unknown']);
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-a', scope: 'latest', result: 'available',
})), ['a4', 'a2']);
assert.deepEqual(ids(browseContentVideos(videos, accounts, {
  accountId: 'account-a', scope: 'latest', result: 'missing',
})), ['a6', 'a5', 'a1']);

// A late collection timestamp never turns an old or undated publication into a new one.
assert.equal(all.at(-2)?.id, 'a1');
assert.equal(all.at(-1)?.id, 'a-unknown');
assert.equal(JSON.stringify(videos), originalVideos, 'browsing must not mutate saved videos');
assert.equal(JSON.stringify(accounts), originalAccounts, 'browsing must not mutate account check results');
assert.notEqual(all, videos, 'the displayed order is a separate array');
assert.equal(all.find((item) => item.id === 'a4'), videos.find((item) => item.id === 'a4'));
assert.deepEqual(browseContentVideos([], accounts, { accountId: '', scope: 'latest', result: 'all' }), []);
assert.deepEqual(browseContentVideos(videos, [], { accountId: '', scope: 'all', result: 'all' }), []);

assert.equal(collectionAccountScope('内容浏览', 'account-a', 'account-b'), 'account-a');
assert.equal(collectionAccountScope('内容浏览', '', 'account-b'), '');
assert.equal(collectionAccountScope('互动数据', 'account-a', 'account-b'), 'account-b');
assert.equal(collectionAccountScope('互动数据', 'account-a', ''), '');
assert.equal(collectionAccountScope('信源管理', 'account-a', 'account-b'), '');
assert.equal(collectionAccountScope('链接分析', 'account-a', 'account-b'), '');

console.log('Content browsing validation passed: account filters, saved latest IDs, legacy fallback, partial results, publication chronology, link isolation, immutable sorting, and manual collection scope.');
