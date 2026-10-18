/** A Douyin profile is identified by its /user/ ID, independent of referral parameters. */
export function canonicalDouyinAccountUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))
      || (url.port && !['80', '443'].includes(url.port))) return null;
    const match = /^\/user\/([A-Za-z0-9._-]+)\/?$/.exec(decodeURIComponent(url.pathname));
    if (!match || ['.', '..'].includes(match[1])) return null;
    return `https://www.douyin.com/user/${match[1]}`;
  } catch {
    return null;
  }
}
