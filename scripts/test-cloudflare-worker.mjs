import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Miniflare } from 'miniflare';

// Exercise the deployed bundle and asset routing using the project's existing
// Workers runtime. No real tunnel, database, credentials, or model is contacted.
const server = path.resolve('dist/server');
const config = JSON.parse(await readFile(path.join(server, 'wrangler.json'), 'utf8'));
const origin = 'https://workbench.test';
const session = 's'.repeat(43);
const calls = [];
let offline = false;
const largeResult = JSON.stringify({ ok: true, analysis: 'mock history '.repeat(100_000) });
assert.deepEqual(config.assets.run_worker_first, ['/host/*']);
const modulePaths = [config.main, ...(await readdir(server, { recursive: true })).filter(file => file.endsWith('.js') && file !== config.main)];
const runtime = new Miniflare({
  cf: false,
  modules: modulePaths.map(file => ({ type: 'ESModule', path: path.join(server, file) })),
  modulesRoot: server,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  bindings: { HOST_PUBLIC_ORIGIN: origin },
  assets: {
    directory: path.resolve(server, config.assets.directory),
    binding: config.assets.binding,
    routerConfig: { has_user_worker: true, static_routing: { user_worker: config.assets.run_worker_first } },
  },
  outboundService: () => { throw new Error('External network is forbidden in this test'); },
  serviceBindings: {
    HOST_SERVICE: async request => {
      calls.push({ url: request.url, method: request.method });
      if (offline) return new Response('mock tunnel unavailable', { status: 502 });
      if (request.headers.get('Cookie') !== `douyin_monitor_session=${session}`) return Response.json({ error: 'login required' }, { status: 401 });
      return new Response(largeResult, { headers: { 'Content-Type': 'application/json' } });
    },
  },
});

try {
  const homepage = await runtime.dispatchFetch(origin);
  assert.equal(homepage.status, 200);
  assert.ok(homepage.headers.get('ETag'), 'homepage must be served as a static asset');
  assert.equal(homepage.headers.get('Set-Cookie'), null);
  assert.equal(await homepage.text(), await readFile(path.resolve(server, config.assets.directory, 'index.html'), 'utf8'));
  assert.equal(calls.length, 0, 'opening the shell called the host');

  const guest = await runtime.dispatchFetch(`${origin}/host/api/state`, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
  assert.equal(guest.status, 401, 'API navigation was replaced by the static homepage');
  assert.equal(guest.headers.get('Cache-Control'), 'no-store');
  const response = await runtime.dispatchFetch(`${origin}/host/api/state`, { headers: { Cookie: `douyin_monitor_session=${session}` } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), largeResult, 'historical results were buffered, truncated, or replaced');
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:43130/api/state');

  const count = calls.length;
  for (const url of [`${origin}/host/api/qwen/config`, 'https://preview.test/host/api/state']) {
    assert.equal((await runtime.dispatchFetch(url)).status, 403);
  }
  assert.equal(calls.length, count, 'restricted request reached the host');
  offline = true;
  assert.equal((await runtime.dispatchFetch(`${origin}/host/api/state`)).status, 503);
  const stillAvailable = await runtime.dispatchFetch(origin);
  assert.equal(stillAvailable.status, 200, 'host outage prevented loading the website');
  console.log('Built Cloudflare Worker passed: static homepage, dynamic API, large history, authentication boundaries, host outage.');
} finally {
  await runtime.dispose();
}
