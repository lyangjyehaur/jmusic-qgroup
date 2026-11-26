import { checkAdminReceipt } from './operation-helpers';
import { test,expect } from './fixtures';
import type { BrowserContext,Page } from '@playwright/test';
import sharp from 'sharp';
import { damageDraft,denyDraftWrites,durableRows } from './draft-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
function suite(kind:Kind,body:()=>void){test.describe(kind,()=>{test.use({adminCatalog:kind==='catalog',musicShouts:kind==='shouts'});body();});}
async function login(context:BrowserContext){await context.addCookies([{name:'kanban_session',value:'fixture-registration-admin',url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function auth(context:BrowserContext){const viewer=await(await context.request.get(origin+'/api/v2/session')).json(),access=await(await context.request.get(origin+'/api/v2/admin/session',{headers:{'X-Account-Scope':viewer.scope}})).json();return {viewer,access};}
async function settled(page:Page){await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);}
type Kind='catalog'|'appearance'|'shouts';
type Command='create'|'update'|'delete'|'merge'|'upload'|'config'|'toggle'|'move';
const path=(kind:Kind)=>kind==='catalog'?'/admin/music-entries':kind==='appearance'?'/admin/appearance':'/admin/shouts';
const label=(kind:Kind)=>({catalog:'音樂詞庫管理',appearance:'壁紙管理',shouts:'找搭子管理'})[kind];
const submit=(kind:Kind)=>kind==='catalog'?'確認詞條變更':kind==='appearance'?'確認壁紙變更':'確認刪除找搭子';
const retry=(kind:Kind)=>kind==='shouts'?'確認刪除結果':'確認原操作結果';
async function image(page:Page,name:string,color='#32859e'){
  await page.getByRole('button',{name:'上傳壁紙',exact:true}).click();await page.getByLabel('壁紙名稱（選填）',{exact:true}).fill(name);
  const buffer=await sharp({create:{width:20,height:10,channels:3,background:color}}).png().toBuffer();await page.getByLabel('壁紙圖片',{exact:true}).setInputFiles({name:'original.png',mimeType:'image/png',buffer});await expect(page.getByAltText('待上傳壁紙',{exact:true})).toBeVisible();return buffer.toString('base64');
}
async function confirm(page:Page,kind:Kind){await page.getByRole('checkbox').check();await page.getByRole('button',{name:submit(kind),exact:true}).click();}
async function prepare(page:Page,context:BrowserContext,kind:Kind,command:Command){
  await login(context);await page.goto(origin+path(kind));let bytes='';
  if(kind==='catalog'){
    if(command==='create')await page.getByRole('button',{name:'建立詞條',exact:true}).click();
    else await page.getByRole('button',{name:({update:'編輯 YOASOBI',delete:'刪除 YOASOBI',merge:'合併 YOASOBI'} as Record<string,string>)[command],exact:true}).click();
    if(command==='create'||command==='update')await page.getByLabel('詞條名稱',{exact:true}).fill('原管理音樂詞條');
    if(command==='merge')await page.getByLabel('合併目標',{exact:true}).selectOption('sub-1');
  }else if(kind==='appearance'){
    if(command==='upload')bytes=await image(page,'原圖管理稿');
    else if(command==='config'){await page.getByRole('button',{name:'設定輪播間隔',exact:true}).click();await page.getByLabel('輪播間隔（秒）',{exact:true}).fill('31');}
    else{
      await image(page,'海');await confirm(page,kind);await expect(page.getByText('壁紙設定已保存。',{exact:true})).toBeVisible();
      if(command==='move'){await image(page,'山','#944');await confirm(page,kind);await expect(page.getByText('壁紙設定已保存。',{exact:true})).toBeVisible();}
      await page.getByRole('button',{name:command==='move'?'上移 山':command==='toggle'?'停用 海':'刪除 海',exact:true}).click();
    }
  }else await page.getByRole('button',{name:'移除這則內容',exact:true}).click();
  await settled(page);return bytes;
}
async function done(page:Page,kind:Kind){await expect(page.getByText(kind==='catalog'?/^已(?:建立|保存|刪除|合併)詞條/:kind==='appearance'?'壁紙設定已保存。':'已刪除找搭子內容。',{exact:kind!=='catalog'})).toBeVisible();}
const commands:{kind:Kind;command:Command}[]=[...(['create','update','delete','merge'] as const).map(command=>({kind:'catalog' as const,command})),...(['upload','config','toggle','move','delete'] as const).map(command=>({kind:'appearance' as const,command})),{kind:'shouts',command:'delete'}];
for(const {kind,command} of commands)suite(kind,()=>{test(kind+' '+command+' replays a closed-tab result through the inbox with its original authority, target, UUID and body',async({page,context})=>{
  await prepare(page,context,kind,command);const writes:{url:string;key:string;body:string;authority:string}[]=[];
  const endpoint=kind==='shouts'?'**/api/v2/admin/shouts/*/delete':'**/api/v2'+path(kind);
  await context.route(endpoint,async route=>{if(route.request().method()!=='POST')return route.continue();const r=route.request();writes.push({url:r.url(),key:r.headers()['idempotency-key']!,body:r.postData()!,authority:r.headers()['x-admin-csrf']!});const response=await route.fetch();await route.fulfill(writes.length===1?{response,body:'{'}:{response});});
  await confirm(page,kind);await expect(page.getByText(kind==='catalog'?'尚未確認詞庫操作結果。':kind==='appearance'?'尚未確認壁紙操作結果。':'尚未確認刪除結果。',{exact:false})).toBeVisible();const row=(await durableRows(page)).find(row=>row.key.includes('admin-'+kind+':'))!,pending=JSON.parse(row.raw);expect(pending.pending.key).toBe(writes[0]!.key);
  if(kind==='appearance'&&command==='upload'){expect(pending.value.data).toBe('');expect(row.raw.split(pending.pending.input.data)).toHaveLength(2);}
  const {viewer}=await auth(context),before=await(await context.request.get(origin+'/api/v2'+path(kind)+(kind==='shouts'?'?period=active&offset=0&limit=10':''),{headers:{'X-Account-Scope':viewer.scope}})).json();await page.close();
  const fresh=await context.newPage();await fresh.goto(origin+'/inbox');const inbox=fresh.getByRole('region',{name:'未完成操作',exact:true});expect(await inbox.textContent()).not.toMatch(/原管理音樂詞條|原圖管理稿|週末一起聽音樂|base64/);await checkAdminReceipt(fresh,inbox,writes[0]!.key);expect(writes).toHaveLength(1);await inbox.getByRole('link',{name:label(kind),exact:true}).click();expect(writes).toHaveLength(1);await fresh.getByRole('button',{name:retry(kind),exact:true}).click();await done(fresh,kind);expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);const after=await(await context.request.get(origin+'/api/v2'+path(kind)+(kind==='shouts'?'?period=active&offset=0&limit=10':''),{headers:{'X-Account-Scope':viewer.scope}})).json();if(kind==='shouts'){expect(after.now).toBeGreaterThanOrEqual(before.now);const {now:beforeNow,...beforeData}=before,{now:afterNow,...afterData}=after;expect(afterData).toEqual(beforeData);expect(typeof beforeNow).toBe('number');expect(typeof afterNow).toBe('number');}else expect(after).toEqual(before);
});});
for(const kind of ['catalog','appearance','shouts'] as const)suite(kind,()=>{
  const command=kind==='catalog'?'create':kind==='appearance'?'upload':'delete';
  test(kind+' retains pending when the server accepts but its local confirmation transaction aborts',async({page,context})=>{
    await prepare(page,context,kind,command);await page.getByRole('checkbox').check();await settled(page);
    await page.evaluate(kind=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('admin-'+kind+':')&&typeof value.raw==='string'&&!JSON.parse(value.raw).pending)r.addEventListener('success',()=>{IDBObjectStore.prototype.put=original;this.transaction.abort();});return r;};},kind);
    const writes:string[]=[];await context.route(kind==='shouts'?'**/api/v2/admin/shouts/*/delete':'**/api/v2'+path(kind),route=>{if(route.request().method()==='POST')writes.push(route.request().headers()['idempotency-key']!);return route.continue();});await page.getByRole('button',{name:submit(kind),exact:true}).click();await expect(page.getByText('操作已送出，但無法保存確認狀態；請保留原操作並核對結果。',{exact:true})).toBeVisible();expect(JSON.parse((await durableRows(page)).find(row=>row.key.includes('admin-'+kind+':'))!.raw).pending.key).toBe(writes[0]);await page.close();const fresh=await context.newPage();await fresh.goto(origin+path(kind));await fresh.getByRole('button',{name:retry(kind),exact:true}).click();await done(fresh,kind);expect(writes).toHaveLength(2);expect(writes[1]).toBe(writes[0]);
  });
  test(kind+' blocks HTTP when the pending transaction aborts after a successful autosave',async({page,context})=>{
    await prepare(page,context,kind,command);const before=await durableRows(page);await denyDraftWrites(page,'admin-'+kind+':');let writes=0;page.on('request',r=>{if(r.method()==='POST')writes++;});await confirm(page,kind);await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);expect(await durableRows(page)).toEqual(before);
  });
  test(kind+' restores closed-tab input and original image bytes only after review, without retaining confirmation',async({page,context})=>{
    const bytes=await prepare(page,context,kind,command);await page.getByRole('checkbox').check();const before=await durableRows(page);await page.close();const fresh=await context.newPage();await fresh.goto(origin+path(kind));await expect(fresh.getByRole('checkbox')).not.toBeChecked();await expect(fresh.getByRole('button',{name:submit(kind),exact:true})).toBeDisabled();await fresh.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(fresh.getByRole('checkbox')).not.toBeChecked();
    if(kind==='catalog')await expect(fresh.getByLabel('詞條名稱',{exact:true})).toHaveValue('原管理音樂詞條');if(kind==='appearance')expect(await fresh.getByAltText('待上傳壁紙',{exact:true}).getAttribute('src')).toBe('data:image/png;base64,'+bytes);if(kind==='shouts'){await expect(fresh.getByRole('region',{name:'刪除找搭子確認',exact:true})).toContainText('週末一起聽音樂');await expect(fresh.getByRole('button',{name:'移除這則內容',exact:true})).toBeDisabled();}
    expect(await durableRows(fresh)).toEqual(before);
  });
  test(kind+' migrates exact legacy operations only after the transaction commits',async({page,context})=>{
    await prepare(page,context,kind,command);const row=(await durableRows(page)).find(row=>row.key.includes('admin-'+kind+':'))!,saved=JSON.parse(row.raw);const input=kind==='catalog'?{command:'create',revision:saved.value.revision,confirm:true,name:saved.value.name,kind:saved.value.kind,category:saved.value.category}:kind==='appearance'?{command:'upload',revision:saved.value.revision,confirm:true,name:saved.value.name,mime:saved.value.mime,data:saved.value.data}:{revision:(await(await context.request.get(origin+'/api/v2/admin/shouts/'+saved.id,{headers:{'X-Account-Scope':(await auth(context)).viewer.scope}})).json()).revision,confirm:true};const operationKey=crypto.randomUUID(),draft={...saved,pending:{key:operationKey,input}};if(kind==='appearance')draft.value.data='';const raw=JSON.stringify(draft);
    await page.evaluate(async({key,raw})=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(key);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();sessionStorage.setItem(key,raw);},{key:row.key,raw});
    await page.addInitScript(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('admin-'))r.addEventListener('success',()=>this.transaction.abort());return r;};});page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),row.key)).toBe(raw);expect((await durableRows(page)).filter(r=>r.key===row.key)).toEqual([]);
    const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.evaluate(({key,raw})=>sessionStorage.setItem(key,raw),{key:row.key,raw});let writes=0;await fresh.route(kind==='shouts'?'**/api/v2/admin/shouts/*/delete':'**/api/v2'+path(kind),route=>{if(route.request().method()==='POST'){writes++;expect(route.request().headers()['idempotency-key']).toBe(operationKey);expect(route.request().postDataJSON()).toEqual(input);}return route.continue();});await fresh.goto(origin+path(kind));await expect(fresh.getByRole('button',{name:retry(kind),exact:true})).toBeVisible();expect(await fresh.evaluate(key=>sessionStorage.getItem(key),row.key)).toBeNull();expect((await durableRows(fresh)).find(r=>r.key===row.key)!.raw).toBe(raw);expect(writes).toBe(0);await fresh.getByRole('button',{name:retry(kind),exact:true}).click();await done(fresh,kind);expect(writes).toBe(1);
  });
  test(kind+' preserves inconsistent pending payloads instead of executing an unreviewed command',async({page,context})=>{
    await prepare(page,context,kind,command);const row=(await durableRows(page)).find(row=>row.key.includes('admin-'+kind+':'))!,saved=JSON.parse(row.raw);if(kind==='shouts')saved.id='';saved.pending={key:crypto.randomUUID(),input:kind==='shouts'?{revision:0,confirm:true}:{command:'delete',revision:saved.value.revision,id:'unreviewed-target',confirm:true}};const raw=JSON.stringify(saved);await damageDraft(page,'admin-'+kind+':',raw);page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();let writes=0;page.on('request',r=>{if(r.method()==='POST')writes++;});await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(page,'versions')).map(row=>row.raw)).toContain(raw);expect(writes).toBe(0);
  });
});
for(const kind of ['catalog','appearance'] as const)suite(kind,()=>{test(kind+' preserves both tab versions and resets confirmation when loading a recovery version',async({page,context})=>{
  await prepare(page,context,kind,kind==='catalog'?'create':'upload');const field=(p:Page)=>p.getByLabel(kind==='catalog'?'詞條名稱':'壁紙名稱（選填）',{exact:true});const other=await context.newPage();await other.goto(origin+path(kind));await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await other.getByRole('checkbox').check();await field(page).fill('第一分頁原稿');await settled(page);await field(other).fill('第二分頁原稿');await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();await other.getByRole('button',{name:'讀取已保存版本',exact:true}).click();await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(other.getByRole('checkbox')).not.toBeChecked();await other.getByRole('checkbox').check();await other.getByText('草稿版本（1）',{exact:true}).click();await other.getByRole('button',{name:'載入此原稿（保留目前版本）',exact:true}).click();await expect(field(other)).toHaveValue('第二分頁原稿');await expect(other.getByRole('checkbox')).not.toBeChecked();const versions=(await durableRows(other,'versions')).map(row=>JSON.parse(row.raw));expect(versions.map(row=>row.value.name)).toEqual(expect.arrayContaining(['第一分頁原稿','第二分頁原稿']));
  if(kind==='appearance'){expect(versions[0].value.data).toBe(versions[1].value.data);expect(versions[0].value.data.length).toBeGreaterThan(0);await other.getByRole('button',{name:/^草稿版本/}).click();const download=other.waitForEvent('download');await other.getByRole('button',{name:'下載保全檔',exact:true}).first().click();expect((await download).suggestedFilename()).toMatch(/^qgroup-draft-/);await other.getByRole('button',{name:'關閉草稿版本',exact:true}).click();await other.bringToFront();await other.setViewportSize({width:360,height:800});expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await other.screenshot({path:'test-results/unified-admin-content-recovery-mobile.png',fullPage:true});}
});});
