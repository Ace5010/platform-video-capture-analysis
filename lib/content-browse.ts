export type ContentBrowseScope = 'all' | 'latest';
export type ContentResultFilter = 'all' | 'available' | 'missing';

type BrowseVideo = {
  id: string;
  accountId: string;
  publishedAt: string | null;
  isLinkAnalysis?: boolean;
  transcript: string | null;
  analysis: unknown;
};
type BrowseAccount = { id: string; latestVideoIds?: string[] };

/** Content browsing only reads saved results; it never creates collection or analysis tasks. */
export function browseContentVideos<T extends BrowseVideo>(
  videos: readonly T[],
  accounts: readonly BrowseAccount[],
  options: { accountId: string; scope: ContentBrowseScope; result: ContentResultFilter },
): T[] {
  // A monitored video may also have a link-analysis entry. Its real account
  // ownership keeps it in this feed; standalone link records have a hidden account.
  const saved = videos.filter((video) => accounts.some((account) => account.id === video.accountId));
  const ordered = [...saved].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id));
  const latestIds = new Map(accounts.map((account) => [account.id, new Set(
    account.latestVideoIds?.length ? account.latestVideoIds.slice(0, 5)
      : ordered.filter((video) => video.accountId === account.id).slice(0, 5).map((video) => video.id),
  )]));
  return ordered.filter((video) => {
    if (options.accountId && video.accountId !== options.accountId) return false;
    if (options.scope === 'latest' && !latestIds.get(video.accountId)?.has(video.id)) return false;
    const hasResult = Boolean(video.transcript?.trim() || video.analysis);
    return options.result === 'all' || (options.result === 'available' ? hasResult : !hasResult);
  });
}

export function collectionAccountScope(page: string, contentAccountId: string, analyticsAccountId: string): string {
  if (page === '内容浏览') return contentAccountId;
  if (page === '互动数据') return analyticsAccountId;
  return '';
}
