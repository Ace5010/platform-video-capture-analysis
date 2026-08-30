'use client';

/* eslint-disable @next/next/no-img-element -- 抖音封面是运行时采集的外部地址，不能预先配置图片域名。 */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type AccountStatus = 'waiting' | 'checking' | 'ready' | 'error';
type TranscriptStatus = 'idle' | 'processing' | 'ready' | 'error';
type AnalysisStatus = 'idle' | 'queued' | 'processing' | 'ready' | 'error';
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
  lastSuccessAt: string | null;
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
  analysis: VideoAnalysis | null;
  analysisStatus: AnalysisStatus;
  analysisUpdatedAt: string | null;
  analysisError: string | null;
};

type VideoAnalysis = {
  summary: string;
  topic: string;
  corePoint: string;
  visualContent: string;
  personActions: string;
  onScreenText: string;
  structureNarrative: string;
};

type HostJob = {
  id: string;
  type: 'collect_latest' | 'archive_account' | 'analyze_video' | string;
  status: string;
  payload: Record<string, unknown>;
  message: string | null;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type AuthPhase = 'loading' | 'setup' | 'login' | 'ready' | 'error';

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
  runId?: string;
  eventId?: string;
  messageId?: string;
  accountId?: string;
  accountUrl?: string;
  accountName?: string;
  accountAvatarUrl?: string;
  capturedAt?: string;
  videos?: Array<Partial<Video> & Pick<Video, 'id' | 'accountId' | 'url'>>;
  warning?: string;
  message?: string;
  mode?: SyncMode;
  accountIndex?: number;
  totalAccounts?: number;
  completedVideos?: number;
  totalVideos?: number;
  succeeded?: number;
  failed?: number;
  startedAt?: string;
  completedAt?: string;
};

type CollectionTaskState = {
  runId: string | null;
  phase: 'idle' | 'running' | 'completed';
  accountName: string | null;
  accountIndex: number;
  totalAccounts: number;
  completedVideos: number;
  totalVideos: number;
  succeeded: number;
  failed: number;
  completedAt: string | null;
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
  lastTrigger: 'alarm' | 'catch-up' | 'recovery' | null;
  lastError: string | null;
  missedRunRecoveredAt: string | null;
};

const navItems = [
  ['⌂', '主页仪表盘'],
  ['◎', '监控账号'],
  ['▣', '最新视频分析'],
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
  douyin: { name: '抖音', tagline: '监控账号的视频采集与分析', enabled: true, icon: <PlatformIcon platform="douyin" alt="抖音" /> },
  xiaohongshu: { name: '小红书', tagline: '监控账号的视频采集与分析', enabled: false, icon: <PlatformIcon platform="xiaohongshu" alt="小红书" /> },
  bilibili: { name: '哔哩哔哩', tagline: '监控账号的视频采集与分析', enabled: false, icon: <PlatformIcon platform="bilibili" alt="哔哩哔哩" /> },
  youtube: { name: 'YouTube', tagline: '监控账号的视频采集与分析', enabled: false, icon: <PlatformIcon platform="youtube" alt="YouTube" /> },
};

const accountStoreKey = 'douyin-monitor.accounts.v1';
const videoStoreKey = 'douyin-monitor.videos.v1';
const snapshotStoreKey = 'douyin-monitor.snapshots.v2';
const processedResultStoreKey = 'douyin-monitor.processed-results.v1';
const activePlatformStoreKey = 'douyin-monitor.active-platform.v1';
const selectedAccountStoreKey = 'douyin-monitor.selected-account.v1';
const migrationMarkerStoreKey = 'douyin-monitor.sqlite-migration.v1';
const requiredExtensionVersion = '0.7.0';

function isLoopbackHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function getHostApiBase() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:43129';
  return `http://${window.location.hostname || '127.0.0.1'}:43129`;
}

async function hostApi<T>(base: string, path: string, options: RequestInit = {}, csrfToken = ''): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrfToken && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.message === 'string'
      ? payload.message
      : typeof payload.error === 'string'
        ? payload.error
        : `本机服务返回错误（${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

const emptyCollectionTask: CollectionTaskState = {
  runId: null,
  phase: 'idle',
  accountName: null,
  accountIndex: 0,
  totalAccounts: 0,
  completedVideos: 0,
  totalVideos: 0,
  succeeded: 0,
  failed: 0,
  completedAt: null,
};

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

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAnalysis(raw: unknown): VideoAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const analysis = {
    summary: textValue(source.summary),
    topic: textValue(source.topic),
    corePoint: textValue(source.corePoint ?? source.core_point),
    visualContent: textValue(source.visualContent ?? source.visual_content),
    personActions: textValue(source.personActions ?? source.person_actions),
    onScreenText: textValue(source.onScreenText ?? source.on_screen_text),
    structureNarrative: textValue(source.structureNarrative ?? source.structure_narrative),
  };
  return Object.values(analysis).some(Boolean) ? analysis : null;
}

function normalizeAnalysisStatus(value: unknown, analysis: VideoAnalysis | null): AnalysisStatus {
  if (analysis) return 'ready';
  if (value === 'queued' || value === 'pending' || value === 'waiting') return 'queued';
  if (value === 'processing' || value === 'running' || value === 'claimed') return 'processing';
  if (value === 'error' || value === 'failed' || value === 'expired') return 'error';
  return 'idle';
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
    lastSuccessAt: raw.lastSuccessAt || raw.lastCheckedAt || null,
    status: initialSyncStatus === 'complete' ? (raw.status || 'ready') : 'waiting',
    initialSyncStatus,
    initialSyncCompletedAt: raw.initialSyncCompletedAt || null,
    latestVideoIds: Array.isArray(raw.latestVideoIds) ? raw.latestVideoIds.map(String).slice(0, 3) : [],
    currentSyncMode: null,
  };
}

function normalizeVideo(raw: Partial<Video>, capturedAt = new Date().toISOString()): Video {
  const previousTranscript = typeof raw.transcript === 'string' && raw.transcript.trim() ? raw.transcript : null;
  const analysis = normalizeAnalysis(raw.analysis || {
    summary: (raw as Partial<VideoAnalysis>).summary,
    topic: (raw as Partial<VideoAnalysis>).topic,
    corePoint: (raw as Partial<VideoAnalysis>).corePoint,
    visualContent: (raw as Partial<VideoAnalysis>).visualContent,
    personActions: (raw as Partial<VideoAnalysis>).personActions,
    onScreenText: (raw as Partial<VideoAnalysis>).onScreenText,
    structureNarrative: (raw as Partial<VideoAnalysis>).structureNarrative,
  });
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
    analysis,
    analysisStatus: normalizeAnalysisStatus(raw.analysisStatus, analysis),
    analysisUpdatedAt: raw.analysisUpdatedAt || null,
    analysisError: raw.analysisError || null,
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

function startOfTodayTimestamp() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
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
  const [apiBase, setApiBase] = useState('http://127.0.0.1:43129');
  const [isHostLocal, setIsHostLocal] = useState(true);
  const [browserReady, setBrowserReady] = useState(false);
  const [authPhase, setAuthPhase] = useState<AuthPhase>('loading');
  const [authMessage, setAuthMessage] = useState('正在连接主机服务…');
  const [authPassword, setAuthPassword] = useState('');
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const [qwenConfigured, setQwenConfigured] = useState(false);
  const [showQwenConfig, setShowQwenConfig] = useState(false);
  const [qwenApiKey, setQwenApiKey] = useState('');
  const [qwenSaving, setQwenSaving] = useState(false);
  const [hostJobs, setHostJobs] = useState<HostJob[]>([]);
  const [hostConnected, setHostConnected] = useState(false);
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
  const [collectionTask, setCollectionTask] = useState<CollectionTaskState>(emptyCollectionTask);
  const [isCollecting, setIsCollecting] = useState(false);
  const [todayStart, setTodayStart] = useState(startOfTodayTimestamp);
  const [expandedAnalyses, setExpandedAnalyses] = useState<Set<string>>(new Set());
  const processedResultIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Keep the server snapshot stable for hydration, then resolve the actual
    // LAN/loopback host once the browser has mounted.
    const timer = window.setTimeout(() => {
      setApiBase(getHostApiBase());
      setIsHostLocal(isLoopbackHostname(window.location.hostname));
      setBrowserReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const applyHostState = useCallback((payload: Record<string, unknown>) => {
    const envelope = payload.state && typeof payload.state === 'object'
      ? payload.state as Record<string, unknown>
      : payload.data && typeof payload.data === 'object'
        ? payload.data as Record<string, unknown>
        : payload;
    const nextAccounts = Array.isArray(envelope.accounts)
      ? envelope.accounts.map((account, index) => normalizeAccount(account as Partial<Account>, index))
      : [];
    const nextVideos = Array.isArray(envelope.videos)
      ? envelope.videos.map((video) => normalizeVideo(video as Partial<Video>))
      : [];
    const nextSnapshots = Array.isArray(envelope.snapshots) ? envelope.snapshots as Snapshot[] : [];
    setAccounts(nextAccounts);
    setVideos(nextVideos);
    setSnapshots(nextSnapshots);
    setSelectedAccountId((current) => nextAccounts.some((account) => account.id === current)
      ? current
      : nextAccounts.some((account) => account.id === readStored<string>(selectedAccountStoreKey, ''))
        ? readStored<string>(selectedAccountStoreKey, '')
        : nextAccounts[0]?.id || '');
    if (envelope.schedulerState && typeof envelope.schedulerState === 'object') {
      setSchedulerState(envelope.schedulerState as SchedulerState);
    }
    const connectorState = envelope.connector && typeof envelope.connector === 'object'
      ? envelope.connector as Record<string, unknown>
      : envelope;
    setHostConnected(Boolean(
      connectorState.connected
      ?? connectorState.connectorConnected
      ?? connectorState.chromeConnected
      ?? false
    ));
  }, []);

  const loadHostState = useCallback(async () => {
    const payload = await hostApi<Record<string, unknown>>(apiBase, '/api/state');
    applyHostState(payload);
    return payload;
  }, [apiBase, applyHostState]);

  const loadHostJobs = useCallback(async () => {
    const payload = await hostApi<Record<string, unknown>>(apiBase, '/api/jobs');
    const rawJobs = Array.isArray(payload.jobs)
      ? payload.jobs
      : payload.data && typeof payload.data === 'object' && Array.isArray((payload.data as Record<string, unknown>).jobs)
        ? (payload.data as Record<string, unknown>).jobs as unknown[]
        : [];
    const jobs = rawJobs.map((item, index) => {
      const job = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        id: String(job.id || job.jobId || `job-${index}`),
        type: String(job.type || ''),
        status: String(job.status || 'pending').toLowerCase(),
        payload: job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {},
        message: textValue(job.message) || null,
        error: textValue(job.error ?? job.lastError) || null,
        createdAt: textValue(job.createdAt ?? job.created_at) || null,
        updatedAt: textValue(job.updatedAt ?? job.updated_at) || null,
      } satisfies HostJob;
    });
    setHostJobs(jobs);
    const activeStatuses = new Set(['pending', 'queued', 'waiting', 'claimed', 'running', 'processing']);
    const activeCollectionJobs = jobs.filter((job) => (job.type === 'collect_latest' || job.type === 'archive_account') && activeStatuses.has(job.status));
    setIsCollecting(activeCollectionJobs.length > 0);
    if (activeCollectionJobs.length) {
      const job = activeCollectionJobs[0];
      setCollectionTask((current) => ({
        ...current,
        runId: job.id,
        phase: 'running',
        accountName: textValue(job.payload.accountName) || null,
        totalAccounts: Number(job.payload.totalAccounts) || (Array.isArray(job.payload.accountIds) ? job.payload.accountIds.length : 1),
      }));
    }
    return jobs;
  }, [apiBase]);

  const loadQwenStatus = useCallback(async () => {
    const payload = await hostApi<Record<string, unknown>>(apiBase, '/api/qwen/status');
    const status = payload.qwen && typeof payload.qwen === 'object'
      ? payload.qwen as Record<string, unknown>
      : payload;
    setQwenConfigured(Boolean(status.configured ?? status.apiKeyConfigured ?? status.ready));
  }, [apiBase]);

  const migrateLegacyLocalData = useCallback(async () => {
    if (!isHostLocal || window.localStorage.getItem(migrationMarkerStoreKey)) return;
    const rawAccounts = window.localStorage.getItem(accountStoreKey);
    const rawVideos = window.localStorage.getItem(videoStoreKey);
    const rawSnapshots = window.localStorage.getItem(snapshotStoreKey)
      ?? window.localStorage.getItem('douyin-monitor.snapshots.v1');
    const legacyAccounts = rawAccounts ? readStored<Partial<Account>[]>(accountStoreKey, []) : [];
    const legacyVideos = rawVideos ? readStored<Partial<Video>[]>(videoStoreKey, []) : [];
    const legacySnapshots = rawSnapshots
      ? readStored<Snapshot[]>(window.localStorage.getItem(snapshotStoreKey) ? snapshotStoreKey : 'douyin-monitor.snapshots.v1', [])
      : [];
    const createdAt = new Date().toISOString();
    const migrationId = crypto.randomUUID();
    const backupKey = `douyin-monitor.migration-backup.${createdAt.replace(/[:.]/g, '-')}`;
    try {
      window.localStorage.setItem(backupKey, JSON.stringify({
        createdAt,
        migrationId,
        accounts: legacyAccounts,
        videos: legacyVideos,
        snapshots: legacySnapshots,
      }));
    } catch {
      // 原始 localStorage 键始终保留；空间不足时不因额外副本阻断迁移。
    }
    await hostApi<Record<string, unknown>>(apiBase, '/api/migrate', {
      method: 'POST',
      body: JSON.stringify({ migrationId, source: 'legacy-localStorage', accounts: legacyAccounts, videos: legacyVideos, snapshots: legacySnapshots }),
    }, csrfToken);
    window.localStorage.setItem(migrationMarkerStoreKey, JSON.stringify({ migrationId, createdAt, backupKey }));
  }, [apiBase, csrfToken, isHostLocal]);

  useEffect(() => {
    processedResultIds.current = new Set(readStored<string[]>(processedResultStoreKey, []));
  }, []);

  useEffect(() => {
    if (!browserReady) return;
    let active = true;
    hostApi<Record<string, unknown>>(apiBase, '/api/auth/status')
      .then((payload) => {
        if (!active) return;
        const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth as Record<string, unknown> : payload;
        const setupRequired = Boolean(
          auth.setupRequired
          ?? auth.requiresSetup
          ?? auth.firstRun
          ?? (auth.configured === false),
        );
        const authenticated = Boolean(auth.authenticated ?? auth.loggedIn);
        setCsrfToken(textValue(auth.csrfToken ?? auth.csrf_token));
        if (setupRequired) {
          setAuthPhase('setup');
          setAuthMessage(isHostLocal ? '请先为局域网访问设置密码' : '请先在主机的 localhost 页面完成首次设置');
        } else if (authenticated) {
          setAuthPhase('ready');
          setAuthMessage('');
        } else {
          setAuthPhase('login');
          setAuthMessage('请输入访问密码');
        }
      })
      .catch((error: Error) => {
        if (!active) return;
        setAuthPhase('error');
        setAuthMessage(`无法连接主机服务：${error.message}`);
      });
    return () => { active = false; };
  }, [apiBase, browserReady, isHostLocal]);

  useEffect(() => {
    if (authPhase !== 'ready') return;
    let active = true;
    const bootstrap = async () => {
      try {
        await migrateLegacyLocalData();
        await Promise.all([loadHostState(), loadHostJobs(), loadQwenStatus()]);
        if (active) setLoaded(true);
      } catch (error) {
        if (!active) return;
        setLoaded(false);
        setAuthPhase('error');
        setAuthMessage(error instanceof Error ? `加载主机数据失败：${error.message}` : '加载主机数据失败');
      }
    };
    void bootstrap();
    const timer = window.setInterval(() => {
      void Promise.all([loadHostState(), loadHostJobs(), loadQwenStatus()]).catch(() => {
        setHostConnected(false);
      });
    }, 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [authPhase, loadHostJobs, loadHostState, loadQwenStatus, migrateLegacyLocalData]);

  useEffect(() => {
    window.localStorage.setItem(activePlatformStoreKey, JSON.stringify(activePlatform));
  }, [activePlatform]);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(selectedAccountStoreKey, JSON.stringify(selectedAccountId));
  }, [loaded, selectedAccountId]);

  useEffect(() => {
    const timer = window.setInterval(() => setTodayStart(startOfTodayTimestamp()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
            analysis: previous?.analysis || incoming.analysis,
            analysisStatus: previous?.analysisStatus === 'ready' ? 'ready' : incoming.analysisStatus,
            analysisUpdatedAt: previous?.analysisUpdatedAt || incoming.analysisUpdatedAt,
            analysisError: previous?.analysisError || incoming.analysisError,
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
        lastSuccessAt: capturedAt,
        status: 'ready',
        initialSyncStatus: payload.mode === 'initial' ? 'complete' : account.initialSyncStatus,
        initialSyncCompletedAt: payload.mode === 'initial' ? capturedAt : account.initialSyncCompletedAt,
        latestVideoIds: collected.slice(0, 3).map((video) => video.id),
        currentSyncMode: null,
      } : account));
      setNotice(payload.warning || `${payload.accountName || '当前账号'}：已更新 ${collected.length} 条视频数据`);

      if (eventId) {
        processedResultIds.current.add(eventId);
        window.localStorage.setItem(processedResultStoreKey, JSON.stringify([...processedResultIds.current]));
        window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', eventIds: [eventId] }, window.location.origin);
      }
    };

    const applyCollectionError = (payload: CollectionMessage) => {
      const capturedAt = payload.capturedAt || new Date().toISOString();
      setAccounts((current) => current.map((account) => account.id === payload.accountId ? {
        ...account,
        lastCheckedAt: capturedAt,
        status: 'error',
        initialSyncStatus: payload.mode === 'initial' ? 'error' : account.initialSyncStatus,
        currentSyncMode: null,
      } : account));
      setNotice(payload.message || '采集失败，请稍后重试');
      if (payload.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [payload.messageId] }, window.location.origin);
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
      setExpandedAnalyses((current) => new Set(current).add(payload.videoId as string));
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
      setExpandedAnalyses((current) => new Set(current).add(payload.videoId as string));
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
        if (event.data.schedulerState) {
          const nextSchedulerState = event.data.schedulerState as SchedulerState;
          setSchedulerState(nextSchedulerState);
          if (nextSchedulerState.lastRunStatus === 'running') setIsCollecting(true);
        }
        if (event.data.extensionVersion) {
          setBridgeVersion(event.data.extensionVersion);
          setBridgeNeedsReload(event.data.extensionVersion !== requiredExtensionVersion);
          window.clearTimeout(handshakeTimer);
        }
      }
      if (event.data.type === 'SCHEDULER_STATE' && event.data.schedulerState) {
        const nextSchedulerState = event.data.schedulerState as SchedulerState;
        setSchedulerState(nextSchedulerState);
        if (nextSchedulerState.lastRunStatus === 'running') setIsCollecting(true);
      }
      if (event.data.type === 'SYNC_STATE') {
        const pending = Array.isArray(event.data.pendingResults) ? event.data.pendingResults : [];
        pending.forEach((result: CollectionMessage & { type?: string }) => {
          if (result.type === 'COLLECTION_RESULT') applyCollectionResult(result);
          else if (result.type === 'COLLECTION_ERROR') applyCollectionError(result);
          else if (result.type === 'TRANSCRIPT_RESULT') applyTranscriptResult(result);
          else if (result.type === 'TRANSCRIPT_ERROR') applyTranscriptError(result);
          else if (result.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [result.messageId] }, window.location.origin);
        });
      }
      if (event.data.type === 'COLLECTION_BATCH_STARTED') {
        setIsCollecting(true);
        setCollectionTask({
          ...emptyCollectionTask,
          runId: event.data.runId || null,
          phase: 'running',
          totalAccounts: Number(event.data.totalAccounts) || 0,
        });
      }
      if (event.data.type === 'COLLECTION_STARTED') {
        setIsCollecting(true);
        setCollectionTask((current) => ({
          ...current,
          runId: event.data.runId || current.runId,
          phase: 'running',
          accountName: event.data.accountName || null,
          accountIndex: Number(event.data.accountIndex) || current.accountIndex,
          totalAccounts: Number(event.data.totalAccounts) || current.totalAccounts,
          completedVideos: 0,
          totalVideos: 0,
        }));
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
      if (event.data.type === 'COLLECTION_ACCOUNT_PROGRESS') {
        setCollectionTask((current) => ({
          ...current,
          runId: event.data.runId || current.runId,
          phase: 'running',
          accountName: event.data.accountName || current.accountName,
          accountIndex: Number(event.data.accountIndex) || current.accountIndex,
          totalAccounts: Number(event.data.totalAccounts) || current.totalAccounts,
          completedVideos: Number(event.data.completedVideos) || 0,
          totalVideos: Number(event.data.totalVideos) || 0,
        }));
      }
      if (event.data.type === 'COLLECTION_BATCH_COMPLETED') {
        const succeeded = Number(event.data.succeeded) || 0;
        const failed = Number(event.data.failed) || 0;
        const completedAt = event.data.completedAt || new Date().toISOString();
        setIsCollecting(false);
        setCollectionTask({
          ...emptyCollectionTask,
          runId: event.data.runId || null,
          phase: 'completed',
          totalAccounts: Number(event.data.totalAccounts) || succeeded + failed,
          succeeded,
          failed,
          completedAt,
        });
        setNotice(`本轮检查完成：${succeeded} 个账号成功，${failed} 个账号失败`);
      }
      if (event.data.type === 'COLLECTION_ERROR') {
        if (!event.data.accountId) {
          setIsCollecting(false);
          setCollectionTask((current) => ({
            ...current,
            phase: 'completed',
            failed: Math.max(1, current.failed),
            completedAt: event.data.capturedAt || new Date().toISOString(),
          }));
        }
        applyCollectionError(event.data);
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
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const todayVideos = videos.filter((video) => new Date(video.firstSeenAt).getTime() >= todayStart).length;
  const lastSnapshotAt = snapshots
    .map((snapshot) => snapshot.capturedAt)
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
  const createHostJob = async (type: 'collect_latest' | 'archive_account' | 'analyze_video', payload: Record<string, unknown>) => {
    const response = await hostApi<Record<string, unknown>>(apiBase, '/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ type, payload }),
    }, csrfToken);
    const rawJob = response.job && typeof response.job === 'object' ? response.job as Record<string, unknown> : response;
    if (rawJob.id || rawJob.jobId) {
      setHostJobs((current) => [{
        id: String(rawJob.id || rawJob.jobId),
        type,
        status: String(rawJob.status || 'queued').toLowerCase(),
        payload,
        message: textValue(rawJob.message) || null,
        error: textValue(rawJob.error) || null,
        createdAt: textValue(rawJob.createdAt ?? rawJob.created_at) || new Date().toISOString(),
        updatedAt: textValue(rawJob.updatedAt ?? rawJob.updated_at) || null,
      }, ...current.filter((job) => job.id !== String(rawJob.id || rawJob.jobId))]);
    }
    return rawJob;
  };

  const startInitialSync = (account: Account) => {
    if (isCollecting) {
      setNotice('当前采集仍在进行，请等待完成');
      return false;
    }
    setIsCollecting(true);
    setCollectionTask({ ...emptyCollectionTask, phase: 'running', totalAccounts: 1 });
    setAccounts((current) => current.map((item) => item.id === account.id ? {
      ...item,
      status: 'checking',
      initialSyncStatus: 'pending',
      currentSyncMode: 'initial',
    } : item));
    setNotice(`${account.name} 的近 30 条建档任务已进入主机队列`);
    void createHostJob('archive_account', {
      accountId: account.id,
      accountUrl: account.url,
      account,
      ...(account.initialSyncStatus === 'error' ? { retry: true } : {}),
    }).then(() => loadHostJobs()).catch((error: Error) => {
      setIsCollecting(false);
      setAccounts((current) => current.map((item) => item.id === account.id ? {
        ...item,
        status: 'error',
        initialSyncStatus: 'error',
        currentSyncMode: null,
      } : item));
      setNotice(`建档任务创建失败：${error.message}`);
    });
    return true;
  };

  const submitAccount = async (event: FormEvent) => {
    event.preventDefault();
    const value = accountUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      setNotice('请输入正确的抖音账号主页链接');
      return;
    }
    if (!parsed.hostname.endsWith('douyin.com') || !parsed.pathname.includes('/user/')) {
      setNotice('请输入正确的抖音账号主页链接');
      return;
    }
    if (accounts.some((account) => account.url === value)) {
      setNotice('这个账号已经在监控列表中');
      return;
    }
    try {
      const account: Account = {
        id: crypto.randomUUID(),
        platform: 'douyin',
        url: value,
        name: `待识别账号 ${accounts.length + 1}`,
        avatarUrl: null,
        addedAt: new Date().toISOString(),
        lastCheckedAt: null,
        lastSuccessAt: null,
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
      await hostApi<Record<string, unknown>>(apiBase, '/api/accounts/upsert', {
        method: 'POST',
        body: JSON.stringify({ account }),
      }, csrfToken);
      if (!startInitialSync(account)) setNotice('账号已添加，可稍后在账号卡片点击“首次抓取近 30 条”');
    } catch (error) {
      setNotice(`添加账号失败：${error instanceof Error ? error.message : '主机服务没有响应'}`);
      void loadHostState().catch(() => undefined);
    }
  };

  const requestCheck = () => {
    if (!accounts.length) {
      setShowAddAccount(true);
      return;
    }
    if (isCollecting) {
      setNotice('当前采集仍在进行，请等待完成');
      return;
    }
    const accountScopedView = activeNav === '最新视频分析' || activeNav === '总数据分析';
    const initializedAccounts = accountScopedView
      ? selectedAccount?.initialSyncStatus === 'complete' ? [selectedAccount] : []
      : accounts.filter((account) => account.initialSyncStatus === 'complete');
    if (!initializedAccounts.length) {
      setNotice('请先在账号卡片点击“首次抓取近 30 条”，完成建档后才能检查最新 3 条');
      return;
    }
    setIsCollecting(true);
    setAccounts((current) => current.map((account) => initializedAccounts.some((item) => item.id === account.id) ? {
      ...account,
      status: 'checking',
      currentSyncMode: 'latest',
    } : account));
    setCollectionTask({ ...emptyCollectionTask, phase: 'running', totalAccounts: initializedAccounts.length });
    void createHostJob('collect_latest', {
      accountIds: initializedAccounts.map((account) => account.id),
      scope: accountScopedView ? 'selected_account' : 'all_accounts',
      totalAccounts: initializedAccounts.length,
    }).then(() => {
      setNotice(accountScopedView
        ? `${initializedAccounts[0].name} 的最新 3 条检查已进入主机队列`
        : `全部 ${initializedAccounts.length} 个已建档账号已进入主机检查队列`);
      return loadHostJobs();
    }).catch((error: Error) => {
      setIsCollecting(false);
      setNotice(`检查任务创建失败：${error.message}`);
      void loadHostState().catch(() => undefined);
    });
  };

  const requestAnalysis = (video: Video) => {
    if (video.analysisStatus === 'ready' || video.analysis) {
      setExpandedAnalyses((current) => {
        const next = new Set(current);
        if (next.has(video.id)) next.delete(video.id); else next.add(video.id);
        return next;
      });
      return;
    }
    if (video.analysisStatus === 'queued' || video.analysisStatus === 'processing') {
      setExpandedAnalyses((current) => new Set(current).add(video.id));
      return;
    }
    if (!qwenConfigured) {
      if (isHostLocal) setShowQwenConfig(true);
      else setNotice('主机尚未配置 Qwen API Key，请先在主机 localhost 页面完成配置');
      return;
    }
    setVideos((current) => current.map((item) => item.id === video.id ? {
      ...item,
      transcriptStatus: item.transcript ? item.transcriptStatus : 'processing',
      transcriptError: null,
      analysisStatus: 'queued',
      analysisError: null,
    } : item));
    setExpandedAnalyses((current) => new Set(current).add(video.id));
    void createHostJob('analyze_video', {
      accountId: video.accountId,
      videoId: video.id,
      videoUrl: video.url,
      title: video.title,
      description: video.description,
      ...(video.analysisStatus === 'error' ? { retry: true } : {}),
    }).then(() => {
      setNotice('AI 分析已进入主机队列，将用完整原视频同步生成口播稿与内容分析');
      return loadHostJobs();
    }).catch((error: Error) => {
      setVideos((current) => current.map((item) => item.id === video.id ? {
        ...item,
        transcriptStatus: item.transcript ? item.transcriptStatus : 'idle',
        analysisStatus: 'error',
        analysisError: error.message,
      } : item));
      setNotice(`AI 分析任务创建失败：${error.message}`);
    });
  };

  const removeAccount = (id: string) => {
    const removedVideoIds = new Set(videos.filter((video) => video.accountId === id).map((video) => video.id));
    const nextAccounts = accounts.filter((account) => account.id !== id);
    void hostApi<Record<string, unknown>>(apiBase, '/api/accounts/remove', {
      method: 'POST',
      body: JSON.stringify({ accountId: id }),
    }, csrfToken).then(() => {
      setAccounts(nextAccounts);
      if (selectedAccount?.id === id) setSelectedAccountId(nextAccounts[0]?.id || '');
      setVideos((current) => current.filter((video) => video.accountId !== id));
      setSnapshots((current) => current.filter((snapshot) => snapshot.accountId !== id && !removedVideoIds.has(snapshot.videoId)));
      setNotice('账号及其主机记录已移除');
    }).catch((error: Error) => setNotice(`移除失败：${error.message}`));
  };

  const initializedAccountCount = accounts.filter((account) => account.initialSyncStatus === 'complete').length;
  const pendingAccountCount = accounts.length - initializedAccountCount;
  const currentTaskLabel = isCollecting
    ? collectionTask.accountName
      ? `正在处理 ${collectionTask.accountName} · 账号 ${collectionTask.accountIndex || 1}/${collectionTask.totalAccounts || accounts.length}${collectionTask.totalVideos ? ` · 视频 ${collectionTask.completedVideos}/${collectionTask.totalVideos}` : ''}`
      : schedulerState?.lastRunStatus === 'running'
        ? '后台自动检查正在运行'
        : `任务已启动 · 共 ${collectionTask.totalAccounts || accounts.length} 个账号`
    : collectionTask.phase === 'completed' && collectionTask.completedAt
      ? `${formatTime(collectionTask.completedAt)} · 成功 ${collectionTask.succeeded} / 失败 ${collectionTask.failed}`
      : '当前空闲';

  const statCards = [
    ['监控账号', accounts.length, accounts.length ? `${initializedAccountCount} 个已建档${pendingAccountCount ? ` · ${pendingAccountCount} 个待建档` : ''}` : null],
    ['已采集视频总数', videos.length, lastSnapshotAt ? `${snapshots.filter((snapshot) => snapshot.accountId).length} 次互动数据快照 · 最近快照 ${formatTime(lastSnapshotAt)}` : null],
    ['今日新收录', todayVideos, '按首次发现时间统计'],
  ];

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    if (authPhase === 'setup' && !isHostLocal) return;
    if (authPassword.length < 10) {
      setAuthMessage('访问密码至少需要 10 位');
      return;
    }
    if (authPhase === 'setup' && authPassword !== authPasswordConfirm) {
      setAuthMessage('两次输入的密码不一致');
      return;
    }
    setAuthSubmitting(true);
    try {
      const path = authPhase === 'setup' ? '/api/auth/setup' : '/api/auth/login';
      const payload = await hostApi<Record<string, unknown>>(apiBase, path, {
        method: 'POST',
        body: JSON.stringify({ password: authPassword }),
      });
      const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth as Record<string, unknown> : payload;
      let nextCsrfToken = textValue(auth.csrfToken ?? auth.csrf_token);
      if (!nextCsrfToken) {
        const status = await hostApi<Record<string, unknown>>(apiBase, '/api/auth/status');
        const statusAuth = status.auth && typeof status.auth === 'object' ? status.auth as Record<string, unknown> : status;
        nextCsrfToken = textValue(statusAuth.csrfToken ?? statusAuth.csrf_token);
      }
      setCsrfToken(nextCsrfToken);
      setAuthPassword('');
      setAuthPasswordConfirm('');
      setAuthMessage('');
      setAuthPhase('ready');
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : '验证失败，请重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const logout = () => {
    void hostApi<Record<string, unknown>>(apiBase, '/api/auth/logout', { method: 'POST', body: '{}' }, csrfToken)
      .finally(() => {
        setAuthPhase('login');
        setCsrfToken('');
        setLoaded(false);
        setAccounts([]);
        setVideos([]);
        setSnapshots([]);
      });
  };

  const saveQwenKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!isHostLocal) return;
    if (!qwenApiKey.trim()) {
      setNotice('请输入 Qwen API Key');
      return;
    }
    setQwenSaving(true);
    try {
      await hostApi<Record<string, unknown>>(apiBase, '/api/qwen/config', {
        method: 'POST',
        body: JSON.stringify({ apiKey: qwenApiKey.trim() }),
      }, csrfToken);
      setQwenApiKey('');
      setQwenConfigured(true);
      setShowQwenConfig(false);
      setNotice('Qwen API Key 已由主机安全保存');
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : '主机服务没有响应'}`);
    } finally {
      setQwenApiKey('');
      setQwenSaving(false);
    }
  };

  if (authPhase !== 'ready' || !loaded) {
    const setupBlocked = authPhase === 'setup' && !isHostLocal;
    return <main className="accessGate">
      <section className="accessCard" aria-live="polite">
        <div className="accessMark"><PlatformIcon platform="douyin" alt="抖音" /></div>
        <p className="accessEyebrow">监控数据主机</p>
        <h1>{authPhase === 'setup' ? '设置局域网访问密码' : authPhase === 'login' ? '登录监控工作台' : authPhase === 'error' ? '主机服务未连接' : '正在载入共享数据'}</h1>
        <p>{authMessage || '正在从主机 SQLite 读取账号、视频和分析结果。'}</p>
        {(authPhase === 'setup' || authPhase === 'login') && !setupBlocked && <form onSubmit={submitAuth}>
          <label htmlFor="access-password">访问密码</label>
          <input id="access-password" type="password" autoComplete={authPhase === 'login' ? 'current-password' : 'new-password'} minLength={10} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoFocus />
          {authPhase === 'setup' && <><small className="accessPasswordHint">至少 10 位，仅用于你的局域网设备访问。</small><label htmlFor="access-password-confirm">再次输入密码</label><input id="access-password-confirm" type="password" autoComplete="new-password" minLength={10} value={authPasswordConfirm} onChange={(event) => setAuthPasswordConfirm(event.target.value)} /></>}
          <button className="primaryButton" type="submit" disabled={authSubmitting}>{authSubmitting ? '请稍候…' : authPhase === 'setup' ? '保存并进入工作台' : '登录'}</button>
        </form>}
        {setupBlocked && <div className="accessNotice">首次密码只能在主机打开 <b>http://localhost:3000</b> 设置。设置完成后，本设备即可使用同一密码登录。</div>}
        {authPhase === 'error' && <button className="secondaryButton" type="button" onClick={() => window.location.reload()}>重新连接</button>}
        <small>主机地址：{apiBase.replace(/^https?:\/\//, '')}</small>
      </section>
    </main>;
  }

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
          <div className={hostConnected ? 'localStatus connected' : 'localStatus'}><i /><span><b>主机采集服务</b><small>{!hostConnected ? '服务已连接 · 等待主机 Chrome' : isHostLocal ? bridgeNeedsReload ? `Chrome 组件需刷新到 v${requiredExtensionVersion}` : bridgeReady ? `Chrome 已连接${bridgeVersion ? ` · v${bridgeVersion}` : ''}` : 'Chrome 队列已连接' : '已连接 · 任务由主机 Chrome 执行'}</small></span></div>
          <div className="scheduleSummary">自动检查：每 6 小时</div>
          <button className="logoutButton" type="button" onClick={logout}>退出当前设备</button>
        </div>
      </aside>

      <section className="workspace">
        {activePlatform === 'douyin' && (
          <>
            <header className="topbar">
              <div>
                <h1>{activeNav}</h1>
                <p className="subtitle">首次建档近 30 条 · 日常只查最新 3 条 · Chrome 运行时每 6 小时检查</p>
              </div>
              <div className="topActions">
                <div className="nextRun"><span>下次后台检查</span><b>{schedulerState?.nextRunAt ? formatTime(schedulerState.nextRunAt) : '等待组件'}</b></div>
                {isHostLocal
                  ? <button className={`qwenControl ${qwenConfigured ? 'ready' : ''}`} type="button" onClick={() => setShowQwenConfig(true)}><span>AI 分析</span><b>{qwenConfigured ? 'Qwen 已配置' : '配置 Qwen'}</b></button>
                  : <div className={`qwenControl remote ${qwenConfigured ? 'ready' : ''}`} title="API Key 只能在主机 localhost 页面配置"><span>AI 分析</span><b>{qwenConfigured ? 'Qwen 已配置' : 'Qwen 未配置'}</b></div>}
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
                    <div><h2>采集任务</h2><span>{isHostLocal && bridgeNeedsReload ? `Chrome 采集组件需刷新到 v${requiredExtensionVersion}` : schedulerState?.alarmRegistered ? 'Chrome 后台调度已注册，关闭工作台网页后仍会继续计时' : accounts.some((account) => account.initialSyncStatus !== 'complete') ? '待完成首次建档：每个账号近 30 条非置顶视频' : hostConnected ? '主机正在核验 6 小时后台调度' : '等待主机采集服务连接'}</span></div>
                  </div>
                  <div className="schedulerStatusGrid">
                    <span><small>后台调度</small><b className={schedulerState?.alarmRegistered ? 'schedulerHealthy' : ''}>{schedulerState?.alarmRegistered ? '已启用 · 每 6 小时' : '等待 Chrome 核验'}</b></span>
                    <span><small>自动检查范围</small><b>{schedulerState ? `${schedulerState.monitoredAccountCount} 个已建档账号` : '—'}</b></span>
                    <span><small>上次自动运行</small><b>{schedulerState?.lastAttemptAt ? `${formatTime(schedulerState.lastAttemptAt)} · ${schedulerRunLabel(schedulerState.lastRunStatus)}` : schedulerRunLabel(schedulerState?.lastRunStatus)}</b></span>
                    <span><small>当前采集任务</small><b title={currentTaskLabel}>{currentTaskLabel}</b></span>
                  </div>
                  <p className="schedulerNote">状态由 Chrome 组件直接核验{schedulerState?.checkedAt ? `（${formatTime(schedulerState.checkedAt)}）` : ''}。网页可以关闭；Chrome 完全退出或电脑睡眠时不会被唤醒，恢复后会执行错过周期的单次补跑。</p>
                </article>
                <SectionHeading title="账号监控" count={`${accounts.length} 个账号`} />
                <AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} onInitialSync={startInitialSync} isCollecting={isCollecting} />
              </>
            )}

            {activeNav === '监控账号' && (
              <><SectionHeading title="全部监控账号" count={`${accounts.length} 个账号`} /><AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} onInitialSync={startInitialSync} isCollecting={isCollecting} /></>
            )}

            {activeNav === '最新视频分析' && (
              <>
                <AccountSelector accounts={accounts} videos={videos} selectedAccountId={selectedAccount?.id || ''} onSelect={setSelectedAccountId} />
                <SectionHeading title={selectedAccount ? `${selectedAccount.name} · 最新视频分析` : '最新视频分析'} count={`${latestVideos.length} 条 · 仅当前账号`} />
                <VideoTable videos={latestVideos} jobs={hostJobs} expandedAnalyses={expandedAnalyses} onAnalysis={requestAnalysis} />
              </>
            )}

            {activeNav === '总数据分析' && (
              <>
                <AccountSelector accounts={accounts} videos={videos} selectedAccountId={selectedAccount?.id || ''} onSelect={setSelectedAccountId} />
                <AnalyticsBoard
                  videos={selectedAccountVideos}
                  accountName={selectedAccount?.name || null}
                />
                <SectionHeading title={selectedAccount ? `${selectedAccount.name} · 全部视频数据` : '全部视频数据'} count={`${selectedAccountVideos.length} 条 · 当前账号内去重`} />
                <VideoTable videos={selectedAccountVideos} jobs={hostJobs} expandedAnalyses={expandedAnalyses} onAnalysis={requestAnalysis} />
              </>
            )}
          </>
        )}

        {activePlatform !== 'douyin' && (
          <>
            <header className="topbar">
              <div>
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
            <h2 id="add-account-title">添加新监控账号</h2>
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
            <div className="modalNote">添加后自动抓取近 30 条非置顶视频；以后每次只检查最新 3 条。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => setShowAddAccount(false)}>取消</button><button className="primaryButton" type="submit">添加并抓取近 30 条</button></div>
          </form>
        </div>
      )}

      {showQwenConfig && isHostLocal && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => { setQwenApiKey(''); setShowQwenConfig(false); }}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="qwen-config-title" onSubmit={saveQwenKey} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" aria-label="关闭" onClick={() => { setQwenApiKey(''); setShowQwenConfig(false); }}>×</button>
            <h2 id="qwen-config-title">配置 Qwen 视频分析</h2>
            <p>API Key 只会交给主机服务，并使用当前 Windows 用户加密保存；不会写入浏览器、SQLite、Git 或日志。其他设备只能看到是否已配置。</p>
            <label htmlFor="qwen-api-key">Qwen API Key</label>
            <input id="qwen-api-key" type="password" autoComplete="off" value={qwenApiKey} onChange={(event) => setQwenApiKey(event.target.value)} placeholder={qwenConfigured ? '输入新 Key 可替换现有配置' : '请输入 API Key'} autoFocus />
            <div className="modalNote">模型固定使用 qwen3.8-flash。开始 AI 分析后，完整原视频会作为主要输入，同一任务还会在本机生成口播稿。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => { setQwenApiKey(''); setShowQwenConfig(false); }}>取消</button><button className="primaryButton" type="submit" disabled={qwenSaving}>{qwenSaving ? '保存中…' : qwenConfigured ? '替换配置' : '安全保存'}</button></div>
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
    return <EmptyData title={accountName ? `${accountName} 尚无建档数据` : '等待首次建档'} detail="完成当前账号的首次建档后，这里会根据首次近 30 条非置顶视频及后续发现的新视频生成独立统计和走势，不会混入其他账号。" />;
  }

  return <>
    <SectionHeading title={accountName ? `${accountName} · 总数据分析` : '总数据分析'} count={`${videos.length} 条去重视频 · 仅当前账号`} />
    <section className="analysisStats">{dimensions.map((dimension) => {
      const total = videos.reduce((sum, video) => sum + (video[dimension.key] || 0), 0);
      return <article key={dimension.key} style={{ '--metric-color': dimension.color } as React.CSSProperties}>
        <small>当前{dimension.label}合计</small><strong>{formatMetric(total)}</strong><p>{videos.length} 条视频最新快照的{dimension.label}数据之和</p>
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
    <div className="analysisHeader"><h3>{label}表现走势</h3><span>{videos.length} 个视频节点</span></div>
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
    <p className="metricChartNote">优先按发布时间从左到右排列，缺少发布时间时按首次发现时间；每个圆点代表一条视频，悬停查看数值，点击打开原视频。</p>
  </article>;
}

function SectionHeading({ title, count }: { title: string; count: string }) {
  return <div className="sectionHeading"><h2>{title}</h2><span>{count}</span></div>;
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
  ready: '最近检查成功',
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
      <div className="platformBadge">抖音</div>
      <h3>{account.name}</h3><a href={account.url} target="_blank" rel="noreferrer">打开原账号主页 ↗</a>
      <div className="accountMeta"><span><small>首次建档</small><b>{account.initialSyncStatus === 'complete' ? formatTime(account.initialSyncCompletedAt) : '待抓取近 30 条'}</b></span><span><small>最近检查</small><b>{account.lastCheckedAt ? formatTime(account.lastCheckedAt) : '尚未检查'}</b></span></div>
      {account.initialSyncStatus !== 'complete' && <button className="initialSyncButton" disabled={isCollecting} onClick={() => onInitialSync(account)}>{account.status === 'checking' ? '正在抓取近 30 条…' : account.initialSyncStatus === 'error' ? '重新抓取近 30 条' : '首次抓取近 30 条'}</button>}
      <button className="dangerLink" onClick={() => onRemove(account.id)}>移除账号</button>
    </article>;
  })}</section>;
}

function VideoTable({ videos, jobs, expandedAnalyses, onAnalysis }: {
  videos: Video[];
  jobs: HostJob[];
  expandedAnalyses: Set<string>;
  onAnalysis: (video: Video) => void;
}) {
  if (!videos.length) return <EmptyData title="还没有视频数据" detail="检查成功后，这里会显示封面、视频文案、点赞、评论、收藏、分享和原视频链接。空结果不会再被当作成功。" />;
  return <div className="videoTableScroll"><div className="videoTable">
    <div className="videoTableHead"><span>视频与文案</span><span>数据快照</span><span>时间</span><span>操作</span></div>
    {videos.map((video) => {
      const duration = formatDuration(video.durationSeconds);
      const expanded = expandedAnalyses.has(video.id);
      const latestJob = jobs
        .filter((job) => job.type === 'analyze_video' && String(job.payload.videoId || '') === video.id)
        .sort((left, right) => (right.updatedAt || right.createdAt || '').localeCompare(left.updatedAt || left.createdAt || ''))[0];
      const jobStatus = latestJob?.status || '';
      const analysisStatus: AnalysisStatus = video.analysis
        ? 'ready'
        : ['pending', 'queued', 'waiting'].includes(jobStatus)
          ? 'queued'
          : ['claimed', 'running', 'processing'].includes(jobStatus)
            ? 'processing'
            : ['failed', 'error', 'expired', 'cancelled'].includes(jobStatus)
              ? 'error'
              : video.analysisStatus;
      const analysisError = video.analysisError || latestJob?.error || latestJob?.message;
      const buttonLabel = analysisStatus === 'queued'
        ? '排队中'
        : analysisStatus === 'processing'
          ? '分析中…'
          : analysisStatus === 'ready'
            ? expanded ? '收起分析' : '查看分析'
            : analysisStatus === 'error'
              ? '重新分析'
              : 'AI分析';
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
            <div className="videoCopy"><a href={video.url} target="_blank" rel="noreferrer">{video.title || '未命名视频'} ↗</a>{video.description.trim() && video.description.trim() !== video.title.trim() ? <p>{video.description}</p> : null}</div>
          </div>
          <div className="metricGrid">{metrics.map(([label, value]) => <span key={label}><small>{label}</small><b>{formatMetric(value)}</b></span>)}</div>
          <div className="videoTimes"><span><small>发布</small><b>{formatTime(video.publishedAt)}</b></span><span><small>采集</small><b>{formatTime(video.lastSeenAt)}</b></span></div>
          <button className={`analysisButton ${analysisStatus}`} onClick={() => onAnalysis({ ...video, analysisStatus })}>
            {buttonLabel}
          </button>
        </div>
        {expanded && <div className={`analysisPanel ${analysisStatus}`}>
          <section className="analysisPane transcriptPane">
            <div className="analysisPaneHeader"><b>原视频口播稿</b>{video.transcriptUpdatedAt && <small>更新于 {formatTime(video.transcriptUpdatedAt)}</small>}</div>
            {video.transcript && <p className="transcriptText">{video.transcript}</p>}
            {!video.transcript && (analysisStatus === 'queued' || analysisStatus === 'processing') && <p className="analysisPending">正在同一任务中从完整原视频提取音频，并在主机本地识别口播稿。</p>}
            {!video.transcript && video.transcriptStatus === 'error' && <p className="analysisError">{video.transcriptError || '本地口播识别失败。'}</p>}
            {!video.transcript && analysisStatus === 'ready' && <p className="analysisEmpty">该视频未识别到清晰口播内容。</p>}
            {!video.transcript && analysisStatus === 'idle' && <p className="analysisEmpty">开始 AI 分析后，口播稿会与分析结果一起永久保存。</p>}
          </section>
          <section className="analysisPane aiPane">
            <div className="analysisPaneHeader"><b>AI视频分析</b>{video.analysisUpdatedAt && <small>更新于 {formatTime(video.analysisUpdatedAt)}</small>}</div>
            {(analysisStatus === 'queued' || analysisStatus === 'processing') && <p className="analysisPending">{analysisStatus === 'queued' ? '任务正在等待主机 Chrome 执行。' : '正在读取完整原视频并分析画面、人物行为、文字与内容结构；不会用关键帧或口播稿代替原视频。'}</p>}
            {analysisStatus === 'error' && <p className="analysisError">{analysisError || '视频分析失败，请点击“重新分析”。'}</p>}
            {video.analysis && <div className="analysisFields">
              <section className="wide"><small>内容摘要</small><p>{video.analysis.summary || '未生成摘要'}</p></section>
              <section><small>视频主题</small><p>{video.analysis.topic || '未识别'}</p></section>
              <section><small>核心观点</small><p>{video.analysis.corePoint || '未识别'}</p></section>
              <section><small>画面内容</small><p>{video.analysis.visualContent || '未识别'}</p></section>
              <section><small>人物行为</small><p>{video.analysis.personActions || '未识别'}</p></section>
              <section><small>字幕与画面文字</small><p>{video.analysis.onScreenText || '未识别'}</p></section>
              <section><small>结构与叙事</small><p>{video.analysis.structureNarrative || '未识别'}</p></section>
            </div>}
            {!video.analysis && analysisStatus === 'idle' && <p className="analysisEmpty">点击“AI分析”后生成并永久保存。分析只聚焦视频具体内容，不分析钩子、高潮、引导、语气、音乐或环境音。</p>}
          </section>
        </div>}
      </article>;
    })}
  </div></div>;
}

function EmptyData({ title, detail }: { title: string; detail: string }) {
  return <section className="emptyBoard compact"><div className="emptySymbol">·</div><h3>{title}</h3><p>{detail}</p></section>;
}
