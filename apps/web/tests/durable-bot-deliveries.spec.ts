import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { damageDraft, durableRows } from './draft-helpers';
import { readFile } from 'node:fs/promises';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, confirmation='我已核對目標群、發送模式與重送內容';
const activity='/activities/listen/bot-deliveries', poll='/time-polls/poll-exact/bot-deliveries';
test.use({botDeliveryExamples:true});
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function open(page:Page,context:BrowserContext,path=activity,id='1'){await login(context);await page.goto(origin+path+'?delivery='+id);await expect(page.getByRole('checkbox',{name:confirmation,exact:true})).toBeEnabled();}
async function submit(page:Page){await page.getByRole('checkbox',{name:confirmation,exact:true}).check();await page.getByRole('button',{name:'建立重送工作',exact:true}).click();}
const recover=(page:Page)=>page.getByRole('button',{name:'查回原重送結果',exact:true});
async function draft(page:Page){return (await durableRows(page)).find(row=>row.key.includes('bot-delivery:')&&row.raw!=='null')!;}
async function policy(context:BrowserContext,live:boolean){
 await login(context,'registration-admin');const viewer=await(await context.request.get(origin+'/api/v2/session')).json(),access=await(await context.request.get(origin+'/api/v2/admin/session',{headers:{'X-Account-Scope':viewer.scope}})).json();
 const headers={'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'X-Admin-CSRF':access.adminCsrf,'Idempotency-Key':crypto.randomUUID(),Origin:origin};
 const before=await(await context.request.get(origin+'/api/v2/admin/bot',{headers})).json();
 expect((await context.request.post(origin+'/api/v2/admin/bot',{headers,data:{command:'save',revision:before.revision,config:{...before.config,dry_run:!live},confirm:true}})).ok()).toBe(true);await login(context);
}
for(const [path,id] of [[activity,'1'],[poll,'6']])test(path+' recovers an accepted command after closing through member inbox, with no second POST',async({page,context})=>{
 await open(page,context,path,id);const writes:{key:string;body:string}[]=[];
 await context.route('**/api/v2'+path+'/'+id+'/retry',async route=>{writes.push({key:route.request().headers()['idempotency-key']!,body:route.request().postData()!});const response=await route.fetch();await route.fulfill({response,body:'{'});});
 await submit(page);await expect(recover(page)).toBeVisible();const original=await draft(page);await page.close();
 const fresh=await context.newPage();await fresh.goto(origin+'/inbox');const inventory=fresh.getByRole('region',{name:'未完成操作',exact:true});await expect(inventory.getByRole('link',{name:'群通知重送',exact:true})).toBeVisible();expect(await inventory.textContent()).not.toContain(JSON.parse(original.raw).input.reviewToken);
 const receipt=fresh.waitForResponse(r=>r.url().endsWith('/me/operations/'+writes[0]!.key));await inventory.getByRole('button',{name:'核對結果',exact:true}).click();expect(await(await receipt).json()).toEqual({committed:true});
 await inventory.getByRole('link',{name:'群通知重送',exact:true}).click();expect((await draft(fresh)).raw).toBe(original.raw);await recover(fresh).click();await expect(fresh.getByText(/已建立待送工作 #7/)).toBeVisible();expect(writes).toHaveLength(1);expect(await draft(fresh)).toBeUndefined();
 await fresh.goto(origin+'/inbox');await expect(fresh.getByRole('region',{name:'未完成操作',exact:true})).toHaveCount(0);
});
test('completion abort keeps an accepted original and later only acknowledges its receipt',async({page,context})=>{
 await open(page,context);let writes=0;page.on('request',r=>{if(r.url().endsWith('/retry')&&r.method()==='POST')writes++;});
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('bot-delivery:')&&value.raw==='null')r.addEventListener('success',()=>{IDBObjectStore.prototype.put=put;this.transaction.abort();});return r;};});
 await submit(page);await expect(page.getByText('已建立待送工作，但無法保存本機確認狀態；請保留原操作並查回結果。',{exact:true})).toBeVisible();const original=await draft(page);await page.close();const fresh=await context.newPage();await fresh.goto(origin+activity);await recover(fresh).click();await expect(fresh.getByText(/已建立待送工作 #7/)).toBeVisible();expect(writes).toBe(1);expect(original.raw).toContain('reviewToken');expect(await draft(fresh)).toBeUndefined();
});
test('rejection acknowledgement abort preserves the rejected original until its result can be saved',async({page,context})=>{
 await open(page,context);let writes=0;await page.route('**/api/v2'+activity+'/1/retry',async route=>{writes++;await route.fulfill({status:409,json:{code:'BOT_DELIVERY_CHANGED',message:'synthetic changed review'}});});
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('bot-delivery:')&&value.raw==='null')r.addEventListener('success',()=>{IDBObjectStore.prototype.put=put;this.transaction.abort();});return r;};});
 await submit(page);await expect(page.getByText('無法保存拒絕結果；原重送操作仍保留，請重新核對。',{exact:true})).toBeVisible();const original=await draft(page);await page.reload();await recover(page).click();await page.getByRole('button',{name:'以原操作編號重送',exact:true}).click();await expect(page.getByText('synthetic changed review',{exact:true})).toBeVisible();expect(writes).toBe(2);expect(await draft(page)).toBeUndefined();expect(original).toBeDefined();
});
for(const field of ['originalId','entity','entityId'] as const)test('mismatched receipt '+field+' remains pending without a new queue',async({page,context})=>{
 await open(page,context);let writes=0;await page.route('**/api/v2'+activity+'/1/retry',route=>{writes++;return route.abort();});await submit(page);await expect(recover(page)).toBeVisible();const original=await draft(page);
 await page.route('**/api/v2/bot-delivery-results/*',route=>route.fulfill({json:{state:'completed',result:{originalId:'1',queuedId:'7',entity:'activity',entityId:'listen',[field]:field==='originalId'?'6':field==='entity'?'poll':'other'}}}));
 await recover(page).click();await expect(page.getByText('原重送回執的通知或活動不符，請保全紀錄後核對。',{exact:true})).toBeVisible();expect((await draft(page)).raw).toBe(original.raw);expect(writes).toBe(1);await expect(page.getByRole('button',{name:'以原操作編號重送',exact:true})).toHaveCount(0);
});
test('accepted simulation is only acknowledged after live policy changes, never submitted again',async({page,context})=>{
 await policy(context,false);await open(page,context);let writes=0;await context.route('**/api/v2'+activity+'/1/retry',async route=>{writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});await submit(page);await expect(recover(page)).toBeVisible();await page.close();await policy(context,true);const fresh=await context.newPage();await fresh.goto(origin+activity);await recover(fresh).click();await expect(fresh.getByText(/已建立待送工作 #7/)).toBeVisible();expect(writes).toBe(1);
});
test('an absent old review never substitutes a new token after policy changes',async({page,context})=>{
 await open(page,context);const writes:{key:string;body:string}[]=[];let block=true;await context.route('**/api/v2'+activity+'/1/retry',route=>{writes.push({key:route.request().headers()['idempotency-key']!,body:route.request().postData()!});return block?route.abort():route.continue();});await submit(page);await expect(recover(page)).toBeVisible();await page.close();await policy(context,false);block=false;const fresh=await context.newPage();await fresh.goto(origin+activity);await recover(fresh).click();await fresh.getByRole('button',{name:'以原操作編號重送',exact:true}).click();await expect(fresh.getByText('通知、設定或權限已有變更，請重新核對',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect(await draft(fresh)).toBeUndefined();
});
test('two tabs preserve competing command IDs and conflict recovery clears resend and confirmation',async({page,context})=>{
 await open(page,context);const other=await context.newPage();await other.goto(origin+activity+'?delivery=1');await expect(other.getByRole('checkbox',{name:confirmation,exact:true})).toBeEnabled();let writes=0;await context.route('**/api/v2'+activity+'/1/retry',route=>{writes++;return route.abort();});
 await submit(page);await expect(recover(page)).toBeVisible();const original=await draft(page);await submit(other);await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();expect(writes).toBe(1);expect((await durableRows(other,'versions')).filter(row=>row.key===original.key).length).toBeGreaterThan(0);
 await other.getByRole('button',{name:'讀取已保存版本',exact:true}).click();expect((await draft(other)).raw).toBe(original.raw);await expect(other.getByRole('button',{name:'以原操作編號重送',exact:true})).toHaveCount(0);await recover(other).click();await expect(other.getByRole('button',{name:'以原操作編號重送',exact:true})).toBeVisible();expect(writes).toBe(1);
});
test('damaged original is preserved and downloaded without sending or exposing it in the inbox',async({page,context})=>{
 await open(page,context);await page.route('**/api/v2'+activity+'/1/retry',route=>route.abort());await submit(page);await expect(recover(page)).toBeVisible();const raw='PRIVATE_DAMAGED_COMMAND';await damageDraft(page,'bot-delivery:',raw);await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();await expect(recover(page)).toHaveCount(0);
 await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(page,'versions')).map(row=>row.raw)).toContain(raw);await page.getByText('草稿版本（1）',{exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'下載保全檔',exact:true}).first().click();expect(await readFile((await(await download).path())!,'utf8')).toBe(raw);await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-durable-delivery-mobile.png',fullPage:true});
 await page.goto(origin+'/inbox');await expect(page.getByRole('region',{name:'未完成操作',exact:true})).toBeVisible();await expect(page.getByText(raw,{exact:false})).toHaveCount(0);
});
test('authority loss hides content but retains the scoped command and another account cannot recover it',async({page,context})=>{
 await open(page,context);await page.route('**/api/v2'+activity+'/1/retry',route=>route.abort());await submit(page);await expect(recover(page)).toBeVisible();const original=await draft(page);
 await page.route('**/api/v2/bot-delivery-results/*',route=>route.fulfill({status:403,json:{code:'FORBIDDEN',message:'synthetic permission revoked'}}));await recover(page).click();await expect(page.getByText('目前帳號或通知核對權限已變更。',{exact:false})).toBeVisible();await expect(recover(page)).toHaveCount(0);await expect(page.getByText('合成失敗通知內容',{exact:true})).toHaveCount(0);expect((await draft(page)).raw).toBe(original.raw);
 await page.close();await login(context,'bob');const other=await context.newPage();await other.goto(origin+'/inbox');await expect(other.getByRole('link',{name:'群通知重送',exact:true})).toHaveCount(0);await other.goto(origin+activity);await expect(other.getByText('目前帳號或通知核對權限已變更。',{exact:false})).toBeVisible();await expect(recover(other)).toHaveCount(0);expect((await draft(other)).raw).toBe(original.raw);
});
test('logout fences a stale review without BroadcastChannel or a retry HTTP request',async({page,context})=>{
 await context.addInitScript(()=>Object.defineProperty(window,'BroadcastChannel',{value:undefined,configurable:true}));await open(page,context);const other=await context.newPage();await other.goto(origin+'/me/accounts');await other.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(other).toHaveURL(origin+'/me');let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/retry'))writes++;});
 await page.getByRole('checkbox',{name:confirmation,exact:true}).evaluate(el=>(el as HTMLInputElement).click());await page.getByRole('button',{name:'建立重送工作',exact:true}).evaluate(el=>(el as HTMLButtonElement).click());await expect(page.getByText('此原稿已因登出或資料刪除失效，請重新載入頁面。',{exact:false})).toBeVisible();expect(writes).toBe(0);expect(await draft(other)).toBeUndefined();
});
test('administrator inspection never creates a durable retry command',async({page,context})=>{
 await login(context,'registration-admin');await page.goto(origin+'/admin/bot/deliveries?delivery=1');await expect(page.getByRole('region',{name:'通知核對 #1',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'建立重送工作',exact:true})).toHaveCount(0);expect(await page.evaluate(async()=> (await indexedDB.databases()).filter(db=>db.name==='qgroup-reviewed-drafts-v1'))).toEqual([]);
});
test('session import removes its source only after commit and never automatically resends',async({page,context})=>{
 await open(page,context);await page.route('**/api/v2'+activity+'/1/retry',route=>route.abort());await submit(page);await expect(recover(page)).toBeVisible();const original=await draft(page);
 await page.evaluate(async row=>{sessionStorage.setItem(row.key,row.raw);const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(row.key);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}},original);
 await page.addInitScript(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('bot-delivery:'))r.addEventListener('success',()=>this.transaction.abort());return r;};});await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),original.key)).toBe(original.raw);expect(await draft(page)).toBeUndefined();
 const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.evaluate(row=>sessionStorage.setItem(row.key,row.raw),original);let writes=0;fresh.on('request',r=>{if(r.url().endsWith('/retry')&&r.method()==='POST')writes++;});await fresh.goto(origin+activity);await expect(recover(fresh)).toBeVisible();expect(await fresh.evaluate(key=>sessionStorage.getItem(key),original.key)).toBeNull();expect((await draft(fresh)).raw).toBe(original.raw);expect(writes).toBe(0);await recover(fresh).click();await expect(fresh.getByRole('button',{name:'以原操作編號重送',exact:true})).toBeVisible();expect(writes).toBe(0);
});
