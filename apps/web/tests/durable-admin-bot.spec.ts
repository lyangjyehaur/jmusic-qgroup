import { selectControl, expectControlValue } from './kimi-controls';
import { checkAdminReceipt } from './operation-helpers';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { damageDraft, denyDraftWrites, durableRows } from './draft-helpers';
import { readFile } from 'node:fs/promises';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, interval = '主動發送最小間隔（秒）', confirmation = '我已核對發送模式、群政策與設定變更';
type Command = 'save' | 'revert';
async function login(context: BrowserContext, user = 'registration-admin') {
  await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);
}
async function headers(context: BrowserContext) {
  const viewer = await (await context.request.get(origin+'/api/v2/session')).json();
  const access = await (await context.request.get(origin+'/api/v2/admin/session',{headers:{'X-Account-Scope':viewer.scope}})).json();
  return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'X-Admin-CSRF':access.adminCsrf,'Idempotency-Key':crypto.randomUUID()};
}
async function current(context: BrowserContext) { return (await context.request.get(origin+'/api/v2/admin/bot',{headers:await headers(context)})).json(); }
async function advance(context: BrowserContext, seconds: number) {
  const before = await current(context);
  const result = await context.request.post(origin+'/api/v2/admin/bot',{headers:await headers(context),data:{command:'save',revision:before.revision,config:{...before.config,min_interval_seconds:seconds,dry_run:false},confirm:true}});
  expect(result.ok()).toBe(true); return current(context);
}
async function settled(page: Page) {
  await expect(page.getByText('正在讀取本機原稿…',{exact:true})).toHaveCount(0);
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
}
async function prepare(page: Page, context: BrowserContext, command: Command = 'save') {
  await login(context); if(command==='revert')await advance(context,70);
  await page.goto(origin+'/admin/bot'); await expect(page.getByLabel(interval,{exact:true})).toBeEnabled();
  if(command==='save') { await page.getByLabel(interval,{exact:true}).fill('61'); await selectControl(page.getByLabel('發送模式',{exact:true}), 'simulate'); }
  else await page.getByRole('button',{name:'恢復上一版',exact:true}).click();
  await settled(page);
}
async function submit(page: Page, command: Command = 'save') {
  await page.getByRole('checkbox',{name:confirmation,exact:true}).check();
  await page.getByRole('button',{name:command==='save'?'確認 bot 設定':'確認恢復上一版',exact:true}).click();
}
const retry = (page: Page) => page.getByRole('button',{name:'確認原操作結果',exact:true});
async function pending(page: Page) { await expect(retry(page)).toBeVisible();await expect(page.getByText('尚未確認 bot 設定結果，原稿與操作編號已保留，請確認原操作結果。',{exact:true})).toBeVisible(); }
async function botDraft(page: Page) { return (await durableRows(page)).find(row=>row.key.includes('admin-bot:'))!; }
for(const command of ['save','revert'] as const) {
  test(command+' survives closing the tab, returns from inbox and acknowledges the exact command while showing newer settings',async({page,context})=>{
    await prepare(page,context,command);const writes:{key:string;body:string;authority:string}[]=[];
    await context.route('**/api/v2/admin/bot',async route=>{
      if(route.request().method()!=='POST')return route.continue();const request=route.request();writes.push({key:request.headers()['idempotency-key']!,body:request.postData()!,authority:request.headers()['x-admin-csrf']!});
      const response=await route.fetch();await route.fulfill(writes.length===1?{response,body:'{'}:{response});
    });
    await submit(page,command);await pending(page);const raw=(await botDraft(page)).raw;expect(JSON.parse(raw).pending.input.command).toBe(command);await page.close();
    const latest=await advance(context,99),fresh=await context.newPage();await fresh.goto(origin+'/inbox');const inbox=fresh.getByRole('region',{name:'未完成操作',exact:true});expect(await inbox.textContent()).not.toMatch(/group_openid|templates|61|activity_published/);await checkAdminReceipt(fresh,inbox,writes[0]!.key);expect(writes).toHaveLength(1);await inbox.getByRole('link',{name:'bot 設定',exact:true}).click();
    expect(writes).toHaveLength(1);expect((await botDraft(fresh)).raw).toBe(raw);await retry(fresh).click();await expect(fresh.getByText('bot 設定已保存。',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);
    await expectControlValue(fresh.getByLabel(interval,{exact:true}), '99');expect((await current(context)).revision).toBe(latest.revision);expect((await current(context)).config).toEqual(latest.config);await fresh.goto(origin+'/inbox');await expect(fresh.getByRole('region',{name:'未完成操作',exact:true})).toHaveCount(0);
  });
  test(command+' waits for the pending transaction commit and sends nothing when a successful put is aborted',async({page,context})=>{
    await prepare(page,context,command);const before=await botDraft(page);await denyDraftWrites(page,'admin-bot:');let writes=0;page.on('request',r=>{if(r.url().endsWith('/admin/bot')&&r.method()==='POST')writes++;});await submit(page,command);await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);expect(await botDraft(page)).toEqual(before);await expect(page.getByRole('checkbox',{name:confirmation,exact:true})).toBeChecked();
  });
  test(command+' retains the original operation when local completion is aborted after acceptance',async({page,context})=>{
    await prepare(page,context,command);const writes:{key:string;body:string}[]=[];await context.route('**/api/v2/admin/bot',route=>{if(route.request().method()==='POST')writes.push({key:route.request().headers()['idempotency-key']!,body:route.request().postData()!});return route.continue();});
    await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('admin-bot:')&&!JSON.parse(value.raw).pending)r.addEventListener('success',()=>{IDBObjectStore.prototype.put=put;this.transaction.abort();});return r;};});
    await submit(page,command);await expect(page.getByText('設定已保存，但無法保存本機確認狀態；請保留原操作並核對結果。',{exact:true})).toBeVisible();const before=await current(context);expect(JSON.parse((await botDraft(page)).raw).pending.key).toBe(writes[0]!.key);await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/admin/bot');await retry(fresh).click();await expect(fresh.getByText('bot 設定已保存。',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect((await current(context)).revision).toBe(before.revision);
  });
  test(command+' keeps its accepted receipt when the latest-settings read fails definitively',async({page,context})=>{
    await prepare(page,context,command);let accepted=false;await page.route('**/api/v2/admin/bot',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();accepted=true;return route.fulfill({response});}return accepted?route.fulfill({status:404,json:{code:'NOT_FOUND',message:'synthetic interrupted refresh'}}):route.continue();});
    await submit(page,command);await pending(page);const raw=(await botDraft(page)).raw;expect(JSON.parse(raw).pending).toBeDefined();await page.unroute('**/api/v2/admin/bot');await retry(page).click();await expect(page.getByText('bot 設定已保存。',{exact:true})).toBeVisible();
  });
}
test('restores incomplete policy, all template variants and group rows explicitly while discarding preview and confirmation',async({page,context})=>{
  await prepare(page,context);await page.getByLabel('沿用部署目標群',{exact:true}).uncheck();await page.getByRole('button',{name:'新增群政策',exact:true}).click();await page.getByLabel('群標識 1',{exact:true}).fill('synthetic-durable-group');await page.getByLabel('群名稱 1',{exact:true}).fill('原始群名稱');await page.getByLabel('自訂模板',{exact:true}).fill('原文字模板 {url}');await page.getByLabel('Markdown 模板',{exact:true}).check();await page.getByLabel('自訂模板',{exact:true}).fill('## 原 Markdown\n{url}');await page.getByRole('button',{name:'預覽模板',exact:true}).click();await expect(page.getByRole('region',{name:'模板預覽',exact:true})).toBeVisible();await page.getByRole('checkbox',{name:confirmation,exact:true}).check();await page.getByLabel(interval,{exact:true}).fill('');await settled(page);const before=JSON.parse((await botDraft(page)).raw);await page.close();
  const fresh=await context.newPage();await fresh.goto(origin+'/admin/bot');await expectControlValue(fresh.getByLabel('群標識 1',{exact:true}), 'synthetic-durable-group');await expect(fresh.getByLabel(interval,{exact:true})).toBeDisabled();await fresh.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expectControlValue(fresh.getByLabel(interval,{exact:true}), '');await expect(fresh.getByRole('checkbox',{name:confirmation,exact:true})).not.toBeChecked();await expect(fresh.getByRole('region',{name:'模板預覽',exact:true})).toHaveCount(0);expect(JSON.parse((await botDraft(fresh)).raw).value).toEqual(before.value);await fresh.getByLabel('Markdown 模板',{exact:true}).check();await expectControlValue(fresh.getByLabel('自訂模板',{exact:true}), '## 原 Markdown\n{url}');await submit(fresh);await expect(fresh.getByText('提醒與發送間隔必須填寫整數。',{exact:true})).toBeVisible();expect((await current(context)).revision).toBe(0);
});
test('competing browser tabs preserve both policy drafts and loading a version resets confirmation and preview',async({page,context})=>{
  await prepare(page,context);const other=await context.newPage();await other.goto(origin+'/admin/bot');await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await page.getByLabel(interval,{exact:true}).fill('71');await settled(page);await other.getByLabel(interval,{exact:true}).fill('72');await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();await other.getByRole('button',{name:'讀取已保存版本',exact:true}).click();await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await other.getByRole('button',{name:'預覽模板',exact:true}).click();await other.getByRole('checkbox',{name:confirmation,exact:true}).check();await other.getByText('草稿版本（1）',{exact:true}).click();await other.getByRole('button',{name:'載入此原稿（保留目前版本）',exact:true}).click();await expectControlValue(other.getByLabel(interval,{exact:true}), '72');await expect(other.getByRole('checkbox',{name:confirmation,exact:true})).not.toBeChecked();await expect(other.getByRole('region',{name:'模板預覽',exact:true})).toHaveCount(0);const versions=(await durableRows(other,'versions')).map(row=>JSON.parse(row.raw).value.min_interval_seconds);expect(versions).toEqual(expect.arrayContaining(['71','72']));await other.getByRole('button',{name:/^草稿版本/}).click();const download=other.waitForEvent('download');await other.getByRole('button',{name:'下載保全檔',exact:true}).first().click();expect(JSON.parse(await readFile((await(await download).path())!,'utf8')).value).toBeDefined();await other.getByRole('button',{name:'關閉草稿版本',exact:true}).click();await other.setViewportSize({width:360,height:800});expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await other.getByRole('button',{name:'恢復上一版',exact:true}).scrollIntoViewIfNeeded();await other.screenshot({path:'test-results/unified-durable-bot-recovery-mobile.png',animations:'disabled'});
});
test('session pending is removed only after durable import commits and no submitted setting is automatically replayed',async({page,context})=>{
  await prepare(page,context);await page.route('**/api/v2/admin/bot',route=>route.request().method()==='POST'?route.abort():route.continue());await submit(page);await pending(page);const row=await botDraft(page);await page.evaluate(async row=>{sessionStorage.setItem(row.key,row.raw);const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(row.key);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}},row);
  await page.addInitScript(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('admin-bot:'))r.addEventListener('success',()=>this.transaction.abort());return r;};});page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),row.key)).toBe(row.raw);expect((await durableRows(page)).filter(item=>item.key===row.key)).toEqual([]);
  const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.evaluate(row=>sessionStorage.setItem(row.key,row.raw),row);let writes=0;fresh.on('request',r=>{if(r.url().endsWith('/admin/bot')&&r.method()==='POST')writes++;});await fresh.goto(origin+'/admin/bot');await expect(retry(fresh)).toBeVisible();expect(await fresh.evaluate(key=>sessionStorage.getItem(key),row.key)).toBeNull();expect((await botDraft(fresh)).raw).toBe(row.raw);expect(writes).toBe(0);await retry(fresh).click();await expect(fresh.getByText('bot 設定已保存。',{exact:true})).toBeVisible();expect(writes).toBe(1);
});
for(const action of ['send','preview'] as const)test('a revoked policy draft cannot '+action+' even without cross-tab notifications',async({page,context,browser})=>{
  await context.addInitScript(()=>Object.defineProperty(window,'BroadcastChannel',{value:undefined,configurable:true}));const manager=await browser.newContext({baseURL:origin});try{await login(manager);expect((await manager.request.post('/api/v2/admin/users/bob/role',{headers:await headers(manager),data:{isAdmin:true,revision:0,confirm:true}})).ok()).toBe(true);await login(context,'bob');await page.goto(origin+'/admin/bot');await page.getByLabel(interval,{exact:true}).fill('63');await settled(page);expect((await manager.request.post('/api/v2/admin/users/bob/role',{headers:await headers(manager),data:{isAdmin:false,revision:1,confirm:true}})).ok()).toBe(true);const denied=await context.newPage();await denied.goto(origin+'/admin');await expect(denied.getByLabel('管理救援憑證',{exact:true})).toBeVisible();let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/admin/bot'))writes++;});if(action==='send')await submit(page);else await page.getByRole('button',{name:'預覽模板',exact:true}).click();await expect(page.getByText('此管理原稿已因登出或權限變更失效，請重新載入頁面。',{exact:false})).toBeVisible();expect(writes).toBe(0);expect((await durableRows(denied)).filter(row=>row.key.includes('admin-bot:'))).toEqual([]);}finally{await manager.close();}
});
test('an inconsistent pending body is preserved without sending an unreviewed bot policy',async({page,context})=>{
  await prepare(page,context);await page.route('**/api/v2/admin/bot',route=>route.request().method()==='POST'?route.abort():route.continue());await submit(page);await pending(page);const raw=JSON.parse((await botDraft(page)).raw);raw.pending.input.config.min_interval_seconds=62;await damageDraft(page,'admin-bot:',JSON.stringify(raw));page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();let writes=0;page.on('request',r=>{if(r.url().endsWith('/admin/bot')&&r.method()==='POST')writes++;});await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(page,'versions')).map(row=>row.raw)).toContain(JSON.stringify(raw));expect(writes).toBe(0);
});
for(const action of ['preview','rebase'] as const)test(action+' refreshes management authority on a definitive denial and clears the scoped policy draft',async({page,context,browser})=>{
  const manager=await browser.newContext({baseURL:origin});try{
    await login(manager);expect((await manager.request.post('/api/v2/admin/users/bob/role',{headers:await headers(manager),data:{isAdmin:true,revision:0,confirm:true}})).ok()).toBe(true);
    await login(context,'bob');await page.goto(origin+'/admin/bot');await page.getByLabel(interval,{exact:true}).fill('64');await settled(page);const key=(await botDraft(page)).key;
    expect((await manager.request.post('/api/v2/admin/users/bob/role',{headers:await headers(manager),data:{isAdmin:false,revision:1,confirm:true}})).ok()).toBe(true);
    await page.getByRole('button',{name:action==='preview'?'預覽模板':'核對最新版，保留輸入',exact:true}).click();await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'bot 設定核對',exact:true})).toHaveCount(0);expect((await durableRows(page)).filter(row=>row.key===key)).toEqual([]);expect((await durableRows(page,'versions')).filter(row=>row.key===key)).toEqual([]);
  }finally{await manager.close();}
});
test('leaving after a failed draft write waits for storage recovery and keeps the original policy input',async({page,context})=>{
  await prepare(page,context);await denyDraftWrites(page,'admin-bot:');await page.getByLabel(interval,{exact:true}).fill('88');await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();await page.getByRole('link',{name:'管理後臺',exact:true}).click();await page.getByRole('button',{name:'保留原稿並離開',exact:true}).click();expect(new URL(page.url()).pathname).toBe('/admin/bot');await expectControlValue(page.getByLabel(interval,{exact:true}), '88');
});
