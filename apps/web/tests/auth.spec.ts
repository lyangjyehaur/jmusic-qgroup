import { toggleMusicTerm, expectMusicTerm } from './kimi-controls';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
async function identity(page: Page, code: string) {
  await page.unroute('**/__test/qq?*');
  await page.route('**/__test/qq?*', async route => {
    const url = new URL(route.request().url()); url.searchParams.set('code', code);
    await route.continue({ url: url.href });
  });
}
async function authorize(page: Page, code: string, destination = '/me/accounts') {
  await identity(page, code);
  await page.goto('/login?returnTo=' + encodeURIComponent(destination));
  await expect(page.getByRole('button', { name: '前往 QQ 登入', exact: true })).toBeVisible();
  const consent = page.getByRole('checkbox');
  if (await consent.count()) await consent.check();
  await page.getByRole('button', { name: '前往 QQ 登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '確認 QQ 授權' })).toBeVisible();
  await expect(page.getByText('測試帳號 ' + code, { exact: true })).toBeVisible();
}
test('guest completes explicit login, edits music, returns to the activity and revokes the device', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await identity(page, 'task-context');
  await page.goto('/activities/listen');
  await page.getByRole('link', { name: '編輯我的成分' }).click();
  await page.getByRole('link', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '前往 QQ 登入' })).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '前往 QQ 登入' }).click();
  await expect(page.getByText('建立帳號並登入', { exact: true })).toBeVisible();
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: 'test-results/unified-auth-confirm-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '確認登入', exact: true }).click();
  await expect(page).toHaveURL(/\/me\/music\?from=%2Factivities%2Flisten/);
  await toggleMusicTerm(page, 'J-POP');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回到剛才的活動' }).click();
  await expect(page).toHaveURL(/\/activities\/listen$/);
  await page.goto('/me/accounts');
  await expect(page.locator('.account-settings .binding-row').first().getByText('測試帳號 task-context', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '登出此裝置' }).click();
  await expect(page.getByRole('heading', { name: '尚未登入' })).toBeVisible();
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('qgroup:rebuild:music:')))).toEqual([]);
  expect(errors).toEqual([]);
});
test('cancel preserves guest identity and the exact invite task without creating an account', async ({ page, context }) => {
  const task = '/activities/listen?invite=synthetic-invite&action=join#roster';
  await authorize(page, 'cancel-only', task);
  await page.getByRole('button', { name: '取消並返回' }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}` + task);
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
  await authorize(page, 'cancel-only', task);
  await expect(page.getByText('建立帳號並登入', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-auth-confirm-mobile.png', fullPage: true });
});
test('authorized account switching keeps private music data scoped to each account', async ({ page }) => {
  await authorize(page, 'switch-first'); await page.getByRole('button', { name: '確認登入', exact: true }).click();
  await expect(page.locator('.account-settings .binding-row').first().getByText('測試帳號 switch-first', { exact: true })).toBeVisible();
  await page.goto('/me/music'); await toggleMusicTerm(page, 'Aimer');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await authorize(page, 'switch-second');
  await expect(page.getByText('目前帳號「測試帳號 switch-first」的授權會保留', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '確認登入', exact: true }).click();
  await expect(page.locator('.account-settings .binding-row').first().getByText('測試帳號 switch-second', { exact: true })).toBeVisible();
  await page.goto('/me/music'); await expectMusicTerm(page, 'Aimer', false);
  await page.goto('/me/accounts'); await page.getByRole('button', { name: '切換至 測試帳號 switch-first', exact: true }).click();
  await expect(page.locator('.account-settings .binding-row').first().getByText('測試帳號 switch-first', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('banner')).toHaveCount(1);
  await page.getByRole('button', { name: '登出此裝置', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/unified-accounts-mobile-bottom.png' });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/unified-accounts-mobile.png', fullPage: true });
  await page.goto('/me/music'); await expectMusicTerm(page, 'Aimer', true);
});
test('binding conflict prevents replacement and allows an explicit return to the current account', async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-auth-owner', url: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, httpOnly: true, sameSite: 'Lax' }]);
  await identity(page, 'different-qq');
  await page.goto('/login?mode=bind&returnTo=%2Fme%2Faccounts');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '前往 QQ 授權綁定' }).click();
  await expect(page.getByText('目前帳號已綁定另一個 QQ，或此 QQ 已綁定其他帳號', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '確認綁定', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '取消並返回' }).click();
  await expect(page.locator('.account-settings .binding-row').first().getByText('舊帳號', { exact: true })).toBeVisible();
  await expect(page.getByText('已綁定 QQ：原 QQ', { exact: true })).toBeVisible();
});
test('privacy consent opens the existing versioned policy and retains the unfinished login', async ({ page, context }) => {
  await page.goto('/login?returnTo=%2Fme%2Fmusic');
  const popup = context.waitForEvent('page'); await page.locator('.auth-panel').getByRole('link', { name: '隱私政策', exact: true }).click();
  const policy = await popup; await expect(policy.getByRole('heading', { name: '隱私政策', exact: true })).toBeVisible();
  await expect(policy.getByText('unified-2026-11-18', { exact: false })).toBeVisible(); await policy.close();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('button', { name: '前往 QQ 登入' })).toBeDisabled();
});
test('an unreadable finish response blocks repeats and checks the actual account before returning to the task', async ({ page }) => {
  await authorize(page, 'uncertain-result', '/activities/listen?invite=retry#roster');
  let finishes = 0;
  await page.route('**/api/v2/auth/qq/finish', async route => {
    finishes++; const response = await route.fetch();
    await route.fulfill({ response, body: '{' });
  });
  await page.getByRole('button', { name: '確認登入', exact: true }).click();
  await expect(page.getByText('尚未確認登入結果，請先核對目前帳號。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '確認登入', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '取消並返回' })).toBeDisabled();
  await page.getByRole('link', { name: '核對目前帳號', exact: true }).click();
  await expect(page.locator('.account-settings .binding-row').first().getByText('測試帳號 uncertain-result', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回到原任務', exact: true }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}/activities/listen?invite=retry#roster`);
  expect(finishes).toBe(1);
});
