import { createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext,Page } from '@playwright/test';
import { test,expect } from './fixtures';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,scope=(id='alice')=>createHash('sha256').update('kanban-drafts-v1:'+id).digest('hex');
const fields=[{name:'title',value:'舊活動原文字',checked:undefined},{name:'id',value:''}];
const draft=(suffix='event:new',data:unknown={fields,dataset:{intent:'fixed-original-intent',revision:'7'}})=>({key:'draft:'+scope()+':'+suffix,data,at:1234567});
const operation=()=>({key:'request:'+scope()+':'+'b'.repeat(64),scope:scope(),requestKey:'c'.repeat(64),path:'/api/events',method:'POST',data:{client_intent:'fixed-original-intent',title:'原請求內容',base_revision:7},status:'pending',at:1234567});
async function login(context:BrowserContext,id='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+id,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function seed(page:Page,rows:unknown[],version=1){await page.goto('/activities');await page.evaluate(async({rows,version})=>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('kanban-local-v1',version);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('entries'))r.result.createObjectStore('entries',{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite');for(const row of rows)tx.objectStore('entries').put(row);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}
},{rows,version});}
async function rows(page:Page,source=false){return page.evaluate(async source=>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(source?'kanban-local-v1':'qgroup-legacy-local-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise<{key?:string;raw:string;scope:string;source:unknown;id:string}[]>((resolve,reject)=>{const tx=db.transaction(source?'entries':'snapshots'),r=tx.objectStore(source?'entries':'snapshots').getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
},source);}
const loaded=(page:Page)=>expect(page.getByRole('button',{name:'重新讀取舊紀錄',exact:true})).toBeVisible();
async function denySnapshots(page:Page){await page.addInitScript(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='snapshots')r.addEventListener('success',()=>this.transaction.abort());return r;};});}
test('preserves all original form families with exact scope, base revisions, intent and undefined fields, and isolates accounts',async({page,context})=>{
  await login(context);const originals=[draft(),draft('copy:listen'),draft('time-poll:new',{fields,slots:[{id:'old-slot',date:'2099-12-23',time:''}],intent:'fixed-poll-intent'}),draft('rooms:listen',{rooms:[{id:'fixed-room',amount:'7.25',person_ids:['person']}],revision:7}),draft('invoice:listen',{fields,event:{revision:7,settlement:{version:3}},roster:{collector:{id:'alice'}},people:[],items:[],paymentCodes:[]}),draft('finance:listen:record:new',{fields,edit:{recordId:'fixed-record',custom:[],preview:null},revision:7}),{...draft(),key:'draft:'+scope('bob')+':event:new',data:{fields:[{name:'title',value:'另一個帳號私稿'}],dataset:{}}},operation()];
  await seed(page,originals);await page.goto('/me/local-history');await loaded(page);expect(await rows(page,true)).toHaveLength(originals.length);expect(await rows(page,true)).toEqual(expect.arrayContaining(originals));expect(await rows(page)).toHaveLength(7);
  expect((await rows(page)).map(r=>r.source)).toEqual(expect.arrayContaining(originals.filter(r=>r.key.includes(scope()))));
  await page.getByText('表單內容',{exact:true}).first().click();await expect(page.getByText('舊活動原文字',{exact:true}).filter({visible:true})).toBeVisible();await expect(page.getByText('另一個帳號私稿',{exact:true})).toHaveCount(0);
  await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/me/local-history');await loaded(fresh);expect(await rows(fresh)).toHaveLength(7);
  await login(context,'bob');await fresh.reload();await loaded(fresh);await fresh.getByText('表單內容',{exact:true}).click();await expect(fresh.getByText('另一個帳號私稿',{exact:true})).toBeVisible();await expect(fresh.getByText('舊活動原文字',{exact:true})).toHaveCount(0);
});
test('reads current React original captures and checks their fixed create intent without a request row or new operation',async({page,context})=>{
  await login(context);const intent='11111111-1111-4111-8111-111111111111';
  const originals=[draft('event:new',{react:1,value:{id:'',_intent:intent,_revision:'',_lifecycle:'',title:'React 原活動',timezone:'America/New_York'},revision:undefined}),draft('time-poll:new',{react:1,value:{title:'React 原投票',client_intent:intent,slots:[{key:'slot-2',date:'2099-12-24',time:'18:00'},{key:'slot-1',date:'2099-12-23',time:'19:00'}],deadlineTouched:true},revision:undefined}),draft('rooms:listen',{react:1,value:{rooms:[{id:'room-original',person_ids:['person-original']}]},revision:7}),draft('invoice:listen',{react:1,value:{people:[],items:[{receipt:{version:3,item_id:'image-original'}}],codes:[{kind:'other',version:3}]},revision:7}),draft('finance:listen:record:new',{react:1,value:{recordId:'record-original',kind:'collection',amount:'7.25'},revision:7})];
  await seed(page,originals);await page.goto('/me/local-history');await loaded(page);expect((await rows(page)).map(row=>row.source)).toEqual(expect.arrayContaining(originals));await expect(page.getByText(/格式尚未完成映射/)).toHaveCount(0);await expect(page.getByRole('button',{name:'下載此舊草稿',exact:true})).toHaveCount(5);
  const activity=page.getByRole('heading',{name:'舊活動草稿',exact:true}).locator('..');await activity.getByText('表單內容',{exact:true}).click();await expect(activity.getByText('React 原活動',{exact:true})).toBeVisible();await expect(activity.getByText('America/New_York',{exact:true})).toBeVisible();
  let queries=0,writes=0,body:unknown;page.on('request',r=>{if(r.url().includes('/me/create-intents/view')){queries++;body=r.postDataJSON();}else if(['POST','PUT','PATCH','DELETE'].includes(r.method()))writes++;});
  await activity.getByRole('button',{name:'核對原活動建立識別',exact:true}).click();await expect(activity.getByText(/不能據此認定未建立/)).toBeVisible();expect(body).toEqual({kind:'activity',intent});expect(queries).toBe(1);expect(writes).toBe(0);
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-legacy-react-mobile.png',fullPage:true});
  const other=await context.newPage();await seed(other,[{...originals[0],data:{react:1,value:{id:'',_intent:intent,_revision:'',_lifecycle:'',title:'另一個舊分頁的後續編輯'},revision:undefined}}]);await activity.getByRole('button',{name:'核對原活動建立識別',exact:true}).click();await expect(activity.getByText(/舊分頁已更新原紀錄/)).toBeVisible();expect(queries).toBe(1);expect(await rows(page)).toHaveLength(6);await other.close();
  await page.goto('/activities/new');await expect(page.getByText(/此操作仍有舊看板原稿/)).toBeVisible();expect(writes).toBe(0);
});
test('retains old settlement image bytes through a real browser profile restart and downloads a tagged original without clearing source',async({playwright},info)=>{
  const directory=await mkdtemp(join(tmpdir(),'qgroup-legacy-local-')),launch=()=>playwright.chromium.launchPersistentContext(directory,{headless:true,channel:info.project.use.channel,serviceWorkers:'block',baseURL:origin});let context:BrowserContext|undefined;
  try{
    context=await launch();await login(context);let page=await context.newPage();await page.goto('/activities');
    const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=12;canvas.height=12;canvas.getContext('2d')!.fillRect(0,0,12,12);return canvas.toDataURL().split(',')[1]!;});
    const original=draft('invoice:listen',{fields,people:[],items:[{id:'original-item',amount:'7.25',receipt:image}],rooms:[],custom:[],paymentCodes:[{kind:'other',image}],event:{revision:7,settlement:{version:3}}});
    await seed(page,[original]);await page.goto('/me/local-history');await loaded(page);const before=await rows(page);await context.close();context=await launch();await login(context);page=await context.newPage();await page.goto('/me/local-history');await loaded(page);
    expect(await rows(page)).toEqual(before);await page.getByText('費用與憑證',{exact:true}).click();await expect(page.getByRole('img',{name:'舊草稿圖片',exact:true})).toHaveAttribute('src','data:image/png;base64,'+image);
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'下載此舊草稿',exact:true}).click();const file=await download,path=await file.path();const {readFile}=await import('node:fs/promises');expect(await readFile(path!,'utf8')).toBe(before[0]!.raw);expect((await rows(page,true))[0]).toEqual(original);
    await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-legacy-local-mobile.png',fullPage:true});
  }finally{await context?.close();await rm(directory,{recursive:true,force:true});}
});
test('aborted archive puts do not count as preservation, leave source unchanged and block related new forms',async({page,context})=>{
  await login(context);const original=draft();await seed(page,[original]);await denySnapshots(page);let queries=0;page.on('request',r=>{if(r.url().includes('/legacy-requests/check'))queries++;});
  await page.goto('/activities/new');await expect(page.getByRole('button',{name:'重新讀取',exact:true})).toBeVisible();expect(await rows(page,true)).toEqual([original]);expect(await rows(page)).toHaveLength(0);expect(queries).toBe(0);
});
test('checks real missing receipts with original payload and key, retains done rows and never sends a replacement',async({page,context})=>{
  await login(context);const original={...operation(),status:'done'};await seed(page,[original]);await page.goto('/me/local-history');await loaded(page);let writes=0,checked:unknown;
  page.on('request',r=>{if(r.url().includes('/legacy-requests/check'))checked=r.postDataJSON();else if(['POST','PUT','PATCH','DELETE'].includes(r.method()))writes++;});
  await page.getByRole('button',{name:'核對原請求結果',exact:true}).click();await expect(page.getByText(/尚未查到原回執/)).toBeVisible();expect(checked).toEqual({requestKey:original.requestKey,path:original.path,method:original.method,data:original.data});expect(writes).toBe(0);expect((await rows(page,true))[0]).toEqual(original);
  await page.reload();await loaded(page);await expect(page.getByText(/尚未查到原回執/)).toHaveCount(0);await page.goto('/activities/new');await expect(page.getByText(/此操作仍有舊看板原稿/)).toBeVisible();expect(writes).toBe(0);
});
test('shows an explicitly checked committed target and recovers a lost read response without changing the original operation',async({page,context})=>{
  await login(context);await seed(page,[operation()]);let checks=0;await page.route('**/api/v2/me/legacy-requests/check',async route=>{checks++;if(checks===1)await route.abort('failed');else await route.fulfill({json:{committed:true,target:{kind:'activity',id:'listen'}}});});
  await page.goto('/me/local-history');await loaded(page);await page.getByRole('button',{name:'核對原請求結果',exact:true}).click();await expect(page.getByText('連線未完成，請先核對結果後重試。',{exact:true})).toBeVisible();
  await page.reload();await loaded(page);expect(checks).toBe(1);await page.getByRole('button',{name:'核對原請求結果',exact:true}).click();await expect(page.getByRole('link',{name:'查看原活動',exact:true})).toHaveAttribute('href','/activities/listen');expect(checks).toBe(2);expect((await rows(page,true))[0]).toEqual(operation());
});
test('preserves competing old versions and prevents querying a superseded source snapshot',async({page,context})=>{
  await login(context);const original=operation();await seed(page,[original]);await page.goto('/me/local-history');await loaded(page);const other=await context.newPage();await seed(other,[{...original,data:{...original.data,title:'另一份舊分頁内容'}}]);
  let checks=0;page.on('request',r=>{if(r.url().includes('/legacy-requests/check'))checks++;});await page.getByRole('button',{name:'核對原請求結果',exact:true}).click();await expect(page.getByText(/舊分頁已更新原紀錄/)).toBeVisible();expect(checks).toBe(0);expect(await rows(page)).toHaveLength(2);
  await page.getByRole('button',{name:'重新讀取舊紀錄',exact:true}).click();await expect(page.getByRole('heading',{name:'舊活動建立結果',exact:true})).toHaveCount(2);expect(await rows(page,true)).toHaveLength(1);
});
test('does not send original requests under a different account',async({page,context})=>{
  await login(context);await seed(page,[operation()]);await page.goto('/me/local-history');await loaded(page);await login(context,'bob');let checks=0;page.on('request',r=>{if(r.url().includes('/legacy-requests/check'))checks++;});await page.getByRole('button',{name:'核對原請求結果',exact:true}).click();
  await expect(page.getByText(/此帳號在這個瀏覽器沒有舊看板紀錄/)).toBeVisible();expect(checks).toBe(0);expect(await rows(page,true)).toHaveLength(1);
});
test('logout clears archive and original scoped records, fences late receipt responses and does not reimport obsolete pages',async({page,context})=>{
  await login(context);await seed(page,[operation(),draft()]);await page.goto('/me/local-history');await loaded(page);let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});let arrived!:()=>void;const reached=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/api/v2/me/legacy-requests/check',async route=>{arrived();await pending;await route.fulfill({json:{committed:true,target:{kind:'activity',id:'listen'}}});});await page.getByRole('button',{name:'核對原請求結果',exact:true}).click();await reached;
  const other=await context.newPage();await other.goto('/me/accounts');await other.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(other.getByRole('link',{name:'登入',exact:true})).toBeVisible();release();await expect(page.getByRole('link',{name:'查看原活動',exact:true})).toHaveCount(0);expect(await rows(page)).toHaveLength(0);expect(await rows(page,true)).toHaveLength(0);
  await login(context,'bob');await seed(other,[draft()]);await page.reload();await loaded(page);await expect(page.getByText(/舊分頁不能自動寫回/)).toBeVisible();expect(await rows(page)).toHaveLength(0);expect(await rows(page,true)).toHaveLength(1);
});
test('unknown shapes stay preserved and block conversion, without exporting or revealing embedded credentials',async({page,context})=>{
  await login(context);const original=draft('future-editor',{someFuture:{revision:77},pin:'SECRET_PIN',oauth:'SECRET_OAUTH'});await seed(page,[original]);await page.goto('/me/local-history');await loaded(page);await expect(page.getByText(/格式尚未完成映射/)).toBeVisible();await expect(page.getByRole('button',{name:'下載此舊草稿',exact:true})).toHaveCount(0);await expect(page.getByText(/SECRET_PIN|SECRET_OAUTH/)).toHaveCount(0);expect((await rows(page))[0]!.source).toEqual(original);
  for(const path of ['/activities/new','/time-polls/new','/activities/listen/finance']){await page.goto(path);await expect(page.getByText(/此操作仍有舊看板原稿/)).toBeVisible();}
});
test('recognizable old drafts with credential fields remain private and cannot be displayed or downloaded',async({page,context})=>{
  await login(context);const original=draft('event:new',{fields:[{name:'pin',value:'PRIVATE_PIN'},{name:'csrfToken',value:'PRIVATE_CSRF'}],dataset:{intent:'original'}});await seed(page,[original]);await page.goto('/me/local-history');await loaded(page);
  await expect(page.getByText(/不能展示或匯出/)).toBeVisible();await expect(page.getByText(/PRIVATE_PIN|PRIVATE_CSRF/)).toHaveCount(0);await expect(page.getByRole('button',{name:'下載此舊草稿',exact:true})).toHaveCount(0);expect((await rows(page))[0]!.source).toEqual(original);
});
test('does not create an absent original database or upgrade an unknown source version',async({page,context})=>{
  await login(context);await page.goto('/me/local-history');await loaded(page);expect(await page.evaluate(async()=>(await indexedDB.databases()).some(db=>db.name==='kanban-local-v1'))).toBe(false);
  await seed(page,[draft()],2);await page.goto('/activities/new');await expect(page.getByText(/舊儲存版本無法辨識/)).toBeVisible();expect(await rows(page,true)).toHaveLength(1);expect(await page.evaluate(async()=>(await indexedDB.databases()).find(db=>db.name==='kanban-local-v1')!.version)).toBe(2);
});
test('logout fences an import that already read its original source but has not committed its archive',async({page,context})=>{
  await login(context);await seed(page,[draft()]);await page.addInitScript(()=>{
    const original=SubtleCrypto.prototype.digest;
    SubtleCrypto.prototype.digest=async function(algorithm,data){
      const bytes=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
      if(new TextDecoder().decode(bytes).includes('kanban-local-v1-preserved')){
        (window as unknown as {legacyHashWaiting:boolean}).legacyHashWaiting=true;
        await new Promise<void>(resolve=>{(window as unknown as {releaseLegacyHash:()=>void}).releaseLegacyHash=resolve;});
      }
      return original.call(this,algorithm,data);
    };
  });
  await page.goto('/me/local-history');await expect.poll(()=>page.evaluate(()=>(window as unknown as {legacyHashWaiting:boolean}).legacyHashWaiting)).toBe(true);
  const other=await context.newPage();await other.goto('/me/accounts');await other.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(other.getByRole('link',{name:'登入',exact:true})).toBeVisible();
  await page.evaluate(()=>(window as unknown as {releaseLegacyHash:()=>void}).releaseLegacyHash());await expect(page.getByRole('heading',{name:'舊活動草稿',exact:true})).toHaveCount(0);expect(await rows(page)).toHaveLength(0);expect(await rows(page,true)).toHaveLength(0);
});
test('a failed source cleanup keeps originals blocked until explicit local retry, without repeating server logout',async({page,context})=>{
  await login(context);await seed(page,[draft()]);await page.goto('/me/local-history');await loaded(page);await page.goto('/me/accounts');await page.evaluate(()=>{
    const original=IDBCursor.prototype.delete;
    IDBCursor.prototype.delete=function(){const r=original.call(this);const tx=(this.source as IDBObjectStore).transaction;if((this.source as IDBObjectStore).name==='entries')r.addEventListener('success',()=>tx.abort());return r;};
    (window as unknown as {restoreLegacyDelete:()=>void}).restoreLegacyDelete=()=>{IDBCursor.prototype.delete=original;};
  });
  let logouts=0;page.on('request',r=>{if(r.url().endsWith('/auth/logout')&&r.method()==='POST')logouts++;});await page.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(page.getByText(/本機原稿清除失敗/)).toBeVisible();expect(await rows(page)).toHaveLength(0);expect(await rows(page,true)).toHaveLength(1);
  await page.evaluate(()=>(window as unknown as {restoreLegacyDelete:()=>void}).restoreLegacyDelete());await page.getByRole('button',{name:'重試清除本機原稿',exact:true}).click();await expect(page.getByRole('button',{name:'重試清除本機原稿',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'登入',exact:true})).toBeVisible();expect(logouts).toBe(1);expect(await rows(page,true)).toHaveLength(0);
});
