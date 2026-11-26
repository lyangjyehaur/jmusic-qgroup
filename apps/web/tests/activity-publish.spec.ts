import { fillAdvancedActivity, setActivityStart } from './activity-authoring-controls';
import { durableRows } from './draft-helpers';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function headers(context:BrowserContext){const viewer=await(await context.request.get('/api/v2/session')).json();return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};}
async function create(page:Page){
  await page.goto('/activities/new');await page.getByLabel('活動名稱',{exact:true}).fill('待發布活動');await page.getByLabel('地點',{exact:true}).fill('台北');await setActivityStart(page,'2099-12-12T18:00:00');await fillAdvancedActivity(page,'報名截止','2099-12-11T18:00:00');await fillAdvancedActivity(page,'費用規則','依人數分攤');await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/);return new URL(page.url()).pathname.split('/')[2]!;
}
const consent=(page:Page)=>page.getByLabel('已核對保存的安排與費用規則，同意以本人報名並發布活動',{exact:true});
async function expectLocation(page:Page,value:string){const field=page.getByRole('region',{name:'活動安排',exact:true});await expect(field).toContainText(value);expect(await field.getByRole('link',{name:'高德導航',exact:true}).getAttribute('href')).toBe('https://uri.amap.com/search?keyword='+encodeURIComponent(value));}
async function publish(page:Page){await consent(page).check();await page.getByRole('button',{name:'發布活動',exact:true}).click();}
test('publication requires saved arrangements and explicit personal consent, then returns to the activity and final roster',async({page,context})=>{
  await login(context);const id=await create(page);await expect(page.getByRole('button',{name:'發布活動',exact:true})).toBeDisabled();await page.getByLabel('地點',{exact:true}).fill('新地點');await expect(consent(page)).toBeDisabled();await page.getByRole('button',{name:'保存活動草稿',exact:true}).click();await expect(page.getByText('活動草稿已保存。',{exact:true})).toBeVisible();await expect(consent(page)).not.toBeChecked();await publish(page);await expect(page).toHaveURL('/activities/'+id);await expect(page.getByRole('heading',{name:'待發布活動',exact:true})).toBeVisible();await expect(page.getByText('依人數分攤',{exact:true})).toBeVisible();await expectLocation(page,'新地點');await expect(page.locator('#participants')).toContainText('小青');await expect(page.locator('#participants')).toContainText('· 我');await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-activity-published-mobile.png'});await page.locator('#participants').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/unified-activity-published-roster-mobile.png'});await page.getByRole('link',{name:'← 所有活動',exact:true}).click();await expect(page.getByRole('heading',{name:'待發布活動',exact:true})).toBeVisible();
});
test('a successful but unreadable publication is recovered after reload without issuing a second publication',async({page,context})=>{
  await login(context);const id=await create(page);let writes=0;await page.route('**/api/v2/activities/'+id+'/draft/publish',async route=>{writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});await publish(page);await expect(page.getByRole('button',{name:'確認草稿操作結果',exact:true})).toBeVisible();await expect(page.getByLabel('活動名稱',{exact:true})).toBeDisabled();page.on('dialog',dialog=>void dialog.accept());await page.reload();await page.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();await expect(page).toHaveURL('/activities/'+id);await expect(page.locator('#participants').getByText('小青',{exact:true})).toBeVisible();expect(writes).toBe(1);const h=await headers(context);const roster=await(await context.request.get('/api/v2/activities/'+id+'/roster',{headers:h})).json();expect(roster.participants).toHaveLength(1);
});
test('a newer arrangement rejects stale publication until explicit comparison and renewed acceptance',async({page,context})=>{
  await login(context);const id=await create(page);const h=await headers(context);const draft=await(await context.request.get('/api/v2/activities/'+id+'/draft',{headers:h})).json();expect((await context.request.put('/api/v2/activities/'+id+'/draft',{headers:h,data:{revision:draft.revision,values:{...draft.values,feePolicy:'較新的費用規則'},reason:''}})).status()).toBe(200);
  await publish(page);await expect(page.getByText('活動或名單已有更新；輸入仍保留，請核對目前安排後再保存',{exact:true})).toBeVisible();await page.getByRole('button',{name:'核對目前安排，保留輸入',exact:true}).click();await expect(page.getByText('較新的費用規則',{exact:true})).toBeVisible();await expect(consent(page)).not.toBeChecked();await expect(consent(page)).toBeDisabled();await fillAdvancedActivity(page,'費用規則','較新的費用規則');await page.getByLabel('地點',{exact:true}).fill('核對後的新地點');await page.getByRole('button',{name:'保存活動草稿',exact:true}).click();await expect(page.getByText('活動草稿已保存。',{exact:true})).toBeVisible();await publish(page);await expect(page).toHaveURL('/activities/'+id);await expect(page.getByText('較新的費用規則',{exact:true})).toBeVisible();
});
test('a pending publication that never arrived keeps the exact request and cannot become another account’s activity',async({page,context})=>{
  await login(context);const id=await create(page);let first=true;const keys:string[]=[];await page.route('**/api/v2/activities/'+id+'/draft/publish',async route=>{keys.push(route.request().headers()['idempotency-key']!);if(first){first=false;return route.abort();}return route.continue();});await publish(page);await expect(page.getByRole('button',{name:'確認草稿操作結果',exact:true})).toBeVisible();await login(context,'bob');await page.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號',{exact:true})).toBeVisible();expect(keys[0]).toBe(keys[1]);page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByRole('button',{name:'發布活動',exact:true})).toHaveCount(0);await login(context);await page.reload();await expect(consent(page)).not.toBeChecked();await publish(page);await expect(page).toHaveURL('/activities/'+id);
});
test('legacy bot links select the exact activity and requested task without submitting any action or leaking invitation data',async({page,context})=>{
  let writes=0;page.on('request',request=>{if(['POST','PUT','PATCH','DELETE'].includes(request.method())&&request.url().includes('/activities/'))writes++;});
  for(const [action,path,title] of [['join','signup','新增報名'],['conditions','conditions','安排版本與確認'],['settlement','settlement','逐人結算'],['manage','arrangements','編輯活動安排']]){await page.goto('/?event=listen&action='+action);await expect(page).toHaveURL('/activities/listen/'+path);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();}await page.goto('/?event=listen&action=finance');await expect(page).toHaveURL('/activities/listen/finance');await expect(page.getByRole('heading',{name:'收付款帳本',exact:true})).toBeVisible();expect(writes).toBe(0);
  await page.goto('/?event=listen&action=onsite');await expect(page).toHaveURL('/activities/listen/attendance?preset=onsite');await expect(page.getByRole('link',{name:'登入',exact:true})).toBeVisible();expect(writes).toBe(0);
  await page.goto('/?event=invite&action=join');await expect(page.getByRole('heading',{name:'私人活動',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'登入',exact:true})).toBeVisible();await login(context,'bob');await page.reload();await expect(page.getByRole('alert')).toHaveText('找不到活動或尚未公開');await login(context);await page.reload();await expect(page.getByRole('dialog').locator('strong').filter({hasText:/^私人活動$/})).toBeVisible();expect(writes).toBe(0);
});
for(const kind of ['create','save'] as const)test('a completed '+kind+' raced by publication preserves the exact local input and opens the published activity across reload',async({page,context})=>{
  await login(context);let id=kind==='save'?await create(page):'',writes=0;
  await page.route(kind==='save'?'**/api/v2/activities/'+id+'/draft':'**/api/v2/activities/drafts',async route=>{
    if(route.request().method()!==(kind==='save'?'PUT':'POST'))return route.continue();writes++;
    const response=await route.fetch();const result=await response.json();id=result.id;
    const h=await headers(context);expect((await context.request.post('/api/v2/activities/'+id+'/draft/publish',{headers:h,data:{revision:result.revision,confirm:true,acceptConditions:true}})).status()).toBe(200);
    await route.fulfill({response});
  });
  if(kind==='create'){
    await page.goto('/activities/new');await page.getByLabel('活動名稱',{exact:true}).fill('跨裝置發布');await page.getByLabel('地點',{exact:true}).fill('原始地點');await setActivityStart(page,'2099-12-12T18:00:00');await fillAdvancedActivity(page,'報名截止','2099-12-11T18:00:00');
  }else await page.getByLabel('地點',{exact:true}).fill('原始地點');
  await page.getByRole('button',{name:kind==='create'?'建立活動草稿':'保存活動草稿',exact:true}).click();
  await expect(page.getByRole('link',{name:'開啟活動，原稿仍保留',exact:true})).toBeVisible();await expect(page.getByLabel('地點',{exact:true})).toHaveValue('原始地點');await expect(page.getByLabel('地點',{exact:true})).toBeDisabled();
  const local=await durableRows(page);expect(JSON.stringify(local)).toContain('原始地點');
  page.on('dialog',dialog=>void dialog.accept());await page.reload();
  if(kind==='create')await page.unroute('**/api/v2/activities/drafts');
  await page.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();await expect(page.getByRole('link',{name:'開啟活動，原稿仍保留',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'開啟活動，原稿仍保留',exact:true}).click();if(kind==='create')await page.getByRole('button',{name:'保留原稿並離開',exact:true}).click();
  await expect(page).toHaveURL('/activities/'+id);await expectLocation(page,'原始地點');expect(writes).toBe(1);
  expect(await durableRows(page)).toEqual(local);
});
