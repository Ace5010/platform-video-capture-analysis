// Isolated account-add UI checks; every host request is intercepted before it
// can reach the real database, browser queue or a paid model.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(join(tmpdir(), 'douyin-account-ui-'));
const browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true,
  viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
try {
  for (const scenario of ['existing', 'racing-add', 'new']) {
    const page = await browser.newPage();
    await page.addInitScript(({ scenario }) => {
      const nativeFetch = window.fetch.bind(window);
      const saved = { id: 'saved-profile', platform: 'douyin', name: '已保存账号',
        url: 'https://www.douyin.com/user/profile-a?nt=1', status: 'ready', initialSyncStatus: 'complete' };
      const state = { accounts: scenario === 'existing' ? [saved] : [], videos: [], snapshots: [], linkVideos: [],
        connector: { connected: true, capabilities: ['collect_latest', 'archive_account', 'analyze_video'] } };
      window.accountTestRequests = [];
      window.accountTestJobs = [];
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return nativeFetch(input, init);
        const method = String(init.method || 'GET').toUpperCase();
        const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
        window.accountTestRequests.push({ path: url.pathname, method, body });
        const json = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.pathname.endsWith('/auth/status')) return json({ authenticated: true, configured: true, csrfToken: 'isolated-test' });
        if (url.pathname.endsWith('/state')) return json({ state });
        if (url.pathname.endsWith('/qwen/status')) return json({ configured: false });
        if (url.pathname.endsWith('/accounts/upsert')) {
          const account = scenario === 'racing-add' ? saved : { ...body.account, name: '新账号' };
          state.accounts = [account];
          const job = scenario === 'new' && body.enqueueInitial ? { id: 'isolated-job', type: 'archive_account',
            status: 'queued', payload: { accountId: account.id }, result: {} } : null;
          if (job) window.accountTestJobs.push(job);
          return json({ ok: true, account, reused: scenario === 'racing-add', job });
        }
        if (url.pathname.endsWith('/jobs') && method === 'GET') return json({ jobs: window.accountTestJobs });
        if (url.pathname.endsWith('/jobs')) return json({ job: { id: 'isolated-job', type: body.type,
          status: 'queued', payload: body.payload, result: {} } });
        return json({ ok: true });
      };
    }, { scenario });
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
    await page.locator('.railAdd').waitFor({ timeout: 30000 });
    await page.locator('.railAdd').click();
    await page.locator('#account-url').fill('https://www.douyin.com/user/profile-a?nt=2#works');
    await page.getByRole('button', { name: '添加并抓取近 30 条' }).click();
    if (scenario === 'existing') await page.getByRole('status')
      .getByRole('button', { name: '这个账号已经在监控列表中，点击关闭提示', exact: true }).waitFor();
    else await page.locator('#account-url').waitFor({ state: 'hidden' });
    await page.waitForTimeout(200);
    const requests = await page.evaluate(() => window.accountTestRequests);
    const writes = requests.filter(r => r.method === 'POST' && ['/api/accounts/upsert', '/api/jobs'].includes(r.path));
    if (scenario === 'existing') assert.equal(writes.length, 0, 'known referral variant must not reach an add or collection endpoint');
    if (scenario === 'racing-add') {
      assert.equal(writes.length, 1);
      assert.equal(writes[0].path, '/api/accounts/upsert');
      assert.equal(await page.locator('.railAccountTitle').count(), 1);
      assert.equal(await page.locator('.railAccountTitle').innerText(), '已保存账号');
      const option = page.getByRole('button', { name: '已保存账号，0 条视频', exact: true });
      await option.press('Enter');
      assert.equal(await option.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.topbar h1').innerText(), '已保存账号');
    }
    if (scenario === 'new') {
      const add = writes.find(r => r.path === '/api/accounts/upsert');
      assert.equal(add.body.account.url, 'https://www.douyin.com/user/profile-a');
      assert.equal(add.body.enqueueInitial, true, 'new add must request atomic save and queue');
      const jobs = await page.evaluate(() => window.accountTestJobs);
      assert.equal(jobs[0].payload.accountId, add.body.account.id);
      assert.equal(writes.filter(r => r.path === '/api/jobs').length, 0);
    }
    await page.close();
  }
  console.log('Account UI passed: local duplicate rejection, completed racing add reuse, and atomic new add using the canonical server response.');
} finally {
  await browser.close();
  assert.equal(dirname(profile), tmpdir());
  await rm(profile, { recursive: true, force: true });
}
