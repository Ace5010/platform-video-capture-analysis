'use client';

/* eslint-disable @next/next/no-img-element -- 抖音封面是运行时采集的外部地址，不能预先配置图片域名。 */

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type AccountStatus = 'waiting' | 'checking' | 'ready' | 'error';
type TranscriptStatus = 'idle' | 'processing' | 'ready' | 'error';
type SyncMode = 'initial' | 'latest';
type InitialSyncStatus = 'pending' | 'complete' | 'error';
type Platform = 'douyin' | 'xiaohongshu' | 'bilibili' | 'youtube';
type SchedulerRunStatus = 'never' | 'waiting' | 'running' | 'success' | 'partial' | 'error' | 'skipped';

type Account = {
  id: string;
  platform: Platform;
  url: string;
  name: string;
  avatarUrl: string | null;
  addedAt: string;
  lastCheckedAt: string | null;
  status: AccountStatus;
  initialSyncStatus: InitialSyncStatus;
  initialSyncCompletedAt: string | null;
  latestVideoIds: string[];
  currentSyncMode: SyncMode | null;
};

type Video = {
  id: string;
  accountId: string;
  title: string;
  description: string;
  url: string;
  coverUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  likeCount: number | null;
  commentCount: number | null;
  favoriteCount: number | null;
  shareCount: number | null;
  capturedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptUpdatedAt: string | null;
  transcriptError: string | null;
};

type Snapshot = {
  accountId?: string;
  videoId: string;
  likeCount: number | null;
  commentCount: number | null;
  favoriteCount: number | null;
  shareCount: number | null;
  capturedAt: string;
};

type CollectionMessage = {
  eventId?: string;
  messageId?: string;
  accountId?: string;
  accountUrl?: string;
  accountName?: string;
  accountAvatarUrl?: string;
  capturedAt?: string;
  videos?: Array<Partial<Video> & Pick<Video, 'id' | 'accountId' | 'url'>>;
  warning?: string;
  mode?: SyncMode;
};

type SchedulerState = {
  enabled: boolean;
  alarmRegistered: boolean;
  periodMinutes: number;
  monitoredAccountCount: number;
  registeredAt: string | null;
  checkedAt: string | null;
  nextRunAt: string | null;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: SchedulerRunStatus;
  lastTrigger: 'alarm' | 'catch-up' | null;
  lastError: string | null;
  missedRunRecoveredAt: string | null;
};

const navItems = [
  ['⌂', '主页仪表盘'],
  ['◎', '对标账号'],
  ['▣', '最新视频'],
  ['⌁', '总数据分析'],
];

type PlatformMeta = {
  name: string;
  tagline: string;
  enabled: boolean;
  icon: React.ReactNode;
};

function PlatformIcon({ platform, alt }: { platform: Platform; alt: string }) {
  return <img className="platformIcon" src={`/platform-icons/${platform}.png`} alt={alt} draggable={false} />;
}

const PLATFORMS: Record<Platform, PlatformMeta> = {
  douyin: { name: '抖音', tagline: '对标账号的监控与分析', enabled: true, icon: <PlatformIcon platform="douyin" alt="抖音" /> },
  xiaohongshu: { name: '小红书', tagline: '对标账号的监控与分析', enabled: false, icon: <PlatformIcon platform="xiaohongshu" alt="小红书" /> },
  bilibili: { name: '哔哩哔哩', tagline: '对标账号的监控与分析', enabled: false, icon: <PlatformIcon platform="bilibili" alt="哔哩哔哩" /> },
  youtube: { name: 'YouTube', tagline: '对标账号的监控与分析', enabled: false, icon: <PlatformIcon platform="youtube" alt="YouTube" /> },
};

const accountStoreKey = 'douyin-monitor.accounts.v1';
const videoStoreKey = 'douyin-monitor.videos.v1';
const snapshotStoreKey = 'douyin-monitor.snapshots.v2';
const processedResultStoreKey = 'douyin-monitor.processed-results.v1';
const activePlatformStoreKey = 'douyin-monitor.active-platform.v1';
const selectedAccountStoreKey = 'douyin-monitor.selected-account.v1';
const requiredExtensionVersion = '0.5.0';

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeAccount(raw: Partial<Account>, index: number): Account {
  const initialSyncStatus = raw.initialSyncStatus === 'complete' || raw.initialSyncStatus === 'error'
    ? raw.initialSyncStatus
    : 'pending';
  return {
    id: String(raw.id || crypto.randomUUID()),
    platform: raw.platform || 'douyin',
    url: String(raw.url || ''),
    name: String(raw.name || `待识别账号 ${index + 1}`),
    avatarUrl: typeof raw.avatarUrl === 'string' && raw.avatarUrl ? raw.avatarUrl : null,
    addedAt: raw.addedAt || new Date().toISOString(),
    lastCheckedAt: raw.lastCheckedAt || null,
    status: initialSyncStatus === 'complete' ? (raw.status || 'ready') : 'waiting',
    initialSyncStatus,
    initialSyncCompletedAt: raw.initialSyncCompletedAt || null,
    latestVideoIds: Array.isArray(raw.latestVideoIds) ? raw.latestVideoIds.map(String).slice(0, 3) : [],
    currentSyncMode: null,
  };
}

function normalizeVideo(raw: Partial<Video>, capturedAt = new Date().toISOString()): Video {
  const previousTranscript = typeof raw.transcript === 'string' && raw.transcript.trim() ? raw.transcript : null;
  const seenAt = raw.capturedAt || raw.lastSeenAt || capturedAt;
  return {
    id: String(raw.id || ''),
    accountId: String(raw.accountId || ''),
    title: String(raw.title || raw.description || '未命名视频'),
    description: String(raw.description || raw.title || ''),
    url: String(raw.url || ''),
    coverUrl: raw.coverUrl || null,
    publishedAt: raw.publishedAt || null,
    durationSeconds: nullableNumber(raw.durationSeconds),
    likeCount: nullableNumber(raw.likeCount),
    commentCount: nullableNumber(raw.commentCount),
    favoriteCount: nullableNumber(raw.favoriteCount),
    shareCount: nullableNumber(raw.shareCount),
    capturedAt: seenAt,
    firstSeenAt: raw.firstSeenAt || seenAt,
    lastSeenAt: raw.lastSeenAt || seenAt,
    transcript: previousTranscript,
    transcriptStatus: previousTranscript ? 'ready' : (raw.transcriptStatus === 'processing' ? 'idle' : (raw.transcriptStatus || 'idle')),
    transcriptUpdatedAt: raw.transcriptUpdatedAt || null,
    transcriptError: raw.transcriptError || null,
  };
}

function formatTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function formatMetric(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatDuration(value: number | null) {
  if (value === null) return null;
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function schedulerRunLabel(status: SchedulerRunStatus | undefined) {
  if (status === 'running') return '正在自动采集';
  if (status === 'success') return '运行成功';
  if (status === 'partial') return '部分账号失败';
  if (status === 'error') return '运行失败';
  if (status === 'skipped') return '由同期手动采集替代';
  if (status === 'waiting') return '等待已建档账号';
  return '尚未运行';
}

export default function Home() {
  const [activeNav, setActiveNav] = useState('主页仪表盘');
  const [activePlatform, setActivePlatform] = useState<Platform>(() => {
    const stored = readStored<string>(activePlatformStoreKey, '');
    return stored === 'douyin' || stored === 'xiaohongshu' || stored === 'bilibili' || stored === 'youtube'
      ? stored
      : 'douyin';
  });
  const [platformMenuOpen, setPlatformMenuOpen] = useState(false);
  const platformMenuRef = useRef<HTMLDivElement>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accountUrl, setAccountUrl] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [videos, setVideos] = useState<Video[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null);
  const [bridgeNeedsReload, setBridgeNeedsReload] = useState(false);
  const [schedulerState, setSchedulerState] = useState<SchedulerState | null>(null);
  const [progress, setProgress] = useState(0);
  const [isCollecting, setIsCollecting] = useState(false);
  const [expandedTranscripts, setExpandedTranscripts] = useState<Set<string>>(new Set());
  const processedResultIds = useRef<Set<string>>(new Set());
  const autoStartedInitialAccounts = useRef<Set<string>>(new Set());

  useEffect(() => {
    processedResultIds.current = new Set(readStored<string[]>(processedResultStoreKey, []));
    const frame = window.requestAnimationFrame(() => {
      const storedAccounts = readStored<Partial<Account>[]>(accountStoreKey, []);
      const normalizedAccounts = Array.isArray(storedAccounts) ? storedAccounts.map(normalizeAccount) : [];
      const storedSelectedAccountId = readStored<string>(selectedAccountStoreKey, '');
      setAccounts(normalizedAccounts);
      setSelectedAccountId(normalizedAccounts.some((account) => account.id === storedSelectedAccountId)
        ? storedSelectedAccountId
        : normalizedAccounts[0]?.id || '');
      const storedVideos = readStored<Partial<Video>[]>(videoStoreKey, []);
      setVideos(Array.isArray(storedVideos) ? storedVideos.map((video) => normalizeVideo(video)) : []);
      const legacySnapshots = readStored<Snapshot[]>('douyin-monitor.snapshots.v1', []);
      setSnapshots(readStored<Snapshot[]>(snapshotStoreKey, legacySnapshots));
      setLoaded(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(accountStoreKey, JSON.stringify(accounts));
  }, [accounts, loaded]);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(videoStoreKey, JSON.stringify(videos));
  }, [videos, loaded]);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(snapshotStoreKey, JSON.stringify(snapshots));
  }, [snapshots, loaded]);

  useEffect(() => {
    window.localStorage.setItem(activePlatformStoreKey, JSON.stringify(activePlatform));
  }, [activePlatform]);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(selectedAccountStoreKey, JSON.stringify(selectedAccountId));
  }, [loaded, selectedAccountId]);

  useEffect(() => {
    if (!platformMenuOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (platformMenuRef.current && !platformMenuRef.current.contains(event.target as Node)) {
        setPlatformMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlatformMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [platformMenuOpen]);

  useEffect(() => {
    if (!loaded) return;
    const applyCollectionResult = (payload: CollectionMessage) => {
      const eventId = payload.eventId || payload.messageId;
      if (eventId && processedResultIds.current.has(eventId)) {
        window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', eventIds: [eventId] }, window.location.origin);
        return;
      }

      const capturedAt = payload.capturedAt || new Date().toISOString();
      const collected = Array.isArray(payload.videos)
        ? payload.videos.filter((video) => video?.id && video?.url).map((video) => normalizeVideo(video, capturedAt))
        : [];

      if (!collected.length) {
        setAccounts((current) => current.map((account) => account.id === payload.accountId ? {
          ...account,
          status: 'error',
          initialSyncStatus: payload.mode === 'initial' ? 'error' : account.initialSyncStatus,
          currentSyncMode: null,
        } : account));
        setNotice('采集失败：页面没有返回任何可用视频，未写入空结果');
        if (eventId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', eventIds: [eventId] }, window.location.origin);
        return;
      }

      setVideos((current) => {
        const authoritativeAccountId = payload.accountId || collected[0]?.accountId;
        const keyFor = (video: Pick<Video, 'accountId' | 'id'>) => `${video.accountId}:${video.id}`;
        const previousById = new Map(current.map((video) => [keyFor(video), video]));
        const retained = payload.mode === 'initial' && authoritativeAccountId
          ? current.filter((video) => video.accountId !== authoritativeAccountId)
          : current;
        const byId = new Map(retained.map((video) => [keyFor(video), video]));
        for (const incoming of collected) {
          const key = keyFor(incoming);
          const previous = previousById.get(key);
          byId.set(key, {
            ...incoming,
            firstSeenAt: previous?.firstSeenAt || incoming.firstSeenAt,
            transcript: previous?.transcript || incoming.transcript,
            transcriptStatus: previous?.transcriptStatus === 'ready' ? 'ready' : incoming.transcriptStatus,
            transcriptUpdatedAt: previous?.transcriptUpdatedAt || incoming.transcriptUpdatedAt,
            transcriptError: previous?.transcriptError || incoming.transcriptError,
          });
        }
        return [...byId.values()].sort((a, b) => (b.publishedAt || b.lastSeenAt).localeCompare(a.publishedAt || a.lastSeenAt));
      });
      setSnapshots((current) => [
        ...(payload.mode === 'initial' && payload.accountId
          ? current.filter((snapshot) => snapshot.accountId !== payload.accountId)
          : current),
        ...collected.map((video) => ({
        accountId: video.accountId,
        videoId: video.id,
        likeCount: video.likeCount,
        commentCount: video.commentCount,
        favoriteCount: video.favoriteCount,
        shareCount: video.shareCount,
        capturedAt,
      })),
      ]);
      setAccounts((current) => current.map((account) => payload.accountId === account.id ? {
        ...account,
        name: payload.accountName || account.name,
        avatarUrl: payload.accountAvatarUrl || account.avatarUrl,
        lastCheckedAt: capturedAt,
        status: 'ready',
        initialSyncStatus: payload.mode === 'initial' ? 'complete' : account.initialSyncStatus,
        initialSyncCompletedAt: payload.mode === 'initial' ? capturedAt : account.initialSyncCompletedAt,
        latestVideoIds: collected.slice(0, 3).map((video) => video.id),
        currentSyncMode: null,
      } : account));
      setProgress(100);
      setActiveNav(payload.mode === 'initial' ? '总数据分析' : '最新视频');
      setNotice(payload.warning || `采集完成，已更新 ${collected.length} 条视频数据`);

      if (eventId) {
        processedResultIds.current.add(eventId);
        window.localStorage.setItem(processedResultStoreKey, JSON.stringify([...processedResultIds.current]));
        window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', eventIds: [eventId] }, window.location.origin);
      }
    };

    const applyTranscriptResult = (payload: CollectionMessage & { videoId?: string; transcript?: string; completedAt?: string; updatedAt?: string }) => {
      if (!payload.videoId) return;
      setVideos((current) => current.map((video) => video.id === payload.videoId ? {
        ...video,
        transcript: String(payload.transcript || '').trim(),
        transcriptStatus: 'ready',
        transcriptUpdatedAt: payload.updatedAt || payload.completedAt || new Date().toISOString(),
        transcriptError: null,
      } : video));
      setExpandedTranscripts((current) => new Set(current).add(payload.videoId as string));
      setNotice('口播稿已完成本地识别');
      if (payload.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [payload.messageId] }, window.location.origin);
    };

    const applyTranscriptError = (payload: CollectionMessage & { videoId?: string; message?: string }) => {
      if (!payload.videoId) return;
      setVideos((current) => current.map((video) => video.id === payload.videoId ? {
        ...video,
        transcriptStatus: 'error',
        transcriptError: payload.message || '本地识别失败',
      } : video));
      setExpandedTranscripts((current) => new Set(current).add(payload.videoId as string));
      setNotice(payload.message || '口播稿提取失败');
      if (payload.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [payload.messageId] }, window.location.origin);
    };

    const applyAccountProfileResult = (payload: CollectionMessage) => {
      const avatarUrl = typeof payload.accountAvatarUrl === 'string' ? payload.accountAvatarUrl.trim() : '';
      if (!avatarUrl) return;
      setAccounts((current) => current.map((account) => {
        const matches = payload.accountId
          ? account.id === payload.accountId
          : Boolean(payload.accountUrl && account.url === payload.accountUrl);
        return matches ? {
          ...account,
          name: payload.accountName || account.name,
          avatarUrl,
        } : account;
      }));
    };

    const handshakeTimer = window.setTimeout(() => setBridgeNeedsReload(true), 1800);
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data?.source !== 'douyin-monitor-extension') return;
      if (event.data.type === 'BRIDGE_READY') {
        setBridgeReady(true);
        if (event.data.schedulerState) setSchedulerState(event.data.schedulerState as SchedulerState);
        if (event.data.extensionVersion) {
          setBridgeVersion(event.data.extensionVersion);
          setBridgeNeedsReload(event.data.extensionVersion !== requiredExtensionVersion);
          window.clearTimeout(handshakeTimer);
        }
      }
      if (event.data.type === 'SCHEDULER_STATE' && event.data.schedulerState) {
        setSchedulerState(event.data.schedulerState as SchedulerState);
      }
      if (event.data.type === 'SYNC_STATE') {
        const pending = Array.isArray(event.data.pendingResults) ? event.data.pendingResults : [];
        pending.forEach((result: CollectionMessage & { type?: string }) => {
          if (result.type === 'COLLECTION_RESULT') applyCollectionResult(result);
          else if (result.type === 'TRANSCRIPT_RESULT') applyTranscriptResult(result);
          else if (result.type === 'TRANSCRIPT_ERROR') applyTranscriptError(result);
          else if (result.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [result.messageId] }, window.location.origin);
        });
      }
      if (event.data.type === 'COLLECTION_STARTED') {
        setIsCollecting(true);
        setAccounts((current) => current.map((account) => account.id === event.data.accountId ? {
          ...account,
          status: 'checking',
          currentSyncMode: event.data.mode || (account.initialSyncStatus === 'complete' ? 'latest' : 'initial'),
        } : account));
        if (event.data.accountName) {
          setNotice(event.data.mode === 'initial'
            ? `正在为 ${event.data.accountName} 建立近 30 条视频档案`
            : `正在检查 ${event.data.accountName} 最新 3 条视频`);
        }
      }
      if (event.data.type === 'COLLECTION_PROGRESS') {
        setProgress(event.data.progress ?? 0);
        if (event.data.stage === 'complete' && event.data.progress === 100) setIsCollecting(false);
      }
      if (event.data.type === 'COLLECTION_ERROR') {
        if (!event.data.accountId) setIsCollecting(false);
        setAccounts((current) => current.map((account) => account.id === event.data.accountId ? {
          ...account,
          status: 'error',
          initialSyncStatus: event.data.mode === 'initial' ? 'error' : account.initialSyncStatus,
          currentSyncMode: null,
        } : account));
        setNotice(event.data.message ?? '采集失败，请稍后重试');
        if (event.data.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [event.data.messageId] }, window.location.origin);
      }
      if (event.data.type === 'COLLECTION_RESULT') applyCollectionResult(event.data);
      if (event.data.type === 'ACCOUNT_PROFILE_RESULT') applyAccountProfileResult(event.data);
      if (event.data.type === 'TRANSCRIPT_PROGRESS') {
        setVideos((current) => current.map((video) => video.id === event.data.videoId ? { ...video, transcriptStatus: 'processing', transcriptError: null } : video));
      }
      if (event.data.type === 'TRANSCRIPT_RESULT') {
        applyTranscriptResult(event.data);
      }
      if (event.data.type === 'TRANSCRIPT_ERROR') {
        applyTranscriptError(event.data);
      }
    };
    window.addEventListener('message', receive);
    window.postMessage({ source: 'douyin-monitor', type: 'PING' }, window.location.origin);
    return () => {
      window.clearTimeout(handshakeTimer);
      window.removeEventListener('message', receive);
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded || !bridgeReady || bridgeNeedsReload || bridgeVersion !== requiredExtensionVersion) return;
    window.postMessage({
      source: 'douyin-monitor',
      type: 'SYNC_ACCOUNTS',
      accounts,
    }, window.location.origin);
  }, [accounts, bridgeNeedsReload, bridgeReady, bridgeVersion, loaded]);

  useEffect(() => {
    if (!loaded || !bridgeReady || bridgeNeedsReload || bridgeVersion !== requiredExtensionVersion || isCollecting) return;
    const pending = accounts.filter((account) => account.initialSyncStatus === 'pending'
      && !autoStartedInitialAccounts.current.has(account.id));
    if (!pending.length) return;
    pending.forEach((account) => autoStartedInitialAccounts.current.add(account.id));
    setIsCollecting(true);
    setProgress(2);
    setAccounts((current) => current.map((account) => pending.some((item) => item.id === account.id) ? {
      ...account,
      status: 'checking',
      currentSyncMode: 'initial',
    } : account));
    window.postMessage({
      source: 'douyin-monitor',
      type: 'CHECK_ALL',
      accounts: pending.map((account) => ({ ...account, syncMode: 'initial' })),
      allAccounts: accounts,
    }, window.location.origin);
    setNotice(`首次建档已启动：将抓取 ${pending.length} 个账号各近 30 条非置顶视频`);
  }, [accounts, bridgeNeedsReload, bridgeReady, bridgeVersion, isCollecting, loaded]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const todayStart = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }, []);

  const todayVideos = videos.filter((video) => new Date(video.firstSeenAt).getTime() >= todayStart).length;
  const lastChecked = accounts
    .map((account) => account.lastCheckedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) || accounts[0] || null,
    [accounts, selectedAccountId],
  );
  const selectedAccountVideos = useMemo(
    () => selectedAccount ? videos.filter((video) => video.accountId === selectedAccount.id) : [],
    [selectedAccount, videos],
  );
  const latestVideos = useMemo(() => {
    if (!selectedAccount) return [];
    const byId = new Map(selectedAccountVideos.map((video) => [video.id, video]));
    const ids = selectedAccount.latestVideoIds.length
      ? selectedAccount.latestVideoIds
      : [...selectedAccountVideos]
        .sort((a, b) => (b.publishedAt || b.lastSeenAt).localeCompare(a.publishedAt || a.lastSeenAt))
        .slice(0, 3)
        .map((video) => video.id);
    return ids
      .map((id) => byId.get(id))
      .filter((video): video is Video => Boolean(video))
      .sort((a, b) => (b.publishedAt || b.lastSeenAt).localeCompare(a.publishedAt || a.lastSeenAt));
  }, [selectedAccount, selectedAccountVideos]);
  const extensionReady = bridgeReady && !bridgeNeedsReload && bridgeVersion === requiredExtensionVersion;

  const startInitialSync = (account: Account, allAccounts = accounts) => {
    if (!bridgeReady) {
      setNotice('账号已保存；Chrome 采集组件尚未连接，连接后请点击“首次抓取近 30 条”');
      return false;
    }
    if (!extensionReady) {
      setNotice(`账号已保存；Chrome 采集组件需要刷新到 v${requiredExtensionVersion}，刷新后请点击“首次抓取近 30 条”`);
      return false;
    }
    if (isCollecting) {
      setNotice('当前采集仍在进行，请等待完成');
      return false;
    }
    autoStartedInitialAccounts.current.add(account.id);
    setIsCollecting(true);
    setProgress(2);
    setAccounts((current) => current.map((item) => item.id === account.id ? {
      ...item,
      status: 'checking',
      initialSyncStatus: 'pending',
      currentSyncMode: 'initial',
    } : item));
    window.postMessage({
      source: 'douyin-monitor',
      type: 'CHECK_ALL',
      accounts: [{ ...account, initialSyncStatus: 'pending', syncMode: 'initial' }],
      allAccounts,
    }, window.location.origin);
    setNotice(`正在为 ${account.name} 首次抓取近 30 条非置顶视频`);
    return true;
  };

  const submitAccount = (event: FormEvent) => {
    event.preventDefault();
    const value = accountUrl.trim();
    try {
      const parsed = new URL(value);
      if (!parsed.hostname.endsWith('douyin.com') || !parsed.pathname.includes('/user/')) throw new Error('invalid');
      if (accounts.some((account) => account.url === value)) {
        setNotice('这个账号已经在监控列表中');
        return;
      }
      const account: Account = {
        id: crypto.randomUUID(),
        platform: 'douyin',
        url: value,
        name: `待识别账号 ${accounts.length + 1}`,
        avatarUrl: null,
        addedAt: new Date().toISOString(),
        lastCheckedAt: null,
        status: 'waiting',
        initialSyncStatus: 'pending',
        initialSyncCompletedAt: null,
        latestVideoIds: [],
        currentSyncMode: null,
      };
      const nextAccounts = [...accounts, account];
      setAccounts(nextAccounts);
      setSelectedAccountId(account.id);
      setAccountUrl('');
      setShowAddAccount(false);
      if (!startInitialSync(account, nextAccounts)) {
        setNotice(extensionReady
          ? '账号已添加，可在账号卡片点击“首次抓取近 30 条”'
          : `账号已添加，但采集尚未启动；请先连接或刷新 Chrome 组件到 v${requiredExtensionVersion}`);
      }
    } catch {
      setNotice('请输入正确的抖音账号主页链接');
    }
  };

  const requestCheck = () => {
    if (!accounts.length) {
      setShowAddAccount(true);
      return;
    }
    if (!bridgeReady) {
      setNotice('Chrome 采集组件尚未连接，请重新加载浏览器组件');
      return;
    }
    if (bridgeNeedsReload || bridgeVersion !== requiredExtensionVersion) {
      setNotice(`Chrome 采集组件需要刷新到 v${requiredExtensionVersion}，请在 chrome://extensions 点击扩展卡片的“刷新”`);
      return;
    }
    if (isCollecting) {
      setNotice('当前采集仍在进行，请等待完成');
      return;
    }
    const initializedAccounts = accounts.filter((account) => account.initialSyncStatus === 'complete');
    if (!initializedAccounts.length) {
      setNotice('请先在账号卡片点击“首次抓取近 30 条”，完成建档后才能检查最新 3 条');
      return;
    }
    const requestedAccounts = initializedAccounts.map((account) => ({
      ...account,
      syncMode: 'latest' as const,
    }));
    setIsCollecting(true);
    setAccounts((current) => current.map((account) => initializedAccounts.some((item) => item.id === account.id) ? {
      ...account,
      status: 'checking',
      currentSyncMode: 'latest',
    } : account));
    setProgress(2);
    window.postMessage({ source: 'douyin-monitor', type: 'CHECK_ALL', accounts: requestedAccounts, allAccounts: accounts }, window.location.origin);
    setNotice('已开始检查，每个已建档账号只读取最新 3 条非置顶视频');
  };

  const requestTranscript = (video: Video, force = false) => {
    if (video.transcriptStatus === 'processing') return;
    if (video.transcript && !force) {
      setExpandedTranscripts((current) => {
        const next = new Set(current);
        if (next.has(video.id)) next.delete(video.id); else next.add(video.id);
        return next;
      });
      return;
    }
    if (!bridgeReady) {
      setNotice('Chrome 采集组件尚未连接，无法提取音频');
      return;
    }
    if (bridgeNeedsReload || bridgeVersion !== requiredExtensionVersion) {
      setNotice(`Chrome 采集组件需要刷新到 v${requiredExtensionVersion}，请在 chrome://extensions 点击扩展卡片的“刷新”`);
      return;
    }
    setVideos((current) => current.map((item) => item.id === video.id ? { ...item, transcriptStatus: 'processing', transcriptError: null } : item));
    setExpandedTranscripts((current) => new Set(current).add(video.id));
    window.postMessage({
      source: 'douyin-monitor',
      type: 'EXTRACT_TRANSCRIPT',
      video: { id: video.id, url: video.url, title: video.title },
    }, window.location.origin);
    setNotice('正在提取临时音频并进行本地识别，首次使用会下载识别模型');
  };

  const removeAccount = (id: string) => {
    const removedVideoIds = new Set(videos.filter((video) => video.accountId === id).map((video) => video.id));
    const nextAccounts = accounts.filter((account) => account.id !== id);
    setAccounts(nextAccounts);
    if (selectedAccount?.id === id) setSelectedAccountId(nextAccounts[0]?.id || '');
    setVideos((current) => current.filter((video) => video.accountId !== id));
    setSnapshots((current) => current.filter((snapshot) => snapshot.accountId !== id && !removedVideoIds.has(snapshot.videoId)));
    setNotice('账号及其本地记录已移除');
  };

  const statCards = [
    ['监控账号', accounts.length, accounts.length ? '账号数量不设上限' : null],
    ['已采集视频总数', videos.length, lastChecked ? `${snapshots.filter((snapshot) => snapshot.accountId).length} 份有效快照 · ${formatTime(lastChecked)}` : null],
    ['今日新增', todayVideos, null],
  ];

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMarkWrap" ref={platformMenuRef}>
            <button
              type="button"
              className="brandMark"
              aria-label={`切换平台（当前：${PLATFORMS[activePlatform].name}）`}
              aria-haspopup="menu"
              aria-expanded={platformMenuOpen}
              onClick={() => setPlatformMenuOpen((open) => !open)}
            >
              {PLATFORMS[activePlatform].icon}
            </button>
            {platformMenuOpen && (
              <div className="platformMenu" role="menu" aria-label="选择平台">
                <p className="platformMenuLabel">选择平台</p>
                {(Object.keys(PLATFORMS) as Platform[]).map((platform) => {
                  const meta = PLATFORMS[platform];
                  const isActive = platform === activePlatform;
                  return (
                    <button
                      key={platform}
                      type="button"
                      role="menuitem"
                      className={`platformMenuItem ${isActive ? 'active' : ''}`}
                      disabled={!meta.enabled}
                      onClick={() => {
                        setActivePlatform(platform);
                        setPlatformMenuOpen(false);
                      }}
                    >
                      <span className="platformMenuItemIcon">{meta.icon}</span>
                      <span className="platformMenuItemText"><b>{meta.name}</b><small>{meta.enabled ? (isActive ? '当前平台' : '已启用') : '即将支持'}</small></span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="brandText"><strong>{PLATFORMS[activePlatform].name}</strong><small>{PLATFORMS[activePlatform].tagline}</small></div>
        </div>
        <nav className="navigation" aria-label="主导航">
          <p className="navLabel">工作区</p>
          {navItems.map(([icon, label]) => (
            <button className={activeNav === label ? 'navItem active' : 'navItem'} key={label} onClick={() => setActiveNav(label)}>
              <span className="navIcon">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebarFoot">
          <div className={bridgeReady && !bridgeNeedsReload ? 'localStatus connected' : 'localStatus'}><i /><span><b>数据仅存本机</b><small>{bridgeNeedsReload ? `Chrome 组件需刷新到 v${requiredExtensionVersion}` : bridgeReady ? `Chrome 已连接${bridgeVersion ? ` · v${bridgeVersion}` : ''}` : 'Chrome 等待连接'}</small></span></div>
          <button className="settingsButton">⚙ 每 6 小时检查</button>
        </div>
      </aside>

      <section className="workspace">
        {activePlatform === 'douyin' && (
          <>
            <header className="topbar">
              <div>
                <p className="eyebrow">CONTENT INTELLIGENCE</p>
                <h1>{activeNav}</h1>
                <p className="subtitle">首次建档近 30 条 · 日常只查最新 3 条 · 每 6 小时运行</p>
              </div>
              <div className="topActions">
                <div className="nextRun"><span>下次后台检查</span><b>{schedulerState?.nextRunAt ? formatTime(schedulerState.nextRunAt) : '等待组件'}</b></div>
                <button className="secondaryButton" onClick={requestCheck} disabled={isCollecting}>{isCollecting ? '检查中…' : '检查最新 3 条'}</button>
                <button className="primaryButton" onClick={() => setShowAddAccount(true)}>＋ 添加新监控账号</button>
              </div>
            </header>

            {activeNav === '主页仪表盘' && (
              <>
                <div className="statsGrid">
                  {statCards.map(([label, value, detail]) => (
                    <article className="statCard" key={String(label)}>
                      <div className="statLabel"><span>{label}</span><i /></div>
                      <strong>{value}</strong>
                      {detail ? <small>{detail}</small> : null}
                    </article>
                  ))}
                </div>
                <article className="collectionPanel">
                  <div className="collectionHeader">
                    <div><p className="liveLabel"><i /> LOCAL COLLECTION</p><h2>采集任务</h2><span>{bridgeNeedsReload ? '' : bridgeReady ? schedulerState?.alarmRegistered ? 'Chrome 后台调度已注册，关闭工作台网页后仍会继续计时' : accounts.some((account) => account.initialSyncStatus !== 'complete') ? '待完成首次建档：每个账号近 30 条非置顶视频' : '正在核验 6 小时后台调度' : accounts.length ? '等待 Chrome 采集组件连接' : '添加账号后自动完成首次建档'}</span></div>
                    <div className="progressValue"><span>PROGRESS</span><b>{progress}%</b></div>
                  </div>
                  <div className="progressTrack"><span style={{ width: `${Math.max(progress, 2)}%` }} /></div>
                  <div className="progressMarks"><span>等待开始</span><span>定位账号</span><span>读取公开数据</span><span>去重完成</span></div>
                  <div className="schedulerStatusGrid">
                    <span><small>后台调度</small><b className={schedulerState?.alarmRegistered ? 'schedulerHealthy' : ''}>{schedulerState?.alarmRegistered ? '已启用 · 每 6 小时' : '等待 Chrome 核验'}</b></span>
                    <span><small>后台监控账号</small><b>{schedulerState ? `${schedulerState.monitoredAccountCount} 个已建档账号` : '—'}</b></span>
                    <span><small>上次自动运行</small><b>{schedulerState?.lastAttemptAt ? `${formatTime(schedulerState.lastAttemptAt)} · ${schedulerRunLabel(schedulerState.lastRunStatus)}` : schedulerRunLabel(schedulerState?.lastRunStatus)}</b></span>
                    <span><small>下次计划时间</small><b>{schedulerState?.nextRunAt ? formatTime(schedulerState.nextRunAt) : '—'}</b></span>
                  </div>
                  <p className="schedulerNote">状态由 Chrome 组件直接核验{schedulerState?.checkedAt ? `（${formatTime(schedulerState.checkedAt)}）` : ''}。网页可以关闭；Chrome 完全退出或电脑睡眠时不会被唤醒，恢复后会执行错过周期的单次补跑。</p>
                </article>
                <SectionHeading label="MONITOR BOARD" title="账号监控" count={`${accounts.length} 个账号`} />
                <AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} onInitialSync={startInitialSync} isCollecting={isCollecting} />
              </>
            )}

            {activeNav === '对标账号' && (
              <><SectionHeading label="ACCOUNT LIST" title="全部对标账号" count={`${accounts.length} 个账号`} /><AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} onInitialSync={startInitialSync} isCollecting={isCollecting} /></>
            )}

            {activeNav === '最新视频' && (
              <>
                <AccountSelector accounts={accounts} videos={videos} selectedAccountId={selectedAccount?.id || ''} onSelect={setSelectedAccountId} />
                <SectionHeading label="LATEST CHECK" title={selectedAccount ? `${selectedAccount.name} · 最新视频` : '最新视频数据'} count={`${latestVideos.length} 条 · 仅当前账号`} />
                <VideoTable videos={latestVideos} expandedTranscripts={expandedTranscripts} onTranscript={requestTranscript} />
              </>
            )}

            {activeNav === '总数据分析' && (
              <>
                <AccountSelector accounts={accounts} videos={videos} selectedAccountId={selectedAccount?.id || ''} onSelect={setSelectedAccountId} />
                <AnalyticsBoard
                  videos={selectedAccountVideos}
                  accountName={selectedAccount?.name || null}
                />
                <SectionHeading label="ALL VIDEO DATA" title={selectedAccount ? `${selectedAccount.name} · 全部视频数据` : '全部视频数据'} count={`${selectedAccountVideos.length} 条 · 当前账号内去重`} />
                <VideoTable videos={selectedAccountVideos} expandedTranscripts={expandedTranscripts} onTranscript={requestTranscript} />
              </>
            )}
          </>
        )}

        {activePlatform !== 'douyin' && (
          <>
            <header className="topbar">
              <div>
                <p className="eyebrow">CONTENT INTELLIGENCE</p>
                <h1>{PLATFORMS[activePlatform].name}</h1>
                <p className="subtitle">{PLATFORMS[activePlatform].tagline}</p>
              </div>
            </header>
            <EmptyData
              title={`${PLATFORMS[activePlatform].name}看板尚未启用`}
              detail={`${PLATFORMS[activePlatform].name}采集入口已预留，当前版本只启用抖音采集；启用后将在这里展示独立的账号监控与分析看板。`}
            />
          </>
        )}
      </section>

      {showAddAccount && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setShowAddAccount(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title" onSubmit={submitAccount} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" aria-label="关闭" onClick={() => setShowAddAccount(false)}>×</button>
            <p className="eyebrow">NEW MONITOR</p><h2 id="add-account-title">添加新监控账号</h2>
            <p>目前只启用抖音采集，其他平台入口已预留，后续可直接接入。</p>
            <div className="platformGrid" aria-label="平台选择">
              {(Object.keys(PLATFORMS) as Platform[]).map((platform) => {
                const meta = PLATFORMS[platform];
                return (
                  <button
                    key={platform}
                    className={`platformOption ${platform === activePlatform ? 'active' : ''}`}
                    type="button"
                    disabled={!meta.enabled}
                    onClick={() => setActivePlatform(platform)}
                  >
                    <b>{meta.name}</b><small>{meta.enabled ? '已启用' : '即将支持'}</small>
                  </button>
                );
              })}
            </div>
            <label htmlFor="account-url">{PLATFORMS[activePlatform].name}作者主页链接</label>
            <input id="account-url" type="url" value={accountUrl} onChange={(event) => setAccountUrl(event.target.value)} placeholder="https://www.douyin.com/user/..." autoFocus />
            <div className="modalNote"><i /> 添加后自动抓取近 30 条非置顶视频；以后每次只检查最新 3 条。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => setShowAddAccount(false)}>取消</button><button className="primaryButton" type="submit">添加并抓取近 30 条</button></div>
          </form>
        </div>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}

function AnalyticsBoard({ videos, accountName }: { videos: Video[]; accountName: string | null }) {
  const orderedVideos = [...videos].sort((left, right) => (left.publishedAt || left.firstSeenAt).localeCompare(right.publishedAt || right.firstSeenAt));
  const dimensions = [
    { key: 'likeCount' as const, label: '点赞', color: '#d45b4f' },
    { key: 'commentCount' as const, label: '评论', color: '#4c72c7' },
    { key: 'favoriteCount' as const, label: '收藏', color: '#d18d32' },
    { key: 'shareCount' as const, label: '分享', color: '#418f72' },
  ];

  if (!videos.length) {
    return <EmptyData title={accountName ? `${accountName} 尚无建档数据` : '等待首次建档'} detail="完成当前账号的首次建档后，这里会根据近 30 条非置顶视频生成独立统计和走势，不会混入其他账号。" />;
  }

  return <>
    <SectionHeading label="TOTAL DATA ANALYSIS" title={accountName ? `${accountName} · 总数据分析` : '总数据分析'} count={`${videos.length} 条去重视频 · 仅当前账号`} />
    <section className="analysisStats">{dimensions.map((dimension) => {
      const total = videos.reduce((sum, video) => sum + (video[dimension.key] || 0), 0);
      return <article key={dimension.key} style={{ '--metric-color': dimension.color } as React.CSSProperties}>
        <small>{dimension.label}总量</small><strong>{formatMetric(total)}</strong><p>{videos.length} 条视频的{dimension.label}数据之和</p>
      </article>;
    })}</section>
    <section className="metricTrendGrid">{dimensions.map((dimension) => <MetricTrendChart
      key={dimension.key}
      label={dimension.label}
      color={dimension.color}
      videos={orderedVideos}
      metricKey={dimension.key}
    />)}</section>
  </>;
}

function MetricTrendChart({ videos, metricKey, label, color }: {
  videos: Video[];
  metricKey: 'likeCount' | 'commentCount' | 'favoriteCount' | 'shareCount';
  label: string;
  color: string;
}) {
  const width = Math.max(900, videos.length * 28);
  const height = 220;
  const paddingX = 28;
  const paddingTop = 24;
  const paddingBottom = 38;
  const values = videos.map((video) => video[metricKey] || 0);
  const maximum = Math.max(1, ...values);
  const xAt = (index: number) => videos.length === 1 ? width / 2 : paddingX + index * ((width - paddingX * 2) / (videos.length - 1));
  const yAt = (value: number) => paddingTop + (1 - value / maximum) * (height - paddingTop - paddingBottom);
  const points = values.map((value, index) => `${xAt(index)},${yAt(value)}`).join(' ');

  return <article className="metricTrendCard">
    <div className="analysisHeader"><div><p className="eyebrow">VIDEO TREND</p><h3>{label}走势</h3></div><span>{videos.length} 个视频节点</span></div>
    <div className="metricChartScroll">
      <svg className="metricLineChart" viewBox={`0 0 ${width} ${height}`} style={{ width }} role="img" aria-label={`${label}数据按视频发布时间走势`}>
        <line className="metricAxis" x1={paddingX} y1={height - paddingBottom} x2={width - paddingX} y2={height - paddingBottom} />
        <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {videos.map((video, index) => {
          const value = values[index];
          const showDate = index === 0 || index === videos.length - 1 || index % 5 === 0;
          return <g key={`${video.accountId}:${video.id}`}>
            <a href={video.url} target="_blank" rel="noreferrer">
              <circle className="metricNode" cx={xAt(index)} cy={yAt(value)} r="4.5" fill="white" stroke={color} strokeWidth="2.5">
                <title>{`${video.title}｜${label} ${formatMetric(value)}`}</title>
              </circle>
            </a>
            {showDate && <text x={xAt(index)} y={height - 13} textAnchor="middle">{video.publishedAt ? new Date(video.publishedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : `#${index + 1}`}</text>}
          </g>;
        })}
      </svg>
    </div>
    <p className="metricChartNote">按发布时间从左到右排列；每个圆点代表一条视频，悬停查看数值，点击打开原视频。</p>
  </article>;
}

function SectionHeading({ label, title, count }: { label: string; title: string; count: string }) {
  return <div className="sectionHeading"><div><p className="eyebrow">{label}</p><h2>{title}</h2></div><span>{count}</span></div>;
}

function AccountSelector({ accounts, videos, selectedAccountId, onSelect }: {
  accounts: Account[];
  videos: Video[];
  selectedAccountId: string;
  onSelect: (id: string) => void;
}) {
  if (!accounts.length) return null;
  const videoCounts = new Map<string, number>();
  videos.forEach((video) => videoCounts.set(video.accountId, (videoCounts.get(video.accountId) || 0) + 1));

  return <section className="accountSelector" aria-label="按账号筛选数据">
    <div className="accountSelectorIntro">
      <p className="eyebrow">ACCOUNT VIEW</p>
      <strong>选择查看账号</strong>
      <span>以下数据只属于所选账号，不会与其他账号汇总。</span>
    </div>
    <div className="accountSelectorOptions" role="tablist" aria-label="监控账号">
      {accounts.map((account, index) => {
        const isActive = account.id === selectedAccountId;
        return <button
          type="button"
          role="tab"
          aria-selected={isActive}
          className={isActive ? 'accountSelectorOption active' : 'accountSelectorOption'}
          key={account.id}
          onClick={() => onSelect(account.id)}
        >
          <span className="accountSelectorAvatar">{account.avatarUrl ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /> : index + 1}</span>
          <span className="accountSelectorText"><b>{account.name}</b><small>{videoCounts.get(account.id) || 0} 条已建档视频</small></span>
          <i aria-hidden="true" />
        </button>;
      })}
    </div>
  </section>;
}

const accountStatusLabels: Record<AccountStatus, string> = {
  waiting: '等待检查',
  checking: '正在采集',
  ready: '采集正常',
  error: '采集失败',
};

function AccountBoard({ accounts, onAdd, onRemove, onInitialSync, isCollecting }: {
  accounts: Account[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onInitialSync: (account: Account) => boolean;
  isCollecting: boolean;
}) {
  if (!accounts.length) {
    return <section className="emptyBoard"><div className="emptySymbol">＋</div><h3>添加第一个监控账号</h3><p>首次建立近 30 条非置顶视频档案，之后每 6 小时只检查最新 3 条并自动去重。</p><button className="primaryButton" onClick={onAdd}>添加新监控账号</button></section>;
  }
  return <section className="accountGrid">{accounts.map((account, index) => {
    const statusLabel = account.status === 'checking'
      ? account.currentSyncMode === 'initial' ? '首次建档中' : '检查最新 3 条'
      : account.initialSyncStatus === 'error' ? '建档失败' : accountStatusLabels[account.status];
    return <article className="accountCard" key={account.id}>
      <div className="accountTop"><div className="accountAvatar">{account.avatarUrl ? <img src={account.avatarUrl} alt={`${account.name}头像`} referrerPolicy="no-referrer" /> : <span>{index + 1}</span>}</div><span className={`statusPill ${account.status}`}>{statusLabel}</span></div>
      <div className="platformBadge">抖音 · 已启用</div>
      <h3>{account.name}</h3><a href={account.url} target="_blank" rel="noreferrer">打开原账号主页 ↗</a>
      <div className="accountMeta"><span><small>首次建档</small><b>{account.initialSyncStatus === 'complete' ? formatTime(account.initialSyncCompletedAt) : '待抓取近 30 条'}</b></span><span><small>最近检查</small><b>{account.lastCheckedAt ? formatTime(account.lastCheckedAt) : '尚未检查'}</b></span></div>
      {account.initialSyncStatus !== 'complete' && <button className="initialSyncButton" disabled={isCollecting} onClick={() => onInitialSync(account)}>{account.status === 'checking' ? '正在抓取近 30 条…' : account.initialSyncStatus === 'error' ? '重新抓取近 30 条' : '首次抓取近 30 条'}</button>}
      <button className="dangerLink" onClick={() => onRemove(account.id)}>移除账号</button>
    </article>;
  })}</section>;
}

function VideoTable({ videos, expandedTranscripts, onTranscript }: {
  videos: Video[];
  expandedTranscripts: Set<string>;
  onTranscript: (video: Video, force?: boolean) => void;
}) {
  if (!videos.length) return <EmptyData title="还没有视频数据" detail="检查成功后，这里会显示封面、视频文案、点赞、评论、收藏、分享和原视频链接。空结果不会再被当作成功。" />;
  return <div className="videoTableScroll"><div className="videoTable">
    <div className="videoTableHead"><span>视频与文案</span><span>数据快照</span><span>时间</span><span>操作</span></div>
    {videos.map((video) => {
      const duration = formatDuration(video.durationSeconds);
      const expanded = expandedTranscripts.has(video.id);
      const metrics = [
        ['点赞', video.likeCount],
        ['评论', video.commentCount],
        ['收藏', video.favoriteCount],
        ['分享', video.shareCount],
      ] as const;
      return <article className="videoRecord" key={`${video.accountId}:${video.id}`}>
        <div className="videoMainRow">
          <div className="videoIdentity">
            <a className="coverLink" href={video.url} target="_blank" rel="noreferrer" aria-label="打开原视频">
              {video.coverUrl ? <img src={video.coverUrl} alt="" referrerPolicy="no-referrer" /> : <span>无封面</span>}
              {duration && <i>{duration}</i>}
            </a>
            <div className="videoCopy"><a href={video.url} target="_blank" rel="noreferrer">{video.title || '未命名视频'} ↗</a><p>{video.description || '未提取到视频文案'}</p></div>
          </div>
          <div className="metricGrid">{metrics.map(([label, value]) => <span key={label}><small>{label}</small><b>{formatMetric(value)}</b></span>)}</div>
          <div className="videoTimes"><span><small>发布</small><b>{formatTime(video.publishedAt)}</b></span><span><small>采集</small><b>{formatTime(video.lastSeenAt)}</b></span></div>
          <button className={`transcriptButton ${video.transcriptStatus}`} disabled={video.transcriptStatus === 'processing'} onClick={() => onTranscript(video)}>
            {video.transcriptStatus === 'processing' ? '识别中…' : video.transcript ? (expanded ? '收起口播稿' : '查看口播稿') : video.transcriptStatus === 'error' ? '重新提取' : '一键提取口播稿'}
          </button>
        </div>
        {expanded && <div className={`transcriptPanel ${video.transcriptStatus}`}>
          <div><b>本地口播稿</b>{video.transcriptUpdatedAt && <small>更新于 {formatTime(video.transcriptUpdatedAt)}</small>}</div>
          {video.transcriptStatus === 'processing' && <p>正在从原视频临时提取音频并在本机识别，请保持 Chrome 和本地服务运行。</p>}
          {video.transcriptStatus === 'error' && <p className="transcriptError">{video.transcriptError || '识别失败，请重新尝试。'}</p>}
          {video.transcript && <><p>{video.transcript}</p><button type="button" onClick={() => onTranscript(video, true)}>重新提取</button></>}
        </div>}
      </article>;
    })}
  </div></div>;
}

function EmptyData({ title, detail }: { title: string; detail: string }) {
  return <section className="emptyBoard compact"><div className="emptySymbol">·</div><h3>{title}</h3><p>{detail}</p></section>;
}
