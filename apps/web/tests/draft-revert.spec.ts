import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { chooseMusicLevel, toggleMusicTerm, selectControl } from './kimi-controls';
import { damageDraft, durableRows } from './draft-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function settled(page:Page,prefix:string){await expect.poll(async()=>{const row=(await durableRows(page)).find(row=>row.key.includes(prefix));return row&&JSON.parse(row.raw);}).toMatchObject({dirty:false});}
const restore=(page:Page)=>page.getByRole('button',{name:'恢復本機原稿',exact:true});
async function leaveClean(page:Page){const close=page.getByRole('button',{name:'返回活動',exact:true});if(await close.count()){await close.click();await expect(page.getByRole('dialog',{name:'尚未提交的修改',exact:true})).toHaveCount(0);}await page.getByRole('link',{name:'活動',exact:true}).first().click();await expect(page).toHaveURL('/activities');await expect(page.getByRole('dialog',{name:'尚未提交的修改',exact:true})).toHaveCount(0);}

test('reselecting saved domains/sub terms and restoring levels clears the shared dock across discovery pages and reload',async({page,context})=>{
 await login(context);await page.goto('/me/music');
 for(const name of ['J-POP','YOASOBI','Aimer'])await toggleMusicTerm(page,name);
 await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
 let writes=0;page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/me/music'))writes++;});
 const dock=page.getByRole('region',{name:'詞條變動保存',exact:true});
 await toggleMusicTerm(page,'J-POP');await expect(dock).toBeVisible();await toggleMusicTerm(page,'J-POP');await expect(dock).toHaveCount(0);
 await toggleMusicTerm(page,'YOASOBI');await expect(dock).toBeVisible();await toggleMusicTerm(page,'YOASOBI');await expect(dock).toHaveCount(0);
 await page.goto('/music?q=Aimer');await page.getByRole('button',{name:'調整喜歡程度：Aimer',exact:true}).click();await chooseMusicLevel(page,'本命');await expect(dock).toBeVisible();
 await page.getByRole('button',{name:'調整喜歡程度：Aimer',exact:true}).click();await chooseMusicLevel(page,'常聽');await expect(dock).toHaveCount(0);
 await page.getByRole('link',{name:'同好',exact:true}).first().click();await expect(dock).toHaveCount(0);await page.reload();await expect(restore(page)).toHaveCount(0);await expect(dock).toHaveCount(0);await leaveClean(page);expect(writes).toBe(0);
});

test('an older reordered no-op music draft does not ask for restore but an uncertain identical operation remains pending',async({page,context})=>{
 await login(context);await page.goto('/me/music');for(const name of ['J-POP','Aimer'])await toggleMusicTerm(page,name);await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
 const row=(await durableRows(page)).find(row=>row.key.includes('music:v1:'))!,value=JSON.parse(row.raw);value.selections.reverse();await damageDraft(page,'music:v1:',JSON.stringify(value));await page.reload();await expect(restore(page)).toHaveCount(0);await expect(page.getByRole('region',{name:'詞條變動保存',exact:true})).toHaveCount(0);
 value.requestKey=crypto.randomUUID();await damageDraft(page,'music:v1:',JSON.stringify(value));await page.reload();await expect(page.getByRole('button',{name:'確認詞條保存結果',exact:true})).toBeVisible();expect(JSON.parse((await durableRows(page)).find(row=>row.key.includes('music:v1:'))!.raw).requestKey).toBe(value.requestKey);
});

test('poll fields and switches revert to clean, and a new tab has no recovery warning',async({page,context})=>{
 await login(context);await page.goto('/time-polls/new');const title=page.getByLabel('投票名稱',{exact:true});await title.fill('誤觸');await title.fill('');await settled(page,'poll-create:');
 const notice=page.getByRole('checkbox',{name:/群通知/});if(await notice.count()){await notice.uncheck();await notice.check();await settled(page,'poll-create:');}
 await leaveClean(page);await page.goto('/time-polls/new');await expect(restore(page)).toHaveCount(0);await expect(title).toHaveValue('');
 await title.fill('真正未保存的輸入');const other=await context.newPage();await other.goto('/time-polls/new');await expect(restore(other)).toBeVisible();
});

test('bot settings return to saved values after checkbox and numeric changes, including restored drafts',async({page,context})=>{
 await login(context,'registration-admin');await page.goto('/admin/bot');const field=page.getByLabel('主動發送最小間隔（秒）',{exact:true});await expect(field).toBeEnabled();const initial=await field.inputValue();
 await field.fill(String(Number(initial)+1));await field.fill(initial);await settled(page,'admin-bot:');await leaveClean(page);
 await page.goto('/admin/bot');await expect(restore(page)).toHaveCount(0);await field.fill(String(Number(initial)+2));await page.reload();await restore(page).click();await field.fill(initial);await settled(page,'admin-bot:');await leaveClean(page);
});

test('opening a catalog update is clean; reverting names removes recovery and navigation warnings',async({page,context})=>{
 await login(context,'registration-admin');await page.goto('/admin/music-entries');await page.getByRole('button',{name:'編輯 Aimer',exact:true}).click();
 const name=page.getByLabel('詞條名稱',{exact:true});await expect(name).toBeEnabled();await name.fill('誤觸的名字');await name.fill('Aimer');await settled(page,'admin-catalog:');await leaveClean(page);await page.goto('/admin/music-entries');await expect(restore(page)).toHaveCount(0);
});

test('wallpaper interval edit returns to clean and a fresh tab does not ask to restore',async({page,context})=>{
 await login(context,'registration-admin');await page.goto('/admin/appearance');await page.getByRole('button',{name:'設定輪播間隔',exact:true}).click();const field=page.getByLabel('輪播間隔（秒）',{exact:true}),initial=await field.inputValue();await field.fill('99');await field.fill(initial);await settled(page,'admin-appearance:');await leaveClean(page);await page.goto('/admin/appearance');await expect(restore(page)).toHaveCount(0);
});

test('account and music profile fields revert to clean; version-only local records do not require recovery',async({page,context})=>{
 await login(context);await page.goto('/me/music');await toggleMusicTerm(page,'Aimer');await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
 for(const [path,label,prefix] of [
  ['/me/profile','站內稱呼','account-profile:'],
  ['/me/music/details','成分稱呼','music:fields:'],
  ['/me/music/contact','聯絡 QQ','music:contact:'],
 ]){
  await page.goto(path!);const field=page.getByRole('textbox',{name:label!,exact:true});await expect(field).toBeEnabled();const initial=await field.inputValue();await field.fill(path!.endsWith('contact')?'12345':'暫時變更');await field.fill(initial);
  await expect.poll(async()=>!!(await durableRows(page)).find(row=>row.key.includes(prefix!))).toBe(true);
  const row=(await durableRows(page)).find(row=>row.key.includes(prefix!))!,draft=JSON.parse(row.raw);draft.revision=Math.max(0,draft.revision-1);await damageDraft(page,prefix!,JSON.stringify(draft));await page.reload();await expect(restore(page)).toHaveCount(0);await expect(field).toBeEnabled();await leaveClean(page);
 }
});

test.describe('room baselines',()=>{
test.use({musicRooms:true,adminCatalog:true});
test('free room selections and options compare against the actual initial member set',async({page,context})=>{
 await login(context);await page.goto('/tools/room-lab');const self=page.getByRole('checkbox',{name:'包含自己',exact:true});await expect(self).toBeEnabled();await self.uncheck();await self.check();const count=page.getByLabel('房數',{exact:true});await count.fill('3');await count.fill('2');await leaveClean(page);await page.goto('/tools/room-lab');await expect(restore(page)).toHaveCount(0);
});
test('an activity preselected roster is initially clean and a selection round trip stays clean',async({page,context})=>{
 await login(context);await page.goto('/tools/room-lab?eventId=listen');await expect(page.getByLabel('房數',{exact:true})).toBeEnabled();await leaveClean(page);await page.goto('/tools/room-lab?eventId=listen');await expect(restore(page)).toHaveCount(0);
});
});

test.describe('reviewed editor baselines',()=>{
test.use({settlementExamples:true,pollExamples:true});
test('room and settlement fields return to their original values without a leave or restore warning',async({page,context})=>{
 await login(context);
 for(const [path,label,prefix] of [
  ['/activities/listen/rooms','調整原因（最多 300 字）','rooms:'],
  ['/activities/listen/settlement/edit','結算備註（最多 1000 字）','settlement:'],
 ]){
  await page.goto(path!);const field=page.getByLabel(label!,{exact:true});await expect(field).toBeEnabled();const initial=await field.inputValue();await field.fill('誤觸輸入');await field.fill(initial);await settled(page,prefix!);await leaveClean(page);await page.goto(path!);await expect(restore(page)).toHaveCount(0);
 }
});
test('room member checkbox round trips ignore insertion order without saving the plan again',async({page,context})=>{
 await login(context);const session=await(await context.request.get('/api/v2/session')).json(),headers={Origin:origin,'X-Account-Scope':session.scope,'X-CSRF-Token':session.csrf,'Idempotency-Key':crypto.randomUUID()};
 const roster=await(await context.request.get('/api/v2/activities/listen/rooms',{headers})).json();
 expect((await context.request.post('/api/v2/activities/listen/rooms',{headers,data:{revision:roster.revision,rooms:[{id:'eeeeeeeeeeeeeeee',name:'測試包間',payer_id:roster.payers[0].id,person_ids:roster.people.slice(0,2).map((p:{id:string})=>p.id)}],confirm:true}})).ok()).toBe(true);
 await page.goto('/activities/listen/rooms');await page.getByRole('button',{name:'包間人員 · 2 人',exact:true}).click();const check=page.locator('.settlement-room').getByRole('checkbox',{name:roster.people[0].label,exact:true});await check.uncheck();await check.check();await settled(page,'rooms:');await leaveClean(page);await page.goto('/activities/listen/rooms');await expect(restore(page)).toHaveCount(0);
});
test('checking and unchecking a previously excluded settlement person is clean, but their edited inputs remain a draft',async({page,context})=>{
 await login(context);await page.goto('/activities/listen/settlement/edit');const people=page.locator('.settlement-person');
 const person=people.filter({has:page.getByRole('button',{name:/候補|已退出|待定/})}).first();await person.locator('.disclosure-trigger').first().click();const check=person.getByRole('checkbox').first();await check.check();await check.uncheck();await settled(page,'settlement:');await leaveClean(page);
 await page.goto('/activities/listen/settlement/edit');await person.locator('.disclosure-trigger').first().click();await check.check();await person.getByLabel('核對原因',{exact:true}).fill('保留的核對輸入');await check.uncheck();await expect.poll(async()=>JSON.parse((await durableRows(page)).find(row=>row.key.includes('settlement:'))!.raw).dirty).toBe(true);
});
test('changing a saved vote and changing back is clean without resubmitting',async({page,context})=>{
 await login(context,'bob');await page.goto('/time-polls/poll-exact');const row=page.locator('.poll-choice').nth(1);await expect(row.getByRole('radio',{name:'可以',exact:true})).toBeChecked();await row.getByRole('radio',{name:'不行',exact:true}).check();await row.getByRole('radio',{name:'可以',exact:true}).check();await settled(page,'poll-vote:');await leaveClean(page);await page.goto('/time-polls/poll-exact');await expect(restore(page)).toHaveCount(0);
});
});

test.describe('finance baseline',()=>{
 test.use({financeExamples:true});
 test('finance edits and command round trips return to clean without submitting a transaction',async({page,context})=>{
  await login(context);await page.goto('/activities/listen/finance');const form=page.locator('#finance-operation');await form.getByRole('button',{name:'款項操作',exact:true}).click();const amount=form.getByLabel('金額（人民幣）',{exact:true});await amount.fill('12');await amount.fill('');await settled(page,'finance:');
  await selectControl(form.getByLabel('操作',{exact:true}),'close');await selectControl(form.getByLabel('操作',{exact:true}),'record');await settled(page,'finance:');await leaveClean(page);await page.goto('/activities/listen/finance');await expect(restore(page)).toHaveCount(0);
 });
});
