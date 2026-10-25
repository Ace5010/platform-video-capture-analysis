// Read-only rendering of the running workbench in external Chrome.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const token = randomBytes(32).toString('base64url');
const csrf = createHash('sha256').update(`${token}douyin-monitor-csrf-v1`).digest('hex');
const metadata = JSON.parse(execFileSync(join(project, '.venv/Scripts/python.exe'), ['-c', `
import os,hashlib,sys,json
sys.path.insert(0,os.environ['OBSERVE_PROJECT'])
from host_service.config import HostConfig
from host_service.database import Database
db=Database(HostConfig.from_env())
db.create_session(hashlib.sha256(os.environ['OBSERVE_TOKEN'].encode()).hexdigest(),hashlib.sha256(os.environ['OBSERVE_CSRF'].encode()).hexdigest(),'127.0.0.1',3600)
v=db.get_video('7698692945368616207')
with db.connect() as c:a=json.loads(c.execute('select data_json from accounts where id=?',(v['accountId'],)).fetchone()[0])
print(json.dumps({'video':{'id':v['id'],'analysisStatus':v.get('analysisStatus')},'account':{'name':a['name']}}))
`], { encoding: 'utf8', env: { ...process.env, OBSERVE_PROJECT: project, OBSERVE_TOKEN: token, OBSERVE_CSRF: csrf } }));
const videoId = '7698692945368616207';
const { video, account } = metadata;
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const folder = join(project, 'artifacts/codebuddy-video');
await mkdir(folder, { recursive: true });
const checks = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await context.addCookies([{ name: 'douyin_monitor_session', value: token, url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  // Visual inspection cannot submit billable work or change settings.
  await page.route('**/api/jobs', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.locator('.accountRail').waitFor({ timeout: 30000 });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    if (!await page.locator('.serviceStatus').evaluate(n => n.open)) await page.locator('.serviceStatus > summary').click();
    await page.getByRole('button', { name: 'AI 分析设置', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'AI 分析设置', exact: true });
    await modal.waitFor();
    const text = await modal.innerText();
    assert.match(text, /MiniMax-M3/);
    assert.match(text, /MiniMax-M3.1-Flash/);
    assert.doesNotMatch(text, /GLM-5.3-Flash|qwen3.8-flash/);
    checks.push({ surface: 'settings', width, noHorizontalOverflow: await modal.evaluate(n => n.scrollWidth <= n.clientWidth + 1), text });
    await page.screenshot({ path: join(folder, `settings-${width}.png`), animations: 'disabled' });
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
  }
  if (video.analysisStatus === 'ready') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.railAccount').filter({ hasText: account.name }).first().click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const row = page.locator(`[data-video-id="${videoId}"]`);
      await row.locator('.compactVideoCopy').click({ timeout: 20000 });
      const reader = page.locator('.readingDialog');
      await reader.waitFor();
      await reader.getByRole('tab', { name: '内容分析', exact: true }).click();
      assert.match(await reader.locator('#reader-panel').innerText(), /WorkBuddy|Workbuddy|动画|聊天/);
      const costs = reader.locator('.analysisCosts');
      await costs.locator('summary').click();
      await costs.scrollIntoViewIfNeeded();
      const text = await costs.innerText();
      assert.match(text, /minimax-m3/);
      assert.match(text, /积分/);
      assert.equal(await costs.locator('a.analysisBillingLink').getAttribute('href'), 'https://www.codebuddy.cn/profile/plans-usage');
      checks.push({ surface: 'real-result-and-billing', width, noHorizontalOverflow: await reader.evaluate(n => n.scrollWidth <= n.clientWidth + 1), text });
      await page.screenshot({ path: join(folder, `result-${width}.png`), animations: 'disabled' });
      await reader.getByRole('button', { name: '关闭阅读，返回列表', exact: true }).click();
      await reader.waitFor({ state: 'hidden' });
    }
  }
  await writeFile(join(folder, 'ui-checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), videoStatus: video.analysisStatus, checks }, null, 2));
  assert.ok(checks.every(check => check.noHorizontalOverflow));
  console.log(JSON.stringify({ videoStatus: video.analysisStatus, checks: checks.map(check => ({ surface: check.surface, width: check.width, noHorizontalOverflow: check.noHorizontalOverflow })) }, null, 2));
} finally {
  await browser.close();
}
