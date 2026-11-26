import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { denyDraftWrites } from './draft-helpers';

const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
async function login(context:BrowserContext,user='alice'){
  await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);
}
async function headers(context:BrowserContext){
  const viewer=await(await context.request.get('/api/v2/session')).json();
  return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};
}
async function setup(context:BrowserContext,capacity=5,minimumParticipants=0){
  await login(context);
  const created=await context.request.post('/api/v2/activities/drafts',{headers:await headers(context),data:{values:{title:'詳情與直接報名驗收',category:'约K',location:'隔離測試',startsAt:'2099-12-12T18:00:00+08:00',deadline:'2099-12-12T21:00:00+08:00',capacity,minimumParticipants,description:'注意事項第一行\n第二行',feePolicy:''}}});
  expect(created.status()).toBe(200);const event=await created.json();
  expect((await context.request.post(`/api/v2/activities/${event.id}/draft/publish`,{headers:await headers(context),data:{revision:event.revision,confirm:true,acceptConditions:true}})).status()).toBe(200);
  await login(context,'bob');return event.id as string;
}
test('detail notes, time range and every attendee stay compact and readable; refresh is read-only',async({page,context})=>{
  const id=await setup(context),writes:string[]=[];
  await page.route(`**/api/v2/activities/${id}/roster`,async route=>{
    const response=await route.fetch(),data=await response.json(),original=data.participants[0];
    data.participants=Array.from({length:8},(_,index)=>({...original,id:'person-'+index,name:index===1?'很長的報名者稱呼與同名測試'.repeat(3):'報名者 '+index,isMe:false,managedByMe:false,status:index===7?'waiting':'confirmed',waitingPosition:index===7?1:null,confirmationState:index===0?'declined':'accepted',attendance:index===0?'late':'unknown',note:index===1?'報名備註第一行\n第二行與很長的連續內容'.repeat(4):''}));
    await route.fulfill({response,json:data});
  });
  page.on('request',request=>{if(request.method()!=='GET'&&request.url().includes('/api/'))writes.push(request.url());});
  await page.goto('/activities/'+id);
  const facts=page.getByRole('region',{name:'活動安排'}).or(page.locator('.event-facts'));
  await expect(facts).toContainText('18:00–21:00');await expect(facts).toContainText('注意事項第一行');await expect(facts).not.toContainText('費用規則');await expect(page.getByText('完整時間範圍',{exact:true})).toHaveCount(0);
  const rows=page.locator('.activity-roster > li');await expect(rows).toHaveCount(8);await expect(page.getByRole('link',{name:/查看全部 .* 位成員/})).toHaveCount(0);
  await expect(rows.first()).toContainText('暫不同意新安排 · 遲到');await expect(rows.nth(7)).toContainText('候補 1');await expect(rows.nth(1).locator('.participant-note')).toHaveCSS('white-space','pre-wrap');await expect(page.locator('#participants')).not.toContainText('付款：');
  for(const width of [360,430,1280]){
    await page.setViewportSize({width,height:932});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const identity=await rows.first().locator('.participant-identity').boundingBox(),status=await rows.first().locator('.participant-state').boundingBox();
    expect(identity&&status&&Math.abs(identity.y-status.y)<15).toBe(true);
  }
  let reads=0;page.on('request',request=>{if(request.method()==='GET'&&request.url().endsWith('/roster'))reads++;});
  await page.getByRole('button',{name:'重新整理活動名單',exact:true}).click();await expect.poll(()=>reads).toBeGreaterThan(0);expect(writes).toEqual([]);
});
test('visible detail refreshes changed status automatically and clean self signup follows the latest revision',async({page,context})=>{
  const id=await setup(context,5,3),writes:string[]=[];
  page.on('request',request=>{if(request.method()!=='GET'&&request.url().includes('/api/'))writes.push(request.url());});
  await page.clock.install();
  await page.goto('/activities/'+id);
  await expect(page.locator('.activity-detail-status')).toContainText('發起者：小青');
  await expect(page.locator('.activity-detail-status')).toContainText('尚未達最低人數');
  await expect(page.getByRole('button',{name:'本人報名',exact:true})).toBeEnabled();
  async function change(action:string,reason=''){
    await login(context,'alice');const h=await headers(context);
    const current=await(await context.request.get(`/api/v2/activities/${id}/lifecycle`,{headers:h})).json();
    expect((await context.request.post(`/api/v2/activities/${id}/lifecycle`,{headers:h,data:{revision:current.revision,action,reason,confirm:true}})).status()).toBe(200);
    await login(context,'bob');await page.clock.fastForward(30000);
  }
  await change('pause');await expect(page.getByRole('region',{name:'我的報名'})).toContainText('這個活動已停止報名');
  await change('resume');await expect(page.getByRole('button',{name:'本人報名',exact:true})).toBeEnabled();
  await expect(page.getByText('活動或名單已有更新；請讀取最新安排，備註會保留。',{exact:true})).toHaveCount(0);
  await change('formation','已協調照常舉行');await expect(page.locator('.activity-detail-status')).toContainText('發起者已確認成團');
  await change('cancel','場地取消\n等待另約');await expect(page.locator('.activity-detail-status')).toContainText('取消原因：場地取消');
  expect(writes).toEqual([]);
});
test('one click submits only self and preserves the optional note without opening a preview dialog',async({page,context})=>{
  const id=await setup(context);await page.goto('/activities/'+id);
  await page.getByText('報名備註與規則',{exact:true}).click();await page.getByLabel('報名備註（活動內可見）',{exact:true}).fill('簡体與繁體原文\n第二行');
  await page.getByRole('button',{name:'本人報名',exact:true}).click();await expect(page.getByRole('link',{name:'管理本人報名',exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('region',{name:'報名預覽'})).toHaveCount(0);
  const data=await(await context.request.get(`/api/v2/activities/${id}/registration`,{headers:await headers(context)})).json();
  expect(data.people.filter((p:{isMe:boolean})=>p.isMe)).toHaveLength(1);expect(data.people.find((p:{isMe:boolean})=>p.isMe).note).toBe('簡体與繁體原文\n第二行');await expect(page.locator('#participants')).toContainText('報名備註：簡体與繁體原文');
});
test('a full activity accepts self into waiting in one click and shows the waiting position',async({page,context})=>{
  const id=await setup(context,1);await page.goto('/activities/'+id);await page.getByRole('button',{name:'本人加入候補',exact:true}).click();
  await expect(page.getByRole('heading',{name:'候補第 1 位',exact:true})).toBeVisible();await expect(page.locator('#participants')).toContainText('候補 1');await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('a lost direct signup response confirms the same durable request after reload without a second registration',async({page,context})=>{
  const id=await setup(context),keys:string[]=[];let fail=true;
  await page.route(`**/api/v2/activities/${id}/registration`,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);if(fail){fail=false;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await page.goto('/activities/'+id);await page.getByRole('button',{name:'本人報名',exact:true}).click();await expect(page.getByRole('button',{name:'確認報名操作結果',exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'確認報名操作結果',exact:true}).click();await expect(page.getByRole('button',{name:'確認報名操作結果',exact:true})).toHaveCount(0);
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  const data=await(await context.request.get(`/api/v2/activities/${id}/registration`,{headers:await headers(context)})).json();expect(data.people.filter((p:{isMe:boolean})=>p.isMe)).toHaveLength(1);
});
test('an allocation failure keeps the note, explains the next step and sends no signup until retry',async({page,context})=>{
  const id=await setup(context);let fail=true,writes=0;
  await page.route(`**/api/v2/activities/${id}/registration/preview`,route=>fail?route.fulfill({status:409,json:{code:'REVISION_CONFLICT',message:'活動安排已變更，請讀取最新安排'}}):route.continue());
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith(`/activities/${id}/registration`))writes++;});
  await page.goto('/activities/'+id);await page.getByText('報名備註與規則',{exact:true}).click();await page.getByLabel('報名備註（活動內可見）',{exact:true}).fill('保留的備註');await page.getByRole('button',{name:'本人報名',exact:true}).click();
  await expect(page.getByText('活動安排已變更，請讀取最新安排',{exact:true})).toBeVisible();expect(writes).toBe(0);
  await page.getByRole('button',{name:'讀取最新安排，保留備註',exact:true}).click();await expect(page.getByLabel('報名備註（活動內可見）',{exact:true})).toHaveValue('保留的備註');
  fail=false;await page.getByRole('button',{name:'本人報名',exact:true}).click();await expect(page.getByRole('link',{name:'管理本人報名',exact:true})).toBeVisible();expect(writes).toBe(1);
});
test('a storage failure blocks direct signup before sending an allocation or registration',async({page,context})=>{
  const id=await setup(context);await page.goto('/activities/'+id);await expect(page.getByRole('button',{name:'本人報名',exact:true})).toBeEnabled();await denyDraftWrites(page,'registration:');
  const writes:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/registration'))writes.push(request.url());});
  await page.getByRole('button',{name:'本人報名',exact:true}).click();await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toEqual([]);
});
