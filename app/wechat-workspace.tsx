'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './wechat-workspace.css';

export type WeChatRequest = <T>(path: string, payload?: unknown) => Promise<T>;
type Group = { id: string; name: string; start: number; end: number; status: string; account_label: string };
type Job = { id: string; status: string; date?: string; model?: string; started_at?: string; credits?: number; elapsed_seconds?: number; error?: string; kind?: string; days?: number; partial?: boolean; coverage_end?: number };
type ArchiveContext = { groups: Group[]; members: { id: string; name: string }[]; batches: { id: string; start: number; end: number; status: string }[]; read_jobs: Job[] };
type Day = { date: string; ready: boolean; complete: boolean; summarizable: boolean; partial: boolean; coverage_end: number };
type Topic = { title: string; navigation_title?: string; summary: string; details?: string; points?: string[]; outcome?: string;
  blocks?: { heading: string; text: string; speaker?: string }[]; views?: { speaker: string; text: string }[];
  comparisons?: { heading: string; text: string }[]; quotes?: { text: string; speaker: string; time: string }[]; progress?: string;
  discussion_complete: boolean; discussion_count: number };
type Summary = { status: string; stale?: boolean; editorial_revision?: string; people?: Record<string, string>; partial?: boolean; coverage_end?: number;
  summary?: { format_version: number; topics: Topic[]; notes: string[] } };
type Message = { id: string; sender: string; member?: string; speaker?: string; time: string; content: string; reply_to?: string };
type MessagePage = { messages: Message[]; total: number; next?: number | null; anchor?: string; complete?: boolean };
type Overlay = { kind: 'original' | 'context'; title: string; data?: MessagePage; error?: string; loading?: boolean };
const statusText: Record<string, string> = { running: '正在执行', complete: '总结完成', imported: '已归档可阅读',
  saved_pending_import: '已保存待导入', failed: '失败可重试', unknown: '状态待核实', incomplete: '读取不完整' };
const timeOf = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const clockOf = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
const jobTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const modelName = (value: string) => ({ 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'glm-5.3-flash': 'GLM 5.3 Flash', 'hy4-preview': 'Hy4 Preview' }[value] || value);
const readStatus: Record<string, string> = { imported: '读取成功', running: '正在读取', failed: '读取失败', incomplete: '未完整读取', saved_pending_import: '已读取，待导入', unknown: '结果待核实' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取失败，请重试';

function Person({ name, onClick }: { name: string; onClick?: () => void }) {
  return onClick ? <button className="wxPerson" type="button" onClick={onClick}>群友「{name}」</button> : <span className="wxPerson">群友「{name}」</span>;
}
function Prose({ text, people }: { text?: string; people: Record<string, string> }) {
  return <>{(text || '').split(/((?<![A-Za-z0-9])(?:群友|成员)?p\d{3}(?!\d))/g).map((part, i) => {
    const id = part.match(/^(?:群友|成员)?(p\d{3})$/)?.[1];
    return id ? <Person key={i} name={people[id] || `未命名 ${id.slice(1)}`} /> : part;
  })}</>;
}

export function WeChatWorkspace({ active, local, request, page, onPage, onTaskStatus }: {
  active: boolean; local: boolean; request: WeChatRequest; page: 'reading' | 'manage';
  onPage: (page: 'reading' | 'manage') => void; onTaskStatus: (status: string) => void;
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
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [loading, setLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [confirmation, setConfirmation] = useState<'generate' | 'sync' | 'import' | null>(null);
  const [generationMode, setGenerationMode] = useState('deepseek');
  const [readDays, setReadDays] = useState('incremental');
  const [submitting, setSubmitting] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [updated, setUpdated] = useState(false);
  const reading = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const sourcePane = useRef<HTMLDivElement>(null);
  const workspaceMain = useRef<HTMLElement>(null);
  const scopeSequence = useRef(0);
  const originalSequence = useRef(0);
  const searchSequence = useRef(0);
  const positions = useRef(new Map<string, number>());
  const messagePosition = useRef(0);
  const requestId = useRef('');
  const seenJobs = useRef(new Set<string>());
  const loaded = useRef(false);
  const archiveRevision = useRef('');
  const group = archive?.groups.find(g => g.id === groupId);
  const selectedDay = days.find(d => d.date === date);
  const topic = summary?.summary?.topics[topicIndex];
  const people = summary?.people || {};
  const busy = submitting || ['running', 'unknown'].includes(job?.status || '');
  const readBusy = archive?.read_jobs.some(j => ['running', 'unknown'].includes(j.status));
  const latestRead = archive?.read_jobs[0];
  const pendingImport = archive?.batches.some(b => b.status === 'saved_pending_import');
  const hasOverlay = Boolean(overlay);
  const query = `group=${encodeURIComponent(groupId)}&date=${date}`;
  useLayoutEffect(() => {
    if (!active || (!confirmation && !hasOverlay)) return;
    workspaceMain.current?.querySelector<HTMLButtonElement>(confirmation ? '.wxConfirm button' : '.wxOverlay > header button')?.focus({ preventScroll: true });
  }, [active, confirmation, hasOverlay]);

  const loadArchive = useCallback(async () => {
    setError('');
    try {
      const value = await request<ArchiveContext>('context');
      const revision = value.batches.map(b => `${b.id}:${b.status}`).sort().join('|');
      if (loaded.current && archiveRevision.current !== revision) {
        setRefresh(n => n + 1); setMessagePage(null);
      }
      archiveRevision.current = revision;
      setArchive(value);
      setGroupId(current => value.groups.some(g => g.id === current) ? current : value.groups[0]?.id || '');
      loaded.current = true;
    } catch (e) { setError(errorText(e)); }
  }, [request]);
  useEffect(() => { if (active && !loaded.current) void loadArchive(); }, [active, local, loadArchive]);
  useEffect(() => {
    if (!groupId) return;
    let valid = true;
    void request<{ days: Day[] }>(`days?group=${encodeURIComponent(groupId)}`).then(value => {
      if (!valid) return;
      setDays(value.days);
      const preferred = value.days.filter(d => d.ready).at(-1)?.date || value.days.at(-1)?.date || '';
      setDate(current => value.days.some(d => d.date === current) ? current : preferred);
      setFrom(current => current || preferred); setTo(current => current || preferred);
    }).catch(e => { if (valid) setError(errorText(e)); });
    return () => { valid = false; };
  }, [groupId, local, request, refresh]);
  useEffect(() => {
    if (!date || !groupId) return;
    const sequence = ++scopeSequence.current;
    setLoading(true); setSummaryError(''); setSummary(null); setTopicIndex(0); setJob(null); setUpdated(false);
    void Promise.all([request<Summary>(`summary?${query}`), local ? request<{ job: Job | null }>(`generation?${query}`) : Promise.resolve({ job: null })])
      .then(([result, latest]) => {
        if (sequence !== scopeSequence.current) return;
        setSummary(result); setJob(latest.job);
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
    if (!local || !archive?.read_jobs.some(j => j.status === 'running')) return;
    const timer = setInterval(() => { void loadArchive(); }, 2500);
    return () => clearInterval(timer);
  }, [archive?.read_jobs, local, loadArchive]);
  useEffect(() => {
    const status = job?.status === 'running' || readBusy ? '执行中' : updated ? '总结已更新' : job?.status === 'failed' ? '总结失败' : archive?.read_jobs[0]?.status === 'failed' ? '读取失败' : '';
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
      if (confirmation) setConfirmation(null);
      else if (overlay) { originalSequence.current++; setOverlay(null); }
      else { setDirectoryOpen(false); setFiltersOpen(false); setGroupsOpen(false); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [active, confirmation, overlay]);

  useLayoutEffect(() => {
    if (reading.current) reading.current.scrollTop = positions.current.get(`${groupId}:${date}:${topicIndex}`) || 0;
    if (messages.current) messages.current.scrollTop = messagePosition.current;
  }, [groupId, date, topicIndex, mode, page, summary]);

  useEffect(() => { if (!local && page !== 'reading') onPage('reading'); }, [local, page, onPage]);

  function selectPage(next: 'reading' | 'manage') {
    if (!local && next === 'manage') return;
    if (page === 'reading') { positions.current.set(`${groupId}:${date}:${topicIndex}`, reading.current?.scrollTop || 0); messagePosition.current = messages.current?.scrollTop || 0; }
    onPage(next);
  }
  function selectTopic(index: number) {
    positions.current.set(`${groupId}:${date}:${topicIndex}`, reading.current?.scrollTop || 0);
    setTopicIndex(index); setDirectoryOpen(false);
  }
  function changeMode(next: 'summary' | 'messages') {
    if (mode === next) return;
    if (mode === 'messages') messagePosition.current = messages.current?.scrollTop || 0;
    else positions.current.set(`${groupId}:${date}:${topicIndex}`, reading.current?.scrollTop || 0);
    if (next === 'messages') {
      setFrom(date); setTo(date); setMember(''); setKeyword('');
      setFiltersOpen(false); setMessagePage(null); messagePosition.current = 0;
    }
    setMode(next);
  }
  function selectDate(next: string) {
    setDate(next); setFrom(next); setTo(next); setOverlay(null);
    setFiltersOpen(false); setMessagePage(null); messagePosition.current = 0;
  }
  function toggleFilters() {
    setFilterDates({ from, to }); setFiltersOpen(v => !v);
  }
  async function openOriginal(index: number) {
    const sequence = ++originalSequence.current;
    setOverlay({ kind: 'original', title: topic?.title || '话题原文', loading: true });
    try {
      const data = await request<MessagePage>(`original?${query}&topic=${index}`);
      if (sequence === originalSequence.current) setOverlay(current => current && { ...current, data, loading: false });
    } catch (e) { if (sequence === originalSequence.current) setOverlay(current => current && { ...current, error: errorText(e), loading: false }); }
  }
  async function openContext(id: string) {
    const sequence = ++originalSequence.current;
    setOverlay({ kind: 'context', title: '原群上下文', loading: true });
    try {
      const data = await request<MessagePage>('search', { group: groupId, from, to, anchor: id });
      if (sequence !== originalSequence.current) return;
      setOverlay({ kind: 'context', title: '原群上下文', data });
      requestAnimationFrame(() => sourcePane.current?.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' }));
    } catch (e) { if (sequence === originalSequence.current) setOverlay(current => current && { ...current, error: errorText(e), loading: false }); }
  }
  function confirm(kind: 'generate' | 'sync' | 'import') {
    if (!local) return;
    requestId.current = crypto.randomUUID().replaceAll('-', ''); setConfirmation(kind); setError('');
  }
  async function execute() {
    if (!local || !confirmation || submitting) return;
    setSubmitting(true);
    try {
      if (confirmation === 'generate') {
        const result = await request<{ job: Job }>('generate', { group: groupId, date, mode: generationMode, request_id: requestId.current, confirmed: true });
        setJob(result.job);
      } else {
        await request('read', { group: groupId, kind: confirmation, days: readDays === 'incremental' ? null : Number(readDays), request_id: requestId.current, confirmed: true });
        await loadArchive();
      }
      setConfirmation(null);
    } catch (e) { setError(errorText(e)); }
    finally { setSubmitting(false); }
  }
  function renderMessages(rows: Message[], filtered = false) {
    return rows.map(message => <article key={message.id} data-message-id={message.id} className={`wxMessage ${overlay?.data?.anchor === message.id ? 'wxMessageTarget' : ''}`}>
      <header><Person name={people[message.speaker || ''] || message.sender} onClick={filtered && message.member ? () => {
        setMember(message.member!); setFilterDates({ from, to }); setFiltersOpen(true); setMessagePage(null); messagePosition.current = 0;
      } : undefined} /><time>{message.time}</time></header>
      <p>{message.content}</p>
      {filtered && <button className="wxTextButton" onClick={() => void openContext(message.id)}>查看前后文</button>}
      {!filtered && message.reply_to && rows.some(m => m.id === message.reply_to) && <button className="wxTextButton" onClick={() => sourcePane.current?.querySelector(`[data-message-id="${message.reply_to}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' })}>定位被引用消息</button>}
    </article>);
  }

  return <section className="wxModule" hidden={!active} aria-label="微信读取">
    <nav className="moduleFunctionBar" aria-label="微信功能">
      <button aria-current={page === 'reading' ? 'page' : undefined} onClick={() => selectPage('reading')}>消息阅读</button>
      {local && <button aria-current={page === 'manage' ? 'page' : undefined} onClick={() => selectPage('manage')}>读取管理</button>}
      <button className="wxRefresh" onClick={() => { void loadArchive(); setRefresh(n => n + 1); setMessagePage(null); }}>刷新</button>
    </nav>
    <div className="wxWorkspace">
        <aside className={`wxGroups ${groupsOpen ? 'isExpanded' : ''}`}>
          <button className="wxGroupToggle" onClick={() => setGroupsOpen(v => !v)} aria-expanded={groupsOpen}>{group?.name || '选择群'} ▾</button>
          <div className="wxGroupOptions"><h2>已归档的群</h2>{archive?.groups.map(g => <button key={g.id} aria-current={groupId === g.id ? 'true' : undefined} onClick={() => {
            setGroupId(g.id); setGroupsOpen(false); setMessagePage(null); setMember(''); setKeyword('');
          }}><strong>{g.name}</strong></button>)}</div>
        </aside>
        <main className="wxMain" ref={workspaceMain}>
          <div className="wxMainContent" inert={hasOverlay || Boolean(confirmation)}>
          {error && <div className="wxError" role="alert">{error}<button onClick={() => void loadArchive()}>重试</button></div>}
          {!archive && !error && <p className="wxEmpty">正在读取归档…</p>}
          {archive && local && page === 'manage' && <div className="wxManagement">
            <section className="wxReadAction"><h1>{group?.name}</h1>
              <p>{group?.end ? `已读取至 ${timeOf(group.end)}` : '尚未读取聊天'}</p>
              {latestRead && ['unknown', 'failed', 'incomplete', 'saved_pending_import'].includes(latestRead.status) && <p className="wxReadStatus" role="status">{latestRead.error || statusText[latestRead.status]}</p>}
              <div className="wxActions"><button disabled={readBusy || busy} onClick={() => confirm('sync')}>{latestRead?.status === 'running' ? '正在读取…' : '读取聊天'}</button>{pendingImport && <button disabled={readBusy || busy} onClick={() => confirm('import')}>重试导入</button>}</div>
              <details className="wxReadOptions"><summary>读取范围{readDays !== 'incremental' ? ` · 最近 ${readDays} 天` : ''}</summary><label><select aria-label="读取范围" value={readDays} onChange={e => setReadDays(e.target.value)}><option value="incremental">只读取新增聊天</option><option value="1">最近 1 天</option><option value="3">最近 3 天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select></label></details>
            </section><details className="wxHistory"><summary>记录与消耗</summary><section><h2>最近一次总结</h2><label>哪天的聊天 <select value={date} onChange={e => selectDate(e.target.value)} aria-label="总结记录日期">{[...days].reverse().map(d => <option key={d.date}>{d.date}</option>)}</select></label>
              {loading ? <p>正在读取…</p> : summaryError ? <p className="wxError">{summaryError}</p> : job ? <article className="wxRecord"><header><b>{date} 的聊天总结</b><span>{job.status === 'complete' ? '生成成功' : job.status === 'running' ? '正在生成' : job.status === 'failed' ? '生成失败' : '结果待核实'}</span></header><dl>
                {job.started_at && <><dt>生成时间</dt><dd>{jobTime(job.started_at)}</dd></>}{job.model && <><dt>使用模型</dt><dd>{modelName(job.model)}</dd></>}
                {job.elapsed_seconds != null && <><dt>耗时</dt><dd>{Math.round(job.elapsed_seconds)} 秒</dd></>}<dt>积分消耗</dt><dd>{job.credits != null ? `${job.credits} 积分` : '尚未核实'}</dd>
                {job.partial && job.coverage_end && <><dt>聊天范围</dt><dd>当天 00:00 至 {clockOf(job.coverage_end)}</dd></>}
              </dl>{job.error && <p>{job.error}</p>}</article> : <p>这一天还没有生成记录。</p>}
            </section><section><h2>读取记录</h2>{!archive.read_jobs.length && <p>暂无读取记录。</p>}
              {archive.read_jobs.map(j => <article className="wxRecord" key={j.id}><header><b>{j.kind === 'import' ? (j.status === 'imported' ? '导入成功' : '重试导入') : readStatus[j.status] || '结果待核实'}</b></header><dl>{j.started_at && <><dt>执行时间</dt><dd>{jobTime(j.started_at)}</dd></>}{j.kind !== 'import' && <><dt>读取范围</dt><dd>{j.days ? `最近 ${j.days} 天` : '从上次位置读取新增聊天'}</dd></>}</dl>{j.error && <p>{j.error}</p>}</article>)}
            </section></details>
          </div>}
          {archive && (!local || page === 'reading') && <>
            <header className="wxHeading"><h1>{group?.name}</h1></header>
            <div className="wxReadingControls"><div className="wxViewTabs"><button aria-pressed={mode === 'summary'} onClick={() => changeMode('summary')}>聊天总结</button><button aria-pressed={mode === 'messages'} onClick={() => changeMode('messages')}>聊天原文</button></div>
              {mode === 'messages' && (from !== date || to !== date) ? <div className="wxDateRange"><span>{from === to ? from : `${from} — ${to}`}</span><button onClick={() => selectDate(date)}>返回单日</button></div> : <label>聊天日期 <select value={date} onChange={e => selectDate(e.target.value)} aria-label="聊天日期">{[...days].reverse().map(d => <option key={d.date}>{d.date}</option>)}</select></label>}
              {mode === 'summary' ? local && <button className="wxGenerate" disabled={busy || readBusy || !selectedDay?.summarizable} onClick={() => confirm('generate')}>{summary?.status === 'ready' ? '重新总结' : '生成总结'}</button> : <button onClick={toggleFilters} aria-expanded={filtersOpen}>筛选{member || keyword || from !== date || to !== date ? ' · 已启用' : ''}</button>}
            </div>
            {mode === 'messages' && filtersOpen && <form className="wxFilters" onSubmit={e => { e.preventDefault(); setFrom(filterDates.from); setTo(filterDates.to); messagePosition.current = 0; setMessagePage(null); }}>
              <label>开始日期<select aria-label="开始日期" value={filterDates.from} onChange={e => setFilterDates(current => ({ from: e.target.value, to: current.to < e.target.value ? e.target.value : current.to }))}>{days.map(d => <option key={d.date}>{d.date}</option>)}</select></label><label>结束日期<select aria-label="结束日期" value={filterDates.to} onChange={e => setFilterDates(current => ({ ...current, to: e.target.value }))}>{days.filter(d => d.date >= filterDates.from).map(d => <option key={d.date}>{d.date}</option>)}</select></label>
              <label>成员<select value={member} onChange={e => setMember(e.target.value)}><option value="">所有成员</option>{archive.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
              <label>关键词<input value={keyword} onChange={e => setKeyword(e.target.value)} maxLength={200} placeholder="搜索已保存消息" /></label><button type="submit">应用筛选</button>
            </form>}
            {mode === 'summary' ? <>
              {job && (job.status !== 'complete' || updated) && <div className="wxJobStatus" role="status">{job.status === 'complete' ? '新总结已完成' : job.error || statusText[job.status]}{updated && <button onClick={() => setRefresh(n => n + 1)}>查看新总结</button>}</div>}
              {summary?.stale && <p className="wxNotice">归档有更新，当前总结尚未包含新增消息。</p>}
              {summary?.partial && summary.coverage_end && <p className="wxNotice">总结截至 {timeOf(summary.coverage_end)}</p>}
              {loading ? <p className="wxEmpty">正在读取总结…</p> : summaryError ? <p className="wxError">{summaryError}</p> : !summary?.summary ? <p className="wxEmpty">{selectedDay?.partial ? `聊天已读取至 ${clockOf(selectedDay.coverage_end)}，${local ? '可以生成当前总结。' : '请在电脑生成总结。'}` : selectedDay && !selectedDay.summarizable ? '这一天的聊天未完整读取，请在电脑补充读取。' : '这一天尚无总结。'}</p> :
                <div className="wxSummaryGrid"><nav className="wxTopics" aria-label="当日话题"><button className="wxTopicToggle" onClick={() => setDirectoryOpen(v => !v)} aria-expanded={directoryOpen}>切换话题 ▾</button><div className={directoryOpen ? 'wxTopicOptions isOpen' : 'wxTopicOptions'}>{summary.summary.topics.map((t, index) => <button key={index} aria-current={topicIndex === index ? 'true' : undefined} onClick={() => selectTopic(index)}>{t.navigation_title || t.title}</button>)}</div></nav>
                  <div className="wxTopicReading" ref={reading} tabIndex={0}>{topic && <article><h2><Prose text={topic.title} people={people} /></h2><p className="wxTopicLead"><Prose text={topic.summary} people={people} /></p>
                    {topic.blocks?.map((block, index) => <section key={index} className="wxDiscussion"><h3>{block.heading}</h3>{block.speaker && <Person name={people[block.speaker] || block.speaker} />}<p><Prose text={block.text} people={people} /></p>
                      {index === Math.min(1, topic.blocks!.length - 1) && topic.comparisons?.length ? <div className="wxComparisons">{topic.comparisons.map(c => <div key={c.heading}><h4>{c.heading}</h4><p><Prose text={c.text} people={people} /></p></div>)}</div> : null}</section>)}
                    {topic.details && <p><Prose text={topic.details} people={people} /></p>}{topic.views?.map((view, index) => <p key={index}><Person name={people[view.speaker] || view.speaker} /> <Prose text={view.text} people={people} /></p>)}
                    {summary.summary.format_version < 2 && [...new Set([...(topic.points || []), topic.outcome].filter(Boolean))].map((point, index) => <p key={index}><Prose text={point} people={people} /></p>)}
                    {topic.quotes?.map((quote, index) => <figure className="wxQuote" key={index}><figcaption><Person name={people[quote.speaker] || quote.speaker} /><time>{quote.time}</time><span>原话节选</span></figcaption><blockquote>“{quote.text}”</blockquote></figure>)}
                    {topic.progress && <p className="wxProgress"><b>讨论进展</b> <Prose text={topic.progress} people={people} /></p>}
                    <button className="wxTextButton" onClick={() => void openOriginal(topicIndex)}>{topic.discussion_complete ? '核对完整讨论' : '核对原文节选'}（{topic.discussion_count}）</button>
                    <div className="wxTopicPaging"><button disabled={!topicIndex} onClick={() => selectTopic(topicIndex - 1)}>上个话题</button><button disabled={topicIndex === summary.summary.topics.length - 1} onClick={() => selectTopic(topicIndex + 1)}>下个话题</button></div>
                  </article>}</div></div>}
            </> : <div className="wxMessages" ref={messages} tabIndex={0}>{messageError && <p className="wxError">{messageError}</p>}{messagePage && <p className="wxResultCount">{messagePage.total} 条匹配消息</p>}{renderMessages(messagePage?.messages || [], true)}{messagesLoading ? <p>正在读取…</p> : messagePage?.next != null ? <button onClick={() => void loadMessages(true)}>继续阅读</button> : messagePage?.total === 0 ? <p>没有符合条件的已保存消息。</p> : null}</div>}
          </>}
          </div>
          {overlay && <div className="wxOverlay" role="dialog" aria-label={overlay.title} inert={Boolean(confirmation)}><header><h2>{overlay.title}</h2><button onClick={() => { originalSequence.current++; setOverlay(null); requestAnimationFrame(() => (mode === 'summary' ? reading.current : messages.current)?.focus({ preventScroll: true })); }}>返回阅读</button></header>
            <div className="wxSourcePane" ref={sourcePane} tabIndex={0}>{overlay.loading ? <p>正在读取原文…</p> : overlay.error ? <p className="wxError">{overlay.error}</p> : <>
              {overlay.kind === 'original' && <p className="wxNotice">{overlay.data?.complete ? `完整讨论 · ${overlay.data.total} 条 · 按时间排序` : `旧版原文节选 · ${overlay.data?.total} 条`} {!overlay.data?.complete && <button onClick={() => { originalSequence.current++; setOverlay(null); changeMode('messages'); }}>查看聊天原文</button>}</p>}
              {renderMessages(overlay.data?.messages || [])}</>}</div></div>}
          {confirmation && <div className="wxConfirmBackdrop"><section role="dialog" aria-label={confirmation === 'generate' ? '确认生成总结' : '确认读取'} className="wxConfirm"><h2>{confirmation === 'generate' ? '生成聊天总结' : confirmation === 'import' ? '重试导入已保存归档' : '读取当前群'}</h2>
            <p>{group?.name}</p>{confirmation === 'generate' ? <><p>{date}{selectedDay?.partial ? ` · 00:00 至 ${clockOf(selectedDay.coverage_end)}` : ' · 全天'}</p><label>总结模型<select value={generationMode} onChange={e => setGenerationMode(e.target.value)}><option value="deepseek">DeepSeek-V4.1-Flash · high</option><option value="low">GLM-5.3-Flash · low</option><option value="high">Hy4 preview · high</option></select></label><p>通过官方 CodeBuddy 调用，使用 WorkBuddy 积分。旧总结与费用记录会保留。</p></> : <p>{confirmation === 'import' ? '重试导入已保存的聊天。' : `${readDays === 'incremental' ? '读取新增聊天' : `读取最近 ${readDays} 天的聊天`}，请保持电脑微信已登录。本次只读取，不调用 AI。`}</p>}
            {error && <p className="wxError">{error}</p>}<div className="wxActions"><button disabled={submitting} onClick={() => setConfirmation(null)}>取消</button><button disabled={submitting} onClick={() => void execute()}>{submitting ? '正在提交…' : '确认执行'}</button></div>
          </section></div>}
        </main>
      </div>
  </section>;
}
