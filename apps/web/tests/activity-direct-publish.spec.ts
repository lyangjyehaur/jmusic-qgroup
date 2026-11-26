import type { BrowserContext,Page } from '@playwright/test';
import { test,expect } from './fixtures';
import { chooseOption, expectControlValue } from './kimi-controls';
import { advancedActivity,setActivityStart,fillAdvancedActivity } from './activity-authoring-controls';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
async function login(context:BrowserContext){await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function fill(page:Page){await page.getByLabel('活動名稱',{exact:true}).fill('直接發布驗收');await page.getByLabel('地點',{exact:true}).fill('測試地點');await setActivityStart(page,'2099-12-31T18:00');}
async function scope(context:BrowserContext){const s=await(await context.request.get('/api/v2/session')).json();return {'X-Account-Scope':s.scope};}
test('uses legacy defaults and publishes in one request with end-time cutoff and the owner registered',async({page,context})=>{
  await login(context);await page.goto('/activities/new');
  await expect(page.getByLabel('發布後同步到 QQ 群',{exact:true})).toBeChecked();
  await expectControlValue(page.getByLabel('開始時間',{exact:true}), '18:00');
  await expect(page.getByLabel('報名截止',{exact:true})).not.toBeVisible();
  await fill(page);await chooseOption(page,'活動類型',{label:'聚餐'});await expect(page.getByLabel('持續時間',{exact:true})).toContainText('2 小時');
  await advancedActivity(page);await expectControlValue(page.getByLabel('報名截止',{exact:true}), '2099-12-31T20:00');
  await chooseOption(page,'持續時間',{label:'5 小時'});await chooseOption(page,'活動類型','运动');await expect(page.getByLabel('持續時間',{exact:true})).toContainText('5 小時');
  await expectControlValue(page.getByLabel('報名截止',{exact:true}), '2099-12-31T23:00');
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/activities/drafts'))writes++;});
  await page.getByRole('button',{name:'發布活動',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}$/);expect(writes).toBe(1);
  const id=new URL(page.url()).pathname.split('/')[2],headers=await scope(context),activity=await(await context.request.get('/api/v2/activities/'+id,{headers})).json();
  expect(activity.lifecycle).toBe('scheduled');
  const roster=await(await context.request.get('/api/v2/activities/'+id+'/roster',{headers})).json();expect(roster.participants).toHaveLength(1);
  const arrangements=await(await context.request.get('/api/v2/activities/'+id+'/arrangements',{headers})).json();expect(arrangements.values).toMatchObject({deadline:'2099-12-31T15:00:00+00:00',botEnabled:true,durationHours:5});
});
test('requires early-night selection, previews the next calendar day and confirms before a cross-day publication',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await fill(page);await page.getByLabel('開始時間',{exact:true}).fill('00:30');
  await page.getByRole('button',{name:'發布活動',exact:true}).click();await expect(page.getByText('請選擇凌晨屬於哪一晚',{exact:true})).toBeVisible();
  await chooseOption(page,'凌晨屬於哪一晚',{label:'次日凌晨（相約當晚過後）'});await expect(page.locator('.activity-schedule-preview')).toContainText('2100');
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const top=page.getByRole('button',{name:'回到頂部',exact:true});
  if(await top.isVisible()){const a=await top.boundingBox(),b=await page.locator('.sticky-save-bar').boundingBox();expect(a!.y+a!.height).toBeLessThanOrEqual(b!.y);}
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/activity-create-early-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'發布活動',exact:true}).click();const dialog=page.getByRole('dialog',{name:'核對活動時間'});await expect(dialog).toContainText('2100');
  await expect(page).toHaveURL('/activities/new');await dialog.getByRole('button',{name:'返回修改'}).click();await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'發布活動',exact:true}).click();await page.getByRole('button',{name:'日期無誤，發布活動',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}$/);
});
test('keeps a manual cutoff across schedule edits and can restore its end-time link',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await fill(page);await fillAdvancedActivity(page,'報名截止','2099-12-30T18:00');
  await setActivityStart(page,'2099-12-31T19:00');await chooseOption(page,'持續時間',{label:'4 小時'});await expectControlValue(page.getByLabel('報名截止',{exact:true}), '2099-12-30T18:00');
  await page.getByRole('button',{name:'截止跟隨活動結束',exact:true}).click();await expectControlValue(page.getByLabel('報名截止',{exact:true}), '2099-12-31T23:00');
  await chooseOption(page,'持續時間',{label:'2 小時'});await expectControlValue(page.getByLabel('報名截止',{exact:true}), '2099-12-31T21:00');
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/activity-create-desktop.png',fullPage:true});
});
test('recovers an unreadable direct publication across reload with the same payload and key',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await fill(page);const keys:string[]=[],bodies:unknown[]=[];
  await page.route('**/api/v2/activities/drafts',async route=>{keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postDataJSON());const response=await route.fetch();await route.fulfill(keys.length===1?{response,body:'{'}:{response});});
  await page.getByRole('button',{name:'發布活動',exact:true}).click();await expect(page.getByRole('button',{name:'確認發布結果',exact:true})).toBeVisible();
  page.on('dialog',d=>void d.accept());await page.reload();await page.getByRole('button',{name:'確認發布結果',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}$/);
  expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toEqual(bodies[0]);expect(bodies[0]).toMatchObject({publish:true,confirm:true,acceptConditions:true});
});
