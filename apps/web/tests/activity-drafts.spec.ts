import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin='http://127.0.0.1:5082';
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
const title=(page:Page)=>page.getByLabel('活動名稱',{exact:true});
async function fill(page:Page,name='週末草稿'){
  await title(page).fill(name);await page.getByLabel('地點',{exact:true}).fill('台北');await page.getByLabel('開始時間（台北）',{exact:true}).fill('2099-12-12T14:30:25');await page.getByLabel('報名截止（台北）',{exact:true}).fill('2099-12-11T14:30:00');
}
const save=(page:Page)=>page.getByRole('button',{name:'保存活動草稿',exact:true}).click();
async function create(page:Page){await page.goto('/activities/new');await fill(page);await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/);return new URL(page.url()).pathname.split('/')[2]!;}
async function headers(context:BrowserContext){const viewer=await(await context.request.get('/api/v2/session')).json();return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};}
test('activity authoring returns to one private draft, keeps all settings and renders at 360px',async({page,context})=>{
  await login(context);await page.goto('/activities');await page.getByRole('link',{name:'新增活動草稿',exact:true}).click();await fill(page);
  await page.getByLabel('活動類型',{exact:true}).selectOption('运动');await page.getByLabel('人數上限',{exact:true}).fill('12');await page.getByLabel('最低成團人數',{exact:true}).fill('4');await page.getByLabel('持續時間（小時）',{exact:true}).fill('5');await page.getByLabel('退出期限（台北）',{exact:true}).fill('2099-12-10T20:00:00');await page.getByLabel('活動顯示時區',{exact:true}).fill('Asia/Tokyo');await page.getByLabel('發布後同步到 QQ 群',{exact:true}).check();await page.getByLabel('費用規則',{exact:true}).fill('按實際人數分攤');await page.getByLabel('活動說明',{exact:true}).fill('需要自備的物品');
  await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/);await expect(title(page)).toHaveValue('週末草稿');await expect(page.getByLabel('活動顯示時區',{exact:true})).toHaveValue('Asia/Tokyo');await expect(page.getByLabel('開始時間（台北）',{exact:true})).toHaveValue('2099-12-12T14:30:25');
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-activity-draft-mobile.png',fullPage:true});
  await page.getByLabel('可見性',{exact:true}).selectOption('invitation');await expect(page.getByLabel('發布後同步到 QQ 群',{exact:true})).not.toBeChecked();await expect(page.getByLabel('發布後同步到 QQ 群',{exact:true})).toBeDisabled();await save(page);await expect(page.getByText('活動草稿已保存。',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'活動草稿',exact:true}).click();await expect(page.getByRole('heading',{name:'週末草稿',exact:true})).toBeVisible();await page.getByRole('link',{name:'週末草稿',exact:true}).click();await expect(page.getByLabel('活動說明',{exact:true})).toHaveValue('需要自備的物品');await expect(page.getByLabel('費用規則',{exact:true})).toHaveValue('按實際人數分攤');
});
test('unknown creation retains its exact key and payload across reload and creates one event',async({page,context})=>{
  await login(context);const keys:string[]=[],bodies:unknown[]=[];let first=true;
  await page.route('**/api/v2/activities/drafts',async route=>{keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postDataJSON());const response=await route.fetch();if(first){first=false;await route.fulfill({response,body:'{'});}else await route.fulfill({response});});
  await page.goto('/activities/new');await fill(page,'原操作建立');await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page.getByText('尚未確認活動草稿操作結果。原操作已保留，請按「確認草稿操作結果」安全重試。',{exact:true})).toBeVisible();await expect(title(page)).toBeDisabled();page.on('dialog',dialog=>void dialog.accept());await page.reload();await page.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/);expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toEqual(bodies[1]);
  const h=await headers(context);const list=await(await context.request.get('/api/v2/me/activity-drafts',{headers:h})).json();expect(list.drafts.filter((d:{title:string})=>d.title==='原操作建立')).toHaveLength(1);
  await page.getByRole('link',{name:'所有活動',exact:true}).click();await page.getByRole('link',{name:'新增活動草稿',exact:true}).click();await expect(title(page)).toHaveValue('');
});
test('revision conflict retains local arrangements until explicit comparison and never silently replaces the remote draft',async({page,context,browser})=>{
  await login(context);const id=await create(page);const remote=await browser.newContext({baseURL:origin});await login(remote);
  try{
    await title(page).fill('本機草稿');await page.getByLabel('活動說明',{exact:true}).fill('本機說明');await page.getByLabel('費用規則',{exact:true}).fill('本機費用');
    const other=await remote.newPage();await other.goto('/activities/'+id+'/edit');await title(other).fill('遠端草稿');await other.getByLabel('費用規則',{exact:true}).fill('遠端費用');await save(other);await expect(other.getByText('活動草稿已保存。',{exact:true})).toBeVisible();
    await save(page);await expect(page.getByText('活動或名單已有更新；輸入仍保留，請核對目前安排後再保存',{exact:true})).toBeVisible();await expect(title(page)).toHaveValue('本機草稿');await page.getByRole('button',{name:'核對目前安排，保留輸入',exact:true}).click();await expect(page.getByText('遠端草稿',{exact:true})).toBeVisible();await expect(page.getByText('遠端費用',{exact:true})).toBeVisible();await expect(page.getByLabel('活動說明',{exact:true})).toHaveValue('本機說明');await save(page);await expect(page.getByText('活動草稿已保存。',{exact:true})).toBeVisible();
  }finally{await remote.close();}
});
test('unknown removal is recoverable after reload even when the original draft is now hidden',async({page,context})=>{
  await login(context);const id=await create(page);let writes=0;
  await page.route('**/api/v2/activities/'+id+'/draft/remove',async route=>{writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.getByLabel('確認刪除此活動草稿；保存的紀錄仍會保留',{exact:true}).check();await page.getByRole('button',{name:'刪除活動草稿',exact:true}).click();await expect(page.getByRole('button',{name:'確認草稿操作結果',exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();await page.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();await expect(page).toHaveURL('/me/activities/drafts');await expect(page.getByRole('heading',{name:'週末草稿',exact:true})).toHaveCount(0);expect(writes).toBe(1);
});
test('scoped unfinished inputs survive navigation but cannot be submitted from a switched account',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await fill(page,'小青原稿');await page.getByRole('link',{name:'所有活動',exact:true}).click();await page.getByRole('button',{name:'保留草稿並離開',exact:true}).click();await page.getByRole('link',{name:'新增活動草稿',exact:true}).click();await expect(title(page)).toHaveValue('小青原稿');
  await login(context,'bob');await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號',{exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(title(page)).toHaveValue('');await login(context);await page.reload();await expect(title(page)).toHaveValue('小青原稿');
});
test('storage failure prevents creation and damaged drafts are kept until explicit preservation',async({page,context})=>{
  await login(context);let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/activities/drafts'))writes++;});
  await page.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('qgroup:rebuild:activity-draft:'))throw new DOMException('synthetic denial');original.call(this,key,value);};});
  await page.goto('/activities/new');await fill(page);await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page.getByText('無法保存操作編號，尚未送出修改。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/activities/new');await expect(title(clean)).toBeVisible();await expect.poll(()=>clean.evaluate(()=>Object.keys(sessionStorage).some(key=>key.startsWith('qgroup:rebuild:activity-draft:')))).toBe(true);await clean.evaluate(()=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('qgroup:rebuild:activity-draft:'))!;sessionStorage.setItem(key,'damaged activity draft');});await clean.reload();await expect(title(clean)).toBeDisabled();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect(await clean.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.includes(':recovery:')).map(key=>sessionStorage.getItem(key)))).toContain('damaged activity draft');await expect(title(clean)).toBeEnabled();await clean.close();
});
test('an unknown saved draft replays the original operation then reads newer data instead of restoring its stale receipt',async({page,context})=>{
  await login(context);const id=await create(page);const keys:string[]=[],bodies:unknown[]=[];let first=true;
  await page.route('**/api/v2/activities/'+id+'/draft',async route=>{if(route.request().method()!=='PUT')return route.continue();keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postDataJSON());const response=await route.fetch();if(first){first=false;await route.fulfill({response,body:'{'});}else await route.fulfill({response});});
  await title(page).fill('原操作草稿');await page.getByLabel('修改原因（選填）',{exact:true}).fill('保留原原因');await save(page);await expect(page.getByRole('button',{name:'確認草稿操作結果',exact:true})).toBeVisible();const h=await headers(context);const latest=await(await context.request.get('/api/v2/activities/'+id+'/draft',{headers:h})).json();expect((await context.request.put('/api/v2/activities/'+id+'/draft',{headers:h,data:{revision:latest.revision,values:{...latest.values,title:'較新的草稿',description:'較新的說明'},reason:'另一次修改'}})).status()).toBe(200);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByLabel('修改原因（選填）',{exact:true})).toHaveValue('保留原原因');await page.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();await expect(page.getByText('原操作已保存，草稿已再次變更；請核對目前安排。',{exact:true})).toBeVisible();await expect(title(page)).toHaveValue('較新的草稿');await expect(page.getByLabel('活動說明',{exact:true})).toHaveValue('較新的說明');expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toEqual(bodies[1]);
});
test('logout clears activity drafts in another tab and a late successful response cannot recreate them',async({page,context})=>{
  await login(context);const id=await create(page);let release!:()=>void,seen!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),intercepted=new Promise<void>(resolve=>{seen=resolve;});
  await page.route('**/api/v2/activities/'+id+'/draft',async route=>{if(route.request().method()!=='PUT')return route.continue();const response=await route.fetch();seen();await gate;await route.fulfill({response});});
  await title(page).fill('登出前的私有原稿');await save(page);await intercepted;
  const account=await context.newPage();try{await account.goto('/me/accounts');await account.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(title(page)).toHaveCount(0);release();await expect(page.getByRole('link',{name:'登入',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('qgroup:rebuild:activity-draft:')))).toEqual([]);}finally{release();await account.close();}
});
