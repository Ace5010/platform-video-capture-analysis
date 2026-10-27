import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { deflateSync } from 'node:zlib';

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(320, 0); header.writeUInt32BE(160, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.alloc((320 * 3 + 1) * 160);
for (let y = 0; y < 160; y++) for (let x = 0; x < 320; x++) {
  const offset = y * 961 + 1 + x * 3;
  pixels.set(x < 160 ? [30, 140, 180] : [235, 164, 70], offset);
}
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
const id = 'a'.repeat(64);
const resources = [
  { kind: 'image', label: '图片', status: 'ready', assets: [{ id, mime: 'image/png', bytes: png.length, name: '聊天图片', tier: 'received' }] },
  { kind: 'website', label: '网页', status: 'ready', text: '已经读取的网站正文，保留原有观点及信息。', assets: [] },
  { kind: 'audio', label: '语音', status: 'missing', error: '本机尚无完整语音，需要在微信中加载后补取' },
];
await fs.mkdir('outputs/wechat-resources', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    const errors = [], writes = [], assetReads = [];
    let retryCount=0;
    const missingImage={kind:'image',label:'图片',status:'missing',error:'仅有缩略图',error_code:'thumbnail_only',
      detail:'请在电脑微信中打开大图后重试',assets:[{id,mime:'image/png',bytes:png.length,name:'图片缩略图',tier:'thumbnail'}]};
    const chatMessages=[
      {id:'m_fixture',sender:'群友甲',time:'10:30:00',content:'[图片：未获取原件]',resources},
      {id:'m_thumbnail',sender:'群友乙',time:'10:31:00',content:'[图片：未获取原件]',resources:[missingImage]},
      {id:'m_absent',sender:'群友丙',time:'10:32:00',content:'[图片：未获取原件]',resources:[{kind:'image',label:'图片',status:'missing',error:'未找到图片文件'}]},
      {id:'m_broken',sender:'群友丁',time:'10:33:00',content:'[图片：未获取原件]',resources:[{kind:'image',label:'图片',status:'missing',error:'图片解析失败',detail:'图片解密校验失败'}]},
    ];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('douyin-monitor.sqlite-migration.v1', 'isolated-test'));
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.port !== '43129' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/host/')) return route.continue();
      const path = url.pathname.replace(/^\/host/, '');
      if (path.endsWith('/wechat/asset')) {
        assetReads.push(url.searchParams.get('group'));
        return route.fulfill({ status: 200, contentType: 'image/png', body: png });
      }
      if (req.method() !== 'GET') writes.push({ path, body: req.postDataJSON() });
      let body = { ok: true };
      if (path.endsWith('/auth/status')) body = { authenticated: true, configured: true, csrfToken: 'isolated' };
      else if (path.endsWith('/state')) body = { state: { accounts: [], videos: [], snapshots: [], linkVideos: [] } };
      else if (path.endsWith('/jobs')) body = { jobs: [] };
      else if (path.endsWith('/wechat/context')) body = { groups: [{ id: 'group_fixture', name: '资源验证群', start: 1792857600, end: 1792900002,
        resource_coverage: { total: 3, ready: 2, missing: 1, complete: false } }], members: [], batches: [], read_jobs: [] };
      else if (path.endsWith('/wechat/days')) body = { days: [{ date: '2026-10-25', ready: false, summarizable: true }] };
      else if (path.endsWith('/wechat/summary')) body = { status: 'missing' };
      else if (path.endsWith('/wechat/generation')) body = { job: null };
      else if (path.endsWith('/wechat/search')) body = { total: chatMessages.length, messages: chatMessages };
      else if (path.endsWith('/wechat/retry-image')) {
        assert.deepEqual(req.postDataJSON(),{group:'group_fixture',message:'m_thumbnail',confirmed:true});
        retryCount++;
        if(retryCount===1)return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'请等待当前任务完成后重试图片'})});
        body={message:'m_thumbnail',resources:[resources[0]]};
      }
      else if (path.endsWith('/wechat/read')) body = { job: { id: 'fixture', status: 'running', kind: 'resources' } };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('http://localhost:3000/?module=wechat&view=reading', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '查看当天全部聊天', exact: true }).click();
    const picture = page.getByAltText('聊天图片', { exact: true });
    await picture.waitFor();
    await picture.evaluate(async img => { await img.decode(); });
    assert.equal(await picture.evaluate(img => img.naturalWidth), 320);
    await page.getByText('网页正文', { exact: true }).click();
    await page.getByText('已经读取的网站正文，保留原有观点及信息。', { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const details = document.querySelector('.wxResource details');
      return details?.open && getComputedStyle(details, '::details-content').opacity === '1'
        && details.clientHeight >= details.querySelector('p').clientHeight + details.querySelector('summary').clientHeight;
    });
    assert.ok(!(await page.locator('.wxMessages').innerText()).includes('未获取原件'));
    assert.ok((await page.locator('.wxMessages').innerText()).includes('本机尚无完整语音'));
    assert.ok(assetReads.every(group=>group==='group_fixture'));
    await page.screenshot({ path: `outputs/wechat-resources/reading-${width}.png`, animations: 'disabled' });
    const thumbnail=page.locator('[data-message-id="m_thumbnail"]');
    await thumbnail.scrollIntoViewIfNeeded();
    await thumbnail.getByAltText('图片缩略图').waitFor();
    await thumbnail.getByAltText('图片缩略图').evaluate(img=>img.decode());
    assert.equal(await thumbnail.getByText('仅有缩略图',{exact:true}).count(),1);
    assert.equal(await page.getByText('未找到图片文件',{exact:true}).count(),1);
    assert.equal(await page.getByText('图片解析失败',{exact:true}).count(),1);
    await page.screenshot({path:`outputs/wechat-resources/thumbnail-${width}.png`,animations:'disabled'});
    await thumbnail.getByRole('button',{name:'重试',exact:true}).click();
    await thumbnail.getByRole('alert').waitFor();
    await thumbnail.getByRole('button',{name:'重试',exact:true}).click();
    await thumbnail.getByAltText('聊天图片').waitFor();
    assert.equal(await thumbnail.getByText('缩略图',{exact:true}).count(),0);
    assert.equal(await thumbnail.getByRole('alert').count(),0);
    assert.equal(await page.getByText('未找到图片文件',{exact:true}).count(),1);
    assert.equal(await page.locator('.wxMessages').evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.getByRole('button', { name: '补取附件与网页', exact: true }).count(), 0);
    assert.equal(writes.filter(w => !w.path.endsWith('/search') && !w.path.endsWith('/retry-image')).length, 0);
    assert.equal(retryCount,2);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('WeChat resources browser: 1440/390/320, thumbnail decoding and label, distinct missing reasons, single-image retry failure/recovery, other messages preserved.');
} finally { await browser.close(); }
