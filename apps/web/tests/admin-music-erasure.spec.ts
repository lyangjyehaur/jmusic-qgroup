import { test,expect } from './fixtures';
import type { BrowserContext,Page } from '@playwright/test';
const origin='http://127.0.0.1:5082',bob='m_'+'b'.repeat(32),orphan='m_'+'c'.repeat(32);
test.use({adminCatalog:true});
async function login(context:BrowserContext,user='registration-admin'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
const review=(page:Page)=>page.getByRole('region',{name:'刪除範圍核對',exact:true});
async function confirm(page:Page,reset=false){await page.getByLabel('輸入 '+(reset?'RESET':'DELETE')+' 確認',{exact:true}).fill(reset?'RESET':'DELETE');await page.getByRole('checkbox',{name:'我已核對刪除範圍及不可復原的影響',exact:true}).check();await page.getByRole('button',{name:reset?'重置成分與詞庫':'確認刪除成分',exact:true}).click();}
test('profile-free administrators navigate to removal, review exact scope and retain another member’s selections',async({page,context})=>{
  await login(context);await page.goto('/admin/music/'+bob);await page.getByRole('link',{name:'刪除此成分',exact:true}).click();await expect(review(page)).toContainText('詞庫bob');await expect(review(page)).toContainText('1 份成分 · 2 項選擇');
  await expect(page.getByRole('button',{name:'確認刪除成分',exact:true})).toBeDisabled();await confirm(page);await expect(page.getByText('成分已刪除，自建詞條保留並移除原建立者資訊。',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'返回成分關聯',exact:true}).click();await expect(page.getByRole('link',{name:'詞庫bob',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'詞庫alice',exact:true})).toBeVisible();
  const catalog=await (await context.request.get('/api/v2/music/catalog')).json();expect(catalog.entries.find((e:any)=>e.id==='sub-1')).toMatchObject({creatorName:'',count:1});
});
test('full reset requires its own confirmation, works at 360px and preserves activities and logged-in accounts',async({page,context})=>{
  await login(context);await page.setViewportSize({width:360,height:800});await page.goto('/admin');await page.getByRole('link',{name:'重置成分與詞庫',exact:true}).click();
  await expect(review(page)).toContainText('3 份成分 · 7 項選擇');await expect(review(page)).toContainText('22 個詞條將刪除');await page.getByLabel('輸入 RESET 確認',{exact:true}).fill('DELETE');await expect(page.getByRole('button',{name:'重置成分與詞庫',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-admin-music-reset-mobile.png',fullPage:true});await confirm(page,true);
  await expect(page.getByText('已刪除 3 份成分、22 個詞條。',{exact:true})).toBeVisible();await page.goto('/activities');await expect(page.getByRole('link',{name:'週末一起聽日系音樂',exact:true})).toBeVisible();
  expect((await (await context.request.get('/api/v2/music/catalog')).json()).entries).toEqual([]);expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(true);
});
test('a lost deletion response is recovered by receipt after reload despite the source profile returning 404',async({page,context})=>{
  await login(context);let writes=0;await page.route('**/api/v2/admin/music/'+bob+'/erase',async route=>{if(route.request().method()!=='POST')return route.continue();writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.goto('/admin/music/'+bob+'/erase');await confirm(page);await expect(page.getByRole('button',{name:'查詢刪除結果',exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();
  await expect(page.getByRole('alert')).toContainText('成分不存在或已刪除');await page.getByRole('button',{name:'查詢刪除結果',exact:true}).click();await expect(page.getByText('成分已刪除，自建詞條保留並移除原建立者資訊。',{exact:true})).toBeVisible();expect(writes).toBe(1);
});
test('an undelivered reset can only retry its exact original request and cannot delete data changed after review',async({page,context})=>{
  await login(context);let fail=true;const writes:{body:string|null}[]=[];await page.route('**/api/v2/admin/music-reset',async route=>{if(route.request().method()!=='POST')return route.continue();writes.push({body:route.request().postData()});if(fail){fail=false;return route.abort();}return route.continue();});
  await page.goto('/admin/music-reset');await confirm(page,true);await page.getByRole('button',{name:'查詢刪除結果',exact:true}).click();await expect(page.getByText('尚未找到完成紀錄。',{exact:false})).toBeVisible();
  const other=await context.newPage();await other.goto('/admin/music-entries');await other.getByRole('button',{name:'建立詞條',exact:true}).click();await other.getByLabel('詞條名稱',{exact:true}).fill('重置後不可誤刪');await other.getByRole('checkbox',{name:'我已核對詞條及影響範圍',exact:true}).check();await other.getByRole('button',{name:'確認詞條變更',exact:true}).click();await expect(other.getByText('已建立詞條。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重新提交原刪除',exact:true}).click();await expect(page.getByText('成分、詞庫或相關資料已有變更，請重新核對刪除範圍',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);await expect(review(page)).toContainText('23 個詞條將刪除');await expect(page.getByRole('button',{name:'重置成分與詞庫',exact:true})).toBeDisabled();await other.close();
});
test('storage failure blocks deletion; corrupt records are backed up; route changes protect unsubmitted confirmation',async({page,context})=>{
  await login(context);await page.goto('/admin/music/'+orphan+'/erase');await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.includes('admin-music-erasure'))throw Error('synthetic storage failure');return original.call(this,key,value);};});let writes=0;page.on('request',request=>{if(request.url().endsWith('/erase')&&request.method()==='POST')writes++;});
  await confirm(page);await expect(page.getByText('無法保存刪除操作編號及回執憑證，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  await page.getByRole('link',{name:'管理後台',exact:true}).click();await expect(page.getByText('仍有刪除確認或待確認操作。',{exact:false})).toBeVisible();await page.getByRole('button',{name:'留在此頁',exact:true}).click();
  page.on('dialog',dialog=>void dialog.accept());await page.reload();const key=await page.evaluate(async()=>{const viewer=await(await fetch('/api/v2/session')).json(),admin=await(await fetch('/api/v2/admin/session',{headers:{'X-Account-Scope':viewer.scope}})).json();const key='qgroup:rebuild:admin-music-erasure:v1:'+viewer.scope+':'+admin.scope+':'+location.pathname;sessionStorage.setItem(key,'{damaged');return key;});
  await page.reload();await expect(page.getByText('無法讀取刪除操作紀錄，請先保全原稿再繼續。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'確認刪除成分',exact:true})).toBeDisabled();await page.getByRole('button',{name:'保全操作紀錄後繼續',exact:true}).click();
  expect(await page.evaluate(key=>Object.keys(sessionStorage).filter(k=>k.startsWith(key+':recovery:')).map(k=>sessionStorage.getItem(k)),key)).toEqual(['{damaged']);
});
test('non-admins cannot read previews and late private data cannot restore revoked authority',async({page,context})=>{
  await page.goto('/admin/music-reset');await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();await expect(review(page)).toHaveCount(0);await login(context);
  let arrived!:()=>void,release!:()=>void;const captured=new Promise<void>(resolve=>{arrived=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v2/admin/music-reset',async route=>{const response=await route.fetch();arrived();await pending;await route.fulfill({response}).catch(()=>{});});await page.reload();await captured;
  await login(context,'alice');await page.evaluate(()=>{const channel=new BroadcastChannel('qgroup:rebuild:session');channel.postMessage('refresh');channel.close();});await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();release();await expect(review(page)).toHaveCount(0);
});
test('rescue administrators remove unlinked music without creating or closing a member account',async({page,context})=>{
  await page.goto('/admin');await page.getByLabel('管理救援憑證',{exact:true}).fill('synthetic-admin-rescue-'+'x'.repeat(32));await page.getByRole('button',{name:'使用救援憑證登入',exact:true}).click();await expect(page.getByText('管理授權：救援憑證（1 小時）',{exact:true})).toBeVisible();
  await page.goto('/admin/music/'+orphan+'/erase');await expect(review(page)).toContainText('關聯帳號：未關聯');await confirm(page);await expect(page.getByText('成分已刪除，自建詞條保留並移除原建立者資訊。',{exact:true})).toBeVisible();
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
});
