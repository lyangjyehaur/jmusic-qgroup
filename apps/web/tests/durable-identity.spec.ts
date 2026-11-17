import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { durableRows, denyDraftWrites } from './draft-helpers';
const origin='http://127.0.0.1:5082';
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function session(context:BrowserContext){return(await context.request.get(origin+'/api/v2/session')).json();}
async function headers(context:BrowserContext){const viewer=await session(context);return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};}
type Kind='nickname'|'contact'|'fields'|'selection';
const flows:{kind:Kind;path:string;endpoint:string;label:string;submit:string;retry:string;done:string}[]=[
  {kind:'nickname',path:'/me/profile',endpoint:'/me/profile',label:'帳號稱呼',submit:'保存稱呼',retry:'確認修改結果',done:'已保存稱呼。'},
  {kind:'contact',path:'/me/music/contact',endpoint:'/me/music/contact',label:'聯絡 QQ',submit:'保存聯絡 QQ',retry:'確認聯絡 QQ 結果',done:'已保存聯絡 QQ。'},
  {kind:'fields',path:'/me/music/details',endpoint:'/me/music/fields',label:'成分資料',submit:'保存成分資料',retry:'確認成分資料結果',done:'成分資料已保存。'},
  {kind:'selection',path:'/me/music',endpoint:'/me/music',label:'成分選擇',submit:'保存我的成分',retry:'確認保存結果',done:'已保存。'},
];
async function setup(context:BrowserContext,kind:Kind){
  await login(context);if(kind==='contact'||kind==='fields')expect((await context.request.put(origin+'/api/v2/me/music',{headers:await headers(context),data:{profileId:null,musicEpoch:0,revision:0,selections:[{entryId:'sub-2',level:4}]}})).status()).toBe(200);
}
const control=(page:Page,kind:Kind)=>kind==='selection'?page.getByLabel('YOASOBI喜歡程度'):page.getByLabel(kind==='nickname'?'站內稱呼':kind==='contact'?'聯絡 QQ':'私人留言',{exact:true});
async function fill(page:Page,kind:Kind){
  await page.goto(origin+flows.find(f=>f.kind===kind)!.path);
  if(kind==='selection'){await page.getByRole('button',{name:'YOASOBI',exact:true}).click();await control(page,kind).selectOption('4');}
  else await control(page,kind).fill(kind==='contact'?'123456':'關頁後的原稿');
  if(kind==='fields'){await page.getByLabel('性別',{exact:true}).selectOption('custom');await page.getByLabel('自訂性別',{exact:true}).fill('原自訂性別');await page.getByLabel('在成分卡公開性別',{exact:true}).check();}
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
}
for(const flow of flows){
  test(flow.kind+' restores the exact closed-tab draft and requires explicit recovery before saving',async({page,context})=>{
    await setup(context,flow.kind);await fill(page,flow.kind);const before=await durableRows(page);expect(before).toHaveLength(1);await page.close();
    const fresh=await context.newPage();await fresh.goto(origin+flow.path);await expect(control(fresh,flow.kind)).toHaveValue(flow.kind==='contact'?'123456':flow.kind==='selection'?'4':'關頁後的原稿');await expect(control(fresh,flow.kind)).toBeDisabled();await expect(fresh.getByRole('button',{name:flow.submit,exact:true})).toBeDisabled();await fresh.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(control(fresh,flow.kind)).toBeEnabled();expect(await durableRows(fresh)).toEqual(before);
    if(flow.kind==='fields'){await expect(fresh.getByLabel('自訂性別',{exact:true})).toHaveValue('原自訂性別');await expect(fresh.getByLabel('在成分卡公開性別',{exact:true})).toBeChecked();}
  });
  test(flow.kind+' resolves a closed-tab unknown result via the inbox with original UUID, body and identity',async({page,context})=>{
    await setup(context,flow.kind);await fill(page,flow.kind);const keys:string[]=[],bodies:string[]=[];
    await context.route('**/api/v2'+flow.endpoint,async route=>{if(route.request().method()!=='PUT')return route.continue();keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);const response=await route.fetch();await route.fulfill(keys.length===1?{response,body:'{'}:{response});});
    await page.getByRole('button',{name:flow.submit,exact:true}).click();await expect(page.getByRole('button',{name:flow.retry,exact:true})).toBeVisible();const before=await(await context.request.get(origin+'/api/v2'+flow.endpoint,{headers:await headers(context)})).json();await page.close();
    const fresh=await context.newPage();await fresh.goto(origin+'/inbox');const pending=fresh.getByRole('region',{name:'未完成操作',exact:true});expect(await pending.textContent()).not.toMatch(/關頁後的原稿|123456|原自訂性別/);await pending.getByRole('link',{name:flow.label,exact:true}).click();expect(keys).toHaveLength(1);await fresh.getByRole('button',{name:flow.retry,exact:true}).click();await expect(fresh.getByText(flow.done,{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);const after=await(await context.request.get(origin+'/api/v2'+flow.endpoint,{headers:await headers(context)})).json();expect(after).toEqual(before);
  });
  test(flow.kind+' retains a successful pending if local confirmation aborts and never duplicates its business write',async({page,context})=>{
    await setup(context,flow.kind);await fill(page,flow.kind);const keys:string[]=[],bodies:string[]=[];
    await context.route('**/api/v2'+flow.endpoint,route=>{if(route.request().method()==='PUT'){keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);}return route.continue();});
    await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&typeof value.raw==='string'){const draft=JSON.parse(value.raw);if(!draft.pending&&!draft.requestKey)r.addEventListener('success',()=>{IDBObjectStore.prototype.put=original;this.transaction.abort();});}return r;};});
    await page.getByRole('button',{name:flow.submit,exact:true}).click();await expect(page.getByText('操作已送出，但無法保存確認狀態；請保留原操作並核對結果。',{exact:true})).toBeVisible();const raw=JSON.parse((await durableRows(page))[0]!.raw);expect(raw.requestKey??raw.pending.key).toBe(keys[0]);await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.getByRole('link',{name:flow.label,exact:true}).click();await fresh.getByRole('button',{name:flow.retry,exact:true}).click();await expect(fresh.getByText(flow.done,{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
  });
}
test('selection receipts read newer server choices instead of restoring the old accepted snapshot',async({page,context})=>{
  await setup(context,'selection');await fill(page,'selection');let first=true;await page.route('**/api/v2/me/music',async route=>{if(route.request().method()!=='PUT')return route.continue();const response=await route.fetch();await route.fulfill(first?{response,body:'{'}:{response});first=false;});await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByRole('button',{name:'確認保存結果',exact:true})).toBeVisible();
  const current=await(await context.request.get(origin+'/api/v2/me/music',{headers:await headers(context)})).json();expect((await context.request.put(origin+'/api/v2/me/music',{headers:await headers(context),data:{profileId:current.id,musicEpoch:0,revision:current.revision,selections:[{entryId:'sub-2',level:1}]}})).status()).toBe(200);
  await page.getByRole('button',{name:'確認保存結果',exact:true}).click();await expect(page.getByText('原操作已保存，成分已再次變更；請核對目前選擇。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'YOASOBI',exact:true})).toHaveAttribute('aria-pressed','false');await expect(page.getByLabel('Aimer喜歡程度')).toHaveValue('1');
});
test('a conflicted private field version keeps the original target and both drafts, with download and mobile recovery',async({page,context})=>{
  await setup(context,'fields');await fill(page,'fields');const other=await context.newPage();await other.goto(origin+'/me/music/details');await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await control(page,'fields').fill('第一分頁私人原稿');await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await control(other,'fields').fill('第二分頁私人原稿');await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();await other.getByRole('button',{name:'讀取已保存版本',exact:true}).click();await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(control(other,'fields')).toHaveValue('第一分頁私人原稿');await other.getByText('本機保全版本（1）',{exact:true}).click();await other.getByRole('button',{name:'載入此原稿（保留目前版本）',exact:true}).click();await expect(control(other,'fields')).toHaveValue('第二分頁私人原稿');
  const download=other.waitForEvent('download');await other.getByRole('button',{name:'下載保全檔',exact:true}).first().click();expect((await download).suggestedFilename()).toMatch(/^qgroup-draft-/);await other.bringToFront();await other.setViewportSize({width:360,height:800});expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await other.screenshot({path:'test-results/unified-private-field-recovery-mobile.png',fullPage:true});
});
test('a pending write transaction abort prevents selection HTTP even after an earlier autosave succeeded',async({page,context})=>{
  await setup(context,'selection');await fill(page,'selection');const before=await durableRows(page);await denyDraftWrites(page,'music:v1:');let writes=0;page.on('request',r=>{if(r.method()==='PUT')writes++;});await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);expect(await durableRows(page)).toEqual(before);
});
for(const kind of ['contact','fields'] as const)test(kind+' preserves a mismatched profile draft instead of issuing it against the current profile',async({page,context})=>{
  await setup(context,kind);await fill(page,kind);const [row]=await durableRows(page),original=JSON.parse(row!.raw);if(kind==='contact')original.musicEpoch++;else original.pending={key:crypto.randomUUID(),input:{profileId:'another-profile',musicEpoch:0,revision:original.revision,name:'不可送出',note:'',gender:'',genderPublic:false}};
  const raw=JSON.stringify(original);await page.evaluate(async({key,raw})=>{const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);});await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),r=store.get(key);r.onsuccess=()=>store.put({...r.result,raw,revision:r.result.revision+1});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();},{key:row!.key,raw});page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(control(page,kind)).toBeDisabled();let writes=0;page.on('request',r=>{if(r.method()==='PUT')writes++;});await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();await expect(control(page,kind)).toBeEnabled();expect((await durableRows(page,'versions')).map(row=>row.raw)).toContain(raw);expect(writes).toBe(0);
});
test('a legacy session field draft migrates exactly and its source disappears only after durable commit',async({page,context})=>{
  await setup(context,'fields');await fill(page,'fields');const [row]=await durableRows(page);await page.evaluate(async row=>{sessionStorage.setItem(row.key,row.raw);const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);});await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(row.key);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();},row!);page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(control(page,'fields')).toHaveValue('關頁後的原稿');await expect(control(page,'fields')).toBeDisabled();await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();expect((await durableRows(page))[0]!.raw).toBe(row!.raw);expect(await page.evaluate(key=>sessionStorage.getItem(key),row!.key)).toBeNull();
});
test('music erasure fences an open private draft without tab signaling while keeping the independent nickname draft usable',async({page,context})=>{
  await context.addInitScript(()=>Object.defineProperty(window,'BroadcastChannel',{value:undefined,configurable:true}));await setup(context,'fields');await fill(page,'fields');
  const nickname=await context.newPage();await nickname.goto(origin+'/me/profile');await control(nickname,'nickname').fill('保留帳號稱呼');await expect(nickname.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
  const privacy=await context.newPage();await privacy.goto(origin+'/me/privacy');await privacy.getByRole('radio',{name:'只刪除成分',exact:true}).check();await privacy.getByRole('checkbox',{name:'我已確認範圍，了解此操作無法復原',exact:true}).check();await privacy.getByRole('button',{name:'確認刪除成分',exact:true}).click();await expect(privacy.getByRole('heading',{name:'成分已刪除',exact:true})).toBeVisible();
  expect((await durableRows(privacy)).filter(row=>row.key.includes('music:'))).toEqual([]);expect((await durableRows(privacy)).filter(row=>row.key.includes('account-profile:'))).toHaveLength(1);
  let writes=0;page.on('request',r=>{if(r.method()==='PUT')writes++;});await page.getByRole('button',{name:'保存成分資料',exact:true}).evaluate(button=>(button as HTMLButtonElement).click());await expect(page.getByText('此原稿已因登出或資料刪除失效，請重新載入頁面。',{exact:false})).toBeVisible();expect(writes).toBe(0);expect((await durableRows(page)).filter(row=>row.key.includes('music:'))).toEqual([]);
  await nickname.getByRole('button',{name:'保存稱呼',exact:true}).click();await expect(nickname.getByText('已保存稱呼。',{exact:true})).toBeVisible();
});
