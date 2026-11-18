import { test, expect } from './fixtures';
import { denyWrite } from './erasure-test-helpers';
import type { BrowserContext, Page } from '@playwright/test';
const origin = 'http://127.0.0.1:5082';
async function login(context: BrowserContext, user = 'bob') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function saveMusic(page: Page) {
  await page.goto('/me/music'); await page.getByRole('button', { name: 'Aimer', exact: true }).click();
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
}
async function confirm(page: Page, label: string, button: string) {
  await page.getByRole('radio', { name: label, exact: true }).check();
  await page.getByRole('checkbox', { name: '我已確認範圍，瞭解此操作無法復原', exact: true }).check();
  await page.getByRole('button', { name: button, exact: true }).click();
}
test('music erasure clears stale drafts in other tabs, retains the account and explicitly creates a fresh profile', async ({ page, context }) => {
  await login(context); await saveMusic(page);
  const viewer = await (await context.request.get('/api/v2/session')).json();
  const before = await (await context.request.get('/api/v2/me/music', { headers: { 'X-Account-Scope': viewer.scope } })).json();
  const other = await context.newPage(); await other.goto('/me/music'); await expect(other.getByRole('button', { name: 'Aimer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/me/accounts'); await page.getByRole('link', { name: '隱私與資料刪除', exact: true }).click();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByRole('button', { name: '確認刪除成分', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-privacy-mobile.png', fullPage: true });
  await confirm(page, '只刪除成分', '確認刪除成分'); await expect(page.getByRole('heading', { name: '成分已刪除', exact: true })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Aimer', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(true);
  await other.getByRole('button', { name: 'YOASOBI', exact: true }).click(); await other.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(other.getByText('已保存。', { exact: true })).toBeVisible();
  const after = await (await context.request.get('/api/v2/me/music', { headers: { 'X-Account-Scope': viewer.scope } })).json(); expect(after.id).not.toBe(before.id);
  await other.close();
});
test('an unreadable account closure response survives reload and is recovered after login revocation without a second erase', async ({ page, context }) => {
  await login(context); await saveMusic(page);
  let erasures = 0; let proofQueries = 0;
  await page.route('**/api/v2/me/privacy/erase', async route => { erasures++; const response = await route.fetch(); await route.fulfill({ response, body: '{' }); });
  page.on('request', request => { if (request.url().endsWith('/api/v2/privacy/receipt')) proofQueries++; });
  await page.goto('/me/privacy'); await confirm(page, '只關閉帳號', '確認關閉帳號');
  await expect(page.getByText('尚未確認刪除結果。', { exact: false })).toBeVisible();
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
  page.on('dialog', dialog => void dialog.accept()); await page.reload();
  await page.getByRole('button', { name: '確認刪除結果', exact: true }).click();
  await expect(page.getByRole('heading', { name: '帳號已關閉', exact: true })).toBeVisible();
  await expect(page.getByText('原成分及其歷史仍保留，已解除帳號關聯。', { exact: true })).toBeVisible();
  await expect(page.getByText('共享活動、帳務或歷史紀錄仍待人工審核', { exact: false })).toBeVisible();
  expect(erasures).toBe(1); expect(proofQueries).toBe(1);
});
test('active activity ownership blocks account closure while music deletion remains a separate choice', async ({ page, context }) => {
  await login(context, 'alice'); await page.goto('/me/privacy');
  await page.getByRole('radio', { name: '只關閉帳號', exact: true }).check();
  await expect(page.getByText('仍由你管理的活動', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByRole('button', { name: '確認關閉帳號', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: '只刪除成分', exact: true }).check();
  await expect(page.getByText('目前沒有可刪除的成分。', { exact: true })).toBeVisible();
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(true);
});
test('storage failure blocks destructive requests and damaged operation records are preserved', async ({ page, context }) => {
  await login(context); let erasures = 0;

  page.on('request', request => { if (request.url().endsWith('/api/v2/me/privacy/erase')) erasures++; });
  await page.goto('/me/privacy'); await expect(page.getByRole('radio').first()).toBeVisible(); await denyWrite(page); await confirm(page, '只關閉帳號', '確認關閉帳號');
  await expect(page.getByText('無法保存或核對原刪除紀錄，尚未提交刪除。', { exact: false })).toBeVisible(); expect(erasures).toBe(0);
  const clean = await context.newPage(); await clean.goto('/me/privacy');
  await clean.evaluate(() => sessionStorage.setItem('qgroup:rebuild:privacy-pending:v1', 'damaged synthetic intent'));
  await clean.reload(); await expect(clean.getByText('無法讀取刪除操作紀錄', { exact: false })).toBeVisible();
  await expect(clean.getByRole('button', { name: '確認關閉帳號', exact: true })).toHaveCount(0);
  const downloaded = clean.waitForEvent('download'); await clean.getByRole('button', { name: '下載原刪除紀錄', exact: true }).click(); await downloaded;
  await clean.getByRole('button', { name: '已保全，清除原紀錄', exact: true }).click();
  expect(await clean.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('privacy-pending:v1:recovery:')))).toEqual([]);
  await clean.close();
});
test('a pending unsent deletion never switches to another account during recovery', async ({ page, context }) => {
  await login(context); let erasures = 0;
  await page.route('**/api/v2/me/privacy/erase', async route => { erasures++; await route.abort(); });
  await page.goto('/me/privacy'); await confirm(page, '只關閉帳號', '確認關閉帳號');
  await expect(page.getByText('尚未確認刪除結果。', { exact: false })).toBeVisible();
  await login(context, 'alice'); await page.getByRole('button', { name: '確認刪除結果', exact: true }).click();
  await expect(page.getByText('不會使用目前帳號提交刪除。', { exact: false })).toBeVisible(); expect(erasures).toBe(1);
  expect((await (await context.request.get('/api/v2/session')).json()).nickname).toBe('小青');
});
test('an explicitly combined erasure closes the account without claiming retained history is gone', async ({ page, context }) => {
  await login(context); await saveMusic(page); await page.goto('/me/privacy');
  await confirm(page, '關閉帳號並刪除成分', '確認關閉並刪除');
  await expect(page.getByRole('heading', { name: '帳號已關閉', exact: true })).toBeVisible();
  await expect(page.getByText('帳號私人資料與成分已移除。', { exact: true })).toBeVisible();
  await expect(page.getByText('原成分及其歷史仍保留，已解除帳號關聯。', { exact: true })).toHaveCount(0);
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
});
