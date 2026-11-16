import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const baseURL = 'http://127.0.0.1:5082';
async function adminContext(context: BrowserContext) {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-registration-admin', url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
}
async function setting(context: BrowserContext, enabled: boolean) {
  const viewer = await (await context.request.get('/api/v2/session')).json();
  const headers = { 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, Origin: baseURL };
  const current = await (await context.request.get('/api/v2/admin/registration', { headers })).json();
  const result = await context.request.post('/api/v2/admin/registration', { headers: { ...headers, 'X-Admin-CSRF': current.adminCsrf }, data: { enabled, revision: current.revision, confirm: true } });
  expect(result.ok()).toBe(true);
}
async function fillName(page: Page, name: string) {
  await page.getByLabel('站內稱呼', { exact: true }).fill(name);
  await page.getByRole('checkbox', { name: '我已閱讀並同意' }).check();
  await page.getByRole('checkbox', { name: '確認建立新的獨立帳號' }).check();
}
test('default closure, administrator confirmation and independent registration retain the original task', async ({ page, browser }) => {
  const admin = await browser.newContext({ baseURL }); await adminContext(admin);
  try {
    await setting(admin, false);
    await page.goto('/login'); await expect(page.getByRole('link', { name: '使用名稱註冊' })).toHaveCount(0);
    await page.goto('/register'); await expect(page.getByText('名稱註冊尚未開放。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '建立帳號', exact: true })).toHaveCount(0);
    await page.goto('/admin/registration'); await expect(page.getByRole('link', { name: '會員登入', exact: true })).toBeVisible();
    const control = await admin.newPage(); await control.goto('/admin/registration');
    await expect(control.getByRole('button', { name: '開放名稱註冊', exact: true })).toBeDisabled();
    await control.getByRole('checkbox').check(); await control.getByRole('button', { name: '開放名稱註冊', exact: true }).click();
    await expect(control.getByRole('status')).toHaveText('名稱註冊：已開放');
    await control.setViewportSize({ width: 360, height: 800 });
    expect(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await control.screenshot({ path: 'test-results/unified-registration-settings-mobile.png', fullPage: true });
    const task = '/activities/listen?invite=name-registration#roster';
    await page.goto('/login?returnTo=' + encodeURIComponent(task)); await page.getByRole('link', { name: '使用名稱註冊', exact: true }).click();
    await expect(page.getByRole('button', { name: '建立帳號', exact: true })).toBeDisabled();
    await fillName(page, '名稱註冊測試');
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/unified-registration-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '建立帳號', exact: true }).click(); await expect(page).toHaveURL(baseURL + task);
    await setting(admin, false);
    await page.goto('/me/accounts'); await expect(page.getByRole('heading', { name: '名稱註冊測試', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '註冊設定', exact: true })).toHaveCount(0);
    await page.goto('/admin/registration'); await expect(page.getByLabel('管理救援憑證', { exact: true })).toBeVisible();
    await page.goto('/me/music'); await page.getByRole('button', { name: 'Aimer', exact: true }).click();
    await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  } finally { await setting(admin, false); await admin.close(); }
});
test('an unreadable registration result blocks repeat creation and checks the actual account', async ({ page, browser }) => {
  const admin = await browser.newContext({ baseURL }); await adminContext(admin); await setting(admin, true);
  try {
    const task = '/activities/listen?invite=unknown-name#roster';
    await page.goto('/register?returnTo=' + encodeURIComponent(task)); await fillName(page, '核對註冊結果');
    let writes = 0;
    await page.route('**/api/v2/auth/register-name', async route => { writes++; const response = await route.fetch(); await route.fulfill({ response, body: '{' }); });
    await page.getByRole('button', { name: '建立帳號', exact: true }).click();
    await expect(page.getByText('尚未確認註冊結果，請先核對目前帳號，避免重複建立。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '建立帳號', exact: true })).toBeDisabled();
    await page.getByRole('link', { name: '核對目前帳號', exact: true }).click();
    await expect(page.getByRole('heading', { name: '核對註冊結果', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '回到原任務', exact: true }).click(); await expect(page).toHaveURL(baseURL + task);
    expect(writes).toBe(1);
  } finally { await setting(admin, false); await admin.close(); }
});
test('stale admin pages cannot overwrite newer settings and unreadable writes require a fresh read', async ({ page, context }) => {
  await adminContext(context); await setting(context, false);
  try {
    await page.goto('/admin/registration'); await page.getByRole('checkbox').check();
    await setting(context, true);
    await page.getByRole('button', { name: '開放名稱註冊', exact: true }).click();
    await expect(page.getByText('註冊設定已被修改，請重新讀取後確認', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '開放名稱註冊', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重新讀取設定', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('名稱註冊：已開放');
    await expect(page.getByRole('checkbox')).not.toBeChecked();
    await page.route('**/api/v2/admin/registration', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); await route.fulfill({ response, body: '{' });
    });
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '關閉名稱註冊', exact: true }).click();
    await expect(page.getByText('尚未確認修改結果，請重新讀取目前設定後核對。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '關閉名稱註冊', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重新讀取設定', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('名稱註冊：已關閉'); await expect(page.getByRole('checkbox')).not.toBeChecked();
  } finally { await setting(context, false); }
});
