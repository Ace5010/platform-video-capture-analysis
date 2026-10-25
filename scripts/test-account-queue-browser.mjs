// All host requests are intercepted; no production writes or Douyin/model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(join(tmpdir(), 'douyin-initial-queue-ui-'));
const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true,
  viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
try {
  for (const scenario of ['adding', 'backlog']) {
    const page = await context.newPage();
    await page.addInitScript(({ scenario }) => {
      const nativeFetch = window.fetch.bind(window);
      const stored = sessionStorage.getItem('initial-queue-fixture');
      const fixture = stored ? JSON.parse(stored) : {
        accounts: scenario === 'backlog' ? [
          { id: 'pending-a', name: '待建档甲', initialSyncStatus: 'pending' },
          { id: 'failed-b', name: '失败乙', initialSyncStatus: 'error', status: 'error' },
          { id: 'complete-c', name: '完成丙', initialSyncStatus: 'complete', status: 'ready' },
        ].map(a => ({ platform: 'douyin', status: 'waiting', url: `https://www.douyin.com/user/${a.id}`, ...a })) : [],
        jobs: [], writes: [],
      };
      window.initialQueueFixture = fixture;
      const persist = () => sessionStorage.setItem('initial-queue-fixture', JSON.stringify(fixture));
      const queue = account => {
        const existing = fixture.jobs.find(j => j.payload.accountId === account.id);
        if (existing) return existing;
        const job = { id: `job-${account.id}`, type: 'archive_account',
          status: fixture.jobs.length ? 'queued' : 'running',
          payload: { accountId: account.id }, progress: { accountId: account.id, accountName: account.name },
          result: {}, createdAt: new Date().toISOString() };
        account.status = 'checking'; account.currentSyncMode = 'initial';
        fixture.jobs.unshift(job); return job;
      };
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return nativeFetch(input, init);
        const method = String(init.method || 'GET').toUpperCase();
        const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
        const json = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (method === 'POST') fixture.writes.push({ path: url.pathname, body });
        let result = { ok: true };
        if (url.pathname.endsWith('/auth/status')) result = { authenticated: true, configured: true, csrfToken: 'isolated' };
        if (url.pathname.endsWith('/state')) result = { state: { accounts: fixture.accounts, videos: [], snapshots: [],
          linkVideos: [], browser: { mode: 'dedicated_browser' }, connector: { connected: true } } };
        if (url.pathname.endsWith('/qwen/status')) result = { configured: false };
        if (url.pathname.endsWith('/accounts/upsert')) {
          const account = { ...body.account, name: `新增${fixture.accounts.length + 1}` };
          fixture.accounts.push(account);
          result = { ok: true, account, reused: false, job: body.enqueueInitial ? queue(account) : null };
        }
        if (url.pathname.endsWith('/jobs')) result = method === 'GET' ? { jobs: fixture.jobs }
          : { job: queue(fixture.accounts.find(a => a.id === body.payload.accountId)), created: true };
        persist(); return json(result);
      };
    }, { scenario });
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
    await page.locator('.railAdd').waitFor({ timeout: 30000 });
    if (scenario === 'adding') {
      for (let n = 1; n <= 3; n++) {
        await page.locator('.railAdd').click();
        await page.locator('#account-url').fill(`https://www.douyin.com/user/queue-${n}`);
        await page.getByRole('button', { name: '添加并抓取近 30 条' }).click();
        await page.locator('#account-url').waitFor({ state: 'hidden' });
      }
      const fixture = await page.evaluate(() => window.initialQueueFixture);
      assert.equal(fixture.jobs.length, 3, 'adding while the first account runs must enqueue every account');
      assert.equal(fixture.writes.filter(w => w.path.endsWith('/accounts/upsert') && w.body.enqueueInitial).length, 3,
        'save and queue must be one backend request per account');
      assert.equal(fixture.writes.filter(w => w.path.endsWith('/jobs')).length, 0);
      await page.getByRole('button', { name: /信源管理/ }).click();
      await page.getByRole('button', { name: '排队中', exact: true }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: '排队中', exact: true }).count(), 2);
      assert.equal(await page.getByRole('button', { name: '正在抓取近 30 条…', exact: true }).count(), 1);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.railAdd').waitFor();
      const reloaded = await page.evaluate(() => window.initialQueueFixture);
      assert.equal(reloaded.jobs.length, 3);
      assert.equal(reloaded.writes.length, fixture.writes.length, 'refresh must not resubmit queued accounts');
    } else {
      await page.getByRole('button', { name: /信源管理/ }).click();
      await page.getByRole('button', { name: '抓取全部待建档账号', exact: true }).click();
      await page.waitForFunction(() => window.initialQueueFixture.jobs.length === 2);
      const fixture = await page.evaluate(() => window.initialQueueFixture);
      assert.deepEqual(new Set(fixture.jobs.map(j => j.payload.accountId)), new Set(['pending-a', 'failed-b']));
      assert.ok(fixture.writes.filter(w => w.path.endsWith('/jobs')).every(w => w.body.payload.retry === true));
      await page.getByRole('button', { name: '排队中', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '抓取全部待建档账号', exact: true }).count(), 0);
    }
    await page.close();
  }
  console.log('Initial queue UI passed: add while running, atomic add, per-account state, refresh persistence and backlog retry.');
} finally {
  await context.close();
  assert.equal(dirname(profile), tmpdir());
  await rm(profile, { recursive: true, force: true });
}
