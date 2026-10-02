export type FollowerReading = {
  followerCount?: number | null;
  followerDisplayText?: string | null;
  followerCountIsApproximate?: boolean;
  followerCountCapturedAt?: string | null;
};

/**
 * Follower counts are auxiliary account data. A reading is only usable when the
 * collector stored a valid non-negative integer or an explicit abbreviated
 * label together with the server time it was observed, so an unknown account
 * never displays a fabricated exact number.
 */
export function normalizeFollowerReading(raw: FollowerReading | null | undefined): {
  count: number | null;
  displayText: string | null;
  approximate: boolean;
  capturedAt: string | null;
} {
  if (!raw || typeof raw !== 'object') return { count: null, displayText: null, approximate: false, capturedAt: null };
  const capturedAt = typeof raw.followerCountCapturedAt === 'string' && raw.followerCountCapturedAt.trim()
    ? raw.followerCountCapturedAt
    : null;
  const count = typeof raw.followerCount === 'number' && Number.isSafeInteger(raw.followerCount) && raw.followerCount >= 0
    ? raw.followerCount
    : null;
  const displayText = typeof raw.followerDisplayText === 'string' && raw.followerDisplayText.trim()
    ? raw.followerDisplayText.trim()
    : null;
  return { count, displayText, approximate: raw.followerCountIsApproximate === true, capturedAt };
}

/** Compact Chinese follower label. Never invents exactness the source lacked. */
export function formatFollowerLabel(reading: FollowerReading | null | undefined): string {
  const { count, displayText, approximate } = normalizeFollowerReading(reading);
  if (approximate) {
    if (displayText) return `约${displayText}粉丝`;
    return '粉丝 —';
  }
  if (count === null) {
    if (displayText) return `${displayText}粉丝`;
    return '粉丝 —';
  }
  if (count >= 100_000_000) {
    const value = Math.round((count / 100_000_000) * 10) / 10;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}亿粉丝`;
  }
  if (count >= 10_000) {
    const value = Math.round((count / 10_000) * 10) / 10;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}万粉丝`;
  }
  return `${count}粉丝`;
}

/** The exact stored value, shown only where a tooltip can explain the precision. */
export function followerDetailText(reading: FollowerReading | null | undefined, capturedLabel: string): string {
  const { count, displayText, approximate, capturedAt } = normalizeFollowerReading(reading);
  if (count === null && !displayText) return '粉丝数量：尚未取得';
  const observed = capturedAt ? `，读取于 ${capturedLabel}` : '';
  if (approximate) {
    return `粉丝数量：平台只显示缩写${displayText ? ` ${displayText}` : ''}，未取得精确整数${observed}`;
  }
  return `粉丝数量：${count?.toLocaleString('zh-CN') ?? displayText}${observed}`;
}
