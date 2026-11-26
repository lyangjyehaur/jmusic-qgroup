import { expectControlValue } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { durableRows } from './draft-helpers';
import { rows as erasureRows } from './erasure-test-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,raw='后台發 · 帐号後臺';
async function setup(context:BrowserContext,language:string,account='alice'){
  await context.route(origin+'/**',route=>route.continue({headers:{...route.request().headers(),'accept-language':language}}));
  await context.addCookies([{name:'kanban_session',value:'fixture-'+account,url:origin,httpOnly:true,sameSite:'Lax'}]);
}
for(const language of ['zh-CN','zh-TW']){
  const simplified=language==='zh-CN';
  test(language+' real backend errors provide localized displays and canonical fields independently of request language',async({page,context})=>{
    await setup(context,language);await page.goto('/activities/unknown');
    await expect(page.getByRole('alert')).toHaveText(simplified?'找不到活动或尚未公开':'找不到活動或尚未公開');
    const response=await context.request.get('/api/v2/activities/unknown'),failure=await response.json();
    expect(response.status()).toBe(404);expect(failure).toEqual({code:'NOT_FOUND',message:'找不到活動或尚未公開',messageDisplay:{hans:'找不到活动或尚未公开',hant:'找不到活動或尚未公開'}});
    const viewer=await(await context.request.get('/api/v2/session')).json();
    await page.route('**/api/v2/me/profile',route=>route.continue({headers:{...route.request().headers(),'x-account-scope':'0'.repeat(64)}}));
    await page.goto('/me/profile');await expect(page.getByRole('alert')).toHaveText(simplified?'目前帐号已变更；请重新整理并确认帐号':'目前帳號已變更；請重新整理並確認帳號');
    expect((await(await context.request.get('/api/v2/session')).json()).scope).toBe(viewer.scope);
  });
  test(language+' an actual nickname revision conflict and malformed recovery read retain the original draft',async({page,context})=>{
    await setup(context,language);await page.goto('/me/profile');const field=page.getByLabel(simplified?'站内称呼':'站內稱呼',{exact:true});await field.fill(raw);
    const viewer=await(await context.request.get('/api/v2/session')).json(),profile=await(await context.request.get('/api/v2/me/profile',{headers:{'X-Account-Scope':viewer.scope}})).json();
    const update=await context.request.put('/api/v2/me/profile',{headers:{Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()},data:{nickname:'另一份稱呼',revision:profile.revision}});expect(update.status(),await update.text()).toBe(200);
    await page.getByRole('button',{name:simplified?'保存称呼':'保存稱呼',exact:true}).click();
    await expect(page.getByRole('status')).toContainText(simplified?'称呼已被修改；请核对目前称呼后再保存':'稱呼已被修改；請核對目前稱呼後再保存');await expectControlValue(field, raw);
    const before=(await durableRows(page)).find(row=>row.key.includes('account-profile:'))!;expect(before).toBeDefined();
    await page.route('**/api/v2/me/profile',route=>route.fulfill({status:200,json:{nickname:7}}));
    await page.getByRole('button',{name:simplified?'核对目前称呼，保留输入':'核對目前稱呼，保留輸入',exact:true}).click();
    await expect(page.getByRole('status')).toContainText(simplified?'回应资料格式不符，请先核对结果后重试。':'回應資料格式不符，請先核對結果後重試。');await expectControlValue(field, raw);
    expect((await durableRows(page)).find(row=>row.key===before.key)?.raw).toBe(before.raw);
  });
  test(language+' an unmarked older API error keeps mixed-script user content byte-for-byte',async({page,context})=>{
    await setup(context,language);await page.route('**/api/v2/me/profile',route=>route.fulfill({status:422,json:{code:'LEGACY_USER_ERROR',message:raw}}));
    await page.goto('/me/profile');await expect(page.getByRole('alert')).toHaveText(raw);
  });
  test(language+' native erasure conflict class keeps the first proof and blocks a second command',async({page,context})=>{
    await setup(context,language,'bob');await context.addInitScript(()=>Object.defineProperty(window,'BroadcastChannel',{value:undefined}));const other=await context.newPage();
    for(const tab of [page,other]){await tab.goto('/me/privacy');await tab.getByRole('radio',{name:simplified?'只关闭帐号':'只關閉帳號',exact:true}).check();await tab.getByRole('checkbox').check();}
    let writes=0;await context.route('**/api/v2/me/privacy/erase',route=>{writes++;return route.abort();});
    await page.getByRole('button',{name:simplified?'确认关闭帐号':'確認關閉帳號',exact:true}).click();await expect(page.getByRole('button',{name:simplified?'确认删除结果':'確認刪除結果',exact:true})).toBeVisible();const before=await erasureRows(page);
    await other.getByRole('button',{name:simplified?'确认关闭帐号':'確認關閉帳號',exact:true}).click();await expect(other.getByText(simplified?'其他分页已更新删除纪录，请重新读取原操作。':'其他分頁已更新刪除紀錄，請重新讀取原操作。',{exact:false})).toBeVisible();expect(writes).toBe(1);expect(await erasureRows(other)).toEqual(before);await other.close();
  });
  test(language+' a malformed accepted nickname response preserves its original key and safely checks the result',async({page,context})=>{
    await setup(context,language);await page.goto('/me/profile');const field=page.getByLabel(simplified?'站内称呼':'站內稱呼',{exact:true});await field.fill(raw);
    const keys:string[]=[],bodies:string[]=[];let corrupt=true;
    await page.route('**/api/v2/me/profile',async route=>{if(route.request().method()!=='PUT')return route.continue();keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);const response=await route.fetch();return corrupt?route.fulfill({response,json:{nickname:7}}):route.fulfill({response});});
    await page.getByRole('button',{name:simplified?'保存称呼':'保存稱呼',exact:true}).click();const recover=page.getByRole('button',{name:simplified?'确认修改结果':'確認修改結果',exact:true});await expect(recover).toBeVisible();
    const before=(await durableRows(page)).find(row=>row.key.includes('account-profile:'))!;expect(JSON.parse(before.raw).requestKey).toBe(keys[0]);await page.reload();await expectControlValue(field, raw);expect(keys).toHaveLength(1);
    expect((await durableRows(page)).find(row=>row.key===before.key)?.raw).toBe(before.raw);corrupt=false;await recover.click();await expect(page.getByRole('status')).toContainText(simplified?'已保存称呼。':'已保存稱呼。');expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
  });
  test(language+' download errors use marked backend displays and retain privacy confirmation without releasing a file',async({page,context})=>{
    await setup(context,language,'registration-admin');await page.goto('/admin/backups');const consent=page.getByRole('checkbox',{name:simplified?'确认下载并保管私人资料':'確認下載並保管私人資料',exact:true});await consent.check();let files=0;page.on('download',()=>files++);
    await page.route('**/api/v2/admin/music-export',route=>route.continue({url:origin+'/api/v2/admin/music-export?backup=20000101-000000-'+'0'.repeat(32)}));
    await page.getByRole('button',{name:simplified?'下载目前成分 JSON':'下載目前成分 JSON',exact:true}).click();await expect(page.getByRole('status')).toContainText(simplified?'目前未启用持久配对备份':'目前未啟用持久配對備份');expect(files).toBe(0);await expect(consent).toBeChecked();
  });
  test.describe(language+' scoped payment image failures',()=>{
    test.use({paymentExamples:true});
    test('keeps original metadata and applies optional display pairs in the image path',async({page,context})=>{
      await setup(context,language);await page.route('**/api/v2/activities/past/settlement/history/1/payment-codes/wechat',route=>route.fulfill({status:503,json:{code:'SYNTHETIC_IMAGE_FAILURE',message:'原始圖片錯誤',messageDisplay:{hans:'图片暂时无法读取',hant:'圖片暫時無法讀取'}}}));
      await page.goto('/activities/past/settlement/images?version=1');await expect(page.getByRole('heading',{name:simplified?'微信收款码 · 本版原碼':'微信收款碼 · 本版原碼',exact:true})).toBeVisible();
      await expect(page.getByRole('img',{name:simplified?'消费凭证 · 店家單據':'消費憑證 · 店家單據',exact:true})).toBeVisible();await expect(page.getByRole('alert').filter({hasText:simplified?'图片暂时无法读取':'圖片暫時無法讀取'})).toBeVisible();
      await expect(page.getByRole('button',{name:simplified?'重试图片':'重試圖片',exact:true})).toBeVisible();let writes=0;page.on('request',r=>{if(['POST','PUT','DELETE'].includes(r.method()))writes++;});
      await page.getByRole('button',{name:simplified?'重试图片':'重試圖片',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:simplified?'图片暂时无法读取':'圖片暫時無法讀取'})).toBeVisible();expect(writes).toBe(0);
    });
  });
}
