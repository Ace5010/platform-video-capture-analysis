'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './wechat-workspace.css';
/* eslint-disable @next/next/no-img-element -- Authenticated originals and animated stickers bypass image optimization. */

export type WeChatRequest = <T>(path: string, payload?: unknown) => Promise<T>;
type Group = { id: string; name: string; start: number; end: number; summary_end?: number; status: string; account_label: string;
  cleanup_pending?: { from: string; to: string };
  resource_coverage?: { total: number; ready: number; missing: number; complete: boolean } };
type Job = { id: string; group?: string; status: string; date?: string; model?: string; started_at?: string; credits?: number | null; elapsed_seconds?: number; error?: string; kind?: string; days?: number; partial?: boolean; coverage_end?: number;
  scope?: 'continue' | 'all' | 'date'; phase?: string; current_date?: string; start?: number; end?: number; known_credits?: number; credits_pending?: boolean; children?: Job[];
  media_credits?: number | null; summary_credits?: number | null; media_models?: string[] };
type GroupCandidate = { id: string; name: string; added: boolean };
type ArchiveContext = { groups: Group[]; members: { id: string; name: string }[]; batches: { id: string; start: number; end: number; status: string }[]; read_jobs: Job[]; revision?: string };
type Day = { date: string; ready: boolean; complete: boolean; summarizable: boolean; partial: boolean; coverage_end: number };
type Topic = { title: string; navigation_title?: string; summary: string;
  discussion_complete: boolean; discussion_count: number };
type Summary = { status: string; stale?: boolean; editorial_revision?: string; people?: Record<string, string>; partial?: boolean; coverage_end?: number;
  missing_resources?: { message: string; time: string; sender: string; label: string; reason: string }[];
  summary?: { format_version: number; topics: Topic[]; notes: string[] } };
type Resource = { kind: string; label: string; status: string; text?: string; error?: string; error_code?: string; detail?: string;
  assets?: { id: string; mime: string; name: string; bytes: number; tier?: string }[] };
type Message = { id: string; sender: string; member?: string; speaker?: string; time: string; content: string; reply_to?: string; resources?: Resource[] };
type MessagePage = { messages: Message[]; total: number; next?: number | null; anchor?: string; complete?: boolean };
type Overlay = { kind: 'original' | 'context'; title: string; data?: MessagePage; error?: string; loading?: boolean };
type CleanupPreview = { token: string; messages: number; summaries: number; attachments: number; unused_cache_files?: number; reclaim_bytes: number; resuming?: boolean };
const storageSize = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} KB`;
const statusText: Record<string, string> = { queued: '排队中', running: '正在执行', complete: '总结完成', imported: '已归档可阅读',
  saved_pending_import: '已保存待导入', failed: '失败', unknown: '状态待核实', incomplete: '读取不完整' };
const timeOf = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const jobTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const modelName = (value: string) => ({ 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'glm-5.3-flash': 'GLM 5.3 Flash', 'hy4-preview': 'Hy4 Preview' }[value] || value);
const scopeName = (job: Job) => job.scope === 'continue' ? '补齐未总结聊天' : job.scope === 'all' ? '全部聊天' : job.date || (job.days ? `最近 ${job.days} 天` : '新增聊天');
const jobStatus = (job: Job) => job.status === 'running' ? (job.phase === 'summarizing' || (job.model && job.kind !== 'read_and_summarize') ? `正在总结 ${job.current_date || ''}` : '正在读取') : job.status === 'failed' && job.phase === 'summarizing' ? '总结未完成' : statusText[job.status] || '等待执行';
const jobCredits = (job: Job) => job.credits != null ? `${job.credits} 积分` : job.credits_pending && job.known_credits ? `已核实 ${job.known_credits} 积分，其余待核实` : job.model ? '积分待核实' : '0 积分';
const errorText = (error: unknown) => {
  if (error instanceof TypeError && /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(error.message)) {
    return '连接不到电脑后台，请检查后台和网络后重试。';
  }
  return error instanceof Error ? error.message : '读取失败，请重试';
};

function Person({ name, onClick }: { name: string; onClick?: () => void }) {
  return onClick ? <button className="wxPerson" type="button" onClick={onClick}>{name}</button> : <span className="wxPerson">{name}</span>;
}
function Prose({ text, people }: { text?: string; people: Record<string, string> }) {
  return <>{(text || '').split(/((?<![A-Za-z0-9])(?:群友|成员)?p\d{3}(?!\d))/g).map((part, i) => {
    const id = part.match(/^(?:群友|成员)?(p\d{3})$/)?.[1];
    return id ? <Person key={i} name={people[id] || `未命名 ${id.slice(1)}`} /> : part;
  })}</>;
}

function ReadingPlaceholder() {
  return <div className="wxReadingPlaceholder wxSummaryGrid" role="status" aria-label="正在读取总结">
    <div className="wxSkeletonDirectory" aria-hidden="true">{[0, 1, 2, 3].map(index => <i key={index} />)}</div>
    <div className="wxSkeletonReading" aria-hidden="true">{[0, 1, 2].map(index => <div className="wxSkeletonArticle" key={index}><i /><i /><i /><i /></div>)}</div>
  </div>;
}

function ReadingStatus({ notes, missing }: { notes: string[]; missing: NonNullable<Summary['missing_resources']> }) {
  const element = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!element.current?.contains(event.target as Node)) element.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  return <details className="wxReadingStatus" ref={element} onKeyDown={event => {
    if (event.key === 'Escape') { element.current?.removeAttribute('open'); element.current?.querySelector('summary')?.focus(); }
  }}>
    <summary aria-label="阅读状态" title="阅读状态">ⓘ</summary>
    <div className="wxReadingStatusPanel" tabIndex={0}>{notes.map(note => <p key={note}>{note}</p>)}
      {!!missing.length && <section className="wxMissingList" aria-label="未读取内容">
        <h3>未读取内容（{missing.length}）</h3>
        <ul>{missing.map((item, index) => <li key={`${item.message}-${index}`}>
          <strong>{item.time} · {item.sender} · {item.label}</strong><span>{item.reason}</span>
        </li>)}</ul>
      </section>}
    </div>
  </details>;
}

function ChatAsset({ base, group, asset, active, showTier = true }: { base: string; group: string;
  asset: NonNullable<Resource['assets']>[number]; active: boolean; showTier?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const image = asset.mime.startsWith('image/');
  const endpoint = `${base}/api/wechat/asset?group=${encodeURIComponent(group)}&asset=${encodeURIComponent(asset.id)}`;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { rootMargin: '150px' });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || !visible || !image) return;
    const controller = new AbortController();
    let objectUrl = '';
    void fetch(endpoint, { credentials: 'include', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('图片读取失败，请重试');
      const blob = await response.blob();
      if (!blob.type.startsWith('image/') || blob.size !== asset.bytes) throw new Error('图片响应不完整');
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setError(''); setUrl(objectUrl);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); setUrl(''); };
  }, [active, visible, image, endpoint, asset.bytes]);
  async function download() {
    try {
      const response = await fetch(endpoint, { credentials: 'include' });
      if (!response.ok) throw new Error('附件读取失败，请重试');
      const blob = await response.blob();
      if (blob.size !== asset.bytes) throw new Error('附件响应不完整');
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = objectUrl; link.download = asset.name;
      link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (e) { setError(errorText(e)); }
  }
  return <div className="wxAsset" ref={element}>
    {image && url ? <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={asset.name} loading="lazy" /></a>
      : image ? <span>{error || '正在读取图片…'}</span> : <button className="wxTextButton" onClick={() => void download()}>{asset.name}</button>}
    {showTier && asset.tier === 'thumbnail' && <span className="wxThumbnailLabel">缩略图</span>}
    {!image && error && <p className="wxError">{error}</p>}
  </div>;
}

export function WeChatWorkspace({ active, local, request, page, onPage, onTaskStatus, mediaBase = '' }: {
  active: boolean; local: boolean; request: WeChatRequest; page: 'reading' | 'manage';
  onPage: (page: 'reading' | 'manage') => void; onTaskStatus: (status: string) => void;
  mediaBase?: string;
}) {
  const [archive, setArchive] = useState<ArchiveContext | null>(null);
  const [groupId, setGroupId] = useState('');
  const [days, setDays] = useState<Day[]>([]);
  const [date, setDate] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [topicIndex, setTopicIndex] = useState(0);
  const [mode, setMode] = useState<'summary' | 'messages'>('summary');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterDates, setFilterDates] = useState({ from: '', to: '' });
  const [member, setMember] = useState('');
  const [keyword, setKeyword] = useState('');
  const [messagePage, setMessagePage] = useState<MessagePage | null>(null);
  const [retryingImage, setRetryingImage] = useState('');
  const [imageRetryErrors, setImageRetryErrors] = useState<Record<string, string>>({});
  const imageRetryInFlight = useRef(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [loading, setLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [generationMode, setGenerationMode] = useState('deepseek');
  const [scope, setScope] = useState<'continue' | 'all' | 'date'>('continue');
  const [analysisDate, setAnalysisDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupFrom, setCleanupFrom] = useState('');
  const [cleanupTo, setCleanupTo] = useState('');
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const [cleanupResult, setCleanupResult] = useState('');
  const [history, setHistory] = useState<Job[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupCandidates, setGroupCandidates] = useState<GroupCandidate[] | null>(null);
  const [groupError, setGroupError] = useState('');
  const [groupPending, setGroupPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [updated, setUpdated] = useState(false);
  const reading = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const sourcePane = useRef<HTMLDivElement>(null);
  const groupList = useRef<HTMLDivElement>(null);
  const workspaceMain = useRef<HTMLElement>(null);
  const scopeSequence = useRef(0);
  const summaryScope = useRef('');
  const summaryAnchor = useRef<{ scope: string; index: number; offset: number } | null>(null);
  const archiveSequence = useRef(0);
  const archiveInFlight = useRef<{ group: string; sequence: number } | null>(null);
  const originalSequence = useRef(0);
  const searchSequence = useRef(0);
  const positions = useRef(new Map<string, number>());
  const messagePosition = useRef(0);
  const requestId = useRef('');
  const seenJobs = useRef(new Set<string>());
  const loaded = useRef(false);
  const archiveRevision = useRef('');
  const readingDirection = useRef({ axis: 'Y', sign: 1 });
  const topicScroll = useRef(0);
  const topicScrolling = useRef(false);
  const returnTarget = useRef<HTMLElement | null>(null);
  const returning = useRef(false);
  const returnAnimations = useRef<Animation[]>([]);
  const group = archive?.groups.find(g => g.id === groupId);
  const selectedDay = days.find(d => d.date === date);
  const people = summary?.people || {};
  const busy = submitting || ['running', 'unknown'].includes(job?.status || '');
  const readBusy = archive?.read_jobs.some(j => ['queued', 'running', 'unknown'].includes(j.status));
  const pendingReads = archive?.read_jobs.filter(j => ['queued', 'running', 'unknown'].includes(j.status)) || [];
  const availableGroups = archive?.groups.filter(g => !g.cleanup_pending && !pendingReads.some(j => j.group === g.id)) || [];
  const canContinue = selectedGroups.length > 0 && selectedGroups.every(id => archive?.groups.find(g => g.id === id)?.summary_end);
  const groupReads = archive?.read_jobs.filter(j => !j.group || j.group === groupId) || [];
  const latestRead = groupReads[0];
  const missingResources = mode === 'summary' ? summary?.missing_resources || [] : [];
  const readingNotes = [
    latestRead && ['failed', 'unknown', 'incomplete', 'saved_pending_import'].includes(latestRead.status) ? latestRead.error || jobStatus(latestRead) : '',
    mode === 'summary' && summary?.stale ? '聊天或图片有更新，可重新读取并总结。' : '',
    mode === 'summary' && summary?.partial && summary.coverage_end ? `总结截至 ${timeOf(summary.coverage_end)}` : '',
  ].filter(Boolean) as string[];
  const hasOverlay = Boolean(overlay);
  const query = `group=${encodeURIComponent(groupId)}&date=${date}`;
  // Reveal only the live reading surface; never remount it or reset its position.
  useLayoutEffect(() => {
    if (!active || loading || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const pane = mode === 'summary' ? reading.current?.closest('.wxSummaryGrid') : messages.current;
    const { axis, sign } = readingDirection.current;
    const animation = pane?.animate([{ opacity: .65, transform: `translate${axis}(${8 * sign}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    return () => animation?.cancel();
  }, [active, loading, mode]);
  useEffect(() => () => {
    cancelAnimationFrame(topicScroll.current);
    topicScrolling.current = false;
    returnAnimations.current.forEach(animation => animation.cancel());
    returning.current = false;
  }, [active, groupId, date]);
  const closeOriginal = useCallback(() => {
    if (returning.current) return;
    returning.current = true;
    const sequence = ++originalSequence.current;
    const layer = workspaceMain.current?.querySelector<HTMLElement>('.wxOriginalLayer');
    const pane = mode === 'summary' ? reading.current?.closest('.wxSummaryGrid') : messages.current;
    const finish = () => {
      if (sequence !== originalSequence.current) return;
      setOverlay(null); returning.current = false;
      requestAnimationFrame(() => {
        const target = returnTarget.current;
        (target?.isConnected ? target : mode === 'summary' ? reading.current : messages.current)?.focus({ preventScroll: true });
      });
    };
    if (!layer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    const style = getComputedStyle(layer);
    const opacity = style.opacity, transform = style.transform;
    layer.getAnimations().forEach(animation => animation.cancel());
    const exit = layer.animate([{ opacity, transform }, { opacity: 0, transform: 'translateX(20px)' }],
      { duration: 180, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    const reveal = pane?.animate([{ opacity: .8, transform: 'translateX(-5px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    returnAnimations.current = reveal ? [exit, reveal] : [exit];
    void exit.finished.then(finish, () => { returning.current = false; });
  }, [mode]);
  useLayoutEffect(() => {
    if (!active || (!confirmation && !hasOverlay)) return;
    if (hasOverlay && !confirmation) returnTarget.current = document.activeElement as HTMLElement | null;
    workspaceMain.current?.querySelector<HTMLButtonElement>(confirmation ? '.wxConfirm button:not(:disabled)' : '.wxOverlay > header button')?.focus({ preventScroll: true });
  }, [active, confirmation, hasOverlay]);

  const loadArchive = useCallback(async () => {
    if (archiveInFlight.current?.group === groupId) return;
    const sequence = ++archiveSequence.current;
    archiveInFlight.current = { group: groupId, sequence };
    setError('');
    try {
      const value = await request<ArchiveContext>(`context${groupId ? `?group=${encodeURIComponent(groupId)}` : ''}`);
      if (sequence !== archiveSequence.current) return;
      const revision = value.revision ?? (value.batches.map(b => `${b.id}:${b.status}`).sort().join('|') + value.read_jobs.filter(j => j.kind === 'read_and_summarize').map(j => `${j.id}:${j.status}`).join('|'));
      if (loaded.current && archiveRevision.current !== revision) {
        setRefresh(n => n + 1); setMessagePage(null);
      }
      archiveRevision.current = revision;
      setArchive(value);
      setGroupId(current => value.groups.some(g => g.id === current) ? current : value.groups[0]?.id || '');
      loaded.current = true;
    } catch (e) { if (sequence === archiveSequence.current) setError(errorText(e)); }
    finally { if (archiveInFlight.current?.sequence === sequence) archiveInFlight.current = null; }
  }, [request, groupId]);
  useEffect(() => { if (active) void loadArchive(); }, [active, local, loadArchive]);
  useEffect(() => {
    if (!groupId) return;
    let valid = true;
    void request<{ days: Day[] }>(`days?group=${encodeURIComponent(groupId)}`).then(value => {
      if (!valid) return;
      setDays(value.days);
      const preferred = value.days.filter(d => d.ready).at(-1)?.date || value.days.at(-1)?.date || '';
      setDate(current => value.days.some(d => d.date === current) ? current : preferred);
      if (!preferred) setLoading(false);
      setFrom(current => current || preferred); setTo(current => current || preferred);
    }).catch(e => { if (valid) { setError(errorText(e)); setLoading(false); } });
    return () => { valid = false; };
  }, [groupId, local, request, refresh]);
  useEffect(() => {
    if (!date || !groupId) return;
    const sequence = ++scopeSequence.current;
    if (summaryScope.current !== query) {
      summaryScope.current = query;
      setLoading(true); setSummary(null); setTopicIndex(0);
    }
    setSummaryError(''); setJob(null); setUpdated(false);
    void Promise.all([request<Summary>(`summary?${query}`), local ? request<{ job: Job | null }>(`generation?${query}`) : Promise.resolve({ job: null })])
      .then(([result, latest]) => {
        if (sequence !== scopeSequence.current) return;
        const pane = reading.current;
        if (pane) {
          const top = pane.getBoundingClientRect().top;
          const articles = [...pane.querySelectorAll<HTMLElement>('[data-topic-index]')];
          const anchor = articles.findLast(article => article.getBoundingClientRect().top <= top + 44) || articles[0];
          if (anchor) summaryAnchor.current = { scope: query, index: Number(anchor.dataset.topicIndex), offset: anchor.getBoundingClientRect().top - top };
          cancelAnimationFrame(topicScroll.current); topicScrolling.current = false;
        }
        setSummary(result); setJob(latest.job);
        setTopicIndex(current => Math.min(current, Math.max(0, (result.summary?.topics.length || 0) - 1)));
        if (latest.job?.status === 'complete') seenJobs.current.add(latest.job.id);
      }).catch(e => { if (sequence === scopeSequence.current) setSummaryError(errorText(e)); })
      .finally(() => { if (sequence === scopeSequence.current) setLoading(false); });
    return () => { scopeSequence.current = sequence + 1; };
  }, [date, groupId, local, query, request, refresh]);
  useEffect(() => {
    if (!local || job?.status !== 'running') return;
    let valid = true;
    const timer = setInterval(() => {
      void request<{ job: Job | null }>(`generation?${query}`).then(value => {
        if (!valid) return;
        setJob(value.job);
        if (value.job?.status === 'complete' && !seenJobs.current.has(value.job.id)) {
          seenJobs.current.add(value.job.id); setUpdated(true);
        }
      }).catch(() => { if (valid) setSummaryError('任务进度暂时无法读取，稍后会继续核对。'); });
    }, 2000);
    return () => { valid = false; clearInterval(timer); };
  }, [job?.status, local, query, request]);
  useEffect(() => {
    if (!active) return;
    const refreshVisible = () => { if (!document.hidden) void loadArchive(); };
    const timer = setInterval(refreshVisible, local && readBusy ? 2500 : 15000);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [active, readBusy, local, loadArchive]);
  useEffect(() => {
    if (!historyOpen || !local || !groupId) return;
    let valid = true;
    setHistoryLoading(true); setHistoryError('');
    void request<{ jobs: Job[] }>(`history?group=${encodeURIComponent(groupId)}`).then(value => {
      if (valid) setHistory(value.jobs);
    }).catch(e => { if (valid) setHistoryError(errorText(e)); })
      .finally(() => { if (valid) setHistoryLoading(false); });
    return () => { valid = false; };
  }, [historyOpen, local, groupId, archive?.read_jobs, request, job?.status]);
  useEffect(() => {
    const latestRead = archive?.read_jobs[0];
    const status = job?.status === 'running' || readBusy ? '执行中' : updated ? '总结已更新' : job?.status === 'failed' ? '总结失败' : latestRead?.status === 'failed' ? (latestRead.phase === 'summarizing' ? '总结未完成' : '读取失败') : '';
    onTaskStatus(status);
  }, [job?.status, readBusy, updated, archive?.read_jobs, onTaskStatus]);

  const loadMessages = useCallback(async (append = false) => {
    if (!from || !to || !groupId) return;
    const sequence = ++searchSequence.current;
    setMessagesLoading(true); setMessageError('');
    try {
      const result = await request<MessagePage>('search', { group: groupId, from, to, keyword, member,
        offset: append ? messagePage?.next || 0 : 0 });
      if (sequence !== searchSequence.current) return;
      setMessagePage(current => append && current ? { ...result, messages: [...current.messages, ...result.messages] } : result);
    } catch (e) { if (sequence === searchSequence.current) setMessageError(errorText(e)); }
    finally { if (sequence === searchSequence.current) setMessagesLoading(false); }
  }, [from, to, groupId, keyword, member, messagePage?.next, request]);
  useEffect(() => {
    if (mode !== 'messages' || messagePage || !from) return;
    void loadMessages();
  }, [mode, messagePage, from, loadMessages]);
  useEffect(() => {
    if (!active) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (addingGroup) { if (!groupPending) setAddingGroup(false); }
      else if (cleanupOpen) { if (!cleanupBusy) setCleanupOpen(false); }
      else if (confirmation) { if (!submitting) setConfirmation(false); }
      else if (overlay) closeOriginal();
      else if (historyOpen) setHistoryOpen(false);
      else { setMoreOpen(false); setDateOpen(false); setFiltersOpen(false); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [active, confirmation, overlay, addingGroup, groupPending, historyOpen, submitting, cleanupOpen, cleanupBusy, closeOriginal]);

  useLayoutEffect(() => {
    const pane = reading.current;
    if (pane) {
      const anchor = summaryAnchor.current;
      const target = anchor?.scope === query ? pane.querySelector<HTMLElement>(`[data-topic-index="${anchor.index}"]`) : null;
      pane.scrollTop = target && anchor
        ? pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset
        : positions.current.get(`${groupId}:${date}`) || 0;
      positions.current.set(`${groupId}:${date}`, pane.scrollTop);
    }
    summaryAnchor.current = null;
    if (messages.current) messages.current.scrollTop = messagePosition.current;
  }, [groupId, date, mode, page, summary, query]);

  useEffect(() => { if (page !== 'reading') onPage('reading'); }, [page, onPage]);
  useLayoutEffect(() => {
    const list = groupList.current;
    if (!active || !list) return;
    const reveal = () => list.querySelector<HTMLElement>('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [groupId, active]);
  useEffect(() => {
    if (!moreOpen && !dateOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.wxMore')) setMoreOpen(false);
      if (!target.closest('.wxDateNavigation')) setDateOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [moreOpen, dateOpen]);
  useEffect(() => {
    if (!active || (!confirmation && !historyOpen && !overlay && !addingGroup && !cleanupOpen)) return;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.wxModule:not([hidden]) [role="dialog"]:not([inert])');
      const controls = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]') || [])].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [active, confirmation, historyOpen, overlay, addingGroup, cleanupOpen]);
  async function cleanup(apply: boolean) {
    if (cleanupBusy || !local || !cleanupFrom || !cleanupTo || cleanupFrom > cleanupTo || (apply && (!cleanupPreview || !cleanupConfirmed))) return;
    setCleanupBusy(true); setCleanupError('');
    try {
      const value = await request<CleanupPreview>(apply ? 'cleanup' : 'cleanup-preview', {
        group: groupId, from: cleanupFrom, to: cleanupTo, confirmed: true,
        ...(apply ? { token: cleanupPreview!.token } : {}),
      });
      if (apply) {
        setCleanupOpen(false); setCleanupPreview(null); setSummary(null); setMessagePage(null);
        setCleanupResult(`已清理 ${value.messages} 条聊天记录及 ${value.attachments} 个附件。`);
        setRefresh(n => n + 1); await loadArchive();
      } else { setCleanupPreview(value); setCleanupConfirmed(false); }
    } catch (e) { setCleanupError(errorText(e)); }
    finally { setCleanupBusy(false); }
  }
  function selectTopic(index: number) {
    const pane = reading.current;
    const target = pane?.querySelector<HTMLElement>(`[data-topic-index="${index}"]`);
    if (pane && target) {
      cancelAnimationFrame(topicScroll.current);
      const start = pane.scrollTop;
      const end = Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight, start + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20));
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      topicScrolling.current = !reduced && Math.abs(end - start) > 1;
      if (!topicScrolling.current) pane.scrollTop = end;
      else {
        const began = performance.now();
        const step = (now: number) => {
          const progress = Math.min(1, (now - began) / 240);
          pane.scrollTop = start + (end - start) * (1 - Math.pow(1 - progress, 3));
          positions.current.set(`${groupId}:${date}`, pane.scrollTop);
          if (progress < 1) topicScroll.current = requestAnimationFrame(step);
          else topicScrolling.current = false;
        };
        topicScroll.current = requestAnimationFrame(step);
      }
      positions.current.set(`${groupId}:${date}`, pane.scrollTop);
    }
    setTopicIndex(index);
  }
  function trackTopic() {
    const pane = reading.current;
    if (!pane) return;
    positions.current.set(`${groupId}:${date}`, pane.scrollTop);
    const top = pane.getBoundingClientRect().top;
    const articles = [...pane.querySelectorAll<HTMLElement>('[data-topic-index]')];
    const current = articles.findLast(article => article.getBoundingClientRect().top <= top + 44) || articles[0];
    if (current && !topicScrolling.current) setTopicIndex(Number(current.dataset.topicIndex));
  }
  function interruptTopicScroll() {
    cancelAnimationFrame(topicScroll.current); topicScrolling.current = false;
  }
  function changeMode(next: 'summary' | 'messages') {
    if (mode === next) return;
    if (mode === 'messages') messagePosition.current = messages.current?.scrollTop || 0;
    else positions.current.set(`${groupId}:${date}`, reading.current?.scrollTop || 0);
    if (next === 'messages') {
      setFrom(date); setTo(date); setMember(''); setKeyword('');
      setFiltersOpen(false); setMessagePage(null); messagePosition.current = 0;
    }
    setMode(next);
  }
  function selectDate(next: string) {
    if (next === date) { setDateOpen(false); return; }
    readingDirection.current = { axis: 'X', sign: next > date ? 1 : -1 };
    setLoading(true); setSummary(null);
    setDateOpen(false); originalSequence.current++; searchSequence.current++;
    setDate(next); setFrom(next); setTo(next); setOverlay(null);
    setFiltersOpen(false); setMessagePage(null); messagePosition.current = 0;
  }
  function toggleFilters() {
    setFilterDates({ from, to }); setFiltersOpen(v => !v);
  }
  function selectGroup(id: string) {
    if (id === groupId) return;
    readingDirection.current = { axis: 'Y', sign: (archive?.groups.findIndex(g => g.id === id) || 0) > (archive?.groups.findIndex(g => g.id === groupId) || 0) ? 1 : -1 };
    archiveSequence.current++;
    scopeSequence.current++; originalSequence.current++; searchSequence.current++;
    setGroupId(id); setMode('summary'); setDateOpen(false); setMoreOpen(false); setHistoryOpen(false); setHistory([]); setMessagePage(null); setMember(''); setKeyword('');
    setDays([]); setDate(''); setFrom(''); setTo(''); setSummary(null); setJob(null); setOverlay(null);
    setSummaryError(''); setMessageError(''); setFiltersOpen(false); messagePosition.current = 0;
    setLoading(true); setMessagesLoading(false); setUpdated(false);
  }
  async function findGroups() {
    if (!local || groupPending) return;
    setGroupPending(true); setGroupError(''); setGroupCandidates(null);
    try {
      const result = await request<{ groups: GroupCandidate[] }>('find-groups', { name: groupName.trim() });
      setGroupCandidates(result.groups);
    } catch (e) { setGroupError(errorText(e)); }
    finally { setGroupPending(false); }
  }
  async function addGroup(candidate: GroupCandidate) {
    if (!local || groupPending) return;
    setGroupPending(true); setGroupError('');
    try {
      const result = await request<{ group: string }>('add-group', { candidate: candidate.id, confirmed: true });
      const value = await request<ArchiveContext>(`context?group=${encodeURIComponent(result.group)}`);
      setArchive(value); selectGroup(result.group); onPage('reading'); setAddingGroup(false);
    } catch (e) { setGroupError(errorText(e)); }
    finally { setGroupPending(false); }
  }
  async function openOriginal(index: number) {
    interruptTopicScroll();
    returnAnimations.current.forEach(animation => animation.cancel());
    returning.current = false;
    const sequence = ++originalSequence.current;
    setOverlay({ kind: 'original', title: summary?.summary?.topics[index]?.title || '话题原文', loading: true });
    try {
      const data = await request<MessagePage>(`original?${query}&topic=${index}`);
      if (sequence === originalSequence.current) setOverlay(current => current && { ...current, data, loading: false });
    } catch (e) { if (sequence === originalSequence.current) setOverlay(current => current && { ...current, error: errorText(e), loading: false }); }
  }
  async function openContext(id: string) {
    returnAnimations.current.forEach(animation => animation.cancel());
    returning.current = false;
    const sequence = ++originalSequence.current;
    setOverlay({ kind: 'context', title: '原群上下文', loading: true });
    try {
      const data = await request<MessagePage>('search', { group: groupId, from, to, anchor: id });
      if (sequence !== originalSequence.current) return;
      setOverlay({ kind: 'context', title: '原群上下文', data });
      requestAnimationFrame(() => sourcePane.current?.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' }));
    } catch (e) { if (sequence === originalSequence.current) setOverlay(current => current && { ...current, error: errorText(e), loading: false }); }
  }
  function confirm() {
    if (!local) return;
    const initial = availableGroups.find(g => g.id === groupId) || availableGroups[0];
    setSelectedGroups(initial ? [initial.id] : []);
    requestId.current = crypto.randomUUID().replaceAll('-', ''); setScope(initial?.summary_end ? 'continue' : 'all');
    setAnalysisDate(date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
    setConfirmation(true); setMoreOpen(false); setError('');
  }
  function selectAnalysisGroups(ids: string[]) {
    setSelectedGroups(ids);
    if (scope === 'continue' && ids.some(id => !archive?.groups.find(g => g.id === id)?.summary_end)) setScope('all');
    requestId.current = crypto.randomUUID().replaceAll('-', '');
  }
  async function execute() {
    if (!local || !confirmation || submitting || !selectedGroups.length) return;
    setSubmitting(true);
    try {
      const result = await request<{ jobs: Job[] }>('analyze-batch', { groups: selectedGroups, scope, date: scope === 'date' ? analysisDate : undefined, mode: generationMode, request_id: requestId.current, confirmed: true });
      setArchive(current => current && { ...current, read_jobs: [...result.jobs, ...current.read_jobs.filter(j => !result.jobs.some(next => next.id === j.id))] });
      setConfirmation(false); void loadArchive();
    } catch (e) { setError(errorText(e)); }
    finally { setSubmitting(false); }
  }
  async function retryImage(id: string) {
    if (!local || imageRetryInFlight.current) return;
    const sequence = scopeSequence.current;
    const key = `${groupId}/${id}`;
    imageRetryInFlight.current = true;
    setRetryingImage(key); setImageRetryErrors(current => ({ ...current, [key]: '' }));
    try {
      const result = await request<{ message: string; resources: Resource[] }>('retry-image', { group: groupId, message: id, confirmed: true });
      if (sequence !== scopeSequence.current) return;
      const update = (data: MessagePage) => ({ ...data, messages: data.messages.map(m => m.id === id ? { ...m, resources: result.resources } : m) });
      setMessagePage(current => current && update(current));
      setOverlay(current => current?.data ? { ...current, data: update(current.data) } : current);
      void loadArchive();
    } catch (e) {
      if (sequence === scopeSequence.current) setImageRetryErrors(current => ({ ...current, [key]: errorText(e) }));
    } finally { imageRetryInFlight.current = false; setRetryingImage(''); }
  }
  function renderMessages(rows: Message[], filtered = false) {
    return rows.map(message => {
      const linkedReply = !filtered && message.reply_to && rows.some(m => m.id === message.reply_to);
      const content = linkedReply ? message.content.split('\n引用', 1)[0] : message.content;
      return <article key={message.id} data-message-id={message.id} className={`wxMessage ${overlay?.data?.anchor === message.id ? 'wxMessageTarget' : ''}`}>
      <header><Person name={people[message.speaker || ''] || message.sender} onClick={filtered && message.member ? () => {
        setMember(message.member!); setFilterDates({ from, to }); setFiltersOpen(true); setMessagePage(null); messagePosition.current = 0;
      } : undefined} /><time>{message.time}</time></header>
      <p>{message.resources?.length ? content.replace(/\[(?:图片|表情|视频|语音|文件|位置|其他消息)：未获取原件\]/g, '').trim() : content}</p>
      {message.resources?.map((resource, index) => <div className="wxResource" key={index}>
        {resource.status === 'excluded' ? <p>{resource.text}</p> : <>
          {resource.status !== 'ready' && <div className="wxResourceStatus">
            <span>{resource.error || `${resource.label}尚未读取完整`}</span>
            {local && resource.kind === 'image' && <button className="wxTextButton" disabled={!!retryingImage} onClick={() => void retryImage(message.id)}>{retryingImage === `${groupId}/${message.id}` ? '正在重试…' : '重试'}</button>}
          </div>}
          {resource.status !== 'ready' && resource.detail && <details><summary>处理方法</summary><p>{resource.detail}</p></details>}
          {resource.text && (resource.kind !== 'card' || !/当前微信版本不支持|version does not support/.test(resource.text)) && <details><summary>{resource.label}正文</summary><p>{resource.text}</p></details>}
          {resource.assets?.map(asset => <ChatAsset key={asset.id} base={mediaBase} group={groupId} asset={asset} active={active} showTier={resource.error_code !== 'thumbnail_only'} />)}
          {imageRetryErrors[`${groupId}/${message.id}`] && <p role="alert">{imageRetryErrors[`${groupId}/${message.id}`]}</p>}
        </>}
      </div>)}
      {(filtered || overlay?.kind === 'original') && <button className="wxTextButton" onClick={() => void openContext(message.id)}>查看前后文</button>}
      {linkedReply && <button className="wxTextButton" onClick={() => sourcePane.current?.querySelector(`[data-message-id="${message.reply_to}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' })}>定位被引用消息</button>}
    </article>;
    });
  }

  return <section className="wxModule" hidden={!active} aria-label="微信读取">
    <div className="wxWorkspace" inert={addingGroup}>
        <aside className="wxGroups" aria-label="群列表" inert={confirmation || hasOverlay || historyOpen || cleanupOpen}>
          <div className="wxGroupOptions" ref={groupList}><h2>群聊</h2>{archive?.groups.map(g => <button key={g.id} aria-current={groupId === g.id ? 'true' : undefined} onClick={() => selectGroup(g.id)}><strong>{g.name}</strong></button>)}
          </div>
          {local && <button className="wxAddGroupButton" aria-label="新增群" onClick={() => { setAddingGroup(true); setGroupCandidates(null); setGroupName(''); setGroupError(''); }}>＋</button>}
        </aside>
        <main className="wxMain" ref={workspaceMain}>
          <div className="wxMainContent" inert={hasOverlay || confirmation || historyOpen || cleanupOpen}>
          {error && <div className="wxError" role="alert">{error}<button onClick={() => void loadArchive()}>重试</button></div>}
          {!archive && !error && <p className="wxEmpty">正在读取归档…</p>}
          {archive && !group && <p className="wxEmpty">{local ? '点击“新增群”添加要读取的群。' : '暂无已归档的群。'}</p>}
          {archive && group && <>
            <header className="wxHeading"><h1>{group.name}</h1></header>
            <div className="wxReadingControls">
              {mode === 'messages' ? <button onClick={() => changeMode('summary')}>返回总结</button> : <div className="wxDateNavigation">
                <button aria-label="前一天" disabled={days.findIndex(d => d.date === date) <= 0} onClick={() => selectDate(days[days.findIndex(d => d.date === date) - 1].date)}>‹</button>
                <button className="wxDateButton" aria-label="选择聊天日期" aria-expanded={dateOpen} onClick={() => { setDateOpen(v => !v); setMoreOpen(false); }}>{date || '暂无记录'} ▾</button>
                <button aria-label="后一天" disabled={!date || days.findIndex(d => d.date === date) >= days.length - 1} onClick={() => selectDate(days[days.findIndex(d => d.date === date) + 1].date)}>›</button>
                {dateOpen && <div className="wxDatePopover" aria-label="聊天日期">{[...days].reverse().map(d => <button key={d.date} aria-current={date === d.date ? 'date' : undefined} onClick={() => selectDate(d.date)}>{d.date}</button>)}{!days.length && <p>暂无记录</p>}</div>}
              </div>}
              {mode === 'messages' && <><span className="wxDateRange">{from === to ? from : `${from} — ${to}`}</span><button onClick={toggleFilters} aria-expanded={filtersOpen}>筛选</button></>}
              <div className="wxToolbarActions">{(!!readingNotes.length || !!missingResources.length) && <ReadingStatus key={`${groupId}:${date}`} notes={readingNotes} missing={missingResources} />}{local && <button className="wxPrimary" disabled={busy || !availableGroups.length} onClick={confirm}>读取并总结</button>}
                <div className="wxMore"><button aria-label="更多操作" aria-expanded={moreOpen} onClick={() => { setMoreOpen(v => !v); setDateOpen(false); }}>⋯</button>
                  {moreOpen && <div className="wxMoreMenu">
                    {local && <button onClick={() => { setMoreOpen(false); setHistory([]); setHistoryOpen(true); }}>读取记录与积分</button>}
                    {local && <button disabled={busy || readBusy || (!date && !group?.cleanup_pending)} onClick={() => {
                      setMoreOpen(false); setCleanupFrom(group?.cleanup_pending?.from || date); setCleanupTo(group?.cleanup_pending?.to || date); setCleanupPreview(null);
                      setCleanupConfirmed(false); setCleanupError(''); setCleanupOpen(true);
                    }}>清理聊天记录</button>}
                    <button disabled={!date} onClick={() => { setMoreOpen(false); changeMode('messages'); }}>查看当天全部聊天</button>
                    <button onClick={() => { setMoreOpen(false); void loadArchive(); setRefresh(n => n + 1); setMessagePage(null); }}>刷新</button>
                  </div>}
                </div>
              </div>
            </div>
            {!!pendingReads.length && <div className="wxReadQueue" aria-label="读取队列">{[...pendingReads].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (a.started_at || '').localeCompare(b.started_at || '')).map(item => <div key={item.id} className="wxJobStatus" data-running={item.status === 'running'} role="status"><span>{archive.groups.find(g => g.id === item.group)?.name}</span><span>{item.error || jobStatus(item)}</span></div>)}</div>}
            {cleanupResult && <p className="wxNotice" role="status">{cleanupResult}</p>}
            {local && group?.cleanup_pending && <p className="wxNotice" role="status">清理尚未完成，请在“更多操作 → 清理聊天记录”中继续。</p>}
            {mode === 'messages' && filtersOpen && <form className="wxFilters" onSubmit={e => { e.preventDefault(); setFrom(filterDates.from); setTo(filterDates.to); messagePosition.current = 0; setMessagePage(null); }}>
              <label>开始日期<select aria-label="开始日期" value={filterDates.from} onChange={e => setFilterDates(current => ({ from: e.target.value, to: current.to < e.target.value ? e.target.value : current.to }))}>{days.map(d => <option key={d.date}>{d.date}</option>)}</select></label><label>结束日期<select aria-label="结束日期" value={filterDates.to} onChange={e => setFilterDates(current => ({ ...current, to: e.target.value }))}>{days.filter(d => d.date >= filterDates.from).map(d => <option key={d.date}>{d.date}</option>)}</select></label>
              <label>成员<select value={member} onChange={e => setMember(e.target.value)}><option value="">所有成员</option>{archive.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
              <label>关键词<input value={keyword} onChange={e => setKeyword(e.target.value)} maxLength={200} placeholder="搜索已保存消息" /></label><button type="submit">应用筛选</button>
            </form>}
            {mode === 'summary' ? <>
              {job && !latestRead?.children?.some(child => child.id === job.id) && (job.status !== 'complete' || updated) && <div className="wxJobStatus" role="status">{job.status === 'complete' ? '新总结已完成' : job.error || statusText[job.status]}{updated && <button onClick={() => setRefresh(n => n + 1)}>查看新总结</button>}</div>}
              {loading ? <ReadingPlaceholder /> : summaryError ? <p className="wxError">{summaryError}</p> : !summary?.summary ? <p className="wxEmpty">{!group.end ? '尚未读取聊天' : selectedDay && !selectedDay.summarizable ? '这一天的聊天未完整读取' : '这一天尚无总结'}</p> :
                <div className="wxSummaryGrid"><nav className="wxTopics" aria-label="当日讨论"><div className="wxTopicOptions">{summary.summary.topics.map((t, index) => <button key={index} aria-current={topicIndex === index ? 'true' : undefined} onClick={() => selectTopic(index)}>{t.navigation_title || t.title}</button>)}</div></nav>
                  <div className="wxTopicReading" ref={reading} tabIndex={0} onScroll={trackTopic} onWheel={interruptTopicScroll} onTouchStart={interruptTopicScroll} onPointerDown={interruptTopicScroll} onKeyDown={interruptTopicScroll}>{summary.summary.topics.map((item, index) => <article key={index} data-topic-index={index}>
                    <h2><Prose text={item.title} people={people} /></h2>
                    <p className="wxTopicLead"><Prose text={item.summary} people={people} /></p>
                    <button className="wxTextButton" onClick={() => void openOriginal(index)}>{item.discussion_complete ? '查看讨论原文' : '查看原文节选'}（{item.discussion_count}）</button>
                  </article>)}</div></div>}
            </> : <div className="wxMessages" ref={messages} tabIndex={0}>{messageError && <p className="wxError">{messageError}</p>}{messagePage && <p className="wxResultCount">{messagePage.total} 条匹配消息</p>}{renderMessages(messagePage?.messages || [], true)}{messagesLoading ? <p>正在读取…</p> : messagePage?.next != null ? <button onClick={() => void loadMessages(true)}>继续阅读</button> : messagePage?.total === 0 ? <p>没有符合条件的已保存消息。</p> : null}</div>}
          </>}
          </div>
          {overlay && <div className="wxOverlay wxOriginalLayer" role="dialog" aria-label={overlay.title} inert={Boolean(confirmation)}><header className="wxOriginalHeader"><button onClick={closeOriginal}>返回</button><h2>{overlay.title}</h2></header>
            <div className="wxSourcePane" ref={sourcePane} tabIndex={0}>{overlay.loading ? <p>正在读取原文…</p> : overlay.error ? <p className="wxError">{overlay.error}</p> : <>
              {overlay.kind === 'original' && <p className="wxNotice">{overlay.data?.complete ? `${overlay.data.total} 条消息` : `原文节选 · ${overlay.data?.total} 条`} <button onClick={() => { originalSequence.current++; setOverlay(null); changeMode('messages'); }}>查看当天全部聊天</button></p>}
              {renderMessages(overlay.data?.messages || [])}</>}</div></div>}
          {historyOpen && local && <section className="wxOverlay wxHistoryOverlay" role="dialog" aria-modal="true" aria-label="读取记录与积分">
            <header><h2>读取记录与积分</h2><button autoFocus onClick={() => setHistoryOpen(false)}>关闭</button></header>
            <div className="wxSourcePane">{historyError && <p className="wxError">{historyError}</p>}{historyLoading && !history.length ? <p>正在读取记录…</p> : !history.length && !historyError ? <p>暂无读取记录</p> : null}
              {history.map(record => <article className="wxRecord" key={record.id}><header><b>{record.kind === 'read_and_summarize' ? scopeName(record) : record.kind === 'generate' ? `${record.date} 的总结` : record.kind === 'resources' ? '附件与网页读取' : record.kind === 'import' ? '归档导入' : scopeName(record)}</b><span>{jobStatus(record)}</span></header>
                <dl>{record.started_at && <><dt>执行时间</dt><dd>{jobTime(record.started_at)}</dd></>}
                  {record.start != null && record.end != null && <><dt>聊天范围</dt><dd>{record.start === 0 ? '全部聊天' : timeOf(record.start)} 至 {timeOf(record.end)}</dd></>}
                  {record.model && <><dt>总结模型</dt><dd>{modelName(record.model)}</dd></>}<dt>积分消耗</dt><dd>{jobCredits(record)}</dd>
                  {!!record.media_models?.length && <><dt>视频读取</dt><dd>{record.media_models.map(modelName).join('、')} · {record.media_credits == null ? '积分待核实' : `${record.media_credits} 积分`}</dd></>}
                  {record.summary_credits != null && <><dt>总结积分</dt><dd>{record.summary_credits}</dd></>}
                  {record.elapsed_seconds != null && <><dt>耗时</dt><dd>{Math.round(record.elapsed_seconds)} 秒</dd></>}
                </dl>{record.error && <p role="status">{record.error}</p>}
                {!!record.children?.length && <details className="wxRunDetails"><summary>每日总结明细</summary>{record.children.map(child => <div key={child.id}><span>{child.date}</span><span>{jobStatus(child)}</span><span>{jobCredits(child)}</span>{!!child.media_models?.length && <p>视频读取：{child.media_models.map(modelName).join('、')} · {child.media_credits == null ? '积分待核实' : `${child.media_credits} 积分`}{child.summary_credits != null ? `；总结：${child.summary_credits} 积分` : ''}</p>}{child.error && <p>{child.error}</p>}</div>)}</details>}
              </article>)}
            </div>
          </section>}
          {cleanupOpen && local && <div className="wxConfirmBackdrop"><section role="dialog" aria-modal="true" aria-label="清理聊天记录" className="wxConfirm wxCleanup"><h2>清理聊天记录</h2>
            <p>{group?.name}</p>
            <div className="wxCleanupDates">
              <label>开始日期<input autoFocus type="date" value={cleanupFrom} disabled={cleanupBusy} onChange={e => { setCleanupFrom(e.target.value); setCleanupPreview(null); setCleanupConfirmed(false); }} /></label>
              <label>结束日期<input type="date" value={cleanupTo} min={cleanupFrom} disabled={cleanupBusy} onChange={e => { setCleanupTo(e.target.value); setCleanupPreview(null); setCleanupConfirmed(false); }} /></label>
            </div>
            <p>清理所选日期的聊天、总结和未共享附件，并清除当前群闲置缓存。保留微信原聊天和积分记录。</p>
            {cleanupPreview && <><dl><dt>聊天记录</dt><dd>{cleanupPreview.messages} 条</dd><dt>总结</dt><dd>{cleanupPreview.summaries} 份</dd><dt>附件</dt><dd>{cleanupPreview.attachments} 个{cleanupPreview.unused_cache_files ? `（含 ${cleanupPreview.unused_cache_files} 个闲置缓存）` : ''}</dd><dt>预计释放</dt><dd>{storageSize(cleanupPreview.reclaim_bytes)}</dd></dl>
              <p>清理后无法在 Observe 中恢复，该时间段不再自动读取。</p>
              <label className="wxCleanupConsent"><input type="checkbox" checked={cleanupConfirmed} disabled={cleanupBusy} onChange={e => setCleanupConfirmed(e.target.checked)} />我确认清理以上记录</label></>}
            {cleanupError && <p className="wxError" role="alert">{cleanupError}</p>}
            <div className="wxActions"><button disabled={cleanupBusy} onClick={() => setCleanupOpen(false)}>取消</button>
              {cleanupPreview ? <button className="wxDanger" disabled={cleanupBusy || !cleanupConfirmed || !cleanupPreview.messages} onClick={() => void cleanup(true)}>{cleanupBusy ? '正在清理…' : cleanupPreview.resuming ? '继续清理' : '确认清理'}</button>
                : <button className="wxPrimary" disabled={cleanupBusy || !cleanupFrom || !cleanupTo || cleanupFrom > cleanupTo} onClick={() => void cleanup(false)}>{cleanupBusy ? '正在计算…' : '预览清理范围'}</button>}</div>
          </section></div>}
          {confirmation && local && <div className="wxConfirmBackdrop"><section role="dialog" aria-modal="true" aria-label="读取并总结" className="wxConfirm wxAnalysisSetup"><h2>读取并总结</h2>
            <fieldset disabled={submitting}><legend>群聊</legend><div className="wxBatchControls"><button onClick={() => selectAnalysisGroups(availableGroups.map(g => g.id))}>全选</button><button onClick={() => selectAnalysisGroups([])}>清空选择</button></div><div className="wxBatchGroups">{archive?.groups.map(g => <label key={g.id}><input type="checkbox" checked={selectedGroups.includes(g.id)} disabled={!availableGroups.some(next => next.id === g.id)} onChange={e => selectAnalysisGroups(e.target.checked ? [...selectedGroups, g.id] : selectedGroups.filter(id => id !== g.id))} /><span>{g.name}</span>{pendingReads.some(j => j.group === g.id) && <span>已在队列</span>}</label>)}</div></fieldset>
            <fieldset disabled={submitting}><legend>总结范围</legend><div className="wxScopeOptions">
              <button className="wxContinueChoice" aria-pressed={scope === 'continue'} disabled={!canContinue} onClick={() => { setScope('continue'); requestId.current = crypto.randomUUID().replaceAll('-', ''); }}>补齐未总结聊天</button>
              <button aria-pressed={scope === 'all'} onClick={() => { setScope('all'); requestId.current = crypto.randomUUID().replaceAll('-', ''); }}>全部聊天</button>
              <button aria-pressed={scope === 'date'} onClick={() => { setScope('date'); requestId.current = crypto.randomUUID().replaceAll('-', ''); }}>指定日期</button>
            </div>{scope === 'date' && <label className="wxAnalysisDate">日期<input aria-label="总结日期" type="date" value={analysisDate} max={new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })} onChange={e => { setAnalysisDate(e.target.value); requestId.current = crypto.randomUUID().replaceAll('-', ''); }} /></label>}</fieldset>
            <fieldset disabled={submitting}><legend>总结模型</legend><div className="wxModelOptions">{[['deepseek', 'DeepSeek V4.1 Flash'], ['low', 'GLM 5.3 Flash'], ['high', 'Hy4 Preview']].map(([value, label]) => <button key={value} aria-pressed={generationMode === value} onClick={() => { setGenerationMode(value); requestId.current = crypto.randomUUID().replaceAll('-', ''); }}>{label}</button>)}</div></fieldset>
            <p>{scope === 'continue' ? '包含历史未完成日期，跳过内容未变化的已有总结。' : ''}读取文字和已有完整图片，缺失内容单独列出，视频不下载。</p>
            {error && <p className="wxError" role="alert">{error}</p>}<div className="wxActions"><button disabled={submitting} onClick={() => setConfirmation(false)}>取消</button><button className="wxPrimary" disabled={submitting || !selectedGroups.length || (scope === 'date' && !analysisDate)} onClick={() => void execute()}>{submitting ? '正在提交…' : `加入队列（${selectedGroups.length}）`}</button></div>
          </section></div>}
        </main>
      </div>
    {addingGroup && local && <div className="wxGroupBackdrop"><section className="wxConfirm wxAddGroup" role="dialog" aria-modal="true" aria-label="新增群">
      <h2>新增群</h2><p>保持电脑微信已登录，输入完整群名。</p>
      <form onSubmit={e => { e.preventDefault(); void findGroups(); }}><label>群名<input autoFocus required maxLength={100} value={groupName} disabled={groupPending} onChange={e => { setGroupName(e.target.value); setGroupCandidates(null); setGroupError(''); }} /></label>
        <button type="submit" disabled={groupPending || !groupName.trim()}>{groupPending ? '正在处理…' : '查找群'}</button></form>
      {groupError && <p className="wxError" role="alert">{groupError}</p>}
      {groupCandidates?.length === 0 && <p role="status">未找到该群，请核对微信中的完整群名。</p>}
      {groupCandidates?.map(candidate => <div className="wxGroupCandidate" key={candidate.id}><strong>{candidate.name}</strong><button disabled={candidate.added || groupPending} onClick={() => void addGroup(candidate)}>{candidate.added ? '已添加' : '确认添加'}</button></div>)}
      <div className="wxActions"><button disabled={groupPending} onClick={() => setAddingGroup(false)}>关闭</button></div>
    </section></div>}
  </section>;
}
