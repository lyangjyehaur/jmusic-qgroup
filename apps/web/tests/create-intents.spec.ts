import { fillAdvancedActivity, setActivityStart } from './activity-authoring-controls';
import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { test,expect } from './fixtures';
import { damageDraft,durableRows } from './draft-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,scope=createHash('sha256').update('kanban-drafts-v1:alice').digest('hex');
async function login(context:BrowserContext,id='alice') {await context.addCookies([{name:'kanban_session',value:'fixture-'+id,url:origin,httpOnly:true,sameSite:'Lax'}]);}
const key=(kind:'activity'|'poll')=>'qgroup:rebuild:activity-draft:'+(kind==='activity'?'v1:':'poll-create:v1:')+scope+':new';
const name=(kind:'activity'|'poll')=>kind==='activity'?'活動名稱':'投票名稱';
const button=(kind:'activity'|'poll')=>kind==='activity'?'建立活動草稿':'建立時間投票';
async function fill(page:Page,kind:'activity'|'poll') {
  await page.getByLabel(name(kind),{exact:true}).fill('原建立內容');
  if(kind==='activity'){
    await page.getByLabel('地點',{exact:true}).fill('台北');await setActivityStart(page,'2099-12-23T18:00:00');await fillAdvancedActivity(page,'報名截止','2099-12-22T18:00:00');
  }else{
    await page.getByLabel('預計地點',{exact:true}).fill('台北');await page.getByLabel('候選日期 1',{exact:true}).fill('2099-12-23');await page.getByLabel('候選日期 2',{exact:true}).fill('2099-12-24');await page.getByLabel('投票截止（含時區）',{exact:true}).fill('2099-12-22T18:00:00+08:00');
  }
}
for(const kind of ['activity','poll'] as const) {
  test(kind+' creation follows its durable intent across browser contexts and keeps later edits when another context has already created it',async({page,context,browser})=>{
    await login(context);await page.goto(kind==='activity'?'/activities/new':'/time-polls/new');await fill(page,kind);
    await expect.poll(async()=>{const row=(await durableRows(page)).find(row=>row.key===key(kind));if(!row?.raw)return '';const saved=JSON.parse(row.raw);return kind==='activity'?saved.form.deadline:saved.value.deadline;}).toBe(kind==='activity'?'2099-12-22T18:00':'2099-12-22T18:00:00+08:00');
    const raw=(await durableRows(page)).find(row=>row.key===key(kind))!.raw!;
    const original=JSON.parse(raw),intent=kind==='activity'?original.clientIntent:original.value.client_intent;expect(intent).toMatch(/^[\da-f-]{36}$/);
    let firstBody:Record<string,unknown>|undefined;const url=kind==='activity'?'**/api/v2/activities/drafts':'**/api/v2/time-polls';
    await page.route(url,async route=>{firstBody=route.request().postDataJSON();await route.continue();});
    await page.getByRole('button',{name:button(kind),exact:true}).click();await expect(page).toHaveURL(kind==='activity'?/\/activities\/[a-f0-9]{16}\/edit$/:/\/time-polls\/[a-f0-9]{16}$/);
    const remoteId=new URL(page.url()).pathname.split('/')[2]!;
    const restored=await browser.newContext({baseURL:origin,serviceWorkers:'block'});
    try {
      await login(restored);await restored.addInitScript(({key,raw})=>sessionStorage.setItem(key,raw),{key:key(kind),raw});
      const old=await restored.newPage();await old.goto(kind==='activity'?'/activities/new':'/time-polls/new');await old.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expect(old.getByLabel(name(kind),{exact:true})).toHaveValue('原建立內容');
      await old.getByLabel(name(kind),{exact:true}).fill('本機後續編輯');let secondBody:Record<string,unknown>|undefined,writes=0;
      await old.route(url,async route=>{writes++;secondBody=route.request().postDataJSON();await route.continue();});
      await old.getByRole('button',{name:button(kind),exact:true}).click();await expect(old.getByText(/這份原稿已建立/)).toBeVisible();await expect(old.getByLabel(name(kind),{exact:true})).toHaveValue('本機後續編輯');expect(secondBody?.[kind==='activity'?'clientIntent':'client_intent']).toBe(firstBody?.[kind==='activity'?'clientIntent':'client_intent']);
      await old.getByRole('button',{name:'核對原'+(kind==='activity'?'活動':'投票')+'建立識別',exact:true}).click();const link=old.getByRole('link',{name:'開啟原'+(kind==='activity'?'活動':'投票')+'，保留本機原稿',exact:true});await expect(link).toHaveAttribute('href',kind==='activity'?'/activities/'+remoteId+'/edit':'/time-polls/'+remoteId);
      const retained=JSON.parse((await durableRows(old)).find(row=>row.key===key(kind))!.raw!);expect(kind==='activity'?retained.form.title:retained.value.title).toBe('本機後續編輯');expect(retained.pending).toBeUndefined();expect(writes).toBe(1);
      const current=await restored.request.get('/api/v2/'+(kind==='activity'?'me/activity-drafts':'time-polls'),{headers:{'X-Account-Scope':scope}});const body=await current.json();expect((kind==='activity'?body.drafts:body.polls).filter((v:{title:string})=>v.title==='原建立內容')).toHaveLength(1);
    }finally{await restored.close();}
  });
}
test('read-only intent lookups retain incomplete input and ignore a response arriving after logout',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await page.getByLabel('活動名稱',{exact:true}).fill('未完成原稿');
  await page.getByRole('button',{name:'核對原活動建立識別',exact:true}).click();await expect(page.getByText(/不能據此認定未建立/)).toBeVisible();await expect(page.getByLabel('活動名稱',{exact:true})).toHaveValue('未完成原稿');
  let release!:()=>void,seen!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),arrived=new Promise<void>(resolve=>{seen=resolve;});
  await page.route('**/api/v2/me/create-intents/view',async route=>{seen();await gate;await route.fulfill({json:{state:'existing',kind:'activity',id:'listen',revision:0,route:'arrangements',canEdit:true}});});
  await page.getByRole('button',{name:'核對原活動建立識別',exact:true}).click();await arrived;
  const other=await context.newPage();try{await other.goto('/me/accounts');await other.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(page.getByLabel('活動名稱',{exact:true})).toHaveCount(0);release();await expect(page.getByRole('link',{name:'開啟原活動，保留本機原稿',exact:true})).toHaveCount(0);expect((await durableRows(other)).filter(row=>row.key===key('activity'))).toHaveLength(0);}finally{release();await other.close();}
});
test('preserving an unreadable poll draft uses the same fresh intent in storage and the visible replacement',async({page,context})=>{
  await login(context);await page.goto('/time-polls/new');await fill(page,'poll');await damageDraft(page,'poll-create:','unreadable preserved poll');page.on('dialog',dialog=>void dialog.accept());await page.reload();await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();await expect(page.getByLabel('投票名稱',{exact:true})).toBeEnabled();
  const original=(await durableRows(page,'versions')).map(row=>row.raw);expect(original).toContain('unreadable preserved poll');const stored=JSON.parse((await durableRows(page)).find(row=>row.key===key('poll'))!.raw).value.client_intent;
  let checked:unknown;page.on('request',r=>{if(r.url().endsWith('/me/create-intents/view'))checked=r.postDataJSON();});await page.getByRole('button',{name:'核對原投票建立識別',exact:true}).click();await expect(page.getByText(/不能據此認定未建立/)).toBeVisible();expect(checked).toEqual({kind:'poll',intent:stored});
});
test('a delayed lookup cannot cross a local logout epoch even when the same account is still visible without tab signaling',async({page,context})=>{
  await page.addInitScript(()=>Object.defineProperty(globalThis,'BroadcastChannel',{value:undefined,configurable:true}));await login(context);await page.goto('/activities/new');await page.getByLabel('活動名稱',{exact:true}).fill('世代清除前原稿');
  let release!:()=>void,seen!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),arrived=new Promise<void>(resolve=>{seen=resolve;});await page.route('**/api/v2/me/create-intents/view',async route=>{seen();await gate;await route.fulfill({json:{state:'existing',kind:'activity',id:'listen',revision:0,route:'arrangements',canEdit:true}});});
  await page.getByRole('button',{name:'核對原活動建立識別',exact:true}).click();await arrived;
  // Isolated fixture models logout cleanup followed by same-account login; no production session or work is involved.
  await page.evaluate(async()=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['epochs','drafts','versions'],'readwrite',{durability:'strict'}),store=tx.objectStore('epochs'),r=store.get('device');r.onsuccess=()=>{store.put((r.result??0)+1,'device');tx.objectStore('drafts').clear();tx.objectStore('versions').clear();};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}});
  release();await expect(page.getByText('此原稿已因登出清除，請重新載入頁面。',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'開啟原活動，保留本機原稿',exact:true})).toHaveCount(0);expect(await durableRows(page)).toHaveLength(0);
});
