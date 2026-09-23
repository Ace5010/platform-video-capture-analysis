'use client';

/* eslint-disable @next/next/no-img-element -- 抖音封面是运行时采集的外部地址，不能预先配置图片域名。 */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { ANALYSIS_STAGE_LABELS, formatAnalysisDiagnostics, redactDiagnosticText, type AnalysisDiagnostics } from '../lib/analysis-diagnostics';
import { createClientId } from '../lib/client-id';
import { hostApiBase } from '../lib/host-connection';
import { browseContentVideos, collectionAccountScope, type ContentBrowseScope, type ContentResultFilter } from '../lib/content-browse';
import { normalizeAnalysisUsage, formatTokenCount, formatEstimatedCost, formatCloudAudioSeconds, analysisRequestCountLabel, analysisUsageSummary, type AnalysisUsage } from '../lib/analysis-usage';

import {
  analyticsMetricValue,
  calculateDelta,
  metricRank,
  metricTrendSegments,
  orderVideosOldestFirst,
  previousPublishedVideo,
  snapshotMetricChange,
  summarizeMetric,
  type AnalyticsMetricKey,
  type NumericDelta,
} from '../lib/video-analytics';
import {
  isAnalysisExtensionCompatible,
  MINIMUM_ANALYSIS_EXTENSION_VERSION,
  REQUIRED_ANALYSIS_EXTENSION_CAPABILITY,
} from '../lib/extension-compatibility';

import { formatRemotionPlan, isRemotionPlan, videoContentAnalysis, videoContentReading, REMOTION_PLAN_SECTIONS, type RemotionPlan } from '../lib/remotion-plan';

type AccountStatus = 'waiting' | 'checking' | 'ready' | 'error';
type TranscriptStatus = 'idle' | 'processing' | 'ready' | 'error';
type AnalysisStatus = 'idle' | 'queued' | 'processing' | 'ready' | 'error';
type SyncMode = 'initial' | 'latest';
type InitialSyncStatus = 'pending' | 'complete' | 'error';
type Platform = 'douyin' | 'xiaohongshu' | 'bilibili' | 'youtube';
type AnalyticsSortMode = 'published' | 'value';
type ReadingSection = 'transcript' | 'content' | 'production';
type ReaderState = { videoId: string; videoIds: string[]; section: ReadingSection };

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
  latestCheckNewVideoCount: number | null;
  latestCheckNewVideoIds: string[];
  updatesReadAt?: string | null;
  collectionError?: string | null;
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
  authorName: string | null;
  authorAvatarUrl: string | null;
  authorProfileUrl: string | null;
  isLinkAnalysis: boolean;
  linkSourceUrl: string | null;
  linkAddedAt: string | null;
  capturedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptUpdatedAt: string | null;
  transcriptError: string | null;
  analysis: VideoAnalysis | null;
  analysisUsage: AnalysisUsage | null;
  analysisRuns: AnalysisRun[];
  analysisStatus: AnalysisStatus;
  analysisUpdatedAt: string | null;
  analysisError: string | null;
  analysisDiagnostics?: AnalysisDiagnostics | null;
};

type VideoAnalysis = Partial<RemotionPlan> & {
  summary: string;
  topic: string;
  corePoint: string;
  visualContent: string;
  personActions: string;
  onScreenText: string;
  structureNarrative: string;
};

type AnalysisRun = {
  id: string;
  jobId: string;
  status: string;
  usage: AnalysisUsage | null;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type HostJob = {
  id: string;
  type: 'collect_latest' | 'archive_account' | 'analyze_video' | string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  progress?: Record<string, unknown>;
  message: string | null;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  attemptCount: number;
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
  connectorJobId?: string | null;
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

const navItems = [
  ['⌂', '内容浏览'],
  ['⌕', '链接分析'],
  ['⌁', '互动数据'],
  ['◎', '信源管理'],
];

const ANALYTICS_METRICS = [
  { key: 'likeCount' as const, label: '点赞', color: '#d45b4f' },
  { key: 'commentCount' as const, label: '评论', color: '#4c72c7' },
  { key: 'favoriteCount' as const, label: '收藏', color: '#d18d32' },
  { key: 'shareCount' as const, label: '分享', color: '#418f72' },
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
const requiredExtensionVersion = MINIMUM_ANALYSIS_EXTENSION_VERSION;
const requiredExtensionCapability = REQUIRED_ANALYSIS_EXTENSION_CAPABILITY;

function isLoopbackHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function getHostApiBase() {
  return hostApiBase(typeof window === 'undefined' ? undefined : window.location);
}

async function hostApi<T>(base: string, path: string, options: RequestInit = {}, csrfToken = '', retried = false): Promise<T> {
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
    if (response.status === 403 && !retried && String(payload.message || payload.error || '').includes('CSRF')) {
      const auth = await hostApi<Record<string, unknown>>(base, '/api/auth/status');
      if (auth.authenticated && typeof auth.csrfToken === 'string') {
        return hostApi<T>(base, path, options, auth.csrfToken, true);
      }
    }
    if (response.status === 401 && path !== '/api/auth/login') {
      window.dispatchEvent(new Event('host-session-expired'));
    }
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
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAnalysis(raw: unknown): VideoAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const analysis = {
    ...source,
    summary: textValue(source.summary),
    topic: textValue(source.topic),
    corePoint: textValue(source.corePoint ?? source.core_point),
    visualContent: textValue(source.visualContent ?? source.visual_content),
    personActions: textValue(source.personActions ?? source.person_actions),
    onScreenText: textValue(source.onScreenText ?? source.on_screen_text),
    structureNarrative: textValue(source.structureNarrative ?? source.structure_narrative),
  };
  return Object.values(analysis).some(Boolean) ? analysis as VideoAnalysis : null;
}

function normalizeAnalysisStatus(value: unknown, analysis: VideoAnalysis | null): AnalysisStatus {
  if (value === 'queued' || value === 'pending' || value === 'waiting') return 'queued';
  if (value === 'processing' || value === 'running' || value === 'claimed') return 'processing';
  if (value === 'error' || value === 'failed' || value === 'expired') return 'error';
  if (analysis) return 'ready';
  return 'idle';
}

function normalizeAccount(raw: Partial<Account>, index: number): Account {
  const initialSyncStatus = raw.initialSyncStatus === 'complete' || raw.initialSyncStatus === 'error'
    ? raw.initialSyncStatus
    : 'pending';
  return {
    id: String(raw.id || createClientId()),
    platform: raw.platform || 'douyin',
    url: String(raw.url || ''),
    name: String(raw.name || `待识别账号 ${index + 1}`),
    avatarUrl: typeof raw.avatarUrl === 'string' && raw.avatarUrl ? raw.avatarUrl : null,
    addedAt: raw.addedAt || new Date().toISOString(),
    lastCheckedAt: raw.lastCheckedAt || null,
    lastSuccessAt: raw.lastSuccessAt || raw.lastCheckedAt || null,
    status: (String(raw.status) === 'partial' ? 'error' : raw.status) || (initialSyncStatus === 'complete' ? 'ready' : 'waiting'),
    initialSyncStatus,
    initialSyncCompletedAt: raw.initialSyncCompletedAt || null,
    latestVideoIds: Array.isArray(raw.latestVideoIds) ? [...new Set(raw.latestVideoIds.map(String))].slice(0, 5) : [],
    latestCheckNewVideoCount: typeof raw.latestCheckNewVideoCount === 'number' && raw.latestCheckNewVideoCount >= 0
      ? Math.floor(raw.latestCheckNewVideoCount)
      : null,
    latestCheckNewVideoIds: Array.isArray(raw.latestCheckNewVideoIds) ? raw.latestCheckNewVideoIds.map(String) : [],
    updatesReadAt: raw.updatesReadAt || null,
    collectionError: raw.collectionError || null,
    currentSyncMode: raw.currentSyncMode === 'initial' || raw.currentSyncMode === 'latest' ? raw.currentSyncMode : null,
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
    authorName: textValue(raw.authorName) || null,
    authorAvatarUrl: textValue(raw.authorAvatarUrl) || null,
    authorProfileUrl: textValue(raw.authorProfileUrl) || null,
    isLinkAnalysis: raw.isLinkAnalysis === true,
    linkSourceUrl: textValue(raw.linkSourceUrl) || null,
    linkAddedAt: textValue(raw.linkAddedAt) || null,
    capturedAt: seenAt,
    firstSeenAt: raw.firstSeenAt || seenAt,
    lastSeenAt: raw.lastSeenAt || seenAt,
    transcript: previousTranscript,
    transcriptStatus: previousTranscript ? 'ready' : (raw.transcriptStatus === 'processing' ? 'idle' : (raw.transcriptStatus || 'idle')),
    transcriptUpdatedAt: raw.transcriptUpdatedAt || null,
    transcriptError: raw.transcriptError || null,
    analysis,
    analysisUsage: normalizeAnalysisUsage(raw.analysisUsage),
    analysisRuns: Array.isArray(raw.analysisRuns)
      ? raw.analysisRuns.map(normalizeAnalysisRun).filter((run): run is AnalysisRun => run !== null)
      : [],
    analysisStatus: normalizeAnalysisStatus(raw.analysisStatus, analysis),
    analysisUpdatedAt: raw.analysisUpdatedAt || null,
    analysisError: raw.analysisError || null,
    analysisDiagnostics: raw.analysisDiagnostics || null,
  };
}

function normalizeAnalysisRun(value: unknown): AnalysisRun | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || '');
  const jobId = String(raw.jobId || '');
  if (!id || !jobId) return null;
  return {
    id,
    jobId,
    status: String(raw.status || 'unknown'),
    usage: normalizeAnalysisUsage(raw.usage),
    error: typeof raw.error === 'string' && raw.error.trim() ? raw.error : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function analysisRunStatusLabel(status: string) {
  if (status === 'succeeded') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'expired') return '等待超时';
  if (status === 'cancelled') return '已取消';
  if (status === 'running' || status === 'claimed') return '分析中';
  if (status === 'queued') return '排队中';
  return status || '未知';
}

function formatTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function formatPublishedTime(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return '发布时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function formatCalendarDate(value: string | null, includeYear = false) {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(includeYear ? { year: 'numeric' as const } : {}),
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatClockTime(value: string | null) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatMetric(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

function formatCompactMetric(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatSignedMetric(value: number, compact = false) {
  if (value === 0) return '0';
  const formatted = compact ? formatCompactMetric(Math.abs(value)) : formatMetric(Math.abs(value));
  return `${value > 0 ? '+' : '−'}${formatted}`;
}

function formatSignedPercentage(value: number) {
  if (value === 0) return '0%';
  const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(Math.abs(value));
  return `${value > 0 ? '+' : '−'}${formatted}%`;
}

function formatDeltaDetail(delta: NumericDelta | null) {
  if (!delta) return '数据不足';
  if (delta.absolute === 0) return '持平';
  const absolute = formatSignedMetric(delta.absolute);
  return delta.percentage === null
    ? `${absolute}（基线为 0）`
    : `${absolute}（${formatSignedPercentage(delta.percentage)}）`;
}

function deltaTone(delta: NumericDelta | null) {
  if (!delta || delta.absolute === 0) return 'neutral';
  return delta.absolute > 0 ? 'positive' : 'negative';
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
  const [dedicatedBrowser, setDedicatedBrowser] = useState(true);
  const [browserError, setBrowserError] = useState('');
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [hostConnectorCapabilities, setHostConnectorCapabilities] = useState<string[]>([]);
  const [hostWorkerStatus, setHostWorkerStatus] = useState('');
  const [activeNav, setActiveNav] = useState('内容浏览');
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
  const [linkVideos, setLinkVideos] = useState<Video[]>([]);
  const [videoLinkInput, setVideoLinkInput] = useState('');
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null);
  const [bridgeCapabilities, setBridgeCapabilities] = useState<string[]>([]);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeNeedsReload, setBridgeNeedsReload] = useState(false);
  const [collectionTask, setCollectionTask] = useState<CollectionTaskState>(emptyCollectionTask);
  const [isCollecting, setIsCollecting] = useState(false);
  const [todayStart, setTodayStart] = useState(startOfTodayTimestamp);
  const [homeAccountId, setHomeAccountId] = useState('');
  const [contentScope, setContentScope] = useState<ContentBrowseScope>('all');
  const [contentResult, setContentResult] = useState<ContentResultFilter>('all');
  const [reader, setReader] = useState<ReaderState | null>(null);
  const closeReader = useCallback(() => setReader(null), []);
  const openReader = (video: Video, section: ReadingSection, scope: Video[]) => {
    setReader({ videoId: video.id, videoIds: scope.map((item) => item.id), section });
  };
  const processedResultIds = useRef<Set<string>>(new Set());
  const observedJobStates = useRef<Map<string, string>>(new Map());
  const accountsRef = useRef<Account[]>([]);
  const videosRef = useRef<Video[]>([]);
  const collectionUpdatesRef = useRef<Map<string, { accountName: string; newVideoCount: number }>>(new Map());

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

  useEffect(() => {
    const expired = () => { setAuthPhase('login'); setLoaded(false); setAuthMessage('工作台登录已到期，请输入访问密码重新登录'); };
    window.addEventListener('host-session-expired', expired);
    return () => window.removeEventListener('host-session-expired', expired);
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
    const nextLinkVideos = Array.isArray(envelope.linkVideos)
      ? envelope.linkVideos.map((video) => normalizeVideo(video as Partial<Video>))
        .sort((left, right) => (right.linkAddedAt || right.firstSeenAt).localeCompare(left.linkAddedAt || left.firstSeenAt))
      : [];
    const nextSnapshots = Array.isArray(envelope.snapshots) ? envelope.snapshots as Snapshot[] : [];
    const browser = envelope.browser as Record<string, unknown> | undefined;
    setDedicatedBrowser(browser?.mode === 'dedicated_browser');
    setBrowserError(typeof browser?.error === 'string' ? browser.error : '');
    setLanUrls(Array.isArray(envelope.lanUrls) ? envelope.lanUrls.filter((url): url is string => typeof url === 'string') : []);
    setAccounts(nextAccounts);
    setHomeAccountId((current) => !current || nextAccounts.some((account) => account.id === current) ? current : '');
    accountsRef.current = nextAccounts;
    setVideos(nextVideos);
    setLinkVideos(nextLinkVideos);
    videosRef.current = nextVideos;
    setSnapshots(nextSnapshots);
    setSelectedAccountId((current) => nextAccounts.some((account) => account.id === current)
      ? current
      : nextAccounts.some((account) => account.id === readStored<string>(selectedAccountStoreKey, ''))
        ? readStored<string>(selectedAccountStoreKey, '')
        : nextAccounts[0]?.id || '');
    const connectorState = envelope.connector && typeof envelope.connector === 'object'
      ? envelope.connector as Record<string, unknown>
      : envelope;
    setHostConnected(Boolean(
      connectorState.connected
      ?? connectorState.connectorConnected
      ?? connectorState.chromeConnected
      ?? false
    ));
    setHostConnectorCapabilities(Array.isArray(connectorState.capabilities)
      ? connectorState.capabilities.filter((value): value is string => typeof value === 'string')
      : []);
    setHostWorkerStatus(textValue(connectorState.workerStatus ?? connectorState.status));
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
        result: job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : {},
        progress: job.progress && typeof job.progress === 'object' ? job.progress as Record<string, unknown> : {},
        message: textValue(job.message) || null,
        error: textValue(job.error ?? job.lastError) || null,
        createdAt: textValue(job.createdAt ?? job.created_at) || null,
        updatedAt: textValue(job.updatedAt ?? job.updated_at) || null,
        attemptCount: Number(job.attemptCount ?? job.attempt_count) || 0,
      } satisfies HostJob;
    });
    setHostJobs(jobs);
    const activeStatuses = new Set(['pending', 'queued', 'waiting', 'claimed', 'running', 'processing']);
    for (const job of jobs) {
      const before = observedJobStates.current.get(job.id);
      if ((job.type === 'collect_latest' || job.type === 'archive_account') && before && activeStatuses.has(before) && !activeStatuses.has(job.status)) {
        const updates = Array.isArray(job.result.accountUpdates) ? job.result.accountUpdates as { accountName: string; newVideoCount: number }[] : [];
        setNotice(job.status === 'succeeded'
          ? updates.length ? `检查完成，新增 ${Number(job.result.newVideoCount) || 0} 条：${updates.map((item) => `${item.accountName} +${item.newVideoCount}`).join('；')}` : '采集完成，视频与互动数据已更新；重复视频已自动合并'
          : `采集未完成：${job.error || '请检查电脑上的抖音登录状态后重试'}`);
      }
    }
    observedJobStates.current = new Map(jobs.map((job) => [job.id, job.status]));
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
    } else {
      const last = jobs.find((job) => job.type === 'collect_latest' || job.type === 'archive_account');
      if (last) setCollectionTask({ ...emptyCollectionTask, phase: 'completed', completedAt: last.updatedAt,
        succeeded: Number(last.result.succeeded) || (last.status === 'succeeded' ? 1 : 0),
        failed: Number(last.result.failed) || (last.status === 'succeeded' ? 0 : 1) });
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
    const migrationId = createClientId();
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
          setAuthMessage(isHostLocal ? '请先设置工作台访问密码' : '请先在主机的 localhost 页面完成首次设置');
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
    if (!loaded || dedicatedBrowser) return;
    const applyCollectionResult = (payload: CollectionMessage) => {
      const eventId = payload.eventId || payload.messageId;
      if (!payload.connectorJobId) {
        if (eventId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', eventIds: [eventId] }, window.location.origin);
        return;
      }
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

      const authoritativeAccountId = payload.accountId || collected[0]?.accountId || '';
      const knownVideoIds = new Set(videosRef.current
        .filter((video) => video.accountId === authoritativeAccountId)
        .map((video) => video.id));
      const persistedResult = accountsRef.current.find((account) => account.id === authoritativeAccountId);
      const isPersistedReplay = payload.mode === 'latest'
        && persistedResult?.lastSuccessAt === capturedAt
        && persistedResult.latestCheckNewVideoCount !== null;
      const newVideoIds = isPersistedReplay
        ? persistedResult?.latestCheckNewVideoIds || []
        : payload.mode === 'latest'
        ? [...new Set(collected.map((video) => video.id).filter((videoId) => !knownVideoIds.has(videoId)))]
        : [];
      const newVideoCount = isPersistedReplay
        ? persistedResult.latestCheckNewVideoCount as number
        : newVideoIds.length;
      if (payload.mode === 'latest' && authoritativeAccountId) {
        collectionUpdatesRef.current.set(authoritativeAccountId, {
          accountName: payload.accountName || '当前账号',
          newVideoCount,
        });
      }

      setVideos((current) => {
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
            transcript: incoming.transcript || previous?.transcript || null,
            transcriptStatus: previous?.transcriptStatus === 'ready' ? 'ready' : incoming.transcriptStatus,
            transcriptUpdatedAt: (incoming.transcript ? (incoming.transcriptUpdatedAt || previous?.transcriptUpdatedAt) : (previous?.transcriptUpdatedAt || incoming.transcriptUpdatedAt)) || null,
            transcriptError: previous?.transcriptError || incoming.transcriptError,
            analysis: previous?.analysis || incoming.analysis,
            analysisUsage: incoming.analysisUsage || previous?.analysisUsage || null,
            analysisRuns: incoming.analysisRuns.length ? incoming.analysisRuns : (previous?.analysisRuns || []),
            analysisStatus: previous?.analysisStatus === 'ready' ? 'ready' : incoming.analysisStatus,
            analysisUpdatedAt: previous?.analysisUpdatedAt || incoming.analysisUpdatedAt,
            analysisError: previous?.analysisError || incoming.analysisError,
          });
        }
        const nextVideos = [...byId.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
        videosRef.current = nextVideos;
        return nextVideos;
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
      setAccounts((current) => {
        const nextAccounts = current.map((account) => payload.accountId === account.id ? {
          ...account,
          name: payload.accountName || account.name,
          avatarUrl: payload.accountAvatarUrl || account.avatarUrl,
          lastCheckedAt: capturedAt,
          lastSuccessAt: capturedAt,
          status: 'ready' as const,
          initialSyncStatus: payload.mode === 'initial' ? 'complete' as const : account.initialSyncStatus,
          initialSyncCompletedAt: payload.mode === 'initial' ? capturedAt : account.initialSyncCompletedAt,
          latestVideoIds: [...new Set(collected.map((video) => video.id))].slice(0, 5),
          latestCheckNewVideoCount: payload.mode === 'latest' ? newVideoCount : account.latestCheckNewVideoCount,
          latestCheckNewVideoIds: payload.mode === 'latest' ? newVideoIds : account.latestCheckNewVideoIds,
          currentSyncMode: null,
        } : account);
        accountsRef.current = nextAccounts;
        return nextAccounts;
      });
      setNotice(payload.warning || (payload.mode === 'latest'
        ? newVideoCount
          ? `${payload.accountName || '当前账号'}：发现 ${newVideoCount} 条新视频`
          : `${payload.accountName || '当前账号'}：本次没有发现新视频`
        : `${payload.accountName || '当前账号'}：已完成近 ${collected.length} 条视频建档`));

      if (eventId) {
        processedResultIds.current.add(eventId);
        window.localStorage.setItem(processedResultStoreKey, JSON.stringify([...processedResultIds.current]));
        window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', eventIds: [eventId] }, window.location.origin);
      }
    };

    const applyCollectionError = (payload: CollectionMessage) => {
      if (!payload.connectorJobId) {
        if (payload.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [payload.messageId] }, window.location.origin);
        return;
      }
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

    const pingBridge = () => window.postMessage({ source: 'douyin-monitor', type: 'PING' }, window.location.origin);
    const handshakeTimer = window.setTimeout(() => setBridgeReady(false), 1800);
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data?.source !== 'douyin-monitor-extension') return;
      if (event.data.type === 'BRIDGE_READY') {
        if (event.data.extensionVersion) {
          const capabilities = Array.isArray(event.data.capabilities)
            ? event.data.capabilities.filter((value: unknown): value is string => typeof value === 'string')
            : [];
          const compatible = isAnalysisExtensionCompatible(event.data.extensionVersion, capabilities);
          setBridgeReady(true);
          setBridgeVersion(event.data.extensionVersion);
          setBridgeCapabilities(capabilities);
          setBridgeBusy(Boolean(event.data.collectionInProgress || event.data.activeJobId));
          setBridgeNeedsReload(!compatible);
          window.clearTimeout(handshakeTimer);
        }
      }
      if (event.data.type === 'BRIDGE_STALE') {
        setBridgeReady(false);
        setBridgeBusy(false);
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
        if (!event.data.connectorJobId) return;
        collectionUpdatesRef.current.clear();
        setIsCollecting(true);
        setCollectionTask({
          ...emptyCollectionTask,
          runId: event.data.runId || null,
          phase: 'running',
          totalAccounts: Number(event.data.totalAccounts) || 0,
        });
      }
      if (event.data.type === 'COLLECTION_STARTED') {
        if (!event.data.connectorJobId) return;
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
            : `正在检查 ${event.data.accountName} 最新 5 条视频`);
        }
      }
      if (event.data.type === 'COLLECTION_ACCOUNT_PROGRESS') {
        if (!event.data.connectorJobId) return;
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
        if (!event.data.connectorJobId) return;
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
        const updateResults = [...collectionUpdatesRef.current.values()];
        const updatedAccounts = updateResults.filter((result) => result.newVideoCount > 0);
        const newVideoCount = updatedAccounts.reduce((total, result) => total + result.newVideoCount, 0);
        setNotice(updateResults.length
          ? newVideoCount
            ? `本轮检查完成：${updatedAccounts.length} 个博主共发布 ${newVideoCount} 条新视频`
            : `本轮检查完成：${succeeded} 个账号均未发现新视频`
          : `本轮检查完成：${succeeded} 个账号成功，${failed} 个账号失败`);
      }
      if (event.data.type === 'COLLECTION_ERROR') {
        if (!event.data.connectorJobId) {
          if (event.data.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [event.data.messageId] }, window.location.origin);
          return;
        }
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
    const pingTimer = window.setInterval(pingBridge, 15_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') pingBridge();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    pingBridge();
    return () => {
      window.clearTimeout(handshakeTimer);
      window.clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('message', receive);
    };
  }, [loaded, dedicatedBrowser]);

  useEffect(() => {
    const capabilityReady = isAnalysisExtensionCompatible(bridgeVersion, bridgeCapabilities);
    if (dedicatedBrowser || !loaded || !bridgeReady || bridgeNeedsReload || !capabilityReady) return;
    window.postMessage({
      source: 'douyin-monitor',
      type: 'SYNC_ACCOUNTS',
      accounts,
    }, window.location.origin);
  }, [accounts, bridgeCapabilities, bridgeNeedsReload, bridgeReady, bridgeVersion, loaded, dedicatedBrowser]);

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
  const homeVideos = useMemo(() => browseContentVideos(videos, accounts, {
    accountId: homeAccountId, scope: contentScope, result: contentResult,
  }).map((video) => ({ ...video, authorName: video.authorName || accounts.find((account) => account.id === video.accountId)?.name || null })), [videos, homeAccountId, accounts, contentScope, contentResult]);
  const checkAccountId = collectionAccountScope(activeNav, homeAccountId, selectedAccount?.id || '');
  const readerVideo = reader ? [...videos, ...linkVideos].find((video) => video.id === reader.videoId) : null;
  const selectedAccountSnapshots = useMemo(() => {
    if (!selectedAccount) return [];
    const videoIds = new Set(selectedAccountVideos.map((video) => video.id));
    return snapshots.filter((snapshot) => videoIds.has(snapshot.videoId)
      && (!snapshot.accountId || snapshot.accountId === selectedAccount.id));
  }, [selectedAccount, selectedAccountVideos, snapshots]);
  const createHostJob = async (type: 'collect_latest' | 'archive_account' | 'analyze_video', payload: Record<string, unknown>) => {
    const response = await hostApi<Record<string, unknown>>(apiBase, '/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ type, payload }),
    }, csrfToken);
    if (response.reused === true && response.video && typeof response.video === 'object') {
      const saved = normalizeVideo(response.video as Partial<Video>);
      setVideos((current) => current.map((video) => video.id === saved.id ? saved : video));
      setLinkVideos((current) => current.map((video) => video.id === saved.id ? saved : video));
      setNotice('已复用完整结果，没有发起新的模型调用');
      return response;
    }
    const rawJob = response.job && typeof response.job === 'object' ? response.job as Record<string, unknown> : response;
    if (rawJob.id || rawJob.jobId) {
      setHostJobs((current) => [{
        id: String(rawJob.id || rawJob.jobId),
        type,
        status: String(rawJob.status || 'queued').toLowerCase(),
        payload,
        result: rawJob.result && typeof rawJob.result === 'object' ? rawJob.result as Record<string, unknown> : {},
        message: textValue(rawJob.message) || null,
        error: textValue(rawJob.error) || null,
        createdAt: textValue(rawJob.createdAt ?? rawJob.created_at) || new Date().toISOString(),
        updatedAt: textValue(rawJob.updatedAt ?? rawJob.updated_at) || null,
        attemptCount: Number(rawJob.attemptCount ?? rawJob.attempt_count) || 0,
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
        id: createClientId(),
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
        latestCheckNewVideoCount: null,
        latestCheckNewVideoIds: [],
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
    const accountScopedView = Boolean(checkAccountId);
    const scopedAccount = accounts.find((account) => account.id === checkAccountId);
    const initializedAccounts = accountScopedView
      ? scopedAccount?.initialSyncStatus === 'complete' ? [scopedAccount] : []
      : accounts.filter((account) => account.initialSyncStatus === 'complete');
    if (!initializedAccounts.length) {
      setNotice('请先在账号卡片点击“首次抓取近 30 条”，完成建档后才能检查最新 5 条');
      return;
    }
    setIsCollecting(true);
    collectionUpdatesRef.current.clear();
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
        ? `${initializedAccounts[0].name} 的最新 5 条检查已进入主机队列`
        : `全部 ${initializedAccounts.length} 个已建档账号已进入主机检查队列`);
      return loadHostJobs();
    }).catch((error: Error) => {
      setIsCollecting(false);
      setNotice(`检查任务创建失败：${error.message}`);
      void loadHostState().catch(() => undefined);
    });
  };

  const updateVideoEverywhere = (videoId: string, update: (video: Video) => Video) => {
    const apply = (current: Video[]) => current.map((video) => video.id === videoId ? update(video) : video);
    setVideos(apply);
    setLinkVideos(apply);
  };

  const submitVideoLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!videoLinkInput.trim()) {
      setNotice('请粘贴抖音视频分享链接');
      return;
    }
    setLinkSubmitting(true);
    try {
      const response = await hostApi<Record<string, unknown>>(apiBase, '/api/video-links/analyze', {
        method: 'POST',
        body: JSON.stringify({ shareText: videoLinkInput.trim() }),
      }, csrfToken);
      const rawVideo = response.video && typeof response.video === 'object'
        ? response.video as Partial<Video>
        : null;
      if (!rawVideo?.id || !rawVideo.accountId) throw new Error('主机服务没有返回有效的视频记录');
      const video = normalizeVideo(rawVideo);
      setLinkVideos((current) => [video, ...current.filter((item) => item.id !== video.id)]);
      openReader(video, 'content', [video, ...linkVideos.filter((item) => item.id !== video.id)]);
      setVideoLinkInput('');
      if (response.reused === true) {
        setNotice('这条视频已有完整分析，已直接打开历史结果');
      } else {
        setNotice('视频链接已识别，正在读取封面、标题和博主信息并分析完整原视频');
        if (!dedicatedBrowser && isHostLocal && bridgeReady && !bridgeNeedsReload) {
          window.postMessage({ source: 'douyin-monitor', type: 'WAKE_CONNECTOR' }, window.location.origin);
        }
        await loadHostJobs();
      }
    } catch (error) {
      setNotice(`视频链接分析启动失败：${error instanceof Error ? error.message : '主机服务没有响应'}`);
    } finally {
      setLinkSubmitting(false);
    }
  };

  const requestAnalysis = (video: Video, regenerate = false, forceRegenerate = false) => {
    if (!regenerate && video.transcriptStatus === 'ready' && videoContentReading(video.analysis).complete && isRemotionPlan(video.analysis)) return;
    if (video.analysisStatus === 'queued' || video.analysisStatus === 'processing') {
      if (video.analysisStatus === 'queued') {
        window.postMessage({ source: 'douyin-monitor', type: 'WAKE_CONNECTOR' }, window.location.origin);
        setNotice(hostConnected
          ? bridgeBusy || hostWorkerStatus === 'busy' || hostWorkerStatus === 'running'
            ? '电脑正在处理上一项任务，完成后会自动继续本条分析'
            : '分析任务已排队，电脑后台会自动继续'
          : '任务已保留，等待电脑采集服务连接后继续');
      }
      return;
    }
    if (!qwenConfigured) {
      if (isHostLocal) { setReader(null); setShowQwenConfig(true); }
      else setNotice('主机尚未配置 Qwen API Key，请先在主机 localhost 页面完成配置');
      return;
    }
    const hostAnalysisCapable = hostConnectorCapabilities.includes(requiredExtensionCapability);
    if (!hostAnalysisCapable) {
      setNotice(dedicatedBrowser ? '电脑采集服务尚未就绪，请检查电脑工作台显示的状态' : isHostLocal && bridgeNeedsReload
        ? '当前 Chrome 组件缺少完整视频分析能力，需要更新一次；之后连接会自动恢复'
        : '主机 Chrome 尚未报告完整视频分析能力，正在等待组件自动连接');
      window.postMessage({ source: 'douyin-monitor', type: 'PING' }, window.location.origin);
      return;
    }
    updateVideoEverywhere(video.id, (item) => ({
      ...item,
      transcriptStatus: item.transcript || item.transcriptStatus === 'ready' ? item.transcriptStatus : 'processing',
      transcriptError: null,
      analysisUsage: null,
      analysisStatus: 'queued',
      analysisError: null,
    }));
    void createHostJob('analyze_video', {
      accountId: video.accountId,
      videoId: video.id,
      videoUrl: video.url,
      title: video.title,
      description: video.description,
      authorName: video.authorName,
      ...(video.isLinkAnalysis ? { sourceKind: 'video_link' } : {}),
      ...(regenerate || video.analysisStatus === 'error' ? { retry: true } : {}),
      ...(forceRegenerate ? { forceRegenerate: true } : {}),
    }).then((result) => {
      if (result.reused === true) return loadHostJobs();
      setNotice('AI 分析已进入主机队列，将用完整视频和云端口播识别生成内容分析与制作规范');
      if (!dedicatedBrowser && isHostLocal && bridgeReady && !bridgeNeedsReload) {
        window.postMessage({ source: 'douyin-monitor', type: 'WAKE_CONNECTOR' }, window.location.origin);
      }
      return loadHostJobs();
    }).catch((error: Error) => {
      updateVideoEverywhere(video.id, (item) => ({
        ...item,
        transcriptStatus: item.transcript || item.transcriptStatus === 'ready' ? item.transcriptStatus : 'idle',
        analysisStatus: 'error',
        analysisError: error.message,
      }));
      setNotice(`AI 分析任务创建失败：${error.message}`);
    });
  };

  const cancelAnalysis = (job: HostJob) => {
    void hostApi(apiBase, `/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' }, csrfToken)
      .then(() => { setNotice('任务已取消，已完成结果继续保留'); return Promise.all([loadHostJobs(), loadHostState()]); })
      .catch((error: Error) => setNotice(`取消失败：${error.message}`));
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
      setHomeAccountId((current) => current === id ? '' : current);
      setVideos((current) => current.filter((video) => video.accountId !== id));
      setSnapshots((current) => current.filter((snapshot) => snapshot.accountId !== id && !removedVideoIds.has(snapshot.videoId)));
      setNotice('账号及其主机记录已移除');
    }).catch((error: Error) => setNotice(`移除失败：${error.message}`));
  };

  const initializedAccountCount = accounts.filter((account) => account.initialSyncStatus === 'complete').length;
  const pendingAccountCount = accounts.length - initializedAccountCount;
  const unreadAccounts = accounts.filter((account) => (account.latestCheckNewVideoCount || 0) > 0
    && (!account.lastCheckedAt || account.updatesReadAt !== account.lastCheckedAt));
  const updatedAccountCount = unreadAccounts.length;
  const latestNewVideoCount = unreadAccounts.reduce((total, account) => total + (account.latestCheckNewVideoCount || 0), 0);
  const dismissAccountBadge = () => {
    if (!unreadAccounts.length) return;
    const displayed = unreadAccounts.map(({ id, lastCheckedAt }) => ({ id, lastCheckedAt }));
    setAccounts((current) => current.map((account) => displayed.some((item) => item.id === account.id && item.lastCheckedAt === account.lastCheckedAt)
      ? { ...account, updatesReadAt: account.lastCheckedAt } : account));
    void hostApi(apiBase, '/api/accounts/ack-updates', { method: 'POST', body: JSON.stringify({ accounts: displayed }) }, csrfToken)
      .then(() => loadHostState())
      .catch(() => { setNotice('未能保存气泡已读状态，请稍后重试'); void loadHostState(); });
  };
  const lastAccountCheckAt = accounts.reduce<string | null>((latest, account) => {
    if (!account.lastCheckedAt) return latest;
    if (!latest) return account.lastCheckedAt;
    return Date.parse(account.lastCheckedAt) > Date.parse(latest) ? account.lastCheckedAt : latest;
  }, null);
  const lastAccountSuccessAt = accounts.map((account) => account.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null;
  const currentTaskLabel = isCollecting
    ? collectionTask.accountName
      ? `正在处理 ${collectionTask.accountName} · 账号 ${collectionTask.accountIndex || 1}/${collectionTask.totalAccounts || accounts.length}${collectionTask.totalVideos ? ` · 视频 ${collectionTask.completedVideos}/${collectionTask.totalVideos}` : ''}`
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

        <h1>{authPhase === 'setup' ? '设置工作台访问密码' : authPhase === 'login' ? '登录监控工作台' : authPhase === 'error' ? '主机服务未连接' : '正在载入共享数据'}</h1>
        <p>{authMessage || '正在加载账号、视频和分析结果。'}</p>
        {(authPhase === 'setup' || authPhase === 'login') && !setupBlocked && <form onSubmit={submitAuth}>
          <label htmlFor="access-password">访问密码</label>
          <input id="access-password" type="password" autoComplete={authPhase === 'login' ? 'current-password' : 'new-password'} minLength={10} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoFocus />
          {authPhase === 'setup' && <><small className="accessPasswordHint">至少 10 位，用于你的设备登录工作台。</small><label htmlFor="access-password-confirm">再次输入密码</label><input id="access-password-confirm" type="password" autoComplete="new-password" minLength={10} value={authPasswordConfirm} onChange={(event) => setAuthPasswordConfirm(event.target.value)} /></>}
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
          <div className="brandText"><strong>{PLATFORMS[activePlatform].name}工作台</strong></div>
        </div>
        <nav className="navigation" aria-label="主导航">

          {navItems.map(([icon, label]) => (
            <button className={activeNav === label ? 'navItem active' : 'navItem'} key={label} onClick={() => {
              animateChange(() => setActiveNav(label));
              if (label === '信源管理') dismissAccountBadge();
            }}>
              <span className="navIcon">{icon}</span><span className="navText">{label}</span>
              {label === '信源管理' && updatedAccountCount > 0 && <span className="navUpdateBadge" title={`${updatedAccountCount} 个博主有更新，共 ${latestNewVideoCount} 条新视频`}>{latestNewVideoCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebarFoot">
          <div className={hostConnected ? 'localStatus connected' : 'localStatus'}><i /><span><b>主机采集服务</b><small>{dedicatedBrowser ? (hostConnected ? '已连接' : '正在连接电脑后台') : !hostConnected ? '服务已连接 · 等待主机 Chrome 自动连接' : isHostLocal ? bridgeNeedsReload ? `Chrome 组件缺少视频分析能力 · 需更新一次到 v${requiredExtensionVersion}` : bridgeReady ? `Chrome 已连接${bridgeVersion ? ` · v${bridgeVersion}` : ''}` : 'Chrome 后台已连接 · 网页桥接自动恢复中' : '已连接 · 任务由主机 Chrome 执行'}</small></span></div>
          <button className="logoutButton" type="button" onClick={logout}>退出当前设备</button>
        </div>
      </aside>

      <section className="workspace">
        {activePlatform === 'douyin' && (
          <>
            <header className="topbar">
              <div>
                <h1>{activeNav}</h1>
                <p className="subtitle">{activeNav === '链接分析'
                  ? '粘贴分享链接，获取口播稿、内容分析和制作规范。'
                  : activeNav === '互动数据' ? '按视频发布时间查看当前账号的互动走势，逐条比较作品表现。'
                  : activeNav === '内容浏览' ? '按发布时间浏览内容，查看要点后决定是否深入阅读。' : '添加账号并手动采集，管理已有信源。'}</p>
              </div>
              <div className="topActions">
                {activeNav !== '链接分析' && <button className="secondaryButton" onClick={requestCheck} disabled={isCollecting} title={checkAccountId ? '检查当前账号的最新 5 条视频' : '逐个检查全部已建档账号的最新 5 条视频'}>{isCollecting ? '检查中…' : checkAccountId ? '检查当前账号' : '检查全部账号'}</button>}
                <details className="settingsEntry"><summary>设置</summary><div className="settingsActions">
                {dedicatedBrowser && isHostLocal && <button className="secondaryButton" disabled={openingBrowser} title="在电脑打开专用 Chrome，用于登录抖音和处理验证码" onClick={() => {
                  setOpeningBrowser(true);
                  void hostApi(apiBase, '/api/browser/open', { method: 'POST', body: '{}' }, csrfToken)
                    .then(() => setNotice('正在电脑打开专用浏览器，请完成抖音登录；遇到验证码也在此窗口处理'))
                    .catch((error: Error) => setNotice(error.message))
                    .finally(() => setOpeningBrowser(false));
                }}>{openingBrowser ? '正在打开…' : '在电脑登录抖音'}</button>}
                {isHostLocal
                  ? <button className={`qwenControl ${qwenConfigured ? 'ready' : ''}`} type="button" onClick={() => setShowQwenConfig(true)}><b>{qwenConfigured ? 'AI 分析设置' : '配置 AI 分析'}</b></button>
                  : <div className={`qwenControl remote ${qwenConfigured ? 'ready' : ''}`} title="API Key 只能在主机 localhost 页面配置"><b>{qwenConfigured ? 'AI 分析已配置' : 'AI 分析未配置'}</b></div>}
                {dedicatedBrowser && isHostLocal && <details className="browserAccessNote"><summary>手机访问地址</summary>
                  {lanUrls.length ? lanUrls.map((url) => <p key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></p>) : <p>暂未检测到局域网地址，请连接 Wi-Fi 后刷新网页。</p>}
                  <small>连接同一个 Wi-Fi，使用工作台访问密码登录。电脑需保持开机并运行服务。</small>
                </details>}
                </div></details>
                {activeNav === '信源管理' && <button className="primaryButton" onClick={() => setShowAddAccount(true)}>添加监控账号</button>}
              </div>
            </header>

            {dedicatedBrowser && (browserError || !isHostLocal) && <div className="browserAccessNote">

              {browserError && <p role="alert">{browserError}。已保存结果仍可阅读。请在电脑打开抖音登录窗口检查。</p>}
              {!isHostLocal && <small>采集和分析由电脑执行；抖音登录和验证码需要在电脑处理。</small>}
            </div>}

            {activeNav === '内容浏览' && (
              <section className="homeFeed" aria-label="全部信源内容">
                <div className="feedToolbar">
                  <div className="contentScope" role="group" aria-label="内容范围">
                    <button type="button" aria-pressed={contentScope === 'all'} onClick={() => animateChange(() => setContentScope('all'))}>全部内容</button>
                    <button type="button" aria-pressed={contentScope === 'latest'} onClick={() => animateChange(() => setContentScope('latest'))}>最新 5 条 / 账号</button>
                  </div>
                  <label>信源账号<select value={homeAccountId} onChange={(event) => { const value = event.currentTarget.value; animateChange(() => { setHomeAccountId(value); if (value) setSelectedAccountId(value); }); }}><option value="">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                </div>
                <div className="feedToolbar">
                  <label>分析结果<select value={contentResult} onChange={(event) => { const value = event.currentTarget.value as ContentResultFilter; animateChange(() => setContentResult(value)); }}><option value="all">全部状态</option><option value="available">已有结果</option><option value="missing">尚无结果</option></select></label>
                  <span>{homeVideos.length} 条视频 · 按视频发布时间排序</span>
                </div>
                {(!browserError && (accounts.some((account) => account.status === 'error') || !hostConnected)) && <div className="collectionWarning" role="status"><p>{accounts.filter((account) => account.status === 'error').map((account) => `${account.name}：${account.collectionError || '采集未完成'}`).join('；') || '主机采集服务暂未连接。'} 已保存结果仍可阅读。</p><button type="button" className="secondaryButton" onClick={() => animateChange(() => setActiveNav('信源管理'))}>查看账号与采集状态</button></div>}
                {homeVideos.length ? <VideoTable videos={homeVideos} jobs={hostJobs} onOpen={openReader} onAnalysis={requestAnalysis} onCancel={cancelAnalysis} connectorConnected={hostConnected} connectorBusy={bridgeBusy || hostWorkerStatus === 'busy' || hostWorkerStatus === 'running'} showAuthor />
                  : <EmptyData title={videos.length ? '当前筛选下没有视频' : '还没有视频数据'} detail={videos.length ? '调整账号、内容范围或结果筛选，查看其他已保存内容。' : '在信源管理中添加账号并手动采集。'} />}
                <details className="collectionSummary"><summary>采集状态与数据概况</summary>
                  <div className="statsGrid">{statCards.map(([label, value, detail]) => <article className="statCard" key={String(label)}><div className="statLabel">{label}</div><strong>{value}</strong>{detail && <small>{detail}</small>}</article>)}</div>
                  <div className="taskStatusGrid"><span><small>最近一次采集尝试</small><b>{formatTime(lastAccountCheckAt)}</b></span><span><small>最近一次成功采集</small><b>{formatTime(lastAccountSuccessAt)}</b></span><span><small>当前采集任务</small><b>{currentTaskLabel}</b></span></div>
                  <p className="taskNote">采集由你手动发起；今日新收录按首次采集时间统计，不代表今日发布。</p>
                </details>
              </section>
            )}

            {activeNav === '信源管理' && (
              <><SectionHeading title="全部监控账号" count={`${accounts.length} 个账号`} /><AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} onInitialSync={startInitialSync} isCollecting={isCollecting} /></>
            )}

            {activeNav === '链接分析' && (
              <>
                <section className="linkAnalysisEntry">
                  <div><h2>粘贴抖音视频分享链接</h2><p>支持视频链接或整段分享文案，使用完整原视频分析。</p></div>
                  <form onSubmit={submitVideoLink}>
                    <textarea
                      value={videoLinkInput}
                      onChange={(event) => setVideoLinkInput(event.target.value)}
                      placeholder="例如：复制此链接，打开抖音搜索，直接观看视频 https://v.douyin.com/……"
                      disabled={linkSubmitting}
                      aria-label="抖音视频分享链接或分享文案"
                    />
                    <button className="primaryButton" type="submit" disabled={linkSubmitting || !videoLinkInput.trim()}>{linkSubmitting ? '正在解析…' : '开始分析'}</button>
                  </form>
                  <small>结果保存在本机；已分析的视频直接打开历史结果，不重复调用 AI。</small>
                </section>
                <SectionHeading title="链接记录" count={`${linkVideos.length} 条`} />
                {linkVideos.length
                  ? <VideoTable
                    videos={linkVideos}
                    jobs={hostJobs}
                    onOpen={openReader}
                    onAnalysis={requestAnalysis}
                    onCancel={cancelAnalysis}
                    connectorConnected={hostConnected}
                    connectorBusy={bridgeBusy || hostWorkerStatus === 'busy' || hostWorkerStatus === 'running'}
                    showAuthor
                  />
                  : <EmptyData title="还没有视频链接分析记录" detail="在上方粘贴任意有效的抖音视频分享链接，提交后会立即开始完整原视频分析。" />}
              </>
            )}

            {activeNav === '互动数据' && (
              <>
                <AccountSelector accounts={accounts} videos={videos} selectedAccountId={selectedAccount?.id || ''} onSelect={(id) => animateChange(() => setSelectedAccountId(id))} />
                <SectionHeading title={selectedAccount ? `${selectedAccount.name} · 互动数据` : '互动数据'} count={`${selectedAccountVideos.length} 条视频`} />
                <AnalyticsBoard
                  key={selectedAccount?.id || 'empty'}
                  videos={selectedAccountVideos}
                  snapshots={selectedAccountSnapshots}
                  accountName={selectedAccount?.name || null}
                />
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

      {reader && readerVideo && <VideoReader video={readerVideo} jobs={hostJobs} initialSection={reader.section} index={reader.videoIds.indexOf(reader.videoId)} total={reader.videoIds.length} onClose={closeReader} onNavigate={(offset) => setReader((current) => {
        if (!current) return current;
        const id = current.videoIds[current.videoIds.indexOf(current.videoId) + offset];
        return id ? { ...current, videoId: id } : current;
      })} onAnalysis={requestAnalysis} onCancel={cancelAnalysis} />}

      {showAddAccount && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => closeOverlay(() => setShowAddAccount(false))}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title" onSubmit={submitAccount} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" aria-label="关闭" onClick={() => closeOverlay(() => setShowAddAccount(false))}>×</button>
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
            <div className="modalNote">添加后自动抓取近 30 条非置顶视频；以后每次只检查最新 5 条。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => closeOverlay(() => setShowAddAccount(false))}>取消</button><button className="primaryButton" type="submit">添加并抓取近 30 条</button></div>
          </form>
        </div>
      )}

      {showQwenConfig && isHostLocal && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => closeOverlay(() => { setQwenApiKey(''); setShowQwenConfig(false); })}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="qwen-config-title" onSubmit={saveQwenKey} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" aria-label="关闭" onClick={() => closeOverlay(() => { setQwenApiKey(''); setShowQwenConfig(false); })}>×</button>
            <h2 id="qwen-config-title">配置 Qwen 视频分析</h2>
            <p>API Key 只会交给主机服务，并使用当前 Windows 用户加密保存；不会写入浏览器、SQLite、Git 或日志。其他设备只能看到是否已配置。</p>
            <label htmlFor="qwen-api-key">Qwen API Key</label>
            <input id="qwen-api-key" type="password" autoComplete="off" value={qwenApiKey} onChange={(event) => setQwenApiKey(event.target.value)} placeholder={qwenConfigured ? '输入新 Key 可替换现有配置' : '请输入 API Key'} autoFocus />
            <div className="modalNote">视频分析使用 qwen3.8-flash，口播识别使用 qwen3-asr-flash-filetrans。开始分析后，完整视频与完整音轨会分别发送至云端；已有口播稿直接复用。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => closeOverlay(() => { setQwenApiKey(''); setShowQwenConfig(false); })}>取消</button><button className="primaryButton" type="submit" disabled={qwenSaving}>{qwenSaving ? '保存中…' : qwenConfigured ? '替换配置' : '安全保存'}</button></div>
          </form>
        </div>
      )}

      {notice && <div className="toast" role="status"><button type="button" onClick={() => setNotice('')} aria-label={`${notice}，点击关闭提示`} title="点击关闭提示">{notice}<span aria-hidden="true"> ×</span></button></div>}
    </main>
  );
}

function AnalyticsBoard({ videos, snapshots, accountName }: {
  videos: Video[];
  snapshots: Snapshot[];
  accountName: string | null;
}) {
  const [metricKey, setMetricKey] = useState<AnalyticsMetricKey>('likeCount');
  const [sortMode, setSortMode] = useState<AnalyticsSortMode>('published');
  const [chartMode, setChartMode] = useState<'line' | 'bar'>('line');
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const orderedVideos = useMemo(() => orderVideosOldestFirst(videos), [videos]);
  const selectedVideo = orderedVideos.find((video) => video.id === selectedVideoId)
    || orderedVideos.at(-1)
    || null;

  if (!videos.length) {
    return <EmptyData title={accountName ? `${accountName} 尚无建档数据` : '等待首次建档'} detail="完成当前账号的首次建档后，这里会根据首次近 30 条非置顶视频及后续发现的新视频生成独立统计，不会混入其他账号。" />;
  }

  return <section className="analyticsComparisonView">
    <MetricBarComparison
      videos={orderedVideos}
      metricKey={metricKey}
      sortMode={sortMode}
      chartMode={chartMode}
      selectedVideoId={selectedVideo?.id || ''}
      onMetricChange={(metric) => animateChange(() => setMetricKey(metric))}
      onSortChange={(mode) => animateChange(() => {
        setSortMode(mode);
        if (mode === 'value') setChartMode('bar');
      })}
      onChartModeChange={(mode) => animateChange(() => {
        setChartMode(mode);
        if (mode === 'line') setSortMode('published');
      })}
      onSelectVideo={(videoId) => animateChange(() => setSelectedVideoId(videoId))}
    />
    {selectedVideo && <SelectedVideoComparison video={selectedVideo} videos={orderedVideos} snapshots={snapshots} />}
    <details className="analyticsBenchmarks">
      <summary>账号数据基准与近期对比</summary>
      <p className="analysisMethodNote">仅使用当前账号已采集视频。中位数使用有效数据；最近 3 条与此前 3 条均须具备完整数据才比较。</p>
      <section className="analysisStats">{ANALYTICS_METRICS.map((dimension) => {
      const summary = summarizeMetric(videos, dimension.key);
      return <article key={dimension.key} style={{ '--metric-color': dimension.color } as React.CSSProperties}>
        <div className="analysisStatTitle"><small>{dimension.label}账号基准</small><span>{summary.validCount}/{summary.totalCount} 条有效</span></div>
        <strong>{formatMetric(summary.median)}</strong>
        <p className="analysisStatPrimaryLabel">账号中位数</p>
        <div className="analysisStatRows">
          <span><small>最近 3 条均值</small><b>{formatMetric(summary.recentAverage)}</b></span>
          <span><small>此前 3 条均值</small><b>{formatMetric(summary.previousAverage)}</b></span>
        </div>
        <p className={`summaryDelta ${deltaTone(summary.recentDelta)}`}>
          {summary.recentDelta ? `最近 3 条较此前 3 条 ${formatDeltaDetail(summary.recentDelta)}` : '完整的两组 3 条样本不足'}
        </p>
      </article>;
      })}</section>
    </details>
  </section>;
}

function MetricBarComparison({ videos, metricKey, sortMode, chartMode, selectedVideoId, onMetricChange, onSortChange, onChartModeChange, onSelectVideo }: {
  videos: Video[];
  metricKey: AnalyticsMetricKey;
  sortMode: AnalyticsSortMode;
  chartMode: 'line' | 'bar';
  selectedVideoId: string;
  onMetricChange: (metric: AnalyticsMetricKey) => void;
  onSortChange: (mode: AnalyticsSortMode) => void;
  onChartModeChange: (mode: 'line' | 'bar') => void;
  onSelectVideo: (videoId: string) => void;
}) {
  const chartScrollRef = useRef<HTMLDivElement>(null);
  const [chartContainerWidth, setChartContainerWidth] = useState(720);
  useEffect(() => {
    const container = chartScrollRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setChartContainerWidth(Math.max(160, Math.floor(container.clientWidth)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const metric = ANALYTICS_METRICS.find((item) => item.key === metricKey) || ANALYTICS_METRICS[0];
  const chronologicalIndex = new Map(videos.map((video, index) => [video.id, index + 1]));
  const displayedVideos = sortMode === 'published'
    ? videos
    : [...videos].sort((left, right) => {
      const leftValue = analyticsMetricValue(left[metricKey]);
      const rightValue = analyticsMetricValue(right[metricKey]);
      if (leftValue === null && rightValue === null) return (chronologicalIndex.get(left.id) || 0) - (chronologicalIndex.get(right.id) || 0);
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return rightValue - leftValue || (chronologicalIndex.get(left.id) || 0) - (chronologicalIndex.get(right.id) || 0);
    });
  const width = chartMode === 'line' ? chartContainerWidth : Math.max(720, displayedVideos.length * 96 + 110);
  const height = 380;
  const paddingLeft = 80;
  const paddingRight = 24;
  const paddingTop = 36;
  const paddingBottom = 74;
  const baseline = height - paddingBottom;
  const plotHeight = baseline - paddingTop;
  const values = displayedVideos.map((video) => analyticsMetricValue(video[metricKey])).filter((value): value is number => value !== null);
  const maximum = Math.max(1, ...values);
  const bandWidth = (width - paddingLeft - paddingRight) / Math.max(1, displayedVideos.length);
  const barWidth = Math.min(36, bandWidth * .58);
  const labelCount = Math.min(displayedVideos.length, Math.max(1, Math.floor((width - paddingLeft - paddingRight - 40) / 100) + 1));
  const lineLabelIndices = new Set(Array.from({ length: labelCount }, (_, index) => labelCount === 1
    ? displayedVideos.length - 1
    : Math.round(index * (displayedVideos.length - 1) / (labelCount - 1))));
  const ticks = [0, .25, .5, .75, 1];
  const hasPublishedDate = (video: Video) => Boolean(video.publishedAt && Number.isFinite(Date.parse(video.publishedAt)));
  const hasFallbackDates = videos.some((video) => !hasPublishedDate(video));
  const lineSegments = chartMode === 'line' ? metricTrendSegments(displayedVideos, metricKey) : [];
  const publishedVideos = videos.filter(hasPublishedDate);
  const capturedTimes = videos.map((video) => Date.parse(video.lastSeenAt)).filter(Number.isFinite);
  const firstCaptured = capturedTimes.length ? new Date(Math.min(...capturedTimes)).toISOString() : null;
  const lastCaptured = capturedTimes.length ? new Date(Math.max(...capturedTimes)).toISOString() : null;
  const selectedIndex = displayedVideos.findIndex((video) => video.id === selectedVideoId);

  useEffect(() => {
    const container = chartScrollRef.current;
    if (!container || selectedIndex < 0) return;
    if (chartMode === 'line') {
      container.scrollLeft = 0;
      return;
    }
    const centerX = paddingLeft + bandWidth * (selectedIndex + .5);
    if (centerX < container.scrollLeft + 40 || centerX > container.scrollLeft + container.clientWidth - 40) {
      container.scrollTo({
        left: Math.max(0, centerX - container.clientWidth / 2),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    }
  }, [selectedIndex, bandWidth, chartMode]);

  return <article className="metricComparisonCard">
    <div className="metricComparisonHeader">
      <div><h3>{sortMode === 'published' ? '账号视频互动走势' : '各视频互动高低对比'}</h3><p>{chartMode === 'line' ? '每个点是一条视频，按发布先后排列；点间距不代表时间间隔。' : sortMode === 'published' ? '每根柱是一条视频，按发布先后排列。' : `每根柱是一条视频，按${metric.label}从高到低排列。`}纵轴为最近采集的{metric.label}累计值。</p></div>
    </div>
    <div className="metricChartContext">
      <span>当前账号 {videos.length} 条视频 · {metric.label}有效数据 {values.length} 条</span>
      <span>{publishedVideos.length ? `发布时间：${formatCalendarDate(publishedVideos[0].publishedAt, true)} 至 ${formatCalendarDate(publishedVideos.at(-1)?.publishedAt || null, true)}` : '视频发布时间未知'}</span>
      <span>数据采集：{firstCaptured && lastCaptured ? firstCaptured === lastCaptured ? formatTime(lastCaptured) : `${formatTime(firstCaptured)} 至 ${formatTime(lastCaptured)}` : '时间未知'}</span>
    </div>
      <div className="metricControls">
        <div className="metricTabs" role="group" aria-label="选择对比指标">
          {ANALYTICS_METRICS.map((item) => <button key={item.key} type="button" aria-pressed={metricKey === item.key} className={metricKey === item.key ? 'active' : ''} style={{ '--metric-color': item.color } as React.CSSProperties} onClick={() => onMetricChange(item.key)}>{item.label}</button>)}
        </div>
        <div className="metricChartModes" role="group" aria-label="图表形式">
          <button type="button" aria-pressed={chartMode === 'line'} className={chartMode === 'line' ? 'active' : ''} onClick={() => onChartModeChange('line')}>折线图</button>
          <button type="button" aria-pressed={chartMode === 'bar'} className={chartMode === 'bar' ? 'active' : ''} onClick={() => onChartModeChange('bar')}>柱形图</button>
        </div>
        <div className="metricSort" role="group" aria-label="视频排序方式">
          <button type="button" aria-pressed={sortMode === 'published'} className={sortMode === 'published' ? 'active' : ''} onClick={() => onSortChange('published')}>按发布时间</button>
          <button type="button" aria-pressed={sortMode === 'value'} className={sortMode === 'value' ? 'active' : ''} onClick={() => onSortChange('value')}>按数据高低</button>
        </div>
      </div>
    <p className="metricChartHelp">{chartMode === 'line' ? '折线展示全部视频的整体走势，日期按空间间隔显示；点击点或使用下方“查看视频”精确选择。' : '柱形图保留每条视频的日期，左右滑动逐条比较；点击柱或日期选择。'}键盘聚焦视频点后可用左右方向键选择。{values.length < videos.length ? '缺失数据标为“缺值”，折线在该处断开；0 表示实际采集值为零。' : ''}{hasFallbackDates ? '带 * 的日期为首次发现时间，发布时间未知。' : ''}</p>
    <div className={`metricBarChartScroll ${chartMode === 'line' ? 'metricLineChartFit' : ''}`} ref={chartScrollRef} tabIndex={0} role="region" aria-label={chartMode === 'line' ? '全部视频互动折线图' : '视频互动柱形图，可横向滚动'}>
      <svg className="metricBarChart" viewBox={`0 0 ${width} ${height}`} style={{ width: chartMode === 'line' ? '100%' : width, height }} role="group" aria-label={`${metric.label}数据按视频对比${chartMode === 'line' ? '折线图' : '柱形图'}`}>
        {ticks.map((ratio) => {
          const y = baseline - plotHeight * ratio;
          return <g key={ratio}>
            <line className="metricGridLine" x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} />
            <text className="metricAxisLabel" x={paddingLeft - 10} y={y + 4} textAnchor="end">{values.length ? formatCompactMetric(maximum * ratio) : '—'}</text>
          </g>;
        })}
        {lineSegments.filter((segment) => segment.length > 1).map((segment) => <polyline
          key={segment[0].index}
          className="metricTrendLine"
          points={segment.map((point) => `${paddingLeft + bandWidth * (point.index + .5)},${baseline - (point.value / maximum) * plotHeight}`).join(' ')}
          fill="none"
          stroke={metric.color}
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />)}
        {displayedVideos.map((video, index) => {
          const value = analyticsMetricValue(video[metricKey]);
          const centerX = paddingLeft + bandWidth * index + bandWidth / 2;
          const validValue = value !== null;
          const barHeight = validValue ? (value / maximum) * plotHeight : 0;
          const y = baseline - barHeight;
          const isSelected = video.id === selectedVideoId;
          const published = hasPublishedDate(video);
          const dateValue = published ? video.publishedAt : video.firstSeenAt;
          const dateLabel = formatCalendarDate(dateValue);
          const displayDateLabel = `${dateLabel}${published ? '' : '*'}`;
          const timeLabel = published ? formatClockTime(dateValue) : '首次发现';
          const label = `${displayDateLabel} ${timeLabel}，${video.title}，${metric.label}${validValue ? formatMetric(value) : '缺少数据'}`;
          const showDateLabel = chartMode === 'bar' || lineLabelIndices.has(index);
          const labelAnchor = chartMode === 'line' && index === displayedVideos.length - 1 ? 'end' : chartMode === 'line' && index === 0 ? 'start' : 'middle';
          return <g
            className={`metricBarGroup ${isSelected ? 'selected' : ''}`}
            key={`${video.accountId}:${video.id}`}
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={isSelected}
            onClick={() => onSelectVideo(video.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectVideo(video.id);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                const nextIndex = Math.max(0, Math.min(displayedVideos.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
                const nextNode = event.currentTarget.parentElement?.querySelectorAll<SVGGElement>('.metricBarGroup')[nextIndex];
                nextNode?.focus({ preventScroll: true });
                onSelectVideo(displayedVideos[nextIndex].id);
              }
            }}
          >
            <title>{`${video.title}｜${metric.label} ${validValue ? formatMetric(value) : '缺少数据'}`}</title>
            <rect className="metricBarHitArea" x={centerX - bandWidth / 2} y={paddingTop} width={bandWidth} height={plotHeight + 42} />
            {isSelected && validValue && chartMode === 'line' && <circle className="metricSelectionHalo" cx={centerX} cy={y} r="14" fill={metric.color} />}
            {validValue && chartMode === 'line'
              ? <circle className="metricTrendPoint" cx={centerX} cy={y} r={isSelected ? 7 : Math.min(5, Math.max(2, bandWidth * .3))} fill={metric.color} />
              : validValue && value > 0
              ? <rect className="metricValueBar" x={centerX - barWidth / 2} y={y} width={barWidth} height={barHeight} rx="4" fill={metric.color} opacity={isSelected ? 1 : .62} />
              : validValue
                ? <circle className="metricZeroMarker" cx={centerX} cy={baseline} r="3" fill={metric.color} />
              : <>{(chartMode === 'bar' || isSelected || showDateLabel) && <text className="metricMissingLabel" x={centerX} y={baseline - 12} textAnchor={labelAnchor}>缺值</text>}</>}
            <circle className="metricSelectionMarker" cx={centerX} cy={baseline + 12} r="3.5" fill={metric.color} />
            {isSelected && validValue && <text className="metricSelectedValue" x={centerX} y={Math.max(18, y - 16)} textAnchor={centerX > width - 70 ? 'end' : 'middle'}>{formatCompactMetric(value)}</text>}
            {showDateLabel && <text className="metricVideoLabel" textAnchor={labelAnchor}>
              <tspan x={centerX} y={height - 38}>{displayDateLabel}</tspan>
              <tspan className="metricVideoTimeLabel" x={centerX} y={height - 16}>{timeLabel}</tspan>
            </text>}
          </g>;
        })}
      </svg>
    </div>
    <div className="metricVideoNavigator">
      <label>查看视频<select value={selectedVideoId} onChange={(event) => onSelectVideo(event.target.value)}>{displayedVideos.map((video) => <option key={`${video.accountId}:${video.id}`} value={video.id}>{formatCalendarDate(hasPublishedDate(video) ? video.publishedAt : video.firstSeenAt)} · {video.title}</option>)}</select></label>
      <button className="secondaryButton" type="button" disabled={selectedIndex <= 0} onClick={() => onSelectVideo(displayedVideos[selectedIndex - 1].id)}>上一条</button>
      <button className="secondaryButton" type="button" disabled={selectedIndex < 0 || selectedIndex >= displayedVideos.length - 1} onClick={() => onSelectVideo(displayedVideos[selectedIndex + 1].id)}>下一条</button>
    </div>
    <p className="analysisMethodNote">使用每条视频各自最新采集的累计值，采集时点和发布时长可能不同；这是视频之间的对比，不代表账号每日新增或相同发布时长的表现。单条视频的历史增长见下方“首次记录后变化”。</p>
  </article>;
}

function SelectedVideoComparison({ video, videos, snapshots }: {
  video: Video;
  videos: Video[];
  snapshots: Snapshot[];
}) {
  const previousVideo = previousPublishedVideo(video, videos);
  return <article className="selectedVideoComparison">
    <div className="selectedVideoPanelHeading">
      <h3>所选视频数据</h3>
      <p>显示所选视频的累计值与历史快照增量；“上一条视频”始终按发布时间确定，与图表当前排序无关。</p>
    </div>
    <div className="selectedVideoHeader">
      <a className="selectedVideoCover" href={video.url} target="_blank" rel="noreferrer">
        {video.coverUrl ? <img src={video.coverUrl} alt="" referrerPolicy="no-referrer" /> : <span>无封面</span>}
      </a>
      <div><span>所选日期 · {formatCalendarDate(video.publishedAt || video.firstSeenAt, true)}{video.publishedAt ? ' 发布' : ' 首次发现'} · 数据采集 {formatTime(video.lastSeenAt)}</span><h3>{video.title}</h3><p><a href={video.url} target="_blank" rel="noreferrer">打开原视频 ↗</a></p></div>
    </div>
    <div className="selectedComparisonTableWrap">
      <table className="selectedComparisonTable">
        <thead><tr><th>指标</th><th>当前累计</th><th>首次记录后变化</th><th>比上一条视频</th><th>账号内排名</th></tr></thead>
        <tbody>{ANALYTICS_METRICS.map((dimension) => {
          const snapshotChange = snapshotMetricChange(video, snapshots, dimension.key);
          const previousDelta = previousVideo ? calculateDelta(video[dimension.key], previousVideo[dimension.key]) : null;
          const rank = metricRank(video, videos, dimension.key);
          const validCount = videos.filter((candidate) => metricRank(candidate, videos, dimension.key) !== null).length;
          const snapshotText = snapshotChange.sampleCount < 2
            ? snapshotChange.sampleCount === 1 ? '等待下次采集' : '暂无历史记录'
            : snapshotChange.delta ? formatDeltaDetail(snapshotChange.delta) : '首末记录缺少数据';
          const previousText = previousVideo
            ? previousDelta ? formatDeltaDetail(previousDelta) : '两条视频数据不足'
            : '没有更早视频';
          const snapshotTitle = snapshotChange.sampleCount >= 2 && snapshotChange.firstCapturedAt && snapshotChange.latestCapturedAt
            ? `首次记录 ${formatTime(snapshotChange.firstCapturedAt)}；最近记录 ${formatTime(snapshotChange.latestCapturedAt)}`
            : snapshotText;
          const previousTitle = previousVideo
            ? `对比对象：${formatCalendarDate(previousVideo.publishedAt || previousVideo.firstSeenAt, true)}${previousVideo.publishedAt ? ' 发布' : ' 首次发现'} · ${previousVideo.title}`
            : previousText;
          return <tr key={dimension.key} style={{ '--metric-color': dimension.color } as React.CSSProperties}>
            <th scope="row"><i aria-hidden="true" /><span>{dimension.label}</span></th>
            <td data-label="当前累计"><b>{formatMetric(video[dimension.key])}</b></td>
            <td data-label="首次记录后变化" className={deltaTone(snapshotChange.delta)}><span>{snapshotText}</span>{snapshotChange.sampleCount >= 2 && <small>{snapshotTitle} · {snapshotChange.sampleCount} 次快照</small>}</td>
            <td data-label="比上一条视频" className={deltaTone(previousDelta)}><span>{previousText}</span>{previousVideo ? <small>{previousTitle}</small> : null}</td>
            <td data-label="账号内排名">{rank && validCount >= 2 ? `第 ${rank} 名 / ${validCount} 条有效样本` : rank ? '仅 1 条有效样本，暂不比较' : '数据不足，暂无排名'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
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
      <span>仅显示所选账号的数据。</span>
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
  checking: '检查中',
  ready: '已完成抓取',
  error: '抓取失败',
};

function AccountBoard({ accounts, onAdd, onRemove, onInitialSync, isCollecting }: {
  accounts: Account[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onInitialSync: (account: Account) => boolean;
  isCollecting: boolean;
}) {
  if (!accounts.length) {
    return <section className="emptyBoard"><div className="emptySymbol">＋</div><h3>添加第一个监控账号</h3><p>首次建立近 30 条非置顶视频档案，之后按需检查最新 5 条并自动去重。</p><button className="primaryButton" onClick={onAdd}>添加新监控账号</button></section>;
  }
  return <section className="accountGrid">{accounts.map((account, index) => {
    const statusLabel = account.status === 'checking' ? '检查中'
      : account.initialSyncStatus === 'error' ? '抓取失败' : accountStatusLabels[account.status];
    return <article className="accountCard" key={account.id}>
      <div className="accountTop"><div className="accountAvatar">{account.avatarUrl ? <img src={account.avatarUrl} alt={`${account.name}头像`} referrerPolicy="no-referrer" /> : <span>{index + 1}</span>}</div><span className={`statusPill ${account.status}`}>{statusLabel}</span></div>

      <h3>{account.name}</h3><a href={account.url} target="_blank" rel="noreferrer">打开原账号主页 ↗</a>
      {account.status === 'error' && account.collectionError && <p className="accountUpdateNotice" role="status">失败原因：{account.collectionError}</p>}
      {account.status === 'checking' && account.currentSyncMode === 'latest'
        ? <div className="accountUpdateNotice checking">正在检查，完成后显示更新数量</div>
        : account.latestCheckNewVideoCount !== null && <div className={`accountUpdateNotice ${account.latestCheckNewVideoCount > 0 ? 'updated' : 'none'}`}>
          <strong>{`${account.status === 'error' ? '上次成功检查' : '最近一次检查'}${account.latestCheckNewVideoCount > 0 ? `：新增 ${account.latestCheckNewVideoCount} 条` : '：无新增'}`}</strong>
          {account.status === 'error' && <small>上次成功：{formatTime(account.lastSuccessAt)}</small>}
        </div>}
      <div className="accountMeta"><span><small>首次建档</small><b>{account.initialSyncStatus === 'complete' ? formatTime(account.initialSyncCompletedAt) : '待抓取近 30 条'}</b></span><span><small>最近检查</small><b>{account.lastCheckedAt ? formatTime(account.lastCheckedAt) : '尚未检查'}</b></span></div>
      {account.initialSyncStatus !== 'complete' && <button className="initialSyncButton" disabled={isCollecting} onClick={() => onInitialSync(account)}>{account.status === 'checking' ? '正在抓取近 30 条…' : account.initialSyncStatus === 'error' ? '重新抓取近 30 条' : '首次抓取近 30 条'}</button>}
      <button className="dangerLink" onClick={() => onRemove(account.id)}>移除账号</button>
    </article>;
  })}</section>;
}

function analysisJob(video: Video, jobs: HostJob[]) {
  return jobs.filter((job) => job.type === 'analyze_video' && String(job.payload.videoId || '') === video.id)
    .sort((left, right) => (right.createdAt || right.updatedAt || '').localeCompare(left.createdAt || left.updatedAt || ''))[0];
}

function displayedAnalysisStatus(video: Video, job?: HostJob): AnalysisStatus {
  if (['pending', 'queued', 'waiting'].includes(job?.status || '')) return 'queued';
  if (['claimed', 'running', 'processing'].includes(job?.status || '')) return 'processing';
  if (['failed', 'error', 'expired', 'cancelled'].includes(job?.status || '')) return 'error';
  return video.analysisStatus;
}

function savedSections(video: Video) {
  return [video.transcriptStatus === 'ready' || Boolean(video.transcript) ? '口播稿' : '', videoContentReading(video.analysis).complete ? '视频内容分析' : '', isRemotionPlan(video.analysis) ? 'Remotion 制作规范' : ''].filter(Boolean);
}

function analysisProgress(video: Video, job?: HostJob) {
  const stage = String(job?.progress?.stage || '');
  return textValue(job?.progress?.message) || ({
    browser_capture: '正在获取并校验目标完整视频', downloading_original_video: '正在下载完整视频并核对时长',
    local_asr_and_secure_upload: '正在识别口播并准备视频', cloud_asr_and_secure_upload: '正在识别完整音轨，并准备视频分析',
    cloud_asr: '正在识别完整音轨', secure_video_upload: '正在上传完整视频',
    qwen_full_video_analysis: '视频已提交，等待模型返回', qwen_reasoning: '模型正在分析完整视频',
    qwen_receiving_output: '正在接收内容分析和制作规范', lossless_continuous_segmentation: '正在无损分段处理完整视频',
  } as Record<string, string>)[stage] || (displayedAnalysisStatus(video, job) === 'queued' ? '任务已排队，等待主机处理' : '正在处理分析任务');
}

function VideoTable({ videos, jobs, onOpen, onAnalysis, onCancel, connectorConnected, connectorBusy, showAuthor = false }: {
  videos: Video[]; jobs: HostJob[];
  onOpen: (video: Video, section: ReadingSection, scope: Video[]) => void;
  onAnalysis: (video: Video, regenerate?: boolean, forceRegenerate?: boolean) => void;
  onCancel: (job: HostJob) => void;
  connectorConnected: boolean; connectorBusy: boolean; showAuthor?: boolean;
}) {
  if (!videos.length) return <EmptyData title="还没有视频数据" detail="在信源管理中添加账号并手动采集。已有视频会按真实发布时间排列，打开结果不会发起分析。" />;
  return <div className="videoTableScroll"><div className="videoTable">
    {videos.map((video, index) => {
      const duration = formatDuration(video.durationSeconds);
      const latestJob = analysisJob(video, jobs);
      const analysisStatus = displayedAnalysisStatus(video, latestJob);
      const busy = analysisStatus === 'queued' || analysisStatus === 'processing';
      const complete = savedSections(video);
      const reading = videoContentReading(video.analysis);
      const latestRun = video.analysisRuns[0] || null;
      const latestUsage = video.analysisUsage || latestRun?.usage || null;
      const previousRuns = video.analysisRuns.slice(1);
      const metrics = [['点赞', video.likeCount], ['评论数', video.commentCount], ['收藏', video.favoriteCount], ['分享', video.shareCount]] as const;
      return <article className="videoRecord" key={`${video.accountId}:${video.id}`} style={{ '--card-order': Math.min(index, 8) } as CSSProperties}>
        <div className="videoMainRow">
          <div className="videoIdentity">
            <button type="button" className="coverLink" onClick={() => onOpen(video, 'content', videos)} aria-label={`阅读：${video.title}`}>
              {video.coverUrl ? <img src={video.coverUrl} alt="" referrerPolicy="no-referrer" /> : <span>无封面</span>}{duration && <i>{duration}</i>}
            </button>
            <div className="videoCopy"><button type="button" className="videoTitle" onClick={() => onOpen(video, 'content', videos)}>{video.title || '未命名视频'}</button>
              {showAuthor && <div className="videoAuthor">{video.authorProfileUrl ? <a href={video.authorProfileUrl} target="_blank" rel="noreferrer">{video.authorName || '作者主页'} ↗</a> : <span>{video.authorName || '作者未记录'}</span>}</div>}
              <div className="videoTimes"><span>视频发布：{formatPublishedTime(video.publishedAt)}</span><span>首次采集：{formatTime(video.firstSeenAt)}</span></div>
              {reading.available && <p className="videoOverview">{reading.overview || '已保存内容分析，展开阅读完整内容。'}</p>}
              <div className="videoResultState">{complete.length ? `${complete.length}/3 个分区已生成` : busy || analysisStatus === 'error' ? '尚未生成结果' : '尚未分析'}{busy ? ` · ${analysisProgress(video, latestJob)}` : latestJob?.status === 'cancelled' ? ' · 任务已取消' : analysisStatus === 'error' ? ' · 本次任务未完成' : ''}</div>
            </div>
          </div>
          <div className="videoData videoMetrics" role="group" aria-label="视频互动数据"><div className="metricGrid">{metrics.map(([label, value]) => <span key={label}><small>{label}</small><b>{formatMetric(value)}</b></span>)}</div><small className="snapshotTime">采集于 {formatTime(video.lastSeenAt)}</small></div>
          <div className="videoAnalysisActions">
            {complete.length || reading.available || busy
              ? <button type="button" className="primaryButton" onClick={() => onOpen(video, 'content', videos)}>{complete.length || reading.available ? '展开阅读' : '查看进度'}</button>
              : <button type="button" className="primaryButton" onClick={() => onAnalysis({ ...video, analysisStatus }, analysisStatus === 'error')}>{analysisStatus === 'error' ? '重试分析' : '分析'}</button>}
            {busy && latestJob && <button type="button" className="secondaryButton" onClick={() => onCancel(latestJob)}>取消任务</button>}
            <a href={video.url} target="_blank" rel="noreferrer">打开原视频 ↗</a>
          </div>
        </div>
        {busy && !connectorConnected && <p className="rowTaskMessage">采集服务暂未连接，任务仍保留。已生成内容可以继续阅读。</p>}
        {busy && connectorConnected && connectorBusy && analysisStatus === 'queued' && <p className="rowTaskMessage">主机正在处理上一项任务，完成后自动继续。</p>}
        {analysisStatus === 'error' && latestJob?.status !== 'cancelled' && <p className="rowTaskMessage analysisError">{redactDiagnosticText(video.analysisDiagnostics?.lastError || latestJob?.error || video.analysisError || '任务未完成，详细原因尚未记录')}<button type="button" onClick={() => onOpen(video, 'content', videos)}>查看诊断</button></p>}
        {(video.analysis || latestRun || latestUsage) && <details className="analysisCosts">
          <summary><span>用量与费用</span><strong>{analysisUsageSummary(latestUsage, analysisStatus)}</strong></summary>
          <div className="analysisPane usagePane">
            {latestUsage && <section className="analysisUsage" aria-label="最近一次 AI 分析用量与费用">
              <div className="analysisUsageHeader"><b>本次消耗</b><small>{latestRun?.updatedAt ? formatTime(latestRun.updatedAt) : '已永久保存'}</small></div>
              <div className="analysisUsageGrid">
                <span><small>视频模型请求</small><b>{analysisRequestCountLabel(latestUsage)}</b></span>
                <span><small>模型</small><b>{latestUsage.requestedModel}</b></span>
                <span><small>输入 Token</small><b>{formatTokenCount(latestUsage.promptTokens)}</b></span>
                <span><small>输出 Token</small><b>{formatTokenCount(latestUsage.completionTokens)}</b></span>
                <span><small>视频模型总 Token</small><b>{formatTokenCount(latestUsage.totalTokens)}</b></span>
                <span><small>{latestUsage.cloudAsr ? '视频分析估算' : '官方原价估算'}</small><b>{formatEstimatedCost(latestUsage.estimatedCostCny)}</b></span>
                {latestUsage.cloudAsr && <>
                  <span><small>云端口播时长</small><b>{formatCloudAudioSeconds(latestUsage.cloudAsr.audioSeconds)}</b></span>
                  <span><small>云端口播估算</small><b>{formatEstimatedCost(latestUsage.cloudAsr.estimatedCostCny)}</b></span>
                  <span><small>含口播合计估算</small><b>{formatEstimatedCost(latestUsage.totalEstimatedCostCny)}</b></span>
                </>}
              </div>
              {latestUsage.requestIds.length > 0 && <p className="analysisRequestIds" title={latestUsage.requestIds.join('\n')}>请求 ID：{latestUsage.requestIds.join('、')}</p>}
              <p className="analysisUsageNote">{latestUsage.billingNote}{latestUsage.pricing?.checkedAt ? ` 单价核对日期：${latestUsage.pricing.checkedAt}。` : ''}</p>
              {latestUsage.cloudAsr && <p className="analysisUsageNote">云端口播（{latestUsage.cloudAsr.model}）：{latestUsage.cloudAsr.billingNote}</p>}
            </section>}
            {!latestUsage && latestRun && <p className="analysisUsageUnavailable">{['queued', 'claimed', 'running'].includes(latestRun.status)
              ? '本次分析尚未结束，用量将在接口返回后永久保存。'
              : latestRun.status === 'succeeded'
                ? '这次历史分析完成时尚未记录接口用量，无法从已保存结果倒推精确 Token 与费用。'
                : '这次分析未保存到接口用量；可能尚未发起模型请求，也可能未收到完整回执，请以百炼账单核对。'}</p>}
            {!latestRun && video.analysis && !latestUsage && <p className="analysisUsageUnavailable">这条历史分析完成时尚未记录接口用量，无法从已保存结果倒推精确 Token 与费用。</p>}
            {(video.analysis || latestRun || latestUsage) && <a className="analysisBillingLink" href="https://bailian.console.aliyun.com/?tab=costing-balance" target="_blank" rel="noreferrer">打开百炼模型用量核对实际账单 ↗</a>}
            {previousRuns.length > 0 && <section className="analysisRunHistory" aria-label="历史 AI 分析费用记录">
              <div className="analysisUsageHeader"><b>历次分析记录</b><small>每次独立保存</small></div>
              <div className="analysisRunList">{previousRuns.map((run) => <div className="analysisRunItem" key={run.id}>
                <span><b>{formatTime(run.createdAt || run.updatedAt)}</b><small>{analysisRunStatusLabel(run.status)}</small></span>
                {run.usage
                  ? <span><b>{formatEstimatedCost(run.usage.totalEstimatedCostCny)} · {formatTokenCount(run.usage.totalTokens)} Token{run.usage.cloudAsr ? '（含云端口播）' : ''}</b><small>输入 {formatTokenCount(run.usage.promptTokens)} / 输出 {formatTokenCount(run.usage.completionTokens)} Token{run.usage.cloudAsr ? ` · 云端口播 ${formatCloudAudioSeconds(run.usage.cloudAsr.audioSeconds)} / ${formatEstimatedCost(run.usage.cloudAsr.estimatedCostCny)}` : ''}</small></span>
                  : <span><b>无本机用量记录</b><small>{run.status === 'succeeded' ? '旧版本未保存，无法倒推' : '请按时间到百炼账单核对'}</small></span>}
              </div>)}</div>
            </section>}
            <p className="analysisUsageNote">Token 和口播秒数来自接口回执；金额按模型单价估算，不代表实际扣款或账户剩余额度。免费额度、套餐抵扣及优惠请在百炼账单核对。重复打开已完成结果不产生新调用。</p>
          </div>
        </details>}
      </article>;
    })}
  </div></div>;
}

function closeOverlay(close: () => void) {
  const overlay = document.querySelector<HTMLElement>('.modalBackdrop');
  if (!overlay || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { close(); return; }
  if (overlay.classList.contains('isClosing')) return;
  overlay.classList.add('isClosing');
  window.setTimeout(close, 200);
}

// View transitions preserve the DOM and list scroll while adding exit/entry motion.
function animateChange(change: () => void) {
  if (typeof document !== 'undefined' && document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const transition = document.startViewTransition(() => flushSync(change));
    // A newer transition may skip this animation; its DOM update still runs.
    // `ready` rejects independently of `finished`, so handle animation skips here.
    void transition.ready.catch(() => undefined);
    void transition.finished.catch(() => undefined);
  } else change();
}

function ReadingText({ children }: { children: string }) {
  return <div className="readingText">{children.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}

async function copyReadingText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea');
  input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
  const active = document.activeElement as HTMLElement | null;
  const container = document.querySelector<HTMLDialogElement>('dialog[open]') || document.body;
  container.appendChild(input); input.select();
  const copied = document.execCommand('copy'); input.remove(); active?.focus({ preventScroll: true });
  if (!copied) throw new Error('复制未完成，请选中正文复制');
}

function downloadReading(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function VideoReader({ video, jobs, initialSection, index, total, onClose, onNavigate, onAnalysis, onCancel }: {
  video: Video; jobs: HostJob[]; initialSection: ReadingSection; index: number; total: number;
  onClose: () => void; onNavigate: (offset: number) => void;
  onAnalysis: (video: Video, regenerate?: boolean, forceRegenerate?: boolean) => void; onCancel: (job: HostJob) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const contentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [section, setSection] = useState<ReadingSection>(initialSection);
  const [fontSize, setFontSize] = useState<18 | 20 | 22>(20);
  const [closing, setClosing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [direction, setDirection] = useState(1);
  const [copyMessage, setCopyMessage] = useState('');
  const latestJob = analysisJob(video, jobs);
  const analysisStatus = displayedAnalysisStatus(video, latestJob);
  const busy = analysisStatus === 'queued' || analysisStatus === 'processing';
  const complete = savedSections(video);
  const reading = videoContentReading(video.analysis);
  const rawDiagnostic = latestJob?.result?.diagnostics;
  const diagnostics: AnalysisDiagnostics = rawDiagnostic && typeof rawDiagnostic === 'object' ? rawDiagnostic as AnalysisDiagnostics : video.analysisDiagnostics || {};
  const failed = analysisStatus === 'error' && latestJob?.status !== 'cancelled';
  const sectionText = section === 'transcript' ? video.transcript || '' : section === 'content' ? videoContentAnalysis(video.analysis) : isRemotionPlan(video.analysis) ? formatRemotionPlan(video.analysis, video.title, video.url, video.transcript) : '';
  const labels: Record<ReadingSection, string> = { transcript: '口播稿', content: '视频内容分析', production: 'Remotion 制作规范' };
  useEffect(() => {
    const element = dialog.current;
    const scheduledTimers = timers.current;
    const origin = document.activeElement as HTMLElement | null;
    const scrollY = window.scrollY;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal(); closeButton.current?.focus({ preventScroll: true });
    const keepFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !element) return;
      const controls = Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    element?.addEventListener('keydown', keepFocus);
    return () => {
      scheduledTimers.forEach(clearTimeout);
      element?.removeEventListener('keydown', keepFocus);
      element?.close(); document.body.style.overflow = overflow;
      origin?.focus({ preventScroll: true }); window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, []);
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    timers.current.push(setTimeout(onClose, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 230));
  };
  const changeContent = (update: () => void, nextDirection = 1) => {
    if (contentTimer.current) clearTimeout(contentTimer.current);
    setDirection(nextDirection); setChanging(true); setCopyMessage('');
    contentTimer.current = setTimeout(() => {
      update(); scroller.current?.scrollTo({ top: 0, behavior: 'instant' }); setChanging(false);
      contentTimer.current = null;
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 130);
    timers.current.push(contentTimer.current);
  };
  const copy = (text: string) => { void copyReadingText(text).then(() => setCopyMessage('已复制')).catch((error: Error) => setCopyMessage(error.message)); };
  const changeTab = (next: ReadingSection) => {
    const ordered: ReadingSection[] = ['transcript', 'content', 'production'];
    changeContent(() => setSection(next), ordered.indexOf(next) > ordered.indexOf(section) ? 1 : -1);
  };
  return <dialog ref={dialog} className={`readingDialog ${closing ? 'isClosing' : ''}`} aria-labelledby="reader-title" onCancel={(event) => { event.preventDefault(); requestClose(); }} onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <div className="readerCloseBar"><button ref={closeButton} type="button" className="readerClose" onClick={requestClose} aria-label="关闭阅读，返回列表">关闭 <span aria-hidden="true">×</span></button></div>
    <div ref={scroller} className="readerScroll" style={{ '--reading-size': `${fontSize}px`, '--reading-direction': direction } as CSSProperties}>
      <header className="readerHeader"><span className="readerPosition">当前列表 · 第 {index + 1} / {total} 条</span><h2 id="reader-title">{video.title}</h2><div className="readerMetadata"><span>视频发布：{formatPublishedTime(video.publishedAt)}</span><span>首次采集：{formatTime(video.firstSeenAt)}</span><a href={video.url} target="_blank" rel="noreferrer">打开原视频核对 ↗</a></div>
        <div className="readerNavigation"><button className="secondaryButton" type="button" disabled={index <= 0} onClick={() => changeContent(() => onNavigate(-1), -1)}>← 上一条</button><button className="secondaryButton" type="button" disabled={index >= total - 1} onClick={() => changeContent(() => onNavigate(1), 1)}>下一条 →</button><span>{complete.length}/3 个分区已生成</span></div>
      </header>
      <div className="readerTabs" role="tablist" aria-label="分析结果分区">{(['transcript', 'content', 'production'] as const).map((key) => <button key={key} id={`reader-tab-${key}`} type="button" role="tab" aria-selected={section === key} aria-controls="reader-panel" tabIndex={section === key ? 0 : -1} onClick={() => { if (section !== key) changeTab(key); }} onKeyDown={(event) => {
        const keys: ReadingSection[] = ['transcript', 'content', 'production'];
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[2] : keys[(keys.indexOf(key) + offset + 3) % 3];
        changeTab(next); document.getElementById(`reader-tab-${next}`)?.focus();
      }}>{labels[key]}</button>)}</div>
      <div className="readerToolbar"><fieldset className="readingFontControl"><legend>阅读字号</legend>{([18, 20, 22] as const).map((size) => <button type="button" key={size} aria-pressed={fontSize === size} onClick={() => setFontSize(size)}>{size}</button>)}</fieldset><div className="readerExport"><button className="secondaryButton" type="button" disabled={!sectionText} onClick={() => copy(sectionText)}>复制{labels[section]}</button><button className="secondaryButton" type="button" disabled={!sectionText} onClick={() => downloadReading(sectionText, `${section}-${video.id}.md`)}>下载 .md</button></div><span role="status" className="readerCopyStatus">{copyMessage}</span></div>
      {busy && <div className="readerTask" role="status"><p>{analysisProgress(video, latestJob)}</p>{latestJob && <button type="button" className="secondaryButton" onClick={() => onCancel(latestJob)}>取消任务</button>}</div>}
      {latestJob?.status === 'cancelled' && <p className="readerTask">任务已取消。已生成的结果仍然保留。</p>}
      {failed && <section className="readerFailure" aria-label="任务诊断"><h3>本次分析未完成</h3><p>失败阶段：{ANALYSIS_STAGE_LABELS[diagnostics.failedStage || ''] || diagnostics.failedStage || '尚未记录'}{Number.isFinite(diagnostics.attemptCount) ? ` · 实际尝试 ${diagnostics.attemptCount} 次` : ' · 尝试次数未记录'}</p><p>最后错误：{redactDiagnosticText(diagnostics.lastError || latestJob?.error || video.analysisError || '没有详细记录，根因尚未确定')}</p><p>已保存并保留：{complete.join('、') || '暂无已生成结果'}</p>{diagnostics.userAction && <p>{redactDiagnosticText(diagnostics.userAction)}</p>}<button type="button" className="secondaryButton" onClick={() => copy(formatAnalysisDiagnostics({ ...diagnostics, jobId: diagnostics.jobId || latestJob?.id, videoId: video.id, lastError: diagnostics.lastError || latestJob?.error || video.analysisError || '' }))}>复制诊断信息</button></section>}
      <div id="reader-panel" key={`${video.id}:${section}`} role="tabpanel" aria-labelledby={`reader-tab-${section}`} className={`readerBody ${changing ? 'isChanging' : ''}`}>
        {section === 'transcript' ? video.transcript ? <ReadingText>{video.transcript}</ReadingText> : <p className="readingEmpty">{video.transcriptStatus === 'ready' ? '完整音轨识别已完成，未识别到清晰口播文字。' : video.transcriptStatus === 'error' ? `口播稿尚未完成：${redactDiagnosticText(video.transcriptError || '具体原因未记录')}` : busy ? '口播稿尚未完成，完成后会先保存并显示。' : '尚未生成口播稿。'}</p> : section === 'content' ? reading.available ? <>
          {reading.overview && <section className="readingSummary"><h3>{reading.legacy ? '已有内容摘要 · 历史原文节选' : '主要内容'}</h3><ReadingText>{reading.overview}</ReadingText></section>}
          {reading.legacy && <p className="readingSourceNote">以下保留已有分析原文。旧结果未区分的证据与推断，不代表已经核实。</p>}
          {reading.sections.map((item) => <section className="readingSection" key={item.key}><h3>{item.label}</h3><ReadingText>{item.text}</ReadingText></section>)}
        </> : <><p className="readingEmpty">尚未生成视频内容分析。已有口播稿或制作规范可切换查看。</p>{video.description && video.description.trim() !== video.title.trim() && <section className="readingSection"><h3>原视频文案</h3><ReadingText>{video.description}</ReadingText></section>}</> : isRemotionPlan(video.analysis) ? <><p className="readingSourceNote">用于参考视频的呈现与制作。观察、复现建议和待确认项以各段标注为准。</p>{REMOTION_PLAN_SECTIONS.map(([key, label]) => <section className="readingSection" key={key}><h3>{label}</h3><ReadingText>{video.analysis?.[key] || ''}</ReadingText></section>)}</> : <p className="readingEmpty">尚未生成 Remotion 制作规范。已有结果继续保留。</p>}
        {!busy && complete.length < 3 && <div className="readerGenerate"><button className="primaryButton" type="button" onClick={() => onAnalysis({ ...video, analysisStatus }, Boolean(video.analysis) || analysisStatus === 'error')}>{complete.length ? '补全缺失分析' : '分析'}</button><span>一次处理三个分区，复用已有口播；可能产生云端费用。</span></div>}
        {!busy && complete.length === 3 && <details className="readerMore"><summary>重新分析</summary><p>重新查看完整视频并生成内容分析与制作规范，已有口播稿仍会复用。失败时保留之前的结果。</p><button type="button" className="secondaryButton" onClick={() => { if (window.confirm('重新分析会再次调用付费视频模型，已有口播稿直接复用。确定继续吗？')) onAnalysis({ ...video, analysisStatus }, true, true); }}>重新分析内容与制作规范（会产生费用）</button></details>}
      </div>
    </div>
  </dialog>;
}

function EmptyData({ title, detail }: { title: string; detail: string }) {
  return <section className="emptyBoard compact"><div className="emptySymbol">·</div><h3>{title}</h3><p>{detail}</p></section>;
}
