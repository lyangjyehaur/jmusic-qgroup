import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { durableRows } from './draft-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
type Kind='invite-issue'|'invite-accept'|'claim-issue'|'claim-decide'|'claim-request'|'manager-invite'|'manager-revoke'|'manager-accept';
const flows:{kind:Kind;family:string;label:string;submit:string;retry:string;done:string}[]=[
  {kind:'invite-issue',family:'invitations',label:'補報名邀請',submit:'建立邀請',retry:'確認邀請操作結果',done:'邀請已建立。'},
  {kind:'invite-accept',family:'invitations',label:'補報名邀請',submit:'接受邀請',retry:'確認邀請操作結果',done:'已接受邀請並保存報名。'},
  {kind:'claim-issue',family:'claims',label:'代報認領',submit:'建立認領邀請',retry:'確認認領操作結果',done:'認領邀請已建立。'},
  {kind:'claim-decide',family:'claims',label:'代報認領',submit:'提交認領處理',retry:'確認認領操作結果',done:'認領處理已保存。'},
  {kind:'claim-request',family:'claims',label:'代報認領',submit:'提交認領申請',retry:'確認認領操作結果',done:'認領申請已提交，請等待管理人核對。'},
  {kind:'manager-invite',family:'delegation',label:'管理分工',submit:'建立管理邀請',retry:'確認管理操作結果',done:'管理邀請已建立。'},
  {kind:'manager-revoke',family:'delegation',label:'管理分工',submit:'撤銷管理權限或邀請',retry:'確認管理操作結果',done:'管理權限或邀請已撤銷。'},
  {kind:'manager-accept',family:'delegation',label:'管理分工',submit:'接受管理邀請',retry:'確認管理操作結果',done:'已接受管理邀請。'},
];
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function headers(context:BrowserContext){const viewer=await(await context.request.get(origin+'/api/v2/session')).json();return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};}
async function get(context:BrowserContext,path:string){const response=await context.request.get(origin+'/api/v2'+path,{headers:await headers(context)});expect(response.status()).toBe(200);return response.json();}
async function post(context:BrowserContext,path:string,data:unknown){const response=await context.request.post(origin+'/api/v2'+path,{headers:await headers(context),data});expect(response.status()).toBe(200);return response.json();}
async function setup(context:BrowserContext,kind:Kind){
  await login(context);const created=await post(context,'/activities/drafts',{values:{title:'邀請原稿驗收',category:'约K',location:'核對場地',startsAt:'2099-12-12T18:00:00+08:00',deadline:'2099-12-11T18:00:00+08:00',capacity:8}}),id=created.id as string,base='/activities/'+id;
  await post(context,base+'/draft/publish',{revision:created.revision,confirm:true,acceptConditions:true});
  let token='',person='',item='';
  if(kind.startsWith('claim-')){
    const state=await get(context,base+'/registration'),values={revision:state.revision,people:[{isSelf:false,name:'原代報者',note:'原備註',payerKind:'manager'}],queueMode:'individual',intent:'registered'},preview=await post(context,base+'/registration/preview',values);
    await post(context,base+'/registration',{...values,previewToken:preview.token,conditionsVersion:preview.conditionsVersion,acceptConditions:true,acceptPartial:true,confirm:true});person=(await get(context,base+'/registration')).people.find((p:{isGuest:boolean})=>p.isGuest).id;
    if(kind!=='claim-issue'){
      const state=await get(context,base+'/claims');await post(context,base+'/claims',{revision:state.revision,attendeeId:person,reason:'邀請本人',confirm:true});const claim=(await get(context,base+'/claims')).claims[0];token=claim.token;item=claim.id;
      await login(context,'bob');
      if(kind==='claim-decide'){const p=await get(context,base+'/claims/preview/'+token);await post(context,base+'/claims/preview/'+token+'/request',{revision:p.revision,confirmIdentity:true,keepPayment:true,confirm:true});await login(context);}
    }
  }
  if(kind==='invite-accept'){
    const state=await get(context,base+'/invitations');await post(context,base+'/invitations',{revision:state.revision,people:[{isSelf:false,name:'受邀本人',note:'',payerKind:'self'}],reason:'補報名',confirm:true});token=(await get(context,base+'/invitations')).people[0].token;await login(context,'bob');
  }
  if(kind==='manager-revoke'||kind==='manager-accept'){
    const state=await get(context,base+'/delegation');await post(context,base+'/delegation/invitations',{revision:state.revision,kind:'cohost',targetName:'協辦本人',attendeeId:null,permissions:['attendance'],reason:'現場分工',confirm:true});const invite=(await get(context,base+'/delegation')).invitations[0];token=invite.token;item=invite.id;
    if(kind==='manager-accept')await login(context,'bob');
  }
  const family=flows.find(f=>f.kind===kind)!.family,path=base+'/'+family+((kind.endsWith('accept')||kind==='claim-request')?'/'+token:kind==='claim-issue'?'?person='+person:'');
  const endpoint=base+'/'+(kind==='invite-accept'?'invitations/'+token+'/accept':kind==='claim-request'?'claims/preview/'+token+'/request':kind==='claim-decide'?'claims/'+item:kind==='manager-accept'?'delegation/preview/'+token+'/accept':kind==='manager-revoke'?'delegation/invitations/'+item+'/revoke':kind==='manager-invite'?'delegation/invitations':family);
  return {id,path,endpoint,person,item,token};
}
async function prepare(page:Page,kind:Kind,state:Awaited<ReturnType<typeof setup>>){
  await page.goto(origin+state.path);
  if(kind==='invite-issue'){await page.locator('#invite-name-0').fill('原稿受邀人');await page.locator('#invite-reason').fill('核對原邀請');await page.getByLabel('已核對受邀者與原因，確認建立邀請',{exact:true}).check();}
  if(kind==='invite-accept')await page.getByLabel(/^已核對本人身分與第/).check();
  if(kind==='claim-issue'||kind==='claim-decide'){
    if(kind==='claim-decide'){await page.locator('#claim-target').selectOption('claim:'+state.item);await page.getByLabel('已核對申請人就是這位參加者',{exact:true}).check();}
    await page.locator('#claim-reason').fill('原稿認領原因');
    // Editing reason deliberately resets identity confirmation.
    if(kind==='claim-decide')await page.getByLabel('已核對申請人就是這位參加者',{exact:true}).check();
    await page.getByLabel(/^已核對對象、原因與付款責任/).check();
  }
  if(kind==='claim-request')for(const label of ['我就是這位被代報的參加者','保留原付款責任、隊位與同意紀錄，不移轉或合併款項','確認以目前帳號提交本人認領申請'])await page.getByLabel(label,{exact:true}).check();
  if(kind==='manager-invite'||kind==='manager-revoke'){
    if(kind==='manager-revoke'){await page.locator('#delegation-action').selectOption('revoke');await page.locator('#delegation-target').selectOption('invitations:'+state.item);}
    else{await page.getByLabel('受邀者稱呼',{exact:true}).fill('原稿協辦');await page.getByLabel('現場出席',{exact:true}).check();}
    await page.locator('#delegation-reason').fill('原稿管理原因');await page.getByLabel('已核對對象、職責與原因，確認管理操作',{exact:true}).check();
  }
  if(kind==='manager-accept')for(const label of ['我已核對受邀身分並願意承擔上述管理職責','確認以目前帳號接受管理邀請'])await page.getByLabel(label,{exact:true}).check();
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
}
for(const flow of flows)test(flow.kind+' recovers a closed-tab uncertain result via the original scoped link and exact request',async({page,context})=>{
  const state=await setup(context,flow.kind);await prepare(page,flow.kind,state);const keys:string[]=[],bodies:string[]=[];
  await context.route('**/api/v2'+state.endpoint,async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);const response=await route.fetch();await route.fulfill(keys.length===1?{response,body:'{'}:{response});});
  await page.getByRole('button',{name:flow.submit,exact:true}).click();await expect(page.getByRole('button',{name:flow.retry,exact:true})).toBeVisible();
  const before=await get(context,'/activities/'+state.id+'/registration');await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/inbox');
  const inventory=fresh.getByRole('region',{name:'未完成操作',exact:true});expect(await inventory.textContent()).not.toContain(state.token||'原稿');
  const link=inventory.getByRole('link',{name:flow.label,exact:true});await expect(link).toHaveAttribute('href',state.path.split('?')[0]!);await link.click();expect(keys).toHaveLength(1);
  await fresh.getByRole('button',{name:flow.retry,exact:true}).click();await expect(fresh.getByText(flow.done,{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
  const after=await get(context,'/activities/'+state.id+'/registration');expect(after).toEqual(before);
});
for(const kind of ['invite-issue','claim-issue','manager-invite'] as const)test(kind+' restores unfinished input without accepting old confirmations or a new URL target',async({page,context})=>{
  const state=await setup(context,kind),flow=flows.find(f=>f.kind===kind)!;await prepare(page,kind,state);const before=await durableRows(page);await page.close();
  const fresh=await context.newPage();await fresh.goto(origin+state.path+(kind==='claim-issue'?'ignored':''));const field=fresh.locator(kind==='invite-issue'?'#invite-reason':kind==='claim-issue'?'#claim-reason':'#delegation-reason');await expect(field).toBeDisabled();await fresh.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(field).toBeEnabled();expect(await durableRows(fresh)).toEqual(before);
  await expect(fresh.getByRole('button',{name:flow.submit,exact:true})).toBeDisabled();const confirmations=fresh.locator('.activity-editor input[type="checkbox"]');
  for(let i=0;i<await confirmations.count();i++){const input=confirmations.nth(i);if(await input.evaluate(el=>(el as HTMLInputElement).parentElement?.textContent?.includes('現場出席')))continue;await expect(input).not.toBeChecked();}
  if(kind==='claim-issue')await expect(fresh.locator('#claim-target')).toHaveValue('person:'+state.person);
});
test('manager acceptance preserves its pending operation if the local completion transaction aborts',async({page,context})=>{
  const state=await setup(context,'manager-accept');await prepare(page,'manager-accept',state);
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&typeof value.raw==='string'&&!JSON.parse(value.raw).pending){r.addEventListener('success',()=>{IDBObjectStore.prototype.put=original;this.transaction.abort();});}return r;};});
  await page.getByRole('button',{name:'接受管理邀請',exact:true}).click();await expect(page.getByText('操作已送出，但無法保存確認狀態；請保留原操作並核對結果。',{exact:true})).toBeVisible();const [row]=await durableRows(page);expect(JSON.parse(row!.raw).pending.kind).toBe('accept');await page.close();
  const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.getByRole('link',{name:'管理分工',exact:true}).click();await fresh.getByRole('button',{name:'確認管理操作結果',exact:true}).click();await expect(fresh.getByText('已接受管理邀請。',{exact:true})).toBeVisible();expect((await get(context,'/activities/'+state.id+'/delegation')).roles).toHaveLength(1);
});
test('claim clean placeholder accepts a fresh person link without restoring old input',async({page,context})=>{
  const state=await setup(context,'claim-issue');await page.goto(origin+'/activities/'+state.id+'/claims');await expect(page.locator('#claim-target')).toBeEnabled();
  // Rebase stores an actual empty placeholder with the current revision.
  await page.getByRole('button',{name:'核對最新資料，保留輸入',exact:true}).click();await expect(page.getByText('已取得最新名單與認領狀態；原輸入保留，請重新核對。',{exact:true})).toBeVisible();
  await page.goto(origin+state.path);await expect(page.locator('#claim-target')).toHaveValue('person:'+state.person);await expect(page.locator('#claim-target')).toBeEnabled();await expect(page.getByRole('button',{name:'恢復本機原稿',exact:true})).toHaveCount(0);
});
test('conflicting claim drafts preserve both target versions and reset identity after archived version load',async({page,context})=>{
  const state=await setup(context,'claim-decide');await prepare(page,'claim-decide',state);const other=await context.newPage();await other.goto(origin+state.path);await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await page.locator('#claim-reason').fill('第一頁核對');await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await other.locator('#claim-reason').fill('第二頁核對');await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();
  expect((await durableRows(other,'versions')).some(row=>JSON.parse(row.raw).reason==='第二頁核對')).toBe(true);await other.getByRole('button',{name:'讀取已保存版本',exact:true}).click();await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(other.locator('#claim-reason')).toHaveValue('第一頁核對');
  await other.getByLabel('已核對申請人就是這位參加者',{exact:true}).check();await other.getByLabel(/^已核對對象、原因與付款責任/).check();await other.getByText('本機保全版本（1）',{exact:true}).click();await other.getByRole('button',{name:'載入此原稿（保留目前版本）',exact:true}).click();await expect(other.locator('#claim-reason')).toHaveValue('第二頁核對');await expect(other.getByLabel('已核對申請人就是這位參加者',{exact:true})).not.toBeChecked();await expect(other.getByRole('button',{name:'提交認領處理',exact:true})).toBeDisabled();
  await other.bringToFront();await other.setViewportSize({width:360,height:800});expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await other.screenshot({path:'test-results/unified-claim-draft-recovery-mobile.png',fullPage:true});
});
test('a rejected recipient operation stays pending if durable rejection cleanup aborts',async({page,context})=>{
  const state=await setup(context,'invite-accept');await prepare(page,'invite-accept',state);
  const keys:string[]=[],bodies:string[]=[];await context.route('**/api/v2'+state.endpoint,async route=>{keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'SYNTHETIC_CONFLICT',message:'請重新核對邀請'})});});
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&typeof value.raw==='string'&&!JSON.parse(value.raw).pending){r.addEventListener('success',()=>{IDBObjectStore.prototype.put=original;this.transaction.abort();});}return r;};});
  await page.getByRole('button',{name:'接受邀請',exact:true}).click();await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(JSON.parse((await durableRows(page))[0]!.raw).pending.key).toBe(keys[0]);await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.getByRole('link',{name:'補報名邀請',exact:true}).click();await fresh.getByRole('button',{name:'確認邀請操作結果',exact:true}).click();await expect(fresh.getByText('請重新核對邀請',{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);expect(JSON.parse((await durableRows(fresh))[0]!.raw).pending).toBeUndefined();await expect(fresh.getByRole('button',{name:'接受邀請',exact:true})).toBeDisabled();
});
