// Inspect real saved data and the multi-select UI; never submit valid work.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = 'outputs/wechat-queue-20261027';
await mkdir(output, { recursive: true });
const token = randomBytes(32).toString('base64url');
const csrf = createHash('sha256').update(`${token}douyin-monitor-csrf-v1`).digest('hex');
const env = { ...process.env, OBSERVE_TEST_SESSION: token, OBSERVE_TEST_CSRF: csrf };
execFileSync('python', ['-X', 'utf8', '-c', `
import os,hashlib
from host_service.config import HostConfig
from host_service.database import Database
Database(HostConfig.from_env()).create_session(hashlib.sha256(os.environ['OBSERVE_TEST_SESSION'].encode()).hexdigest(),hashlib.sha256(os.environ['OBSERVE_TEST_CSRF'].encode()).hexdigest(),'127.0.0.1',600)
`], { env });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  await context.addCookies([{ name: 'douyin_monitor_session', value: token, url: 'http://localhost:43129', httpOnly: true, sameSite: 'Strict' }]);
  const headers = { Origin: 'http://localhost:3000', 'X-CSRF-Token': csrf };
  // An invalid, empty selection proves the running backend loaded the new
  // endpoint without creating a job or making a paid model call.
  const response = await context.request.post('http://localhost:43129/api/wechat/analyze-batch', {
    headers, data: { groups: [], scope: 'all', mode: 'deepseek', confirmed: true, request_id: randomBytes(16).toString('hex') },
  });
  assert.equal(response.status(), 400);
  assert.match(JSON.stringify(await response.json()), /请选择不重复的群聊/);
  const writes = [], errors = [];
  await context.route('**/*', route => {
    if (route.request().method() !== 'GET') { writes.push(new URL(route.request().url()).pathname); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.name));
  await page.goto('http://localhost:3000/?module=wechat&view=reading', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '读取并总结', exact: true }).waitFor();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: '读取并总结', exact: true }).click();
    const setup = page.getByRole('dialog', { name: '读取并总结', exact: true });
    assert.ok(await setup.getByRole('checkbox').count() > 1);
    await setup.getByRole('button', { name: '全选', exact: true }).click();
    const count = await setup.locator('input:checked').count();
    const submit = setup.getByRole('button', { name: `加入队列（${count}）`, exact: true });
    assert.equal(await submit.isDisabled(), false);
    await submit.scrollIntoViewIfNeeded();
    assert.equal(await setup.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/live-setup-${width}.png` });
    await setup.getByRole('button', { name: '取消', exact: true }).click();
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log('Live multi-group UI passed at 1440/390/320px; running batch endpoint verified with rejected empty selection. No capture, summary or queue created.');
} finally {
  await browser?.close();
  execFileSync('python', ['-c', `
import os,hashlib
from host_service.config import HostConfig
from host_service.database import Database
Database(HostConfig.from_env()).delete_session(hashlib.sha256(os.environ['OBSERVE_TEST_SESSION'].encode()).hexdigest())
`], { env });
}
