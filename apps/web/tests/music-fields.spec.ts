import { chooseOption, toggleMusicTerm, expectMusicTerm } from './kimi-controls';
import { test, expect } from './fixtures';
import { durableRows, denyDraftWrites, damageDraft } from './draft-helpers';
import type { BrowserContext, Page } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context: BrowserContext, user = 'alice') { await context.addCookies([{ name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax' }]); }
async function seed(context: BrowserContext, user = 'alice') {
  await login(context,user); const viewer = await (await context.request.get('/api/v2/session')).json();
  const headers = { Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID() };
  const profile = await (await context.request.put('/api/v2/me/music',{headers,data:{profileId:null,musicEpoch:0,revision:0,selections:[{entryId:'sub-2',level:4}]}})).json();
  return {viewer,profile,headers};
}
const name = (page: Page) => page.getByLabel('成分稱呼',{exact:true});
const note = (page: Page) => page.getByLabel('私人留言',{exact:true});
const save = (page: Page) => page.getByRole('button',{name:'保存成分資料',exact:true}).click();
test('music fields share one flow with selections and member cards while the account nickname stays independent', async ({page,context}) => {
  const {profile} = await seed(context); await page.goto('/me/music'); await page.getByRole('tab',{name:'成分資料',exact:true}).click();
  await name(page).fill('我的成分稱呼'); await note(page).fill('私人留言內容'); await chooseOption(page,'性別','custom'); await page.getByLabel('自訂性別',{exact:true}).fill('非二元'); await page.getByLabel('在成分卡公開性別',{exact:true}).check(); await save(page);
  await expect(page.getByText('成分資料已保存。',{exact:true})).toBeVisible(); await expect(page.locator('.viewer')).toHaveText('小青');
  await page.setViewportSize({width:360,height:800}); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({path:'test-results/unified-fields-mobile.png',fullPage:true});
  await page.getByRole('link',{name:'回到我的成分',exact:true}).click(); await expectMusicTerm(page,'Aimer',true);
  await page.goto('/people/'+profile.id); await expect(page.getByRole('heading',{name:'我的成分稱呼',exact:true})).toBeVisible(); await expect(page.locator('.profile-summary .inline-definitions')).toContainText('非二元'); await expect(page.getByText('私人留言內容',{exact:true})).toHaveCount(0);
  await page.goto('/me/music/details'); await expect(note(page)).toHaveValue('私人留言內容'); await note(page).fill(''); await save(page); await expect(page.getByText('成分資料已保存。',{exact:true})).toBeVisible();
});
test('an unknown successful write keeps its exact operation through reload and fetches newer fields after retry', async ({page,context}) => {
  const {headers,profile} = await seed(context); const keys:string[]=[];const bodies:unknown[]=[];let first=true;
  await page.route('**/api/v2/me/music/fields',async route => { if(route.request().method()!=='PUT')return route.continue();keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postDataJSON());const response=await route.fetch();if(first){first=false;await route.fulfill({response,body:'{'});}else await route.fulfill({response}); });
  await page.goto('/me/music/details'); await name(page).fill('原操作稱呼'); await save(page); await expect(page.getByText('尚未確認成分資料保存結果。原操作已保留，請按「確認成分資料結果」安全重試。',{exact:true})).toBeVisible(); await expect(name(page)).toBeDisabled();
  const changed=await context.request.put('/api/v2/me/music/fields',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{profileId:profile.id,musicEpoch:0,revision:1,name:'後來的稱呼',note:'後來留言',gender:'',genderPublic:false}});expect(changed.status()).toBe(200);
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await page.getByRole('button',{name:'確認成分資料結果',exact:true}).click();
  await expect(page.getByText('原操作已保存，資料已再次變更；請核對目前內容。',{exact:true})).toBeVisible();await expect(name(page)).toHaveValue('後來的稱呼');await expect(note(page)).toHaveValue('後來留言');expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toEqual(bodies[1]);
});
test('conflicts preserve inputs until an explicit read, including custom gender and private notes',async({page,context,browser})=>{
  await seed(context);const remote=await browser.newContext({baseURL:origin});await login(remote);
  try{
    await page.goto('/me/music/details');await name(page).fill('本機稱呼');await note(page).fill('本機留言');await chooseOption(page,'性別','custom');await page.getByLabel('自訂性別',{exact:true}).fill('本機性別');
    const other=await remote.newPage();await other.goto('/me/music/details');await name(other).fill('遠端稱呼');await save(other);await expect(other.getByText('成分資料已保存。',{exact:true})).toBeVisible();
    await save(page);await expect(page.getByText('成分資料已變更；輸入仍保留，請核對目前資料後再保存',{exact:true})).toBeVisible();await expect(name(page)).toHaveValue('本機稱呼');await expect(note(page)).toHaveValue('本機留言');
    await page.getByRole('button',{name:'核對目前成分資料，保留輸入',exact:true}).click();await expect(page.getByText('已取得目前資料；輸入仍保留，請核對後再保存。',{exact:true})).toBeVisible();await expect(page.getByLabel('目前已保存的成分資料').getByText('遠端稱呼',{exact:true})).toBeVisible();await expect(page.getByLabel('自訂性別',{exact:true})).toHaveValue('本機性別');await save(page);await expect(page.getByText('成分資料已保存。',{exact:true})).toBeVisible();
  }finally{await remote.close();}
});
test('account switches reject the old field draft and restore only that account’s input',async({page,context})=>{
  await seed(context,'bob');await seed(context);await page.goto('/me/music/details');await note(page).fill('小青私人原稿');await login(context,'bob');await save(page);await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號',{exact:true})).toBeVisible();
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(name(page)).toHaveValue('小白');await expect(note(page)).toHaveValue('');await login(context);await page.reload();await expect(note(page)).toHaveValue('小青私人原稿');
});
test('storage failure blocks writes and damaged drafts must be preserved before editing',async({page,context})=>{
  await seed(context);let writes=0;page.on('request',request=>{if(request.method()==='PUT')writes++;});
  await page.goto('/me/music/details');await denyDraftWrites(page,'music:fields:');await note(page).fill('尚未送出');await save(page);await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/me/music/details');await note(clean).fill('損壞前原稿');await expect(clean.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await damageDraft(clean,'music:fields:','damaged private draft');clean.on('dialog',dialog=>void dialog.accept());await clean.reload();await expect(note(clean)).toBeDisabled();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged private draft');await expect(note(clean)).toBeEnabled();await clean.close();
});
test('field edits preserve unfinished selections and require their current revision before saving',async({page,context})=>{
  await seed(context);await page.goto('/me/music');await toggleMusicTerm(page,'YOASOBI');await page.getByRole('tab',{name:'成分資料',exact:true}).click();await page.getByRole('button',{name:'保留原稿並離開',exact:true}).click();await note(page).fill('只改成分資料');await save(page);await expect(page.getByText('成分資料已保存。',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'回到我的成分',exact:true}).click();await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await expectMusicTerm(page,'YOASOBI',true);await expect(page.getByRole('button',{name:'保存我的成分',exact:true})).toBeDisabled();await expect(page.getByText('成分版本不同，尚未保存',{exact:true})).toBeVisible();await page.getByRole('button',{name:'核對最新版本，保留我的選擇',exact:true}).click();await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
});
test('music erasure removes private field drafts in another tab and prevents resurrection',async({page,context})=>{
  await seed(context);await page.goto('/me/music/details');await note(page).fill('應刪除的私人原稿');const privacy=await context.newPage();await privacy.goto('/me/privacy');await privacy.getByRole('radio',{name:'只刪除成分',exact:true}).check();await privacy.getByRole('checkbox',{name:'我已確認範圍，瞭解此操作無法復原',exact:true}).check();await privacy.getByRole('button',{name:'確認刪除成分',exact:true}).click();
  await expect(note(page)).toHaveCount(0);await expect(page.getByText('請先保存成分，再編輯成分資料。',{exact:true})).toBeVisible();expect((await durableRows(page)).filter(row=>row.key.includes('qgroup:rebuild:music:'))).toEqual([]);expect(await durableRows(page,'versions')).toEqual([]);await privacy.close();
});
