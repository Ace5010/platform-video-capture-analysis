// Isolated API fixtures only; never reads chats or invokes a model.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

await mkdir('outputs/wechat-briefs', { recursive: true });
const samples = [
  ['多角色协作为什么更费积分', '交流了先定架构再拆任务的做法。有试用反馈仍未测出积分节省，效果还在验证。'],
  ['新模型的入口在哪里', '讨论了新模型的使用入口及签到额度。部分账号暂时没有看到入口，仍需核对开放范围。'],
  ['语音输入在嘈杂环境下的表现', '分享了带口音和背景噪声时的识别体验，讨论了热词设置和录音距离。实际改善程度还没有统一测试。'],
  ['手机如何访问电脑上的工作台', '交流了远程打开工作台的方式，并确认电脑需要保持运行。讨论还涉及登录状态与局域网访问的区别。'],
  ['旧数据能否保留到新版本', '围绕升级后保留已有记录展开，讨论了备份及恢复步骤。尚未完成恢复验证。'],
  ['分析结果为什么遗漏后续消息', '发现一段总结只包含早期方案，没有带上晚间的失败反馈。讨论提出把相关追问和后续一起纳入原文。'],
];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN' });
    const page = await context.newPage();
    if (width === 320) await page.emulateMedia({ reducedMotion: 'reduce' });
    const calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname.replace(/^\/host/, '');
      if (!path.startsWith('/api/') && url.port !== '43129') return route.continue();
      calls.push({ path, method: req.method(), topic: url.searchParams.get('topic') });
      let body = {};
      if (path.endsWith('/auth/status')) body = { configured: true, authenticated: true, localHost: false, csrfToken: 'fixture' };
      else if (path.endsWith('/state')) body = { accounts: [], videos: [], snapshots: [], linkVideos: [] };
      else if (path.endsWith('/jobs')) body = { jobs: [] };
      else if (path.endsWith('/qwen/status')) body = {};
      else if (path.endsWith('/wechat/context')) body = { groups: [{ id: 'test', name: '讨论分段测试群', start: 1, end: 2 }, { id: 'other', name: '产品设计交流群', start: 1, end: 2 }], members: [], batches: [], read_jobs: [] };
      else if (path.endsWith('/wechat/days')) body = { days: ['2026-10-24', '2026-10-25'].map(date => ({ date, ready: true, summarizable: true, complete: true })) };
      else if (path.endsWith('/wechat/summary')) {
        const older = url.searchParams.get('date') === '2026-10-24';
        const other = url.searchParams.get('group') === 'other';
        await new Promise(resolve => setTimeout(resolve, older ? 400 : 70));
        body = { status: 'ready', stale: true, partial: true, coverage_end: 1793020404, people: {},
          missing_resources: Array.from({ length: 48 }, (_, index) => ({ message: `missing-${index}`, time: '09:10:00', sender: `成员 ${index + 1}`, label: '图片', reason: '本机尚无该消息的完整图片，请补齐后重新读取。' })), summary: {
          format_version: 4, notes: [], topics: samples.map(([title, summary]) => ({ title: `${other ? '设计讨论：' : ''}${older ? '昨日：' : ''}${title}`, summary, discussion_complete: true, discussion_count: 3 })) } };
      }
      else if (path.endsWith('/wechat/original')) body = { complete: true, total: 3, messages: [
        { id: 'a', sender: '甲', time: '09:00:00', content: '最初的问题' },
        { id: 'b', sender: '乙', time: '10:00:00', content: '补充与附件' },
        { id: 'c', sender: '甲', time: '22:00:00', content: '晚间的后续反馈' }] };
      else if (path.endsWith('/wechat/search')) body = { messages: [], total: 0 };
      else throw new Error(`Unexpected API request ${path}`);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...body }) });
    });
    await page.goto('http://localhost:3000/?module=wechat&view=reading', { waitUntil: 'domcontentloaded' });
    await page.locator('.wxTopicReading article').last().waitFor();
    await page.waitForFunction(() => !document.querySelector('.wxTopicReading').getAnimations().some(a => a.playState === 'running'));
    await page.waitForFunction(() => !document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity));
    assert.equal(await page.locator('.wxTopicReading article').count(), samples.length);
    assert.equal(await page.locator('.wxTopicReading .wxPerson, .wxDiscussion, .wxQuote, .wxProgress, .wxComparisons').count(), 0);
    assert.deepEqual(await page.locator('.wxTopicLead').allTextContents(), samples.map(row => row[1]));
    const readingTop = await page.locator('.wxSummaryGrid').evaluate(node => node.getBoundingClientRect().top + scrollY);
    await page.getByLabel('阅读状态', { exact: true }).click();
    await page.locator('.wxReadingStatusPanel').waitFor({ state: 'visible' });
    assert.match(await page.locator('.wxReadingStatusPanel').innerText(), /聊天或图片有更新/);
    assert.equal(await page.locator('.wxMissingList li').count(), 48);
    assert.equal(await page.locator('.wxReadingStatusPanel').evaluate(node => node.scrollHeight > node.clientHeight), true);
    await page.locator('.wxMissingList li').last().scrollIntoViewIfNeeded();
    await page.locator('.wxReadingStatusPanel').evaluate(node => { node.scrollTop = 0; });
    assert.ok(Math.abs(await page.locator('.wxSummaryGrid').evaluate(node => node.getBoundingClientRect().top + scrollY) - readingTop) < 1, 'status details must not displace reading');
    const statusBox = await page.locator('.wxReadingStatusPanel').boundingBox();
    assert.ok(statusBox.x >= 0 && statusBox.x + statusBox.width <= width);
    await page.screenshot({ path: `outputs/wechat-briefs/status-${width}.png` });
    await page.keyboard.press('Escape');
    await page.locator('.wxReadingStatusPanel').waitFor({ state: 'hidden' });
    await page.screenshot({ path: `outputs/wechat-briefs/briefs-${width}.png` });
    await page.locator('.wxTopicOptions button').nth(4).click();
    await page.waitForFunction(() => document.querySelector('.wxTopicReading').scrollTop > 100);
    await page.waitForTimeout(280); // Bounded anchor motion must finish before measuring restoration.
    const article = page.locator('.wxTopicReading article').nth(4);
    const pane = await page.locator('.wxTopicReading').boundingBox(), box = await article.boundingBox();
    assert.ok(box.y >= pane.y && box.y < pane.y + pane.height - 40,
      'Directory must bring the selected brief into the reading pane, allowing end-of-list clamping');
    const before = await page.locator('.wxTopicReading').evaluate(node => node.scrollTop);
    await article.getByRole('button', { name: /查看讨论原文/ }).click();
    await page.getByRole('dialog').getByRole('heading', { name: samples[4][0], exact: true }).waitFor();
    await page.locator('.wxSourcePane .wxMessage').last().waitFor();
    await page.waitForFunction(() => !document.querySelector('.wxOverlay').getAnimations().some(a => a.playState === 'running'));
    assert.equal(await page.locator('.wxOverlay').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    if (width === 320) assert.equal(await page.locator('.wxOverlay').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.screenshot({ path: `outputs/wechat-briefs/original-${width}.png` });
    assert.equal(await page.locator('.wxSourcePane .wxMessage').count(), 3);
    assert.equal(calls.findLast(call => call.path.endsWith('/original')).topic, '4');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    if (width === 390) await page.screenshot({ path: 'outputs/wechat-briefs/return-motion-390.png', animations: 'allow' });
    await page.locator('.wxOriginalLayer').waitFor({ state: 'hidden' });
    assert.equal(await article.getByRole('button', { name: /查看讨论原文/ }).evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator('.wxTopicReading').evaluate(node => node.scrollTop), before);
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('.wxMoreMenu').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '查看当天全部聊天', exact: true }).click();
    await page.locator('.wxMessages').waitFor();
    await page.getByRole('button', { name: '返回总结', exact: true }).click();
    assert.equal(await page.locator('.wxTopicReading').evaluate(node => node.scrollTop), before);
    await page.locator('.wxTopicReading').evaluate(node => { node.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('.wxTopicOptions button')?.getAttribute('aria-current') === 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(calls.every(call => call.method === 'GET' || call.path.endsWith('/search')));
    // Date/group changes keep the last selection even if an earlier response arrives late.
    await page.getByRole('button', { name: '前一天', exact: true }).click();
    await page.getByRole('status', { name: '正在读取总结' }).waitFor();
    await page.screenshot({ path: `outputs/wechat-briefs/date-loading-${width}.png` });
    await page.waitForFunction(() => document.querySelector('.wxTopicReading h2')?.textContent.startsWith('昨日：'));
    await page.getByRole('button', { name: '后一天', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wxTopicReading h2')?.textContent === '多角色协作为什么更费积分');
    await page.getByRole('button', { name: '前一天', exact: true }).click();
    await page.getByRole('button', { name: '后一天', exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.wxTopicReading h2').first().innerText(), samples[0][0]);
    await page.getByRole('button', { name: '产品设计交流群', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wxTopicReading h2')?.textContent.startsWith('设计讨论：'));
    await page.getByRole('button', { name: '讨论分段测试群', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wxTopicReading h2')?.textContent === '多角色协作为什么更费积分');
    await page.waitForTimeout(250);
    await page.screenshot({ path: `outputs/wechat-briefs/group-switch-${width}.png` });
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('.wxTopicOptions button');
      buttons[5].click(); buttons[1].click(); buttons[3].click();
    });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.wxTopicOptions button').nth(3).getAttribute('aria-current'), 'true');
    const selected = page.locator('.wxTopicReading article').nth(3);
    const savedTop = await page.locator('.wxTopicReading').evaluate(node => node.scrollTop);
    await selected.getByRole('button', { name: /查看讨论原文/ }).click();
    await page.locator('.wxOriginalLayer').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.wxOriginalLayer').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.wxTopicReading').evaluate(node => node.scrollTop), savedTop);
    assert.equal(await selected.getByRole('button', { name: /查看讨论原文/ }).evaluate(node => document.activeElement === node), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('WeChat briefs passed: continuous titled paragraphs, directory anchors, complete discussion routing, reading position restoration, desktop/390/320px; isolated APIs, no model calls.');
} finally {
  await browser.close();
}
