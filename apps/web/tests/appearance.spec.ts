import { chooseOption, expectOption, expectControlValue } from './kimi-controls';
import { test,expect } from './fixtures';
import { damageDraft,denyDraftWrites,durableRows } from './draft-helpers';
import type { BrowserContext,Page } from '@playwright/test';
import sharp from 'sharp';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context:BrowserContext,user='registration-admin'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
const review=(page:Page)=>page.getByRole('region',{name:'外觀設定核對',exact:true});
async function confirm(page:Page){await page.getByRole('checkbox',{name:'我已核對外觀設定變更',exact:true}).check();await page.getByRole('button',{name:'確認壁紙變更',exact:true}).click();}
async function select(page:Page,name:string,color='#32859e'){
  await page.getByRole('button',{name:'上傳壁紙',exact:true}).click();await page.getByLabel('壁紙名稱（選填）',{exact:true}).fill(name);
  const buffer=await sharp({create:{width:20,height:10,channels:3,background:color}}).png().toBuffer();await page.getByLabel('壁紙圖片',{exact:true}).setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer});await expect(page.getByAltText('待上傳壁紙',{exact:true})).toBeVisible();
}
async function upload(page:Page,name:string){await select(page,name);await confirm(page);await expect(page.getByText('外觀設定已保存。',{exact:true})).toBeVisible();}
test('theme follows system, explicit preferences span routes and tabs, and legacy wallpaper off survives reload',async({page,context})=>{
  await page.emulateMedia({colorScheme:'dark'});await page.addInitScript(()=>{if(!localStorage.getItem('qgroup:appearance:v1')){localStorage.setItem('jpm.theme','dark');localStorage.setItem('jpm.wall','off');}});
  await page.goto('/me/appearance');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(page.getByLabel('顯示壁紙',{exact:true})).not.toBeChecked();await expect(page.locator('.wallpaper-layer')).toHaveCount(0);
  const other=await context.newPage();await other.goto('/activities');await chooseOption(page,'主題','light');await expect(other.locator('html')).toHaveAttribute('data-theme','light');
  await page.getByRole('link',{name:'音樂',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.goto('/me/appearance');await expect(page.getByLabel('顯示壁紙',{exact:true})).not.toBeChecked();
  await chooseOption(page,'主題','system');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');await other.close();
});
test('theme changes preserve both unfinished music choices and activity input without submitting either',async({page,context})=>{
  await login(context,'alice');const writes:string[]=[];
  context.on('request',request=>{if(['POST','PUT','PATCH','DELETE'].includes(request.method())&&new URL(request.url()).pathname.startsWith('/api/v2/'))writes.push(request.url());});
  await page.goto('/me/music');await page.getByLabel('尋找喜歡的音樂',{exact:true}).fill('mijin');await page.getByRole('button',{name:/米津玄師/,exact:false}).click();await chooseOption(page,'米津玄師喜歡程度','4');
  const activity=await context.newPage();await activity.goto('/activities/new');await activity.getByLabel('活動名稱',{exact:true}).fill('仍未送出的活動');await activity.getByLabel('注意事項',{exact:true}).fill('保留原輸入與音樂選擇');
  const preferences=await context.newPage();await preferences.goto('/me/appearance');
  for(const theme of ['dark','light']){
    await chooseOption(preferences,'主題',theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await expect(activity.locator('html')).toHaveAttribute('data-theme',theme);
    await expectOption(page,'米津玄師喜歡程度','4');await expectControlValue(activity.getByLabel('活動名稱',{exact:true}), '仍未送出的活動');await expectControlValue(activity.getByLabel('注意事項',{exact:true}), '保留原輸入與音樂選擇');
  }
  const musicBefore=(await durableRows(page)).filter(row=>row.key.includes('music:v1:'));const activityBefore=(await durableRows(activity)).filter(row=>row.key.includes('activity-draft:'));expect(musicBefore).toHaveLength(1);expect(activityBefore).toHaveLength(1);
  page.on('dialog',dialog=>void dialog.accept());activity.on('dialog',dialog=>void dialog.accept());await page.reload();await activity.reload();await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await activity.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await expectOption(page,'米津玄師喜歡程度','4');await expectControlValue(activity.getByLabel('活動名稱',{exact:true}), '仍未送出的活動');await expectControlValue(activity.getByLabel('注意事項',{exact:true}), '保留原輸入與音樂選擇');
  expect((await durableRows(page)).filter(row=>row.key.includes('music:v1:'))).toEqual(musicBefore);expect((await durableRows(activity)).filter(row=>row.key.includes('activity-draft:'))).toEqual(activityBefore);expect(writes).toEqual([]);await preferences.close();await activity.close();
});
test('profile-free administrator manages original images, order, enabled status, interval and confirmed deletion on mobile',async({page,context})=>{
  await login(context);await page.setViewportSize({width:360,height:800});await page.goto('/admin');await page.getByRole('tab',{name:'活動與內容',exact:true}).click();await page.getByRole('link',{name:'網站外觀',exact:true}).click();await upload(page,'海');await upload(page,'山');
  await page.getByRole('button',{name:'上移 山',exact:true}).click();await expect(review(page)).toContainText('上移壁紙');await confirm(page);await expect(page.locator('.wallpaper-list h2').first()).toHaveText('山');
  await page.getByRole('button',{name:'停用 海',exact:true}).click();await confirm(page);await expect(page.getByRole('button',{name:'啟用 海',exact:true})).toBeVisible();expect((await(await context.request.get('/api/v2/appearance')).json()).items.map((x:any)=>x.name)).toEqual(['山']);
  await page.getByRole('button',{name:'設定輪播間隔',exact:true}).click();await page.getByLabel('輪播間隔（秒）',{exact:true}).fill('8');await confirm(page);await expect(page.getByText('輪播間隔：8 秒 · 1 張啟用',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'刪除 山',exact:true}).click();await expect(review(page)).toContainText('無法復原');await expect(page.getByRole('button',{name:'確認壁紙變更',exact:true})).toBeDisabled();await confirm(page);await expect(page.getByRole('button',{name:'刪除 山',exact:true})).toHaveCount(0);
  await page.goto('/me/appearance');await chooseOption(page,'主題','dark');await page.goto('/admin/appearance');await expect(page.getByRole('button',{name:'上傳壁紙',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-appearance-dark-mobile.png',fullPage:true});
});
test('lost upload response survives reload with one image copy and replays the same UUID and body exactly once',async({page,context})=>{
  await login(context);let lose=true;const writes:{key:string|undefined;body:string|null}[]=[];
  await page.route('**/api/v2/admin/appearance',async route=>{if(route.request().method()!=='POST')return route.continue();writes.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});if(!lose)return route.continue();lose=false;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.goto('/admin/appearance');await select(page,'原圖');await confirm(page);await expect(page.getByRole('button',{name:'確認原操作結果',exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();
  await expect(page.getByAltText('待上傳壁紙',{exact:true})).toBeVisible();await expect(page.getByLabel('壁紙名稱（選填）',{exact:true})).toBeDisabled();await page.getByRole('button',{name:'確認原操作結果',exact:true}).click();await expect(page.getByText('外觀設定已保存。',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect((await(await context.request.get('/api/v2/appearance')).json()).items).toHaveLength(1);
});
test('concurrent settings keep the original input and require a fresh review before resubmitting',async({page,context,browser})=>{
  await login(context);await page.goto('/admin/appearance');await page.getByRole('button',{name:'設定輪播間隔',exact:true}).click();await page.getByLabel('輪播間隔（秒）',{exact:true}).fill('11');
  const independent=await browser.newContext({baseURL:origin});await login(independent);const other=await independent.newPage();await other.goto('/admin/appearance');await other.getByRole('button',{name:'設定輪播間隔',exact:true}).click();await other.getByLabel('輪播間隔（秒）',{exact:true}).fill('12');await confirm(other);await expect(other.getByText('外觀設定已保存。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'核對最新版，保留輸入',exact:true}).click();await expectControlValue(page.getByLabel('輪播間隔（秒）',{exact:true}), '11');await expect(page.getByRole('button',{name:'確認壁紙變更',exact:true})).toBeDisabled();await confirm(page);await expect(page.getByText('輪播間隔：11 秒 · 0 張啟用',{exact:true})).toBeVisible();await independent.close();
});
test('storage failure blocks writes, corrupt drafts are preserved, and unfinished work protects navigation',async({page,context})=>{
  await login(context);await page.goto('/admin/appearance');await page.getByRole('button',{name:'設定輪播間隔',exact:true}).click();await page.getByLabel('輪播間隔（秒）',{exact:true}).fill('31');await denyDraftWrites(page,'admin-appearance:');let writes=0;page.on('request',request=>{if(request.url().endsWith('/admin/appearance')&&request.method()==='POST')writes++;});
  await confirm(page);await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);await page.getByRole('link',{name:'管理後臺',exact:true}).click();await expect(page.getByText('尚未提交的修改',{exact:false})).toBeVisible();await page.getByRole('button',{name:'繼續編輯',exact:true}).click();
  page.on('dialog',dialog=>void dialog.accept());await page.reload();await damageDraft(page,'admin-appearance:','{damaged');await page.reload();await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(page,'versions')).map(row=>row.raw)).toEqual(['{damaged']);
});
test('failed local preferences remain usable without overwriting a damaged original',async({page})=>{
  await page.goto('/me/appearance');await page.evaluate(()=>localStorage.setItem('qgroup:appearance:v1','{damaged'));await page.reload();await expect(page.getByRole('alert')).toContainText('無法讀取外觀偏好');await chooseOption(page,'主題','dark');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');expect(await page.evaluate(()=>localStorage.getItem('qgroup:appearance:v1'))).toBe('{damaged');await page.getByRole('button',{name:'保全原偏好後保存',exact:true}).click();expect(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('qgroup:appearance:v1:recovery:')).map(k=>localStorage.getItem(k)))).toEqual(['{damaged']);
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('synthetic storage unavailable');};});await chooseOption(page,'主題','light');await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.getByRole('alert')).toContainText('無法保存外觀偏好');
});
test('wallpapers decode before display, follow enabled preference and stop rotating for reduced motion',async({page,context})=>{
  await login(context);await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/admin/appearance');await upload(page,'一');await upload(page,'二');await page.getByRole('link',{name:'我的',exact:true}).click();await page.getByRole('tab',{name:'設定',exact:true}).click();await page.getByRole('link',{name:'外觀',exact:true}).click();await expect(page.locator('.wallpaper-frame.current')).toHaveCount(1);const id=await page.locator('.wallpaper-frame.current').getAttribute('data-wallpaper-id');await page.clock.install();await page.clock.fastForward(26000);await expect(page.locator('.wallpaper-frame.current')).toHaveAttribute('data-wallpaper-id',id!);await page.getByLabel('顯示壁紙',{exact:true}).uncheck();await expect(page.locator('.wallpaper-layer')).toHaveCount(0);await page.getByLabel('顯示壁紙',{exact:true}).check();await expect(page.locator('.wallpaper-frame.current')).toHaveCount(1);await chooseOption(page,'主題','light');await page.screenshot({path:'test-results/unified-appearance-light-desktop.png',fullPage:true});
});
test('rescue access works without a music profile and late data cannot restore revoked management',async({page,context})=>{
  await page.goto('/admin/appearance');await page.getByLabel('管理救援憑證',{exact:true}).fill('synthetic-admin-rescue-'+'x'.repeat(32));await page.getByRole('button',{name:'使用救援憑證登入',exact:true}).click();await upload(page,'救援壁紙');expect((await(await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
  await context.clearCookies();await login(context);let arrive!:()=>void,release!:()=>void;const captured=new Promise<void>(resolve=>{arrive=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});await page.route('**/api/v2/admin/appearance',async route=>{const response=await route.fetch();arrive();await pending;await route.fulfill({response}).catch(()=>{});});await page.reload();await captured;
  await login(context,'alice');await page.evaluate(()=>{const c=new BroadcastChannel('qgroup:rebuild:session');c.postMessage('refresh');c.close();});await expect(page.getByLabel('管理救援憑證',{exact:true})).toBeVisible();release();await expect(page.locator('.wallpaper-list')).toHaveCount(0);
});
test('normal rotation avoids immediate repeats, retains two decoded frames and pauses while the page is hidden',async({page,context})=>{
  await page.clock.install();await login(context);await page.goto('/admin/appearance');await upload(page,'甲');await upload(page,'乙');await page.getByRole('button',{name:'設定輪播間隔',exact:true}).click();await page.getByLabel('輪播間隔（秒）',{exact:true}).fill('8');await confirm(page);await expect(page.getByText('外觀設定已保存。',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'我的',exact:true}).click();await page.getByRole('tab',{name:'設定',exact:true}).click();await page.getByRole('link',{name:'外觀',exact:true}).click();await expect(page.locator('.wallpaper-frame.current')).toHaveCount(1);const first=await page.locator('.wallpaper-frame.current').getAttribute('data-wallpaper-id');await page.clock.fastForward(8100);await expect(page.locator('.wallpaper-frame.current')).not.toHaveAttribute('data-wallpaper-id',first!);await expect(page.locator('.wallpaper-frame')).toHaveCount(2);
  const second=await page.locator('.wallpaper-frame.current').getAttribute('data-wallpaper-id');await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await page.clock.fastForward(25000);await expect(page.locator('.wallpaper-frame.current')).toHaveAttribute('data-wallpaper-id',second!);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});await page.clock.fastForward(8100);await expect(page.locator('.wallpaper-frame.current')).not.toHaveAttribute('data-wallpaper-id',second!);await expect(page.locator('.wallpaper-frame')).toHaveCount(2);
});
test('a corrupt image falls back to a decodable image even with reduced motion, while administrators see the read failure',async({page,context})=>{
  await login(context);await page.goto('/admin/appearance');await upload(page,'壞圖');await upload(page,'好圖');const manifest=await(await context.request.get('/api/v2/appearance')).json(),bad=manifest.items[0],good=manifest.items[1];
  await page.route('**'+bad.url,route=>route.fulfill({status:200,contentType:'image/png',body:'synthetic corrupt image'}));await page.addInitScript(()=>{Math.random=()=>0;});await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/me/appearance');await expect(page.locator('.wallpaper-frame.current')).toHaveAttribute('data-wallpaper-id',good.id);
  await page.goto('/admin/appearance');await expect(page.getByText('原圖無法顯示，請重新上傳；原始檔仍保留。',{exact:true})).toBeVisible();
});
test.describe('dark activity and music theme',()=>{
  test.use({rosterExamples:true});
  test('dark preference keeps activity dialogs and music controls readable across domains',async({page,context})=>{
  await login(context,'bob');const viewer=await(await context.request.get('/api/v2/session')).json();expect((await context.request.put('/api/v2/me/music',{headers:{Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()},data:{profileId:null,musicEpoch:0,revision:0,selections:[{entryId:'sub-2',level:4}]}})).status()).toBe(200);
  await login(context,'alice');await page.goto('/me/appearance');await chooseOption(page,'主題','dark');await page.getByRole('link',{name:'活動',exact:true}).click();await page.getByRole('link',{name:'週末一起聽日系音樂',exact:true}).click();await page.getByRole('button',{name:'查看 小白 的成分',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();expect(await dialog.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}))).toEqual(await page.locator('html').evaluate(el=>{const probe=document.createElement('span');probe.style.backgroundColor='var(--app-surface)';probe.style.color='var(--app-ink)';el.append(probe);const style=getComputedStyle(probe),result={bg:style.backgroundColor,color:style.color};probe.remove();return result;}));await page.keyboard.press('Escape');await page.getByRole('link',{name:'音樂',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.getByRole('searchbox',{name:'搜尋音樂詞條',exact:true}).fill('Aimer');await expect(page.getByRole('link',{name:'Aimer',exact:true})).toBeVisible();expect(await page.getByRole('combobox',{name:'詞庫類型',exact:true}).evaluate(el=>getComputedStyle(el).color)).toBe(await page.locator('html').evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--app-ink)';el.append(probe);const result=getComputedStyle(probe).color;probe.remove();return result;}));
});
});
test('a completed upload with failed local receipt cleanup retains its exact operation until storage recovers',async({page,context})=>{
  await login(context);await page.goto('/admin/appearance');await select(page,'已保存原圖');await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'&&String(value.key).includes('admin-appearance')&&typeof value.raw==='string'&&JSON.parse(value.raw).value.command==='none')r.addEventListener('success',()=>this.transaction.abort());return r;};
    window.addEventListener('test:restore-storage',()=>{IDBObjectStore.prototype.put=original;},{once:true});
  });
  const writes:{key:string|undefined;body:string|null}[]=[];page.on('request',request=>{if(request.url().endsWith('/admin/appearance')&&request.method()==='POST')writes.push({key:request.headers()['idempotency-key'],body:request.postData()});});
  await confirm(page);await expect(page.getByText('操作已送出，但無法保存確認狀態；請保留原操作並核對結果。',{exact:true})).toBeVisible();const pending=JSON.parse((await durableRows(page)).find(row=>row.key.includes('admin-appearance:'))!.raw);expect(pending.value.data).toBe('');expect(pending.pending.input.data.length).toBeGreaterThan(0);expect((await(await context.request.get('/api/v2/appearance')).json()).items).toHaveLength(1);
  await page.evaluate(()=>window.dispatchEvent(new Event('test:restore-storage')));await page.getByRole('button',{name:'重試保存原稿',exact:true}).click();await page.getByRole('button',{name:'確認原操作結果',exact:true}).click();await expect(page.getByText('外觀設定已保存。',{exact:true})).toBeVisible();expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect((await(await context.request.get('/api/v2/appearance')).json()).items).toHaveLength(1);
});

test('administrator site title uses Yahha input, reverting edits clears dirty state and an uncertain save replays once',async({page,context})=>{
  await login(context);await page.setViewportSize({width:320,height:925});await page.goto('/admin/appearance');
  await page.getByRole('button',{name:'修改網站名稱',exact:true}).click();const field=page.getByRole('textbox',{name:'網站名稱',exact:true});await expect(field).toHaveValue('群聚');
  await field.fill('誤觸');await field.fill('群聚');await expect(page.getByRole('button',{name:'保存網站名稱',exact:true})).toBeDisabled();
  const title='重慶日音同好・週末音樂聚會';await field.fill(title);await page.getByRole('checkbox',{name:'我已核對外觀設定變更',exact:true}).check();
  let lost=false;const keys:string[]=[];await page.route('**/api/v2/admin/appearance',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']!);const response=await route.fetch();if(!lost){lost=true;return route.abort();}return route.fulfill({response});});
  await page.getByRole('button',{name:'保存網站名稱',exact:true}).click();await expect(page.getByRole('button',{name:'確認原操作結果',exact:true})).toBeEnabled();await page.getByRole('button',{name:'確認原操作結果',exact:true}).click();await expect(review(page)).toHaveCount(0);
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);await page.goto('/activities');await expect(page).toHaveTitle(title);await expect(page.locator('.mobile-brand')).toHaveText(title);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator('.mobile-brand').evaluate(el=>el.getBoundingClientRect().right<=document.querySelector('.topbar-actions')!.getBoundingClientRect().left)).toBe(true);
});
