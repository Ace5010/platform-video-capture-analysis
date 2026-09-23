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
assert.equal((await proxyHostRequest(request('/api/state'), env)).status, 502);
console.log('HTTPS 主机网关检查通过：来源、白名单、Cookie、凭据隔离、请求限制与失败不重发。');
