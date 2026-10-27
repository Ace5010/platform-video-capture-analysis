// All host traffic is isolated: no real group registration, capture or AI calls.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

await mkdir('outputs/wechat-groups', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
    await context.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'isolated-test'));
    const page = await context.newPage();
    const errors = [], writes = [];
    let added = false, lookup = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return route.continue();
      const path = url.pathname.replace(/^\/host/, '');
      let body = { ok: true }, status = 200;
      if (req.method() !== 'GET') writes.push({ path, body: req.postDataJSON() });
      if (path.endsWith('/auth/status')) body = { authenticated: true, configured: true, csrfToken: 'isolated' };
      else if (path.endsWith('/state')) body = { state: { accounts: [], videos: [], snapshots: [], linkVideos: [] } };
      else if (path.endsWith('/jobs')) body = { jobs: [] };
      else if (path.endsWith('/wechat/context')) body = { groups: [
        { id: 'old', name: '原有群', start: 1792857600, end: 1792900002 },
        ...(added ? [{ id: 'new', name: '新增测试群', start: null, end: null }] : [])
      ], members: [], batches: [], read_jobs: [] };
      else if (path.endsWith('/wechat/days')) body = { days: url.searchParams.get('group') === 'old' ? [{ date:'2026-10-25', ready:true, summarizable:true }] : [] };
      else if (path.endsWith('/wechat/summary')) body = { status:'ready', people:{}, summary:{format_version:3, notes:[], topics:[{title:'原有群的总结', summary:'保留原有内容', discussion_complete:true, discussion_count:1}]} };
      else if (path.endsWith('/wechat/generation')) body = { job: null };
      else if (path.endsWith('/wechat/find-groups')) {
        lookup++;
        if (lookup === 1) { status = 400; body = { error: '微信未运行，请打开微信并登录后重试' }; }
        else body = { groups: req.postDataJSON().name === '不存在的群' ? [] : [{ id:'candidate', name:'新增测试群', added }] };
      } else if (path.endsWith('/wechat/add-group')) { added = true; body = { group:'new', added:true }; }
      else if (path.endsWith('/wechat/analyze')) body = { job:{id:'fixture', group:'new', status:'imported'} };
      await route.fulfill({ status, contentType:'application/json', body:JSON.stringify(body) });
    });
    await page.goto('http://localhost:3000/?module=wechat&view=reading', { waitUntil:'domcontentloaded' });
    await page.locator('.wxTopicReading h2').waitFor();
    await page.getByRole('button', { name:'新增群', exact:true }).click();
    const dialog = page.getByRole('dialog', { name:'新增群', exact:true });
    await dialog.getByLabel('群名', {exact:true}).fill('新增测试群');
    await dialog.getByRole('button', {name:'查找群',exact:true}).click();
    await dialog.getByRole('alert').waitFor();
    await dialog.getByLabel('群名', {exact:true}).fill('不存在的群');
    await dialog.getByRole('button', {name:'查找群',exact:true}).click();
    await dialog.getByText('未找到该群，请核对微信中的完整群名。').waitFor();
    await dialog.getByLabel('群名', {exact:true}).fill('新增测试群');
    await dialog.getByRole('button', {name:'查找群',exact:true}).click();
    await dialog.getByRole('button', {name:'确认添加',exact:true}).waitFor();
    await page.screenshot({path:`outputs/wechat-groups/add-${width}.png`});
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await dialog.getByRole('button', {name:'确认添加',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await page.getByRole('button', {name:'读取并总结',exact:true}).waitFor();
    assert.equal(await page.getByRole('button', {name:'读取管理',exact:true}).count(), 0);
    assert.match(await page.locator('.wxMain').innerText(), /尚未读取聊天/);
    await page.screenshot({path:`outputs/wechat-groups/added-${width}.png`});
    await page.getByRole('button', {name:'读取并总结',exact:true}).click();
    await page.getByRole('button', {name:'开始读取并总结',exact:true}).click();
    await page.getByRole('dialog', {name:'读取并总结'}).waitFor({state:'hidden'});
    assert.equal(writes.find(w => w.path.endsWith('/wechat/analyze')).body.group, 'new');
    await page.getByRole('button', {name:'新增群',exact:true}).click();
    await dialog.getByLabel('群名', {exact:true}).fill('新增测试群');
    await dialog.getByRole('button', {name:'查找群',exact:true}).click();
    assert.equal(await dialog.getByRole('button', {name:'已添加',exact:true}).isDisabled(), true);
    await dialog.getByRole('button', {name:'关闭',exact:true}).click();
    await page.locator('.wxGroupOptions').getByRole('button', {name:'原有群',exact:true}).click();
    await page.locator('.wxTopicReading h2', {hasText:'原有群的总结'}).waitFor();
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('.wxGroupOptions').getByRole('button', {name:'新增测试群',exact:true}).waitFor();
    assert.equal(writes.filter(w => w.path.endsWith('/wechat/add-group')).length, 1);
    assert.equal(writes.some(w => w.path.endsWith('/wechat/generate')), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('WeChat group UI passed at 1440/390/320px: lookup/retry/no match, add, duplicate prevention, targeted capture, switch and reload; all host traffic isolated.');
} finally { await browser.close(); }
