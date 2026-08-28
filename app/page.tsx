'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

type Account = {
  id: string;
  url: string;
  name: string;
  addedAt: string;
  lastCheckedAt: string | null;
  status: 'waiting' | 'checking' | 'ready' | 'error';
};

type Video = {
  id: string;
  accountId: string;
  title: string;
  description: string;
  url: string;
  publishedAt: string;
  playCount: number | null;
  likeCount: number;
  commentCount: number;
  capturedAt: string;
  transcript: string | null;
};

type Snapshot = {
  videoId: string;
  playCount: number | null;
  likeCount: number;
  commentCount: number;
  capturedAt: string;
};

const navItems = [
  ['⌂', '主页仪表盘'],
  ['◎', '对标账号'],
  ['▣', '视频数据'],
  ['Aa', '口播稿'],
];

const accountStoreKey = 'douyin-monitor.accounts.v1';
const videoStoreKey = 'douyin-monitor.videos.v1';
const snapshotStoreKey = 'douyin-monitor.snapshots.v1';

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function formatTime(value: string | null) {
  if (!value) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
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
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setAccounts(readStored<Account[]>(accountStoreKey, []));
      setVideos(readStored<Video[]>(videoStoreKey, []));
      setSnapshots(readStored<Snapshot[]>(snapshotStoreKey, []));
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
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data?.source !== 'douyin-monitor-extension') return;
      if (event.data.type === 'BRIDGE_READY') setBridgeReady(true);
      if (event.data.type === 'COLLECTION_PROGRESS') setProgress(event.data.progress ?? 0);
      if (event.data.type === 'COLLECTION_ERROR') setNotice(event.data.message ?? '采集失败，请稍后重试');
      if (event.data.type === 'COLLECTION_RESULT') {
        const capturedAt = event.data.capturedAt ?? new Date().toISOString();
        const collected = (event.data.videos ?? []) as Array<Video & { accountName?: string }>;
        setVideos((current) => {
          const byId = new Map(current.map((video) => [video.id, video]));
          for (const video of collected) byId.set(video.id, { ...byId.get(video.id), ...video, capturedAt, transcript: byId.get(video.id)?.transcript ?? null });
          return [...byId.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
        });
        setSnapshots((current) => [...current, ...collected.map((video) => ({ videoId: video.id, playCount: video.playCount, likeCount: video.likeCount, commentCount: video.commentCount, capturedAt }))]);
        setAccounts((current) => current.map((account) => event.data.accountId === account.id ? { ...account, name: event.data.accountName || account.name, lastCheckedAt: capturedAt, status: 'ready' } : account));
        setProgress(100);
        setNotice(`采集完成，收到 ${collected.length} 条视频数据`);
      }
    };
    window.addEventListener('message', receive);
    window.postMessage({ source: 'douyin-monitor', type: 'PING' }, window.location.origin);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const todayStart = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }, []);

  const todayVideos = videos.filter((video) => new Date(video.capturedAt).getTime() >= todayStart).length;
  const pendingTranscripts = videos.filter((video) => !video.transcript).length;
  const completedTranscripts = videos.filter((video) => video.transcript).length;
  const lastChecked = accounts
    .map((account) => account.lastCheckedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  const submitAccount = (event: FormEvent) => {
    event.preventDefault();
    const value = accountUrl.trim();
    try {
      const parsed = new URL(value);
      if (!parsed.hostname.endsWith('douyin.com') || !parsed.pathname.includes('/user/')) {
        throw new Error('invalid');
      }
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
      setNotice('账号已加入，等待连接 Chrome 后首次检查');
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
      setNotice('Chrome 采集组件尚未连接，请先加载项目中的浏览器组件');
      return;
    }
    setProgress(2);
    window.postMessage({ source: 'douyin-monitor', type: 'CHECK_ALL', accounts }, window.location.origin);
    setNotice('已发送检查请求，Chrome 正在按顺序采集');
  };

  const removeAccount = (id: string) => {
    setAccounts((current) => current.filter((account) => account.id !== id));
    setVideos((current) => current.filter((video) => video.accountId !== id));
    setNotice('账号及其本地记录已移除');
  };

  const statCards = [
    ['监控账号', accounts.length, accounts.length ? '账号数量不设上限' : '等待添加对标账号'],
    ['收录视频', videos.length, lastChecked ? `${snapshots.length} 份快照 · ${formatTime(lastChecked)}` : '尚未开始首次检查'],
    ['今日新增', todayVideos, '最近 24 小时采集'],
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
          <div className={bridgeReady ? 'localStatus connected' : 'localStatus'}><i /><span><b>数据仅存本机</b><small>{bridgeReady ? 'Chrome 已连接' : 'Chrome 等待连接'}</small></span></div>
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
                <div><p className="liveLabel"><i /> LOCAL COLLECTION</p><h2>采集任务</h2><span>{bridgeReady ? 'Chrome 已连接，可按顺序检查最新作品' : accounts.length ? '等待 Chrome 采集组件连接' : '添加账号后，系统将按顺序检查最新作品'}</span></div>
                <div className="progressValue"><span>PROGRESS</span><b>{progress}%</b></div>
              </div>
              <div className="progressTrack"><span style={{ width: `${Math.max(progress, 2)}%` }} /></div>
              <div className="progressMarks"><span>等待开始</span><span>检查账号</span><span>生成数据快照</span><span>完成</span></div>
            </article>
            <SectionHeading label="MONITOR BOARD" title="账号监控" count={`${accounts.length} 个账号`} />
            <AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} />
          </>
        )}

        {activeNav === '对标账号' && (
          <><SectionHeading label="ACCOUNT LIST" title="全部对标账号" count={`${accounts.length} 个账号`} /><AccountBoard accounts={accounts} onAdd={() => setShowAddAccount(true)} onRemove={removeAccount} /></>
        )}

        {activeNav === '视频数据' && (
          <><SectionHeading label="VIDEO SNAPSHOTS" title="视频与数据快照" count={`${videos.length} 条视频`} /><VideoTable videos={videos} /></>
        )}

        {activeNav === '口播稿' && (
          <><SectionHeading label="LOCAL TRANSCRIPTS" title="本地口播稿" count={`${completedTranscripts} 条完成`} /><TranscriptBoard videos={videos} /></>
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

function AccountBoard({ accounts, onAdd, onRemove }: { accounts: Account[]; onAdd: () => void; onRemove: (id: string) => void }) {
  if (!accounts.length) {
    return <section className="emptyBoard"><div className="emptySymbol">＋</div><h3>添加第一个对标账号</h3><p>粘贴抖音账号主页链接，之后会自动记录最新视频和数据变化。</p><button className="primaryButton" onClick={onAdd}>添加抖音账号</button><small>不保存完整视频 · 不采集评论正文</small></section>;
  }
  return <section className="accountGrid">{accounts.map((account, index) => (
    <article className="accountCard" key={account.id}>
      <div className="accountTop"><div className="accountAvatar">{index + 1}</div><span className="statusPill">等待检查</span></div>
      <h3>{account.name}</h3><a href={account.url} target="_blank" rel="noreferrer">打开原账号主页 ↗</a>
      <div className="accountMeta"><span><small>最近检查</small><b>{formatTime(account.lastCheckedAt)}</b></span><span><small>采集周期</small><b>每 6 小时</b></span></div>
      <button className="dangerLink" onClick={() => onRemove(account.id)}>移除账号</button>
    </article>
  ))}</section>;
}

function VideoTable({ videos }: { videos: Video[] }) {
  if (!videos.length) return <EmptyData title="还没有视频数据" detail="首次检查完成后，这里会显示标题、正文、播放量、点赞量、评论量和原视频链接。" />;
  return <div className="dataTable"><div className="tableRow tableHead"><span>视频</span><span>播放</span><span>点赞</span><span>评论</span><span>采集时间</span></div>{videos.map((video) => <div className="tableRow" key={video.id}><span><a href={video.url} target="_blank" rel="noreferrer">{video.title || '未命名视频'} ↗</a><small>{video.description}</small></span><b>{video.playCount ?? '—'}</b><b>{video.likeCount}</b><b>{video.commentCount}</b><time>{formatTime(video.capturedAt)}</time></div>)}</div>;
}

function TranscriptBoard({ videos }: { videos: Video[] }) {
  const transcripts = videos.filter((video) => video.transcript);
  if (!transcripts.length) return <EmptyData title="还没有本地口播稿" detail="发现新视频后，只提取临时音频并在本机识别；完整视频不会保存。" />;
  return <section className="transcriptList">{transcripts.map((video) => <article key={video.id}><a href={video.url} target="_blank" rel="noreferrer">{video.title} ↗</a><p>{video.transcript}</p></article>)}</section>;
}

function EmptyData({ title, detail }: { title: string; detail: string }) {
  return <section className="emptyBoard compact"><div className="emptySymbol">·</div><h3>{title}</h3><p>{detail}</p></section>;
}
