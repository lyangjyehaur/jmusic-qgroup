import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { durableRows } from './draft-helpers';
import { toggleMusicTerm } from './kimi-controls';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function headers(context:BrowserContext){const v=await(await context.request.get('/api/v2/session')).json();return {Origin:origin,'X-Account-Scope':v.scope,'X-CSRF-Token':v.csrf,'Idempotency-Key':crypto.randomUUID()};}
async function event(context:BrowserContext){await login(context);const r=await context.request.post('/api/v2/activities/drafts',{headers:await headers(context),data:{values:{title:'共用表單驗收',category:'约K',location:'隔離測試',startsAt:'2099-12-12T18:00:00+08:00',deadline:'2099-12-12T21:00:00+08:00',capacity:5}}});expect(r.status()).toBe(200);const e=await r.json();expect((await context.request.post(`/api/v2/activities/${e.id}/draft/publish`,{headers:await headers(context),data:{revision:e.revision,confirm:true,acceptConditions:true}})).status()).toBe(200);return e.id as string;}
const prompt=(page:import('@playwright/test').Page)=>page.getByRole('dialog',{name:'尚未提交的修改',exact:true});
test('a scrolled mobile registration opens a centered leave decision, preserves on request and discards only local edits',async({page,context})=>{
 const id=await event(context);await page.setViewportSize({width:430,height:932});await page.goto(`/activities/${id}/registration`);
 const d=page.getByRole('dialog',{name:'管理報名',exact:true});const title=d.getByRole('heading',{name:'管理報名',exact:true}),close=d.getByRole('button',{name:'返回活動',exact:true});
 await expect(title).toBeVisible();const a=await title.boundingBox(),b=await close.boundingBox();expect(a&&b&&Math.abs(a.y+a.height/2-b.y-b.height/2)<3).toBe(true);
 const note=d.getByLabel('公開備註',{exact:true});await note.fill('只留在本機的修改');await expect.poll(async()=>JSON.parse((await durableRows(page)).find(r=>r.key.includes('registration:'))!.raw).note).toBe('只留在本機的修改');
 const height=await d.evaluate(el=>el.scrollHeight);await note.fill('第二版修改');await expect.poll(async()=>JSON.parse((await durableRows(page)).find(r=>r.key.includes('registration:'))!.raw).note).toBe('第二版修改');expect(await d.evaluate(el=>el.scrollHeight)).toBe(height);
 await d.getByRole('button',{name:'提交報名操作',exact:true}).scrollIntoViewIfNeeded();let writes=0;page.on('request',r=>{if(r.method()!=='GET'&&r.url().includes('/api/'))writes++;});
 await close.click();await expect(prompt(page)).toBeVisible();await expect(prompt(page).getByRole('button',{name:'捨棄並離開',exact:true})).toBeInViewport();await prompt(page).getByRole('button',{name:'繼續編輯',exact:true}).click();await expect(note).toHaveValue('第二版修改');
 await close.click();await prompt(page).getByRole('button',{name:'保留原稿並離開',exact:true}).click();await expect(page).toHaveURL('/activities/'+id);await page.goto(`/activities/${id}/registration`);await expect(page.getByRole('region',{name:'草稿狀態'})).toBeInViewport();await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(note).toHaveValue('第二版修改');
 await close.click();await prompt(page).getByRole('button',{name:'捨棄並離開',exact:true}).click();await expect(page).toHaveURL('/activities/'+id);expect((await durableRows(page)).some(r=>r.key.includes('registration:'))).toBe(false);expect(writes).toBe(0);
 await page.goto(`/activities/${id}/registration`);await expect(note).toHaveValue('');await expect(page.getByRole('button',{name:'恢復本機原稿',exact:true})).toHaveCount(0);
});
test('reviewed poll drafts can be discarded at restore without submitting a poll',async({page,context})=>{
 await login(context);await page.goto('/time-polls/new');const title=page.getByLabel('投票名稱',{exact:true});await title.fill('不要保留的投票');await expect.poll(async()=>(await durableRows(page)).some(r=>r.raw.includes('不要保留的投票'))).toBe(true);
 const other=await context.newPage();await other.goto('/time-polls/new');await expect(other.getByRole('region',{name:'草稿狀態'})).toBeInViewport();let writes=0;other.on('request',r=>{if(r.method()!=='GET'&&r.url().includes('/api/'))writes++;});await other.getByRole('button',{name:'捨棄草稿',exact:true}).click();await expect(other.getByLabel('投票名稱',{exact:true})).toBeEnabled();await expect(other.getByLabel('投票名稱',{exact:true})).toHaveValue('');expect((await durableRows(other)).some(r=>r.key.includes('poll-create:'))).toBe(false);expect(writes).toBe(0);
});
test('discard refuses to overwrite a newer draft from another tab',async({page,context})=>{
 await login(context);await page.goto('/time-polls/new');await page.getByLabel('投票名稱',{exact:true}).fill('第一分頁');await expect.poll(async()=>(await durableRows(page)).some(r=>r.raw.includes('第一分頁'))).toBe(true);
 const other=await context.newPage();await other.goto('/time-polls/new');await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await page.getByLabel('投票名稱',{exact:true}).fill('已更新的第一分頁');await expect.poll(async()=>(await durableRows(page)).some(r=>r.raw.includes('已更新的第一分頁'))).toBe(true);
 await other.getByRole('link',{name:'活動',exact:true}).first().click();await prompt(other).getByRole('button',{name:'捨棄並離開',exact:true}).click();await expect(prompt(other)).toContainText('其他分頁已更新草稿，尚未捨棄');expect((await durableRows(other)).some(r=>r.raw.includes('已更新的第一分頁'))).toBe(true);
});
test('pending registration offers safe leave and keeps the exact request instead of discard',async({page,context})=>{
 const id=await event(context);await login(context,'bob');await page.route(`**/api/v2/activities/${id}/registration`,route=>route.request().method()==='POST'?route.abort():route.continue());await page.goto('/activities/'+id);await page.getByRole('button',{name:'本人報名',exact:true}).click();await expect(page.getByRole('button',{name:'確認報名操作結果',exact:true})).toBeVisible();const before=(await durableRows(page)).find(r=>r.key.includes('registration:'))!.raw;
 await page.getByRole('link',{name:'音樂',exact:true}).first().click();const pending=page.getByRole('dialog',{name:'操作結果尚未確認',exact:true});await expect(pending).toBeVisible();await expect(pending.getByRole('button',{name:'捨棄並離開',exact:true})).toHaveCount(0);await pending.getByRole('button',{name:'保留操作並離開',exact:true}).click();await expect(page).toHaveURL('/music');expect((await durableRows(page)).find(r=>r.key.includes('registration:'))!.raw).toBe(before);
});
test('music discard restores saved selections and only clears the editable local draft',async({page,context})=>{
 await login(context);await page.goto('/me/music');await toggleMusicTerm(page,'YOASOBI');await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();await toggleMusicTerm(page,'ヨルシカ');await expect.poll(async()=>(await durableRows(page)).some(r=>r.key.includes('music:v1:')&&JSON.parse(r.raw).selections.length===2)).toBe(true);
 await page.getByRole('link',{name:'活動',exact:true}).first().click();await prompt(page).getByRole('button',{name:'捨棄並離開',exact:true}).click();await expect(page).toHaveURL('/activities');expect((await durableRows(page)).some(r=>r.key.includes('music:v1:'))).toBe(false);const saved=await(await context.request.get('/api/v2/me/music',{headers:await headers(context)})).json();expect(saved.selections).toHaveLength(1);
});
test('opening an untouched time poll does not create a dirty draft or block leaving',async({page,context})=>{
 await login(context);await page.goto('/time-polls/new');await expect(page.getByLabel('投票名稱',{exact:true})).toBeEnabled();await page.getByRole('link',{name:'活動',exact:true}).first().click();await expect(page).toHaveURL('/activities');await expect(prompt(page)).toHaveCount(0);expect((await durableRows(page)).some(r=>r.key.includes('poll-create:'))).toBe(false);
});
test('a failed discard commit keeps the draft and shows the error in the leave dialog',async({page,context})=>{
 await login(context);await page.goto('/time-polls/new');await page.getByLabel('投票名稱',{exact:true}).fill('不能靜默丟失的資料');await expect.poll(async()=>(await durableRows(page)).some(r=>r.raw.includes('不能靜默丟失的資料'))).toBe(true);
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=put.call(this,value,key);if(this.name==='drafts'&&value.raw===null){const tx=this.transaction;r.addEventListener('success',()=>tx.abort());}return r;};});
 await page.getByRole('link',{name:'活動',exact:true}).first().click();await prompt(page).getByRole('button',{name:'捨棄並離開',exact:true}).click();await expect(prompt(page)).toContainText('尚未捨棄草稿，請重試；目前內容仍保留。');expect(new URL(page.url()).pathname).toBe('/time-polls/new');expect((await durableRows(page)).some(r=>r.raw.includes('不能靜默丟失的資料'))).toBe(true);
});
