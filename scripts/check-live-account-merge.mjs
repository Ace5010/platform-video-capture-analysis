// Read-only acceptance of an explicitly repaired account in the running workbench.
// A temporary session is removed afterward. All browser writes are blocked.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const [keepId, removedId] = process.argv.slice(2);
assert.ok(keepId && removedId, 'Pass the retained and removed account IDs.');
const project = fileURLToPath(new URL('..', import.meta.url));
const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
const csrf = createHash('sha256').update(`${token}douyin-monitor-csrf-v1`).digest('hex');
const env = { ...process.env, PYTHONIOENCODING: 'utf-8', ACCOUNT_SESSION: tokenHash,
  ACCOUNT_CSRF: createHash('sha256').update(csrf).digest('hex') };
const python = join(project, '.venv', 'Scripts', 'python.exe');
const runPython = source => execFileSync(python, ['-c', source], { cwd: project, env, encoding: 'utf8' });
runPython(`import os
from host_service.config import HostConfig
from host_service.database import Database
Database(HostConfig.from_env()).create_session(os.environ['ACCOUNT_SESSION'], os.environ['ACCOUNT_CSRF'], '127.0.0.1', 3600)`);
const profile = await mkdtemp(join(tmpdir(), 'douyin-account-merge-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true,
    viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await context.addCookies([{ name: 'douyin_monitor_session', value: token,
    url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const blockedWrites = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'read-only-inspection'));
  await page.route('**/*', async route => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      blockedWrites.push(new URL(request.url()).pathname);
      await route.abort();
    } else await route.continue();
  });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.locator('.accountRail').waitFor({ timeout: 30000 });
  const state = await page.evaluate(async () => {
    const response = await fetch('http://localhost:43129/api/state', { credentials: 'include' });
    if (!response.ok) throw new Error(`State read failed: ${response.status}`);
    return response.json();
  });
  const saved = state.accounts.find(account => account.id === keepId);
  assert.ok(saved);
  assert.equal(state.accounts.some(account => account.id === removedId), false);
  assert.ok(saved.mergedAccountIds.includes(removedId));
  const works = state.videos.filter(video => video.accountId === keepId);
  assert.equal(works.length, 30, 'the repaired account must contain all 30 saved works');
  assert.equal(new Set(works.map(video => video.id)).size, 30);
  const titles = page.locator('.railAccountTitle', { hasText: saved.name });
  assert.equal(await titles.count(), 1, 'the account must appear exactly once');
  const option = page.getByRole('button', { name: `${saved.name}，30 条视频`, exact: true });
  await option.press('Enter');
  assert.equal(await option.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.topbar h1').innerText(), saved.name);
  assert.match(await page.locator('.topbar .accountFollowers').innerText(), /粉丝/);
  assert.match(await page.locator('.compactFeedHeading').innerText(), /共 30 条/);
  const displayedIds = new Set();
  for (let index = 1; index <= 3; index++) {
    assert.equal(await page.locator('.compactVideoRow').count(), 10);
    assert.equal(await page.locator('.feedPagination span').innerText(), `${index} / 3`);
    for (const id of await page.locator('.compactVideoRow').evaluateAll(rows => rows.map(row => row.dataset.videoId))) {
      displayedIds.add(id);
    }
    if (index < 3) await page.getByRole('button', { name: '下一页', exact: true }).press('Enter');
  }
  assert.equal(displayedIds.size, 30, 'all three pages must expose the 30 different works');
  await page.locator('.railAdd').press('Enter');
  await page.locator('#account-url').fill(`${saved.url}?nt=2&from_tab_name=main#works`);
  await page.getByRole('button', { name: '添加并抓取近 30 条', exact: true }).press('Enter');
  await page.getByRole('status').getByRole('button', {
    name: '这个账号已经在监控列表中，点击关闭提示', exact: true }).waitFor();
  assert.deepEqual(blockedWrites, [], 'duplicate rejection must happen before any server write');
  await page.getByRole('button', { name: '取消', exact: true }).press('Enter');
  await page.locator('#account-url').waitFor({ state: 'hidden' });
  await page.waitForTimeout(400);
  assert.equal(await titles.count(), 1);
  assert.deepEqual(blockedWrites, []);
  assert.deepEqual(pageErrors, []);
  await page.waitForFunction(() => {
    const preview = document.querySelector('.videoPreview');
    return !preview || Number(getComputedStyle(preview).opacity) >= 0.99;
  }, null, { timeout: 5000 });
  await mkdir(join(project, 'outputs'), { recursive: true });
  const screenshot = join(project, 'outputs', 'account-duplicate-fixed-20261004.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ account: saved.name, visibleEntries: 1, works: works.length,
    followers: saved.followerCount, totalVisibleAccounts: state.accounts.length,
    duplicateWrites: blockedWrites.length, pageErrors, screenshot }));
} finally {
  if (context) await context.close();
  assert.equal(dirname(profile), tmpdir());
  await rm(profile, { recursive: true, force: true });
  runPython(`import os
from host_service.config import HostConfig
from host_service.database import Database
Database(HostConfig.from_env()).delete_session(os.environ['ACCOUNT_SESSION'])`);
}
