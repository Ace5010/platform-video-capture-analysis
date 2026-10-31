export type ContentBrowseScope = 'all' | 'latest';
export type ContentResultFilter = 'all' | 'available' | 'missing';

/** Source metadata can contain a whole caption. Never use ASR or analysis as a heading. */
export function videoDisplayTitle(video: { title: string; description: string }): string {
  const source = (video.title.trim() || video.description.trim())
    .replace(/(?<![A-Za-z0-9])(?:#[^\s#]+)+/gu, '').trim();
  const firstLine = source.split(/\r?\n/u).find(line => line.trim())?.trim() || '';
  const text = firstLine.replace(/\s+/gu, ' ');
  const characters = Array.from(text);
  if (characters.length <= 48) return text || '未命名视频';

  // Prefer the source's opening sentence; preserve wording and never invent a summary.
  const opening = Array.from(text.match(/^.*?(?:[。！？!?]|\.{3,}|…+)/u)?.[0] || '');
  if (opening.length >= 8 && opening.length <= 48) return opening.join('');
  return characters.slice(0, 47).join('').trimEnd() + '…';
}

/** The feed shows only the source description, with a repeated title omitted. */
export function contentSourceDescription(video: { title: string; description: string }): string {
  const description = video.description.trim();
  const key = (text: string) => text.normalize('NFKC').toLowerCase()
    .replace(/#[^\s#]+/gu, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  const titleKey = key(video.title);
  const descriptionKey = key(description);
  if (!descriptionKey || (titleKey && titleKey.includes(descriptionKey))) return '';
  if (!titleKey || !descriptionKey.startsWith(titleKey)) return description;

  // Keep additional source text after its repeated opening title. Match using
  // normalized text, but return the original wording without rewriting it.
  let prefix = '';
  for (const character of description) {
    prefix += character;
    if (key(prefix).length >= titleKey.length) break;
  }
  const remainder = description.slice(prefix.length).replace(/^[\s:：,，;；.!！?？、。—–\-|｜·]+/u, '').trim();
  return key(remainder) ? remainder : '';
}

type BrowseVideo = {
  id: string;
  accountId: string;
  publishedAt: string | null;
  isLinkAnalysis?: boolean;
  transcript: string | null;
  analysis: unknown;
};
type BrowseAccount = { id: string; latestVideoIds?: string[] };

/** Newest publications first; unknown dates never borrow a collection timestamp. */
export function orderContentVideosNewestFirst<T extends { id: string; publishedAt: string | null }>(videos: readonly T[]): T[] {
  const publishedTime = (video: T) => {
    const time = Date.parse(video.publishedAt || '');
    return Number.isFinite(time) ? time : -Infinity;
  };
  return [...videos].sort((left, right) => {
    const leftTime = publishedTime(left), rightTime = publishedTime(right);
    return leftTime === rightTime ? left.id.localeCompare(right.id) : leftTime > rightTime ? -1 : 1;
  });
}

/** Content browsing only reads saved results; it never creates collection or analysis tasks. */
export function browseContentVideos<T extends BrowseVideo>(
  videos: readonly T[],
  accounts: readonly BrowseAccount[],
  options: { accountId: string; scope: ContentBrowseScope; result: ContentResultFilter },
): T[] {
  // A monitored video may also have a link-analysis entry. Its real account
  // ownership keeps it in this feed; standalone link records have a hidden account.
  const saved = videos.filter((video) => accounts.some((account) => account.id === video.accountId));
  const ordered = orderContentVideosNewestFirst(saved);
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
