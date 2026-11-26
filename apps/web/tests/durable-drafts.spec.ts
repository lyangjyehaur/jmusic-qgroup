import { toggleMusicTerm } from './kimi-controls';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { denyDraftWrites, durableRows } from './draft-helpers';
test.use({ settlementExamples: true, pollExamples: true });
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
const title = (page: Page) => page.getByLabel('投票名稱', { exact: true });
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function saved(page: Page) {
  await expect(page.getByText('正在保存本機原稿…', { exact: true })).toHaveCount(0);
}
async function definition(page: Page, name: string) {
  await title(page).fill(name);
  await page.getByLabel('預計地點', { exact: true }).fill('台北');
  await page.getByLabel('候選日期 1', { exact: true }).fill('2099-12-20');
  await page.getByLabel('候選日期 2', { exact: true }).fill('2099-12-23');
  await page.getByLabel('投票截止（含時區）', { exact: true }).fill('2099-12-19T18:00:00+08:00');
  await saved(page);
}
test('restores incomplete drafts from a closed tab only after review and isolates accounts in the same browser', async ({ page, context }) => {
  await login(context); await page.goto('/time-polls/new');
  await title(page).fill('關頁前的原稿'); await saved(page); await page.close();
  const fresh = await context.newPage(); await fresh.goto(origin + '/time-polls/new');
  await expect(title(fresh)).toHaveValue('關頁前的原稿'); await expect(title(fresh)).toBeDisabled();
  await fresh.getByRole('button', { name: '恢復本機原稿', exact: true }).click();
  await expect(title(fresh)).toBeEnabled();
  await login(context, 'bob'); await fresh.reload(); await expect(title(fresh)).toHaveValue('');
  await title(fresh).fill('另一個帳號'); await saved(fresh);
  await login(context); fresh.on('dialog', d => void d.accept()); await fresh.reload();
  await expect(title(fresh)).toHaveValue('關頁前的原稿');
  expect((await durableRows(fresh)).filter(row => row.key.includes('poll-create:'))).toHaveLength(2);
});
test('keeps receipt image bytes and base revisions across a real browser profile restart without reusing a preview', async ({ playwright }, info) => {
  const directory = await mkdtemp(join(tmpdir(), 'qgroup-drafts-'));
  const launch = () => playwright.chromium.launchPersistentContext(directory, { headless: true, channel: info.project.use.channel, serviceWorkers: 'block', baseURL: origin });
  let context: BrowserContext | undefined;
  try {
    context = await launch(); await login(context); let page = await context.newPage();
    await page.goto('/activities/listen/settlement/edit');
    await page.getByLabel('費用金額', { exact: true }).fill('7.25');
    const raw = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20;
      canvas.getContext('2d')!.fillRect(0, 0, 20, 20); return canvas.toDataURL().split(',')[1]!;
    });
    await page.getByLabel('消費憑證（最多三項附圖）', { exact: true }).setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(raw, 'base64') });
    const image = page.getByRole('img', { name: '新消費憑證 · 消費', exact: true });
    await expect(image).toBeVisible(); const src = await image.getAttribute('src');
    await page.getByRole('checkbox', { name: /已逐人核對名單/ }).check();
    await page.getByRole('button', { name: '預覽逐人結算', exact: true }).click();
    await expect(page.getByRole('region', { name: '逐人結算預覽', exact: true })).toBeVisible(); await saved(page);
    const before = (await durableRows(page))[0]!.raw;
    await context.close(); context = await launch(); await login(context); page = await context.newPage();
    let writes = 0; page.on('request', r => { if (r.method() === 'POST') writes++; });
    await page.goto('/activities/listen/settlement/edit');
    await expect(page.getByLabel('費用金額', { exact: true })).toHaveValue('7.25');
    await expect(page.getByRole('img', { name: '新消費憑證 · 消費', exact: true })).toHaveAttribute('src', src!);
    expect((await durableRows(page))[0]!.raw).toBe(before);
    await expect(page.getByRole('region', { name: '逐人結算預覽', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '恢復本機原稿', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: /已核對本版金額/ })).toHaveCount(0); expect(writes).toBe(0);
  } finally { await context?.close(); await rm(directory, { recursive: true, force: true }); }
});
test('retains both cross-tab versions and blocks stale mutation before it reaches the server', async ({ page, context }) => {
  await login(context); await page.goto('/time-polls/new');
  const other = await context.newPage(); await other.goto(origin + '/time-polls/new'); await expect(title(other)).toBeEnabled();
  await definition(page, '第一個分頁');
  let writes = 0; other.on('request', r => { if (r.method() === 'POST') writes++; });
  await title(other).fill('第二個分頁的內容');
  await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible();
  await expect(title(other)).toBeDisabled(); expect(writes).toBe(0);
  expect((await durableRows(other, 'versions')).map(row => JSON.parse(row.raw).value.title)).toContain('第二個分頁的內容');
  await other.getByRole('button', { name: '讀取已保存版本', exact: true }).click();
  await expect(title(other)).toHaveValue('第一個分頁');
  await other.getByText('草稿版本（1）', { exact: true }).click();
  await other.getByRole('button', { name: '載入此原稿（保留目前版本）', exact: true }).click();
  await expect(title(other)).toHaveValue('第二個分頁的內容'); await expect(title(other)).toBeEnabled();
  expect((await durableRows(other, 'versions')).map(row => JSON.parse(row.raw).value.title)).toContain('第一個分頁');
  await page.getByRole('button', { name: '建立時間投票', exact: true }).click();
  await expect(page.getByText(/其他分頁已更新原稿/)).toBeVisible();
  expect((await durableRows(page, 'versions')).some(row => JSON.parse(row.raw).pending?.input.title === '第一個分頁')).toBe(true);
  const inbox = await context.newPage(); await inbox.goto(origin + '/inbox');
  await expect(inbox.getByRole('link', { name: '建立時間投票（保全版本）', exact: true })).toBeVisible();
  await other.setViewportSize({width:360,height:800});
  expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await other.screenshot({path:'test-results/unified-draft-conflict-mobile.png',fullPage:true});
});
test('migrates exact session payloads only after IDB commits and never imports privacy or device credentials', async ({ page, context }) => {
  await login(context); await page.goto('/time-polls/new'); await title(page).fill('遷移原稿'); await saved(page);
  const row = (await durableRows(page))[0]!;
  // Start from a genuine older session draft, including its original UUID/body.
  const pending = { dirty: true, pending: { key: crypto.randomUUID(), input: {
    title: '遷移原操作', category: '约K', location: '台北', description: '', timezone: 'Asia/Taipei', capacity: 0, minimum_participants: 0,
    fee_policy: '', deadline: '2099-12-19T18:00:00+08:00', bot_enabled: true, visibility: 'public', time_mode: 'date', options: [{ date: '2099-12-20' }, { date: '2099-12-23' }],
  } } };
  await page.evaluate(async ({key,raw}) => {
    sessionStorage.setItem(key,raw); sessionStorage.setItem('qgroup:rebuild:device-link','DEVICE_SECRET');
    sessionStorage.setItem('qgroup:rebuild:privacy-pending:v1','RECEIPT_SECRET');
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('qgroup-reviewed-drafts-v1',1);r.onsuccess=()=>resolve(r.result);});
    await new Promise<void>(resolve=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').clear();tx.oncomplete=()=>resolve();});db.close();
  }, {key:row.key,raw:JSON.stringify(pending)});
  await page.addInitScript(() => {
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key){const r=original.call(this,value,key);if(this.name==='drafts'){const tx=this.transaction;r.addEventListener('success',()=>tx.abort());}return r;};
  });
  page.on('dialog', d => void d.accept()); await page.reload();
  await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。')).toBeVisible();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),row.key)).toBe(JSON.stringify(pending));
  // A fresh tab does not inherit injected IDB failures. Copy the untouched migration source.
  const clean=await context.newPage(); await clean.goto(origin + '/time-polls');
  await clean.evaluate(({key,raw})=>sessionStorage.setItem(key,raw),{key:row.key,raw:JSON.stringify(pending)});
  await clean.goto(origin + '/time-polls/new');
  await expect(clean.getByRole('button',{name:'確認原投票建立結果',exact:true})).toBeVisible();
  expect(await clean.evaluate(key=>sessionStorage.getItem(key),row.key)).toBeNull();
  expect((await durableRows(clean)).map(r=>r.raw)).toContain(JSON.stringify(pending));
  expect(JSON.stringify(await durableRows(clean))).not.toMatch(/DEVICE_SECRET|RECEIPT_SECRET/);
});
for (const kind of ['logout','music-erasure'] as const) test('fences a stale tab after '+kind+' even when BroadcastChannel is unavailable', async ({page,context})=>{
  await login(context); page.on('dialog',d=>void d.accept());
  await page.goto('/me/music'); await toggleMusicTerm(page, 'YOASOBI');
  await page.getByRole('button',{name:'保存我的成分',exact:true}).click(); await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
  await page.goto('/time-polls/new'); await title(page).fill('保留活動草稿'); await saved(page);
  const stale=await context.newPage(); await stale.addInitScript(()=>{Object.defineProperty(window,'BroadcastChannel',{value:undefined});});
  await stale.goto(origin+'/me/music/entries/new');
  const name=stale.getByLabel('詞條名稱（最多 24 字）',{exact:true}); await name.fill('刪除前原稿'); await saved(stale);
  // Make a conflicting version as well; cleanup must cover archives.
  const scope=(await (await context.request.get('/api/v2/session')).json()).scope;
  await page.goto('/me/music/entries/new'); await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await page.getByLabel('詞條名稱（最多 24 字）',{exact:true}).fill('新版本'); await saved(page);
  await name.fill('舊頁衝突'); await expect(stale.getByText(/其他分頁已更新原稿/)).toBeVisible();
  await stale.getByRole('button',{name:'讀取已保存版本',exact:true}).click(); await stale.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  if(kind==='logout'){
    await page.goto('/me/accounts'); await page.getByRole('button',{name:'登出此裝置',exact:true}).click();
    await expect(page.getByRole('heading',{name:'尚未登入',exact:true})).toBeVisible();
  }else{
    await page.goto('/me/privacy'); await page.getByRole('radio',{name:'只刪除成分',exact:true}).check();
    await page.getByRole('checkbox',{name:'我已確認範圍，瞭解此操作無法復原',exact:true}).check();
    await page.getByRole('button',{name:'確認刪除成分',exact:true}).click();
    await expect(page.getByRole('heading',{name:'成分已刪除',exact:true})).toBeVisible();
  }
  await name.fill('不得復活');
  await expect(stale.getByText('此原稿已因登出或資料刪除失效，請重新載入頁面。')).toBeVisible();
  const rows=await durableRows(page),versions=await durableRows(page,'versions');
  expect(rows.filter(r=>r.key.includes('music:entries:'))).toEqual([]);expect(versions).toEqual([]);
  if(kind==='music-erasure')expect(rows.some(r=>r.key.includes('poll-create:')&&r.key.includes(scope))).toBe(true);
  else expect(rows).toEqual([]);
});
test('finds an uncertain operation in a new tab inbox and retries the exact UUID/body only on request', async ({page,context})=>{
  await login(context); await page.goto('/time-polls/new'); await definition(page,'關頁後查回');
  const keys:string[]=[],bodies:string[]=[];
  await context.route('**/api/v2/time-polls',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);
    const response=await route.fetch();await route.fulfill(keys.length===1?{response,body:'{'}:{response});
  });
  await page.getByRole('button',{name:'建立時間投票',exact:true}).click();
  await expect(page.getByText('尚未確認操作結果。原操作已保留，請確認原操作結果。',{exact:true})).toBeVisible();
  await page.close();const fresh=await context.newPage();await fresh.goto(origin+'/inbox');
  await fresh.getByRole('link',{name:'建立時間投票',exact:true}).click();
  await expect(fresh.getByRole('button',{name:'確認原投票建立結果',exact:true})).toBeVisible();expect(keys).toHaveLength(1);
  await fresh.getByRole('button',{name:'確認原投票建立結果',exact:true}).click();
  await expect(fresh.getByRole('heading',{name:'關頁後查回',exact:true})).toBeVisible();
  expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0]);
});
test('keeps the editor open when retaining the draft on navigation cannot commit',async({page,context})=>{
  await login(context);await page.goto('/time-polls/new');await title(page).fill('已保存原稿');await saved(page);
  await denyDraftWrites(page,'poll-create:');await title(page).fill('尚未保存的新內容');
  await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();
  await page.locator('header').getByRole('link',{name:/^收件匣/}).click();
  await page.getByRole('button',{name:'保留原稿並離開',exact:true}).click();
  await saved(page);await expect(page).toHaveURL('/time-polls/new');await expect(title(page)).toHaveValue('尚未保存的新內容');
  expect(JSON.parse((await durableRows(page))[0]!.raw).value.title).toBe('已保存原稿');
});
for(const kind of ['logout','admin-logout','music-erasure'] as const)test('retries local cleanup after '+kind+' without repeating the committed server action',async({page,context})=>{
  await login(context,kind==='admin-logout'?'registration-admin':'alice');await page.goto('/me/music');await toggleMusicTerm(page, 'YOASOBI');
  await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
  await page.goto('/me/music/entries/new');await page.getByLabel('詞條名稱（最多 24 字）',{exact:true}).fill('待清除原稿');await saved(page);
  page.on('dialog',d=>void d.accept());await page.goto(kind==='logout'?'/me/accounts':kind==='admin-logout'?'/admin':'/me/privacy');
  const beforeCleanup=await durableRows(page);expect(beforeCleanup.some(row=>row.key.includes('music:entries:'))).toBe(true);expect(beforeCleanup.some(row=>row.key.includes('music:v1:'))).toBe(true);
  await page.evaluate(kind=>{
    if(kind!=='music-erasure'){
      const original=IDBObjectStore.prototype.clear;
      IDBObjectStore.prototype.clear=function(){const r=original.call(this);if(this.name==='drafts'){const tx=this.transaction;r.addEventListener('success',()=>{IDBObjectStore.prototype.clear=original;tx.abort();});}return r;};
    }else{
      const original=IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete=function(key){const r=original.call(this,key);if(this.name==='drafts'){const tx=this.transaction;r.addEventListener('success',()=>{IDBObjectStore.prototype.delete=original;tx.abort();});}return r;};
    }
  },kind);
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith(kind==='logout'?'/auth/logout':kind==='admin-logout'?'/admin/logout':'/privacy/erase'))writes++;});
  if(kind==='logout')await page.getByRole('button',{name:'登出此裝置',exact:true}).click();
  else if(kind==='admin-logout'){
    await page.getByRole('checkbox',{name:'確認登出此裝置的全部帳號與管理授權，其他裝置不受影響',exact:true}).check();
    await page.getByRole('button',{name:'登出管理',exact:true}).click();
  }else{
    await page.getByRole('checkbox',{name:'我已確認範圍，瞭解此操作無法復原',exact:true}).check();
    await page.getByRole('button',{name:'確認刪除成分',exact:true}).click();
    await expect(page.getByRole('heading',{name:'成分已刪除',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'完成',exact:true})).toBeDisabled();
  }
  await expect(page.getByText(kind!=='music-erasure'?'此裝置已登出，但本機原稿清除失敗。請重試清除。':'伺服器刪除已完成，但本機原稿清除失敗。請重試清除。',{exact:kind!=='admin-logout'})).toBeVisible();
  expect(await durableRows(page)).toEqual(beforeCleanup);
  await page.getByRole('button',{name:'重試清除本機原稿',exact:true}).click();
  if(kind==='logout'){await expect(page.getByRole('button',{name:'重試清除本機原稿',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'尚未登入',exact:true})).toBeVisible();}
  else if(kind==='music-erasure') await expect(page.getByRole('button',{name:'完成',exact:true})).toBeEnabled();
  else await expect(page.getByRole('button',{name:'重試清除本機原稿',exact:true})).toHaveCount(0);
  expect(await durableRows(page)).toEqual([]);expect(writes).toBe(1);
});
