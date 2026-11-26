import { openAdminTool, toggleMusicTerm } from './kimi-controls';
import { test,expect } from './fixtures';
import { damageDraft,denyDraftWrites,durableRows } from './draft-helpers';
import type { BrowserContext,Page } from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
test.use({adminCatalog:true});
async function login(context:BrowserContext,user='registration-admin'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function refresh(page:Page){await page.evaluate(()=>{const channel=new BroadcastChannel('qgroup:rebuild:session');channel.postMessage('refresh');channel.close();});}
const listing=(page:Page)=>page.getByRole('region',{name:'管理詞庫清單',exact:true});
const review=(page:Page)=>page.getByRole('region',{name:'詞條操作核對',exact:true});
async function confirm(page:Page){await page.getByRole('checkbox',{name:'我已核對詞條及影響範圍',exact:true}).check();await page.getByRole('button',{name:'確認詞條變更',exact:true}).click();}
async function merge(page:Page){await listing(page).getByRole('button',{name:'合併 YOASOBI',exact:true}).click();await page.getByLabel('合併目標',{exact:true}).selectOption('sub-1');await confirm(page);}
test('only administrators can read the catalog; profile-free administrators and rescue login share the native manager',async({page,context})=>{
  let reads=0;page.on('request',request=>{if(request.url().includes('/api/v2/admin/music-entries'))reads++;});
  await page.goto('/admin/music-entries');await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();await expect(listing(page)).toHaveCount(0);
  await login(context,'alice');await refresh(page);await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();expect(reads).toBe(0);
  await login(context);await refresh(page);await expect(listing(page).getByRole('button',{name:'編輯 YOASOBI',exact:true})).toBeVisible();
  await expect(listing(page).locator('.account-list > li')).toHaveCount(20);await page.getByRole('button',{name:'下一頁',exact:true}).click();await expect(listing(page).locator('.account-list > li')).toHaveCount(2);
  await page.getByLabel('搜尋管理詞條',{exact:true}).fill('YOASOBI');await expect(page).not.toHaveURL(/page=/);await expect(listing(page).locator('.account-list > li')).toHaveCount(1);
  const viewer=await (await context.request.get('/api/v2/session')).json();expect(await (await context.request.get('/api/v2/me/music',{headers:{'X-Account-Scope':viewer.scope}})).json()).toBeNull();
  await page.goto('/admin');await page.getByRole('checkbox').check();await page.getByRole('button',{name:'登出管理',exact:true}).click();
  await page.getByLabel('管理救援憑證',{exact:true}).fill('synthetic-admin-rescue-'+'x'.repeat(32));await page.getByRole('button',{name:'使用救援憑證登入',exact:true}).click();
  await openAdminTool(page,'音樂詞庫管理');await expect(listing(page).getByRole('button',{name:'編輯 YOASOBI',exact:true})).toBeVisible();
});
test('creation, normalized search and editing retain category, type and metadata without a member quota',async({page,context})=>{
  await login(context);await page.goto('/admin/music-entries');await page.getByRole('button',{name:'建立詞條',exact:true}).click();
  await page.getByLabel('詞條名稱',{exact:true}).fill('  管理自建音樂  ');await page.getByLabel('詞條類型',{exact:true}).selectOption('main');await page.getByLabel('詞條分類',{exact:true}).selectOption('领域');await confirm(page);
  await expect(page.getByText('已建立詞條。',{exact:true})).toBeVisible();await page.getByLabel('搜尋管理詞條',{exact:true}).fill('管理自建');await expect(listing(page).getByRole('heading',{name:'詞條 · 1',exact:true})).toBeVisible();
  await listing(page).getByRole('button',{name:'編輯 管理自建音樂',exact:true}).click();await page.getByLabel('詞條名稱',{exact:true}).fill('管理更正音樂');await page.getByLabel('詞條類型',{exact:true}).selectOption('sub');await page.getByLabel('詞條分類',{exact:true}).selectOption('歌手');await confirm(page);
  await expect(page.getByText('已保存詞條。',{exact:true})).toBeVisible();await page.getByLabel('搜尋管理詞條',{exact:true}).fill('管理更正');await expect(listing(page).getByRole('heading',{name:'管理更正音樂',exact:true})).toBeVisible();
  const catalog=await (await context.request.get('/api/v2/music/catalog')).json();expect(catalog.entries.find((e:any)=>e.name==='管理更正音樂')).toMatchObject({kind:'sub',category:'歌手',creatorName:'管理員',count:0});
});
test('merge reviews both targets on mobile, refreshes shared music data and refuses to overwrite an unsaved member draft',async({page,context})=>{
  await login(context);const editor=await context.newPage();await editor.goto('/me/music');
  for(const name of ['J-POP','YOASOBI','ヨルシカ'])await toggleMusicTerm(editor,name);
  await editor.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(editor.getByText('已保存。',{exact:true})).toBeVisible();await editor.getByRole('button',{name:'移除J-POP',exact:true}).click();
  await page.setViewportSize({width:360,height:800});await page.goto('/admin/music-entries');await listing(page).getByRole('button',{name:'合併 YOASOBI',exact:true}).click();await page.getByLabel('合併目標',{exact:true}).selectOption('sub-1');
  await expect(review(page)).toContainText('來源：YOASOBI');await expect(review(page)).toContainText('目標：ヨルシカ');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/unified-admin-catalog-merge-mobile.png',fullPage:true});await confirm(page);
  await expect(page.getByText('已合併詞條，更新 4 份成分。',{exact:true})).toBeVisible();await expect(listing(page).getByRole('heading',{name:'YOASOBI',exact:true})).toHaveCount(0);
  await expect(editor.locator('.selection-groups').getByText('已移除的詞條',{exact:true})).toBeVisible();await expect(editor.getByRole('button',{name:'移除J-POP',exact:true})).toHaveCount(0);
  await editor.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(editor.getByText('成分已有更新；你的選擇仍保留，請核對最新版本',{exact:true})).toBeVisible();
  await editor.getByRole('button',{name:'核對最新版本，保留我的選擇',exact:true}).click();await editor.getByRole('button',{name:'移除已移除的詞條',exact:true}).click();await editor.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(editor.getByText('已保存。',{exact:true})).toBeVisible();
  const session=await (await context.request.get('/api/v2/session')).json(),profile=await (await context.request.get('/api/v2/me/music',{headers:{'X-Account-Scope':session.scope}})).json();expect(profile.selections).toEqual([{entryId:'sub-1',level:3}]);await editor.close();
});
test('unknown merge results retain the exact UUID and body across reload even when the source has disappeared',async({page,context})=>{
  await login(context);let fail=true;const operations:{key:string;body:string|null}[]=[];
  await page.route('**/api/v2/admin/music-entries',async route=>{if(route.request().method()!=='POST')return route.continue();operations.push({key:route.request().headers()['idempotency-key']!,body:route.request().postData()});const response=await route.fetch();if(fail){fail=false;await route.fulfill({response,body:'{'});}else await route.fulfill({response});});
  await page.goto('/admin/music-entries');await merge(page);await expect(page.getByText('尚未確認詞庫操作結果。',{exact:false})).toBeVisible();await expect(page.getByLabel('合併目標',{exact:true})).toBeDisabled();
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(review(page)).toContainText('來源詞條已不存在');await page.getByRole('button',{name:'確認原操作結果',exact:true}).click();
  await expect(page.getByText('已合併詞條，更新 3 份成分。',{exact:true})).toBeVisible();expect(operations).toHaveLength(2);expect(operations[0]).toEqual(operations[1]);await expect(review(page)).toHaveCount(0);
});
test('deleting a selected entry requires confirmation and removes every current reference',async({page,context})=>{
  await login(context);await page.goto('/admin/music-entries');await listing(page).getByRole('button',{name:'刪除 YOASOBI',exact:true}).click();await expect(review(page)).toContainText('3 人選用 · 3 份建立紀錄');await expect(page.getByRole('button',{name:'確認詞條變更',exact:true})).toBeDisabled();
  await confirm(page);await expect(page.getByText('已刪除詞條，更新 3 份成分。',{exact:true})).toBeVisible();await expect(listing(page).getByRole('heading',{name:'YOASOBI',exact:true})).toHaveCount(0);
  await login(context,'alice');await page.goto('/me/music');await expect(page.getByRole('button',{name:'移除YOASOBI',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'移除ヨルシカ',exact:true})).toBeVisible();
});
test('competing edits preserve input and require an explicit fresh review instead of silently replacing a revision',async({page,context,browser})=>{
  await login(context);await page.goto('/admin/music-entries');await listing(page).getByRole('button',{name:'編輯 YOASOBI',exact:true}).click();await page.getByLabel('詞條名稱',{exact:true}).fill('保留我的更正');
  const independent=await browser.newContext({baseURL:origin});await login(independent);const other=await independent.newPage();await other.goto('/admin/music-entries');await listing(other).getByRole('button',{name:'編輯 YOASOBI',exact:true}).click();await other.getByLabel('詞條名稱',{exact:true}).fill('另一管理者更正');await confirm(other);await expect(other.getByText('已保存詞條。',{exact:true})).toBeVisible();
  await refresh(page);await expect(page.getByText('詞庫或會員資料已更新，請重新核對影響範圍。',{exact:true})).toBeVisible();await expect(page.getByLabel('詞條名稱',{exact:true})).toHaveValue('保留我的更正');await expect(page.getByRole('button',{name:'確認詞條變更',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'核對最新版，保留輸入',exact:true}).click();await expect(page.getByLabel('詞條名稱',{exact:true})).toHaveValue('保留我的更正');await confirm(page);await expect(page.getByText('已保存詞條。',{exact:true})).toBeVisible();await independent.close();
});
test('damaged drafts are preserved, navigation protects work and storage failure prevents all catalog mutations',async({page,context})=>{
  await login(context);await page.goto('/admin/music-entries');await page.getByRole('button',{name:'建立詞條',exact:true}).click();await page.getByLabel('詞條名稱',{exact:true}).fill('原管理稿');
  await page.getByRole('link',{name:'管理後臺',exact:true}).click();await expect(page.getByText('尚未提交的修改',{exact:false})).toBeVisible();await page.getByRole('button',{name:'保留原稿並離開',exact:true}).click();await openAdminTool(page,'音樂詞庫管理');await expect(page.getByLabel('詞條名稱',{exact:true})).toHaveValue('原管理稿');await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await damageDraft(page,'admin-catalog:','damaged admin catalog draft');page.on('dialog',dialog=>void dialog.accept());await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(page,'versions')).map(row=>row.raw)).toContain('damaged admin catalog draft');
  await page.getByRole('button',{name:'建立詞條',exact:true}).click();await page.getByLabel('詞條名稱',{exact:true}).fill('儲存失敗');await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await denyDraftWrites(page,'admin-catalog:');let writes=0;page.on('request',request=>{if(request.method()==='POST')writes++;});await confirm(page);await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
});
test('failed reads offer a retry and late private catalog data cannot restore revoked authority',async({page,context})=>{
  await login(context);let fail=true;await page.route('**/api/v2/admin/music-entries',route=>fail?route.fulfill({status:503,json:{code:'FAIL',message:'詞庫暫時無法讀取'}}):route.continue());
  await page.goto('/admin/music-entries');await expect(page.getByRole('alert')).toContainText('詞庫暫時無法讀取');await expect(listing(page)).toHaveCount(0);fail=false;await page.getByRole('button',{name:'重新讀取',exact:true}).click();await expect(listing(page)).toBeVisible();
  await page.unroute('**/api/v2/admin/music-entries');let arrived!:()=>void,release!:()=>void;const captured=new Promise<void>(resolve=>{arrived=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v2/admin/music-entries',async route=>{const response=await route.fetch();arrived();await pending;await route.fulfill({response}).catch(()=>{});});
  await page.reload();await captured;await login(context,'alice');await refresh(page);await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();release();await expect(listing(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'合併 YOASOBI',exact:true})).toHaveCount(0);
});
