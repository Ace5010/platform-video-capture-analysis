/** A fixed website alias. The existing Worker remains the authenticated gateway. */
export function createWebsiteEntry({ websiteOrigin, upstreamOrigin }, fetchUpstream = fetch) {
  for (const origin of [websiteOrigin, upstreamOrigin]) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('Website origins must be bare HTTPS origins');
    }
  }
  const error = (status, message) => Response.json({ ok: false, error: message }, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== websiteOrigin) return error(403, '请使用正式工作台网址');
      const api = url.pathname.startsWith('/host/');
      const origin = request.headers.get('Origin');
      const site = request.headers.get('Sec-Fetch-Site');
      if ((origin && origin !== websiteOrigin)
        || (api && site && !['same-origin', 'none'].includes(site))
        || (request.method === 'POST' && origin !== websiteOrigin)) {
        return error(403, '不允许的网页来源');
      }
      if (!['GET', 'HEAD'].includes(request.method) && !(api && request.method === 'POST')) {
        return error(405, '此操作不受支持');
      }
      // Assign path/search separately: a path starting // must never select another host.
      const target = new URL(upstreamOrigin);
      target.pathname = url.pathname;
      target.search = url.search;
      const headers = new Headers();
      for (const name of ['Accept', 'Accept-Language', 'Content-Type', 'Cache-Control',
        'If-None-Match', 'If-Modified-Since', 'Range', 'X-CSRF-Token', 'Sec-Fetch-Site']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const cookie = (request.headers.get('Cookie') || '').split(';').map(value => value.trim())
        .find(value => /^douyin_monitor_session=[a-zA-Z0-9_-]{32,256}$/.test(value));
      if (cookie) headers.set('Cookie', cookie);
      // Only after the outer origin check may the fixed upstream receive its origin.
      if (origin) headers.set('Origin', upstreamOrigin);
      try {
        const upstream = await fetchUpstream(new Request(target, {
          method: request.method, headers, body: request.body, redirect: 'manual',
          signal: request.signal, ...(request.body ? { duplex: 'half' } : {}),
        }));
        const responseHeaders = new Headers(upstream.headers);
        const location = responseHeaders.get('Location');
        if (location) {
          const redirect = new URL(location, target);
          if (redirect.origin !== upstreamOrigin) {
            await upstream.body?.cancel();
            return error(502, '网站返回了无效跳转');
          }
          responseHeaders.set('Location', websiteOrigin + redirect.pathname + redirect.search + redirect.hash);
        }
        // A host-only session cookie is stored on this website; credentials never go in URLs.
        const setCookie = responseHeaders.get('Set-Cookie');
        if (setCookie && (!setCookie.startsWith('douyin_monitor_session=') || /;\s*Domain=/i.test(setCookie))) {
          responseHeaders.delete('Set-Cookie');
        }
        if (api) responseHeaders.set('Cache-Control', 'private, no-store');
        responseHeaders.set('X-Content-Type-Options', 'nosniff');
        responseHeaders.set('Referrer-Policy', 'same-origin');
        return new Response(request.method === 'HEAD' ? null : upstream.body, {
          status: upstream.status, statusText: upstream.statusText, headers: responseHeaders,
        });
      } catch {
        return error(503, request.method === 'POST'
          ? '连接中断，请恢复后查看任务状态，避免重复提交。'
          : '暂时无法连接网站，请稍后重试。');
      }
    },
  };
}
