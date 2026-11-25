import { openAdminTool, openActivityTool } from './kimi-controls';
import { test,expect } from './fixtures';
import type { BrowserContext,Page } from '@playwright/test';
import { denyDraftWrites } from './draft-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
test.use({botDeliveryExamples:true});
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function confirm(page:Page){await page.getByRole('checkbox',{name:'我已核對目標群、發送模式與重送內容',exact:true}).check();await page.getByRole('button',{name:'建立重送工作',exact:true}).click();}
async function rows(context:BrowserContext,root='/activities/listen/bot-deliveries'){
  const viewer=await(await context.request.get('/api/v2/session')).json();return (await context.request.get('/api/v2'+root,{headers:{'X-Account-Scope':viewer.scope}})).json();
}
test('administrator reviews metadata and blocked uncertainty on mobile; site administration does not grant activity ownership',async({page,context})=>{
  await login(context,'registration-admin');await page.setViewportSize({width:360,height:800});await page.goto('/admin');await openAdminTool(page,'bot 投遞紀錄');
  await expect(page.getByText('DO NOT EXPOSE PAYLOAD')).toHaveCount(0);await page.getByRole('button',{name:'核對通知 #3',exact:true}).click();await expect(page.getByRole('region',{name:'通知核對 #3',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'建立重送工作',exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'前往授權核對入口',exact:true}).click();await expect(page.getByText('目前帳號或通知核對權限已變更。')).toBeVisible();await expect(page.getByText('合成未確認通知內容',{exact:true})).toHaveCount(0);
  await page.goto('/admin/bot/deliveries');await page.getByRole('combobox',{name:'投遞狀態',exact:true}).selectOption('failed');await expect(page.getByRole('button',{name:'核對通知 #3',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-bot-deliveries-mobile.png',fullPage:true});
});
test('lost retry response survives reload and is recovered without creating a second intent',async({page,context})=>{
  await login(context);let lose=true;const writes:{key:string|undefined;body:string|null}[]=[];
  await page.route('**/api/v2/activities/listen/bot-deliveries/1/retry',async route=>{writes.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});if(!lose)return route.continue();lose=false;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.goto('/activities/listen');await openActivityTool(page,'群通知紀錄');await page.getByRole('button',{name:'核對通知 #1',exact:true}).click();await expect(page.getByText('合成失敗通知內容',{exact:true}).last()).toBeVisible();await expect(page.getByRole('button',{name:'建立重送工作',exact:true})).toBeDisabled();await confirm(page);
  await expect(page.getByText('尚未確認重送結果；請先查回原操作，避免重複建立工作。',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'查回原重送結果',exact:true}).click();await expect(page.getByText(/已建立待送工作 #7/)).toBeVisible();expect(writes).toHaveLength(1);expect((await rows(context)).entries.filter((r:{status:string})=>r.status==='pending')).toHaveLength(2);
});
test('a missing original result requires a deliberate resend using the exact saved UUID and body',async({page,context})=>{
  await login(context);let lose=true;const writes:{key:string|undefined;body:string|null}[]=[];
  await page.route('**/api/v2/activities/listen/bot-deliveries/1/retry',async route=>{writes.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});if(lose){lose=false;return route.abort();}return route.continue();});
  await page.goto('/activities/listen/bot-deliveries?delivery=1');await confirm(page);await expect(page.getByRole('button',{name:'查回原重送結果',exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'查回原重送結果',exact:true}).click();await expect(page.getByRole('button',{name:'以原操作編號重送',exact:true})).toBeVisible();expect(writes).toHaveLength(1);await page.getByRole('button',{name:'以原操作編號重送',exact:true}).click();await expect(page.getByText(/已建立待送工作 #7/)).toBeVisible();expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);
});
test('storage failure prevents submission and uncertain or already sent records offer no retry action',async({page,context})=>{
  await login(context);let writes=0;page.on('request',request=>{if(request.url().endsWith('/retry')&&request.method()==='POST')writes++;});
  await page.goto('/activities/listen/bot-deliveries?delivery=3');await expect(page.getByRole('alert').filter({hasText:'投遞結果未確認'})).toBeVisible();await expect(page.getByRole('button',{name:'建立重送工作',exact:true})).toHaveCount(0);
  await page.goto('/activities/listen/bot-deliveries?delivery=4');await expect(page.getByRole('alert').filter({hasText:'已確認送出'})).toBeVisible();await page.goto('/activities/listen/bot-deliveries?delivery=1');
  await page.evaluate(()=>{Object.defineProperty(window,'restoreSyntheticStorage',{configurable:true,value:IDBObjectStore.prototype.put});});
  await denyDraftWrites(page,'bot-delivery:');
  await confirm(page);await expect(page.getByText('無法保存重送操作編號，請先修復瀏覽器儲存後再操作。',{exact:true})).toBeVisible();expect(writes).toBe(0);await page.evaluate(()=>{IDBObjectStore.prototype.put=(window as unknown as {restoreSyntheticStorage:typeof IDBObjectStore.prototype.put}).restoreSyntheticStorage;});await page.getByRole('button',{name:'建立重送工作',exact:true}).click();await expect(page.getByText(/已建立待送工作 #7/)).toBeVisible();expect(writes).toBe(1);
});
test('poll owner reviews regenerated candidates and queues a new notice from the unified delivery screen',async({page,context})=>{
  await login(context);await page.goto('/time-polls/poll-exact/manage');await page.getByRole('link',{name:'群通知紀錄',exact:true}).click();await page.getByRole('button',{name:'核對通知 #6',exact:true}).click();await expect(page.getByRole('region',{name:'通知核對 #6',exact:true})).toContainText('共 2 个候选');await confirm(page);await expect(page.getByText(/已建立待送工作 #7/)).toBeVisible();expect((await rows(context,'/time-polls/poll-exact/bot-deliveries')).entries).toHaveLength(2);
});
test('a delayed old-account review cannot restore private notification content after switching accounts',async({page,context})=>{
  await login(context);let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/v2/activities/listen/bot-deliveries/1',async route=>{const response=await route.fetch();started();await held;await route.fulfill({response}).catch(()=>{});});
  try{await page.goto('/activities/listen/bot-deliveries?delivery=1');await waiting;await login(context,'bob');await page.evaluate(()=>{const channel=new BroadcastChannel('qgroup:rebuild:session');channel.postMessage('refresh');channel.close();});await expect(page.getByText('目前帳號或通知核對權限已變更。')).toBeVisible();}finally{release();}await expect(page.getByText('合成失敗通知內容',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'建立重送工作',exact:true})).toHaveCount(0);
});

test('receipt lookup failure preserves the original operation across reload',async({page,context})=>{
  await login(context);let writes=0,limited=true;
  await page.route('**/api/v2/activities/listen/bot-deliveries/1/retry',async route=>{writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.route('**/api/v2/bot-delivery-results/*',async route=>{if(limited){limited=false;await route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({code:'RATE_LIMIT',message:'請稍後再查回結果'})});}else await route.continue();});
  await page.goto('/activities/listen/bot-deliveries?delivery=1');await confirm(page);await page.getByRole('button',{name:'查回原重送結果',exact:true}).click();await expect(page.getByText('請稍後再查回結果',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'建立重送工作',exact:true})).toHaveCount(0);await page.reload();await page.getByRole('button',{name:'查回原重送結果',exact:true}).click();await expect(page.getByText(/已建立待送工作 #7/)).toBeVisible();expect(writes).toBe(1);
});

test('an invalid bookmarked filter uses the recovery controls without issuing an invalid API query',async({page,context})=>{
  await login(context);const queries:string[]=[];
  page.on('request',request=>{if(request.url().includes('/api/v2/activities/listen/bot-deliveries'))queries.push(request.url());});
  await page.goto('/activities/listen/bot-deliveries?status=simulated&before=9223372036854775808');
  await expect(page.getByText('篩選條件無效，請重新選擇通知條件。',{exact:true})).toBeVisible();expect(queries).toEqual([]);
  await page.getByRole('combobox',{name:'投遞狀態',exact:true}).selectOption('failed');
  await expect(page.getByRole('button',{name:'核對通知 #1',exact:true})).toBeVisible();
  expect(queries).toHaveLength(1);expect(new URL(queries[0]!).searchParams.toString()).toBe('status=failed');
  await expect(page.getByText('篩選條件無效，請重新選擇通知條件。',{exact:true})).toHaveCount(0);
});
