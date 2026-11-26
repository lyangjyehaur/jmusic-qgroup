import { chooseOption, expectControlValue } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { durableRows, denyDraftWrites, damageDraft } from './draft-helpers';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`; const rescueKey = 'synthetic-admin-rescue-' + 'x'.repeat(32);
async function login(context: BrowserContext, user = 'registration-admin') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function metadata(page: Page, note: string, qq = '') { await page.getByLabel('內部備註', { exact: true }).fill(note); await page.getByLabel('人工 QQ', { exact: true }).fill(qq); await page.getByRole('button', { name: '保存備註', exact: true }).click(); }
test('member administrators search exact QQ status and keep private metadata outside the member profile', async ({ page, context }) => {
  await login(context); await page.goto('/admin'); await page.getByRole('link', { name: '使用者管理', exact: true }).click();
  await page.getByLabel('搜尋使用者', { exact: true }).fill('原 QQ'); await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByText('共 1 個帳號', { exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: '舊帳號', exact: true })).toBeVisible();
  await chooseOption(page,'QQ／UnionID 狀態','bound'); await expect(page.getByText('沒有符合條件的帳號。', { exact: true })).toBeVisible();
  await chooseOption(page,'QQ／UnionID 狀態','missing'); await expect(page.getByRole('link', { name: '舊帳號', exact: true })).toBeVisible();
  await page.goto('/admin/users/bob'); await page.setViewportSize({ width: 360, height: 800 });
  await metadata(page, '人工核對 <script>\n第二行備註', '123456789'); await expect(page.getByText('備註已保存，請核對目前資料。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/unified-admin-user-mobile.png', fullPage: true });
  await page.goto('/admin/users?search=123456789'); await expect(page.getByRole('link', { name: '小白', exact: true })).toBeVisible(); await expect(page.locator('script').filter({ hasText: '第二行備註' })).toHaveCount(0);
  await login(context, 'bob'); await page.goto('/me/accounts'); await expect(page.getByText('第二行備註', { exact: false })).toHaveCount(0); await expect(page.getByText('123456789', { exact: false })).toHaveCount(0);
});
test('granting and revoking a role changes every request while self-revocation stays blocked', async ({ page, context, browser }) => {
  await login(context); await page.goto('/admin/users/bob');
  await page.getByRole('checkbox', { name: '確認授予此帳號的管理權', exact: true }).check(); await page.getByRole('button', { name: '授予管理權', exact: true }).click();
  await expect(page.getByText('管理權限：管理員 · 版本 1', { exact: true })).toBeVisible(); await expect(page.getByText('一般會員 → 管理員', { exact: false })).toBeVisible();
  const otherContext = await browser.newContext({ baseURL: origin }); await login(otherContext, 'bob');
  try {
    const other = await otherContext.newPage(); await other.goto('/admin/users/bob');
    await expect(other.getByText('不能撤銷目前登入帳號的管理權，請由其他管理員操作。', { exact: true })).toBeVisible();
    await expect(other.getByRole('button', { name: '撤銷管理權', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: '確認撤銷此帳號的管理權', exact: true }).check(); await page.getByRole('button', { name: '撤銷管理權', exact: true }).click();
    await expect(page.getByText('管理權限：一般會員 · 版本 2', { exact: true })).toBeVisible(); await other.reload();
    await expect(other.getByLabel('管理救援憑證', { exact: true })).toBeVisible(); await expect(other.getByLabel('內部備註', { exact: true })).toHaveCount(0);
  } finally { await otherContext.close(); }
});
test('unreadable metadata responses retain the exact operation through reload and retry once', async ({ page, context }) => {
  await login(context); await page.goto('/admin/users/bob'); const keys: string[] = []; let fail = true;
  await page.route('**/api/v2/admin/users/bob/metadata', async route => { keys.push(route.request().headers()['idempotency-key']!); const response = await route.fetch(); if (fail) { fail = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response }); });
  await metadata(page, '保留原操作的內部備註'); await expect(page.getByText('尚未確認修改結果。', { exact: false })).toBeVisible(); await expect(page.getByLabel('內部備註', { exact: true })).toBeDisabled();
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await page.getByRole('button', { name: '確認修改結果', exact: true }).click();
  await expect(page.getByText('備註已保存，請核對目前資料。', { exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const session = await (await context.request.get('/api/v2/session')).json(); const user = await (await context.request.get('/api/v2/admin/users/bob', { headers: { 'X-Account-Scope': session.scope } })).json(); expect(user.metadataRevision).toBe(1);
});
test('conflicting admin metadata preserves input until an explicit rebase', async ({ page, context, browser }) => {
  await login(context); const otherContext=await browser.newContext({baseURL:origin});await login(otherContext);const other=await otherContext.newPage();await other.goto('/admin/users/bob');await page.goto('/admin/users/bob');
  await page.getByLabel('內部備註', { exact: true }).fill('保留我的核對說明'); await metadata(other, '另一個管理頁的說明'); await expect(other.getByText('備註已保存，請核對目前資料。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存備註', exact: true }).click(); await expect(page.getByText('備註或人工 QQ 已被修改，請核對目前版本', { exact: true })).toBeVisible();
  await expectControlValue(page.getByLabel('內部備註', { exact: true }), '保留我的核對說明'); await page.getByRole('button', { name: '核對目前資料，保留輸入', exact: true }).click();
  await page.getByRole('button', { name: '保存備註', exact: true }).click(); await expect(page.getByText('備註已保存，請核對目前資料。', { exact: true })).toBeVisible(); await otherContext.close();
});
test('storage failures block writes and damaged private admin drafts can be preserved', async ({ page, context }) => {
  await login(context);await page.goto('/admin/users/bob');await denyDraftWrites(page,'admin-user:');
  let writes=0;page.on('request',request=>{if(request.method()==='POST')writes++;});
  await metadata(page,'不可遺失的備註');await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/admin/users/bob');await clean.getByLabel('內部備註',{exact:true}).fill('保全前原稿');await expect(clean.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
  await damageDraft(clean,'admin-user:','damaged synthetic admin draft');clean.on('dialog',dialog=>void dialog.accept());await clean.reload();
  await expect(clean.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();
  expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged synthetic admin draft');await clean.close();
});
test('a lost rescue login response is checked without saving or resending the credential, and rescue logout retains member login', async ({ page, context }) => {
  await login(context, 'bob'); let logins = 0;
  await page.route('**/api/v2/admin/login', async route => { logins++; const response = await route.fetch(); await route.fulfill({ response, body: '{' }); });
  await page.goto('/admin'); await page.getByLabel('管理救援憑證', { exact: true }).fill(rescueKey); await page.getByRole('button', { name: '使用救援憑證登入', exact: true }).click();
  await expect(page.getByText('尚未確認登入結果，請先重新確認管理狀態。', { exact: true })).toBeVisible(); await expectControlValue(page.getByLabel('管理救援憑證', { exact: true }), '');
  expect(await page.evaluate(key => JSON.stringify({ ...sessionStorage, ...localStorage }).includes(key), rescueKey)).toBe(false);
  await page.getByRole('button', { name: '重新確認管理狀態', exact: true }).click(); await expect(page.getByText('管理授權：救援憑證（1 小時）', { exact: true })).toBeVisible(); expect(logins).toBe(1);
  await page.getByRole('link', { name: '註冊設定', exact: true }).click(); await expect(page.getByText('名稱註冊：已關閉', { exact: true })).toBeVisible();
  await page.goto('/admin'); await page.getByRole('checkbox', { name: '確認登出救援管理，保留目前會員登入', exact: true }).check(); await page.getByRole('button', { name: '登出管理', exact: true }).click();
  await expect(page.getByLabel('管理救援憑證', { exact: true })).toBeVisible(); const viewer = await (await context.request.get('/api/v2/session')).json(); expect(viewer.authenticated).toBe(true); expect(viewer.nickname).toBe('小白');
});
test('account administrator logout clears this device and other tabs private admin drafts', async ({ page, context }) => {
  await login(context); const other = await context.newPage(); await other.goto('/admin/users/bob'); await other.getByLabel('內部備註', { exact: true }).fill('此分頁的管理草稿');
  await page.goto('/admin'); await page.getByRole('checkbox', { name: '確認登出此裝置的全部帳號與管理授權，其他裝置不受影響', exact: true }).check(); await page.getByRole('button', { name: '登出管理', exact: true }).click();
  await expect(page.getByLabel('管理救援憑證', { exact: true })).toBeVisible(); await expect(other.getByLabel('管理救援憑證', { exact: true })).toBeVisible();
  await expect(other.getByLabel('內部備註', { exact: true })).toHaveCount(0); await expect.poll(async()=>(await durableRows(other)).filter(row=>row.key.startsWith('qgroup:rebuild:admin-user:'))).toEqual([]);expect(await durableRows(other,'versions')).toEqual([]); expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false); await other.close();
});
for (const mode of ['account', 'credential'] as const) test(`an unreadable ${mode} administrator logout is checked against the current session without a second logout`, async ({ page, context }) => {
  await login(context, mode === 'account' ? 'registration-admin' : 'bob'); await page.goto('/admin');
  if (mode === 'credential') { await page.getByLabel('管理救援憑證', { exact: true }).fill(rescueKey); await page.getByRole('button', { name: '使用救援憑證登入', exact: true }).click(); }
  await expect(page.getByRole('link', { name: '使用者管理', exact: true })).toBeVisible(); let writes = 0;
  await page.route('**/api/v2/admin/logout', async route => { writes++; const response = await route.fetch(); await route.fulfill({ response, body: '{' }); });
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '登出管理', exact: true }).click(); await expect(page.getByText('尚未確認登出結果，請重新確認管理狀態。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '登出管理', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '重新確認管理狀態', exact: true }).click(); await expect(page.getByLabel('管理救援憑證', { exact: true })).toBeVisible();
  expect(writes).toBe(1); expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(mode === 'credential');
});
