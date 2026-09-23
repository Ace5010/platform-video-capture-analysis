export type AnalyticsMetricKey = 'likeCount' | 'commentCount' | 'favoriteCount' | 'shareCount';

export type AnalyticsVideoLike = {
  id: string;
  accountId: string;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  likeCount: number | null;
  commentCount: number | null;
  favoriteCount: number | null;
  shareCount: number | null;
};

export type AnalyticsSnapshotLike = {
  accountId?: string;
  videoId: string;
  capturedAt: string;
  likeCount: number | null;
  commentCount: number | null;
  favoriteCount: number | null;
  shareCount: number | null;
};

export type NumericDelta = {
  baseline: number;
  current: number;
  absolute: number;
  percentage: number | null;
};

export type SnapshotMetricChange = {
  sampleCount: number;
  firstCapturedAt: string | null;
  latestCapturedAt: string | null;
  delta: NumericDelta | null;
};

export type MetricSummary = {
  median: number | null;
  validCount: number;
  totalCount: number;
  recentAverage: number | null;
  previousAverage: number | null;
  recentCount: number;
  previousCount: number;
  recentDelta: NumericDelta | null;
};

export function analyticsMetricValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function videoTimestamp(video: AnalyticsVideoLike): number {
  return timestamp(video.publishedAt)
    ?? timestamp(video.firstSeenAt)
    ?? timestamp(video.lastSeenAt)
    ?? 0;
}

export function orderVideosOldestFirst<T extends AnalyticsVideoLike>(videos: readonly T[]): T[] {
  return [...videos].sort((left, right) => {
    const difference = videoTimestamp(left) - videoTimestamp(right);
    if (difference !== 0) return difference;
    const firstSeenDifference = (timestamp(left.firstSeenAt) ?? 0) - (timestamp(right.firstSeenAt) ?? 0);
    return firstSeenDifference || left.id.localeCompare(right.id);
  });
}

// Keep a missing sample as a gap; zero is a real observation on the baseline.
// The caller supplies display order so point indices match the chart labels.
export function metricTrendSegments(
  videos: readonly AnalyticsVideoLike[],
  metricKey: AnalyticsMetricKey,
): { index: number; value: number }[][] {
  const segments: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  videos.forEach((video, index) => {
    const value = analyticsMetricValue(video[metricKey]);
    if (value === null) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push({ index, value });
  });
  if (current.length) segments.push(current);
  return segments;
}

export function calculateDelta(currentValue: unknown, baselineValue: unknown): NumericDelta | null {
  const current = analyticsMetricValue(currentValue);
  const baseline = analyticsMetricValue(baselineValue);
  if (current === null || baseline === null) return null;
  const absolute = current - baseline;
  const percentage = baseline === 0
    ? absolute === 0 ? 0 : null
    : (absolute / baseline) * 100;
  return { baseline, current, absolute, percentage };
}

export function snapshotMetricChange(
  video: AnalyticsVideoLike,
  snapshots: readonly AnalyticsSnapshotLike[],
  metricKey: AnalyticsMetricKey,
): SnapshotMetricChange {
  const byCapturedAt = new Map<number, AnalyticsSnapshotLike>();
  for (const snapshot of snapshots) {
    if (snapshot.videoId !== video.id) continue;
    if (snapshot.accountId && snapshot.accountId !== video.accountId) continue;
    const capturedAt = timestamp(snapshot.capturedAt);
    if (capturedAt === null) continue;
    byCapturedAt.set(capturedAt, snapshot);
  }
  const samples = [...byCapturedAt.values()].sort(
    (left, right) => (timestamp(left.capturedAt) ?? 0) - (timestamp(right.capturedAt) ?? 0),
  );
  const first = samples[0];
  const latest = samples.at(-1);
  return {
    sampleCount: samples.length,
    firstCapturedAt: first?.capturedAt ?? null,
    latestCapturedAt: latest?.capturedAt ?? null,
    delta: first && latest && samples.length >= 2
      ? calculateDelta(latest[metricKey], first[metricKey])
      : null,
  };
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function summarizeMetric(
  videos: readonly AnalyticsVideoLike[],
  metricKey: AnalyticsMetricKey,
): MetricSummary {
  const ordered = orderVideosOldestFirst(videos);
  const allValues = ordered.map((video) => analyticsMetricValue(video[metricKey])).filter((value): value is number => value !== null);
  const recentVideos = ordered.slice(-3);
  const previousVideos = ordered.length >= 6 ? ordered.slice(-6, -3) : [];
  const recentValues = recentVideos.map((video) => analyticsMetricValue(video[metricKey])).filter((value): value is number => value !== null);
  const previousValues = previousVideos.map((video) => analyticsMetricValue(video[metricKey])).filter((value): value is number => value !== null);
  const recentAverage = recentVideos.length === 3 && recentValues.length === 3 ? average(recentValues) : null;
  const previousAverage = previousVideos.length === 3 && previousValues.length === 3 ? average(previousValues) : null;
  return {
    median: median(allValues),
    validCount: allValues.length,
    totalCount: ordered.length,
    recentAverage,
    previousAverage,
    recentCount: recentValues.length,
    previousCount: previousValues.length,
    recentDelta: recentValues.length === 3 && previousValues.length === 3
      ? calculateDelta(recentAverage, previousAverage)
      : null,
  };
}

export function metricRank(
  video: AnalyticsVideoLike,
  videos: readonly AnalyticsVideoLike[],
  metricKey: AnalyticsMetricKey,
): number | null {
  const value = analyticsMetricValue(video[metricKey]);
  if (value === null) return null;
  return 1 + videos.reduce((count, candidate) => {
    if (candidate.accountId !== video.accountId) return count;
    const candidateValue = analyticsMetricValue(candidate[metricKey]);
    return count + (candidateValue !== null && candidateValue > value ? 1 : 0);
  }, 0);
}

export function previousPublishedVideo<T extends AnalyticsVideoLike>(
  video: T,
  videos: readonly T[],
): T | null {
  const ordered = orderVideosOldestFirst(videos.filter((candidate) => candidate.accountId === video.accountId));
  const index = ordered.findIndex((candidate) => candidate.id === video.id && candidate.accountId === video.accountId);
  return index > 0 ? ordered[index - 1] : null;
}
