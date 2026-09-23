/** A narrow JSON gateway. Never proxy arbitrary URLs, credentials, or local admin routes. */
export type HostProxyEnvironment = {
  HOST_SERVICE?: { fetch(request: Request): Promise<Response> };
  HOST_PUBLIC_ORIGIN?: string;
};

const COOKIE_NAME = 'douyin_monitor_session';
const MAX_BODY_BYTES = 64 * 1024;
const GET_PATHS = new Set(['/health', '/api/auth/status', '/api/state', '/api/jobs', '/api/qwen', '/api/qwen/status']);
const POST_PATHS = new Set(['/api/auth/login', '/api/auth/logout', '/api/accounts/upsert', '/api/accounts/remove', '/api/accounts/ack-updates', '/api/video-links/analyze', '/api/jobs']);

function errorResponse(status: number, error: string, upstreamStatus?: number): Response {
  return Response.json({ ok: false, error, ...(upstreamStatus ? { upstreamStatus } : {}) }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function proxyHostRequest(request: Request, env: HostProxyEnvironment): Promise<Response> {
  const url = new URL(request.url);
  // Only the configured production origin may operate this computer. Preview
  // deployments and arbitrary Host headers cannot borrow its credentials.
  if (!env.HOST_PUBLIC_ORIGIN || !env.HOST_SERVICE) {
    return errorResponse(503, '网站尚未完成电脑后台连接配置。请先完成 Cloudflare 隧道和后台配对。');
  }
  if (url.protocol !== 'https:' || url.origin !== env.HOST_PUBLIC_ORIGIN) {
    return errorResponse(403, '请从正式工作台网址访问电脑后台');
  }
  if (!url.pathname.startsWith('/host/')) return errorResponse(404, '接口不存在');
  const path = url.pathname.slice('/host'.length);
  const allowed = request.method === 'GET'
    ? GET_PATHS.has(path) || /^\/api\/jobs\/[a-zA-Z0-9_-]+$/.test(path)
    : request.method === 'POST' && (POST_PATHS.has(path) || /^\/api\/jobs\/[a-zA-Z0-9_-]+\/cancel$/.test(path));
  if (!allowed) return errorResponse(403, '此操作只能在电脑的 localhost 工作台执行，或接口不受支持');
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== url.origin) || (site && !['same-origin', 'none'].includes(site)) || (request.method === 'POST' && origin !== url.origin)) {
    return errorResponse(403, '不允许的网页来源');
  }

  const headers = new Headers({
    Origin: env.HOST_PUBLIC_ORIGIN,
    'X-Workbench-Client-IP': request.headers.get('CF-Connecting-IP') || 'unknown',
  });
  const cookie = (request.headers.get('Cookie') || '').split(';').map(part => part.trim())
    .find(part => new RegExp(`^${COOKIE_NAME}=[a-zA-Z0-9_-]{32,256}$`).test(part));
  if (cookie) headers.set('Cookie', cookie);
  const csrf = request.headers.get('X-CSRF-Token');
  if (csrf && /^[a-zA-Z0-9_-]{32,256}$/.test(csrf)) headers.set('X-CSRF-Token', csrf);

  // Job creation already uses database deduplication. Never retry a POST here:
  // a timeout does not prove that the host did not accept it.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  try {
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === 'POST') {
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return errorResponse(415, '请求必须使用 application/json');
      }
      if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return errorResponse(413, '请求内容过大');
      const reader = request.body?.getReader();
      if (!reader) return errorResponse(400, '请求内容不能为空');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BODY_BYTES) { await reader.cancel(); return errorResponse(413, '请求内容过大'); }
          chunks.push(chunk.value);
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
      signal.throwIfAborted();
      if (!size) return errorResponse(400, '请求内容不能为空');
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      headers.set('Content-Type', 'application/json');
      headers.set('Content-Length', String(size));
    }
    const target = new URL(`http://127.0.0.1:43130${path}`);
    // No arbitrary parameters are forwarded; only the existing jobs page limit.
    if (path === '/api/jobs' && request.method === 'GET' && url.searchParams.has('limit')) {
      const limit = url.searchParams.get('limit') || '';
      if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) return errorResponse(400, '任务数量范围无效');
      target.searchParams.set('limit', limit);
    }
    const upstream = await env.HOST_SERVICE.fetch(new Request(target, { method: request.method, headers, body, redirect: 'manual', signal }));
    if ((upstream.status >= 300 && upstream.status < 400) || !upstream.headers.get('Content-Type')?.includes('application/json')) {
      await upstream.body?.cancel();
      if (upstream.status >= 500) return errorResponse(503, '电脑连接通道暂时不可用，请确认电脑工作台和隧道正在运行。', upstream.status);
      return errorResponse(502, '电脑连接通道返回了无效响应，请检查后台与隧道状态');
    }
    const responseHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    // The host emits only its own session cookie. Do not forward any other
    // upstream headers (CORS, internal addresses, tunnel credentials, etc.).
    const setCookie = upstream.headers.get('Set-Cookie');
    if (setCookie?.startsWith(`${COOKIE_NAME}=`)) responseHeaders.set('Set-Cookie', setCookie);
    const retryAfter = upstream.headers.get('Retry-After');
    if (retryAfter && /^\d+$/.test(retryAfter)) responseHeaders.set('Retry-After', retryAfter);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    // Do not expose exception text: transports can include headers and tokens.
    return errorResponse(503, request.method === 'POST'
      ? '电脑后台未响应，任务可能已经提交。请恢复连接后查看任务状态，避免重复提交。'
      : '电脑后台暂时无法连接。请确认电脑已开机、未休眠，并已启动工作台和连接通道。');
  }
}
