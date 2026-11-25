import { test, expect } from './fixtures';
import { denyDraftWrites,durableRows } from './draft-helpers';
import type { BrowserContext, Page } from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
const confirmation='確認已核對成分及申請人，重設找回口令';
const success='口令重設已完成，該成分的舊找回授權已失效。';
const unknown='尚未確認口令重設結果。口令未保存，請先查詢操作結果。';
async function login(context:BrowserContext,user='registration-admin'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function revealPin(page:Page){await expect(page.getByText('重設找回口令',{exact:true})).toBeVisible();if(!await page.getByLabel('新找回口令',{exact:true}).isVisible())await page.getByText('重設找回口令',{exact:true}).click();}
async function open(page:Page,qq='10001'){
  await page.goto('/admin/music');await page.getByLabel('搜尋成分',{exact:true}).fill(qq);await page.getByRole('button',{name:'搜尋',exact:true}).click();await expect(page.getByText('共 1 份成分',{exact:true})).toBeVisible();await page.getByRole('link',{name:'舊成分 '+qq,exact:true}).click();await expect(page.getByLabel('新找回口令',{exact:true})).toBeHidden();await revealPin(page);
}
async function fill(page:Page,pin='654321',reason='已核對原成分及重設申請'){await revealPin(page);await page.getByLabel('新找回口令',{exact:true}).fill(pin);await page.getByLabel('重設原因',{exact:true}).fill(reason);}
async function submit(page:Page){await page.getByRole('checkbox',{name:confirmation,exact:true}).check();await page.getByRole('button',{name:'重設口令',exact:true}).click();}
async function noPinStored(page:Page){for(const name of ['drafts','versions'] as const)for(const row of (await durableRows(page,name)).filter(row=>row.key.includes('admin-music-pin:'))){const value=JSON.parse(row.raw);expect(value===null||Object.keys(value).join(',')==='requestId').toBe(true);}expect(await page.evaluate(()=>JSON.stringify({session:{...sessionStorage},local:{...localStorage}}))).not.toMatch(/654321|jpm-pin|pinHash|pin_hash/);}

test('an administrator without music resets a numeric PIN with confirmation and retains music and association',async({page,context})=>{
  await login(context);await open(page);let writes=0;page.on('request',request=>{if(request.url().endsWith('/pin'))writes++;});
  await fill(page);await expect(page.getByRole('button',{name:'重設口令',exact:true})).toBeDisabled();await noPinStored(page);expect(writes).toBe(0);
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-admin-pin-mobile.png',fullPage:true});
  await submit(page);await expect(page.getByText(success,{exact:true})).toBeVisible();await expect(page.getByLabel('新找回口令',{exact:true})).toHaveValue('');await expect(page.getByText('目前關聯：未關聯',{exact:true})).toBeVisible();await expect(page.getByText('Aimer · 程度 4',{exact:true})).toBeVisible();await expect(page.getByText('已核對原成分及重設申請',{exact:true})).toBeVisible();expect(writes).toBe(1);await noPinStored(page);
  await login(context,'bob');await page.goto('/me/music/recover');await page.getByLabel('舊 QQ',{exact:true}).fill('10001');await page.getByLabel('原口令',{exact:true}).fill('654321');await page.getByRole('checkbox',{name:/確認以舊資料驗證/}).check();await page.getByRole('button',{name:'驗證原口令',exact:true}).click();await expect(page.getByRole('button',{name:'前往 QQ 授權找回',exact:true})).toBeVisible();expect(page.url()).toContain('/me/music/recover');
});
test('a lost reset response survives reload as only an operation ID and checks the receipt without resending the PIN',async({page,context})=>{
  await login(context);await open(page);let writes=0;let checks=0;
  await page.route('**/api/v2/admin/music/*/pin',async route=>{writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  page.on('request',request=>{if(request.url().endsWith('/pin-result'))checks++;});
  await fill(page);await submit(page);await expect(page.getByText(unknown,{exact:true})).toBeVisible();await expect(page.getByLabel('新找回口令',{exact:true})).toHaveValue('');await noPinStored(page);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByLabel('新找回口令',{exact:true})).toBeDisabled();expect(writes).toBe(1);await page.getByRole('button',{name:'查詢口令重設結果',exact:true}).click();await expect(page.getByText(success,{exact:true})).toBeVisible();expect(writes).toBe(1);expect(checks).toBe(1);await noPinStored(page);
});
test('a request that did not arrive is checked first and requires re-entry and confirmation before a new submission',async({page,context})=>{
  await login(context);await open(page);let writes=0;
  await page.route('**/api/v2/admin/music/*/pin',async route=>{writes++;await route.abort();});await fill(page);await submit(page);await expect(page.getByText(unknown,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'查詢口令重設結果',exact:true}).click();await expect(page.getByText('尚未查到完成紀錄。可稍後再查，或核對目前版本後重新輸入口令。',{exact:true})).toBeVisible();expect(writes).toBe(1);
  await page.getByRole('button',{name:'核對版本並重新輸入',exact:true}).click();await expect(page.getByLabel('新找回口令',{exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'重設口令',exact:true})).toBeDisabled();
  await page.unroute('**/api/v2/admin/music/*/pin');await page.getByLabel('新找回口令',{exact:true}).fill('654321');await submit(page);await expect(page.getByText(success,{exact:true})).toBeVisible();await noPinStored(page);
});
test('concurrent changes require rechecking the current version and a new confirmation',async({page,context,browser})=>{
  await login(context);await open(page);const independent=await browser.newContext({baseURL:origin});await login(independent);try{const other=await independent.newPage();await other.goto(page.url());await fill(page,'654321','第一頁的核對原因');await fill(other,'4321','另一位管理員');await submit(other);await expect(other.getByText(success,{exact:true})).toBeVisible();await submit(page);
  await expect(page.getByText('成分、口令或關聯已有變更，請核對目前資料後再重設',{exact:true})).toBeVisible();await expect(page.getByLabel('新找回口令',{exact:true})).toHaveValue('');await expect(page.getByLabel('重設原因',{exact:true})).toHaveValue('第一頁的核對原因');await expect(page.getByRole('checkbox',{name:confirmation,exact:true})).not.toBeChecked();
  await page.getByRole('button',{name:'核對目前成分版本',exact:true}).click();await page.getByLabel('新找回口令',{exact:true}).fill('654321');await submit(page);await expect(page.getByText(success,{exact:true})).toBeVisible();}finally{await independent.close();}
});
test('blocked or damaged storage prevents reset and preserves the damaged operation record',async({page,context})=>{
  await login(context);await open(page);await denyDraftWrites(page,'admin-music-pin:');let writes=0;page.on('request',request=>{if(request.url().endsWith('/pin'))writes++;});await fill(page);await submit(page);await expect(page.getByText('無法保存口令操作編號，尚未送出口令。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const other=await context.newPage();await other.goto(page.url());await revealPin(other);await other.evaluate(async()=>{const v=await(await fetch('/api/v2/session')).json(),a=await(await fetch('/api/v2/admin/session',{headers:{'X-Account-Scope':v.scope}})).json(),id=location.pathname.split('/').pop();sessionStorage.setItem('qgroup:rebuild:admin-music-pin:v1:'+v.scope+':'+a.scope+':'+id,'damaged synthetic operation');});await other.reload();await expect(other.getByLabel('新找回口令',{exact:true})).toBeDisabled();const download=other.waitForEvent('download');await other.getByRole('button',{name:'下載舊操作紀錄',exact:true}).click();expect((await download).suggestedFilename()).toBe('qgroup-pin-operation-recovery.json');expect(JSON.stringify(await durableRows(other))).not.toContain('damaged synthetic operation');await other.getByRole('button',{name:'清除已下載的舊紀錄',exact:true}).click();await expect(other.getByLabel('新找回口令',{exact:true})).toBeEnabled();expect((await durableRows(other,'versions')).map(row=>row.raw)).not.toContain('damaged synthetic operation');await other.close();
});
test('unsubmitted PINs are discarded explicitly on leaving and account revocation hides management controls',async({page,context})=>{
  await login(context);await open(page);const url=page.url();await fill(page);await page.getByRole('link',{name:'回到成分關聯',exact:true}).click();await expect(page.getByText('仍有未送出的口令或待確認操作；離開後口令不會保存。',{exact:true})).toBeVisible();await page.getByRole('button',{name:'保留操作編號並離開',exact:true}).click();await page.getByRole('link',{name:'舊成分 10001',exact:true}).click();await revealPin(page);await expect(page.getByLabel('新找回口令',{exact:true})).toHaveValue('');await expect(page.getByLabel('重設原因',{exact:true})).toHaveValue('');await noPinStored(page);
  await login(context,'bob');await page.goto(url);await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();await expect(page.getByLabel('新找回口令',{exact:true})).toHaveCount(0);
});
test.describe('imported history',()=>{
  test.use({musicHistory:true});
test('imported ownership history shares the management page, with pagination and original IDs',async({page,context})=>{
  await login(context);await open(page,'10002');await expect(page.getByText('原關聯紀錄 #151',{exact:true})).toBeVisible();await expect(page.getByText('原關聯紀錄 #100',{exact:true})).toHaveCount(0);await expect(page.getByText(/credential:synthetic-private/)).toHaveCount(0);
  await page.getByRole('button',{name:'載入更多紀錄',exact:true}).click();await expect(page.getByText('原關聯紀錄 #100',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'載入更多紀錄',exact:true})).toHaveCount(0);
});
});
