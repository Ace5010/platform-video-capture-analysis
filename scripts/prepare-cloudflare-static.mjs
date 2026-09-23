import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Publish only the anonymous root shell. Account data and authenticated API
// responses must stay behind /host and must never become deployment assets.
export async function prepareCloudflareStatic(root = process.cwd()) {
  const server = path.join(root, 'dist', 'server');
  const manifest = JSON.parse(await readFile(path.join(server, 'vinext-prerender.json'), 'utf8'));
  const homepage = manifest.routes?.find(route => route.route === '/');
  if (homepage?.status !== 'rendered' || homepage.revalidate !== false) {
    throw new Error('首页未完成静态预渲染，停止构建，避免上线后再次触发 Cloudflare 1102。');
  }
  const buildId = (await readFile(path.join(server, 'BUILD_ID'), 'utf8')).trim();
  if (!buildId || manifest.buildId !== buildId) {
    throw new Error('首页预渲染与当前构建版本不一致，停止发布。');
  }
  const source = path.join(server, 'prerendered-routes', 'index.html');
  const html = await readFile(source, 'utf8');
  if (!/^<!doctype html>/i.test(html) || !html.includes('vinext.navigationRuntime')) {
    throw new Error('首页预渲染产物不完整，停止发布。');
  }
  await copyFile(source, path.join(root, 'dist', 'client', 'index.html'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareCloudflareStatic();
  console.log('已发布首页静态外壳；/host 接口继续通过受限网关实时访问。');
}
