import http from 'node:http';
import net from 'node:net';

// Isolated browser QA: only front-end GET/HEAD resources reach the existing dev server.
// The host API, writes, and saved user data are never forwarded by this service.
const capturedAt = '2026-09-23T09:00:00Z';
const previousCapture = '2026-09-22T09:00:00Z';
const completeAnalysis = {
  schemaVersion: 'remotion-plan-v3',
  contentAnalysis: {
    quickOverview: '模拟结果：作者想说明，选择视频压缩设置时需要同时看文件体积和实际画质。他用同一段包含人物与字幕的素材，对比两种导出配置：第二种配置生成的文件更小，但放大字幕边缘时可以看到细节差异。作者认为，普通分享场景可以考虑体积更小的配置，需要保留细小文字时则应先检查导出效果。\n\n他先展示原片和两份导出文件，解释比较时要使用相同素材，并区分分辨率与码率这两个设置。接着把结果并排放置，观察正常播放和局部放大时的区别。作者特别提醒，只看文件大小不能说明哪一种配置更好，使用场景和画面内容也会影响取舍。\n\n最后，作者给出的做法是先用有代表性的小片段试导出，检查字幕、人物边缘和运动画面，再决定是否用于整条视频。这次演示只涉及一段素材，不能直接得出所有素材都适用同一配置的结论。以上为隔离界面验收文本，并非真实模型产出。',
    keyInformation: '作者展示原片和两份导出文件，并逐项说明分辨率、码率和文件大小。数值仅用于界面验收。',
    claimsAndEvidence: '',
    visualDemonstrations: '左右并排展示字幕和人物边缘，再放大观察；AI 推断较低码率可能影响细节，不能据此确认所有素材都有相同效果。',
    scopeAndLimits: '只有一段素材和一台设备，未验证其他编码器、屏幕和网络环境；保留原视频核对入口。',
  },
  projectSettings: '复现建议：1920 × 1080，30 fps。实际源文件参数尚未核实。',
  assetList: '需要原片、两份导出结果、参数截图及完整口播。这里没有实际媒体文件。',
  shotTimeline: '开头说明比较对象；中段并排展示；结尾列出适用范围。',
  visualDesign: '黑白灰背景，左右对比画面，关键参数置于各自画面下方。',
  motionAndTransitions: '对比区域依次淡入，局部细节平滑放大；切换时保持字幕位置稳定。',
  audioAndCaptions: '保留完整口播，字幕按语义换行；时间轴需要使用真实音轨核对。',
  productionSteps: '建立画布、排布对比区域、补齐字幕，最后核对参数、音画同步和缩放可读性。',
  uncertainties: '原视频转场曲线和原始编码参数无法从演示画面确认。',
};

const conciseAnalysis = { ...completeAnalysis, contentAnalysis: {
  quickOverview: '模拟结果：作者说明录屏前应先关闭桌面通知，避免通知遮挡操作区域，也避免意外录入私人消息。',
  keyInformation: '', claimsAndEvidence: '', visualDemonstrations: '', scopeAndLimits: '',
} };

function makeVideo(id, accountId, day, likeCount, extra = {}) {
  return {
    id, accountId, title: `模拟视频 ${id}：字幕与画面呈现比较`, description: '隔离验收内容，不是真实采集记录。',
    url: `https://www.douyin.com/video/${id}`, coverUrl: null,
    publishedAt: `2026-09-${String(day).padStart(2, '0')}T08:00:00Z`, durationSeconds: 128,
    likeCount, commentCount: likeCount === null ? null : Math.floor(likeCount / 10),
    favoriteCount: likeCount === null ? 18 : Math.floor(likeCount / 4),
    shareCount: likeCount === null ? null : Math.floor(likeCount / 20),
    authorName: accountId === 'fixture-a' ? '模拟账号甲' : '模拟账号乙',
    authorAvatarUrl: null, authorProfileUrl: null, isLinkAnalysis: false,
    capturedAt, firstSeenAt: capturedAt, lastSeenAt: capturedAt,
    transcript: null, transcriptStatus: 'idle', transcriptError: null,
    analysis: null, analysisStatus: 'idle', analysisError: null, analysisRuns: [],
    ...extra,
  };
}

const transcript = '这是隔离验收使用的完整口播示例。我们先看同一段素材，再比较两种压缩设置。画面里展示了文件大小和字幕边缘，但这一次只测试了一段素材，不能直接推断所有场景。';
const accountAVideos = [120, null, 0, 460, 280, 720, 510].map((likes, index) => makeVideo(
  `900000000000000000${index + 1}`, 'fixture-a', 15 + index, likes,
  index === 6 ? { title: '两种压缩配置：同一素材的画质对比', transcript, transcriptStatus: 'ready', analysis: completeAnalysis, analysisStatus: 'ready', analysisUpdatedAt: capturedAt }
    : index === 3 ? { title: '仅口播已完成：字幕布局演示', transcript, transcriptStatus: 'ready', analysisStatus: 'error', analysisError: '模拟记录：内容分析保存前失败，口播已保留。' }
      : {},
));
const accountBVideos = [80, 160].map((likes, index) => makeVideo(
  `900000000000000001${index + 1}`, 'fixture-b', 18 + index, likes,
  index === 1 ? { title: '账号乙历史结果：录屏与字幕流程', transcript, transcriptStatus: 'ready', analysis: conciseAnalysis, analysisStatus: 'ready' } : {},
));
const videos = [...accountAVideos, ...accountBVideos];
const linkVideo = makeVideo('9000000000000000021', '__video_link_analysis__', 22, 340, {
  title: '独立链接记录：桌面操作演示', authorName: '模拟链接作者', isLinkAnalysis: true,
  linkAddedAt: capturedAt, linkSourceUrl: 'https://www.douyin.com/video/9000000000000000021',
  transcript, transcriptStatus: 'ready', analysis: completeAnalysis, analysisStatus: 'ready',
});
const data = {
  accounts: [
    { id: 'fixture-a', name: '模拟账号甲', platform: 'douyin', url: 'https://www.douyin.com/user/fixture-a',
      addedAt: previousCapture, status: 'ready', initialSyncStatus: 'complete', initialSyncCompletedAt: previousCapture,
      lastCheckedAt: capturedAt, lastSuccessAt: capturedAt, latestVideoIds: accountAVideos.slice(-5).reverse().map((video) => video.id),
      latestCheckNewVideoCount: 1, latestCheckNewVideoIds: [accountAVideos.at(-1).id], collectionError: null, currentSyncMode: null },
    { id: 'fixture-b', name: '模拟账号乙', platform: 'douyin', url: 'https://www.douyin.com/user/fixture-b',
      addedAt: previousCapture, status: 'error', initialSyncStatus: 'complete', initialSyncCompletedAt: previousCapture,
      lastCheckedAt: capturedAt, lastSuccessAt: previousCapture, latestVideoIds: accountBVideos.map((video) => video.id),
      latestCheckNewVideoCount: 0, latestCheckNewVideoIds: [], collectionError: '模拟采集错误：账号页面要求重新登录；已保存结果仍可阅读。', currentSyncMode: null },
  ],
  videos,
  linkVideos: [linkVideo],
  snapshots: videos.flatMap((video) => [previousCapture, capturedAt].map((time, index) => ({
    accountId: video.accountId, videoId: video.id, capturedAt: time,
    ...Object.fromEntries(['likeCount', 'commentCount', 'favoriteCount', 'shareCount'].map((metric) => [
      metric, video[metric] === null ? null : index ? video[metric] : Math.floor(video[metric] * 0.75),
    ])),
  }))),
  browser: { mode: 'dedicated_browser', error: null },
  connector: { connected: true, capabilities: ['analyze_video'], workerStatus: 'ready' },
  lanUrls: [],
};

function browserFixture(fixtureData) {
  const nativeFetch = window.fetch.bind(window);
  const qa = { requests: [], errors: [], data: fixtureData, isolated: true };
  window.__workspaceQa = qa;
  const redact = (value) => typeof value === 'string'
    ? value.replace(/(Bearer\s+)\S+/gi, '$1[redacted]').replace(/((?:api[-_]?key|access[-_]?token|password|cookie|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [/cookie|authorization|token|password|secret|api.?key/i.test(key) ? key : key, /cookie|authorization|token|password|secret|api.?key/i.test(key) ? '[redacted]' : Array.isArray(item) ? item.map(redact) : redact(item)]))
      : value;
  const syncReport = () => {
    let report = document.getElementById('workspace-fixture-report');
    if (!report) {
      report = document.createElement('output');
      report.id = 'workspace-fixture-report';
      report.hidden = true;
      document.head.appendChild(report);
    }
    report.textContent = JSON.stringify({
      errors: qa.errors,
      requests: qa.requests.filter((request) => !['GET', 'HEAD'].includes(request.method)),
    });
  };
  syncReport();
  window.addEventListener('error', (event) => {
    qa.errors.push({ type: 'error', message: redact(event.message), source: redact(event.filename), line: event.lineno });
    syncReport();
  });
  window.addEventListener('unhandledrejection', (event) => {
    qa.errors.push({ type: 'unhandledrejection', message: redact(String(event.reason?.message || event.reason)) });
    syncReport();
  });
  const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Workspace-Fixture': 'true' } });
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, window.location.href);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const hostApi = url.port === '43129' || url.pathname.startsWith('/api/');
    if (!hostApi && (method === 'GET' || method === 'HEAD')) return nativeFetch(input, init);
    let body = init.body ?? (input instanceof Request ? await input.clone().text() : null);
    try { if (typeof body === 'string' && body) body = JSON.parse(body); } catch { /* Keep a non-JSON fixture request readable. */ }
    qa.requests.push({ method, path: url.pathname, body: redact(body), at: new Date().toISOString(), mocked: true });
    if (!['GET', 'HEAD'].includes(method)) syncReport();
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, configured: true, setupRequired: false, csrfToken: 'fixture-only' });
    if (url.pathname === '/api/state') return json({ state: fixtureData });
    if (url.pathname === '/api/qwen/status') return json({ configured: true });
    if (url.pathname === '/api/jobs' && method === 'GET') return json({ jobs: [] });
    if (url.pathname === '/api/jobs') return json({ job: { id: `fixture-job-${qa.requests.length}`, type: body?.type || 'fixture', status: 'succeeded', payload: body?.payload || {}, result: {}, message: '模拟请求已记录，未执行真实任务。', attemptCount: 0 } });
    if (url.pathname === '/api/video-links/analyze') return json({ reused: true, video: fixtureData.linkVideos[0] });
    return json({ ok: true, mocked: true, message: '隔离模拟响应，未连接真实主机服务。' });
  };
}

const fixtureScript = `;(${browserFixture.toString()})(${JSON.stringify(data)});`;
const respondMock = (res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Workspace-Fixture': 'true' });
  res.end(JSON.stringify({ ok: true, mocked: true, message: '隔离服务未转发此请求。' }));
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method || 'GET')) return respondMock(res);
  if (pathname === '/__workspace_fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : fixtureScript);
    return;
  }
  const headers = { ...req.headers, host: '127.0.0.1:3000', 'accept-encoding': 'identity' };
  delete headers.cookie;
  delete headers.authorization;
  const upstream = http.request({ hostname: '127.0.0.1', port: 3000, path: req.url, method: req.method, headers }, (incoming) => {
    const responseHeaders = { ...incoming.headers, 'cache-control': 'no-store' };
    delete responseHeaders['set-cookie'];
    if (!String(incoming.headers['content-type'] || '').includes('text/html')) {
      res.writeHead(incoming.statusCode || 502, responseHeaders);
      incoming.pipe(res);
      return;
    }
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8');
      if (req.method !== 'HEAD' && !/<head\b[^>]*>/i.test(html)) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('无法安全注入模拟接口，已停止加载前端。');
        return;
      }
      const port = server.address().port;
      delete responseHeaders['content-length'];
      delete responseHeaders['content-encoding'];
      delete responseHeaders.etag;
      responseHeaders['content-security-policy'] = `connect-src 'self' http://127.0.0.1:3000 http://localhost:3000 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:${port}`;
      res.writeHead(incoming.statusCode || 502, responseHeaders);
      res.end(html.replace(/<head\b[^>]*>/i, (head) => `${head}<script src="/__workspace_fixture.js"></script>`));
    });
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('前端代理超时')));
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('无法连接已运行的 127.0.0.1:3000 前端；未连接主机 API。');
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/') || req.url.startsWith('/api/')) return socket.destroy();
  const upstream = net.connect(3000, '127.0.0.1', () => {
    const headers = { ...req.headers, host: '127.0.0.1:3000' };
    delete headers.cookie;
    delete headers.authorization;
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
  console.log('模拟接口，无真实采集/模型/数据库');
});
