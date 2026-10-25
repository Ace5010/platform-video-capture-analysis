import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// All API requests are isolated fixtures, including auth and read-only POST search.
await mkdir('outputs/wechat-remote', {recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for (const width of [1440,390,320]) {
  const context=await browser.newContext({viewport:{width,height:900},locale:'zh-CN'});
  const calls=[];const errors=[];const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  const messages=[{id:'m0001',sender:'甲',time:'09:00:00',content:'<img src="https://exfil.invalid/private" onerror="window.leaked=true">'},
                  {id:'m0002',sender:'乙',time:'09:00:01',content:'这是已保存的完整讨论。'}];
  await context.route('**/*',async route=>{
   const r=route.request();const url=new URL(r.url());
   if(url.hostname==='exfil.invalid')throw new Error('Message HTML must never execute or fetch external resources');
   const path=url.pathname.replace(/^\/host/,'');
   if(!path.startsWith('/api/'))return route.continue();
   calls.push({path,query:url.searchParams.toString(),method:r.method(),body:r.postDataJSON()});
   let body={};
   if(path==='/api/auth/status')body={configured:true,authenticated:true,csrfToken:'c'.repeat(64),localHost:false};
   else if(path==='/api/state')body={accounts:[],videos:[],linkVideos:[],snapshots:[]};
   else if(path==='/api/jobs')body={jobs:[]};
   else if(path==='/api/wechat/context')body={groups:[{id:'group_test',name:'共享测试群',start:1792796400,end:1792882800}],members:[{id:'u_test',name:'甲'}],batches:[],read_jobs:[]};
   else if(path==='/api/wechat/days')body={days:['2026-10-23','2026-10-24'].map(date=>({date,ready:true,complete:true,summarizable:true}))};
   else if(path==='/api/wechat/summary')body={status:'ready',people:{},summary:{format_version:3,notes:[],topics:[0,1].map(n=>({title:`共享话题${n+1}`,navigation_title:`目录${n+1}`,summary:'这段总结来自电脑已保存的归档。',discussion_complete:true,discussion_count:2}))}};
   else if(path==='/api/wechat/original')body={messages,total:2,complete:true};
   else if(path==='/api/wechat/search'){
    const data=r.postDataJSON();body=data.anchor?{messages,total:2,anchor:data.anchor,next:null}:{messages,total:2,next:null};
   } else if(path.startsWith('/api/wechat/'))throw new Error('Remote page called management: '+path);
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,...body})});
  });
  await page.goto('http://localhost:3000/?module=wechat&view=manage',{waitUntil:'domcontentloaded'});
  try { await page.locator('.wxTopicReading h2').waitFor({timeout:30000}); }
  catch(error){console.log(JSON.stringify({url:page.url(),body:(await page.locator('body').innerText()).slice(0,700),calls,errors}));throw error;}
  assert.equal(await page.getByRole('button',{name:'读取管理',exact:true}).count(),0);
  assert.equal(await page.locator('.wxGenerate,.wxManagement,.wxLocalOnly').count(),0);
  assert.match(page.url(),/view=reading/);
  if(width<740)await page.getByRole('button',{name:'切换话题 ▾',exact:true}).click();
  await page.getByRole('button',{name:'目录2',exact:true}).click();
  assert.equal(await page.locator('.wxTopicReading h2').innerText(),'共享话题2');
  await page.getByRole('button',{name:/核对完整讨论/}).click();
  await page.locator('.wxSourcePane .wxMessage').last().waitFor();
  assert.equal(await page.locator('.wxSourcePane img').count(),0);
  assert.equal(await page.evaluate(()=>Boolean(window.leaked)),false);
  assert.match(calls.findLast(c=>c.path==='/api/wechat/original').query,/topic=1/);
  await page.getByRole('button',{name:'返回阅读',exact:true}).click();
  await page.getByRole('button',{name:'聊天原文',exact:true}).click();
  await page.locator('.wxMessages .wxMessage').last().waitFor();
  await page.getByRole('button',{name:'筛选',exact:true}).click();
  await page.getByLabel('关键词',{exact:true}).fill('完整讨论');
  await page.getByRole('button',{name:'应用筛选',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.wxMessages')?.textContent.includes('匹配消息'));
  await page.waitForTimeout(200);
  assert.ok(calls.some(c=>c.path==='/api/wechat/search'&&c.body.keyword==='完整讨论'));
  await page.getByRole('button',{name:'聊天总结',exact:true}).click();
  await page.getByRole('combobox',{name:'聊天日期',exact:true}).selectOption('2026-10-23');
  await page.waitForTimeout(200);
  assert.ok(calls.some(c=>c.path==='/api/wechat/summary'&&c.query.includes('date=2026-10-23')));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  assert.ok(calls.filter(c=>c.method==='POST').every(c=>c.path==='/api/wechat/search'));
  await page.screenshot({path:`outputs/wechat-remote/fixture-${width}.png`,fullPage:true});
  await context.close();
 }
 console.log('Remote WeChat browser passed: shared summary/original, topic/date/filter, management hidden, deep-link recovery, escaped messages, desktop/390/320px.');
} finally {await browser.close();}
