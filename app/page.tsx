'use client';

/* eslint-disable @next/next/no-img-element -- 抖音封面是运行时采集的外部地址，不能预先配置图片域名。 */

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type AccountStatus = 'waiting' | 'checking' | 'ready' | 'error';
type TranscriptStatus = 'idle' | 'processing' | 'ready' | 'error';

type Account = {
  id: string;
  url: string;
  name: string;
  addedAt: string;
  lastCheckedAt: string | null;
  status: AccountStatus;
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
  playCount: number | null;
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
  videoId: string;
  playCount: number | null;
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
  accountName?: string;
  capturedAt?: string;
  videos?: Array<Partial<Video> & Pick<Video, 'id' | 'accountId' | 'url'>>;
  warning?: string;
};

const navItems = [
  ['⌂', '主页仪表盘'],
  ['◎', '对标账号'],
  ['▣', '视频数据'],
];

const accountStoreKey = 'douyin-monitor.accounts.v1';
const videoStoreKey = 'douyin-monitor.videos.v1';
const snapshotStoreKey = 'douyin-monitor.snapshots.v2';
const processedResultStoreKey = 'douyin-monitor.processed-results.v1';
const requiredExtensionVersion = '0.2.0';

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
    playCount: nullableNumber(raw.playCount),
    likeCount: nullableNumber(raw.likeCount),
    commentCount: nullableNumber(raw.commentCount),
    favoriteCount: nullableNumber(raw.favoriteCount),
    shareCount: nullableNumber(raw.shareCount),
    capturedAt: seenAt,
    firstSeenAt: raw.firstSeenAt || seenAt,
    lastSeenAt: raw.lastSeenAt || seenAt,
    transcript: previousTranscript,
    transcriptStatus: previousTranscript ? 'ready' : (raw.transcriptStatus || 'idle'),
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

export default function Home() {
  const [activeNav, setActiveNav] = useState('主页仪表盘');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accountUrl, setAccountUrl] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null);
  const [bridgeNeedsReload, setBridgeNeedsReload] = useState(false);
  const [progress, setProgress] = useState(0);
  const [expandedTranscripts, setExpandedTranscripts] = useState<Set<string>>(new Set());
  const processedResultIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    processedResultIds.current = new Set(readStored<string[]>(processedResultStoreKey, []));
    const frame = window.requestAnimationFrame(() => {
      setAccounts(readStored<Account[]>(accountStoreKey, []));
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
        setAccounts((current) => current.map((account) => account.id === payload.accountId ? { ...account, status: 'error' } : account));
        setNotice('采集失败：页面没有返回任何可用视频，未写入空结果');
        if (eventId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', eventIds: [eventId] }, window.location.origin);
        return;
      }

      setVideos((current) => {
        const byId = new Map(current.map((video) => [video.id, video]));
        for (const incoming of collected) {
          const previous = byId.get(incoming.id);
          byId.set(incoming.id, {
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
      setSnapshots((current) => [...current, ...collected.map((video) => ({
        videoId: video.id,
        playCount: video.playCount,
        likeCount: video.likeCount,
        commentCount: video.commentCount,
        favoriteCount: video.favoriteCount,
        shareCount: video.shareCount,
        capturedAt,
      }))]);
      setAccounts((current) => current.map((account) => payload.accountId === account.id ? {
        ...account,
        name: payload.accountName || account.name,
        lastCheckedAt: capturedAt,
        status: 'ready',
      } : account));
      setProgress(100);
      setActiveNav('视频数据');
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

    const handshakeTimer = window.setTimeout(() => setBridgeNeedsReload(true), 1800);
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data?.source !== 'douyin-monitor-extension') return;
      if (event.data.type === 'BRIDGE_READY') {
        setBridgeReady(true);
        if (event.data.extensionVersion) {
          setBridgeVersion(event.data.extensionVersion);
          setBridgeNeedsReload(event.data.extensionVersion !== requiredExtensionVersion);
          window.clearTimeout(handshakeTimer);
        }
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
        setAccounts((current) => current.map((account) => account.id === event.data.accountId ? { ...account, status: 'checking' } : account));
        if (event.data.accountName) setNotice(`正在检查：${event.data.accountName}`);
      }
      if (event.data.type === 'COLLECTION_PROGRESS') setProgress(event.data.progress ?? 0);
      if (event.data.type === 'COLLECTION_ERROR') {
        setAccounts((current) => current.map((account) => account.id === event.data.accountId ? { ...account, status: 'error' } : account));
        setNotice(event.data.message ?? '采集失败，请稍后重试');
        if (event.data.messageId) window.postMessage({ source: 'douyin-monitor', type: 'ACK_RESULTS', messageIds: [event.data.messageId] }, window.location.origin);
      }
      if (event.data.type === 'COLLECTION_RESULT') applyCollectionResult(event.data);
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
  const pendingTranscripts = videos.filter((video) => video.transcriptStatus !== 'ready').length;
  const completedTranscripts = videos.filter((video) => video.transcriptStatus === 'ready').length;
  const lastChecked = accounts
    .map((account) => account.lastCheckedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

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
        url: value,
        name: `待识别账号 ${accounts.length + 1}`,
        addedAt: new Date().toISOString(),
        lastCheckedAt: null,
        status: 'waiting',
      };
      setAccounts((current) => [...current, account]);
      setAccountUrl('');
      setShowAddAccount(false);
      setNotice('账号已加入，可以立即检查');
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
    setAccounts((current) => current.map((account) => ({ ...account, status: 'checking' })));
    setProgress(2);
    window.postMessage({ source: 'douyin-monitor', type: 'CHECK_ALL', accounts }, window.location.origin);
    setNotice('已开始检查，Chrome 正在读取真实视频数据');
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
    setAccounts((current) => current.filter((account) => account.id !== id));
    setVideos((current) => current.filter((video) => video.accountId !== id));
    setSnapshots((current) => current.filter((snapshot) => !removedVideoIds.has(snapshot.videoId)));
    setNotice('账号及其本地记录已移除');
  };

  const statCards = [
    ['监控账号', accounts.length, accounts.length ? '账号数量不设上限' : '等待添加对标账号'],
    ['收录视频', videos.length, lastChecked ? `${snapshots.length} 份快照 · ${formatTime(lastChecked)}` : '尚未开始首次检查'],
    ['今日新增', todayVideos, '今日首次收录的视频'],
    ['待转写', pendingTranscripts, `${completedTranscripts} 条已完成本地识别`],
  ];

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">抖</span>
          <div><strong>对标工作台</strong><small>本地数据监控</small></div>
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
        <header className="topbar">
          <div>
            <p className="eyebrow">DOUYIN INTELLIGENCE</p>
            <h1>{activeNav}</h1>
            <p className="subtitle">每 6 小时检查一次公开作品与互动数据</p>
          </div>
          <div className="topActions">
            <div className="nextRun"><span>检查周期</span><b>每 6 小时</b></div>
            <button className="secondaryButton" onClick={requestCheck}>立即检查</button>
            <button className="primaryButton" onClick={() => setShowAddAccount(true)}>＋ 添加账号</button>
          </div>
        </header>

        {activeNav === '主页仪表盘' && (
          <>
            <div className="statsGrid">
              {statCards.map(([label, value, detail]) => (
                <article className="statCard" key={String(label)}>
                  <div className="statLabel"><span>{label}</span><i /></div>
                  <strong>{value}</strong><small>{detail}</small>
                </article>
              ))}
            </div>
            <article className="collectionPanel">
              <div className="collectionHeader">
                <div><p className="liveLabel"><i /> LOCAL COLLECTION</p><h2>采集任务</h2><span>{bridgeNeedsReload ? `请先将 Chrome 组件刷新到 v${requiredExtensionVersion}` : bridgeReady ? 'Chrome 已连接，可读取真实视频详情' : accounts.length ? '等待 Chrome 采集组件连接' : '添加账号后，系统将按顺序检查最新作品'}</span></div>
                <div className="progressValue"><span>PROGRESS</span><b>{progress}%</b></div>
              </div>
              <div className="progressTrack"><span style={{ width: `${Math.max(progress, 2)}%` }} /></div>
              <div className="progressMarks"><span>等待开始</span><span>检查账号</span><span>读取视频详情</span><span>完成</span></div>
            </article>
            <SectionHeading label="MONITOR BOARD" title="账号监控" count={`${accounts.length} 个账号`} />
            <AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} />
          </>
        )}

        {activeNav === '对标账号' && (
          <><SectionHeading label="ACCOUNT LIST" title="全部对标账号" count={`${accounts.length} 个账号`} /><AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} /></>
        )}

        {activeNav === '视频数据' && (
          <><SectionHeading label="VIDEO SNAPSHOTS" title="视频与数据快照" count={`${videos.length} 条视频`} /><VideoTable videos={videos} expandedTranscripts={expandedTranscripts} onTranscript={requestTranscript} /></>
        )}
      </section>

      {showAddAccount && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setShowAddAccount(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title" onSubmit={submitAccount} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" aria-label="关闭" onClick={() => setShowAddAccount(false)}>×</button>
            <p className="eyebrow">NEW MONITOR</p><h2 id="add-account-title">添加对标账号</h2>
            <p>输入公开的抖音账号主页链接。系统通过本机已登录的 Chrome 访问。</p>
            <label htmlFor="account-url">账号主页链接</label>
            <input id="account-url" type="url" value={accountUrl} onChange={(event) => setAccountUrl(event.target.value)} placeholder="https://www.douyin.com/user/..." autoFocus />
            <div className="modalNote"><i /> 账号密码与 Chrome 登录信息不会保存到本系统。</div>
            <div className="modalActions"><button className="secondaryButton" type="button" onClick={() => setShowAddAccount(false)}>取消</button><button className="primaryButton" type="submit">添加账号</button></div>
          </form>
        </div>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}

function SectionHeading({ label, title, count }: { label: string; title: string; count: string }) {
  return <div className="sectionHeading"><div><p className="eyebrow">{label}</p><h2>{title}</h2></div><span>{count}</span></div>;
}

const accountStatusLabels: Record<AccountStatus, string> = {
  waiting: '等待检查',
  checking: '正在采集',
  ready: '采集正常',
  error: '采集失败',
};

function AccountBoard({ accounts, onAdd, onRemove }: { accounts: Account[]; onAdd: () => void; onRemove: (id: string) => void }) {
  if (!accounts.length) {
    return <section className="emptyBoard"><div className="emptySymbol">＋</div><h3>添加第一个对标账号</h3><p>粘贴抖音账号主页链接，之后会自动记录最新视频和五项互动数据的变化。</p><button className="primaryButton" onClick={onAdd}>添加抖音账号</button><small>不保存完整视频 · 不采集评论正文</small></section>;
  }
  return <section className="accountGrid">{accounts.map((account, index) => (
    <article className="accountCard" key={account.id}>
      <div className="accountTop"><div className="accountAvatar">{index + 1}</div><span className={`statusPill ${account.status}`}>{accountStatusLabels[account.status]}</span></div>
      <h3>{account.name}</h3><a href={account.url} target="_blank" rel="noreferrer">打开原账号主页 ↗</a>
      <div className="accountMeta"><span><small>最近检查</small><b>{account.lastCheckedAt ? formatTime(account.lastCheckedAt) : '尚未检查'}</b></span><span><small>采集周期</small><b>每 6 小时</b></span></div>
      <button className="dangerLink" onClick={() => onRemove(account.id)}>移除账号</button>
    </article>
  ))}</section>;
}

function VideoTable({ videos, expandedTranscripts, onTranscript }: {
  videos: Video[];
  expandedTranscripts: Set<string>;
  onTranscript: (video: Video, force?: boolean) => void;
}) {
  if (!videos.length) return <EmptyData title="还没有视频数据" detail="检查成功后，这里会显示封面、视频文案、播放、点赞、评论、收藏、分享和原视频链接。空结果不会再被当作成功。" />;
  return <div className="videoTableScroll"><div className="videoTable">
    <div className="videoTableHead"><span>视频与文案</span><span>数据快照</span><span>时间</span><span>操作</span></div>
    {videos.map((video) => {
      const duration = formatDuration(video.durationSeconds);
      const expanded = expandedTranscripts.has(video.id);
      const metrics = [
        ['播放', video.playCount],
        ['点赞', video.likeCount],
        ['评论', video.commentCount],
        ['收藏', video.favoriteCount],
        ['分享', video.shareCount],
      ] as const;
      return <article className="videoRecord" key={video.id}>
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
