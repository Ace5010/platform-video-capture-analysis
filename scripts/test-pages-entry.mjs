import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createWebsiteEntry } from '../lib/pages-entry.mjs';
import { proxyHostRequest } from '../lib/host-proxy.ts';

const websiteOrigin = 'https://workbench.pages.dev';
const upstreamOrigin = 'https://workbench.owner.workers.dev';
const session = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const calls = [];
const hostCalls = [];
let offline = false;
const entry = createWebsiteEntry({ websiteOrigin, upstreamOrigin }, async request => {
  calls.push(request);
  assert.equal(new URL(request.url).origin, upstreamOrigin);
  if (offline) throw new Error('private transport diagnostic');
  if (!new URL(request.url).pathname.startsWith('/host/')) {
    return new Response('website', { headers: { 'Content-Type': 'text/html', ETag: 'fixture' } });
  }
  return proxyHostRequest(request, {
    HOST_PUBLIC_ORIGIN: upstreamOrigin,
    HOST_SERVICE: { fetch: async target => {
      const body = target.method === 'POST' ? await target.text() : null;
      hostCalls.push({ target, body });
      if (new URL(target.url).pathname === '/api/auth/login') {
        return Response.json({ ok: true }, { headers: { 'Set-Cookie': `douyin_monitor_session=${session}; HttpOnly; Secure; SameSite=Strict; Path=/` } });
      }
      if (target.headers.get('Cookie') !== `douyin_monitor_session=${session}`) return Response.json({ error: 'login required' }, { status: 401 });
      if (new URL(target.url).pathname.endsWith('/media')) {
        assert.equal(target.headers.get('Range'), 'bytes=0-3');
        return new Response(target.method === 'HEAD' ? null : 'mp4!', { status: 206,
          headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 0-3/100', 'Content-Length': '4' } });
      }
      return Response.json({ ok: true, records: ['existing-record'] });
    } },
  });
});
const request = (path, options) => new Request(websiteOrigin + path, options);
const headers = { Origin: websiteOrigin, Cookie: `unrelated=private; douyin_monitor_session=${session}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
assert.equal(await (await entry.fetch(request('/'))).text(), 'website');
assert.equal((await entry.fetch(request('/host/api/state'))).status, 401);
const state = await entry.fetch(request('/host/api/state', { headers }));
assert.deepEqual(await state.json(), { ok: true, records: ['existing-record'] });
assert.equal(state.headers.get('Cache-Control'), 'private, no-store');
assert.equal(hostCalls.at(-1).target.headers.get('Cookie'), `douyin_monitor_session=${session}`);
assert.equal(hostCalls.at(-1).target.headers.get('Origin'), upstreamOrigin);
assert.equal(hostCalls.at(-1).target.headers.get('X-CSRF-Token'), csrf);
const login = await entry.fetch(request('/host/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password: 'isolated-test' }) }));
assert.match(login.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Strict; Path=\//);
assert.equal(hostCalls.at(-1).body, JSON.stringify({ password: 'isolated-test' }));
for (const method of ['GET', 'HEAD']) {
  const media = await entry.fetch(request('/host/api/previews/123/1234abcd/media', { method, headers: { ...headers, Range: 'bytes=0-3' } }));
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('Content-Range'), 'bytes 0-3/100');
  assert.equal(await media.text(), method === 'HEAD' ? '' : 'mp4!');
}
const before = calls.length;
for (const blocked of [
  new Request('https://preview.workbench.pages.dev/host/api/state'),
  request('/host/api/state', { headers: { Origin: 'https://other.test' } }),
  request('/host/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
  request('/host/api/jobs', { method: 'POST', body: '{}' }),
  request('/host/api/jobs', { method: 'POST', headers: { Origin: 'null' }, body: '{}' }),
  request('/', { method: 'POST', headers, body: '{}' }),
  request('/host/api/jobs', { method: 'DELETE', headers }),
]) assert.ok([403, 405].includes((await entry.fetch(blocked)).status));
assert.equal(calls.length, before, 'rejected requests must not leave this entry');
assert.equal((await entry.fetch(request('/host/api/qwen/config', { headers }))).status, 403);
await entry.fetch(request('//attacker.test/example?next=https://attacker.test'));
assert.equal(new URL(calls.at(-1).url).origin, upstreamOrigin, 'path/query must not choose an upstream');
offline = true;
const count = calls.length;
const failure = await entry.fetch(request('/host/api/jobs', { method: 'POST', headers, body: '{}' }));
assert.equal(failure.status, 503);
assert.equal(calls.length, count + 1, 'never retry a possibly accepted write');
assert.doesNotMatch(await failure.text(), /private transport diagnostic/);
for (const location of ['https://other.test/login', upstreamOrigin + '/login']) {
  const redirectEntry = createWebsiteEntry({ websiteOrigin, upstreamOrigin }, async () => Response.redirect(location));
  const result = await redirectEntry.fetch(request('/'));
  if (location.startsWith(upstreamOrigin)) assert.equal(result.headers.get('Location'), websiteOrigin + '/login');
  else assert.equal(result.status, 502);
}
console.log('Pages entry passed: fixed upstream, login/session/CSRF, real gateway restrictions, streamed media, preview/cross-origin rejection, no write retry. Isolated interfaces only.');

const builtConfig = JSON.parse(await readFile(new URL('../cloudflare-pages.json', import.meta.url), 'utf8'));
const originalConfig = JSON.parse(await readFile(new URL('../cloudflare-host.json', import.meta.url), 'utf8'));
const runtime = new Miniflare({
  cf: false, modules: true, scriptPath: 'outputs/cloudflare-pages/_worker.js', compatibilityDate: '2026-05-15',
  outboundService: async request => {
    assert.equal(new URL(request.url).origin, originalConfig.publicOrigin);
    if (request.method === 'POST') {
      assert.equal(request.headers.get('Origin'), originalConfig.publicOrigin);
      assert.equal(await request.text(), '{"fixture":true}');
    }
    return Response.json({ fixture: true });
  },
});
try {
  assert.equal((await runtime.dispatchFetch(builtConfig.publicOrigin)).status, 200);
  const post = await runtime.dispatchFetch(builtConfig.publicOrigin + '/host/api/jobs', {
    method: 'POST', headers: { Origin: builtConfig.publicOrigin, 'Content-Type': 'application/json' }, body: '{"fixture":true}',
  });
  assert.equal(post.status, 200);
  assert.equal((await runtime.dispatchFetch('https://preview.test/host/api/state')).status, 403);
  console.log('Built Pages entry passed the Workers runtime with isolated upstream, including streamed POST and production-origin restriction.');
} finally { await runtime.dispose(); }
