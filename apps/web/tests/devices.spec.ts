import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
const baseURL = 'http://127.0.0.1:5082';
async function login(page: Page, code: string, destination = '/me/accounts') {
  await page.route('**/__test/qq?*', async route => {
    const url = new URL(route.request().url()); url.searchParams.set('code', code); await route.continue({ url: url.href });
  });
  await page.goto('/login?returnTo=' + encodeURIComponent(destination));
  await expect(page.getByRole('button', { name: '前往 QQ 登入', exact: true })).toBeVisible();
  const consent = page.getByRole('checkbox'); if (await consent.count()) await consent.check();
  await page.getByRole('button', { name: '前往 QQ 登入', exact: true }).click();
  await expect(page.getByText('測試帳號 ' + code, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '確認登入', exact: true }).click();
  await expect(page).toHaveURL(baseURL + destination);
}
async function issue(page: Page) {
  await page.goto('/me/devices');
  await page.getByRole('checkbox', { name: '只授權自己的另一台裝置' }).check();
  await page.getByRole('button', { name: '產生限時連結', exact: true }).click();
  const field = page.getByRole('textbox', { name: '裝置連結（可手動複製）' });
  await expect(field).toBeVisible();
  return field.inputValue();
}
async function accept(page: Page) {
  await page.getByRole('checkbox', { name: '這是我的帳號，確認授權目前裝置' }).check();
  await page.getByRole('button', { name: '確認接受授權', exact: true }).click();
  await expect(page.getByText('已授權此裝置。原有帳號保持登入，請到帳號頁明確切換。', { exact: true })).toBeVisible();
}
async function recheckSession(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
}
test('two devices grant explicitly, switch separately and revoke without changing the other account music', async ({ browser }) => {
  const sourceContext = await browser.newContext({ baseURL }); const targetContext = await browser.newContext({ baseURL });
  try {
    const source = await sourceContext.newPage(); const target = await targetContext.newPage();
    const errors: string[] = []; for (const page of [source, target]) page.on('pageerror', e => errors.push(e.message));
    await login(source, 'device-source'); await login(target, 'device-target');
    await target.goto('/me/music'); await target.getByRole('button', { name: 'Aimer', exact: true }).click();
    await target.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(target.getByText('已保存。')).toBeVisible();
    const link = await issue(source); const token = new URL(link).hash.slice(7);
    const apiUrls: string[] = []; target.on('request', request => { if (request.url().includes('/api/')) apiUrls.push(request.url()); });
    await target.goto(link);
    await expect(target.getByRole('heading', { name: '授權帳號：測試帳號 device-source', exact: true })).toBeVisible();
    await expect(target).toHaveURL(baseURL + '/me/devices/accept');
    await expect(target.getByRole('button', { name: '確認接受授權', exact: true })).toBeDisabled();
    await target.reload();
    await expect(target.getByRole('heading', { name: '授權帳號：測試帳號 device-source', exact: true })).toBeVisible();
    await target.setViewportSize({ width: 360, height: 800 });
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await target.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
    await target.screenshot({ path: 'test-results/unified-device-accept-mobile.png', fullPage: true });
    await accept(target);
    expect((await (await targetContext.request.get('/api/v2/session')).json()).nickname).toBe('測試帳號 device-target');
    await target.getByRole('link', { name: '前往帳號切換', exact: true }).click();
    await target.getByRole('button', { name: '切換至 測試帳號 device-source', exact: true }).click();
    await expect(target.getByRole('heading', { name: '測試帳號 device-source', exact: true })).toBeVisible();
    await source.reload(); await source.getByRole('button', { name: '撤銷其他裝置 1', exact: true }).click();
    await source.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
    await source.screenshot({ path: 'test-results/unified-device-revoke-desktop.png', fullPage: true });
    await source.getByRole('button', { name: '保留授權', exact: true }).click();
    expect((await (await targetContext.request.get('/api/v2/session')).json()).nickname).toBe('測試帳號 device-source');
    await source.getByRole('button', { name: '撤銷其他裝置 1', exact: true }).click();
    await source.getByRole('button', { name: '確認撤銷', exact: true }).click();
    await expect(source.getByText('已撤銷該裝置的此帳號授權；其他帳號保留。', { exact: true })).toBeVisible();
    await recheckSession(target);
    await expect(target.getByRole('heading', { name: '測試帳號 device-target', exact: true })).toBeVisible();
    await expect(target.getByRole('button', { name: '切換至 測試帳號 device-source', exact: true })).toHaveCount(0);
    await target.goto('/me/music'); await expect(target.getByRole('button', { name: 'Aimer', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(apiUrls.every(url => !url.includes(token))).toBe(true); expect(errors).toEqual([]);
  } finally { await sourceContext.close(); await targetContext.close(); }
});
test('guest retains the link through login, can cancel without consuming, and sees replacement links expire', async ({ browser }) => {
  const sourceContext = await browser.newContext({ baseURL }); const guestContext = await browser.newContext({ baseURL });
  try {
    const source = await sourceContext.newPage(); const guest = await guestContext.newPage();
    await login(source, 'device-guest-source'); const first = await issue(source);
    await guest.goto(first); await expect(guest.getByRole('link', { name: '登入後確認授權', exact: true })).toBeVisible();
    await guest.getByRole('button', { name: '取消並返回帳號', exact: true }).click();
    expect((await (await guestContext.request.get('/api/v2/session')).json()).authenticated).toBe(false);
    await guest.goto(first); await expect(guest.getByRole('heading', { name: '授權帳號：測試帳號 device-guest-source', exact: true })).toBeVisible();
    const second = await issue(source);
    await guest.reload(); await expect(guest.getByText('連結已過期、使用或撤銷，請重新產生', { exact: true })).toBeVisible();
    await guest.goto(second); await guest.getByRole('link', { name: '登入後確認授權', exact: true }).click();
    await expect(guest).toHaveURL(/\/login\?returnTo=%2Fme%2Fdevices%2Faccept$/);
    await login(guest, 'device-guest-member', '/me/devices/accept');
    await expect(guest.getByRole('heading', { name: '授權帳號：測試帳號 device-guest-source', exact: true })).toBeVisible();
    await accept(guest);
    expect((await (await guestContext.request.get('/api/v2/session')).json()).nickname).toBe('測試帳號 device-guest-member');
  } finally { await sourceContext.close(); await guestContext.close(); }
});
test('an unreadable accept response is checked by its session-bound receipt without consuming twice', async ({ browser }) => {
  const sourceContext = await browser.newContext({ baseURL }); const targetContext = await browser.newContext({ baseURL });
  try {
    const source = await sourceContext.newPage(); const target = await targetContext.newPage();
    await login(source, 'device-retry-source'); await login(target, 'device-retry-target'); const link = await issue(source);
    await target.goto(link); await target.getByRole('checkbox', { name: '這是我的帳號，確認授權目前裝置' }).check();
    let accepts = 0;
    await target.route('**/api/v2/device-links/accept', async route => { accepts++; const response = await route.fetch(); await route.fulfill({ response, body: '{' }); });
    await target.getByRole('button', { name: '確認接受授權', exact: true }).click();
    await expect(target.getByText('尚未確認授權結果，請先核對授權。', { exact: true })).toBeVisible();
    await expect(target.getByRole('button', { name: '確認接受授權', exact: true })).toBeDisabled();
    await target.getByRole('button', { name: '核對授權結果', exact: true }).click();
    await expect(target.getByText('已授權此裝置。原有帳號保持登入，請到帳號頁明確切換。', { exact: true })).toBeVisible();
    await target.reload(); await expect(target.getByRole('link', { name: '前往帳號切換', exact: true })).toBeVisible();
    expect(accepts).toBe(1);
  } finally { await sourceContext.close(); await targetContext.close(); }
});
test('storage failure keeps the link visible for recovery and blocks sending authorization', async ({ browser }) => {
  const sourceContext = await browser.newContext({ baseURL }); const targetContext = await browser.newContext({ baseURL });
  try {
    const source = await sourceContext.newPage(); const target = await targetContext.newPage();
    await login(source, 'device-storage-source'); const link = await issue(source);
    await target.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('synthetic blocked storage', 'SecurityError'); }; });
    let writes = 0; target.on('request', r => { if (r.method() === 'POST' && r.url().includes('/device-links/')) writes++; });
    await target.goto(link);
    await expect(target.getByText('無法暫存裝置連結', { exact: false })).toBeVisible();
    expect(target.url()).toBe(link); expect(writes).toBe(0);
    await expect(target.getByRole('button', { name: '確認接受授權', exact: true })).toHaveCount(0);
  } finally { await sourceContext.close(); await targetContext.close(); }
});
test('logout clears the same browser other tab private views and music drafts without reloading', async ({ page, context }) => {
  await login(page, 'device-tabs');
  const editor = await context.newPage(); await editor.goto('/me/music');
  await editor.getByRole('button', { name: 'YOASOBI', exact: true }).click();
  expect(await editor.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('qgroup:rebuild:music:')))).toBe(true);
  await page.getByRole('button', { name: '登出此裝置', exact: true }).click();
  await expect(editor.getByRole('heading', { name: '登入後才能保存成分', exact: true })).toBeVisible();
  expect(await editor.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('qgroup:rebuild:music:')))).toEqual([]);
  await editor.close();
});
test('switching accounts updates another tab while preserving its original account draft', async ({ page, context }) => {
  await login(page, 'device-tab-original');
  const editor = await context.newPage(); await editor.goto('/me/music');
  await editor.getByRole('button', { name: 'ヨルシカ', exact: true }).click();
  await login(page, 'device-tab-switch');
  await expect(editor.getByText('測試帳號 device-tab-switch 的音樂成分', { exact: false })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'ヨルシカ', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '切換至 測試帳號 device-tab-original', exact: true }).click();
  await expect(editor.getByText('測試帳號 device-tab-original 的音樂成分', { exact: false })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'ヨルシカ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor.close();
});
