import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { durableRows } from './draft-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
type Family='lifecycle'|'consent'|'attendance'|'onsite'|'signup'|'manage';
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function headers(context:BrowserContext){const viewer=await(await context.request.get(origin+'/api/v2/session')).json();return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};}
async function setup(context:BrowserContext,family:Family){
  await login(context);const created=await context.request.post(origin+'/api/v2/activities/drafts',{headers:await headers(context),data:{values:{title:'參與原稿驗收',category:'约K',location:'原場地',startsAt:'2099-12-12T18:00:00+08:00',deadline:'2099-12-11T18:00:00+08:00',capacity:5}}});expect(created.status()).toBe(200);
  const {id,revision}=await created.json();expect((await context.request.post(origin+'/api/v2/activities/'+id+'/draft/publish',{headers:await headers(context),data:{revision,confirm:true,acceptConditions:true}})).status()).toBe(200);
  const arrangement=await(await context.request.get(origin+'/api/v2/activities/'+id+'/arrangements',{headers:await headers(context)})).json();
  expect((await context.request.put(origin+'/api/v2/activities/'+id+'/arrangements',{headers:await headers(context),data:{revision:arrangement.revision,values:{...arrangement.values,feePolicy:'須核對的新費用'},reason:'驗收安排更新'}})).status()).toBe(200);
  if(family==='attendance'||family==='onsite'){
    const state=await(await context.request.get(origin+'/api/v2/activities/'+id+'/lifecycle',{headers:await headers(context)})).json();
    expect((await context.request.post(origin+'/api/v2/activities/'+id+'/lifecycle',{headers:await headers(context),data:{revision:state.revision,action:'start',reason:'',confirm:true}})).status()).toBe(200);
  }
  const registration=await(await context.request.get(origin+'/api/v2/activities/'+id+'/registration',{headers:await headers(context)})).json();
  if(family==='signup')await login(context,'bob');
  return {id:id as string,person:registration.people[0].id as string};
}
const flows:{family:Family;path:string;field:string;submit:string;retry:string;label:string;done:string}[]=[
  {family:'lifecycle',path:'lifecycle',field:'#lifecycle-reason',submit:'提交狀態變更',retry:'確認狀態操作結果',label:'活動狀態',done:'活動狀態已保存。'},
  {family:'consent',path:'conditions',field:'#condition-reason',submit:'提交安排確認',retry:'確認安排回覆結果',label:'安排回覆',done:'安排確認已保存。'},
  {family:'attendance',path:'attendance',field:'#attendance-note',submit:'保存出席紀錄',retry:'確認出席操作結果',label:'現場出席',done:'出席紀錄已保存。'},
  {family:'onsite',path:'attendance',field:'#onsite-name-0',submit:'保存現場補錄',retry:'確認出席操作結果',label:'現場出席',done:'現場補錄已保存。'},
  {family:'signup',path:'signup',field:'#signup-note-0',submit:'提交報名',retry:'確認報名操作結果',label:'活動報名',done:'報名已保存。'},
  {family:'manage',path:'registration',field:'#registration-note',submit:'提交報名操作',retry:'確認報名操作結果',label:'活動報名',done:'報名操作已保存。'},
];
async function prepare(page:Page,family:Family,id:string,person:string){
  const flow=flows.find(row=>row.family===family)!;await page.goto(origin+'/activities/'+id+'/'+flow.path);
  if(family==='lifecycle')await page.locator('#lifecycle-action').selectOption('cancel');
  if(family==='consent'){await page.locator('#condition-person').selectOption(person);await page.locator('#condition-decision').selectOption('declined');}
  if(family==='attendance'){await page.locator('#attendance-person').selectOption(person);await page.locator('#attendance-state').selectOption('present');}
  if(family==='onsite'){await page.locator('#attendance-mode').selectOption('onsite');await page.locator('#attendance-reason').fill('現場核對並保留原隊序');}
  if(family==='manage')await page.locator('#registration-person').selectOption(person);
  if(family==='signup')await page.locator('.registration-person summary').click();
  await page.locator(flow.field).fill('原稿內容');
  if(family==='signup')await page.getByRole('button',{name:'預覽逐人分配',exact:true}).click();
  if(family==='onsite')await page.getByLabel(/^已與現場參加者核對並接受第/).check();
  await page.getByLabel(family==='lifecycle'?/^已核對目前狀態，確認/:family==='consent'?/^已核對第 .* 版安排，確認提交/:family==='signup'?/^已核對第 .* 版安排、費用與逐人分配/:family==='manage'?/^已核對此人的報名，確認/:/^已核對對象、狀態與原因/).check();
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
}
for(const flow of flows){
  test(flow.family+' restores closed-tab input with the same revision, without carrying over acceptance or preview',async({page,context})=>{
    const {id,person}=await setup(context,flow.family);await prepare(page,flow.family,id,person);
    const [before]=await durableRows(page);expect(before).toBeDefined();expect(JSON.parse(before!.raw).pending).toBeUndefined();await page.close();
    const fresh=await context.newPage();await fresh.goto(origin+'/activities/'+id+'/'+flow.path+(flow.family==='onsite'?'?preset=onsite':''));
    await expect(fresh.locator(flow.field)).toHaveValue('原稿內容');await expect(fresh.locator(flow.field)).toBeVisible();await expect(fresh.locator(flow.field)).toBeDisabled();await fresh.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(fresh.locator(flow.field)).toBeEnabled();
    expect((await durableRows(fresh))[0]!.raw).toBe(before!.raw);
    const checks=fresh.locator('.activity-editor input[type="checkbox"]');for(let i=0;i<await checks.count();i++)await expect(checks.nth(i)).not.toBeChecked();
    if(flow.family==='signup'){
      await expect(fresh.getByRole('region',{name:'報名預覽',exact:true})).toHaveCount(0);
      await expect(fresh.getByRole('button',{name:flow.submit,exact:true})).toHaveCount(0);
      await fresh.getByRole('button',{name:'預覽逐人分配',exact:true}).click();
      await expect(fresh.getByLabel(/^已核對第 .* 版安排、費用與逐人分配/)).not.toBeChecked();
    }
    await expect(fresh.getByRole('button',{name:flow.submit,exact:true})).toBeDisabled();
  });
  test(flow.family+' resolves an uncertain operation from a new-tab inbox with its original UUID and body',async({page,context})=>{
    const {id,person}=await setup(context,flow.family);await prepare(page,flow.family,id,person);
    const suffix=flow.family==='lifecycle'?'/lifecycle':flow.family==='consent'?'/attendees/'+person+'/conditions':flow.family==='attendance'?'/attendance/'+person:flow.family==='onsite'?'/onsite':flow.family==='signup'?'/registration':'/attendees/'+person+'/registration';
    const keys:string[]=[],bodies:string[]=[];
    await context.route('**/api/v2/activities/'+id+suffix,async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);const response=await route.fetch();await route.fulfill(keys.length===1?{response,body:'{'}:{response});});
    await page.getByRole('button',{name:flow.submit,exact:true}).click();await expect(page.getByRole('button',{name:flow.retry,exact:true})).toBeVisible();
    const before=await(await context.request.get(origin+'/api/v2/activities/'+id+'/registration',{headers:await headers(context)})).json();await page.close();
    const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.getByRole('link',{name:flow.label,exact:true}).click();await expect(fresh.locator(flow.field)).toHaveValue('原稿內容');expect(keys).toHaveLength(1);
    await fresh.getByRole('button',{name:flow.retry,exact:true}).click();await expect(fresh.getByText(flow.done,{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
    const after=await(await context.request.get(origin+'/api/v2/activities/'+id+'/registration',{headers:await headers(context)})).json();expect(after.revision).toBe(before.revision);expect(after.people.length).toBe(before.people.length);
    // A clean stored placeholder can take a new deep-link preset without pretending to restore old input.
    if(flow.family!=='lifecycle'){
      const tail=flow.family==='consent'?'conditions?person='+person:flow.family==='manage'?'registration?person='+person:flow.family==='signup'?'signup?preset=tentative':'attendance?preset=onsite';
      await fresh.goto(origin+'/activities/'+id+'/'+tail);await expect(fresh.getByText('正在讀取本機原稿…',{exact:true})).toHaveCount(0);
      const control=flow.family==='consent'?'#condition-person':flow.family==='manage'?'#registration-person':flow.family==='signup'?'#signup-intent':'#attendance-mode';
      await expect(fresh.locator(control)).toHaveValue(flow.family==='consent'||flow.family==='manage'?person:flow.family==='signup'?'tentative':'onsite');await expect(fresh.locator(control)).toBeEnabled();await expect(fresh.getByRole('button',{name:'恢復本機原稿',exact:true})).toHaveCount(0);expect(keys).toHaveLength(2);
    }
  });
}
test('preserves both onsite tab versions and requires fresh safety confirmations after loading either version',async({page,context})=>{
  const {id,person}=await setup(context,'onsite');await prepare(page,'onsite',id,person);
  const other=await context.newPage();await other.goto(origin+'/activities/'+id+'/attendance?preset=onsite');await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await page.locator('#onsite-name-0').fill('第一頁現場人員');await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
  await other.locator('#onsite-name-0').fill('第二頁現場人員');await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();
  expect((await durableRows(other,'versions')).some(row=>JSON.parse(row.raw).people[0].name==='第二頁現場人員')).toBe(true);
  await other.getByRole('button',{name:'讀取已保存版本',exact:true}).click();await expect(other.locator('#onsite-name-0')).toHaveValue('第一頁現場人員');await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await other.getByLabel(/^已與現場參加者核對並接受第/).check();await other.getByLabel(/^已核對對象、狀態與原因/).check();
  await other.getByText('本機保全版本（1）',{exact:true}).click();await other.getByRole('button',{name:'載入此原稿（保留目前版本）',exact:true}).click();await expect(other.locator('#onsite-name-0')).toHaveValue('第二頁現場人員');
  await expect(other.getByLabel(/^已與現場參加者核對並接受第/)).not.toBeChecked();await expect(other.getByLabel(/^已核對對象、狀態與原因/)).not.toBeChecked();await expect(other.getByRole('button',{name:'保存現場補錄',exact:true})).toBeDisabled();
  await other.bringToFront();await other.setViewportSize({width:360,height:800});expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await other.screenshot({path:'test-results/unified-onsite-draft-recovery-mobile.png',fullPage:true});
});
test('retains a committed signup receipt when local confirmation aborts, then recovers the original pending without duplicating people',async({page,context})=>{
  const {id,person}=await setup(context,'signup');await prepare(page,'signup',id,person);
  const keys:string[]=[],bodies:string[]=[];await context.route('**/api/v2/activities/'+id+'/registration',route=>{if(route.request().method()==='POST'){keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);}return route.continue();});
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&typeof value.raw==='string'&&!JSON.parse(value.raw).pending){const tx=this.transaction;r.addEventListener('success',()=>{IDBObjectStore.prototype.put=original;tx.abort();});}return r;};
  });
  await page.getByRole('button',{name:'提交報名',exact:true}).click();await expect(page.getByText('操作已送出，但無法保存確認狀態；請保留原操作並核對結果。',{exact:true})).toBeVisible();expect(keys).toHaveLength(1);
  const [row]=await durableRows(page);expect(JSON.parse(row!.raw).pending.key).toBe(keys[0]);await page.close();
  const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.getByRole('link',{name:'活動報名',exact:true}).click();await fresh.getByRole('button',{name:'確認報名操作結果',exact:true}).click();await expect(fresh.getByText('報名已保存。',{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
  const data=await(await context.request.get(origin+'/api/v2/activities/'+id+'/registration',{headers:await headers(context)})).json();expect(data.people).toHaveLength(1);
});
