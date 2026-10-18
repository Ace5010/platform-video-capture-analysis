import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWebsiteEntry } from '../lib/pages-entry.mjs';

const root = new URL('../', import.meta.url);
const website = JSON.parse(await readFile(new URL('cloudflare-pages.json', root), 'utf8'));
const host = JSON.parse(await readFile(new URL('cloudflare-host.json', root), 'utf8'));
const config = { websiteOrigin: website.publicOrigin, upstreamOrigin: host.publicOrigin };
createWebsiteEntry(config); // Validate both origins before emitting a deployable entry.
if (website.publicOrigin !== `https://${website.projectName}.pages.dev`) throw new Error('Pages project and origin differ');
const output = new URL('outputs/cloudflare-pages/', root);
await mkdir(output, { recursive: true });
const source = await readFile(new URL('lib/pages-entry.mjs', root), 'utf8');
await writeFile(new URL('_worker.js', output), source + `\nexport default createWebsiteEntry(${JSON.stringify(config)});\n`);
await writeFile(new URL('_routes.json', output), JSON.stringify({ version: 1, include: ['/*'], exclude: [] }));
await writeFile(new URL('index.html', output), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>内容情报台</title><p>工作台入口暂时不可用，请稍后重试。</p></html>');
console.log(`Pages entry prepared: ${fileURLToPath(output)}`);
