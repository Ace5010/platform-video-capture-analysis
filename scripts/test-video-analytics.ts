import assert from 'node:assert/strict';

import {
  analyticsMetricValue,
  calculateDelta,
  metricRank,
  metricTrendSegments,
  orderVideosOldestFirst,
  previousPublishedVideo,
  snapshotMetricChange,
  summarizeMetric,
  type AnalyticsSnapshotLike,
  type AnalyticsVideoLike,
} from '../lib/video-analytics.ts';

function video(id: string, publishedAt: string | null, likeCount: number): AnalyticsVideoLike {
  return {
    id,
    accountId: 'account-a',
    publishedAt,
    firstSeenAt: publishedAt || '2026-08-01T00:00:00Z',
    lastSeenAt: publishedAt || '2026-08-01T00:00:00Z',
    likeCount,
    commentCount: likeCount / 10,
    favoriteCount: likeCount / 5,
    shareCount: likeCount / 20,
  };
}

const videos = [
  video('v3', '2026-08-03T00:00:00Z', 60),
  video('v1', '2026-08-01T00:00:00Z', 10),
  video('v6', '2026-08-06T00:00:00Z', 50),
  video('v2', '2026-08-02T00:00:00Z', 20),
  video('v5', '2026-08-05T00:00:00Z', 40),
  video('v4', '2026-08-04T00:00:00Z', 30),
];

assert.deepEqual(orderVideosOldestFirst(videos).map((item) => item.id), ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
assert.equal(previousPublishedVideo(videos[0], videos)?.id, 'v2');
assert.equal(previousPublishedVideo(videos[1], videos), null);

assert.deepEqual(calculateDelta(150, 100), { baseline: 100, current: 150, absolute: 50, percentage: 50 });
assert.deepEqual(calculateDelta(5, 0), { baseline: 0, current: 5, absolute: 5, percentage: null });
assert.deepEqual(calculateDelta(0, 0), { baseline: 0, current: 0, absolute: 0, percentage: 0 });
assert.deepEqual(calculateDelta(80, 100), { baseline: 100, current: 80, absolute: -20, percentage: -20 });
assert.equal(analyticsMetricValue(null), null);
assert.equal(analyticsMetricValue(''), null);
assert.equal(analyticsMetricValue(-1), null);
assert.equal(analyticsMetricValue(0), 0);

const gappedVideos = [
  { ...video('missing-start', null, 1), likeCount: null },
  video('zero', null, 0),
  video('valid', null, 20),
  { ...video('missing-middle', null, 1), likeCount: null },
  video('isolated', null, 15),
  { ...video('missing-end', null, 1), likeCount: null },
];
assert.deepEqual(metricTrendSegments(gappedVideos, 'likeCount'), [
  [{ index: 1, value: 0 }, { index: 2, value: 20 }],
  [{ index: 4, value: 15 }],
]);
assert.deepEqual(metricTrendSegments([], 'likeCount'), []);
assert.deepEqual(metricTrendSegments(gappedVideos.filter((item) => item.likeCount === null), 'likeCount'), []);
assert.deepEqual(metricTrendSegments([video('single-zero', null, 0)], 'likeCount'), [[{ index: 0, value: 0 }]]);
assert.deepEqual(metricTrendSegments([{ ...video('other-metric', null, 99), commentCount: 0 }], 'commentCount'), [[{ index: 0, value: 0 }]]);

const snapshots: AnalyticsSnapshotLike[] = [
  { accountId: 'account-a', videoId: 'v1', capturedAt: '2026-08-01T12:00:00Z', likeCount: 100, commentCount: 10, favoriteCount: 20, shareCount: 5 },
  { accountId: 'account-b', videoId: 'v1', capturedAt: '2026-08-02T12:00:00Z', likeCount: 999, commentCount: 99, favoriteCount: 99, shareCount: 99 },
  { accountId: 'account-a', videoId: 'v1', capturedAt: '2026-08-03T12:00:00Z', likeCount: 150, commentCount: 15, favoriteCount: 30, shareCount: 8 },
];
const snapshotChange = snapshotMetricChange(videos[1], snapshots, 'likeCount');
assert.equal(snapshotChange.sampleCount, 2);
assert.deepEqual(snapshotChange.delta, { baseline: 100, current: 150, absolute: 50, percentage: 50 });
assert.equal(snapshotMetricChange(videos[2], snapshots, 'likeCount').delta, null);

const duplicateInstantSnapshots: AnalyticsSnapshotLike[] = [
  { accountId: 'account-a', videoId: 'v1', capturedAt: '2026-08-01T00:00:00Z', likeCount: 10, commentCount: 1, favoriteCount: 1, shareCount: 1 },
  { accountId: 'account-a', videoId: 'v1', capturedAt: '2026-08-01T08:00:00+08:00', likeCount: 20, commentCount: 2, favoriteCount: 2, shareCount: 2 },
];
assert.equal(snapshotMetricChange(videos[1], duplicateInstantSnapshots, 'likeCount').sampleCount, 1);

const missingEndpointSnapshots: AnalyticsSnapshotLike[] = [
  { accountId: 'account-a', videoId: 'v1', capturedAt: '2026-08-01T00:00:00Z', likeCount: null, commentCount: 1, favoriteCount: 1, shareCount: 1 },
  { accountId: 'account-a', videoId: 'v1', capturedAt: '2026-08-02T00:00:00Z', likeCount: 20, commentCount: 2, favoriteCount: 2, shareCount: 2 },
];
assert.equal(snapshotMetricChange(videos[1], missingEndpointSnapshots, 'likeCount').delta, null);

const summary = summarizeMetric(videos, 'likeCount');
assert.equal(summary.median, 35);
assert.equal(summary.previousAverage, 30);
assert.equal(summary.recentAverage, 40);
assert.equal(summary.recentDelta?.baseline, 30);
assert.equal(summary.recentDelta?.current, 40);
assert.equal(summary.recentDelta?.absolute, 10);
assert.ok(Math.abs((summary.recentDelta?.percentage ?? 0) - (100 / 3)) < 1e-10);
assert.equal(metricRank(videos[0], videos, 'likeCount'), 1);
assert.equal(metricRank(videos[2], videos, 'likeCount'), 2);

const tiedVideos = [video('t1', '2026-08-01T00:00:00Z', 100), video('t2', '2026-08-02T00:00:00Z', 80), video('t3', '2026-08-03T00:00:00Z', 80)];
assert.equal(metricRank(tiedVideos[1], tiedVideos, 'likeCount'), 2);
assert.equal(metricRank(tiedVideos[2], tiedVideos, 'likeCount'), 2);
assert.equal(metricRank(tiedVideos[1], [...tiedVideos, { ...video('other', '2026-08-04T00:00:00Z', 999), accountId: 'account-b' }], 'likeCount'), 2);

const shortSummary = summarizeMetric(videos.slice(0, 5), 'likeCount');
assert.equal(shortSummary.previousAverage, null);
assert.equal(shortSummary.recentDelta, null);

const mixedAccounts = [
  video('a-old', '2026-08-01T00:00:00Z', 1),
  { ...video('b-middle', '2026-08-02T00:00:00Z', 2), accountId: 'account-b' },
  video('a-new', '2026-08-03T00:00:00Z', 3),
];
assert.equal(previousPublishedVideo(mixedAccounts[2], mixedAccounts)?.id, 'a-old');

console.log('Video analytics validation passed: chronology, missing-value trend gaps, real zero points, snapshot growth, account isolation, zero baseline, correction, median, recent comparison, and ranking.');
