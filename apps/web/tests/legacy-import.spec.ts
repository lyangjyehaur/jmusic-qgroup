import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { durableRows } from './draft-helpers';
import { legacyRaw } from '../src/legacy-local-codec';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, scope = createHash('sha256').update('kanban-drafts-v1:alice').digest('hex');
const intent = '11111111-1111-4111-8111-111111111111';
const draft = (data: unknown = { fields: [{ name: 'id', value: '' }, { name: 'title', value: '匯入原文字', checked: undefined }], dataset: { intent, revision: '7' } }, suffix = 'event:new') => ({ key: 'draft:' + scope + ':' + suffix, data, at: 1234567 });
const activity = () => draft({ react: 1, value: { id: '', _intent: intent, _revision: '', _lifecycle: '', title: '匯入活動', category: '约K', location: '台北', description: '原說明\n第二行', fee_policy: '原費用', capacity_unlimited: false, capacity: '8', minimum_participants: '2', timezone: 'Asia/Taipei', visibility: 'public', event_date: '2099-12-12', start_time: '18:30', start_day_offset: '0', duration_hours: '3', deadline: '2099-12-10T18:00', withdrawal_deadline: '2099-12-09T20:00', bot_enabled: false, reason: '原修改原因' }, revision: undefined });
async function login(context: BrowserContext, user = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function inventory(page: Page) { await page.goto('/me/local-history'); await expect(page.getByLabel('舊草稿保全檔', { exact: true })).toBeVisible(); }
async function seed(page: Page, source: unknown) {
  await page.evaluate(async source => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('kanban-local-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('entries', { keyPath: 'key' }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('entries', 'readwrite'); tx.objectStore('entries').put(source); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
  }, source);
}
async function vault(page: Page, store = 'snapshots') {
  return page.evaluate(async store => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('qgroup-legacy-local-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<{ id: string; raw: string; source: unknown; importedEpoch?: number }[]>((resolve, reject) => { const tx = db.transaction(store), r = tx.objectStore(store).getAll(); tx.oncomplete = () => resolve(r.result); tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
  }, store);
}
async function choose(page: Page, raw: string | Buffer) { await page.getByLabel('舊草稿保全檔', { exact: true }).setInputFiles({ name: 'kanban-local-draft.json', mimeType: 'application/json', buffer: typeof raw === 'string' ? Buffer.from(raw) : raw }); }
async function stage(page: Page, raw: string, label = '舊活動草稿') { await choose(page, raw); await expect(page.getByRole('heading', { name: label + ' · 待匯入', exact: true })).toBeVisible(); }
async function importStaged(page: Page) { await page.getByRole('checkbox', { name: '已核對原稿屬於目前帳號；只匯入本機，不送出', exact: true }).check(); await page.getByRole('button', { name: '匯入此舊草稿', exact: true }).click(); }
const imported = (page: Page) => expect(page.getByText('已匯入本機。請核對原結果，再帶入新版表單。', { exact: true })).toBeVisible();

test('restores an actual downloaded image draft into a fresh browser without a legacy source, target mapping or API write', async ({ page, context, browser }) => {
  await login(context); await inventory(page);
  const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 12; c.getContext('2d')!.fillRect(0, 0, 12, 12); return c.toDataURL().split(',')[1]!; });
  const original = draft({ fields: [], people: [], items: [{ id: 'original-item', receipt: image }], paymentCodes: [{ kind: 'other', image }], event: { revision: 7, settlement: { version: 3 } } }, 'invoice:listen');
  await seed(page, original); await inventory(page); const before = (await vault(page))[0]!;
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '下載此舊草稿', exact: true }).click(); const bytes = await readFile((await (await pending).path())!); expect(bytes.toString()).toBe(before.raw);
  const fresh = await browser.newContext({ baseURL: origin, serviceWorkers: 'block' });
  try {
    await login(fresh); const restored = await fresh.newPage(); await inventory(restored); let writes = 0; restored.on('request', r => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method())) writes++; });
    await stage(restored, bytes.toString(), '舊結算草稿'); expect(await vault(restored)).toEqual([]); await expect(restored.getByRole('button', { name: '匯入此舊草稿', exact: true })).toBeDisabled();
    await importStaged(restored); await imported(restored); const rows = await vault(restored); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: before.id, raw: before.raw, source: original, importedEpoch: 0 });
    expect(await vault(restored, 'mappings')).toEqual([]); expect(await durableRows(restored)).toEqual([]); expect(writes).toBe(0);
    expect(await restored.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'kanban-local-v1'))).toBe(false);
    await restored.getByText('費用與憑證', { exact: true }).click(); await expect(restored.getByRole('img', { name: '舊草稿圖片', exact: true })).toHaveAttribute('src', 'data:image/png;base64,' + image);
    await restored.reload(); await expect(restored.getByRole('heading', { name: '舊結算草稿', exact: true })).toBeVisible(); expect(await vault(restored)).toEqual(rows);
    await restored.setViewportSize({ width: 360, height: 800 }); expect(await restored.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await restored.screenshot({ path: 'test-results/unified-legacy-import-mobile.png', fullPage: true });
  } finally { await fresh.close(); }
});
test('deduplicates exact files and preserves changed versions under the same source key without destination writes', async ({ page, context }) => {
  await login(context); await inventory(page); const original = draft(), raw = legacyRaw(original);
  await stage(page, raw); await importStaged(page); await imported(page); const before = await vault(page);
  await stage(page, raw); await importStaged(page); await expect(page.getByText('這份原稿已在本機，未新增副本。', { exact: true })).toBeVisible(); expect(await vault(page)).toEqual(before);
  const changed = draft({ fields: [{ name: 'id', value: '' }, { name: 'title', value: '後續原文字' }], dataset: { intent } }); await stage(page, legacyRaw(changed)); await importStaged(page); await imported(page);
  const rows = await vault(page); expect(rows).toHaveLength(2); expect(rows.map(r => r.source)).toEqual(expect.arrayContaining([original, changed])); expect(await vault(page, 'mappings')).toEqual([]); expect(await durableRows(page)).toEqual([]);
  await page.goto('/activities/new'); await expect(page.getByText(/此操作仍有舊看板原稿/)).toBeVisible();
});
test('rolls back a failed strict archive transaction and permits an exact explicit retry', async ({ page, context }) => {
  await login(context); await inventory(page); await stage(page, legacyRaw(draft()));
  await page.evaluate(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (value, key) { const r = put.call(this, value, key); if (this.name === 'snapshots') r.addEventListener('success', () => this.transaction.abort()); return r; }; (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = put; }; });
  await importStaged(page); await expect(page.getByText('無法保全舊紀錄', { exact: true })).toBeVisible(); expect(await vault(page)).toEqual([]); expect(await vault(page, 'mappings')).toEqual([]);
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut()); await page.getByRole('button', { name: '匯入此舊草稿', exact: true }).click(); await imported(page); expect(await vault(page)).toHaveLength(1);
});
test('rejects other accounts, secret fields, unsupported formats and invalid UTF-8 without keeping the previous preview', async ({ page, context }) => {
  await login(context); await inventory(page);
  const invalid = [
    legacyRaw({ ...draft(), key: 'draft:' + 'b'.repeat(64) + ':event:new' }),
    legacyRaw(draft({ fields: [{ name: 'pin', value: 'SYNTHETIC_PRIVATE' }], dataset: {} })),
    legacyRaw(draft({}, 'future-editor')), legacyRaw(draft()).slice(0, -1),
    JSON.stringify(JSON.parse(legacyRaw(draft())), null, 2), Buffer.from([0xff, 0xfe]),
  ];
  for (const raw of invalid) {
    await stage(page, legacyRaw(draft())); await choose(page, raw); await expect(page.getByText(/請保留原檔|請切換原帳號/)).toBeVisible();
    await expect(page.getByRole('button', { name: '匯入此舊草稿', exact: true })).toHaveCount(0); await expect(page.getByText('SYNTHETIC_PRIVATE', { exact: true })).toHaveCount(0); expect(await vault(page)).toEqual([]);
  }
});
for (const fence of ['account', 'device-epoch'] as const) test('rejects a staged import after ' + fence + ' changes', async ({ page, context }) => {
  await login(context); await inventory(page); await stage(page, legacyRaw(draft()));
  if (fence === 'account') await login(context, 'bob');
  else await page.evaluate(async () => { const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('qgroup-reviewed-drafts-v1'); r.onsuccess = () => resolve(r.result); }); try { await new Promise<void>(resolve => { const tx = db.transaction('epochs', 'readwrite'); tx.objectStore('epochs').put(1, 'device'); tx.oncomplete = () => resolve(); }); } finally { db.close(); } });
  await importStaged(page); if (fence === 'account') await expect(page.getByText(/此帳號在這個瀏覽器沒有舊看板紀錄/)).toBeVisible(); else await expect(page.getByText(/本機紀錄已因登出清除，請重新選擇保全檔/)).toBeVisible(); expect(await vault(page)).toEqual([]);
});
test('rejects logout during hashing and never resurrects the selected draft', async ({ page, context }) => {
  await login(context); await inventory(page); await stage(page, legacyRaw(draft()));
  await page.evaluate(() => { const digest = SubtleCrypto.prototype.digest; SubtleCrypto.prototype.digest = async function (algorithm, bytes) { (window as unknown as { hashPending: boolean }).hashPending = true; await new Promise<void>(resolve => { (window as unknown as { releaseHash: () => void }).releaseHash = resolve; }); return digest.call(this, algorithm, bytes); }; });
  await importStaged(page); await expect.poll(() => page.evaluate(() => (window as unknown as { hashPending: boolean }).hashPending)).toBe(true);
  const other = await context.newPage(); try { await other.goto('/me/accounts'); await other.getByRole('button', { name: '登出此裝置', exact: true }).click(); await expect(other.getByRole('link', { name: '登入', exact: true })).toBeVisible(); await page.evaluate(() => (window as unknown as { releaseHash: () => void }).releaseHash()); await expect(page.getByRole('heading', { name: '舊活動草稿', exact: true })).toHaveCount(0); expect(await vault(page)).toEqual([]); } finally { await other.close(); }
});
test('rejects an account change during hashing before committing the private archive', async ({ page, context }) => {
  await login(context); await inventory(page); await stage(page, legacyRaw(draft()));
  await page.evaluate(() => { const digest = SubtleCrypto.prototype.digest; SubtleCrypto.prototype.digest = async function (algorithm, bytes) { (window as unknown as { hashPending: boolean }).hashPending = true; await new Promise<void>(resolve => { (window as unknown as { releaseHash: () => void }).releaseHash = resolve; }); return digest.call(this, algorithm, bytes); }; });
  await importStaged(page); await expect.poll(() => page.evaluate(() => (window as unknown as { hashPending: boolean }).hashPending)).toBe(true); await login(context, 'bob'); await page.evaluate(() => (window as unknown as { releaseHash: () => void }).releaseHash());
  await expect(page.getByText(/此帳號在這個瀏覽器沒有舊看板紀錄/)).toBeVisible(); expect(await vault(page)).toEqual([]);
});
test('permits deliberate restoration after logout, keeps automatic old-page import disabled, and converts the restored intent once', async ({ page, context }) => {
  await login(context); await page.goto('/login?mode=bind&returnTo=%2Fme%2Faccounts'); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '前往 QQ 授權綁定', exact: true }).click(); await page.getByRole('button', { name: '確認綁定', exact: true }).click(); await expect(page).toHaveURL('/me/accounts');
  await inventory(page); const original = activity(), raw = legacyRaw(original); await stage(page, raw);
  await page.goto('/me/accounts'); await page.getByRole('button', { name: '登出此裝置', exact: true }).click(); await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await page.goto('/login?returnTo=%2Fme%2Flocal-history'); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '前往 QQ 登入', exact: true }).click(); await page.getByRole('button', { name: '確認登入', exact: true }).click(); await expect(page).toHaveURL('/me/local-history');
  expect((await (await context.request.get('/api/v2/session')).json()).scope).toBe(scope); await inventory(page); await expect(page.getByText(/舊分頁不能自動寫回/)).toBeVisible();
  await seed(page, draft({ fields: [], dataset: {} }, 'copy:listen')); await inventory(page); expect(await vault(page)).toEqual([]);
  await stage(page, raw); await importStaged(page); await imported(page); expect(await vault(page)).toHaveLength(1); await expect(page.getByText(/舊分頁不能自動寫回/)).toBeVisible();
  const card = page.getByRole('heading', { name: '舊活動草稿', exact: true }).locator('..'); await card.getByRole('button', { name: '檢查此舊稿的轉換', exact: true }).click(); await expect(card.getByLabel('轉換時間核對')).toBeVisible();
  await card.getByRole('checkbox', { name: '已核對原資料、結果與時區；只帶入表單，尚未送出', exact: true }).check(); await card.getByRole('button', { name: '保全並帶入新版表單', exact: true }).click(); await expect(card.getByText('此原稿已轉換。', { exact: false })).toBeVisible();
  const maps = await vault(page, 'mappings'), destinations = await durableRows(page); expect(maps).toHaveLength(1);
  await stage(page, raw); await importStaged(page); await expect(page.getByText('這份原稿已在本機，未新增副本。', { exact: true })).toBeVisible(); expect(await vault(page, 'mappings')).toEqual(maps); expect(await durableRows(page)).toEqual(destinations);
  await card.getByRole('link', { name: '開啟目的原稿', exact: true }).click(); await page.getByRole('button', { name: '恢復本機原稿', exact: true }).click(); await expect(page.getByLabel('活動名稱', { exact: true })).toHaveValue('匯入活動'); await expect(page.getByLabel('活動說明', { exact: true })).toHaveValue('原說明\n第二行');
  let writes = 0, payload: unknown; page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/activities/drafts')) { writes++; payload = r.postDataJSON(); } }); await page.getByRole('button', { name: '建立活動草稿', exact: true }).click(); await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/); expect(writes).toBe(1); expect(payload).toMatchObject({ clientIntent: intent });
});
test('leaving the import page during hashing cannot finish an archive write', async ({ page, context }) => {
  await login(context); await inventory(page); await stage(page, legacyRaw(draft()));
  await page.evaluate(() => { const digest = SubtleCrypto.prototype.digest; SubtleCrypto.prototype.digest = async function (algorithm, bytes) { (window as unknown as { hashPending: boolean }).hashPending = true; await new Promise<void>(resolve => { (window as unknown as { releaseHash: () => void }).releaseHash = resolve; }); return digest.call(this, algorithm, bytes); }; });
  await importStaged(page); await expect.poll(() => page.evaluate(() => (window as unknown as { hashPending: boolean }).hashPending)).toBe(true);
  await page.getByRole('link', { name: '活動', exact: true }).first().click(); await expect(page).toHaveURL('/activities');
  const checked = page.waitForResponse(r => r.url().endsWith('/api/v2/session')); await page.evaluate(() => (window as unknown as { releaseHash: () => void }).releaseHash()); await checked; expect(await vault(page)).toEqual([]);
  await inventory(page); await expect(page.getByRole('heading', { name: '舊活動草稿', exact: true })).toHaveCount(0); expect(await vault(page)).toEqual([]);
});
