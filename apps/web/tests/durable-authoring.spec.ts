import { fillAdvancedActivity, setActivityStart } from './activity-authoring-controls';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { durableRows } from './draft-helpers';
test.use({ financeExamples: true, paymentExamples: true });
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
const title=(page:Page)=>page.getByLabel('活動名稱',{exact:true});
async function fill(page:Page,name:string){await title(page).fill(name);await page.getByLabel('地點',{exact:true}).fill('台北');await setActivityStart(page,'2099-12-12T18:00:00');await fillAdvancedActivity(page,'報名截止','2099-12-11T18:00:00');}
async function saved(page:Page){await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);}
async function image(page:Page){const raw=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=16;c.height=16;c.getContext('2d')!.fillRect(0,0,16,16);return c.toDataURL().split(',')[1]!;});return {name:'code.png',mimeType:'image/png',buffer:Buffer.from(raw,'base64')};}
test('retains the original pending without sending after account replacement during its storage commit',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await fill(page,'保存途中切換帳號');await saved(page);
  let sends=0;await page.route('**/api/v2/activities/drafts',route=>{sends++;return route.continue();});
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put,flags=window as unknown as {draftCommitHeld:boolean;releaseDraftCommit:boolean};
    IDBObjectStore.prototype.put=function(value,key){
      const result=original.call(this,value,key);
      if(this.name==='drafts'&&typeof value.raw==='string'&&JSON.parse(value.raw).pending){
        IDBObjectStore.prototype.put=original;
        result.addEventListener('success',()=>{
          flags.draftCommitHeld=true;
          const keepAlive=()=>{if(!flags.releaseDraftCommit)this.get(value.key).addEventListener('success',keepAlive);};keepAlive();
        });
      }
      return result;
    };
  });
  await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();
  try{
    await expect.poll(()=>page.evaluate(()=>(window as unknown as {draftCommitHeld:boolean}).draftCommitHeld)).toBe(true);
    await login(context,'bob');await page.evaluate(()=>{const channel=new BroadcastChannel('qgroup:rebuild:session');channel.postMessage('refresh');channel.close();});
    await expect(page.locator('header .viewer')).toHaveText('小白');
  }finally{await page.evaluate(()=>{(window as unknown as {releaseDraftCommit:boolean}).releaseDraftCommit=true;});}
  await expect(title(page)).toBeEnabled();await expect(title(page)).toHaveValue('');expect(sends).toBe(0);
  const rows=await durableRows(page);expect(rows).toHaveLength(1);expect(JSON.parse(rows[0]!.raw).pending.input.values.title).toBe('保存途中切換帳號');
  await login(context);await page.evaluate(()=>{const channel=new BroadcastChannel('qgroup:rebuild:session');channel.postMessage('refresh');channel.close();});
  await expect(page.getByRole('button',{name:'確認草稿操作結果',exact:true})).toBeVisible();expect(sends).toBe(0);
});
test('keeps a created operation recoverable when its atomic local move aborts, then resolves it once after closing the tab',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await fill(page,'轉移失敗原稿');await saved(page);
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&value.raw===null){const tx=this.transaction;r.addEventListener('success',()=>{IDBObjectStore.prototype.put=original;tx.abort();});}return r;};
  });
  const keys:string[]=[],bodies:string[]=[];
  await context.route('**/api/v2/activities/drafts',async route=>{keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);await route.continue();});
  await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();
  await expect(page.getByText('尚未確認活動草稿操作結果。原操作已保留，請按「確認草稿操作結果」安全重試。',{exact:true})).toBeVisible();
  const rows=await durableRows(page);expect(rows).toHaveLength(1);expect(JSON.parse(rows[0]!.raw).pending.key).toBe(keys[0]);expect(rows[0]!.key.endsWith(':new')).toBe(true);
  await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await fresh.getByRole('link',{name:'活動草稿',exact:true}).click();
  expect(keys).toHaveLength(1);await fresh.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();
  await expect(fresh).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/);expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
  expect((await durableRows(fresh)).some(row=>row.key.endsWith(':new'))).toBe(false);
  await fresh.goto(origin+'/activities/new');await expect(title(fresh)).toHaveValue('');
});
test('retains target edits made in another tab while creation is waiting for its response',async({page,context})=>{
  await login(context);await page.goto('/activities/new');await fill(page,'伺服器已建立');
  let release!:()=>void,seen!:(id:string)=>void;const gate=new Promise<void>(r=>release=r),created=new Promise<string>(r=>seen=r);
  await page.route('**/api/v2/activities/drafts',async route=>{const response=await route.fetch();seen((await response.json()).id);await gate;await route.fulfill({response});});
  await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();const id=await created,other=await context.newPage();
  try{
    await other.goto(origin+'/activities/'+id+'/edit');await title(other).fill('另一頁的尚未保存編輯');await saved(other);
    release();await expect(page).toHaveURL('/activities/'+id+'/edit');await expect(title(page)).toHaveValue('另一頁的尚未保存編輯');await expect(title(page)).toBeDisabled();
    await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await page.getByRole('button',{name:'保存活動草稿',exact:true}).click();await expect(page.getByText('活動草稿已保存。',{exact:true})).toBeVisible();
  }finally{release();await other.close();}
});
test('recovers a copy creation from the new-tab inbox without re-reading its original source or making another activity',async({page,context})=>{
  await login(context);await page.goto('/activities/new?copyFrom=listen');await fill(page,'再約的原操作');
  const keys:string[]=[],bodies:string[]=[];
  await context.route('**/api/v2/activities/drafts',async route=>{keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);const response=await route.fetch();await route.fulfill(keys.length===1?{response,body:'{'}:{response});});
  await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page.getByText('尚未確認活動草稿操作結果。原操作已保留，請按「確認草稿操作結果」安全重試。',{exact:true})).toBeVisible();
  await page.close();let sourceReads=0;await context.route('**/api/v2/activities/listen/copy-source',route=>{sourceReads++;return route.abort();});
  const fresh=await context.newPage();await fresh.goto(origin+'/inbox');await expect(fresh.getByRole('link',{name:'活動草稿',exact:true})).toHaveAttribute('href','/activities/new?copyFrom=listen');await fresh.getByRole('link',{name:'活動草稿',exact:true}).click();
  await expect(title(fresh)).toHaveValue('再約的原操作');expect(sourceReads).toBe(0);expect(keys).toHaveLength(1);
  await fresh.getByRole('button',{name:'確認草稿操作結果',exact:true}).click();await expect(fresh).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
});
test('preserves a receipt code after closing the tab, isolates accounts and blocks a stale editor after logout without tab signaling',async({page,context})=>{
  await login(context);await page.goto('/me/payment-codes');await page.getByLabel('名稱（選填）',{exact:true}).fill('關頁原圖');await page.getByLabel('收款碼圖片',{exact:true}).setInputFiles(await image(page));
  const img=page.getByRole('img',{name:'待保存收款碼',exact:true});await expect(img).toBeVisible();const src=await img.getAttribute('src');await saved(page);await page.close();
  const fresh=await context.newPage();await fresh.addInitScript(()=>{Object.defineProperty(window,'BroadcastChannel',{value:undefined});});await fresh.goto(origin+'/me/payment-codes');
  await expect(fresh.getByRole('img',{name:'待保存收款碼',exact:true})).toHaveAttribute('src',src!);await expect(fresh.getByLabel('名稱（選填）',{exact:true})).toBeDisabled();await fresh.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  const other=await context.newPage();await login(context,'bob');await other.goto(origin+'/me/payment-codes');await expect(other.locator('.payment-asset img')).toHaveCount(0);
  await login(context);await other.goto(origin+'/me/accounts');await other.getByRole('button',{name:'登出此裝置',exact:true}).click();await expect(other.getByRole('heading',{name:'尚未登入',exact:true})).toBeVisible();
  await fresh.getByLabel('名稱（選填）',{exact:true}).fill('不能復活的原圖');await expect(fresh.getByText('此原稿已因登出或資料刪除失效，請重新載入頁面。',{exact:false})).toBeVisible();expect(await durableRows(fresh)).toEqual([]);
});
test('restores incomplete ledger commands with their operation IDs and revisions, and preserves both competing tab inputs',async({page,context})=>{
  await login(context);await page.goto('/activities/listen/finance');await page.getByText('款項操作',{exact:true}).click();
  await page.getByLabel('金額（人民幣）',{exact:true}).fill('7.25');await page.getByLabel('備註（最多 1000 字）',{exact:true}).fill('保留帳本原輸入');await saved(page);
  const before=(await durableRows(page)).find(row=>row.key.includes('finance:'))!;await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/activities/listen/finance');
  await expect(fresh.getByLabel('金額（人民幣）',{exact:true})).toHaveValue('7.25');await fresh.getByRole('button',{name:'恢復本機原稿',exact:true}).click();expect((await durableRows(fresh)).find(row=>row.key===before.key)!.raw).toBe(before.raw);
  const other=await context.newPage();await other.goto(origin+'/activities/listen/finance');
  await expect(other.getByLabel('金額（人民幣）',{exact:true})).toHaveValue('7.25');
  await expect(other.getByLabel('金額（人民幣）',{exact:true})).toBeDisabled();
  await expect(other.locator('.finance-operation-panel')).toHaveAttribute('open','');
  await other.getByText('款項操作',{exact:true}).click();
  await expect(other.locator('.finance-operation-panel')).not.toHaveAttribute('open','');
  await other.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await expect(other.getByLabel('金額（人民幣）',{exact:true})).toBeVisible();
  await fresh.getByLabel('金額（人民幣）',{exact:true}).fill('8.25');await saved(fresh);await other.getByLabel('金額（人民幣）',{exact:true}).fill('9.25');
  await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();expect((await durableRows(other,'versions')).some(row=>JSON.parse(row.raw).operation.transaction.amount==='9.25')).toBe(true);
  expect(JSON.parse((await durableRows(other)).find(row=>row.key===before.key)!.raw).operation.transaction.amount).toBe('8.25');
  await other.bringToFront();await other.setViewportSize({width:360,height:800});expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await other.screenshot({path:'test-results/unified-finance-draft-recovery-mobile.png',fullPage:true});
});
