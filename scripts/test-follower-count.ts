import assert from 'node:assert/strict';
import { followerDetailText, formatFollowerLabel, normalizeFollowerReading } from '../lib/follower-count.ts';

const reading = (overrides: Record<string, unknown> = {}) => ({
  followerCount: null, followerDisplayText: null, followerCountIsApproximate: false,
  followerCountCapturedAt: '2026-10-01T00:00:00.000Z', ...overrides,
} as Parameters<typeof normalizeFollowerReading>[0]);

// Unknown stays unknown: never a fabricated zero and never a silent number.
assert.equal(formatFollowerLabel(null), '粉丝 —');
assert.equal(formatFollowerLabel(reading()), '粉丝 —');
assert.equal(formatFollowerLabel(reading({ followerCount: undefined })), '粉丝 —');

// A real zero is a valid observation, not a missing value.
assert.deepEqual(normalizeFollowerReading(reading({ followerCount: 0 })).count, 0);
assert.equal(formatFollowerLabel(reading({ followerCount: 0 })), '0粉丝');

// Exact values are grouped by Chinese units while staying precise in detail.
assert.equal(formatFollowerLabel(reading({ followerCount: 8652 })), '8652粉丝');
assert.equal(formatFollowerLabel(reading({ followerCount: 123_456 })), '12.3万粉丝');
assert.equal(formatFollowerLabel(reading({ followerCount: 12_000_000 })), '1200万粉丝');
assert.equal(formatFollowerLabel(reading({ followerCount: 230_000_000 })), '2.3亿粉丝');
assert.match(followerDetailText(reading({ followerCount: 123_456 }), '2026-10-01 08:00'), /123,456/);
assert.match(followerDetailText(reading({ followerCount: 123_456 }), '2026-10-01 08:00'), /2026-10-01 08:00/);

// An abbreviated label is displayed as approximate and never as a false exact number.
const approximate = reading({ followerDisplayText: '1.2万', followerCountIsApproximate: true });
assert.equal(formatFollowerLabel(approximate), '约1.2万粉丝');
assert.equal(normalizeFollowerReading(approximate).count, null);
assert.match(followerDetailText(approximate, '2026-10-01 08:00'), /缩写/);

// A decrease is reported as it was observed; the formatter never clamps growth.
assert.equal(formatFollowerLabel(reading({ followerCount: 9000 })), '9000粉丝');
assert.equal(formatFollowerLabel(reading({ followerCount: 1200 })), '1200粉丝');

// Invalid values are treated as no observation instead of becoming zero.
for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY, '1200', true]) {
  assert.equal(normalizeFollowerReading(reading({ followerCount: value as number })).count, null, String(value));
  assert.equal(formatFollowerLabel(reading({ followerCount: value as number })), '粉丝 —', String(value));
}

// A display-only label without the approximate flag still renders readably.
assert.equal(formatFollowerLabel(reading({ followerDisplayText: '3.4万' })), '3.4万粉丝');

// The stored capture time is preserved so a late response can be rejected.
assert.equal(normalizeFollowerReading(reading()).capturedAt, '2026-10-01T00:00:00.000Z');
assert.equal(normalizeFollowerReading(reading({ followerCountCapturedAt: '' })).capturedAt, null);
assert.equal(normalizeFollowerReading(reading({ followerCountCapturedAt: 5 as unknown as string })).capturedAt, null);

console.log('Follower count check passed: unknown, real zero, exact, 万/亿, approximate, decrease and invalid values.');
