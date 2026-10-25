import assert from 'node:assert/strict';
import { hostApiBase } from '../lib/host-connection.ts';
import { proxyHostRequest, type HostProxyEnvironment } from '../lib/host-proxy.ts';

const origin = 'https://workbench.example';
const token = 't'.repeat(43);
const requests: Request[] = [];
let respond = async () => Response.json({ ok: true }, { headers: { 'Set-Cookie': `douyin_monitor_session=${'s'.repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Strict`, 'X-Secret': token } });
const env: HostProxyEnvironment = {
  HOST_PUBLIC_ORIGIN: origin,
  HOST_SERVICE: { async fetch(request) { requests.push(request); return respond(); } },
};
const request = (path: string, options: RequestInit = {}) => new Request(`${origin}/host${path}`, options);
const post = (extra: Record<string, string> = {}) => ({ method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: '{}' });

assert.equal(hostApiBase(), 'http://127.0.0.1:43129');
assert.equal(hostApiBase({ protocol: 'http:', hostname: '192.168.1.5', origin: 'http://192.168.1.5:3000' }), 'http://192.168.1.5:43129');
assert.equal(hostApiBase({ protocol: 'http:', hostname: '[::1]', origin: 'http://[::1]:3000' }), 'http://[::1]:43129');
assert.equal(hostApiBase({ protocol: 'https:', hostname: 'workbench.example', origin }), `${origin}/host`);
assert.equal((await proxyHostRequest(request('/api/auth/status'), {})).status, 503);
assert.equal((await proxyHostRequest(new Request('https://preview.example/host/api/state'), env)).status, 403);
for (const path of ['/api/qwen/config', '/api/auth/setup', '/api/migrate', '/api/browser/open', '/connector/poll', '/api/jobs/id/../../qwen/config']) {
  assert.equal((await proxyHostRequest(request(path, post()), env)).status, 403, path);
}
assert.equal((await proxyHostRequest(request('/api/jobs', post({ Origin: 'https://evil.example' })), env)).status, 403);
assert.equal((await proxyHostRequest(request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env)).status, 403);
assert.equal((await proxyHostRequest(request('/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), env)).status, 403);
assert.equal((await proxyHostRequest(request('/api/jobs', { ...post(), body: 'a'.repeat(65537) }), env)).status, 413);
assert.equal((await proxyHostRequest(request('/api/jobs', { ...post(), headers: { Origin: origin, 'Content-Type': 'text/plain' } }), env)).status, 415);
assert.equal(requests.length, 0, 'invalid requests reached the host');

const response = await proxyHostRequest(request('/api/state?target=https://evil.example', { headers: {
  Cookie: `other=private; douyin_monitor_session=${'s'.repeat(43)}`,
  Authorization: 'Bearer never-forward', 'X-Workbench-Gateway': 'forged',
  'X-Workbench-Client-IP': '127.0.0.1', 'CF-Connecting-IP': '198.51.100.8',
} }), env);
assert.equal(response.status, 200);
assert.equal(requests[0].url, 'http://127.0.0.1:43130/api/state');
assert.equal(requests[0].headers.get('X-Workbench-Gateway'), null);
assert.equal(requests[0].headers.get('X-Workbench-Client-IP'), '198.51.100.8');
assert.equal(requests[0].headers.get('Cookie'), `douyin_monitor_session=${'s'.repeat(43)}`);
assert.equal(requests[0].headers.get('Authorization'), null);
assert.equal(requests[0].headers.get('Origin'), origin);
assert.equal(response.headers.get('X-Secret'), null);
assert.equal(response.headers.get('Cache-Control'), 'no-store');
assert.match(response.headers.get('Set-Cookie') || '', /Secure/);
assert.equal((await proxyHostRequest(request('/api/jobs?limit=999'), env)).status, 400);
await proxyHostRequest(request('/api/jobs?limit=50'), env);
assert.equal(requests.at(-1)?.url, 'http://127.0.0.1:43130/api/jobs?limit=50');

await proxyHostRequest(request('/api/jobs', post({ 'X-CSRF-Token': 'c'.repeat(64) })), env);
assert.equal(requests.at(-1)?.headers.get('Content-Length'), '2');
assert.equal(await requests.at(-1)?.text(), '{}');
assert.equal(requests.at(-1)?.headers.get('X-CSRF-Token'), 'c'.repeat(64));

const clearBody = JSON.stringify({ videoIds: ['7530000000000000001', '7530000000000000002'] });
assert.equal((await proxyHostRequest(request('/api/discoveries/clear', {
  ...post({ 'X-CSRF-Token': 'c'.repeat(64) }), body: clearBody,
}), env)).status, 200);
assert.equal(requests.at(-1)?.url, 'http://127.0.0.1:43130/api/discoveries/clear');
assert.equal(requests.at(-1)?.headers.get('X-CSRF-Token'), 'c'.repeat(64));
assert.equal(await requests.at(-1)?.text(), clearBody);
const clearRequestCount = requests.length;
assert.equal((await proxyHostRequest(request('/api/discoveries/clear'), env)).status, 403);
assert.equal((await proxyHostRequest(request('/api/discoveries/clear', post({ Origin: 'https://evil.example' })), env)).status, 403);
assert.equal(requests.length, clearRequestCount, 'invalid clear requests must not reach the host');

const count = requests.length;
respond = async () => { throw new Error(`transport error with secret ${token}`); };
const failed = await proxyHostRequest(request('/api/jobs', post()), env);
assert.equal(failed.status, 503);
const failureText = await failed.text();
assert.match(failureText, /可能已经提交/);
assert.ok(!failureText.includes(token));
assert.equal(requests.length, count + 1, 'POST was retried after an uncertain failure');

respond = async () => new Response('moved', { status: 302, headers: { Location: 'https://evil.example' } });
assert.equal((await proxyHostRequest(request('/api/state'), env)).status, 502);
assert.equal(requests.at(-1)?.redirect, 'manual');
respond = async () => new Response('tunnel error', { status: 502 });
const offline = await proxyHostRequest(request('/api/state'), env);
assert.equal(offline.status, 503);
assert.equal((await offline.json() as { upstreamStatus: number }).upstreamStatus, 502);
respond = async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: {
  'Content-Type': 'video/mp4', 'Content-Length': '4', 'Content-Range': 'bytes 4-7/100',
  'Accept-Ranges': 'bytes', 'X-Secret': token,
} });
const previewMediaPath = '/api/previews/1234567890123456789/0123456789abcdef0123456789abcdef/media';
const media = await proxyHostRequest(request(previewMediaPath, { headers: {
  Range: 'bytes=4-7', Cookie: `douyin_monitor_session=${'s'.repeat(43)}`,
} }), env);
assert.equal(media.status, 206);
assert.equal(media.headers.get('Content-Range'), 'bytes 4-7/100');
assert.equal(media.headers.get('X-Secret'), null);
assert.equal(requests.at(-1)?.headers.get('Range'), 'bytes=4-7');
assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [1, 2, 3, 4]);
assert.equal((await proxyHostRequest(request(previewMediaPath, { headers: { Range: 'bytes=1-2,4-5' } }), env)).status, 416);
assert.equal((await proxyHostRequest(request('/api/previews/invalid/0123456789abcdef0123456789abcdef/media'), env)).status, 403);
assert.equal((await proxyHostRequest(request('/api/previews/1234567890123456789/ZZZZ/media'), env)).status, 403);
assert.equal((await proxyHostRequest(request('/api/media/1234567890123456789', { headers: { Range: 'bytes=4-7' } }), env)).status, 403,
  'the retired local-file media route must no longer be reachable');
// A status read must never forward the Range header, while a prepare POST is a
// normal bounded JSON request.
respond = async () => Response.json({ ok: true, sources: [] });
const prepared = await proxyHostRequest(request('/api/previews/prepare', post({ 'X-CSRF-Token': 'c'.repeat(64) })), env);
assert.equal(prepared.status, 200);
assert.equal(requests.at(-1)?.url, 'http://127.0.0.1:43130/api/previews/prepare');
respond = async () => Response.json({ ok: true, status: 'ready', generation: '0123456789abcdef0123456789abcdef' });
const previewStatus = await proxyHostRequest(request('/api/previews/1234567890123456789/status'), env);
assert.equal(previewStatus.status, 200);
assert.equal(requests.at(-1)?.url, 'http://127.0.0.1:43130/api/previews/1234567890123456789/status');
assert.equal(requests.at(-1)?.headers.get('Range'), null, 'a status read must not carry a media range');
respond = async () => new Response(null, { status: 200, headers: {
  'Content-Type': 'video/mp4', 'Content-Length': '100', 'Accept-Ranges': 'bytes',
} });
assert.equal((await proxyHostRequest(request(previewMediaPath, { method: 'HEAD' }), env)).status, 200);
assert.equal((await proxyHostRequest(request('/api/previews/1234567890123456789/status', { method: 'HEAD' }), env)).status, 403);
console.log('HTTPS 主机网关检查通过：来源、白名单、Cookie、凭据隔离、请求限制、按需播放路由与失败不重发。');

respond = async () => Response.json({ ok: true, messages: [] });
for (const [path, query] of [
  ['/api/wechat/context', ''],
  ['/api/wechat/days', '?group=group_test'],
  ['/api/wechat/summary', '?group=group_test&date=2026-10-24'],
  ['/api/wechat/original', '?group=group_test&date=2026-10-24&topic=2'],
]) {
  assert.equal((await proxyHostRequest(request(path+query+(query?'&':'?')+'target=private'), env)).status, 200);
  assert.equal(requests.at(-1)?.url, 'http://127.0.0.1:43130'+path+query);
}
assert.equal((await proxyHostRequest(request('/api/wechat/search', post({'X-CSRF-Token':'c'.repeat(64)})), env)).status,200);
assert.equal(requests.at(-1)?.headers.get('X-CSRF-Token'),'c'.repeat(64));
const beforeRestrictedWeChat=requests.length;
for (const path of ['/api/wechat/read','/api/wechat/generate','/api/wechat/generation','/api/wechat/config','/api/wechat/export']) {
  assert.equal((await proxyHostRequest(request(path), env)).status,403);
  assert.equal((await proxyHostRequest(request(path, post()), env)).status,403);
}
assert.equal(requests.length,beforeRestrictedWeChat);
for (const query of ['?group=../private','?group=group_test&date=invalid','?group=group_test&date=2026-10-24&topic=-1','?group=group_test&group=other']) {
  assert.equal((await proxyHostRequest(request('/api/wechat/original'+query),env)).status,400);
}
assert.equal((await proxyHostRequest(request('/api/wechat/search',post({Origin:'https://untrusted.example'})),env)).status,403);
console.log('WeChat gateway passed: exact saved-read routes, preserved group/date/topic, CSRF search and blocked management.');
