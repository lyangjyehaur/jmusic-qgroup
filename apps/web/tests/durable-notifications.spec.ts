import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from '@playwright/test';
import { damageDraft, denyDraftWrites, durableRows } from './draft-helpers';

const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, success = '通知已標為已讀；待辦仍按目前狀態計算。';
const unknown = '尚未確認已讀結果，原操作已保留，請確認原操作結果。';
const retry = (page: Page) => page.getByRole('button', { name: '確認原已讀操作結果', exact: true });
const notices = (page: Page) => page.getByRole('region', { name: '站內通知', exact: true });
test.use({ inboxExamples: true });
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function settled(page: Page) {
  await expect(page.getByText('正在讀取本機原稿…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('正在保存本機原稿…', { exact: true })).toHaveCount(0);
}
async function open(page: Page, context: BrowserContext) {
  await login(context); await page.goto(origin + '/inbox');
  await expect(notices(page).getByRole('button', { name: '標為已讀', exact: true }).first()).toBeEnabled(); await settled(page);
}
async function mark(page: Page, batch = false) {
  await notices(page).getByRole('button', { name: batch ? '將已載入的通知標為已讀（最多 100 筆）' : '標為已讀', exact: true }).first().click();
}
async function pendingRow(page: Page) { return (await durableRows(page)).find(row => row.key.includes('notifications-read:') && row.raw !== 'null')!; }

for (const batch of [false, true]) test((batch ? 'batch' : 'single') + ' read receipts survive closing the tab and retain only the exact original UUID and notification IDs', async ({ page, context }) => {
  await open(page, context); const writes: { key: string; input: { ids: string[] } }[] = [];
  await context.route('**/api/v2/me/notifications/read', async route => {
    writes.push({ key: route.request().headers()['idempotency-key']!, input: route.request().postDataJSON() });
    const response = await route.fetch(); await route.fulfill(writes.length === 1 ? { response, body: '{' } : { response });
  });
  await mark(page, batch); await expect(page.getByText(unknown, { exact: true })).toBeVisible();
  const row = await pendingRow(page); expect(JSON.parse(row.raw)).toEqual({ key: writes[0]!.key, input: writes[0]!.input });
  expect(writes[0]!.input.ids).toHaveLength(batch ? 100 : 1); expect(row.raw).not.toMatch(/站內通知|PRIVATE_|小青|小白/);
  const viewer = await (await context.request.get(origin + '/api/v2/session')).json();
  const before = await (await context.request.get(origin + '/api/v2/me/notifications', { headers: { 'X-Account-Scope': viewer.scope } })).json();
  await page.close(); const fresh = await context.newPage(); await fresh.goto(origin + '/inbox'); await expect(retry(fresh)).toBeVisible();
  expect(writes).toHaveLength(1); await expect(fresh.getByRole('region', { name: '未完成操作', exact: true })).toHaveCount(0);
  await expect(notices(fresh).getByRole('button', { name: '將已載入的通知標為已讀（最多 100 筆）', exact: true })).toBeDisabled();
  await retry(fresh).click(); await expect(fresh.getByText(success, { exact: true })).toBeVisible(); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  const after = await (await context.request.get(origin + '/api/v2/me/notifications', { headers: { 'X-Account-Scope': viewer.scope } })).json(); expect(after).toEqual(before);
  expect(await pendingRow(fresh)).toBeUndefined(); await expect(fresh.getByRole('region', { name: '目前待辦', exact: true }).getByRole('listitem')).toHaveCount(10);
});

test('a successful put followed by pending transaction abort prevents every read POST and preserves the server unread count', async ({ page, context }) => {
  await open(page, context); await denyDraftWrites(page, 'notifications-read:'); let writes = 0;
  page.on('request', request => { if (request.url().endsWith('/notifications/read') && request.method() === 'POST') writes++; });
  await mark(page); await expect(page.getByText('無法保存已讀操作編號，尚未送出。', { exact: true })).toBeVisible();
  expect(writes).toBe(0); expect(await pendingRow(page)).toBeUndefined(); await expect(retry(page)).toHaveCount(0);
  await expect(notices(page).getByRole('heading', { name: '站內通知 · 105 未讀', exact: true })).toBeVisible();
});

test('a completion transaction abort keeps the accepted original command available after closing the tab', async ({ page, context }) => {
  await open(page, context); const writes: { key: string; body: string }[] = [];
  await context.route('**/api/v2/me/notifications/read', route => { writes.push({ key: route.request().headers()['idempotency-key']!, body: route.request().postData()! }); return route.continue(); });
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) { const result = original.call(this, value, key);
      if (this.name === 'drafts' && String(value.key).includes('notifications-read:') && value.raw === 'null') result.addEventListener('success', () => this.transaction.abort()); return result;
    };
  });
  await mark(page); await expect(page.getByText('已讀操作已送出，但無法保存本機確認狀態；請保留原操作並核對結果。', { exact: true })).toBeVisible();
  expect(JSON.parse((await pendingRow(page)).raw).key).toBe(writes[0]!.key); await expect(page.getByText(success, { exact: true })).toHaveCount(0);
  await page.close(); const fresh = await context.newPage(); await fresh.goto(origin + '/inbox'); await retry(fresh).click();
  await expect(fresh.getByText(success, { exact: true })).toBeVisible(); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  await expect(notices(fresh).getByRole('heading', { name: '站內通知 · 104 未讀', exact: true })).toBeVisible();
});

test('a definitive rejection cannot clear the original command until its local acknowledgement commits', async ({ page, context }) => {
  await open(page, context); const writes: string[] = [];
  await context.route('**/api/v2/me/notifications/read', route => { writes.push(route.request().postData()!); return route.fulfill({ status: 403, json: { code: 'SYNTHETIC', message: '本次已讀操作被拒絕' } }); });
  await page.evaluate(() => { const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, key) {
    const result = original.call(this, value, key); if (this.name === 'drafts' && String(value.key).includes('notifications-read:') && value.raw === 'null') result.addEventListener('success', () => this.transaction.abort()); return result;
  }; });
  await mark(page); await expect(page.getByText('無法保存拒絕結果；原操作仍保留，請重新核對。', { exact: true })).toBeVisible(); const before = await pendingRow(page);
  await expect(retry(page)).toBeVisible(); await page.close(); const fresh = await context.newPage(); await fresh.goto(origin + '/inbox'); expect(await pendingRow(fresh)).toEqual(before);
  await retry(fresh).click(); await expect(fresh.getByText('本次已讀操作被拒絕', { exact: true })).toBeVisible(); await expect(retry(fresh)).toHaveCount(0); expect(writes).toHaveLength(2); expect(writes[1]).toBe(writes[0]);
  expect(await pendingRow(fresh)).toBeUndefined(); await expect(notices(fresh).getByRole('heading', { name: '站內通知 · 105 未讀', exact: true })).toBeVisible();
});

test('two tabs preserve competing read commands and send only the saved operation after explicit conflict recovery', async ({ page, context }) => {
  await open(page, context); const other = await context.newPage(); await other.goto(origin + '/inbox'); await settled(other);
  const writes: { key: string; body: string }[] = [];
  await context.route('**/api/v2/me/notifications/read', route => {
    writes.push({ key: route.request().headers()['idempotency-key']!, body: route.request().postData()! }); return writes.length === 1 ? route.abort() : route.continue();
  });
  await mark(page); await expect(page.getByText(unknown, { exact: true })).toBeVisible(); const original = await pendingRow(page);
  await mark(other, true); await expect(other.getByText(/其他分頁已更新原稿/)).toBeVisible(); expect(writes).toHaveLength(1);
  const preserved = (await durableRows(other, 'versions')).filter(row => row.key.includes('notifications-read:')); expect(preserved).toHaveLength(1); expect(JSON.parse(preserved[0]!.raw).input.ids).toHaveLength(100);
  await other.getByRole('button', { name: '讀取已保存版本', exact: true }).click(); expect((await pendingRow(other)).raw).toBe(original.raw);
  await retry(other).click(); await expect(other.getByText(success, { exact: true })).toBeVisible(); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  await expect(notices(other).getByRole('heading', { name: '站內通知 · 104 未讀', exact: true })).toBeVisible();
  await notices(other).getByText('草稿版本（1）', { exact: true }).click(); await notices(other).getByRole('button', { name: '載入此原稿（保留目前版本）', exact: true }).click();
  await expect(retry(other)).toBeVisible(); expect(writes).toHaveLength(2); expect(JSON.parse((await pendingRow(other)).raw).input.ids).toHaveLength(100);
});

test('session migration retains its source on abort and transfers the exact pending command only after commit', async ({ page, context }) => {
  await open(page, context); const viewer = await (await context.request.get(origin + '/api/v2/session')).json();
  const key = 'qgroup:rebuild:notifications-read:v1:' + viewer.scope, raw = JSON.stringify({ key: crypto.randomUUID(), input: { ids: ['1', '2'] } });
  await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), { key, raw });
  await page.addInitScript(() => { const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, key) {
    const result = original.call(this, value, key); if (this.name === 'drafts' && String(value.key).includes('notifications-read:')) result.addEventListener('success', () => this.transaction.abort()); return result;
  }; });
  await page.reload(); await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。', { exact: false })).toBeVisible(); expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBe(raw); expect(await pendingRow(page)).toBeUndefined();
  const fresh = await context.newPage(); await fresh.goto(origin + '/inbox'); await fresh.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), { key, raw }); await fresh.reload(); await expect(retry(fresh)).toBeVisible();
  expect(await fresh.evaluate(key => sessionStorage.getItem(key), key)).toBeNull(); expect((await pendingRow(fresh)).raw).toBe(raw);
  let writes = 0; await fresh.route('**/api/v2/me/notifications/read', route => { writes++; expect(route.request().headers()['idempotency-key']).toBe(JSON.parse(raw).key); expect(route.request().postDataJSON()).toEqual(JSON.parse(raw).input); return route.continue(); });
  expect(writes).toBe(0); await retry(fresh).click(); await expect(fresh.getByText(success, { exact: true })).toBeVisible(); expect(writes).toBe(1);
});

test('malformed saved commands are preserved for download without sending, including mobile recovery', async ({ page, context }) => {
  await open(page, context); await page.route('**/api/v2/me/notifications/read', route => route.abort()); await mark(page); await expect(page.getByText(unknown, { exact: true })).toBeVisible();
  const raw = JSON.stringify({ key: crypto.randomUUID(), input: { ids: ['PRIVATE_INVALID_ID'] } }); await damageDraft(page, 'notifications-read:', raw);
  await page.reload(); await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。', { exact: false })).toBeVisible(); let writes = 0; page.on('request', request => { if (request.url().endsWith('/notifications/read') && request.method() === 'POST') writes++; });
  await page.getByRole('button', { name: '保全原稿後繼續', exact: true }).click(); expect((await durableRows(page, 'versions')).map(row => row.raw)).toContain(raw); expect(writes).toBe(0);
  await notices(page).getByText('草稿版本（1）', { exact: true }).click(); await notices(page).getByRole('button', { name: '載入此原稿（保留目前版本）', exact: true }).click();
  await expect(page.getByText('這份原稿格式無法讀取，請下載保全檔。', { exact: true })).toBeVisible();
  expect(await notices(page).textContent()).not.toContain('PRIVATE_INVALID_ID');
  const download = page.waitForEvent('download'); await notices(page).getByRole('button', { name: '下載保全檔', exact: true }).click(); expect(await readFile((await (await download).path())!, 'utf8')).toBe(raw);
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await notices(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/unified-notice-recovery-mobile.png', animations: 'disabled' });
});

test('a different account never acquires an earlier account’s pending read command', async ({ page, context }) => {
  await open(page, context); await context.route('**/api/v2/me/notifications/read', route => route.abort()); await mark(page); await expect(page.getByText(unknown, { exact: true })).toBeVisible(); const original = await pendingRow(page);
  await page.close(); await login(context, 'bob'); const other = await context.newPage(); await other.goto(origin + '/inbox'); await settled(other); await expect(retry(other)).toHaveCount(0); expect(await pendingRow(other)).toEqual(original); await expect(other.getByText('小白專屬通知', { exact: true })).toBeVisible();
  await other.close(); await login(context); const fresh = await context.newPage(); await fresh.goto(origin + '/inbox'); await expect(retry(fresh)).toBeVisible(); expect((await pendingRow(fresh)).raw).toBe(original.raw);
});

test('device logout fences a stale read action without relying on BroadcastChannel', async ({ page, context }) => {
  await context.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true })); await open(page, context);
  const other = await context.newPage(); await other.goto(origin + '/me/accounts'); await other.getByRole('button', { name: '登出此裝置', exact: true }).click(); await expect(other).toHaveURL(origin + '/me');
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/notifications/read')) writes++; });
  await notices(page).getByRole('button', { name: '標為已讀', exact: true }).first().evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByText('此原稿已因登出或資料刪除失效，請重新載入頁面。', { exact: false })).toBeVisible(); expect(writes).toBe(0); expect(await pendingRow(other)).toBeUndefined();
});
