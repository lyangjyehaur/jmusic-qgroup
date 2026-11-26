import { openActivityTool, selectControl, expectControlValue } from './kimi-controls';
import { damageDraft, denyDraftWrites, durableRows } from './draft-helpers';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function headers(context:BrowserContext){const viewer=await(await context.request.get('/api/v2/session')).json();return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};}
async function published(context:BrowserContext){
  await login(context);let h=await headers(context);const response=await context.request.post('/api/v2/activities/drafts',{headers:h,data:{values:{title:'活動狀態驗收',category:'约K',location:'測試地點',startsAt:'2099-12-12T18:00:00+08:00',deadline:'2099-12-11T18:00:00+08:00',capacity:5,minimumParticipants:3}}});expect(response.status()).toBe(200);const result=await response.json();h=await headers(context);expect((await context.request.post('/api/v2/activities/'+result.id+'/draft/publish',{headers:h,data:{revision:result.revision,confirm:true,acceptConditions:true}})).status()).toBe(200);return result.id as string;
}
async function change(context:BrowserContext,id:string,action:string,reason=''){
  const h=await headers(context),current=await(await context.request.get('/api/v2/activities/'+id+'/lifecycle',{headers:h})).json();expect((await context.request.post('/api/v2/activities/'+id+'/lifecycle',{headers:h,data:{revision:current.revision,action,reason,confirm:true}})).status()).toBe(200);
}
async function choose(page:Page,action:string,reason=''){
  await selectControl(page.getByLabel('操作',{exact:true}), action);await page.getByLabel(/^原因（/).fill(reason);await page.getByLabel(/^已核對目前狀態，確認/).check();
}
const submit=(page:Page)=>page.getByRole('button',{name:'提交狀態變更',exact:true});
test('finish and settle opens the owner editor only after confirmation without publishing a bill',async({page,context})=>{
  const id=await published(context);await page.goto('/activities/'+id);
  await page.getByRole('link',{name:'結束並結算',exact:true}).click();
  await expectControlValue(page.getByLabel('操作',{exact:true}), 'finish');
  await expect(submit(page)).toBeDisabled();
  const before=await(await context.request.get('/api/v2/activities/'+id+'/lifecycle',{headers:await headers(context)})).json();expect(before.actualEndedAt).toBeNull();
  await page.getByLabel('已核對目前狀態，確認標記實際結束',{exact:true}).check();await submit(page).click();
  await expect(page).toHaveURL('/activities/'+id+'/settlement/edit');
  await expect(page.getByRole('dialog',{name:'編輯結算',exact:true}).getByLabel('費用金額',{exact:true})).toBeVisible();
  const bill=await context.request.get('/api/v2/activities/'+id+'/settlement',{headers:await headers(context)});expect(bill.status()).toBe(200);expect((await bill.json()).bill).toBeNull();
});
test('finish and settle recovers a lost finish response with the same key before opening the editor',async({page,context})=>{
  const id=await published(context),keys:string[]=[];let fail=true;
  await page.route('**/api/v2/activities/'+id+'/lifecycle',async route=>{
    if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']!);
    if(fail){fail=false;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await page.goto('/activities/'+id);await page.getByRole('link',{name:'結束並結算',exact:true}).click();
  await page.getByLabel('已核對目前狀態，確認標記實際結束',{exact:true}).check();await submit(page).click();
  await expect(page.getByRole('button',{name:'確認狀態操作結果',exact:true})).toBeVisible();
  const first=await(await context.request.get('/api/v2/activities/'+id+'/lifecycle',{headers:await headers(context)})).json();
  page.on('dialog',dialog=>void dialog.accept());await page.reload();
  await page.getByRole('button',{name:'確認狀態操作結果',exact:true}).click();
  await expect(page).toHaveURL('/activities/'+id+'/settlement/edit');expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  const second=await(await context.request.get('/api/v2/activities/'+id+'/lifecycle',{headers:await headers(context)})).json();
  expect(second.actualEndedAt).toBe(first.actualEndedAt);expect(second.revision).toBe(first.revision);
});
test('schedule cohost can finish but is not sent to an unauthorized settlement editor',async({page,context})=>{
  const id=await published(context),h=await headers(context);
  const current=await(await context.request.get('/api/v2/activities/'+id+'/delegation',{headers:h})).json();
  expect((await context.request.post('/api/v2/activities/'+id+'/delegation/invitations',{headers:await headers(context),data:{revision:current.revision,kind:'cohost',targetName:'日程協辦',attendeeId:null,permissions:['schedule'],reason:'日程分工',confirm:true}})).status()).toBe(200);
  const invitation=(await(await context.request.get('/api/v2/activities/'+id+'/delegation',{headers:await headers(context)})).json()).invitations.at(-1);
  await login(context,'bob');const preview=await(await context.request.get('/api/v2/activities/'+id+'/delegation/preview/'+invitation.token,{headers:await headers(context)})).json();
  expect((await context.request.post('/api/v2/activities/'+id+'/delegation/preview/'+invitation.token+'/accept',{headers:await headers(context),data:{revision:preview.revision,acceptResponsibility:true,confirm:true}})).status()).toBe(200);
  await page.goto('/activities/'+id);await page.getByRole('link',{name:'結束並結算',exact:true}).click();
  await page.getByLabel('已核對目前狀態，確認標記實際結束',{exact:true}).check();await submit(page).click();
  await expect(page.getByText('由發起者或指定結算人核對並發布結算。',{exact:true})).toBeVisible();
  await expect(page).toHaveURL('/activities/'+id+'/lifecycle?preset=finish&next=settlement');
  const bill=await context.request.get('/api/v2/activities/'+id+'/settlement',{headers:await headers(context)});expect(bill.status()).toBe(200);expect((await bill.json()).bill).toBeNull();
});
test('activity lifecycle shares the detail flow, confirms low attendance, records actual times and preserves cancellation through archive',async({page,context})=>{
  const id=await published(context);await page.goto('/activities/'+id);await openActivityTool(page,'管理活動狀態');await expect(page.getByText('已排定',{exact:true})).toBeVisible();
  await choose(page,'formation');await submit(page).click();await expect(page.getByText('此操作必須填寫原因。',{exact:true})).toBeVisible();await page.getByLabel('原因（必填）',{exact:true}).fill('已協調仍決定成團');await expect(page.getByLabel(/^已核對目前狀態，確認/)).not.toBeChecked();await page.getByLabel(/^已核對目前狀態，確認/).check();await submit(page).click();await expect(page.getByText('已確認',{exact:true})).toBeVisible();
  for(const [action,text] of [['pause','關閉'],['resume','開啟（仍受截止時間限制）'],['start','實際進行中'],['finish','實際已結束']] as const){await choose(page,action);await submit(page).click();await expect(page.getByText(text,{exact:true})).toBeVisible();await expectControlValue(page.getByLabel('操作',{exact:true}), '');}
  await choose(page,'cancel','場地取消，款項另行核對');await submit(page).click();await expect(page.getByRole('dialog').getByText('已取消',{exact:true})).toBeVisible();await expect(page.getByText('場地取消，款項另行核對',{exact:true})).toBeVisible();await choose(page,'archive');await submit(page).click();await expect(page.getByText('已取消 · 已歸檔',{exact:true})).toBeVisible();await selectControl(page.getByLabel('操作',{exact:true}), 'start');await expect(page.getByText('請先取消歸檔再修改活動',{exact:true})).toBeVisible();await expect(submit(page)).toBeDisabled();await choose(page,'unarchive');await submit(page).click();await expect(page.getByRole('dialog').getByText('已取消',{exact:true})).toBeVisible();
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByLabel('操作',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/unified-lifecycle-mobile.png'});
  const h=await headers(context),roster=await(await context.request.get('/api/v2/activities/'+id+'/roster',{headers:h})).json();expect(roster.participants).toHaveLength(1);
});
test('unknown lifecycle results keep the original key and payload across reload and do not duplicate the actual transition',async({page,context})=>{
  const id=await published(context),keys:string[]=[],bodies:unknown[]=[];let first=true;await page.route('**/api/v2/activities/'+id+'/lifecycle',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postDataJSON());const response=await route.fetch();await route.fulfill({response,...(first?{body:'{'}:{})});first=false;});
  await page.goto('/activities/'+id+'/lifecycle');await choose(page,'cancel','保留原取消原因');await submit(page).click();await expect(page.getByRole('button',{name:'確認狀態操作結果',exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();await expectControlValue(page.getByLabel('原因（必填）',{exact:true}), '保留原取消原因');await expect(page.getByLabel('操作',{exact:true})).toBeDisabled();await page.getByRole('button',{name:'確認狀態操作結果',exact:true}).click();await expect(page.getByText('活動狀態已保存。',{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toEqual(bodies[1]);const h=await headers(context),data=await(await context.request.get('/api/v2/activities/'+id+'/lifecycle',{headers:h})).json();expect(data.revision).toBe(4);
});
test('stale state retains the reason and requires explicit rechecking before another transition',async({page,context})=>{
  const id=await published(context);await page.goto('/activities/'+id+'/lifecycle');await choose(page,'cancel','原取消原因');await change(context,id,'start');await submit(page).click();await expect(page.getByText('活動或名單已有更新；輸入仍保留，請核對目前安排後再保存',{exact:true})).toBeVisible();await expect(page.getByLabel(/^已核對目前狀態，確認/)).not.toBeChecked();await page.getByRole('button',{name:'核對最新狀態，保留輸入',exact:true}).click();await expect(page.getByText('實際進行中',{exact:true})).toBeVisible();await expectControlValue(page.getByLabel('原因（必填）',{exact:true}), '原取消原因');await expect(page.getByLabel(/^已核對目前狀態，確認/)).not.toBeChecked();await page.getByLabel(/^已核對目前狀態，確認/).check();await submit(page).click();await expect(page.getByRole('dialog').getByText('已取消',{exact:true})).toBeVisible();
});
test('eligible removal safely recovers after an unreadable response and becomes inaccessible to others',async({page,context})=>{
  const id=await published(context);let first=true;const keys:string[]=[];await page.route('**/api/v2/activities/'+id+'/lifecycle',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']!);const response=await route.fetch();await route.fulfill({response,...(first?{body:'{'}:{})});first=false;});
  await page.goto('/activities/'+id+'/lifecycle');await choose(page,'remove');await submit(page).click();await expect(page.getByRole('button',{name:'確認狀態操作結果',exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByText('已移除',{exact:true})).toBeVisible();await page.getByRole('button',{name:'確認狀態操作結果',exact:true}).click();await expect(page.getByText('活動已移除。',{exact:true})).toBeVisible();expect(keys[0]).toBe(keys[1]);await login(context,'bob');await page.reload();await expect(page.getByRole('alert')).toHaveText('找不到活動或尚未公開');
});
test('blocked and damaged draft storage prevent sending while preserving recovery evidence',async({page,context})=>{
  const id=await published(context);let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/lifecycle'))writes++;});await page.goto('/activities/'+id+'/lifecycle');await choose(page,'pause');await denyDraftWrites(page,'lifecycle:');await submit(page).click();await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();try{clean.on('dialog',dialog=>void dialog.accept());await clean.goto('/activities/'+id+'/lifecycle');await damageDraft(clean,'lifecycle:','damaged lifecycle draft');await clean.reload();await expect(clean.getByLabel('操作',{exact:true})).toBeDisabled();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged lifecycle draft');await expect(clean.getByLabel('操作',{exact:true})).toBeEnabled();}finally{await clean.close();}
});
test('account switches reject the original operation and never grant lifecycle rights',async({page,context})=>{
  const id=await published(context);await page.goto('/activities/'+id+'/lifecycle');await choose(page,'start');await login(context,'bob');await submit(page).click();await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號',{exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByText('目前帳號沒有活動狀態管理權限。',{exact:true})).toBeVisible();await expect(page.getByLabel('操作',{exact:true})).toHaveCount(0);await context.clearCookies();await page.goto('/activities/invite/lifecycle');await expect(page.getByLabel('操作',{exact:true})).toHaveCount(0);
});
test('device logout clears lifecycle drafts and delayed success cannot recreate private content',async({page,context})=>{
  const id=await published(context);let release!:()=>void,seen!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),intercepted=new Promise<void>(resolve=>{seen=resolve;});await page.route('**/api/v2/activities/'+id+'/lifecycle',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();seen();await gate;await route.fulfill({response});});await page.goto('/activities/'+id+'/lifecycle');await choose(page,'cancel','登出前的取消原稿');await submit(page).click();await intercepted;
  const account=await context.newPage();try{await account.goto('/me/accounts');await account.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(page.getByLabel('操作',{exact:true})).toHaveCount(0);release();await expect.poll(()=>durableRows(page)).toEqual([]);await expect(page.getByText('登出前的取消原稿',{exact:true})).toHaveCount(0);}finally{release();await account.close();}
});
