import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareCloudflareStatic } from './prepare-cloudflare-static.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'workbench-static-test-'));
const server = path.join(fixture, 'dist', 'server');
const client = path.join(fixture, 'dist', 'client');
const manifestPath = path.join(server, 'vinext-prerender.json');
const html = '<!DOCTYPE html><html><body>Loading<script>/* vinext.navigationRuntime */</script></body></html>';
const manifest = { buildId: 'test-build', routes: [{ route: '/', status: 'rendered', revalidate: false }, { route: '/host/:path+', status: 'skipped', reason: 'api' }] };

try {
  await mkdir(path.join(server, 'prerendered-routes', 'host'), { recursive: true });
  await mkdir(client, { recursive: true });
  await writeFile(path.join(server, 'BUILD_ID'), 'test-build\n');
  await writeFile(path.join(server, 'prerendered-routes', 'index.html'), html);
  await writeFile(path.join(server, 'prerendered-routes', 'host', 'state.json'), '{"private":"must-not-publish"}');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await prepareCloudflareStatic(fixture);
  assert.equal(await readFile(path.join(client, 'index.html'), 'utf8'), html);
  assert.deepEqual(await readdir(client), ['index.html'], 'private routes were copied into public assets');

  for (const homepage of [undefined, { route: '/', status: 'skipped' }, { route: '/', status: 'error' }, { route: '/', status: 'rendered', revalidate: 30 }]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, routes: homepage ? [homepage] : [] }));
    await assert.rejects(prepareCloudflareStatic(fixture), /未完成静态预渲染/);
  }
  await writeFile(manifestPath, JSON.stringify({ ...manifest, buildId: 'old-build' }));
  await assert.rejects(prepareCloudflareStatic(fixture), /版本不一致/);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(server, 'prerendered-routes', 'index.html'), '<html>render failed</html>');
  await assert.rejects(prepareCloudflareStatic(fixture), /产物不完整/);
  console.log('Cloudflare static shell tests passed: static-only, current build, complete HTML, no API publication.');
} finally {
  // This directory is the isolated fixture returned by mkdtemp above.
  await rm(fixture, { recursive: true, force: true });
}
