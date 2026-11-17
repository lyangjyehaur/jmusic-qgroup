import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { durableRows } from './draft-helpers';
import { checkAdminReceipt } from './operation-helpers';

const origin = 'http://127.0.0.1:5082', rescueKey = 'synthetic-admin-rescue-' + 'x'.repeat(32);
const found = '此操作編號已有回執，請回原頁核對內容及目前權限。';
const missing = '尚未查到此操作編號的回執，請回原頁確認原操作結果。';
async function login(context: BrowserContext, user = 'registration-admin') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function session(context: BrowserContext) { return (await context.request.get(origin + '/api/v2/session')).json(); }
async function auth(context: BrowserContext) {
  const viewer = await session(context), access = await (await context.request.get(origin + '/api/v2/admin/session', { headers: { 'X-Account-Scope': viewer.scope } })).json();
  return { viewer, access, headers: { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'X-Admin-CSRF': access.adminCsrf, 'Idempotency-Key': crypto.randomUUID() } };
}
async function prepare(page: Page, context: BrowserContext, accepted = true) {
  await page.goto(origin + '/admin/bot'); await page.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('61');
  await expect(page.getByText('正在保存本機原稿…', { exact: true })).toHaveCount(0);
  let writes = 0;
  await context.route('**/api/v2/admin/bot', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes++;
    if (writes === 1 && !accepted) return route.abort();
    const response = await route.fetch(); await route.fulfill(writes === 1 ? { response, body: '{' } : { response });
  });
  await page.getByRole('checkbox', { name: '我已核對發送模式、群政策與設定變更', exact: true }).check();
  await page.getByRole('button', { name: '確認 bot 設定', exact: true }).click();
  await expect(page.getByText('尚未確認 bot 設定結果，原稿與操作編號已保留，請確認原操作結果。', { exact: true })).toBeVisible();
  const row = (await durableRows(page)).find(row => row.key.includes('admin-bot:'))!;
  return { row, key: JSON.parse(row.raw).pending.key as string, writes: () => writes };
}
const inventory = (page: Page) => page.getByRole('region', { name: '未完成操作', exact: true });

test('a preserved management version retains its original receipt scope and never replays on inventory lookup', async ({ page, context }) => {
  await login(context); const pending = await prepare(page, context);
  await page.evaluate(async row => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('qgroup-reviewed-drafts-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['drafts', 'versions'], 'readwrite');
        tx.objectStore('versions').put({ id: crypto.randomUUID(), key: row.key, scope: row.key.split(':')[4], raw: row.raw, at: Date.now(), reason: 'synthetic preserved pending' });
        tx.objectStore('drafts').put({ ...row, raw: 'null', revision: row.revision + 1 });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, pending.row);
  await page.close(); const fresh = await context.newPage(); await fresh.goto(origin + '/inbox');
  await expect(inventory(fresh).getByRole('link', { name: 'bot 設定（保全版本）', exact: true })).toBeVisible();
  const before = await durableRows(fresh, 'versions'); await checkAdminReceipt(fresh, inventory(fresh), pending.key);
  expect(await durableRows(fresh, 'versions')).toEqual(before); expect(pending.writes()).toBe(1);
});

test('an undelivered admin command stays absent even when a member command has the same UUID, and only the original form retries it', async ({ page, context }) => {
  await login(context); const pending = await prepare(page, context, false), { viewer } = await auth(context);
  const profile = await (await context.request.get(origin + '/api/v2/me/profile', { headers: { 'X-Account-Scope': viewer.scope } })).json();
  const member = await context.request.put(origin + '/api/v2/me/profile', { headers: { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': pending.key }, data: profile });
  expect(member.ok()).toBe(true);
  await page.close(); const fresh = await context.newPage(); await fresh.goto(origin + '/inbox');
  const before = await durableRows(fresh); await checkAdminReceipt(fresh, inventory(fresh), pending.key, false);
  expect(await durableRows(fresh)).toEqual(before); expect(pending.writes()).toBe(1);
  await inventory(fresh).getByRole('link', { name: 'bot 設定', exact: true }).click();
  await fresh.getByRole('button', { name: '確認原操作結果', exact: true }).click();
  await expect(fresh.getByText('bot 設定已保存。', { exact: true })).toBeVisible(); expect(pending.writes()).toBe(2);
  await fresh.goto(origin + '/inbox'); await expect(inventory(fresh)).toHaveCount(0);
});

test('receipt HTTP and parsing failures stay visible, clear an earlier result and retain the original record for retry', async ({ page, context }) => {
  await login(context); const pending = await prepare(page, context); await page.close();
  const fresh = await context.newPage(); await fresh.goto(origin + '/inbox'); await checkAdminReceipt(fresh, inventory(fresh), pending.key);
  const before = await durableRows(fresh);
  for (const broken of ['unavailable', 'malformed'] as const) {
    await fresh.route('**/api/v2/admin/operations/' + pending.key, route => broken === 'unavailable'
      ? route.fulfill({ status: 503, json: { code: 'SYNTHETIC', message: '回執暫時無法核對' } })
      : route.fulfill({ status: 200, contentType: 'application/json', body: '{' }));
    await inventory(fresh).getByRole('button', { name: '核對結果', exact: true }).click();
    await expect(inventory(fresh).getByText(found, { exact: true })).toHaveCount(0);
    await expect(inventory(fresh).getByText(missing, { exact: true })).toHaveCount(0);
    await expect(inventory(fresh).getByText(broken === 'unavailable' ? '回執暫時無法核對' : '無法讀取操作回執，請稍後重試。', { exact: true })).toBeVisible();
    expect(await durableRows(fresh)).toEqual(before); expect(pending.writes()).toBe(1);
    await fresh.unroute('**/api/v2/admin/operations/' + pending.key);
    await checkAdminReceipt(fresh, inventory(fresh), pending.key);
  }
  await fresh.setViewportSize({ width: 360, height: 800 });
  expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await inventory(fresh).scrollIntoViewIfNeeded(); await fresh.screenshot({ path: 'test-results/unified-admin-operation-receipt-mobile.png', animations: 'disabled' });
});

test('renewed rescue authority reports the original scope mismatch instead of a missing member receipt', async ({ page, context }) => {
  await login(context, 'bob'); await page.goto(origin + '/admin');
  await page.getByLabel('管理救援憑證', { exact: true }).fill(rescueKey); await page.getByRole('button', { name: '使用救援憑證登入', exact: true }).click();
  await expect(page.getByRole('link', { name: 'bot 設定', exact: true })).toBeVisible();
  const pending = await prepare(page, context), original = await auth(context);
  const renewed = await context.request.post(origin + '/api/v2/admin/login', { headers: original.headers, data: { key: rescueKey, confirm: true } }); expect(renewed.ok()).toBe(true);
  expect((await auth(context)).access.scope).not.toBe(original.access.scope);
  await page.close(); const fresh = await context.newPage(); let memberLookups = 0;
  fresh.on('request', request => { if (request.url().includes('/me/operations/')) memberLookups++; });
  await fresh.goto(origin + '/inbox'); const before = await durableRows(fresh);
  const response = fresh.waitForResponse(response => response.url().endsWith('/admin/operations/' + pending.key));
  await inventory(fresh).getByRole('button', { name: '核對結果', exact: true }).click();
  expect((await response).request().headers()['x-admin-scope']).toBe(original.access.scope);
  await expect(inventory(fresh).getByText('原操作的管理授權已變更，請回原頁核對管理狀態。', { exact: true })).toBeVisible();
  await expect(inventory(fresh).getByText(missing, { exact: true })).toHaveCount(0);
  expect(await durableRows(fresh)).toEqual(before); expect(memberLookups).toBe(0); expect(pending.writes()).toBe(1);
});

test('revoked administrator receipts cannot be queried by the remaining member login or by a later role grant', async ({ page, context, browser }) => {
  const manager = await browser.newContext({ baseURL: origin });
  try {
    await login(manager);
    expect((await manager.request.post('/api/v2/admin/users/bob/role', { headers: (await auth(manager)).headers, data: { isAdmin: true, revision: 0, confirm: true } })).ok()).toBe(true);
    await login(context, 'bob'); const pending = await prepare(page, context); await page.close();
    expect((await manager.request.post('/api/v2/admin/users/bob/role', { headers: (await auth(manager)).headers, data: { isAdmin: false, revision: 1, confirm: true } })).ok()).toBe(true);
    const fresh = await context.newPage(); await fresh.goto(origin + '/inbox'); const before = await durableRows(fresh);
    await inventory(fresh).getByRole('button', { name: '核對結果', exact: true }).click();
    await expect(inventory(fresh).getByText('需要管理員權限或救援憑證登入', { exact: true })).toBeVisible();
    expect(await durableRows(fresh)).toEqual(before); expect(pending.writes()).toBe(1);
    expect((await manager.request.post('/api/v2/admin/users/bob/role', { headers: (await auth(manager)).headers, data: { isAdmin: true, revision: 2, confirm: true } })).ok()).toBe(true);
    await inventory(fresh).getByRole('button', { name: '核對結果', exact: true }).click();
    await expect(inventory(fresh).getByText('原操作的管理授權已變更，請回原頁核對管理狀態。', { exact: true })).toBeVisible();
    expect(await durableRows(fresh)).toEqual(before); expect(pending.writes()).toBe(1);
  } finally { await manager.close(); }
});

test('a late receipt response cannot restore inbox results after device logout', async ({ page, context }) => {
  await login(context); const pending = await prepare(page, context); await page.close(); const fresh = await context.newPage(); await fresh.goto(origin + '/inbox');
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { seen = resolve; });
  await fresh.route('**/api/v2/admin/operations/' + pending.key, async route => { const response = await route.fetch(); seen(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await inventory(fresh).getByRole('button', { name: '核對結果', exact: true }).click(); await intercepted;
  const logout = await context.newPage();
  try {
    await logout.goto(origin + '/me/accounts'); await logout.getByRole('button', { name: '登出此裝置', exact: true }).click();
    await expect(inventory(fresh)).toHaveCount(0); release();
    await expect(fresh.getByText(found, { exact: true })).toHaveCount(0);
    expect(await durableRows(logout)).toEqual([]); expect(pending.writes()).toBe(1);
  } finally { release(); await logout.close(); }
});
