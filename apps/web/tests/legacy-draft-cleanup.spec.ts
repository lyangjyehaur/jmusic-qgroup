import { createHash } from 'node:crypto';
import type { BrowserContext,Page } from '@playwright/test';
import { test,expect } from './fixtures';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
const scope=(id='alice')=>createHash('sha256').update('kanban-drafts-v1:'+id).digest('hex');
const oldDraft=(id='alice',suffix='event:new')=>({key:'draft:'+scope(id)+':'+suffix,data:{fields:[{name:'title',value:'舊版未送出草稿'},{name:'id',value:''}],dataset:{intent:'old-intent'}},at:Date.now()+86400000});
const oldRequest=(status='pending')=>({key:'request:'+scope()+':'+(status==='pending'?'b':'d').repeat(64),scope:scope(),requestKey:'c'.repeat(64),method:'POST',path:'/api/events',data:{client_intent:'old-intent',title:'原請求內容'},status,at:1234567});
async function login(context:BrowserContext,id='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+id,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function seed(page:Page,rows:unknown[]){await page.evaluate(async rows=>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('kanban-local-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('entries',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite');for(const row of rows)tx.objectStore('entries').put(row);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}
},rows);}
async function read(page:Page,dbName='kanban-local-v1',storeName='entries'){return page.evaluate(async({dbName,storeName})=>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(dbName);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise<Record<string,unknown>[]>((resolve,reject)=>{const tx=db.transaction(storeName),r=tx.objectStore(storeName).getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
},{dbName,storeName});}
const clear=(page:Page)=>page.getByRole('button',{name:'清除舊版草稿，重新填寫',exact:true}).click();
const blocked=(page:Page)=>expect(page.getByText(/此操作仍有舊看板原稿/)).toBeVisible();
test('clears scoped legacy source, snapshots and mappings while preserving native drafts, versions and another account',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await page.getByLabel('活動名稱',{exact:true}).fill('新版未送出活動');
  await expect.poll(async()=>JSON.stringify(await read(page,'qgroup-reviewed-drafts-v1','drafts'))).toContain('新版未送出活動');
  const native=await read(page,'qgroup-reviewed-drafts-v1','drafts');
  await page.evaluate(async row=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1');const db=await new Promise<IDBDatabase>(resolve=>{r.onsuccess=()=>resolve(r.result);});await new Promise<void>(resolve=>{const tx=db.transaction('versions','readwrite');tx.objectStore('versions').put({id:'native-version',key:row.key,scope:row.scope,raw:row.raw,at:1,reason:'新版歷史原稿'});tx.oncomplete=()=>resolve();});db.close();},native[0]!);
  const versions=await read(page,'qgroup-reviewed-drafts-v1','versions');
  await page.evaluate(()=>sessionStorage.setItem('qgroup:rebuild:untouched','新版分頁草稿'));
  const other=oldDraft('bob');await seed(page,[oldDraft(),oldDraft('alice','future-editor'),oldDraft('alice','invoice:listen'),other]);
  await page.goto('/me/local-history');await expect(page.getByRole('button',{name:'重新讀取舊紀錄',exact:true})).toBeVisible();
  const snapshots=await read(page,'qgroup-legacy-local-v1','snapshots');
  await page.evaluate(async({id,scope})=>{const r=indexedDB.open('qgroup-legacy-local-v1');const db=await new Promise<IDBDatabase>(resolve=>{r.onsuccess=()=>resolve(r.result);});await new Promise<void>(resolve=>{const tx=db.transaction('mappings','readwrite');tx.objectStore('mappings').put({id,scope,sourceId:id,targetKey:'obsolete',path:'/activities/new',deviceEpoch:0,at:0});tx.oncomplete=()=>resolve();});db.close();},{id:snapshots[0]!.id,scope:scope()});
  await page.goto('/activities/new');await blocked(page);await clear(page);
  await expect(page.getByRole('button',{name:'恢復本機原稿',exact:true})).toBeVisible();
  expect(await read(page)).toEqual([other]);expect(await read(page,'qgroup-legacy-local-v1','snapshots')).toEqual([]);expect(await read(page,'qgroup-legacy-local-v1','mappings')).toEqual([]);
  expect(await read(page,'qgroup-reviewed-drafts-v1','drafts')).toEqual(native);expect(await read(page,'qgroup-reviewed-drafts-v1','versions')).toEqual(versions);
  expect(await page.evaluate(()=>sessionStorage.getItem('qgroup:rebuild:untouched'))).toBe('新版分頁草稿');
  await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(page.getByLabel('活動名稱',{exact:true})).toHaveValue('新版未送出活動');
});
test('keeps pending and done original requests and their blocker after clearing obsolete drafts',async({page,context})=>{
  await login(context);await page.goto('/activities');const requests=[oldRequest(),oldRequest('done')];await seed(page,[oldDraft(),...requests]);await page.goto('/activities/new');await blocked(page);
  let writes=0;page.on('request',r=>{if(['POST','PUT','PATCH','DELETE'].includes(r.method()))writes++;});await clear(page);
  await expect.poll(()=>read(page)).toHaveLength(2);await expect(page.getByText(/正在清除舊版草稿/)).toHaveCount(0);await blocked(page);await expect(page.getByRole('button',{name:'清除舊版草稿，重新填寫',exact:true})).toHaveCount(0);
  expect(await read(page)).toEqual(expect.arrayContaining(requests));expect(await read(page)).toHaveLength(2);expect((await read(page,'qgroup-legacy-local-v1','snapshots')).map(r=>r.source)).toEqual(expect.arrayContaining(requests));expect(writes).toBe(0);
});
test('late obsolete tabs cannot reintroduce a cleared draft, while new native input still persists',async({page,context})=>{
  await login(context);await page.goto('/activities');await seed(page,[oldDraft()]);await page.goto('/activities/new');await clear(page);await expect(page.getByLabel('活動名稱',{exact:true})).toBeVisible();
  const other=await context.newPage();await other.goto('/activities');await seed(other,[oldDraft()]);await page.reload();await expect(page.getByLabel('活動名稱',{exact:true})).toBeVisible();await expect(page.getByText(/此操作仍有舊看板原稿/)).toHaveCount(0);
  await page.getByLabel('活動名稱',{exact:true}).fill('清稿後的新活動');await expect.poll(async()=>JSON.stringify(await read(page,'qgroup-reviewed-drafts-v1','drafts'))).toContain('清稿後的新活動');
  await page.goto('/me/local-history');await expect(page.getByRole('button',{name:'重新讀取舊紀錄',exact:true})).toBeVisible();expect(await read(page,'qgroup-legacy-local-v1','snapshots')).toEqual([]);await other.close();
});
test('snapshot transaction abort leaves all old drafts and does not unblock the editor',async({page,context})=>{
  await login(context);await page.goto('/activities');await seed(page,[oldDraft()]);await page.goto('/activities/new');await blocked(page);
  const before=await read(page),snapshots=await read(page,'qgroup-legacy-local-v1','snapshots');
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.delete;IDBObjectStore.prototype.delete=function(key){const r=original.call(this,key);if(this.name==='snapshots')r.addEventListener('success',()=>this.transaction.abort());return r;};});
  await clear(page);await expect(page.getByRole('alert')).toBeVisible();await blocked(page);expect(await read(page)).toEqual(before);expect(await read(page,'qgroup-legacy-local-v1','snapshots')).toEqual(snapshots);
});
test('source deletion failure offers retry and never deletes an original request',async({page,context})=>{
  await login(context);await page.goto('/activities');const request=oldRequest();await seed(page,[oldDraft(),request]);await page.goto('/activities/new');await blocked(page);
  await page.evaluate(()=>{const original=IDBCursor.prototype.delete;IDBCursor.prototype.delete=function(){const r=original.call(this);if((this.source as IDBObjectStore).name==='entries')r.addEventListener('success',()=>this.source instanceof IDBObjectStore&&this.source.transaction.abort());return r;};(window as unknown as {restore:()=>void}).restore=()=>{IDBCursor.prototype.delete=original;};});
  await clear(page);await expect(page.getByRole('alert')).toBeVisible();expect(await read(page)).toHaveLength(2);
  await page.evaluate(()=>(window as unknown as {restore:()=>void}).restore());await page.reload();await expect(page.getByText(/舊版草稿清除未完成/)).toBeVisible();await clear(page);await expect.poll(()=>read(page)).toEqual([request]);await expect(page.getByText(/正在清除舊版草稿/)).toHaveCount(0);await expect(page.getByRole('button',{name:'清除舊版草稿，重新填寫',exact:true})).toHaveCount(0);await blocked(page);
});
test('clearing a snapshot after its source disappears does not create a replacement source database',async({page,context})=>{
  await login(context);await page.goto('/activities');await seed(page,[oldDraft()]);await page.goto('/me/local-history');await expect(page.getByRole('button',{name:'重新讀取舊紀錄',exact:true})).toBeVisible();
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase('kanban-local-v1');r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);}));await clear(page);
  await expect(page.getByText('此帳號在這個瀏覽器沒有舊看板紀錄。',{exact:true})).toBeVisible();expect(await page.evaluate(async()=>(await indexedDB.databases()).some(db=>db.name==='kanban-local-v1'))).toBe(false);
});
test('an account switch before clicking cannot clear the previous account drafts',async({page,context})=>{
  await login(context);await page.goto('/activities');const draft=oldDraft();await seed(page,[draft]);await page.goto('/activities/new');await blocked(page);
  await login(context,'bob');await clear(page);await expect(page.getByLabel('活動名稱',{exact:true})).toBeVisible();expect(await read(page)).toEqual([draft]);
});
test('does not erase native pending requests when clearing legacy drafts',async({page,context})=>{
  await login(context);await page.goto('/activities');const original=oldRequest();await seed(page,[oldDraft(),original]);await page.goto('/activities/new');await blocked(page);
  const key='qgroup:rebuild:activity-draft:v1:'+scope()+':new',raw=JSON.stringify({pending:{key:'native-original-operation',input:{title:'新版結果未知活動'}}});
  await page.evaluate(async({key,scope,raw})=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1');const db=await new Promise<IDBDatabase>(resolve=>{r.onsuccess=()=>resolve(r.result);});await new Promise<void>(resolve=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({key,scope,revision:1,raw,at:1});tx.oncomplete=()=>resolve();});db.close();},{key,scope:scope(),raw});
  const before=await read(page,'qgroup-reviewed-drafts-v1','drafts');await clear(page);await expect.poll(()=>read(page)).toEqual([original]);await expect(page.getByText(/正在清除舊版草稿/)).toHaveCount(0);await blocked(page);expect(await read(page,'qgroup-reviewed-drafts-v1','drafts')).toEqual(before);
});
