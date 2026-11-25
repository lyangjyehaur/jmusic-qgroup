import { toggleMusicTerm, expectMusicTerm } from './kimi-controls';
import { test, expect } from './fixtures';
import { damageDraft,denyDraftWrites,durableRows } from './draft-helpers';
import type { BrowserContext, Page } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
const confirmation = '確認已核對成分與目標帳號，執行此關聯變更';
async function login(context: BrowserContext, user = 'registration-admin') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function openProfile(page: Page) { await page.goto('/admin'); await page.getByRole('link', { name: '成分關聯', exact: true }).click(); await page.getByLabel('搜尋成分', { exact: true }).fill('10001'); await page.getByRole('button', { name: '搜尋', exact: true }).click(); await expect(page.getByText('共 1 份成分', { exact: true })).toBeVisible(); expect(page.url()).not.toContain('10001'); await page.getByRole('link', { name: '舊成分 10001', exact: true }).click(); await expect(page.getByLabel('目標帳號 ID', { exact: true })).toBeVisible(); }
async function preview(page: Page, target = 'bob', reason = '核對原成分及帳號') { await page.getByLabel('目標帳號 ID', { exact: true }).fill(target); await page.getByLabel('核對原因', { exact: true }).fill(reason); await page.getByRole('button', { name: '預覽關聯變更', exact: true }).click(); }
async function save(page: Page) { await page.getByRole('checkbox', { name: confirmation, exact: true }).check(); await page.getByRole('button', { name: '保存關聯變更', exact: true }).click(); }
async function done(page: Page) { await expect(page.getByText('關聯操作已完成，請核對目前成分與帳號。', { exact: true })).toBeVisible(); }
test('an administrator without music searches, previews explicit ownership and unlinks while retaining the original selections', async ({ page, context }) => {
  await login(context); await openProfile(page); let writes = 0; page.on('request', request => { if (request.url().endsWith('/link')) writes++; });
  await preview(page); await expect(page.getByText('目標帳號：小白（bob）', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存關聯變更', exact: true })).toBeDisabled(); expect(writes).toBe(0);
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/unified-admin-music-mobile.png', fullPage: true });
  await save(page); await done(page); await expect(page.getByText('目前關聯：小白（bob）', { exact: true })).toBeVisible(); await expect(page.getByText('Aimer · 程度 4', { exact: true })).toBeVisible();
  await preview(page, '', '已核對解除關聯，保留原成分'); await expect(page.getByText('目標帳號：未關聯', { exact: true })).toBeVisible(); await save(page); await done(page); await expect(page.getByText('目前關聯：未關聯', { exact: true })).toBeVisible(); await expect(page.getByText('bob → 未關聯', { exact: true })).toBeVisible(); expect(writes).toBe(2);
  await login(context, 'bob'); await page.goto('/me/music'); await expectMusicTerm(page, 'Aimer', false);
});
test('lost linking results survive reload and retry the exact original operation once', async ({ page, context }) => {
  await login(context); await openProfile(page); const keys: string[] = []; let fail = true;
  await page.route('**/api/v2/admin/music/*/link', async route => { keys.push(route.request().headers()['idempotency-key']!); const response = await route.fetch(); if (fail) { fail = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response }); });
  await preview(page); await save(page); await expect(page.getByText('尚未確認關聯結果。原操作已保留，請按「確認關聯結果」安全重試。', { exact: true })).toBeVisible(); await expect(page.getByLabel('目標帳號 ID', { exact: true })).toBeDisabled();
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await page.getByRole('button', { name: '確認關聯結果', exact: true }).click(); await done(page); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const viewer = await (await context.request.get('/api/v2/session')).json(); const history = await (await context.request.get('/api/v2/admin/music/' + page.url().split('/').pop() + '/history', { headers: { 'X-Account-Scope': viewer.scope } })).json(); expect(history.history).toHaveLength(1);
});
test('concurrent previews require a new explicit confirmation and preserve the original reason', async ({ page, context, browser }) => {
  await login(context); await openProfile(page); const url = page.url(); const independent=await browser.newContext({baseURL:origin});await login(independent);try{const other=await independent.newPage();await other.goto(url); await preview(page, 'bob', '保留這份核對原因'); await preview(other, 'alice', '另一位管理員的核對'); await save(other); await done(other);
  await save(page); await expect(page.getByText('成分、關聯或目標帳號已有變更，請重新預覽後核對', { exact: true })).toBeVisible(); await expect(page.getByLabel('核對原因', { exact: true })).toHaveValue('保留這份核對原因'); await expect(page.getByRole('button', { name: '保存關聯變更', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '預覽關聯變更', exact: true }).click(); await expect(page.getByText('原帳號：小青（alice）', { exact: true })).toBeVisible(); await expect(page.getByRole('checkbox', { name: confirmation, exact: true })).not.toBeChecked(); await save(page); await done(page);}finally{await independent.close();}
});
test('an already populated target cannot be overwritten and a normal member cannot inspect the management page', async ({ page, context }) => {
  await login(context, 'bob'); await page.goto('/me/music'); await toggleMusicTerm(page, 'YOASOBI'); await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await login(context); await openProfile(page); const url = page.url(); await preview(page); await expect(page.getByText('目標帳號已有另一份成分，請先核對並解除原關聯；不會覆蓋或合併', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存關聯變更', exact: true })).toHaveCount(0);
  page.on('dialog', dialog => void dialog.accept()); await login(context, 'bob'); await page.goto(url); await expect(page.getByLabel('管理救援憑證', { exact: true })).toBeVisible(); await expect(page.getByLabel('目標帳號 ID', { exact: true })).toHaveCount(0); await page.goto('/me/music'); await expectMusicTerm(page, 'YOASOBI', true);
});
test('unwritable and damaged management drafts block writes and can be preserved', async ({ page, context }) => {
  await login(context);await openProfile(page);await preview(page);await denyDraftWrites(page,'admin-music:');let writes=0;page.on('request',r=>{if(r.url().endsWith('/link'))writes++;});await save(page);await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto(page.url());await clean.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await damageDraft(clean,'admin-music:','damaged synthetic draft');await clean.reload();await expect(clean.getByLabel('目標帳號 ID',{exact:true})).toBeDisabled();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged synthetic draft');await clean.close();
});
test('navigation preserves an unsubmitted ownership draft without executing it', async ({ page, context }) => {
  await login(context); await openProfile(page); await preview(page, 'bob', '未保存的核對草稿'); await page.getByRole('link', { name: '回到成分關聯', exact: true }).click(); await expect(page.getByText('仍有未保存的關聯草稿或待確認操作。', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '保留草稿並離開', exact: true }).click(); await page.getByRole('link', { name: '舊成分 10001', exact: true }).click();
  await expect(page.getByLabel('核對原因', { exact: true })).toHaveValue('未保存的核對草稿');await expect(page.getByLabel('核對原因',{exact:true})).toBeDisabled();await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click(); await expect(page.getByText('目前關聯：未關聯', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存關聯變更', exact: true })).toHaveCount(0);
});
test('a former owner retains an unsaved choice but cannot edit music transferred to another account', async ({ page, context, browser }) => {
  await login(context); await openProfile(page); await preview(page); await save(page); await done(page);
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    await login(otherContext, 'bob'); const other = await otherContext.newPage(); await other.goto('/me/music'); await expectMusicTerm(other, 'Aimer', true); await toggleMusicTerm(other, 'YOASOBI');
    await preview(page, 'alice', '更正管理權'); await save(page); await done(page); await other.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(other.getByText('成分已有更新；你的選擇仍保留，請核對最新版本', { exact: true })).toBeVisible(); await expectMusicTerm(other, 'YOASOBI', true);
    const viewer = await (await context.request.get('/api/v2/session')).json(); const current = await (await context.request.get('/api/v2/admin/music/' + page.url().split('/').pop(), { headers: { 'X-Account-Scope': viewer.scope } })).json(); expect(current.selections.map((selection: { entryId: string }) => selection.entryId)).toEqual(['sub-2']);
  } finally { await otherContext.close(); }
});
