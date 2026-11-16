import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const baseURL = 'http://127.0.0.1:5082';
async function loginFixture(context: BrowserContext, account = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + account, url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
}
async function fakeQQ(page: Page, code: string) {
  await page.unroute('**/__test/qq?*');
  await page.route('**/__test/qq?*', async route => {
    const url = new URL(route.request().url()); url.searchParams.set('code', code); await route.continue({ url: url.href });
  });
}
async function authorize(page: Page, button = '前往 QQ 授權綁定') {
  await expect(page.getByRole('button', { name: button, exact: true })).toBeVisible();
  const consent = page.getByRole('checkbox'); if (await consent.count()) await consent.check();
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('button', { name: button === '前往 QQ 登入' ? '確認登入' : '確認綁定', exact: true }).click();
}
test('changing a nickname updates other tabs while preserving the account, music and QQ nickname', async ({ page, context }) => {
  await fakeQQ(page, 'avatar-source'); let avatarRequests = 0;
  await page.route('https://q1.qlogo.cn/**', async route => { avatarRequests++; await route.abort(); });
  await page.goto('/login?returnTo=%2Fme%2Faccounts'); await authorize(page, '前往 QQ 登入');
  await expect(page.getByRole('img', { name: 'QQ 頭像無法載入', exact: true })).toBeVisible();
  await page.goto('/me/music'); await page.getByRole('button', { name: 'Aimer', exact: true }).click();
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  const before = await (await context.request.get('/api/v2/session')).json();
  const other = await context.newPage(); await other.route('https://q1.qlogo.cn/**', route => route.abort()); await other.goto('/me/accounts');
  await page.goto('/me/profile'); await page.getByLabel('站內稱呼', { exact: true }).fill('新的站內稱呼');
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-nickname-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '保存稱呼', exact: true }).click(); await expect(page.getByText('已保存稱呼。', { exact: true })).toBeVisible();
  await expect(other.getByRole('heading', { name: '新的站內稱呼', exact: true })).toBeVisible();
  await expect(other.getByText('已綁定 QQ：測試帳號 avatar-source', { exact: true })).toBeVisible();
  const after = await (await context.request.get('/api/v2/session')).json(); expect(after.scope).toBe(before.scope); expect(after.qq).toEqual(before.qq);
  await page.goto('/me/music'); await expect(page.getByRole('button', { name: 'Aimer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(avatarRequests).toBeGreaterThan(0); await other.close();
});
test('an unreadable nickname response survives reload and retries the same operation exactly once', async ({ page, context }) => {
  await loginFixture(context); await page.goto('/me/profile');
  const keys: string[] = []; const payloads: unknown[] = []; let fail = true;
  await page.route('**/api/v2/me/profile', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!); payloads.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (fail) { fail = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response });
  });
  await page.getByLabel('站內稱呼', { exact: true }).fill('保留操作編號'); await page.getByRole('button', { name: '保存稱呼', exact: true }).click();
  await expect(page.getByText('尚未確認修改結果。操作編號已保留，請按「確認修改結果」安全重試。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('站內稱呼', { exact: true })).toBeDisabled();
  page.on('dialog', dialog => void dialog.accept()); await page.reload();
  await page.getByRole('button', { name: '確認修改結果', exact: true }).click(); await expect(page.getByText('已保存稱呼。', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(payloads[0]).toEqual(payloads[1]);
  const viewer = await (await context.request.get('/api/v2/session')).json();
  const history = await (await context.request.get('/api/v2/me/account-history', { headers: { 'X-Account-Scope': viewer.scope } })).json();
  expect(history.history.filter((row: { action: string }) => row.action === 'nickname_changed')).toHaveLength(1);
});
test('conflicting nickname edits preserve input and require an explicit read before overwriting', async ({ page, context, browser }) => {
  await loginFixture(context); const remote = await browser.newContext({ baseURL }); await loginFixture(remote);
  try {
    await page.goto('/me/profile'); await page.getByLabel('站內稱呼', { exact: true }).fill('保留我的輸入');
    const other = await remote.newPage(); await other.goto('/me/profile'); await other.getByLabel('站內稱呼', { exact: true }).fill('另一裝置稱呼');
    await other.getByRole('button', { name: '保存稱呼', exact: true }).click(); await expect(other.getByText('已保存稱呼。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存稱呼', exact: true }).click(); await expect(page.getByText('稱呼已被修改；請核對目前稱呼後再保存', { exact: true })).toBeVisible();
    await expect(page.getByLabel('站內稱呼', { exact: true })).toHaveValue('保留我的輸入');
    await page.getByRole('button', { name: '核對目前稱呼，保留輸入', exact: true }).click(); await expect(page.getByText('目前稱呼：另一裝置稱呼', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存稱呼', exact: true }).click(); await expect(page.getByText('已保存稱呼。', { exact: true })).toBeVisible();
  } finally { await remote.close(); }
});
test('blocked browser storage prevents nickname writes and damaged drafts remain recoverable', async ({ page, context }) => {
  await loginFixture(context);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('qgroup:rebuild:account-profile:')) throw new Error('synthetic storage failure'); return original.call(this, key, value); };
  });
  let writes = 0; page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/me/profile')) writes++; });
  await page.goto('/me/profile'); await page.getByLabel('站內稱呼', { exact: true }).fill('尚未送出'); await page.getByRole('button', { name: '保存稱呼', exact: true }).click();
  await expect(page.getByText('無法保存操作編號，尚未送出修改。', { exact: true })).toBeVisible(); expect(writes).toBe(0);
  const clean = await context.newPage(); await clean.goto('/activities');
  const viewer = await (await context.request.get('/api/v2/session')).json(); const key = 'qgroup:rebuild:account-profile:v1:' + viewer.scope;
  await clean.evaluate(key => sessionStorage.setItem(key, 'damaged nickname draft'), key); await clean.goto('/me/profile');
  await expect(clean.getByText('此分頁的稱呼草稿無法讀取，原始內容已保留。請先保全原稿。', { exact: true })).toBeVisible();
  await clean.getByRole('button', { name: '保全原稿，從目前稱呼開始', exact: true }).click();
  expect(await clean.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('account-profile:') && key.includes(':recovery:')).map(key => sessionStorage.getItem(key)))).toContain('damaged nickname draft');
  await expect(clean.getByLabel('站內稱呼', { exact: true })).toBeEnabled(); await clean.close();
});
test('reauth reminders defer during editing and invitations, respect the existing 24 hour scope key and never force logout', async ({ page, context }) => {
  await loginFixture(context, 'auth-owner');
  await page.goto('/activities?invite=synthetic#roster'); await expect(page.getByRole('complementary', { name: 'QQ 資料更新提醒' })).toHaveCount(0);
  await page.goto('/me/profile'); await page.getByLabel('站內稱呼', { exact: true }).fill('還在編輯');
  await expect(page.getByRole('complementary', { name: 'QQ 資料更新提醒' })).toHaveCount(0);
  await page.getByRole('link', { name: '活動', exact: true }).click(); await expect(page.getByRole('heading', { name: '還有未保存的稱呼' })).toBeVisible();
  await page.getByRole('button', { name: '保留草稿並離開', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'QQ 資料更新提醒' })).toBeVisible();
  await page.getByRole('button', { name: '稍後處理', exact: true }).click(); await page.reload();
  await expect(page.getByRole('heading', { name: '活動', exact: true })).toBeVisible(); await expect(page.getByRole('complementary', { name: 'QQ 資料更新提醒' })).toHaveCount(0);
  const viewer = await (await context.request.get('/api/v2/session')).json(); expect(viewer.authenticated).toBe(true);
  await page.evaluate(scope => localStorage.setItem('kanban-qq-reauth-v1:' + scope, String(Date.now() - 24 * 3600000 - 1)), viewer.scope); await page.reload();
  await expect(page.getByRole('complementary', { name: 'QQ 資料更新提醒' })).toBeVisible();
  await page.getByRole('complementary', { name: 'QQ 資料更新提醒' }).getByRole('link', { name: '重新授權原 QQ', exact: true }).click();
  await expect(page.getByRole('heading', { name: '綁定 QQ', exact: true })).toBeVisible();
  expect((await (await context.request.get('/api/v2/session')).json()).scope).toBe(viewer.scope);
});
test('missing UnionID reauthorization keeps the original account and reports the actual result before a later successful retry', async ({ page, context }) => {
  await loginFixture(context, 'auth-owner'); const before = await (await context.request.get('/api/v2/session')).json();
  await fakeQQ(page, 'auth-original-no-union');
  await page.goto('/login?mode=bind&returnTo=%2Fme%2Faccounts'); await authorize(page);
  await expect(page.getByText('尚未取得 UnionID；原帳號已保留，可在帳號頁重新授權。', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '舊帳號', exact: true })).toBeVisible();
  const missing = await (await context.request.get('/api/v2/session')).json(); expect(missing.scope).toBe(before.scope); expect(missing.qq.needsReauth).toBe(true);
  await page.goto('/activities'); await expect(page.getByRole('complementary', { name: 'QQ 資料更新提醒' })).toHaveCount(0);
  await fakeQQ(page, 'auth-original'); await page.goto('/login?mode=bind&returnTo=%2Fme%2Faccounts'); await authorize(page);
  await expect(page.getByText('QQ 資料已更新；bot 個人功能仍依實際開放狀態。', { exact: true })).toBeVisible();
  const complete = await (await context.request.get('/api/v2/session')).json(); expect(complete.scope).toBe(before.scope); expect(complete.nickname).toBe('舊帳號'); expect(complete.qq.needsReauth).toBe(false);
});
test('nickname drafts stay with their account across switching and are cleared on device logout', async ({ page, context }) => {
  await loginFixture(context); await page.goto('/me/profile'); await page.getByLabel('站內稱呼', { exact: true }).fill('尚未保存的原帳號稱呼');
  await page.getByRole('link', { name: '回到帳號', exact: true }).click(); await page.getByRole('button', { name: '保留草稿並離開', exact: true }).click();
  await fakeQQ(page, 'profile-other'); await page.goto('/login?returnTo=%2Fme%2Faccounts'); await authorize(page, '前往 QQ 登入');
  await page.goto('/me/profile'); await expect(page.getByLabel('站內稱呼', { exact: true })).toHaveValue('測試帳號 profile-other');
  await page.getByRole('link', { name: '回到帳號', exact: true }).click(); await page.getByRole('button', { name: '切換至 小青', exact: true }).click();
  await page.goto('/me/profile'); await expect(page.getByLabel('站內稱呼', { exact: true })).toHaveValue('尚未保存的原帳號稱呼');
  await page.getByRole('link', { name: '回到帳號', exact: true }).click(); await page.getByRole('button', { name: '保留草稿並離開', exact: true }).click();
  await page.getByRole('button', { name: '登出此裝置', exact: true }).click(); await expect(page.getByRole('heading', { name: '尚未登入', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('qgroup:rebuild:account-profile:')))).toEqual([]);
});
