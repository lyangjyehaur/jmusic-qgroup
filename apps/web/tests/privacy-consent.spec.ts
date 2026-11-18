import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin = 'http://127.0.0.1:5082', version = 'unified-2026-11-18';
const checkbox = (page: Page) => page.getByRole('checkbox', { name: '我已閱讀並同意目前版本的統一隱私政策', exact: true });
async function login(context: BrowserContext, user = 'bob') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function submit(page: Page) { await checkbox(page).check(); await page.getByRole('button', { name: '確認同意', exact: true }).click(); }
async function stored(page: Page, scope: string) {
  return page.evaluate(async scope => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('qgroup-reviewed-drafts-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<{ key: string; raw: string } | undefined>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly'), r = tx.objectStore('drafts').get('qgroup:rebuild:privacy-consent:v1:' + scope);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    }); } finally { db.close(); }
  }, scope);
}
test('policy viewing writes no consent; explicit acceptance updates another tab and stays usable at 360px', async ({ page, context }) => {
  await login(context); let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/me/privacy/consent')) writes++; });
  await page.goto('/me/accounts'); await page.getByRole('link', { name: '確認統一隱私政策', exact: true }).click();
  await expect(page.getByText('尚未同意', { exact: true })).toBeVisible();
  const popup = page.waitForEvent('popup'); await page.getByRole('link', { name: '閱讀統一隱私政策', exact: true }).click(); const policy = await popup;
  await expect(policy.getByText(version, { exact: false })).toBeVisible();
  for (const purpose of ['私人留言', '找搭子', 'UnionID', '副本', '回執']) await expect(policy.getByText(purpose, { exact: false }).first()).toBeVisible();
  await policy.close(); expect(writes).toBe(0);
  expect((await (await context.request.get('/api/v2/session')).json()).privacyAccepted).toBe(false);
  const other = await context.newPage(); await other.goto('/me/accounts'); await expect(other.getByRole('link', { name: '確認統一隱私政策', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 }); await submit(page);
  await expect(page.getByText('已同意', { exact: true })).toBeVisible(); await expect(page.getByText('同意時間', { exact: true })).toBeVisible();
  await expect(other.getByRole('link', { name: '查看政策同意紀錄', exact: true })).toBeVisible(); expect(writes).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-consent-mobile.png', fullPage: true }); await other.close();
});
test('an unreadable committed response survives reload and is recovered by a read-only receipt query', async ({ page, context }) => {
  await login(context); let writes = 0, queries = 0;
  await page.route('**/api/v2/me/privacy/consent', async route => {
    if (route.request().method() !== 'POST') return route.continue(); writes++; const response = await route.fetch(); await route.fulfill({ response, body: '{' });
  });
  page.on('request', request => { if (request.url().includes('/privacy/consent/receipts/')) queries++; });
  await page.goto('/me/privacy/consent'); await submit(page); await expect(page.getByText('尚未確認同意結果。', { exact: false })).toBeVisible();
  const viewer = await (await context.request.get('/api/v2/session')).json(), row = await stored(page, viewer.scope); expect(JSON.parse(row!.raw).input.privacyVersion).toBe(version);
  expect(viewer.privacyAccepted).toBe(true); page.on('dialog', dialog => void dialog.accept()); await page.reload();
  await expect(page.getByRole('button', { name: '查詢原同意結果', exact: true })).toBeVisible(); expect(writes).toBe(1);
  await page.getByRole('button', { name: '查詢原同意結果', exact: true }).click();
  await expect(page.getByText('原版本的同意已完成。', { exact: false })).toBeVisible(); expect(writes).toBe(1); expect(queries).toBe(1);
  expect((await stored(page, viewer.scope))?.raw).toBe('null');
});
test('a request that never reached the server only retries explicitly with its original key and payload', async ({ page, context }) => {
  await login(context); const keys: string[] = [], bodies: string[] = [];
  await page.route('**/api/v2/me/privacy/consent', async route => {
    if (route.request().method() !== 'POST') return route.continue(); keys.push(route.request().headers()['idempotency-key']!); bodies.push(route.request().postData()!);
    if (keys.length === 1) await route.abort(); else await route.continue();
  });
  await page.goto('/me/privacy/consent'); await submit(page); await expect(page.getByText('尚未確認同意結果。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '查詢原同意結果', exact: true }).click(); await expect(page.getByText('尚未找到原同意的完成紀錄。', { exact: false })).toBeVisible();
  expect(keys).toHaveLength(1); await page.getByRole('button', { name: '重新提交原同意', exact: true }).click();
  await expect(page.getByText('已同意', { exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(bodies[0]).toBe(bodies[1]);
});
test('browser storage failure prevents consent submission and retains the unchecked retry requirement', async ({ page, context }) => {
  await login(context); let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/privacy/consent')) writes++; });
  await page.goto('/me/privacy/consent'); await expect(checkbox(page)).toBeEnabled();
  await page.evaluate(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (value, key) {
    const r = put.call(this, value, key); if (this.name === 'drafts' && String(value.key).includes('privacy-consent:')) r.addEventListener('success', () => { IDBObjectStore.prototype.put = put; this.transaction.abort(); }); return r;
  }; });
  await submit(page); await expect(page.getByText('無法保存原稿及操作編號，尚未送出。', { exact: true })).toBeVisible();
  expect(writes).toBe(0); expect((await (await context.request.get('/api/v2/session')).json()).privacyAccepted).toBe(false);
  await page.reload(); await expect(checkbox(page)).not.toBeChecked(); expect(writes).toBe(0);
});
test('a failed local completion keeps the original operation recoverable without a second consent write', async ({ page, context }) => {
  await login(context); let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/privacy/consent')) writes++; });
  await page.goto('/me/privacy/consent'); await expect(checkbox(page)).toBeEnabled();
  await page.evaluate(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (value, key) {
    const r = put.call(this, value, key); if (this.name === 'drafts' && String(value.key).includes('privacy-consent:') && value.raw === 'null') r.addEventListener('success', () => { IDBObjectStore.prototype.put = put; this.transaction.abort(); }); return r;
  }; });
  await submit(page); await expect(page.getByText('同意已完成，但無法保存本機確認狀態', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '查詢原同意結果', exact: true }).click(); await expect(page.getByText('已同意', { exact: true })).toBeVisible(); expect(writes).toBe(1);
});
test('a historical pending version is preserved, queried and archived before a new unchecked confirmation', async ({ page, context }) => {
  await login(context); const viewer = await (await context.request.get('/api/v2/session')).json();
  const pending = { scope: viewer.scope, key: '00000000-0000-4000-8000-000000000123', input: { acceptPrivacy: true, privacyVersion: 'historical-unified' } }, storageKey = 'qgroup:rebuild:privacy-consent:v1:' + viewer.scope;
  await page.addInitScript(({ storageKey, pending }) => sessionStorage.setItem(storageKey, JSON.stringify(pending)), { storageKey, pending });
  let writes = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/privacy/consent')) writes++; });
  await page.goto('/me/privacy/consent'); await expect(page.getByText('待確認版本：historical-unified', { exact: true })).toBeVisible(); expect(writes).toBe(0);
  await page.getByRole('button', { name: '查詢原同意結果', exact: true }).click(); await expect(page.getByRole('button', { name: '重新提交原同意', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新提交原同意', exact: true }).click(); await expect(page.getByText('隱私政策版本已變更；', { exact: false })).toBeVisible(); expect(writes).toBe(0);
  await page.getByRole('button', { name: '查詢原同意結果', exact: true }).click(); await page.getByRole('button', { name: '保全原操作並重新確認', exact: true }).click();
  await expect(checkbox(page)).not.toBeChecked(); await expect(page.getByRole('button', { name: '確認同意', exact: true })).toBeDisabled();
  await expect(page.getByText('本機保全版本', { exact: false })).toBeVisible(); await submit(page); await expect(page.getByText('已同意', { exact: true })).toBeVisible(); expect(writes).toBe(1);
  await page.getByText('本機保全版本', { exact: false }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下載保全檔', exact: true }).first().click();
  const saved = await download; const fs = await import('node:fs/promises'); expect(JSON.parse(await fs.readFile((await saved.path())!, 'utf8'))).toEqual(pending);
});
test('account changes prevent the original consent from being queried or submitted for the replacement account', async ({ page, context }) => {
  await login(context); let writes = 0, queries = 0;
  await page.route('**/api/v2/me/privacy/consent', async route => { if (route.request().method() === 'POST') { writes++; await route.abort(); } else await route.continue(); });
  page.on('request', request => { if (request.url().includes('/privacy/consent/receipts/')) queries++; });
  await page.goto('/me/privacy/consent'); await submit(page); await expect(page.getByRole('button', { name: '查詢原同意結果', exact: true })).toBeVisible();
  await login(context, 'alice'); await page.getByRole('button', { name: '查詢原同意結果', exact: true }).click();
  await expect(page.getByText('小青', { exact: true }).first()).toBeVisible(); expect(writes).toBe(1); expect(queries).toBe(0);
  expect((await (await context.request.get('/api/v2/session')).json()).privacyAccepted).toBe(false);
  page.on('dialog', dialog => void dialog.accept()); await login(context); await page.reload();
  await expect(page.getByRole('button', { name: '查詢原同意結果', exact: true })).toBeVisible(); expect(writes).toBe(1);
});
test('two tabs cannot silently replace competing pending consent operations', async ({ page, context }) => {
  await login(context); let writes = 0;
  await context.route('**/api/v2/me/privacy/consent', async route => { if (route.request().method() === 'POST') { writes++; await route.abort(); } else await route.continue(); });
  await page.goto('/me/privacy/consent'); await expect(checkbox(page)).toBeEnabled(); const other = await context.newPage(); await other.goto('/me/privacy/consent'); await expect(checkbox(other)).toBeEnabled();
  await submit(page); await expect(page.getByText('尚未確認同意結果。', { exact: false })).toBeVisible();
  const viewer = await (await context.request.get('/api/v2/session')).json(), original = await stored(page, viewer.scope);
  await submit(other); await expect(other.getByRole('button', { name: '讀取已保存版本', exact: true })).toBeVisible(); expect(writes).toBe(1);
  expect((await stored(page, viewer.scope))?.raw).toBe(original?.raw); await other.close();
});
