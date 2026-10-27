// All host APIs, including paid actions, are isolated fixtures.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = 'outputs/wechat-queue-20261027';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
    await context.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'isolated-test'));
    const page = await context.newPage(), writes = [], errors = [];
    let record = null, phase = 'reading';
    let pendingContexts = 0, peakContexts = 0;
    const contentReads = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/host/, '');
      if (!path.startsWith('/api/') && url.port !== '43129') return route.continue();
      let body = { ok: true };
      if (['/api/state','/api/jobs','/api/qwen/status'].includes(path)) contentReads.push(path);
      if (request.method() !== 'GET') writes.push({ path, payload: request.postDataJSON() });
      if (path.endsWith('/auth/status')) body = { configured: true, authenticated: true, localHost: true, csrfToken: 'fixture' };
      else if (path.endsWith('/state')) body = { state: { accounts: [], videos: [], snapshots: [], linkVideos: [] } };
      else if (path.endsWith('/jobs')) body = { jobs: [] };
      else if (path.endsWith('/qwen/status')) body = {};
      else if (path.endsWith('/wechat/context')) {
        if (record && width === 1440) {
          pendingContexts++;
          peakContexts = Math.max(peakContexts, pendingContexts);
          // Slower than the 2.5-second polling interval: progress must still
          // arrive instead of being invalidated by overlapping requests.
          await new Promise(resolve => setTimeout(resolve, 3300));
          pendingContexts--;
        }
        if (record) record = { ...record, status: phase === 'complete' ? 'complete' : 'running', phase, current_date: '2026-10-25', credits: phase === 'complete' ? .42 : 0 };
        body = { groups: [{ id: 'group', name: 'AI 产品与实践交流群', summary_end: 1792900002, start: 1792796400, end: 1792900002 },
          { id: 'second', name: '产品设计讨论群', summary_end: 1792900002, start: 1792796400, end: 1792900002 },
          { id: 'third', name: '新加入的学习群', start: 1792796400, end: 1792900002 }], members: [], batches: [], read_jobs: record ? [record, { ...record, id: 'second-job', group: 'second', status: phase === 'complete' ? 'complete' : 'queued' }] : [] };
      } else if (path.endsWith('/wechat/days')) body = { days: ['2026-10-24', '2026-10-25'].map(date => ({ date, ready: true, complete: true, summarizable: true })) };
      else if (path.endsWith('/wechat/summary')) body = { status: 'ready', people: {}, missing_resources: [
        {message:'fixture-missing',time:'09:10:00',sender:'测试成员',label:'图片',reason:'本机尚无该消息的完整图片'},
      ], summary: { format_version: 4, notes: [], topics: [
        { title: '多角色协作为什么更费积分', summary: '交流了先定架构再拆任务的做法。有试用反馈仍未测出积分节省，效果还在验证。', discussion_complete: true, discussion_count: 12 },
        { title: '新模型的入口在哪里', summary: '讨论了新模型的使用入口及签到额度。部分账号暂时没有看到入口，仍需核对开放范围。', discussion_complete: true, discussion_count: 8 },
        { title: '分析结果为什么遗漏后续消息', summary: '一段总结遗漏了晚间的失败反馈。讨论提出把相关追问和后续消息一起纳入原文。', discussion_complete: true, discussion_count: 17 },
      ] } };
      else if (path.endsWith('/wechat/generation')) body = { job: null };
      else if (path.endsWith('/wechat/cleanup-preview') || path.endsWith('/wechat/cleanup')) {
        body = { token: 'f'.repeat(64), messages: 120, summaries: 2, attachments: 26, reclaim_bytes: 45000000 };
      }
      else if (path.endsWith('/wechat/analyze-batch')) {
        const payload = request.postDataJSON();
        record = { ...payload, group: payload.groups[0], id: payload.request_id, kind: 'read_and_summarize', model: 'glm-5.3-flash', status: 'running', phase, started_at: '2026-10-26T01:30:00Z', start: 1792900002, end: 1792978200 };
        body = { jobs: [record, { ...record, id: 'second-job', group: 'second', status: 'queued' }] };
      } else if (path.endsWith('/wechat/history')) body = { jobs: [
        ...(record ? [record] : []),
        { id: 'old', kind: 'read_and_summarize', scope: 'date', date: '2026-10-24', model: 'deepseek-v4.1-flash', status: 'failed', started_at: '2026-10-25T03:00:00Z', credits: .18, error: '总结未通过校验，已有总结保留', children: [{ id: 'old-child', date: '2026-10-24', status: 'failed', model: 'deepseek-v4.1-flash', credits: .18 }] },
        { id: 'unverified', kind: 'generate', date: '2026-10-23', model: 'hy4-preview', status: 'failed', started_at: '2026-10-24T03:00:00Z', credits: null },
      ] };
      else throw new Error(`Unexpected API ${path}`);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('http://localhost:3000/?module=wechat&view=manage', { waitUntil: 'domcontentloaded' });
    await page.locator('.wxTopicReading h2').first().waitFor();
    assert.match(page.url(), /view=reading/);
    assert.equal(await page.getByRole('button', { name: '读取管理', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '聊天原文', exact: true }).count(), 0);
    assert.equal(await page.locator('.wxTopicOptions').isVisible(), true);
    const summaryTop = (await page.locator('.wxSummaryGrid').boundingBox()).y;
    assert.equal(await page.locator('.wxMissingResources').count(), 0);
    await page.getByLabel('阅读状态', { exact: true }).click();
    await page.getByText('本机尚无该消息的完整图片', {exact:true}).waitFor();
    await page.waitForFunction(() => {
      const details=document.querySelector('.wxReadingStatus');
      return details?.open && getComputedStyle(details,'::details-content').opacity==='1';
    });
    assert.equal(await page.locator('.wxReadingStatusPanel').evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.ok(Math.abs((await page.locator('.wxSummaryGrid').boundingBox()).y - summaryTop) < 1, 'Status panel must not shift the reading layout');
    await page.screenshot({path:`${output}/missing-${width}.png`});
    await page.getByLabel('阅读状态', { exact: true }).click();
    await page.screenshot({ path: `${output}/reading-${width}.png` });
    await page.getByRole('button', { name: '前一天', exact: true }).click();
    await page.getByRole('button', { name: '选择聊天日期', exact: true }).filter({ hasText: '2026-10-24' }).waitFor();
    await page.getByRole('button', { name: '后一天', exact: true }).click();
    await page.getByRole('button', { name: '读取并总结', exact: true }).click();
    const setup = page.getByRole('dialog', { name: '读取并总结', exact: true });
    assert.equal(await setup.getByRole('button', { name: /从上次总结继续/ }).getAttribute('aria-pressed'), 'true');
    assert.equal(await setup.getByRole('button', { name: 'DeepSeek V4.1 Flash', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await setup.locator('select').count(), 0);
    assert.equal(await setup.getByRole('button', { name: '读取记录与积分', exact: true }).count(), 0);
    assert.match(await setup.innerText(), /视频不下载/);
    assert.doesNotMatch(await setup.innerText(), /MiniMax/);
    assert.doesNotMatch(await setup.innerText(), /同时分析|可读取|结果按天|单点/);
    await setup.getByRole('button', { name: '清空选择', exact: true }).click();
    assert.equal(await setup.getByRole('button', { name: '加入队列（0）' }).isDisabled(), true);
    await setup.getByRole('button', { name: '全选', exact: true }).click();
    assert.equal(await setup.getByRole('button', { name: /从上次总结继续/ }).isDisabled(), true);
    await setup.getByLabel('新加入的学习群', { exact: true }).uncheck();
    await setup.getByRole('button', { name: /从上次总结继续/ }).click();
    await page.screenshot({ path: `${output}/setup-${width}.png` });
    await setup.getByRole('button', { name: '指定日期', exact: true }).click();
    await setup.getByLabel('总结日期', { exact: true }).fill('2026-10-24');
    assert.equal(await setup.getByLabel('总结日期', { exact: true }).inputValue(), '2026-10-24');
    await page.screenshot({ path: `${output}/date-${width}.png` });
    await setup.getByRole('button', { name: '全部聊天', exact: true }).click();
    assert.equal(await setup.getByLabel('总结日期', { exact: true }).count(), 0);
    await setup.getByRole('button', { name: /从上次总结继续/ }).click();
    await setup.getByRole('button', { name: 'GLM 5.3 Flash', exact: true }).click();
    await setup.getByRole('button', { name: '加入队列（2）', exact: true }).click();
    await setup.waitFor({ state: 'hidden' });
    await page.locator('.wxJobStatus', { hasText: '正在读取' }).waitFor();
    await page.getByLabel('读取队列').getByText('排队中', { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/queue-${width}.png` });
    assert.equal(await page.getByRole('button', { name: '读取并总结', exact: true }).isDisabled(), false);
    await page.getByRole('button', { name: '读取并总结', exact: true }).click();
    assert.equal(await setup.getByLabel(/AI 产品与实践交流群/).isDisabled(), true);
    assert.equal(await setup.getByLabel(/新加入的学习群/).isChecked(), true);
    await setup.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/api/wechat/analyze-batch');
    assert.deepEqual(writes[0].payload.groups, ['group', 'second']);
    assert.equal(writes[0].payload.scope, 'continue');
    assert.equal(writes[0].payload.mode, 'low');
    assert.equal(writes[0].payload.date, undefined);
    phase = 'summarizing';
    await page.locator('.wxJobStatus', { hasText: '正在总结 2026-10-25' }).waitFor();
    phase = 'complete';
    await page.getByLabel('读取队列').waitFor({ state: 'hidden' });
    if (width === 1440) assert.equal(peakContexts, 1, 'slow polls must not overlap or starve progress');
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '读取记录与积分', exact: true }).click();
    const history = page.getByRole('dialog', { name: '读取记录与积分' });
    await history.getByText('0.42 积分', { exact: true }).waitFor();
    assert.match(await history.innerText(), /0\.18 积分/);
    assert.match(await history.innerText(), /积分待核实/);
    await history.locator('.wxRunDetails summary').click();
    await page.waitForFunction(() => {
      const details = document.querySelector('.wxRunDetails');
      return details?.open && getComputedStyle(details, '::details-content').opacity === '1'
        && details.clientHeight >= details.querySelector('div').clientHeight + details.querySelector('summary').clientHeight;
    });
    await page.screenshot({ path: `${output}/history-${width}.png` });
    assert.equal(await history.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await history.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '清理聊天记录', exact: true }).click();
    const cleanup = page.getByRole('dialog', { name: '清理聊天记录', exact: true });
    await cleanup.getByLabel('开始日期', { exact: true }).fill('2026-10-24');
    await cleanup.getByLabel('结束日期', { exact: true }).fill('2026-10-25');
    await cleanup.getByRole('button', { name: '预览清理范围', exact: true }).click();
    await cleanup.getByText('45.0 MB', { exact: true }).waitFor();
    assert.equal(await cleanup.getByRole('button', { name: '确认清理', exact: true }).isDisabled(), true);
    assert.equal(writes.filter(w => w.path === '/api/wechat/cleanup').length, 0);
    assert.equal(await cleanup.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: `${output}/cleanup-${width}.png` });
    await cleanup.getByLabel('我确认清理以上记录', { exact: true }).check();
    await cleanup.getByRole('button', { name: '确认清理', exact: true }).click();
    await cleanup.waitFor({ state: 'hidden' });
    await page.getByText('已清理 120 条聊天记录及 26 个附件。', { exact: true }).waitFor();
    const removal = writes.filter(w => w.path === '/api/wechat/cleanup');
    assert.equal(removal.length, 1);
    assert.deepEqual(removal[0].payload, { group: 'group', from: '2026-10-24', to: '2026-10-25', confirmed: true, token: 'f'.repeat(64) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(contentReads, [], 'WeChat must not wait for or poll the video workspace snapshot');
    await context.close();
  }
  console.log('WeChat queue workflow passed at 1440/390/320px: multi-select/all/empty selection, continuation eligibility, batch submission, running/queued states, append entry, date/model scopes, history and cleanup. All APIs isolated.');
} finally { await browser.close(); }
