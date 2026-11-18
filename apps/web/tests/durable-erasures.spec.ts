import { test, expect } from './fixtures';
import { denyWrite, rows } from './erasure-test-helpers';
import type { BrowserContext,Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const origin='http://127.0.0.1:5082',bob='m_'+'b'.repeat(32);
test.use({adminCatalog:true});
async function login(context:BrowserContext,user='bob'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function memberConfirm(page:Page){await expect(page.getByRole('radio').first()).toBeVisible();await page.getByRole('radio',{name:'只關閉帳號',exact:true}).check();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'確認關閉帳號',exact:true}).click();}
async function adminConfirm(page:Page){await page.getByLabel('輸入 DELETE 確認',{exact:true}).fill('DELETE');await page.getByRole('checkbox').check();await page.getByRole('button',{name:'確認刪除成分',exact:true}).click();}
for(const kind of ['member','admin'] as const)test(kind+' original proof survives closing every page and requires explicit receipt query',async({page,context})=>{
  await login(context,kind==='member'?'bob':'registration-admin');const url=kind==='member'?'/me/privacy':'/admin/music/'+bob+'/erase', endpoint=kind==='member'?'/me/privacy/erase':'/admin/music/'+bob+'/erase';let writes=0;
  await context.route('**/api/v2'+endpoint,async route=>{if(route.request().method()!=='POST')return route.continue();writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.goto(url);if(kind==='member')await memberConfirm(page);else await adminConfirm(page);
  const button=kind==='member'?'確認刪除結果':'查詢刪除結果';await expect(page.getByRole('button',{name:button,exact:true})).toBeVisible();const saved=await rows(page);expect(saved).toHaveLength(1);await page.close();
  const reopened=await context.newPage();await reopened.goto(url);await expect(reopened.getByRole('button',{name:button,exact:true})).toBeVisible();expect(await rows(reopened)).toEqual(saved);expect(writes).toBe(1);
  await reopened.getByRole('button',{name:button,exact:true}).click();await expect(reopened.getByRole('button',{name:'完成',exact:true})).toBeEnabled();expect(writes).toBe(1);
  await reopened.reload();await expect(reopened.getByRole('button',{name:'完成',exact:true})).toBeEnabled();await reopened.getByRole('button',{name:'完成',exact:true}).click();expect(await rows(reopened)).toEqual([]);
});
for(const kind of ['member','admin'] as const)test(kind+' aborted intent transaction never authorizes destructive HTTP',async({page,context})=>{
  await login(context,kind==='member'?'bob':'registration-admin');await page.goto(kind==='member'?'/me/privacy':'/admin/music/'+bob+'/erase');
  await expect(kind==='member'?page.getByRole('radio').first():page.getByLabel('輸入 DELETE 確認',{exact:true})).toBeVisible();await denyWrite(page);
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&(r.url().endsWith('/privacy/erase')||r.url().endsWith('/erase')))writes++;});
  if(kind==='member')await memberConfirm(page);else await adminConfirm(page);
  await expect(page.getByText(kind==='member'?'無法保存或核對原刪除紀錄，尚未提交刪除。':'無法保存或核對刪除操作編號及回執憑證，尚未送出。',{exact:false})).toBeVisible();expect(writes).toBe(0);expect(await rows(page)).toEqual([]);
});
for(const kind of ['member','admin'] as const)test(kind+' lost completion persistence keeps original proof and cannot dismiss before confirmation',async({page,context})=>{
  await login(context,kind==='member'?'bob':'registration-admin');await page.goto(kind==='member'?'/me/privacy':'/admin/music/'+bob+'/erase');
  await expect(kind==='member'?page.getByRole('radio').first():page.getByLabel('輸入 DELETE 確認',{exact:true})).toBeVisible();await denyWrite(page,'result');let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/erase'))writes++;});
  if(kind==='member')await memberConfirm(page);else await adminConfirm(page);
  await expect(page.getByText(kind==='member'?'伺服器刪除已完成，但無法保存本機確認狀態。':'尚未確認刪除結果。',{exact:false})).toBeVisible();expect(JSON.parse((await rows(page))[0]!.raw).result).toBeNull();
  page.on('dialog',d=>void d.accept());await page.reload();await page.getByRole('button',{name:kind==='member'?'確認刪除結果':'查詢刪除結果',exact:true}).click();await expect(page.getByRole('button',{name:'完成',exact:true})).toBeEnabled();expect(writes).toBe(1);
  const original=await rows(page);await denyWrite(page,'delete');await page.getByRole('button',{name:'完成',exact:true}).click();await expect(page.getByText('無法清除操作紀錄',{exact:false})).toBeVisible();expect(await rows(page)).toEqual(original);
  await page.getByRole('button',{name:'完成',exact:true}).click();expect(await rows(page)).toEqual([]);
});
test('member receipt 404 does not automatically replay and changed account blocks the exact original replay',async({page,context})=>{
  await login(context);let writes=0;const bodies:string[]=[];await page.route('**/api/v2/me/privacy/erase',async route=>{writes++;bodies.push(route.request().postData()!);await route.abort();});
  await page.goto('/me/privacy');await memberConfirm(page);await page.getByRole('button',{name:'確認刪除結果',exact:true}).click();await expect(page.getByRole('button',{name:'重新提交原刪除',exact:true})).toBeVisible();expect(writes).toBe(1);
  await login(context,'alice');await page.getByRole('button',{name:'重新提交原刪除',exact:true}).click();await expect(page.getByText('請先登入原帳號',{exact:false})).toBeVisible();expect(writes).toBe(1);
  await login(context);await page.getByRole('button',{name:'確認刪除結果',exact:true}).click();await page.getByRole('button',{name:'重新提交原刪除',exact:true}).click();await expect.poll(()=>writes).toBe(2);expect(bodies[0]).toBe(bodies[1]);
});
test('competing member tabs retain one intent and never replace it with a newly generated proof',async({page,context})=>{
  await login(context);const other=await context.newPage();await context.addInitScript(()=>{Object.defineProperty(window,'BroadcastChannel',{value:undefined});});await page.goto('/me/privacy');await other.goto('/me/privacy');
  for(const tab of [page,other]){await tab.getByRole('radio',{name:'只關閉帳號',exact:true}).check();await tab.getByRole('checkbox').check();}
  let writes=0;await context.route('**/api/v2/me/privacy/erase',async route=>{writes++;await route.abort();});
  await page.getByRole('button',{name:'確認關閉帳號',exact:true}).click();await expect(page.getByRole('button',{name:'確認刪除結果',exact:true})).toBeVisible();const saved=await rows(page);
  await other.getByRole('button',{name:'確認關閉帳號',exact:true}).click();await expect(other.getByText('其他分頁已更新刪除紀錄',{exact:false})).toBeVisible();expect(writes).toBe(1);expect(await rows(other)).toEqual(saved);
  await other.getByRole('button',{name:'重新讀取原操作',exact:true}).click();await expect(other.getByRole('button',{name:'確認刪除結果',exact:true})).toBeVisible();
});
test('mismatched member receipt is never acknowledged or used for local cleanup',async({page,context})=>{
  await login(context);await page.route('**/api/v2/me/privacy/erase',route=>route.abort());await page.goto('/me/privacy');await memberConfirm(page);const saved=await rows(page),input=JSON.parse(saved[0]!.raw).input;
  await page.route('**/api/v2/privacy/receipt',route=>route.fulfill({json:{requestId:input.requestId,target:'both',status:'completed'}}));await page.getByRole('button',{name:'確認刪除結果',exact:true}).click();await expect(page.getByText('尚未確認刪除結果。',{exact:false})).toBeVisible();await expect(page.getByRole('heading',{name:'帳號已關閉',exact:true})).toHaveCount(0);expect(await rows(page)).toEqual(saved);expect((await(await context.request.get('/api/v2/session')).json()).authenticated).toBe(true);
});
test('legacy secret raw is download-only, never archived in general draft versions',async({page,context})=>{
  await login(context);await page.goto('/me/privacy');await page.evaluate(()=>sessionStorage.setItem('qgroup:rebuild:privacy-pending:v1','{"secret":"synthetic proof",damaged'));
  await page.reload();await expect(page.getByRole('button',{name:'已保全，清除原紀錄',exact:true})).toBeDisabled();const download=page.waitForEvent('download');await page.getByRole('button',{name:'下載原刪除紀錄',exact:true}).click();const file=await download;
  expect(await readFile((await file.path())!,'utf8')).toBe('{"secret":"synthetic proof",damaged');await page.getByRole('button',{name:'已保全，清除原紀錄',exact:true}).click();await expect(page.getByRole('radio').first()).toBeVisible();
  expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.includes('privacy-pending')))).toEqual([]);expect(await rows(page)).toEqual([]);
});
test('reviewed proofs are excluded from generic drafts, versions and safe inbox inventory',async({page,context})=>{
  await login(context);await page.route('**/api/v2/me/privacy/erase',route=>route.abort());await page.goto('/me/privacy');await memberConfirm(page);const input=JSON.parse((await rows(page))[0]!.raw).input;
  const values=await page.evaluate(async()=>{
    if(!(await indexedDB.databases()).some(db=>db.name==='qgroup-reviewed-drafts-v1'))return [];const r=indexedDB.open('qgroup-reviewed-drafts-v1');const db=await new Promise<IDBDatabase>(resolve=>{r.onsuccess=()=>resolve(r.result);});try{return await new Promise<unknown[]>(resolve=>{const tx=db.transaction(['drafts','versions'],'readonly'),a=tx.objectStore('drafts').getAll(),b=tx.objectStore('versions').getAll();tx.oncomplete=()=>resolve([a.result,b.result]);});}finally{db.close();}
  });expect(JSON.stringify(values)).not.toContain(input.secret);expect(JSON.stringify(values)).not.toContain(input.requestId);
  page.on('dialog',d=>void d.accept());await page.goto('/inbox');await page.getByRole('button',{name:'重新檢查本機操作',exact:true}).click();await expect(page.getByRole('region',{name:'未完成操作',exact:true})).toContainText('資料刪除');expect(await page.content()).not.toContain(input.secret);await page.getByRole('link',{name:'資料刪除',exact:true}).click();await expect(page.getByRole('button',{name:'確認刪除結果',exact:true})).toBeVisible();
});
test('member cleanup failure survives reopen and retry only clears local data',async({page,context})=>{
  await login(context);await page.goto('/me/music');await page.getByRole('button',{name:'Aimer',exact:true}).click();await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();await page.goto('/me/privacy');await expect(page.getByRole('radio').first()).toBeVisible();
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.delete;IDBObjectStore.prototype.delete=function(key){const r=original.call(this,key);if(this.name==='drafts'){const tx=this.transaction;r.addEventListener('success',()=>{IDBObjectStore.prototype.delete=original;tx.abort();});}return r;};});
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/privacy/erase'))writes++;});await page.getByRole('checkbox').check();await page.getByRole('button',{name:'確認刪除成分',exact:true}).click();await expect(page.getByRole('button',{name:'重試清除本機原稿',exact:true})).toBeVisible();expect(JSON.parse((await rows(page))[0]!.raw).cleaned).toBe(false);await page.close();
  const next=await context.newPage();await next.goto('/me/privacy');await expect(next.getByRole('heading',{name:'成分已刪除',exact:true})).toBeVisible();await expect(next.getByRole('button',{name:'完成',exact:true})).toBeDisabled();await next.getByRole('button',{name:'重試清除本機原稿',exact:true}).click();await expect(next.getByRole('button',{name:'完成',exact:true})).toBeEnabled();expect(writes).toBe(1);
});
for(const kind of ['member','admin'] as const)test(kind+' legacy migration removes source only after dedicated transaction commits',async({page,context})=>{
  await login(context,kind==='member'?'bob':'registration-admin');const path=kind==='member'?'/me/privacy':'/admin/music/'+bob+'/erase';await page.goto(path);await expect(kind==='member'?page.getByRole('radio').first():page.getByLabel('輸入 DELETE 確認',{exact:true})).toBeVisible();
  const key=await page.evaluate(async kind=>{const viewer=await(await fetch('/api/v2/session')).json(),proof={requestId:crypto.randomUUID(),secret:'a'.repeat(64)};let key,value;
    if(kind==='member'){key='qgroup:rebuild:privacy-pending:v1';value={scope:viewer.scope,input:{...proof,target:'account',confirm:true,profileId:null,profileRevision:0}};}
    else{const admin=await(await fetch('/api/v2/admin/session',{headers:{'X-Account-Scope':viewer.scope}})).json(),preview=await(await fetch('/api/v2'+location.pathname,{headers:{'X-Account-Scope':viewer.scope}})).json();key='qgroup:rebuild:admin-music-erasure:v1:'+viewer.scope+':'+admin.scope+':'+location.pathname;value={path:location.pathname,input:{...proof,revision:preview.revision,confirm:'DELETE'}};}
    sessionStorage.setItem(key,JSON.stringify(value));return key;
  },kind);
  await page.addInitScript(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='operations'){const tx=this.transaction;r.addEventListener('success',()=>{IDBObjectStore.prototype.put=original;tx.abort();});}return r;};});await page.reload();
  await expect(page.getByText('無法讀取刪除操作紀錄',{exact:false})).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).not.toBeNull();expect(await rows(page)).toEqual([]);
  await page.getByRole('button',{name:'重新讀取刪除紀錄',exact:true}).click();await expect(page.getByRole('button',{name:kind==='member'?'確認刪除結果':'查詢刪除結果',exact:true})).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();expect(await rows(page)).toHaveLength(1);
});
test('renewed rescue authority can query original receipt but cannot replay an unsent deletion',async({page})=>{
  await page.goto('/admin');await page.getByLabel('管理救援憑證',{exact:true}).fill('synthetic-admin-rescue-'+'x'.repeat(32));await page.getByRole('button',{name:'使用救援憑證登入',exact:true}).click();await expect(page.getByText('管理授權：救援憑證（1 小時）',{exact:true})).toBeVisible();
  const path='/admin/music/'+bob+'/erase';let writes=0;await page.route('**/api/v2'+path,async route=>{if(route.request().method()!=='POST')return route.continue();writes++;await route.abort();});await page.goto(path);await adminConfirm(page);const saved=await rows(page);page.on('dialog',d=>void d.accept());await page.goto('/admin');
  await page.getByRole('checkbox',{name:'確認登出救援管理，保留目前會員登入',exact:true}).check();await page.getByRole('button',{name:'登出管理',exact:true}).click();await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();
  await page.getByLabel('管理救援憑證',{exact:true}).fill('synthetic-admin-rescue-'+'x'.repeat(32));await page.getByRole('button',{name:'使用救援憑證登入',exact:true}).click();await expect(page.getByText('管理授權：救援憑證（1 小時）',{exact:true})).toBeVisible();await page.goto(path);await page.getByRole('button',{name:'查詢刪除結果',exact:true}).click();await expect(page.getByRole('button',{name:'重新提交原刪除',exact:true})).toBeVisible();await page.getByRole('button',{name:'重新提交原刪除',exact:true}).click();await expect(page.getByText('原管理授權已變更',{exact:false})).toBeVisible();expect(writes).toBe(1);expect(await rows(page)).toEqual(saved);
});
test('mismatched admin receipt command remains pending',async({page,context})=>{
  await login(context,'registration-admin');const path='/admin/music/'+bob+'/erase';await page.route('**/api/v2'+path,async route=>{if(route.request().method()!=='POST')return route.continue();await route.abort();});await page.goto(path);await adminConfirm(page);const saved=await rows(page),input=JSON.parse(saved[0]!.raw).input;
  await page.route('**/api/v2/admin/music-erasure/receipt',route=>route.fulfill({json:{requestId:input.requestId,target:'admin_music',command:'reset_music',status:'completed',profiles:99,entries:99}}));await page.getByRole('button',{name:'查詢刪除結果',exact:true}).click();await expect(page.getByText('刪除回執不符原操作',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'完成',exact:true})).toHaveCount(0);expect(await rows(page)).toEqual(saved);
});
test('late account closure response after navigation keeps proof for explicit recovery',async({page,context})=>{
  await login(context);let release!:()=>void,arrived!:()=>void;const waiting=new Promise<void>(r=>release=r),captured=new Promise<void>(r=>arrived=r);await page.route('**/api/v2/me/privacy/erase',async route=>{const response=await route.fetch();arrived();await waiting;await route.fulfill({response}).catch(()=>{});});
  await page.goto('/me/privacy');await memberConfirm(page);await captured;const original=await rows(page);await page.getByRole('link',{name:'回到帳號',exact:true}).click();await expect(page).toHaveURL('/me/accounts');release();await page.goto('/me/privacy');await page.getByRole('button',{name:'確認刪除結果',exact:true}).click();await expect(page.getByRole('heading',{name:'帳號已關閉',exact:true})).toBeVisible();expect(JSON.parse(original[0]!.raw).result).toBeNull();
});
test('pending admin proof never enters current music export or mobile recovery content',async({page,context})=>{
  await login(context,'registration-admin');const path='/admin/music/'+bob+'/erase';await page.route('**/api/v2'+path,async route=>{if(route.request().method()!=='POST')return route.continue();await route.abort();});await page.goto(path);await adminConfirm(page);const proof=JSON.parse((await rows(page))[0]!.raw).input;
  await page.setViewportSize({width:360,height:800});await expect(page.getByRole('button',{name:'查詢刪除結果',exact:true})).toBeEnabled();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.content()).not.toContain(proof.secret);await page.screenshot({path:'test-results/unified-erasure-recovery-mobile.png',fullPage:true});
  const response=await context.request.get('/api/v2/admin/music-export',{headers:{'X-Account-Scope':JSON.parse((await rows(page))[0]!.raw).scope}});expect(response.ok()).toBe(true);const raw=await response.text();expect(raw).not.toContain(proof.secret);expect(raw).not.toContain(proof.requestId);
});
