'use client';

/* eslint-disable @next/next/no-img-element -- 抖音封面是运行时采集的外部地址，不能预先配置图片域名。 */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
// The local workbench keeps this client mounted while editing. Include its
// stylesheet in the client graph so CSS updates accompany player markup updates.
import './globals.css';
import { ColorThemePicker } from './color-theme-picker';
import { WeChatWorkspace, type WeChatRequest } from './wechat-workspace';
import { OBSERVE_NAV_KEY, resolveObserveNavigation, observeSearch, type ObserveModule, type WeChatPage } from '../lib/observe-navigation';
import { ANALYSIS_STAGE_LABELS, formatAnalysisDiagnostics, redactDiagnosticText, type AnalysisDiagnostics } from '../lib/analysis-diagnostics';
import { createClientId } from '../lib/client-id';
import { canonicalDouyinAccountUrl } from '../lib/account-identity';
import { accountCollectionState, isActiveCollectionJob } from '../lib/collection-queue';
import { hostApiBase } from '../lib/host-connection';
import { createWorkspaceRefresh } from '../lib/workspace-refresh';
import { browseContentVideos, collectionAccountScope, contentSourceDescription, orderContentVideosNewestFirst } from '../lib/content-browse';
import { followerDetailText, formatFollowerLabel, normalizeFollowerReading } from '../lib/follower-count';
import { normalizeAnalysisUsage, formatTokenCount, formatEstimatedCost, formatCloudAudioSeconds, analysisRequestCountLabel, analysisUsageSummary, formatAnalysisCost, type AnalysisUsage } from '../lib/analysis-usage';

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
type TranscriptStatus = 'idle' | 'queued' | 'processing' | 'paused' | 'ready' | 'error';
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
  followerCount?: number | null;
  followerDisplayText?: string | null;
  followerCountIsApproximate?: boolean;
  followerCountCapturedAt?: string | null;
};

type DiscoveryRecord = {
  videoId: string;
  accountId: string;
  discoveredAt: string;
  expiresAt: string;
};

type Video = {
  id: string;
  mediaStatus?: 'missing' | 'queued' | 'downloading' | 'ready' | 'failed' | 'online';
  mediaError?: string | null;
  accountId: string;
  discoveredAt?: string | null;
  discoveryExpiresAt?: string | null;
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
  { key: 'likeCount' as const, label: '点赞', color: '#a4d5ec' },
  { key: 'commentCount' as const, label: '评论', color: '#a5dcca' },
  { key: 'favoriteCount' as const, label: '收藏', color: '#bcdfe8' },
  { key: 'shareCount' as const, label: '分享', color: '#bce2bb' },
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
  const readSignal = (!options.method || options.method === 'GET') ? AbortSignal.timeout(20_000) : undefined;
  const signal = readSignal ? (options.signal ? AbortSignal.any([options.signal, readSignal]) : readSignal) : options.signal;
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  const payload = await response.json().catch((error: unknown) => {
    // A stalled or truncated body must not turn into an empty workspace.
    if (response.ok || signal?.aborted) throw error;
    return {};
  }) as Record<string, unknown>;
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
  const followers = normalizeFollowerReading(raw);
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
    followerCount: followers.count,
    followerDisplayText: followers.displayText,
    followerCountIsApproximate: followers.approximate,
    followerCountCapturedAt: followers.capturedAt,
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
    mediaStatus: raw.mediaStatus || 'missing',
    mediaError: raw.mediaError || null,
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
    transcriptStatus: previousTranscript ? 'ready' : (raw.transcriptStatus || 'idle'),
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
  const [analysisProvider, setAnalysisProvider] = useState('qwen');
  const [cloudAsrConfigured, setCloudAsrConfigured] = useState(false);
  const [showQwenConfig, setShowQwenConfig] = useState(false);
  const [qwenApiKey, setQwenApiKey] = useState('');
  const [qwenSaving, setQwenSaving] = useState(false);
  const [hostJobs, setHostJobs] = useState<HostJob[]>([]);
  const [hostConnected, setHostConnected] = useState(false);
  const [dedicatedBrowser, setDedicatedBrowser] = useState(true);
  const [browserError, setBrowserError] = useState('');
  const [collectionPaused, setCollectionPaused] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [initialSubmissions, setInitialSubmissions] = useState<Set<string>>(new Set());
  const [initialBatchSubmitting, setInitialBatchSubmitting] = useState(false);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [hostConnectorCapabilities, setHostConnectorCapabilities] = useState<string[]>([]);
  const [hostWorkerStatus, setHostWorkerStatus] = useState('');
  const [activeNav, setActiveNav] = useState('内容浏览');
  const [activeModule, setActiveModule] = useState<ObserveModule>('content');
  const [wechatPage, setWechatPage] = useState<WeChatPage>('reading');
  const [wechatVisited, setWechatVisited] = useState(false);
  const [wechatTask, setWechatTask] = useState('');
  const [navigationReady, setNavigationReady] = useState(false);
  const contentScroll = useRef(0);
  const globalHeader = useRef<HTMLElement>(null);
  const previousModule = useRef<ObserveModule>('content');
  const wechatRequest = useCallback<WeChatRequest>((path, payload) => hostApi(apiBase, '/api/wechat/' + path,
    payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }, csrfToken), [apiBase, csrfToken]);
  useEffect(() => {
    const restore = () => {
      if (previousModule.current === 'content') contentScroll.current = window.scrollY;
      const navigation = resolveObserveNavigation(window.location.search, readStored(OBSERVE_NAV_KEY, {}));
      setActiveModule(navigation.module); setActiveNav(navigation.contentView); setWechatPage(navigation.wechatView);
      if (navigation.module === 'wechat') setWechatVisited(true);
    };
    const frame = requestAnimationFrame(() => { restore(); setNavigationReady(true); });
    window.addEventListener('popstate', restore);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('popstate', restore); };
  }, []);
  useEffect(() => {
    if (!navigationReady) return;
    const navigation = { module: activeModule, contentView: activeNav, wechatView: wechatPage };
    localStorage.setItem(OBSERVE_NAV_KEY, JSON.stringify(navigation));
    const search = observeSearch(navigation);
    if (window.location.search !== search) window.history.replaceState(null, '', search);
    if (previousModule.current !== activeModule) {
      window.dispatchEvent(new CustomEvent('observe:module-change', { detail: activeModule }));
      requestAnimationFrame(() => {
        window.scrollTo({ top: activeModule === 'content' ? contentScroll.current : 0, behavior: 'instant' });
        globalHeader.current?.querySelector<HTMLButtonElement>(`[data-module="${activeModule}"]`)?.focus({ preventScroll: true });
      });
      previousModule.current = activeModule;
    }
  }, [activeModule, activeNav, wechatPage, navigationReady]);
  const navigateObserve = (module: ObserveModule, view?: string) => {
    if (activeModule === 'content') contentScroll.current = window.scrollY;
    const contentView = module === 'content' && view ? view : activeNav;
    const wechatView = module === 'wechat' && view ? view as WeChatPage : wechatPage;
    window.history.pushState(null, '', observeSearch({ module, contentView, wechatView }));
    setActiveModule(module); setActiveNav(contentView); setWechatPage(wechatView);
    if (module === 'wechat') setWechatVisited(true);
  };

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [activeNav]);
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
  // “This run found N works” and “the rolling 72-hour total” are separate
  // numbers, so the completion feedback carries its own entry point.
  const [discoveryNotice, setDiscoveryNotice] = useState<number | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null);
  const [bridgeCapabilities, setBridgeCapabilities] = useState<string[]>([]);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeNeedsReload, setBridgeNeedsReload] = useState(false);
  const [collectionTask, setCollectionTask] = useState<CollectionTaskState>(emptyCollectionTask);
  const [isCollecting, setIsCollecting] = useState(false);
  const [todayStart, setTodayStart] = useState(startOfTodayTimestamp);
  const [homeAccountId, setHomeAccountId] = useState('');
  const [contentView, setContentView] = useState<'accounts' | 'discoveries'>('accounts');
  const [discoveries, setDiscoveries] = useState<DiscoveryRecord[]>([]);
  const [clearingDiscoveries, setClearingDiscoveries] = useState(false);
  const [selectedLinkId, setSelectedLinkId] = useState('');
  const [reader, setReader] = useState<ReaderState | null>(null);
  const closeReader = useCallback(() => setReader(null), []);
  const openReader = (video: Video, section: ReadingSection, scope: Video[]) => {
    setReader({ videoId: video.id, videoIds: scope.map((item) => item.id), section });
  };
  const processedResultIds = useRef<Set<string>>(new Set());
  const observedJobStates = useRef<Map<string, string>>(new Map());
  const accountsRef = useRef<Account[]>([]);
  const addingAccountRef = useRef(false);
  const initialSubmissionsRef = useRef(new Set<string>());
  const clearedDiscoveryIdsRef = useRef(new Set<string>());
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
    setDiscoveries(Array.isArray(envelope.discoveries)
      ? (envelope.discoveries as Record<string, unknown>[]).map((item) => ({
        videoId: String(item.videoId || ''),
        accountId: String(item.accountId || ''),
        discoveredAt: textValue(item.discoveredAt),
        expiresAt: textValue(item.expiresAt),
      })).filter((item) => item.videoId && item.discoveredAt && !clearedDiscoveryIdsRef.current.has(item.videoId))
      : []);
    const browser = envelope.browser as Record<string, unknown> | undefined;
    setDedicatedBrowser(browser?.mode === 'dedicated_browser');
    setBrowserError(typeof browser?.error === 'string' ? browser.error : '');
    setCollectionPaused(browser?.collectionPaused === true);
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

  const loadHostState = useCallback(async (signal?: AbortSignal) => {
    const payload = await hostApi<Record<string, unknown>>(apiBase, '/api/state', { signal });
    signal?.throwIfAborted();
    applyHostState(payload);
    return payload;
  }, [apiBase, applyHostState]);

  const loadHostJobs = useCallback(async (signal?: AbortSignal) => {
    const payload = await hostApi<Record<string, unknown>>(apiBase, '/api/jobs', { signal });
    signal?.throwIfAborted();
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
        const updates = Array.isArray(job.result.accountUpdates)
          ? job.result.accountUpdates as { accountName: string; newVideoCount: number }[] : [];
        const succeeded = Number(job.result.succeeded) || 0;
        const failed = Number(job.result.failed) || 0;
        const found = Number(job.result.newVideoCount) || 0;
        const total = Number(job.result.discoveryTotalCount) || 0;
        if (job.status === 'succeeded' && updates.length) {
          setDiscoveryNotice(found);
          setNotice(found > 0
            ? `本次新发现 ${found} 条，已加入“新增检查视频”。`
            : '本次检查完成，无新增视频；72小时内先前结果照常保留。');
        } else if (job.status === 'succeeded') {
          setNotice('采集完成，视频与互动数据已更新；重复视频已自动合并');
        } else {
          setNotice(failed && succeeded
            ? `检查部分完成：成功 ${succeeded} 个、失败 ${failed} 个，本次新发现 ${found} 条，72小时内累计 ${total} 条。`
            : `检查未完成：${job.error || '请检查电脑上的抖音登录状态和验证码后重试'}`);
        }
      }
    }
    observedJobStates.current = new Map(jobs.map((job) => [job.id, job.status]));
    const activeCollectionJobs = jobs.filter(isActiveCollectionJob);
    setIsCollecting(activeCollectionJobs.length > 0);
    if (activeCollectionJobs.length) {
      const job = activeCollectionJobs.find((item) => ['claimed', 'running'].includes(item.status)) || activeCollectionJobs.at(-1)!;
      setCollectionTask((current) => ({
        ...current,
        runId: job.id,
        phase: 'running',
        accountName: textValue(job.progress?.accountName) || textValue(job.payload.accountName)
          || accountsRef.current.find((account) => account.id === job.payload.accountId)?.name || null,
        accountIndex: Number(job.progress?.accountIndex) || 1,
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

  const loadQwenStatus = useCallback(async (signal?: AbortSignal) => {
    const payload = await hostApi<Record<string, unknown>>(apiBase, '/api/qwen/status', { signal });
    signal?.throwIfAborted();
    const status = payload.qwen && typeof payload.qwen === 'object'
      ? payload.qwen as Record<string, unknown>
      : payload;
    setQwenConfigured(Boolean(status.configured ?? status.apiKeyConfigured ?? status.ready));
    setAnalysisProvider(String(status.analysisProvider || 'qwen'));
    setCloudAsrConfigured(Boolean(status.cloudAsrConfigured ?? status.configured));
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

  const applyAuthStatus = useCallback((payload: Record<string, unknown>) => {
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
  }, [isHostLocal]);

  useEffect(() => {
    if (!browserReady) return;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6_000);
    hostApi<Record<string, unknown>>(apiBase, '/api/auth/status', { signal: controller.signal })
      .then((payload) => { if (active) applyAuthStatus(payload); })
      .catch((error: Error) => {
        if (!active) return;
        setAuthPhase('error');
        setAuthMessage(`无法连接主机服务：${error.message}`);
      }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [apiBase, browserReady, applyAuthStatus]);

  useEffect(() => {
    if (authPhase !== 'error' || !browserReady) return;
    let active = true;
    let failures = 0;
    let controller: AbortController | null = null;
    let timer = 0;
    const reconnect = async () => {
      if (!active || controller) return;
      window.clearTimeout(timer);
      controller = new AbortController();
      const request = controller;
      const timeout = window.setTimeout(() => request.abort(), 6_000);
      try {
        // Read-only connection checks must never replay user-submitted jobs.
        const payload = await hostApi<Record<string, unknown>>(apiBase, '/api/auth/status', { signal: request.signal });
        if (active) applyAuthStatus(payload);
      } catch {
        if (active) {
          const delay = [1_000, 2_000, 5_000, 10_000][Math.min(failures++, 3)];
          timer = window.setTimeout(() => { void reconnect(); }, delay);
        }
      } finally {
        window.clearTimeout(timeout);
        controller = null;
      }
    };
    const resume = () => { if (document.visibilityState === 'visible') void reconnect(); };
    timer = window.setTimeout(() => { void reconnect(); }, 1_000);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(timer);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [apiBase, authPhase, browserReady, applyAuthStatus]);

  useEffect(() => {
    if (authPhase !== 'ready') return;
    const reader = createWorkspaceRefresh({
      prepare: migrateLegacyLocalData,
      state: loadHostState,
      jobs: loadHostJobs,
      settings: loadQwenStatus,
      ready: () => setLoaded(true),
      failed: (error, initial) => {
        if (!initial) { setHostConnected(false); return; }
        setLoaded(false);
        setAuthPhase('error');
        setAuthMessage(error instanceof Error ? `加载主机数据失败：${error.message}` : '加载主机数据失败');
      },
    });
    void reader.refresh();
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void reader.refresh();
    };
    const timer = window.setInterval(refresh, 4_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      reader.stop();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
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
            : `正在检查 ${event.data.accountName} 的新作品`);
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
    const timer = window.setTimeout(() => { setNotice(''); setDiscoveryNotice(null); }, 7200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const todayVideos = videos.filter((video) => new Date(video.firstSeenAt).getTime() >= todayStart).length;
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) || accounts[0] || null,
    [accounts, selectedAccountId],
  );
  const selectedAccountVideos = useMemo(
    () => selectedAccount ? videos.filter((video) => video.accountId === selectedAccount.id) : [],
    [selectedAccount, videos],
  );
  const homeVideos = useMemo(() => browseContentVideos(videos, accounts, {
    accountId: homeAccountId, scope: 'all', result: 'all',
  }).map((video) => ({ ...video, authorName: video.authorName || accounts.find((account) => account.id === video.accountId)?.name || null })), [videos, homeAccountId, accounts]);
  const homeAccount = accounts.find((account) => account.id === homeAccountId);
  const headingAccount = activeNav === '内容浏览' && contentView === 'accounts'
    ? homeAccount : activeNav === '互动数据' ? selectedAccount : null;
  // “新增检查视频” aggregates every discovery that is still inside the rolling
  // window across all monitored accounts, ordered by publication time. It is a browsing
  // scope of its own and is never sent to collection or analysis as an account id.
  // The clock re-evaluates when the oldest entry is due to expire, so an open
  // page stops listing an entry without a reload.
  const [discoveryClock, setDiscoveryClock] = useState(() => Date.now());
  const discoveryVideos = useMemo(() => {
    const byId = new Map(videos.map((video) => [video.id, video]));
    return orderContentVideosNewestFirst(discoveries
      .filter((item) => Date.parse(item.expiresAt || '') > discoveryClock && byId.has(item.videoId))
      .map((item) => ({
        ...(byId.get(item.videoId) as Video),
        discoveredAt: item.discoveredAt,
        discoveryExpiresAt: item.expiresAt,
        authorName: byId.get(item.videoId)?.authorName
          || accounts.find((account) => account.id === item.accountId)?.name || null,
      })));
  }, [discoveries, videos, accounts, discoveryClock]);
  useEffect(() => {
    if (!discoveries.length) return;
    const nextExpiry = Math.min(...discoveries.map((item) => Date.parse(item.expiresAt)).filter(Number.isFinite));
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(1000, Math.min(nextExpiry - Date.now() + 1000, 60_000));
    const timer = window.setTimeout(() => setDiscoveryClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [discoveries, discoveryClock]);
  const effectiveDiscoveryVideos = discoveryVideos;
  const clearDiscoveryList = async () => {
    if (clearingDiscoveries || !effectiveDiscoveryVideos.length) return;
    const videoIds = [...new Set(effectiveDiscoveryVideos.map((video) => video.id))];
    setClearingDiscoveries(true);
    try {
      // Bound each gateway request while clearing the complete displayed list.
      // New discoveries arriving after this click are intentionally excluded.
      for (let offset = 0; offset < videoIds.length; offset += 500) {
        const batch = videoIds.slice(offset, offset + 500);
        await hostApi(apiBase, '/api/discoveries/clear', {
          method: 'POST', body: JSON.stringify({ videoIds: batch }),
        }, csrfToken);
        batch.forEach((id) => clearedDiscoveryIdsRef.current.add(id));
        setDiscoveries((current) => current.filter((item) => !clearedDiscoveryIdsRef.current.has(item.videoId)));
      }
      await loadHostState();
      setDiscoveryNotice(null);
      setNotice('已清除当前列表，作品仍在“全部账号”');
    } catch (error) {
      await loadHostState().catch(() => undefined);
      setNotice(`清除失败：${error instanceof Error ? error.message : '请稍后重试'}`);
    } finally {
      setClearingDiscoveries(false);
    }
  };
  const selectedLink = linkVideos.find((video) => video.id === selectedLinkId) || linkVideos[0];
  const selectWorkspaceAccount = (id: string) => animateChange(() => {
    setContentView('accounts');
    setHomeAccountId(id);
    if (id) setSelectedAccountId(id);
    if (activeNav === '信源管理') setActiveNav('内容浏览');
  });
  const selectDiscoveryView = () => animateChange(() => {
    setContentView('discoveries');
    if (activeNav === '信源管理') setActiveNav('内容浏览');
  });

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
        payload: rawJob.payload && typeof rawJob.payload === 'object' ? rawJob.payload as Record<string, unknown> : payload,
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

  const startInitialSync = async (account: Account) => {
    if (account.initialSyncStatus === 'complete' || initialSubmissionsRef.current.has(account.id)
      || accountCollectionState(account.id, hostJobs)) {
      return false;
    }
    initialSubmissionsRef.current.add(account.id);
    setInitialSubmissions(new Set(initialSubmissionsRef.current));
    try {
      await createHostJob('archive_account', { accountId: account.id, retry: true });
      setNotice(`${account.name} 的近 30 条建档任务已进入主机队列`);
      void Promise.all([loadHostJobs(), loadHostState()]).catch(() => undefined);
      return true;
    } catch (error) {
      setNotice(`建档任务创建失败：${error instanceof Error ? error.message : '主机服务没有响应'}`);
      return false;
    } finally {
      initialSubmissionsRef.current.delete(account.id);
      setInitialSubmissions(new Set(initialSubmissionsRef.current));
    }
  };

  const pendingInitialAccounts = accounts.filter((account) => account.platform === 'douyin'
    && account.initialSyncStatus !== 'complete' && !accountCollectionState(account.id, hostJobs)
    && !initialSubmissions.has(account.id));
  const queuePendingInitialSync = async () => {
    if (initialBatchSubmitting) return;
    const pending = [...pendingInitialAccounts];
    setInitialBatchSubmitting(true);
    let queued = 0;
    try {
      for (const account of pending) if (await startInitialSync(account)) queued += 1;
      setNotice(`已安排 ${queued} 个待建档账号，后台将依次读取${queued < pending.length ? `；${pending.length - queued} 个未入队，请检查主机连接` : ''}`);
    } finally {
      setInitialBatchSubmitting(false);
      void Promise.all([loadHostJobs(), loadHostState()]).catch(() => undefined);
    }
  };

  const submitAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (addingAccountRef.current) return;
    const value = canonicalDouyinAccountUrl(accountUrl);
    if (!value) {
      setNotice('请输入正确的抖音账号主页链接');
      return;
    }
    if (accounts.some((account) => account.platform === 'douyin' && canonicalDouyinAccountUrl(account.url) === value)) {
      setNotice('这个账号已经在监控列表中');
      return;
    }
    addingAccountRef.current = true;
    setAddingAccount(true);
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
      const response = await hostApi<{ account: Partial<Account>; reused: boolean; job?: HostJob | null }>(apiBase, '/api/accounts/upsert', {
        method: 'POST',
        body: JSON.stringify({ account, enqueueInitial: true }),
      }, csrfToken);
      const saved = normalizeAccount(response.account, accounts.length);
      setAccounts((current) => current.some((item) => item.id === saved.id)
        ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      setSelectedAccountId(saved.id);
      setAccountUrl('');
      setShowAddAccount(false);
      if (!response.job && (response.reused || saved.id !== account.id)) {
        setNotice('这个账号已经在监控列表中');
        return;
      }
      setNotice(`${saved.name} 已加入建档队列，后台将依次抓取近 30 条`);
      if (response.job) setHostJobs((current) => [response.job!, ...current.filter((job) => job.id !== response.job!.id)]);
      void Promise.all([loadHostJobs(), loadHostState()]).catch(() => undefined);
    } catch (error) {
      setNotice(`添加账号失败：${error instanceof Error ? error.message : '主机服务没有响应'}`);
      void loadHostState().catch(() => undefined);
    } finally {
      addingAccountRef.current = false;
      setAddingAccount(false);
    }
  };

  const requestCheck = (accountId = checkAccountId) => {
    if (!accounts.length) {
      setShowAddAccount(true);
      return;
    }
    if (isCollecting) {
      setNotice('当前采集仍在进行，请等待完成');
      return;
    }
    const accountScopedView = Boolean(accountId);
    const scopedAccount = accounts.find((account) => account.id === accountId);
    const initializedAccounts = accountScopedView
      ? scopedAccount?.initialSyncStatus === 'complete' ? [scopedAccount] : []
      : accounts.filter((account) => account.initialSyncStatus === 'complete');
    if (!initializedAccounts.length) {
      setNotice('请先在账号卡片点击“首次抓取近 30 条”，完成建档后才能检查新作品');
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
        ? `${initializedAccounts[0].name} 的新作品检查已进入主机队列`
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

  const requestTranscription = async (video: Video) => {
    updateVideoEverywhere(video.id, (item) => ({ ...item, transcriptStatus: 'queued', transcriptError: null }));
    try {
      await hostApi(apiBase, '/api/jobs', { method: 'POST', body: JSON.stringify({
        type: 'transcribe_video', payload: { videoId: video.id, retry: ['error', 'paused'].includes(video.transcriptStatus) },
      }) }, csrfToken);
      await loadHostState();
    } catch (error) {
      const message = error instanceof Error ? error.message : '口播识别未能入队';
      updateVideoEverywhere(video.id, (item) => ({ ...item, transcriptStatus: 'error', transcriptError: message }));
    }
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
      setSelectedLinkId(video.id);
      setReader(null);
      setVideoLinkInput('');
      if (response.reused === true) {
        setNotice('这条视频已有完整分析，已复用历史结果');
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
      if (analysisProvider === 'codebuddy') setNotice('电脑上的 CodeBuddy 视频分析组件尚未就绪，请检查组件与登录状态');
      else if (isHostLocal) { setReader(null); setShowQwenConfig(true); }
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

  const videoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    videos.forEach((video) => counts.set(video.accountId, (counts.get(video.accountId) || 0) + 1));
    return counts;
  }, [videos]);
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
  const runningCollectionJob = hostJobs.find((job) => isActiveCollectionJob(job) && ['claimed', 'running'].includes(job.status));
  const waitingCollectionCount = accounts.filter((account) => account.status === 'checking'
    && accountCollectionState(account.id, hostJobs) === 'queued').length;
  const currentTaskLabel = isCollecting
    ? collectionPaused ? `读取已暂停 · ${waitingCollectionCount} 个账号排队`
      : runningCollectionJob ? `正在读取 ${collectionTask.accountName || '当前账号'}${waitingCollectionCount ? ` · ${waitingCollectionCount} 个账号排队` : ''}`
        : `${waitingCollectionCount || hostJobs.filter(isActiveCollectionJob).length} 个账号排队等待主机`
    : collectionTask.phase === 'completed' && collectionTask.completedAt
      ? `${formatTime(collectionTask.completedAt)} · 成功 ${collectionTask.succeeded} / 失败 ${collectionTask.failed}`
      : '当前空闲';

  const statCards = [
    ['监控账号', accounts.length, accounts.length ? `${initializedAccountCount} 个已建档${pendingAccountCount ? ` · ${pendingAccountCount} 个待建档` : ''}` : null],
    ['已采集视频总数', videos.length, null],
    ['今日新收录', todayVideos, null],
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
      await loadQwenStatus();
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
        <div className="observeBrand">Observe</div>

        <h1>{authPhase === 'setup' ? '设置工作台访问密码' : authPhase === 'login' ? '登录 Observe' : authPhase === 'error' ? '主机服务未连接' : '正在打开工作台'}</h1>
        <p>{authMessage || '正在连接主机服务…'}</p>
        {(authPhase === 'setup' || authPhase === 'login') && !setupBlocked && <form onSubmit={submitAuth}>
          <label htmlFor="access-password">访问密码</label>
          <input id="access-password" type="password" autoComplete={authPhase === 'login' ? 'current-password' : 'new-password'} minLength={10} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoFocus />
          {authPhase === 'setup' && <><small className="accessPasswordHint">至少 10 位，用于你的设备登录工作台。</small><label htmlFor="access-password-confirm">再次输入密码</label><input id="access-password-confirm" type="password" autoComplete="new-password" minLength={10} value={authPasswordConfirm} onChange={(event) => setAuthPasswordConfirm(event.target.value)} /></>}
          <button className="primaryButton" type="submit" disabled={authSubmitting}>{authSubmitting ? '请稍候…' : authPhase === 'setup' ? '保存并进入工作台' : '登录'}</button>
        </form>}
        {setupBlocked && <div className="accessNotice">首次密码只能在主机打开 <b>http://localhost:3000</b> 设置。设置完成后，本设备即可使用同一密码登录。</div>}
        {authPhase === 'error' && <><p>正在自动重连，连接恢复后会自动进入工作台。</p><button className="secondaryButton" type="button" onClick={() => window.location.reload()}>立即重试</button></>}
      </section>
    </main>;
  }

  return (
    <div className="observeShell">
      <header className="observeGlobalBar" ref={globalHeader}>
        <strong className="observeBrand">Observe</strong>
        <nav aria-label="模块导航"><button data-module="content" aria-current={activeModule === 'content' ? 'page' : undefined} onClick={() => navigateObserve('content')}>内容情报台{hostJobs.some(j => ['queued', 'processing', 'running'].includes(j.status)) && <span className="observeTaskDot" aria-label="视频任务执行中" />}</button>
          <button data-module="wechat" aria-current={activeModule === 'wechat' ? 'page' : undefined} onClick={() => navigateObserve('wechat')}>微信读取{wechatTask && <small>{wechatTask}</small>}</button></nav>
        <details className="observeSettings"><summary>配色</summary><div><ColorThemePicker /><button className="logoutButton" onClick={logout}>退出当前设备</button></div></details>
      </header>
      <div className="observeContent" hidden={activeModule !== 'content'} inert={activeModule !== 'content'}>
    <main className="appShell">
      <header className="sidebar">
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
          <div className="brandText"><strong>{PLATFORMS[activePlatform].name}</strong></div>
        </div>
        <nav className="navigation" aria-label="内容情报台功能">

          {navItems.map(([icon, label]) => (
            <button className={activeNav === label ? 'navItem active' : 'navItem'} aria-current={activeNav === label ? 'page' : undefined} key={label} onClick={() => {
              navigateObserve('content', label);
              if (label === '信源管理') dismissAccountBadge();
            }}>
              <span className="navIcon" aria-hidden="true">{icon}</span><span className="navText">{label}</span>
              {label === '信源管理' && updatedAccountCount > 0 && <span className="navUpdateBadge" title={`${updatedAccountCount} 个博主有更新，共 ${latestNewVideoCount} 条新视频`}>{latestNewVideoCount}</span>}
            </button>
          ))}
        </nav>
        <details className="sidebarFoot serviceStatus">
          <summary title={hostConnected ? '主机已连接' : '主机未连接'}><i className={hostConnected ? 'connected' : ''} aria-label={hostConnected ? '主机已连接' : '主机未连接'} />视频设置</summary>
          <div className="servicePopover">
          <div className={hostConnected ? 'localStatus connected' : 'localStatus'}><i /><span><b>主机采集服务</b><small>{dedicatedBrowser ? (hostConnected ? '已连接' : '正在连接电脑后台') : !hostConnected ? '服务已连接 · 等待主机 Chrome 自动连接' : isHostLocal ? bridgeNeedsReload ? `Chrome 组件缺少视频分析能力 · 需更新一次到 v${requiredExtensionVersion}` : bridgeReady ? `Chrome 已连接${bridgeVersion ? ` · v${bridgeVersion}` : ''}` : 'Chrome 后台已连接 · 网页桥接自动恢复中' : '已连接 · 任务由主机 Chrome 执行'}</small></span></div>
          <div className="serviceSettings">
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
          </div>
          </div>
        </details>
      </header>

      <WorkspaceRail
        accounts={accounts} videos={videos} links={linkVideos}
        activeNav={activeNav} selectedAccountId={activeNav === '信源管理' ? '' : activeNav === '互动数据' ? selectedAccount?.id || '' : homeAccountId}
        selectedLinkId={selectedLink?.id || ''}
        discoveryCount={effectiveDiscoveryVideos.length}
        discoveryActive={activeNav === '内容浏览' && contentView === 'discoveries'}
        onSelect={selectWorkspaceAccount}
        onDiscoveries={selectDiscoveryView}
        onLink={(id) => animateChange(() => setSelectedLinkId(id))}
        onAdd={() => setShowAddAccount(true)}
      />

      <section className="workspace">
        {activePlatform === 'douyin' && (
          <>
            <header className={activeNav === '链接分析' ? 'topbar linkTopbar' : 'topbar'}>
              <div className="workspaceHeading">
                <h1>{activeNav === '内容浏览'
                  ? contentView === 'discoveries' ? '新增检查视频' : homeAccount?.name || '全部账号'
                  : activeNav === '互动数据' && selectedAccount ? selectedAccount.name : activeNav}</h1>
                {headingAccount && <span className="accountFollowers" title={followerDetailText(headingAccount, formatTime(headingAccount.followerCountCapturedAt || null))}>{formatFollowerLabel(headingAccount)}</span>}
              </div>
              <div className="topActions">
                {activeNav === '内容浏览' && contentView === 'discoveries' && <button
                  type="button" className="secondaryButton"
                  onClick={() => void clearDiscoveryList()}
                  disabled={clearingDiscoveries || !effectiveDiscoveryVideos.length}
                  title="清除当前列表，作品仍保留在全部账号"
                >{clearingDiscoveries ? '清除中…' : '清除'}</button>}
                {activeNav !== '链接分析' && <>
                  <button className="secondaryButton" onClick={() => requestCheck('')} disabled={isCollecting} title="逐个检查全部已建档账号的新作品并刷新近期互动数据">检查全部账号</button>
                  {checkAccountId && <button className="secondaryButton" onClick={() => requestCheck(checkAccountId)} disabled={isCollecting} title="检查当前账号的新作品并刷新近期互动数据">检查当前账号</button>}
                </>}
                {activeNav === '信源管理' && pendingInitialAccounts.length > 0 && <button className="secondaryButton" disabled={initialBatchSubmitting} onClick={() => void queuePendingInitialSync()}>{initialBatchSubmitting ? '正在安排…' : '抓取全部待建档账号'}</button>}
                {activeNav === '信源管理' && <button className="primaryButton" onClick={() => setShowAddAccount(true)}>添加监控账号</button>}
              </div>
            </header>

            {dedicatedBrowser && (browserError || collectionPaused) && <div className="browserAccessNote">

              {browserError && <p role="alert">{browserError}。请在电脑打开抖音登录窗口检查。</p>}
              {collectionPaused && <button className="secondaryButton" type="button" onClick={() => {
                void hostApi(apiBase, '/api/browser/resume-collection', { method: 'POST', body: '{}' }, csrfToken)
                  .then(() => { setNotice('已恢复读取队列'); return Promise.all([loadHostState(), loadHostJobs()]); })
                  .catch((error: Error) => setNotice(error.message));
              }}>已处理，继续读取</button>}
            </div>}

            {activeNav === '内容浏览' && (
              <section className="homeFeed" aria-label="全部信源内容">
                {(!browserError && (accounts.some((account) => account.status === 'error') || !hostConnected)) && <div className="collectionWarning" role="status"><p>{!hostConnected ? '主机暂未连接' : `${accounts.filter((account) => account.status === 'error').length} 个账号采集未完成`}</p><button type="button" className="secondaryButton" onClick={() => animateChange(() => setActiveNav('信源管理'))}>查看状态</button></div>}
                {contentView === 'discoveries'
                  ? (effectiveDiscoveryVideos.length
                    ? <VideoBrowser moduleActive={activeModule === 'content'}
                      key="discoveries"
                      videos={effectiveDiscoveryVideos}
                      accounts={accounts}
                      feedTitle="新增检查视频"
                      feedNote="最近72小时检查发现的新内容"
                      discoveryMode
                      csrfToken={csrfToken}
                      jobs={hostJobs}
                      onOpen={openReader}
                      onAnalysis={requestAnalysis}
                      onCancel={cancelAnalysis}
                      connectorConnected={hostConnected}
                      connectorBusy={bridgeBusy || hostWorkerStatus === 'busy' || hostWorkerStatus === 'running'}
                    />
                    : <EmptyData title="暂无新增检查视频" detail="下次检查发现的新作品会出现在这里，保留72小时。" />)
                  : homeVideos.length
                    ? <VideoBrowser moduleActive={activeModule === 'content'}
                      key={homeAccountId || 'all'}
                      videos={homeVideos}
                      accounts={accounts}
                      feedTitle={homeAccount?.name || '全部视频'}
                      feedNote={`共 ${homeVideos.length} 条`}
                      csrfToken={csrfToken}
                      jobs={hostJobs}
                      onOpen={openReader}
                      onAnalysis={requestAnalysis}
                      onCancel={cancelAnalysis}
                      connectorConnected={hostConnected}
                      connectorBusy={bridgeBusy || hostWorkerStatus === 'busy' || hostWorkerStatus === 'running'}
                    />
                    : <EmptyData title="暂无视频" />}
                <details className="collectionSummary"><summary>采集状态与数据概况</summary>
                  <div className="statsGrid">{statCards.map(([label, value, detail]) => <article className="statCard" key={String(label)}><div className="statLabel">{label}</div><strong>{value}</strong>{detail && <small>{detail}</small>}</article>)}</div>
                  <div className="taskStatusGrid"><span><small>最近一次采集尝试</small><b>{formatTime(lastAccountCheckAt)}</b></span><span><small>最近一次成功采集</small><b>{formatTime(lastAccountSuccessAt)}</b></span><span><small>当前采集任务</small><b>{currentTaskLabel}</b></span></div>
                </details>
              </section>
            )}

            {activeNav === '信源管理' && (
              <div className="workspacePage"><SectionHeading title="全部监控账号" count={`${accounts.length} 个账号`} /><AccountBoard accounts={accounts} videoCounts={videoCounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} onInitialSync={startInitialSync} jobs={hostJobs} submitting={initialSubmissions} /></div>
            )}

            {activeNav === '链接分析' && (
              <div className="workspacePage linkWorkspace">
                <section className="linkAnalysisEntry" aria-label="链接分析">
                  <form onSubmit={submitVideoLink}>
                    <textarea
                      value={videoLinkInput}
                      onChange={(event) => setVideoLinkInput(event.target.value)}
                      placeholder="视频链接或分享文案"
                      disabled={linkSubmitting}
                      aria-label="抖音视频分享链接或分享文案"
                    />
                    <button className="primaryButton" type="submit" disabled={linkSubmitting || !videoLinkInput.trim()}>{linkSubmitting ? '正在解析…' : '开始分析'}</button>
                  </form>
                </section>
                {selectedLink
                  ? <VideoBrowser moduleActive={activeModule === 'content'}
                    key={selectedLink.id}
                    videos={linkVideos}
                    accounts={accounts}
                    inlineVideo={selectedLink}
                    csrfToken={csrfToken}
                    feedTitle="链接记录"
                    feedNote=""
                    jobs={hostJobs}
                    onOpen={openReader}
                    onAnalysis={requestAnalysis}
                    onCancel={cancelAnalysis}
                    connectorConnected={hostConnected}
                    connectorBusy={bridgeBusy || hostWorkerStatus === 'busy' || hostWorkerStatus === 'running'}
                  />
                  : <EmptyData title="暂无链接记录" />}
              </div>
            )}

            {activeNav === '互动数据' && (
              <div className="workspacePage analyticsPage" key={selectedAccount?.id || 'empty'}>
                <AnalyticsBoard
                  key={selectedAccount?.id || 'empty'}
                  videos={selectedAccountVideos}
                  snapshots={selectedAccountSnapshots}
                />
              </div>
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

      {reader && readerVideo && <VideoReader active={activeModule === 'content'} video={readerVideo} jobs={hostJobs} initialSection={reader.section} index={reader.videoIds.indexOf(reader.videoId)} total={reader.videoIds.length} onClose={closeReader} onNavigate={(offset) => setReader((current) => {
        if (!current) return current;
        const id = current.videoIds[current.videoIds.indexOf(current.videoId) + offset];
        return id ? { ...current, videoId: id } : current;
      })} onAnalysis={requestAnalysis} onTranscribe={requestTranscription} onCancel={cancelAnalysis} />}

      {showAddAccount && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => closeOverlay(() => setShowAddAccount(false))}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title" onSubmit={submitAccount} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" aria-label="关闭" onClick={() => closeOverlay(() => setShowAddAccount(false))}>×</button>
            <h2 id="add-account-title">添加新监控账号</h2>
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
            <div className="modalNote">首次近 30 条，后续检查至上次采集位置。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => closeOverlay(() => setShowAddAccount(false))}>取消</button><button className="primaryButton" type="submit" disabled={addingAccount}>{addingAccount ? '正在添加…' : '添加并抓取近 30 条'}</button></div>
          </form>
        </div>
      )}

      {showQwenConfig && isHostLocal && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => closeOverlay(() => { setQwenApiKey(''); setShowQwenConfig(false); })}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="qwen-config-title" onSubmit={saveQwenKey} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" aria-label="关闭" onClick={() => closeOverlay(() => { setQwenApiKey(''); setShowQwenConfig(false); })}>×</button>
            <h2 id="qwen-config-title">AI 分析设置</h2>
            <p>{analysisProvider === 'codebuddy' ? '视频分析使用 MiniMax-M3，额度用尽后切换 MiniMax-M3.1-Flash。' : '视频分析使用 Qwen。'}</p>
            <label htmlFor="qwen-api-key">{analysisProvider === 'codebuddy' ? '云端口播 Qwen API Key' : 'Qwen API Key'}</label>
            <input id="qwen-api-key" type="password" autoComplete="off" value={qwenApiKey} onChange={(event) => setQwenApiKey(event.target.value)} placeholder={cloudAsrConfigured ? '输入新 Key 可替换现有配置' : '请输入 API Key'} autoFocus />
            <div className="modalNote">已有口播稿直接复用；缺失时使用云端识别。密钥只保存在电脑。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => closeOverlay(() => { setQwenApiKey(''); setShowQwenConfig(false); })}>取消</button><button className="primaryButton" type="submit" disabled={qwenSaving}>{qwenSaving ? '保存中…' : cloudAsrConfigured ? '替换配置' : '安全保存'}</button></div>
          </form>
        </div>
      )}

      {notice && <div className="toast" role="status">
        <button type="button" onClick={() => setNotice('')} aria-label={`${notice}，点击关闭提示`} title="点击关闭提示">{notice}<span aria-hidden="true"> ×</span></button>
        {discoveryNotice !== null && effectiveDiscoveryVideos.length > 0 && <button type="button" className="toastAction" onClick={() => { setNotice(''); selectDiscoveryView(); }}>查看“新增检查视频”（72小时内 {effectiveDiscoveryVideos.length} 条）</button>}
      </div>}
    </main>
      </div>
      {wechatVisited && <WeChatWorkspace active={activeModule === 'wechat'} local={isHostLocal} request={wechatRequest} page={wechatPage} onPage={page => navigateObserve('wechat', page)} onTaskStatus={setWechatTask} />}
    </div>
  );
}

function AnalyticsBoard({ videos, snapshots }: {
  videos: Video[];
  snapshots: Snapshot[];
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
    return <EmptyData title="暂无互动数据" />;
  }

  return <section className="analyticsComparisonView">
    <MetricBarComparison
      videos={orderedVideos}
      metricKey={metricKey}
      sortMode={sortMode}
      chartMode={chartMode}
      selectedVideoId={selectedVideo?.id || ''}
      onMetricChange={(metric) => {
        if (metric !== metricKey) animateChange(() => setMetricKey(metric));
      }}
      onSortChange={(mode) => {
        if (mode === sortMode) return;
        animateChange(() => {
          setSortMode(mode);
        });
      }}
      onChartModeChange={(mode) => {
        if (mode === chartMode) return;
        animateChange(() => {
          setChartMode(mode);
        });
      }}
      onSelectVideo={setSelectedVideoId}
    />
    {selectedVideo && <SelectedVideoComparison video={selectedVideo} videos={orderedVideos} snapshots={snapshots} />}
    <details className="analyticsBenchmarks">
      <summary>账号数据基准与近期对比</summary>
      <section className="analysisStats">{ANALYTICS_METRICS.map((dimension) => {
      const summary = summarizeMetric(videos, dimension.key);
      return <article key={dimension.key} style={{ '--metric-color': dimension.color } as React.CSSProperties}>
        <div className="analysisStatTitle"><small>{dimension.label}账号基准</small>{summary.validCount < summary.totalCount && <span>缺少 {summary.totalCount - summary.validCount} 条数据</span>}</div>
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
  const fitChart = chartMode === 'line' || chartContainerWidth <= 600;
  const width = fitChart ? chartContainerWidth : Math.max(720, displayedVideos.length * 96 + 110);
  const height = chartContainerWidth <= 600 ? 320 : 380;
  const paddingLeft = chartContainerWidth <= 600 ? 48 : 80;
  const paddingRight = chartContainerWidth <= 600 ? 16 : 24;
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
  const lineSegments = chartMode === 'line' ? metricTrendSegments(displayedVideos, metricKey) : [];
  const selectedIndex = displayedVideos.findIndex((video) => video.id === selectedVideoId);

  useEffect(() => {
    const container = chartScrollRef.current;
    if (!container || selectedIndex < 0) return;
    if (fitChart) {
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
  }, [selectedIndex, bandWidth, fitChart, paddingLeft]);

  return <article className="metricComparisonCard">
    <div className="metricComparisonHeader">
      <h3>{sortMode === 'published' ? '账号视频互动走势' : '各视频互动高低对比'}</h3>
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
        <select className="mobileMetricSort" aria-label="视频排序" value={sortMode} onChange={(event) => onSortChange(event.target.value as AnalyticsSortMode)}><option value="published">按发布时间</option><option value="value">{metric.label}从高到低</option></select>
      </div>
    <div className={`metricBarChartScroll ${fitChart ? 'metricLineChartFit' : ''}`} ref={chartScrollRef} tabIndex={0} role="region" aria-label={chartMode === 'line' ? '全部视频互动折线图' : fitChart ? '全部视频互动柱形图' : '视频互动柱形图，可横向滚动'}>
      <svg className="metricBarChart" viewBox={`0 0 ${width} ${height}`} style={{ width: fitChart ? '100%' : width, height }} role="group" aria-label={`${metric.label}数据按视频对比${chartMode === 'line' ? '折线图' : '柱形图'}`}>
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
          const showDateLabel = !fitChart || lineLabelIndices.has(index);
          const labelAnchor = fitChart && index === displayedVideos.length - 1 ? 'end' : fitChart && index === 0 ? 'start' : 'middle';
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
  </article>;
}

function SelectedVideoComparison({ video, videos, snapshots }: {
  video: Video;
  videos: Video[];
  snapshots: Snapshot[];
}) {
  const previousVideo = previousPublishedVideo(video, videos);
  const metricSnapshots = ANALYTICS_METRICS.map((dimension) => ({
    dimension,
    change: snapshotMetricChange(video, snapshots, dimension.key),
  }));
  const history = metricSnapshots[0].change;
  return <article className="selectedVideoComparison">
    <div className="selectedVideoPanelHeading">
      <h3>所选视频数据</h3>
    </div>
    <div className="selectedVideoHeader">
      <a className="selectedVideoCover" href={video.url} target="_blank" rel="noreferrer">
        {video.coverUrl ? <img src={video.coverUrl} alt="" referrerPolicy="no-referrer" /> : <span>无封面</span>}
      </a>
      <div><span>{formatCalendarDate(video.publishedAt || video.firstSeenAt, true)}{video.publishedAt ? ' 发布' : ' 首次发现'} · 数据采集 {formatTime(video.lastSeenAt)}</span><h3>{video.title}</h3><p><a href={video.url} target="_blank" rel="noreferrer">打开原视频 ↗</a></p></div>
    </div>
    {(previousVideo || history.sampleCount >= 2) && <div className="selectedComparisonContext">
      {history.sampleCount >= 2 && <p>首次记录 {formatTime(history.firstCapturedAt)} · 最近记录 {formatTime(history.latestCapturedAt)} · {history.sampleCount} 次快照</p>}
      {previousVideo && <p>对比对象：{formatCalendarDate(previousVideo.publishedAt || previousVideo.firstSeenAt, true)}{previousVideo.publishedAt ? ' 发布' : ' 首次发现'} · <a href={previousVideo.url} target="_blank" rel="noreferrer">{previousVideo.title}</a></p>}
    </div>}
    <div className="selectedComparisonTableWrap">
      <table className="selectedComparisonTable">
        <thead><tr><th>指标</th><th>当前累计</th><th>首次记录后变化</th><th>比上一条视频</th><th>账号内排名</th></tr></thead>
        <tbody>{metricSnapshots.map(({ dimension, change: snapshotChange }) => {
          const previousDelta = previousVideo ? calculateDelta(video[dimension.key], previousVideo[dimension.key]) : null;
          const rank = metricRank(video, videos, dimension.key);
          const validCount = videos.filter((candidate) => metricRank(candidate, videos, dimension.key) !== null).length;
          const snapshotText = snapshotChange.sampleCount < 2
            ? snapshotChange.sampleCount === 1 ? '等待下次采集' : '暂无历史记录'
            : snapshotChange.delta ? formatDeltaDetail(snapshotChange.delta) : '首末记录缺少数据';
          const previousText = previousVideo
            ? previousDelta ? formatDeltaDetail(previousDelta) : '两条视频数据不足'
            : '没有更早视频';
          return <tr key={dimension.key} style={{ '--metric-color': dimension.color } as React.CSSProperties}>
            <th scope="row"><i aria-hidden="true" /><span>{dimension.label}</span></th>
            <td data-label="当前累计"><b>{formatMetric(video[dimension.key])}</b></td>
            <td data-label="首次记录后变化" className={deltaTone(snapshotChange.delta)}><span>{snapshotText}</span></td>
            <td data-label="比上一条视频" className={deltaTone(previousDelta)}><span>{previousText}</span></td>
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

function WorkspaceRail({ accounts, videos, links, activeNav, selectedAccountId, selectedLinkId, discoveryCount, discoveryActive, onSelect, onLink, onDiscoveries, onAdd }: {
  accounts: Account[]; videos: Video[]; links: Video[]; activeNav: string;
  selectedAccountId: string; selectedLinkId: string;
  discoveryCount: number; discoveryActive: boolean;
  onSelect: (id: string) => void; onLink: (id: string) => void;
  onDiscoveries: () => void; onAdd: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLinks = activeNav === '链接分析';
  const videoCounts = new Map<string, number>();
  videos.forEach((video) => videoCounts.set(video.accountId, (videoCounts.get(video.accountId) || 0) + 1));
  const currentName = isLinks ? '链接记录'
    : discoveryActive ? '新增检查视频'
      : accounts.find((account) => account.id === selectedAccountId)?.name || '全部账号';
  return <aside className="accountRail" data-view={activeNav} data-expanded={expanded} aria-label={isLinks ? '链接记录' : '切换监控账号'}>
    {isLinks && <div className="railHeading"><strong>链接记录</strong><span>{links.length}</span></div>}
    <button className="mobileAccountSwitch" type="button" aria-expanded={expanded} aria-controls="workspace-rail-options" onClick={() => setExpanded((value) => !value)}><b>{currentName}</b><span>{expanded ? '收起 ↑' : isLinks ? '切换记录 ↓' : '切换账号 ↓'}</span></button>
    <div className="railOptions" id="workspace-rail-options">
      {isLinks ? <>
        {links.length ? links.map((video) => <button className="railLink" type="button" key={video.id} aria-pressed={video.id === selectedLinkId} onClick={() => { onLink(video.id); setExpanded(false); }}>
          <b>{video.title || '未命名视频'}</b><small>{video.authorName || '作者未记录'} · {formatPublishedTime(video.publishedAt)}</small>
        </button>) : <p className="railEmpty">暂无记录</p>}
      </> : <>
        {activeNav !== '互动数据' && <>
          <button className="railAccount railAll" type="button" aria-pressed={!discoveryActive && !selectedAccountId} onClick={() => { onSelect(''); setExpanded(false); }}><b>全部账号</b><span>{accounts.length} 个</span></button>
          <button className="railAccount railDiscoveries" type="button" aria-pressed={discoveryActive} onClick={() => { onDiscoveries(); setExpanded(false); }}>
            <b>新增检查视频</b><span>{discoveryCount} 条</span>
          </button>
        </>}
        {accounts.map((account) => <button type="button" className="railAccount" key={account.id} aria-pressed={!discoveryActive && account.id === selectedAccountId} aria-label={`${account.name}，${videoCounts.get(account.id) || 0} 条视频`} title={`${account.name} · ${videoCounts.get(account.id) || 0} 条视频 · ${accountStatusLabels[account.status]}`} onClick={() => { onSelect(account.id); setExpanded(false); }}>
          <span className="railAvatar" aria-hidden="true">{account.avatarUrl ? <img src={account.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : account.name.slice(0, 1)}</span>
          <span className="railAccountName"><span className="railAccountTitle">{account.name}</span></span>
          <span className="railCount">{videoCounts.get(account.id) || 0}<i className={`railStatus ${account.status}`} aria-label={accountStatusLabels[account.status]} /></span>
        </button>)}
        <button className="railAdd secondaryButton" type="button" onClick={onAdd}>＋ 添加账号</button>
      </>}
    </div>
  </aside>;
}

const accountStatusLabels: Record<AccountStatus, string> = {
  waiting: '等待检查',
  checking: '检查中',
  ready: '已完成抓取',
  error: '抓取失败',
};

function AccountBoard({ accounts, videoCounts, onAdd, onRemove, onInitialSync, jobs, submitting }: {
  accounts: Account[];
  videoCounts: Map<string, number>;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onInitialSync: (account: Account) => Promise<boolean>;
  jobs: HostJob[];
  submitting: Set<string>;
}) {
  if (!accounts.length) {
    return <section className="emptyBoard"><div className="emptySymbol">＋</div><h3>添加第一个监控账号</h3><button className="primaryButton" onClick={onAdd}>添加新监控账号</button></section>;
  }
  return <section className="accountGrid">{accounts.map((account) => {
    const queueState = (account.status === 'checking' || account.initialSyncStatus !== 'complete') ? accountCollectionState(account.id, jobs) : null;
    const statusLabel = queueState === 'queued' ? '排队中' : queueState === 'running' ? '读取中' : account.status === 'checking' ? '检查中'
      : account.initialSyncStatus === 'error' ? '抓取失败' : accountStatusLabels[account.status];
    return <article className="accountCard" key={account.id}>
      <div className="accountTop">{account.avatarUrl && <div className="accountAvatar"><img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /></div>}<h3>{account.name}</h3><span className={`statusPill ${account.status}`}>{statusLabel}</span></div>
      <a href={account.url} target="_blank" rel="noreferrer">打开原账号主页 ↗</a>
      {account.status === 'error' && account.collectionError && <p className="accountUpdateNotice" role="status">失败原因：{account.collectionError}</p>}
      {account.status === 'checking' && account.currentSyncMode === 'latest'
        ? <div className="accountUpdateNotice checking">检查中</div>
        : account.latestCheckNewVideoCount !== null && <div className={`accountUpdateNotice ${account.latestCheckNewVideoCount > 0 ? 'updated' : 'none'}`}>
          <strong>{`${account.status === 'error' ? '上次成功检查' : '最近一次检查'}${account.latestCheckNewVideoCount > 0 ? `：新增 ${account.latestCheckNewVideoCount} 条` : '：无新增'}`}</strong>
          {account.status === 'error' && <small>上次成功：{formatTime(account.lastSuccessAt)}</small>}
        </div>}
      <div className="accountMeta"><span><small>粉丝量</small><b title={followerDetailText(account, formatTime(account.followerCountCapturedAt || null))}>{formatFollowerLabel(account)}</b></span><span><small>作品数</small><b>{videoCounts.get(account.id) || 0} 条视频</b></span><span><small>首次建档</small><b>{account.initialSyncStatus === 'complete' ? formatTime(account.initialSyncCompletedAt) : '待抓取近 30 条'}</b></span><span><small>最近检查</small><b>{account.lastCheckedAt ? formatTime(account.lastCheckedAt) : '尚未检查'}</b></span></div>
      {account.initialSyncStatus !== 'complete' && <button className="initialSyncButton" disabled={Boolean(queueState) || submitting.has(account.id)} onClick={() => void onInitialSync(account)}>{submitting.has(account.id) ? '正在入队…' : queueState === 'queued' ? '排队中' : queueState === 'running' ? '正在抓取近 30 条…' : account.initialSyncStatus === 'error' ? '重新抓取近 30 条' : '首次抓取近 30 条'}</button>}
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

function transcriptPendingText(video: Video) {
  return video.transcriptStatus === 'paused' ? '口播识别已暂停'
    : video.transcriptStatus === 'queued' ? '口播识别排队中'
    : video.transcriptStatus === 'processing' ? '正在识别口播'
      : video.transcriptStatus === 'ready' ? '未识别到清晰口播'
        : video.transcriptStatus === 'error' ? `口播识别未完成：${redactDiagnosticText(video.transcriptError || '请重试')}` : '暂无口播稿';
}

function analysisProgress(video: Video, job?: HostJob) {
  const stage = String(job?.progress?.stage || '');
  return textValue(job?.progress?.message) || ({
    browser_capture: '正在获取并校验目标完整视频', downloading_original_video: '正在下载完整视频并核对时长',
    local_asr_and_secure_upload: '正在识别口播并准备视频', cloud_asr_and_secure_upload: '正在识别完整音轨，并准备视频分析',
    cloud_asr: '正在识别完整音轨', secure_video_upload: '正在上传完整视频',
    qwen_full_video_analysis: '视频已提交，等待模型返回', qwen_reasoning: '模型正在分析完整视频',
    analysis_model_fallback: 'MiniMax 额度已用尽，已切换 MiniMax-M3.1-Flash',
    qwen_receiving_output: '正在接收内容分析和制作规范', lossless_continuous_segmentation: '正在无损分段处理完整视频',
  } as Record<string, string>)[stage] || (displayedAnalysisStatus(video, job) === 'queued' ? '任务已排队，等待主机处理' : '正在处理分析任务');
}

type VideoPresentationProps = {
  jobs: HostJob[];
  onOpen: (video: Video, section: ReadingSection, scope: Video[]) => void;
  onAnalysis: (video: Video, regenerate?: boolean, forceRegenerate?: boolean) => void;
  onCancel: (job: HostJob) => void;
  connectorConnected: boolean; connectorBusy: boolean;
};

type PreviewStatus = 'idle' | 'pending' | 'ready' | 'error';
type PreviewState = { generation: string; status: PreviewStatus; message?: string; codec?: string | null };

const PREVIEW_POLL_INTERVAL_MS = 260;

function previewMediaUrl(videoId: string, generation: string) {
  return `${getHostApiBase()}/api/previews/${videoId}/${generation}/media`;
}

function VideoBrowser({ videos, accounts, feedTitle, feedNote, discoveryMode = false, csrfToken, inlineVideo, moduleActive, ...presentation }: VideoPresentationProps & {
  videos: Video[]; accounts: Account[]; feedTitle: string; feedNote: string; discoveryMode?: boolean; csrfToken: string; inlineVideo?: Video; moduleActive: boolean;
}) {
  const authorsById = useMemo(() => new Map(accounts.map(account => [account.id, account])), [accounts]);
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const moduleActiveRef = useRef(moduleActive);
  useEffect(() => { moduleActiveRef.current = moduleActive; }, [moduleActive]);
  const modulePlaybackPosition = useRef(0);
  const initialInlineVideoRef = useRef(inlineVideo);
  const playerRef = useRef<HTMLDivElement>(null);
  const playerOpenRef = useRef(Boolean(inlineVideo));
  const startPlaybackRef = useRef(Boolean(inlineVideo));
  const playerDragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [playerPosition, setPlayerPosition] = useState<{ x: number; y: number } | null>(null);
  const [playerDragging, setPlayerDragging] = useState(false);
  const playerResizeRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; width: number; height: number; corner: string } | null>(null);
  const [playerSize, setPlayerSize] = useState<{ width: number; height: number } | null>(null);
  const [playerResizing, setPlayerResizing] = useState(false);
  const [playerPaused, setPlayerPaused] = useState(true);
  const [playerBuffering, setPlayerBuffering] = useState(false);
  const [playerTime, setPlayerTime] = useState({ current: 0, duration: 0 });
  const [mediaAspect, setMediaAspect] = useState(16 / 9);
  const [hoverId, setHoverId] = useState('');
  const [playerId, setPlayerId] = useState(inlineVideo?.id || '');
  const [hoverBounds, setHoverBounds] = useState<DOMRect | null>(null);
  const [playError, setPlayError] = useState('');
  const [renderedMediaUrl, setRenderedMediaUrl] = useState('');
  const [decodedHoverUrl, setDecodedHoverUrl] = useState('');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playbackVolume, setPlaybackVolume] = useState(1);
  const [playbackMuted, setPlaybackMuted] = useState(false);
  const playbackMutedRef = useRef(false);
  const presentedSourceRef = useRef('');
  const frameWaitRef = useRef<{ source: string; cancel: () => void } | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const hoveredIdRef = useRef('');
  const interruptedHoverRef = useRef('');
  const resumeInlineRef = useRef(false);
  const hoverScrollTopRef = useRef(0);
  const requestedRef = useRef<Set<string>>(new Set());
  const mediaRetries = useRef<Set<string>>(new Set());
  const pollTimers = useRef<Map<string, number>>(new Map());
  const pendingPolls = useRef<Map<string, () => void>>(new Map());
  const mountedRef = useRef(true);
  const activeMediaId = playerId || hoverId;
  const activePreview = activeMediaId && previews[activeMediaId]?.status === 'ready' ? previews[activeMediaId] : null;
  const playerError = playError || (playerId && previews[playerId]?.status === 'error'
    ? previews[playerId].message || '视频源加载失败，请重新打开视频' : '');
  const mediaUrl = activePreview && activeMediaId ? previewMediaUrl(activeMediaId, activePreview.generation) : '';
  const showHover = Boolean(hoverId && !playerId && hoverBounds && mediaUrl && decodedHoverUrl === mediaUrl);

  const stopPreviewPolling = useCallback((videoId: string) => {
    pendingPolls.current.delete(videoId);
    const timer = pollTimers.current.get(videoId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pollTimers.current.delete(videoId);
    }
  }, []);

  const applyPreviewSource = useCallback((videoId: string, generation: string, codec?: string | null) => {
    stopPreviewPolling(videoId);
    // Decoder capability depends on the full track configuration. Let the
    // actual media element attempt playback instead of rejecting a codec family.
    setPreviews((current) => ({ ...current, [videoId]: { generation, status: 'ready', codec } }));
  }, [stopPreviewPolling, setPreviews]);

  // One prepare request per work; every later read only checks the stored
  // status, so polling never opens another detail page.
  const prepareVideo = useCallback((video: Video) => {
    if (!moduleActiveRef.current || requestedRef.current.has(video.id)) return;
    requestedRef.current.add(video.id);
    setPreviews((current) => ({ ...current, [video.id]: { generation: '', status: 'pending' } }));

    const poll = () => {
      stopPreviewPolling(video.id);
      pendingPolls.current.set(video.id, poll);
      const timer = window.setTimeout(() => {
        pollTimers.current.delete(video.id);
        if (!mountedRef.current) return;
        void hostApi<Record<string, unknown>>(getHostApiBase(), `/api/previews/${video.id}/status`)
          .then((payload) => {
            if (!mountedRef.current) return;
            const status = textValue(payload.status);
            const generation = textValue(payload.generation);
            if (status === 'ready' && generation) { applyPreviewSource(video.id, generation, textValue(payload.codec) || null); return; }
            if (status === 'error') {
              pendingPolls.current.delete(video.id);
              requestedRef.current.delete(video.id);
              setPreviews((current) => ({ ...current, [video.id]: { generation: '', status: 'error', message: textValue(payload.message) || '无法取得可播放的低清源' } }));
              return;
            }
            if (status === 'pending' && (Number(payload.elapsedMs) || 0) < 90_000) { poll(); return; }
            pendingPolls.current.delete(video.id);
            requestedRef.current.delete(video.id);
            setPreviews((current) => ({ ...current, [video.id]: { generation: '', status: 'idle' } }));
          })
          .catch((error: Error) => {
            if (!mountedRef.current) return;
            pendingPolls.current.delete(video.id);
            requestedRef.current.delete(video.id);
            setPreviews((current) => ({ ...current, [video.id]: { generation: '', status: 'error', message: error.message } }));
          });
      }, PREVIEW_POLL_INTERVAL_MS);
      pollTimers.current.set(video.id, timer);
    };

    void hostApi<Record<string, unknown>>(getHostApiBase(), '/api/previews/prepare', {
      method: 'POST',
      body: JSON.stringify({ videoIds: [video.id] }),
    }, csrfToken)
      .then((payload) => {
        if (!mountedRef.current) return;
        const sources = Array.isArray(payload.sources) ? payload.sources as Record<string, unknown>[] : [];
        const source = sources.find((item) => String(item.videoId) === video.id);
        const generation = source ? textValue(source.generation) : '';
        if (source && textValue(source.status) === 'ready' && generation) {
          applyPreviewSource(video.id, generation, textValue(source.codec) || null);
          return;
        }
        if (source && textValue(source.status) === 'error') {
          requestedRef.current.delete(video.id);
          setPreviews((current) => ({ ...current, [video.id]: { generation: '', status: 'error', message: textValue(source.message) || '无法取得可播放的低清源' } }));
          return;
        }
        poll();
      })
      .catch((error: Error) => {
        if (!mountedRef.current) return;
        requestedRef.current.delete(video.id);
        setPreviews((current) => ({ ...current, [video.id]: { generation: '', status: 'error', message: error.message } }));
      });
  }, [applyPreviewSource, csrfToken, stopPreviewPolling]);

  // A link record is an explicit viewing intent. Preparing it is independent
  // of analysis completion; later metadata/results refreshes keep this source.
  useEffect(() => {
    const video = initialInlineVideoRef.current;
    if (video && moduleActive) prepareVideo(video);
  }, [prepareVideo, moduleActive]);

  const clearMedia = useCallback(() => {
    frameWaitRef.current?.cancel();
    frameWaitRef.current = null;
    presentedSourceRef.current = '';
    setRenderedMediaUrl('');
    setDecodedHoverUrl('');
    setPlayerPaused(true);
    const element = mediaRef.current;
    if (!element) return;
    element.muted = true;
    element.pause();
    // Pausing alone would leave the transfer running. load() aborts the current
    // media request so the host stops reading from the platform CDN.
    element.removeAttribute('src');
    element.load();
  }, [setRenderedMediaUrl, setDecodedHoverUrl, setPlayerPaused]);

  const requestPlayback = useCallback((element: HTMLVideoElement) => {
    const source = element.getAttribute('src');
    if (!source || !moduleActiveRef.current) return;
    const play = () => {
      if (!mountedRef.current || element !== mediaRef.current || element.getAttribute('src') !== source
        || (!playerOpenRef.current && !hoveredIdRef.current) || !startPlaybackRef.current) return;
      element.muted = !playerOpenRef.current || playbackMutedRef.current;
      void element.play().catch((error: unknown) => {
        const name = error instanceof Error ? error.name : '';
        // A cleared/replaced source and an interrupted play are normal during
        // switching, closing and pausing; their old promises cannot set a banner.
        if (!mountedRef.current || element !== mediaRef.current || !playerOpenRef.current
          || element.getAttribute('src') !== source || !element.paused || name === 'AbortError') return;
        setPlayError(name === 'NotAllowedError' ? '浏览器限制了自动播放，请点击播放'
          : name === 'NotSupportedError' ? '视频加载或解码失败，请重新打开视频'
            : '视频播放失败，请重新打开视频');
      });
    };
    if (presentedSourceRef.current === source && element.readyState >= 2) { play(); return; }
    // Keep both the audio and clock stopped until a real video frame reaches
    // the compositor. `playing`/`canplay` alone can precede that frame.
    element.muted = true;
    if (frameWaitRef.current?.source === source) return;
    frameWaitRef.current?.cancel();
    let cancelled = false;
    let frame = 0;
    let raf = 0;
    let timer = 0;
    let frameConfirmed = false;
    const cancel = () => {
      cancelled = true;
      if (frame) element.cancelVideoFrameCallback(frame);
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      element.removeEventListener('canplay', watchForMissingFrame);
      element.removeEventListener('loadeddata', fallbackFrame);
      element.removeEventListener('loadeddata', finishPresentedFrame);
    };
    const isCurrent = () => !cancelled && mountedRef.current && element === mediaRef.current
      && element.getAttribute('src') === source && (playerOpenRef.current || Boolean(hoveredIdRef.current));
    const presented = () => {
      if (!isCurrent() || !element.videoWidth || !element.videoHeight || element.readyState < 2) return;
      cancel();
      frameWaitRef.current = null;
      presentedSourceRef.current = source;
      flushSync(() => { setRenderedMediaUrl(source); setPlayerBuffering(false); });
      play();
    };
    // Chrome can deliver the compositor callback just before readyState is
    // advanced to HAVE_CURRENT_DATA. Retain that confirmation until loadeddata.
    const finishPresentedFrame = () => { if (frameConfirmed) presented(); };
    const watchForMissingFrame = () => {
      if (timer || !isCurrent()) return;
      timer = window.setTimeout(() => {
        if (!isCurrent()) return;
        cancel();
        frameWaitRef.current = null;
        element.pause();
        setPlayerPaused(true);
        if (playerOpenRef.current) {
          setPlayerBuffering(false);
          setPlayError('视频画面加载超时，请重新打开或查看原视频');
        }
      }, 15_000);
    };
    // A paused first frame may already be decoded before the compositor
    // callback is subscribed. Do not wait for a second frame while paused.
    const hasDecodedFrame = () => {
      if (element.readyState < 2 || !element.videoWidth || !element.videoHeight) return false;
      if (typeof element.getVideoPlaybackQuality !== 'function') return true;
      const quality = element.getVideoPlaybackQuality();
      return quality.totalVideoFrames > quality.droppedVideoFrames;
    };
    const fallbackFrame = () => {
      window.cancelAnimationFrame(raf);
      const waitForPaint = () => {
        if (!isCurrent()) return;
        if (!hasDecodedFrame()) { raf = window.requestAnimationFrame(waitForPaint); return; }
        raf = window.requestAnimationFrame(() => { if (hasDecodedFrame()) presented(); else fallbackFrame(); });
      };
      raf = window.requestAnimationFrame(waitForPaint);
    };
    frameWaitRef.current = { source, cancel };
    if (typeof element.requestVideoFrameCallback === 'function') {
      element.addEventListener('loadeddata', finishPresentedFrame);
      frame = element.requestVideoFrameCallback(() => { frameConfirmed = true; presented(); });
    }
    if (element.readyState >= 2) fallbackFrame();
    else element.addEventListener('loadeddata', fallbackFrame, { once: true });
    element.addEventListener('canplay', watchForMissingFrame, { once: true });
    if (element.readyState >= 3) watchForMissingFrame();
  }, [setPlayError]);

  // The floating preview is an overlay with pointer-events disabled, so it can
  // never receive its own mouseleave. The real pointer position decides whether
  // it should still be on screen.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const rowFor = useCallback((videoId: string) => feedRef.current?.querySelector<HTMLElement>(`[data-video-id="${videoId}"]`) || null, []);
  const pointerOnRow = useCallback((videoId: string) => {
    const pointer = pointerRef.current;
    if (!pointer) return true;
    const row = rowFor(videoId);
    if (!row) return false;
    const bounds = (row.querySelector<HTMLElement>('.compactCover') || row).getBoundingClientRect();
    return pointer.x >= bounds.left && pointer.x <= bounds.right
      && pointer.y >= bounds.top && pointer.y <= bounds.bottom;
  }, [rowFor]);

  // The floating preview lives over the whole card while the pointer is on it,
  // and must follow the cover and disappear as soon as the pointer leaves.

  const hoverVideo = (video: Video, target: HTMLElement) => {
    if (playerOpenRef.current || window.matchMedia('(hover: none)').matches) return;
    if (hoveredIdRef.current === video.id) return;
    const bounds = target.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !pointerOnRow(video.id)) return;
    prepareVideo(video);
    startPlaybackRef.current = true;
    mediaRetries.current.delete(video.id);
    interruptedHoverRef.current = '';
    hoveredIdRef.current = video.id;
    hoverScrollTopRef.current = feedRef.current?.scrollTop || 0;
    setPlayError('');
    setHoverBounds(bounds);
    setHoverId(video.id);
  };
  const stopHover = () => {
    interruptedHoverRef.current = !document.hasFocus() ? hoveredIdRef.current : '';
    hoveredIdRef.current = '';
    if (playerOpenRef.current) return;
    setHoverId('');
    setHoverBounds(null);
    clearMedia();
  };
  const openPlayer = (video: Video) => {
    playerOpenRef.current = true;
    startPlaybackRef.current = true;
    setPlayError('');
    setPlaybackMuted(false);
    playbackMutedRef.current = false;
    const volume = playbackVolume > 0 ? playbackVolume : 0.8;
    setPlaybackVolume(volume);
    const element = mediaRef.current;
    if (element) { element.muted = presentedSourceRef.current !== element.getAttribute('src'); element.volume = volume; }
    const continuing = hoverId === video.id && previews[video.id]?.status === 'ready';
    if (!continuing) {
      // Removing the React src prop alone does not abort the previous resource.
      // Stop that work before waiting for the newly selected target's source.
      clearMedia();
      // Opening is an independent playback intent. Validate the current host
      // source even if this page remembers an old prepared generation.
      requestedRef.current.delete(video.id);
      stopPreviewPolling(video.id);
      prepareVideo(video);
      setPlayerBuffering(true);
      setPlayerTime({ current: 0, duration: video.durationSeconds || 0 });
    }
    if (hoverId === video.id) {
      // Keep the same element, media version and currentTime; only unmute and
      // change presentation, so a hover never restarts from the beginning.
      setHoverId('');
      setPlayerId(video.id);
      if (continuing && element && element.currentSrc.includes(`/api/previews/${video.id}/`)) {
        requestPlayback(element);
        return;
      }
    }
    setSelectedId(video.id);
    setPlayerId(video.id);
  };
  const closePlayer = () => {
    playerOpenRef.current = false;
    startPlaybackRef.current = false;
    playerDragRef.current = null;
    playerResizeRef.current = null;
    setPlayerDragging(false);
    setPlayerResizing(false);
    hoveredIdRef.current = '';
    interruptedHoverRef.current = '';
    if (mediaRef.current) mediaRef.current.muted = true;
    clearMedia();
    setPlayerId('');
    setHoverId('');
    setHoverBounds(null);
    setPlayError('');
  };
  const boundPlayerPosition = useCallback((x: number, y: number) => {
    const bounds = playerRef.current?.getBoundingClientRect();
    const margin = 8;
    return { x: Math.max(margin, Math.min(x, window.innerWidth - (bounds?.width || 0) - margin)),
      y: Math.max(64, Math.min(y, window.innerHeight - (bounds?.height || 0) - margin)) };
  }, []);
  const startPlayerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !playerRef.current) return;
    const bounds = playerRef.current.getBoundingClientRect();
    playerDragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPlayerPosition({ x: bounds.left, y: bounds.top });
    setPlayerDragging(true);
    event.preventDefault();
  };
  const movePlayerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = playerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPlayerPosition(boundPlayerPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY));
  };
  const stopPlayerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    playerDragRef.current = null;
    setPlayerDragging(false);
  };
  const resizePlayer = useCallback((width: number, height: number, left: number, top: number, corner: string) => {
    const bounds = playerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const west = corner.includes('w');
    const north = corner.includes('n');
    const right = left + bounds.width;
    const bottom = top + bounds.height;
    const maxWidth = Math.max(0, west ? right - 8 : window.innerWidth - left - 8);
    const maxHeight = Math.max(0, north ? bottom - 64 : window.innerHeight - top - 8);
    const nextWidth = Math.max(Math.min(360, maxWidth), Math.min(width, maxWidth));
    const nextHeight = Math.max(Math.min(280, maxHeight), Math.min(height, maxHeight));
    setPlayerSize({ width: nextWidth, height: nextHeight });
    setPlayerPosition({ x: west ? right - nextWidth : left, y: north ? bottom - nextHeight : top });
  }, [setPlayerPosition, setPlayerSize]);
  const startPlayerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !playerRef.current) return;
    const corner = event.currentTarget.dataset.corner || 'se';
    const bounds = playerRef.current.getBoundingClientRect();
    playerResizeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, corner };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPlayerResizing(true);
    event.preventDefault();
  };
  const movePlayerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = playerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    // Keep the opposite corner anchored even across successive React renders.
    const width = resize.width + (event.clientX - resize.x) * (resize.corner.includes('w') ? -1 : 1);
    const height = resize.height + (event.clientY - resize.y) * (resize.corner.includes('n') ? -1 : 1);
    const bounds = playerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    resizePlayer(width, height,
      resize.corner.includes('w') ? resize.left + resize.width - bounds.width : resize.left,
      resize.corner.includes('n') ? resize.top + resize.height - bounds.height : resize.top, resize.corner);
  };
  const stopPlayerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    playerResizeRef.current = null;
    setPlayerResizing(false);
  };
  const losePlayerResize = () => { playerResizeRef.current = null; setPlayerResizing(false); };
  const keyPlayerResize = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const bounds = playerRef.current?.getBoundingClientRect();
    if (!bounds || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const corner = event.currentTarget.dataset.corner || 'se';
    const step = event.shiftKey ? 50 : 20;
    const horizontal = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const vertical = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    resizePlayer(bounds.width + horizontal * (corner.includes('w') ? -1 : 1), bounds.height + vertical * (corner.includes('n') ? -1 : 1), bounds.left, bounds.top, corner);
  };
  const togglePlayback = () => {
    const element = mediaRef.current;
    if (!element || !activeVideo) return;
    if (!mediaUrl) { requestedRef.current.delete(activeVideo.id); prepareVideo(activeVideo); startPlaybackRef.current = true; return; }
    if (element.paused) {
      startPlaybackRef.current = true;
      if (element.ended) element.currentTime = 0;
      requestPlayback(element);
    } else { startPlaybackRef.current = false; element.pause(); }
  };
  const enterFullscreen = () => {
    const element = mediaRef.current;
    if (!element) return;
    element.controls = true;
    void element.requestFullscreen().catch(() => { element.controls = false; setPlayError('无法进入全屏'); });
  };
  useEffect(() => {
    if (!playerId) return;
    const keepOnScreen = () => {
      setPlayerSize(current => {
        if (!current) return current;
        const width = Math.min(current.width, window.innerWidth - 16);
        const height = Math.min(current.height, window.innerHeight - 16);
        return width === current.width && height === current.height ? current : { width, height };
      });
      setPlayerPosition(current => {
      if (!current) return current;
      const next = boundPlayerPosition(current.x, current.y);
      return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    const observer = new ResizeObserver(keepOnScreen);
    if (playerRef.current) observer.observe(playerRef.current);
    window.addEventListener('resize', keepOnScreen);
    return () => { observer.disconnect(); window.removeEventListener('resize', keepOnScreen); };
  }, [playerId, boundPlayerPosition]);
  useEffect(() => {
    const onFullscreen = () => { if (mediaRef.current) mediaRef.current.controls = document.fullscreenElement === mediaRef.current; };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);
  useEffect(() => {
    if (!moduleActive || !activeMediaId || !mediaUrl) return;
    const element = mediaRef.current;
    if (!element) return;
    // Scroll cleanup can remove the source just before a click on the same
    // work. React may batch that transition without changing the src prop, so
    // restore the currently requested online source before resuming playback.
    if (element.getAttribute('src') !== mediaUrl) {
      element.src = mediaUrl;
      element.load();
    }
    // Opening explicitly unmutes in the click handler; replacing an expired
    // source must preserve any later mute choice made in the open player.
    if (!playerOpenRef.current) element.muted = true;
    requestPlayback(element);
  }, [activeMediaId, mediaUrl, playerId, requestPlayback, moduleActive]);
  useEffect(() => {
    playbackMutedRef.current = playbackMuted;
    const element = mediaRef.current;
    if (element) element.muted = !playerId || playbackMuted || presentedSourceRef.current !== element.getAttribute('src');
  }, [playerId, playbackMuted, renderedMediaUrl]);
  useEffect(() => {
    if (!mediaRef.current) return;
    mediaRef.current.playbackRate = playbackRate;
    mediaRef.current.volume = playbackVolume;
  }, [playbackRate, playbackVolume, activeMediaId]);
  // A card can slide under a stationary pointer while the list scrolls, so the
  // floating preview follows the real cover and disappears once the pointer is
  // no longer on that card.
  useEffect(() => {
    if (!hoverId) return;
    const hide = () => {
      if (playerOpenRef.current) return;
      hoveredIdRef.current = '';
      setHoverId('');
      setHoverBounds(null);
      clearMedia();
    };
    const track = () => {
      if (playerOpenRef.current) return;
      if (!pointerRef.current) return;
      const cover = rowFor(hoverId)?.querySelector<HTMLElement>('.compactCover');
      if (!cover || !pointerOnRow(hoverId)) {
        hide();
        return;
      }
      const bounds = cover.getBoundingClientRect();
      if (!bounds.width) {
        hide();
        return;
      }
      setHoverBounds(bounds);
    };
    const scroller = feedRef.current;
    scroller?.addEventListener('scroll', track, { passive: true });
    window.addEventListener('resize', track);
    window.addEventListener('pointermove', track);
    return () => {
      scroller?.removeEventListener('scroll', track);
      window.removeEventListener('resize', track);
      window.removeEventListener('pointermove', track);
    };
  }, [hoverId, clearMedia, pointerOnRow, rowFor]);
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => { pointerRef.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, []);
  useEffect(() => {
    const scroller = feedRef.current;
    const onScrollStart = () => {
      // A scroll completed before mouseenter can dispatch its event afterward.
      // Cancel only a position change that happened after the new hover began.
      if (hoveredIdRef.current && scroller?.scrollTop === hoverScrollTopRef.current) return;
      hoveredIdRef.current = '';
      if (playerOpenRef.current) return;
      // Scrolling moves the cover away from the pointer, so the floating
      // preview must not be left hanging over an old coordinate.
      setHoverId('');
      setHoverBounds(null);
      clearMedia();
    };
    scroller?.addEventListener('scroll', onScrollStart, { passive: true });
    return () => scroller?.removeEventListener('scroll', onScrollStart);
  }, [clearMedia]);
  useEffect(() => {
    const resumeInterruptedHover = () => {
      const videoId = interruptedHoverRef.current;
      interruptedHoverRef.current = '';
      if (!videoId || playerOpenRef.current || !pointerOnRow(videoId)) return;
      const cover = rowFor(videoId)?.querySelector<HTMLElement>('.compactCover');
      if (!cover) return;
      hoveredIdRef.current = videoId;
      hoverScrollTopRef.current = feedRef.current?.scrollTop || 0;
      setHoverBounds(cover.getBoundingClientRect());
      setHoverId(videoId);
    };
    window.addEventListener('focus', resumeInterruptedHover);
    return () => window.removeEventListener('focus', resumeInterruptedHover);
  }, [pointerOnRow, rowFor]);
  useEffect(() => {
    const onModule = (event: Event) => {
      moduleActiveRef.current = (event as CustomEvent<string>).detail === 'content';
      if (!moduleActiveRef.current) {

        interruptedHoverRef.current = ''; hoveredIdRef.current = '';
        setHoverId(''); setHoverBounds(null);
        modulePlaybackPosition.current = mediaRef.current?.currentTime || modulePlaybackPosition.current;
        startPlaybackRef.current = false; resumeInlineRef.current = false;
        clearMedia();
      } else {
        const element = mediaRef.current;
        if (element && mediaUrl && playerOpenRef.current) {
          element.src = mediaUrl; element.preload = 'metadata'; element.load();
          element.addEventListener('loadedmetadata', () => {
            if (moduleActiveRef.current) element.currentTime = modulePlaybackPosition.current;
          }, { once: true });
        }
      }
    };
    window.addEventListener('observe:module-change', onModule);
    return () => window.removeEventListener('observe:module-change', onModule);
  });
  useEffect(() => {
    const onVisibility = () => {
      if (!moduleActiveRef.current) return;
      if (!inlineVideo) { if (document.hidden) { stopHover(); closePlayer(); } return; }
      if (document.hidden) { resumeInlineRef.current = Boolean(mediaRef.current && !mediaRef.current.paused); clearMedia(); return; }
      // Restore the same prepared generation after returning to the page.
      const element = mediaRef.current;
      if (element && mediaUrl) {
        element.src = mediaUrl;
        element.load();
        if (resumeInlineRef.current) requestPlayback(element);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });
  useEffect(() => {
    mountedRef.current = true;
    const timers = pollTimers.current;
    // Development refresh/StrictMode remounts effects without recreating refs.
    // Resume status polling so an already prepared source cannot stay pending.
    for (const resume of Array.from(pendingPolls.current.values())) resume();
    return () => {
      mountedRef.current = false;
      frameWaitRef.current?.cancel();
      frameWaitRef.current = null;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(videos.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageVideos = videos.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = inlineVideo || pageVideos.find((video) => video.id === selectedId) || pageVideos[0];
  const changePage = (next: number) => {
    stopHover();
    if (playerOpenRef.current) closePlayer();
    animateChange(() => { setPage(next); setSelectedId(''); });
    feedRef.current?.scrollTo({ top: 0 });
  };
  const activeVideo = activeMediaId ? videos.find((video) => video.id === activeMediaId) : undefined;
  return <div className={inlineVideo ? 'linkPlaybackWorkspace' : 'contentBrowser'}>
    {!inlineVideo && <section className="compactFeed" aria-label={discoveryMode ? '新增检查视频列表' : '视频列表'}>
      <div className="compactFeedHeading"><strong>{feedTitle}</strong><span>{feedNote}</span></div>
      <div className="compactFeedScroll" ref={feedRef} key={currentPage}>
        {pageVideos.map((video) => {
          const reading = videoContentReading(video.analysis);
          const job = analysisJob(video, presentation.jobs);
          const status = displayedAnalysisStatus(video, job);
          const busy = status === 'queued' || status === 'processing';
          const sourceDescription = contentSourceDescription(video);
          const author = authorsById.get(video.accountId);
          const authorName = video.authorName || author?.name || '作者未记录';
          const hasTranscript = Boolean(video.transcript?.trim());
          const hasAnalysis = reading.available || isRemotionPlan(video.analysis);
          const transcriptState = hasTranscript ? '有口播稿' : video.transcriptStatus === 'queued' ? '口播排队中'
            : video.transcriptStatus === 'processing' ? '口播识别中' : video.transcriptStatus === 'paused' ? '口播已暂停' : '无口播稿';
          const analysisState = busy ? status === 'queued' ? '分析排队中' : '分析中'
            : hasAnalysis ? '已分析' : status === 'error' ? '分析未完成' : '未分析';
          const preview = previews[video.id];
          const previewLoading = activeMediaId === video.id && preview?.status !== 'error'
            && (!mediaUrl || renderedMediaUrl !== mediaUrl);
          const enterRow = (event: React.MouseEvent<HTMLDivElement>) => {
            pointerRef.current = { x: event.clientX, y: event.clientY };
            if (window.matchMedia('(hover: hover) and (pointer: fine)').matches
              && selected?.id !== video.id) {
              setSelectedId(video.id);
            }
          };
          const enterCover = (event: React.MouseEvent<HTMLButtonElement>) => {
            pointerRef.current = { x: event.clientX, y: event.clientY };
            hoverVideo(video, event.currentTarget.querySelector<HTMLElement>('.compactCover') || event.currentTarget);
          };
          return <div className="compactVideoRow" data-selected={selected?.id === video.id} data-video-id={video.id} key={video.id}
            onMouseEnter={enterRow} onMouseMove={enterRow} onMouseLeave={stopHover}
            onFocusCapture={() => setSelectedId(video.id)} onClick={() => setSelectedId(video.id)}>
            <div className="compactVideo">
              <button type="button" className="compactCoverButton" aria-label={`播放：${video.title || '未命名视频'}`} onClick={() => openPlayer(video)}
                onMouseEnter={enterCover} onMouseMove={enterCover} onMouseLeave={stopHover}>
                <span className="compactCover">{video.coverUrl ? <img src={video.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span aria-hidden="true">▷</span>}{previewLoading && <span className="compactCoverPending">正在加载</span>}<small>{formatDuration(video.durationSeconds) || '视频'}</small></span>
              </button>
              <div className="compactVideoText">
                <div className="compactVideoAuthor">
                  <strong className="compactAuthorName" title={authorName}>{authorName}</strong>
                  <span className="compactAuthorFollowers" title={followerDetailText(author, formatTime(author?.followerCountCapturedAt || null))}>{formatFollowerLabel(author)}</span>
                </div>
                <button type="button" className="compactVideoCopy" aria-pressed={selected?.id === video.id} onClick={() => presentation.onOpen(video, reading.available ? 'content' : 'transcript', videos)}>{video.title || '未命名视频'}</button>
                {sourceDescription && <p className="compactVideoSummary">{sourceDescription}</p>}
                <div className="compactVideoFooter">
                  <div className="compactRowInfo">
                    <VideoInteractionMetrics video={video} className="compactVideoMetrics" />
                    <div className="compactVideoMeta">{formatPublishedTime(video.publishedAt)}{video.discoveredAt && <span className="compactVideoState discoveryState">发现于 {formatTime(video.discoveredAt)}</span>}</div>
                    <div className="compactVideoStatus" aria-label="口播与分析状态">
                      <span data-ready={hasTranscript}>{transcriptState}</span>
                      <span data-ready={hasAnalysis}>{analysisState}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>;
        })}
      </div>
      <div className="feedPagination" aria-label="视频分页"><button type="button" className="secondaryButton" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages}</span><button type="button" className="secondaryButton" disabled={currentPage >= pages - 1} onClick={() => changePage(currentPage + 1)}>下一页</button></div>
    </section>}
    {inlineVideo && <div className="videoPreviewPane" key={inlineVideo.id}>
      <VideoPreview video={inlineVideo} scope={videos} {...presentation} linkLayout />
    </div>}
    <div ref={playerRef} className={`siteVideoPlayer ${inlineVideo ? 'isInline' : playerId ? `isOpen${mediaAspect < 1 ? ' isPortrait' : ''}${playerDragging ? ' isDragging' : ''}${playerSize ? ' isResized' : ''}${playerResizing ? ' isResizing' : ''}` : showHover ? 'isHover' : ''}`}
      style={showHover && hoverBounds ? { top: hoverBounds.top, left: hoverBounds.left, width: hoverBounds.width, height: hoverBounds.height }
        : playerId ? { '--player-aspect': mediaAspect, ...(!inlineVideo && playerSize ? playerSize : {}), ...(playerPosition ? { left: playerPosition.x, top: playerPosition.y, right: 'auto', bottom: 'auto' } : {}) } as CSSProperties : undefined}
      aria-hidden={!activeMediaId}>
      {playerId && !inlineVideo && <div className="siteVideoHeader">
        <div className="siteVideoDragHandle" role="button" tabIndex={0} aria-label="拖动播放窗口" title="按住拖动，也可使用方向键移动"
          onPointerDown={startPlayerDrag} onPointerMove={movePlayerDrag} onPointerUp={stopPlayerDrag} onPointerCancel={stopPlayerDrag} onLostPointerCapture={() => { playerDragRef.current = null; setPlayerDragging(false); }}
          onKeyDown={(event) => {
            const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            const move = moves[event.key];
            const bounds = playerRef.current?.getBoundingClientRect();
            if (!move || !bounds) return;
            event.preventDefault();
            const step = event.shiftKey ? 32 : 12;
            setPlayerPosition(boundPlayerPosition(bounds.left + move[0] * step, bounds.top + move[1] * step));
          }}>
          <svg className="siteVideoGrip" viewBox="0 0 16 24" fill="currentColor" aria-hidden="true">{[5, 12, 19].map(y => <g key={y}><circle cx="4" cy={y} r="1.6" /><circle cx="11" cy={y} r="1.6" /></g>)}</svg>
          <strong title={activeVideo?.title}>{activeVideo?.title || '视频预览'}</strong>
        </div>
        <button className="siteVideoClose" type="button" onClick={closePlayer} aria-label="关闭视频" title="关闭视频"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg><span>关闭</span></button>
      </div>}
      <div className="siteVideoBody">
      <div className="siteVideoMediaColumn">
      <div className="siteVideoStage">
      <video key="online-preview" ref={mediaRef} src={moduleActive ? mediaUrl || undefined : undefined} poster={activeVideo?.coverUrl || undefined} crossOrigin="use-credentials" playsInline muted={!playerId || playbackMuted || renderedMediaUrl !== mediaUrl} preload={moduleActive ? 'auto' : 'none'}
        onLoadStart={(event) => {
          // The source effect can subscribe before loadstart is dispatched.
          // Keep that subscription so a fast paused first frame is not lost.
          if (frameWaitRef.current?.source !== event.currentTarget.getAttribute('src')) {
            frameWaitRef.current?.cancel();
            frameWaitRef.current = null;
          }
          presentedSourceRef.current = '';
          setRenderedMediaUrl('');
          setDecodedHoverUrl('');
          event.currentTarget.muted = true;
          requestPlayback(event.currentTarget);
        }}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          if (element.videoWidth && element.videoHeight) setMediaAspect(element.videoWidth / element.videoHeight);
          setPlayerTime({ current: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : 0 });
        }}
        onTimeUpdate={(event) => { if (moduleActive && event.currentTarget.currentTime > 0) modulePlaybackPosition.current = event.currentTarget.currentTime; setPlayerTime({ current: event.currentTarget.currentTime, duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0 }); }}
        onLoadedData={(event) => {
          // Expose the decoded hover frame so the compositor can present it;
          // audible playback still waits for the frame callback.
          if (!playerOpenRef.current && mediaUrl && event.currentTarget.currentSrc === mediaUrl && event.currentTarget.readyState >= 2) setDecodedHoverUrl(mediaUrl);
        }}
        onPlay={() => { startPlaybackRef.current = true; setPlayerPaused(false); }}
        onPause={(event) => {
          if (presentedSourceRef.current === event.currentTarget.getAttribute('src')) startPlaybackRef.current = false;
          setPlayerPaused(true);
        }} onWaiting={() => setPlayerBuffering(true)}
        onCanPlay={(event) => {
          if (playerOpenRef.current && startPlaybackRef.current) {
            requestPlayback(event.currentTarget);
          }
        }}
        onVolumeChange={(event) => { if (playerOpenRef.current) {
          // The startup gate's temporary mute is separate from user intent.
          if (presentedSourceRef.current === event.currentTarget.getAttribute('src')) setPlaybackMuted(event.currentTarget.muted);
          setPlaybackVolume(event.currentTarget.volume);
        } }}
        onPlaying={(event) => {
          setPlayError('');
          setPlayerPaused(false);
          setPlayerBuffering(false);
          if (mediaUrl && event.currentTarget.currentSrc === mediaUrl && event.currentTarget.readyState >= 2) {
            setRenderedMediaUrl(mediaUrl);
          }
        }}
        onError={(event) => {
          // Cancelling a hover and switching sources produce ordinary aborts;
          // only report a real failure while a source is actually active.
          if (!activeMediaId || !mediaUrl || event.currentTarget.currentSrc !== mediaUrl
            || !event.currentTarget.error || event.currentTarget.error.code === 1) return;
          const errorCode = event.currentTarget.error.code;
          console.warn('Video preview failed', { videoId: activeMediaId, code: errorCode });
          const video = videos.find((item) => item.id === activeMediaId);
          requestedRef.current.delete(activeMediaId);
          clearMedia();
          setPlayError('');
          // A backend restart/expired generation can invalidate a still-open
          // page. Refresh the same target once, rather than leaving it stuck.
          if (video && !mediaRetries.current.has(activeMediaId)) {
            mediaRetries.current.add(activeMediaId);
            prepareVideo(video);
            return;
          }
          setPreviews((current) => ({ ...current, [activeMediaId]: { generation: '', status: 'error' } }));
          setRenderedMediaUrl('');
          if (playerOpenRef.current) setPlayError(errorCode === 3
            ? '当前浏览器无法解码该视频，请打开原视频' : '视频加载失败，请重新打开视频');
        }} />
        {playerId && !playerError && (!mediaUrl || renderedMediaUrl !== mediaUrl || playerBuffering) && previews[playerId]?.status !== 'error' && <div className="siteVideoLoading" role="status"><span aria-hidden="true" />正在加载</div>}
      </div>
      {playerId && <div className="siteVideoToolbar">
        <div className="siteVideoTimeline"><span>{formatDuration(Math.floor(playerTime.current)) || '0:00'}</span><input aria-label="播放进度" type="range" min="0" max={playerTime.duration || 1} step="0.1" value={Math.min(playerTime.current, playerTime.duration || 0)} disabled={!playerTime.duration} onChange={(event) => { if (mediaRef.current) mediaRef.current.currentTime = Number(event.target.value); }} /><span>{formatDuration(Math.floor(playerTime.duration)) || '0:00'}</span></div>
        <div className="siteVideoControls">
          <button className="siteVideoPlay" type="button" aria-label={playerPaused ? '播放' : '暂停'} title={playerPaused ? '播放' : '暂停'} onClick={togglePlayback}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{playerPaused ? <path d="M8 5v14l11-7z" /> : <path d="M7 5h4v14H7zm6 0h4v14h-4z" />}</svg></button>
          <div className="siteVideoVolume"><button type="button" aria-label={playbackMuted || playbackVolume === 0 ? '开启声音' : '静音'} title={playbackMuted || playbackVolume === 0 ? '开启声音' : '静音'} onClick={() => { if (playbackVolume === 0) setPlaybackVolume(0.8); setPlaybackMuted(!playbackMuted && playbackVolume > 0); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" />{playbackMuted || playbackVolume === 0 ? <path d="m16 9 5 6m0-6-5 6" /> : <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>}</svg></button><input aria-label="音量" type="range" min="0" max="1" step="0.05" value={playbackMuted ? 0 : playbackVolume} onChange={(event) => { setPlaybackVolume(Number(event.target.value)); setPlaybackMuted(false); }} /></div>
          <label className="siteVideoSpeed">倍速<select value={playbackRate} onChange={(event) => setPlaybackRate(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label>
          <button className="siteVideoFullscreen" type="button" onClick={enterFullscreen} aria-label="全屏" title="全屏"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" /></svg><span>全屏</span></button>
        </div>
      </div>}
      {playerError && <p role="status">{playerError}</p>}
      </div>
      {playerId && !inlineVideo && activeVideo && <VideoPlaybackDetails video={activeVideo} />}
      </div>
      {playerId && !inlineVideo && ([['nw', '左上角'], ['ne', '右上角'], ['sw', '左下角'], ['se', '右下角']] as const).map(([corner, label]) => <div key={corner} data-corner={corner} className={`siteVideoResizeHandle ${corner}`} role="button" tabIndex={0} aria-label={`缩放播放窗口（${label}）`} title="拖动调整大小，也可使用方向键"
        onPointerDown={startPlayerResize} onPointerMove={movePlayerResize} onPointerUp={stopPlayerResize} onPointerCancel={stopPlayerResize} onLostPointerCapture={losePlayerResize} onKeyDown={keyPlayerResize} />)}
    </div>
  </div>;
}

function VideoInteractionMetrics({ video, className }: { video: Video; className?: string }) {
  const metrics = [['点赞', video.likeCount], ['评论', video.commentCount], ['收藏', video.favoriteCount], ['分享', video.shareCount]] as const;
  return <dl className={className} aria-label="视频互动数据">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatMetric(value)}</dd></div>)}</dl>;
}

function VideoPlaybackDetails({ video }: { video: Video }) {
  return <aside className="siteVideoDetails" aria-label="当前播放视频详情">
    <section className="siteVideoStats" aria-label="当前播放视频互动数据">
      <VideoInteractionMetrics video={video} />
    </section>
    <a className="siteVideoSourceLink" href={video.url} target="_blank" rel="noreferrer" aria-label="打开原视频">原视频 ↗</a>
  </aside>;
}

function VideoPreview({ video, scope, jobs, onOpen, onAnalysis, onCancel, connectorConnected, connectorBusy, linkLayout = false, onBack }: VideoPresentationProps & { video: Video; scope: Video[]; linkLayout?: boolean; onBack?: () => void }) {
  const [linkSection, setLinkSection] = useState<ReadingSection>('content');
  const linkSections: [ReadingSection, string][] = [['transcript', '口播稿'], ['content', '内容分析'], ['production', '制作规范']];
  const latestJob = analysisJob(video, jobs);
  const analysisStatus = displayedAnalysisStatus(video, latestJob);
  const busy = analysisStatus === 'queued' || analysisStatus === 'processing';
  const complete = savedSections(video);
  const reading = videoContentReading(video.analysis);
  const metrics = [['点赞', video.likeCount], ['评论', video.commentCount], ['收藏', video.favoriteCount], ['分享', video.shareCount]] as const;
  const hasPreviewContent = reading.available || Boolean(video.transcript);
  const previewStatus = busy ? analysisProgress(video, latestJob)
    : latestJob?.status === 'cancelled' ? '任务已取消'
    : analysisStatus === 'error' ? '分析未完成'
    : complete.length > 0 && complete.length < 3 ? `${complete.length}/3 个分区已生成` : '';
  return <article className={`videoPreview ${linkLayout ? 'linkPreview' : ''}`} aria-label="视频内容预览">
    {onBack && <button className="previewBack secondaryButton" type="button" onClick={onBack}>返回列表</button>}
    <h2 tabIndex={-1} title={video.title || '未命名视频'}>{video.title || '未命名视频'}</h2>
    <p className="previewMeta">{video.authorName || '作者未记录'}{formatDuration(video.durationSeconds) && ` · ${formatDuration(video.durationSeconds)}`} · {formatPublishedTime(video.publishedAt)}</p>
    <dl className="previewVideoMetrics" aria-label="视频互动数据">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatMetric(value)}</dd></div>)}</dl>
    {linkLayout ? <>
      <div className="linkResultTabs" role="tablist" aria-label="链接分析结果分区">{linkSections.map(([key, label], index) => <button key={key} type="button" role="tab" id={`link-tab-${key}`} aria-selected={linkSection === key} aria-controls="link-result-panel" tabIndex={linkSection === key ? 0 : -1} onClick={() => setLinkSection(key)} onKeyDown={(event) => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = event.key === 'Home' ? linkSections[0][0] : event.key === 'End' ? linkSections[2][0] : linkSections[(index + offset + 3) % 3][0];
        setLinkSection(next); document.getElementById(`link-tab-${next}`)?.focus();
      }}>{label}</button>)}</div>
      <div className="linkResultBody" id="link-result-panel" role="tabpanel" aria-labelledby={`link-tab-${linkSection}`}>
        {linkSection === 'transcript' ? video.transcript ? <ReadingText>{video.transcript}</ReadingText> : <p className="readingEmpty">{transcriptPendingText(video)}</p>
          : linkSection === 'content' ? reading.available ? <>
            {reading.overview && <section className="readingSummary"><h3>{reading.legacy ? '历史分析摘要' : '主要内容'}</h3><ReadingText>{reading.overview}</ReadingText></section>}
            {reading.sections.map((item) => <section className="readingSection" key={item.key}><h3>{item.label}</h3><ReadingText>{item.text}</ReadingText></section>)}
          </> : <p className="readingEmpty">{busy ? '等待内容分析结果' : '暂无内容分析'}</p>
          : isRemotionPlan(video.analysis) ? <>{REMOTION_PLAN_SECTIONS.map(([key, label]) => <section className="readingSection" key={key}><h3>{label}</h3><ReadingText>{video.analysis?.[key] || ''}</ReadingText></section>)}</> : <p className="readingEmpty">{busy ? '等待制作规范结果' : '暂无制作规范'}</p>}
      </div>
    </> : <div className="previewReading">
      <section className="previewSection"><h3>{reading.available ? '内容摘要' : !linkLayout && video.transcript ? '口播节选' : '分析状态'}</h3>
        <p className="previewExcerpt">{reading.overview || (reading.available ? '暂无摘要' : !linkLayout && video.transcript ? video.transcript : previewStatus || '尚未分析')}</p>
        {reading.sections.length > 0 && <div className="previewDetails"><h3>{reading.sections[0].label}</h3><p className="previewExcerpt">{reading.sections[0].text}</p></div>}
      </section>
    </div>}
    {(linkLayout || hasPreviewContent) && previewStatus && <div className="previewResultState" role="status">{previewStatus}</div>}
    <div className="previewActions">
      {complete.length || reading.available || busy
        ? <button type="button" className="primaryButton" onClick={() => onOpen(video, linkLayout ? linkSection : 'content', scope)}>{complete.length || reading.available ? '展开完整结果' : '查看进度'}</button>
        : <button type="button" className="primaryButton" onClick={() => onAnalysis({ ...video, analysisStatus }, analysisStatus === 'error')}>{analysisStatus === 'error' ? '重试分析' : '分析此视频'}</button>}
      {busy && latestJob && <button type="button" className="secondaryButton" onClick={() => onCancel(latestJob)}>取消任务</button>}
      <a href={video.url} target="_blank" rel="noreferrer">打开原视频 ↗</a>
    </div>
    {!linkLayout && (complete.length > 0 || reading.available) && <div className="previewSections" aria-label="直接阅读结果分区"><button type="button" onClick={() => onOpen(video, 'transcript', scope)}>口播稿</button><button type="button" onClick={() => onOpen(video, 'content', scope)}>内容分析</button><button type="button" onClick={() => onOpen(video, 'production', scope)}>制作规范</button></div>}
    {busy && !connectorConnected && <p className="rowTaskMessage">采集服务未连接</p>}
    {busy && connectorConnected && connectorBusy && analysisStatus === 'queued' && <p className="rowTaskMessage">等待主机空闲</p>}
    {analysisStatus === 'error' && latestJob?.status !== 'cancelled' && <p className="rowTaskMessage analysisError">{redactDiagnosticText(video.analysisDiagnostics?.lastError || latestJob?.error || video.analysisError || '任务未完成，详细原因尚未记录')}<button type="button" onClick={() => onOpen(video, 'content', scope)}>查看诊断</button></p>}
    <VideoRecordDetails video={video} analysisStatus={analysisStatus} />
  </article>;
}

function VideoRecordDetails({ video, analysisStatus }: { video: Video; analysisStatus: AnalysisStatus }) {
  const latestRun = video.analysisRuns[0] || null;
  const latestUsage = video.analysisUsage || latestRun?.usage || null;
  const previousRuns = video.analysisRuns.slice(1);
  return <>
    <details className="previewMetadata"><summary>采集信息</summary><p>首次采集：{formatTime(video.firstSeenAt)}<br />最近采集：{formatTime(video.lastSeenAt)}</p></details>
        {(video.analysis || latestRun || latestUsage) && <details className="analysisCosts">
          <summary><span>用量与费用</span><strong>{analysisUsageSummary(latestUsage, analysisStatus)}</strong></summary>
          <div className="analysisPane usagePane">
            {latestUsage && <section className="analysisUsage" aria-label="最近一次 AI 分析用量与费用">
              <div className="analysisUsageHeader"><b>本次消耗</b>{latestRun?.updatedAt && <small>{formatTime(latestRun.updatedAt)}</small>}</div>
              <div className="analysisUsageGrid">
                <span><small>视频模型请求</small><b>{analysisRequestCountLabel(latestUsage)}</b></span>
                <span><small>模型</small><b>{latestUsage.model}</b></span>
                <span><small>输入 Token</small><b>{formatTokenCount(latestUsage.promptTokens)}</b></span>
                <span><small>输出 Token</small><b>{formatTokenCount(latestUsage.completionTokens)}</b></span>
                <span><small>视频模型总 Token</small><b>{formatTokenCount(latestUsage.totalTokens)}</b></span>
                <span><small>{latestUsage.provider === 'CodeBuddy' ? '视频分析积分' : latestUsage.cloudAsr ? '视频分析估算' : '官方原价估算'}</small><b>{latestUsage.provider === 'CodeBuddy' ? formatAnalysisCost({ ...latestUsage, cloudAsr: null }) : formatEstimatedCost(latestUsage.estimatedCostCny)}</b></span>
                {latestUsage.cloudAsr && <>
                  <span><small>云端口播时长</small><b>{formatCloudAudioSeconds(latestUsage.cloudAsr.audioSeconds)}</b></span>
                  <span><small>云端口播估算</small><b>{formatEstimatedCost(latestUsage.cloudAsr.estimatedCostCny)}</b></span>
                  {latestUsage.provider !== 'CodeBuddy' && <span><small>含口播合计估算</small><b>{formatEstimatedCost(latestUsage.totalEstimatedCostCny)}</b></span>}
                </>}
              </div>
              {latestUsage.requestIds.length > 0 && <p className="analysisRequestIds" title={latestUsage.requestIds.join('\n')}>请求 ID：{latestUsage.requestIds.join('、')}</p>}
            </section>}
            {!latestUsage && latestRun && <p className="analysisUsageUnavailable">{['queued', 'claimed', 'running'].includes(latestRun.status)
              ? '本次分析未结束，暂未返回用量。'
              : latestRun.status === 'succeeded'
                ? '历史用量未记录。'
                : '本次用量未记录。'}</p>}
            {!latestRun && video.analysis && !latestUsage && <p className="analysisUsageUnavailable">历史用量未记录。</p>}
            {(video.analysis || latestRun || latestUsage) && <a className="analysisBillingLink" href={latestUsage?.provider === 'CodeBuddy' ? 'https://www.codebuddy.cn/profile/plans-usage' : 'https://bailian.console.aliyun.com/?tab=costing-balance'} target="_blank" rel="noreferrer">查看{latestUsage?.provider === 'CodeBuddy' ? 'CodeBuddy' : '百炼'}用量 ↗</a>}
            {previousRuns.length > 0 && <section className="analysisRunHistory" aria-label="历史 AI 分析费用记录">
              <div className="analysisUsageHeader"><b>历次分析记录</b></div>
              <div className="analysisRunList">{previousRuns.map((run) => <div className="analysisRunItem" key={run.id}>
                <span><b>{formatTime(run.createdAt || run.updatedAt)}</b><small>{analysisRunStatusLabel(run.status)}</small></span>
                {run.usage
                  ? <span><b>{formatAnalysisCost(run.usage)} · {formatTokenCount(run.usage.totalTokens)} Token{run.usage.cloudAsr && run.usage.provider !== 'CodeBuddy' ? '（含云端口播）' : ''}</b><small>输入 {formatTokenCount(run.usage.promptTokens)} / 输出 {formatTokenCount(run.usage.completionTokens)} Token{run.usage.cloudAsr ? ` · 云端口播 ${formatCloudAudioSeconds(run.usage.cloudAsr.audioSeconds)} / ${formatEstimatedCost(run.usage.cloudAsr.estimatedCostCny)}` : ''}</small></span>
                  : <span><b>无用量记录</b></span>}
              </div>)}</div>
            </section>}
            <p className="analysisUsageNote">{latestUsage?.billingNote || '费用为估算，以实际账单为准。'}</p>
          </div>
        </details>}
  </>;
}

function closeOverlay(close: () => void) {
  const overlay = document.querySelector<HTMLElement>('.modalBackdrop');
  if (!overlay || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { close(); return; }
  if (overlay.classList.contains('isClosing')) return;
  overlay.classList.add('isClosing');
  window.setTimeout(close, 200);
}

// Animate live surfaces instead of whole-page snapshots, which lift scrolled
// content above sticky controls. Cancel old motion when another selection arrives.
const workspaceAnimations = new Set<Animation>();
function animateChange(change: () => void) {
  for (const animation of workspaceAnimations) animation.cancel();
  workspaceAnimations.clear();
  if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    change();
    return;
  }
  const selectors = ['.navItem.active', '.railAccount[aria-pressed="true"], .railLink[aria-pressed="true"]'];
  const before = selectors.map((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    return { element, rect: element?.getBoundingClientRect() };
  });
  flushSync(change);
  const track = (animation: Animation) => {
    workspaceAnimations.add(animation);
    void animation.finished.catch(() => undefined).finally(() => workspaceAnimations.delete(animation));
  };
  selectors.forEach((selector, index) => {
    const element = document.querySelector<HTMLElement>(selector);
    const previous = before[index];
    if (!element || element === previous.element || !previous.rect?.width) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    track(element.animate([
      { transformOrigin: '0 0', transform: `translate(${previous.rect.x - rect.x}px, ${previous.rect.y - rect.y}px) scale(${previous.rect.width / rect.width}, ${previous.rect.height / rect.height})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { pseudoElement: '::before', duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' }));
  });
  const content = document.querySelector<HTMLElement>('.workspace > .homeFeed, .workspace > .workspacePage');
  if (content) track(content.animate([
    { opacity: .35, transform: 'translateY(16px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' }));
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

function VideoReader({ active, video, jobs, initialSection, index, total, onClose, onNavigate, onAnalysis, onTranscribe, onCancel }: {
  active: boolean; video: Video; jobs: HostJob[]; initialSection: ReadingSection; index: number; total: number;
  onClose: () => void; onNavigate: (offset: number) => void;
  onAnalysis: (video: Video, regenerate?: boolean, forceRegenerate?: boolean) => void; onCancel: (job: HostJob) => void;
  onTranscribe: (video: Video) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const previousContent = useRef('');
  const [section, setSection] = useState<ReadingSection>(initialSection);
  const [fontSize, setFontSize] = useState<18 | 20 | 22>(20);
  const [closing, setClosing] = useState(false);
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
  const tabLabels: Record<ReadingSection, string> = { transcript: '口播稿', content: '内容分析', production: '制作规范' };
  useEffect(() => {
    const element = dialog.current;
    if (!active) { element?.close(); return; }
    const scheduledTimers = timers.current;
    const origin = document.activeElement as HTMLElement | null;
    const scrollY = window.scrollY;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.show(); closeButton.current?.focus({ preventScroll: true });
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
  }, [active]);
  useEffect(() => {
    const key = `${video.id}:${section}`;
    const changed = previousContent.current && previousContent.current !== key;
    previousContent.current = key;
    if (!changed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = dialog.current?.querySelector('#reader-panel')?.animate([
      { transform: 'translateY(4px)' },
      { transform: 'none' },
    ], { duration: 120, easing: 'cubic-bezier(.2,.8,.2,1)' });
    return () => animation?.cancel();
  }, [video.id, section]);
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    timers.current.push(setTimeout(onClose, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120));
  };
  const changeContent = (update: () => void) => {
    setCopyMessage('');
    update();
    scroller.current?.scrollTo({ top: 0, behavior: 'instant' });
  };
  const copy = (text: string) => { void copyReadingText(text).then(() => setCopyMessage('已复制')).catch((error: Error) => setCopyMessage(error.message)); };
  const changeTab = (next: ReadingSection) => {
    changeContent(() => setSection(next));
  };
  return <dialog ref={dialog} className={`readingDialog ${closing ? 'isClosing' : ''}`} aria-labelledby="reader-title" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); requestClose(); } }} onCancel={(event) => { event.preventDefault(); requestClose(); }} onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <div className="readerCloseBar">
      <header className="readerHeader"><h2 id="reader-title" title={video.title}>{video.title}</h2><div className="readerMetadata"><span>{formatPublishedTime(video.publishedAt)}</span><a href={video.url} target="_blank" rel="noreferrer">打开原视频 ↗</a></div>
      </header>
      <div className="readerNavigation"><button className="secondaryButton" type="button" aria-label="上一条" disabled={index <= 0} onClick={() => changeContent(() => onNavigate(-1))}>←</button><span className="readerPosition">{index + 1} / {total}</span><button className="secondaryButton" type="button" aria-label="下一条" disabled={index >= total - 1} onClick={() => changeContent(() => onNavigate(1))}>→</button></div><button ref={closeButton} type="button" className="readerClose" onClick={requestClose} aria-label="关闭阅读，返回列表">关闭 <span aria-hidden="true">×</span></button>
    </div>
    <div className="readerControls">
      <div className="readerTabs" role="tablist" aria-label="分析结果分区">{(['transcript', 'content', 'production'] as const).map((key) => <button key={key} id={`reader-tab-${key}`} type="button" role="tab" aria-selected={section === key} aria-controls="reader-panel" tabIndex={section === key ? 0 : -1} onClick={() => changeTab(key)} onKeyDown={(event) => {
        const keys: ReadingSection[] = ['transcript', 'content', 'production'];
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[2] : keys[(keys.indexOf(key) + offset + 3) % 3];
        changeTab(next); document.getElementById(`reader-tab-${next}`)?.focus();
      }}>{tabLabels[key]}</button>)}</div>
      <div className="readerToolbar"><label className="readingFontControl">字号<select value={fontSize} onChange={(event) => setFontSize(Number(event.target.value) as 18 | 20 | 22)}>{([18, 20, 22] as const).map((size) => <option key={size} value={size}>{size}</option>)}</select></label><div className="readerExport"><button className="secondaryButton" type="button" title={`复制${labels[section]}`} disabled={!sectionText} onClick={() => copy(sectionText)}>复制</button><button className="secondaryButton" type="button" title="下载 Markdown 文件" disabled={!sectionText} onClick={() => downloadReading(sectionText, `${section}-${video.id}.md`)}>下载</button></div>{copyMessage && <span role="status" className="readerCopyStatus">{copyMessage}</span>}</div>
    </div>
    <div ref={scroller} className="readerScroll" style={{ '--reading-size': `${fontSize}px` } as CSSProperties}>
      {busy && <div className="readerTask" role="status"><p>{analysisProgress(video, latestJob)}</p>{latestJob && <button type="button" className="secondaryButton" onClick={() => onCancel(latestJob)}>取消任务</button>}</div>}
      {latestJob?.status === 'cancelled' && <p className="readerTask">任务已取消</p>}
      {failed && <section className="readerFailure" aria-label="任务诊断"><h3>本次分析未完成</h3><p>失败阶段：{ANALYSIS_STAGE_LABELS[diagnostics.failedStage || ''] || diagnostics.failedStage || '尚未记录'}{Number.isFinite(diagnostics.attemptCount) ? ` · 实际尝试 ${diagnostics.attemptCount} 次` : ' · 尝试次数未记录'}</p><p>最后错误：{redactDiagnosticText(diagnostics.lastError || latestJob?.error || video.analysisError || '没有详细记录，根因尚未确定')}</p><p>已保存并保留：{complete.join('、') || '暂无已生成结果'}</p>{diagnostics.userAction && <p>{redactDiagnosticText(diagnostics.userAction)}</p>}<button type="button" className="secondaryButton" onClick={() => copy(formatAnalysisDiagnostics({ ...diagnostics, jobId: diagnostics.jobId || latestJob?.id, videoId: video.id, lastError: diagnostics.lastError || latestJob?.error || video.analysisError || '' }))}>复制诊断信息</button></section>}
      <div id="reader-panel" key={`${video.id}:${section}`} role="tabpanel" tabIndex={0} aria-labelledby={`reader-tab-${section}`} className="readerBody">
        {section === 'transcript' ? video.transcript ? <ReadingText>{video.transcript}</ReadingText> : <><p className="readingEmpty">{transcriptPendingText(video)}</p>{['idle', 'error', 'paused'].includes(video.transcriptStatus) && <button type="button" className="secondaryButton" onClick={() => onTranscribe(video)}>{video.transcriptStatus === 'paused' ? '继续这条口播识别' : video.transcriptStatus === 'error' ? '重试口播识别' : '提取口播稿'}</button>}</> : section === 'content' ? reading.available ? <>
          {reading.overview && <section className="readingSummary"><h3>{reading.legacy ? '历史分析摘要' : '主要内容'}</h3><ReadingText>{reading.overview}</ReadingText></section>}
          {reading.sections.map((item) => <section className="readingSection" key={item.key}><h3>{item.label}</h3><ReadingText>{item.text}</ReadingText></section>)}
        </> : <><p className="readingEmpty">尚未分析</p>{video.description && video.description.trim() !== video.title.trim() && <section className="readingSection"><h3>原视频文案</h3><ReadingText>{video.description}</ReadingText></section>}</> : isRemotionPlan(video.analysis) ? <>{REMOTION_PLAN_SECTIONS.map(([key, label]) => <section className="readingSection" key={key}><h3>{label}</h3><ReadingText>{video.analysis?.[key] || ''}</ReadingText></section>)}</> : <p className="readingEmpty">暂无制作规范</p>}
        {!busy && complete.length < 3 && <div className="readerGenerate"><button className="primaryButton" type="button" onClick={() => onAnalysis({ ...video, analysisStatus }, Boolean(video.analysis) || analysisStatus === 'error')}>{complete.length ? '补全缺失分析' : '分析'}</button><span>可能产生云端费用</span></div>}
        {!busy && complete.length === 3 && <details className="readerMore"><summary>重新分析</summary><button type="button" className="secondaryButton" onClick={() => { if (window.confirm('重新分析会再次调用付费视频模型，已有口播稿直接复用。确定继续吗？')) onAnalysis({ ...video, analysisStatus }, true, true); }}>重新分析内容与制作规范（会产生费用）</button></details>}
      </div>
      <div className="readerRecordDetails"><VideoRecordDetails video={video} analysisStatus={analysisStatus} /></div>
    </div>
  </dialog>;
}

function EmptyData({ title, detail }: { title: string; detail?: string }) {
  return <section className="emptyBoard compact"><div className="emptySymbol">·</div><h3>{title}</h3>{detail && <p>{detail}</p>}</section>;
}
