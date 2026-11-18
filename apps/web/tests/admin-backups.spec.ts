import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin = 'http://127.0.0.1:5082';
const confirm = '確認下載並保管私人資料';
async function login(context: BrowserContext, user = 'registration-admin') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function open(page: Page, context: BrowserContext) { await login(context); await page.goto('/admin'); await page.getByRole('link', { name: '成分匯出與歷史備份', exact: true }).click(); await expect(page.getByRole('button', { name: '更新備份清單', exact: true })).toBeEnabled(); }
async function download(page: Page, historical = false) {
  const promise = page.waitForEvent('download');
  await (historical ? page.getByRole('button', { name: /^下載 \d/ }).first() : page.getByRole('button', { name: '下載目前成分 JSON', exact: true })).click();
  const result = await promise, path = await result.path(); expect(result.suggestedFilename()).toMatch(/^music-data-.*\.json$/); return JSON.parse(readFileSync(path!, 'utf8'));
}
test.describe('persistent paired backups', () => {
  test.use({ backupExamples: true });
  test('downloads current and historical JSON with a privacy confirmation, no admin credential and no browser persistence on mobile', async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 800 }); await open(page, context);
    await expect(page.getByRole('button', { name: '下載目前成分 JSON', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: /^下載 \d/ })).toHaveCount(1);
    await page.getByRole('checkbox', { name: confirm, exact: true }).check(); const current = await download(page), history = await download(page, true);
    expect(current).toEqual(history); expect(Object.keys(current.members)).toContain('10001'); expect(current.members['10001'].note).toBeDefined(); expect(current.settings).toEqual({});
    expect(JSON.stringify(current)).not.toMatch(/adminPasswordHash|token_hash|fixture-registration-admin/);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toMatch(/pinHash|contactQQ|"members"/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/unified-backups-mobile.png', fullPage: true });
  });
  test('historical download retains the old profile but applies a later explicit contact clearing', async ({ page, context }) => {
    await login(context, 'alice'); await page.goto('/me/music/contact');
    // The synthetic linked member has an imported contact; clearing is an explicit write.
    const state = await page.evaluate(async () => { const viewer = await (await fetch('/api/v2/session')).json(); const contact = await (await fetch('/api/v2/me/music/contact', { headers: { 'X-Account-Scope': viewer.scope } })).json(); return { viewer, contact }; });
    const result = await context.request.put('/api/v2/me/music/contact', { headers: { Origin: origin, 'X-Account-Scope': state.viewer.scope, 'X-CSRF-Token': state.viewer.csrf, 'Idempotency-Key': crypto.randomUUID() }, data: { contactQQ: '', revision: state.contact.revision, profileId: state.contact.profileId, musicEpoch: state.viewer.musicEpoch } });
    expect(result.status(), await result.text()).toBe(200);
    await open(page, context); await page.getByRole('checkbox', { name: confirm, exact: true }).check(); const history = await download(page, true);
    expect(history.members[state.contact.profileId].contactQQ).toBe('');
  });
  test('a failed download is retryable and revalidates authority before releasing a received file', async ({ page, context }) => {
    await open(page, context); await page.getByRole('checkbox', { name: confirm, exact: true }).check(); let fail = true;
    await page.route('**/api/v2/admin/music-export', async route => { if (fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'BACKUP_UNAVAILABLE', message: '合成備份無法驗證' }) }); } await route.continue(); });
    await page.getByRole('button', { name: '下載目前成分 JSON', exact: true }).click(); await expect(page.getByRole('status')).toContainText('合成備份無法驗證'); await download(page);
    let release!: () => void, arrived!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { arrived = resolve; }); let files = 0; page.on('download', () => { files++; });
    await page.unroute('**/api/v2/admin/music-export'); await page.route('**/api/v2/admin/music-export', async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); });
    await page.getByRole('button', { name: '下載目前成分 JSON', exact: true }).click(); await started; await login(context, 'bob'); release();
    await expect(page.getByLabel('管理救援憑證', { exact: true })).toBeVisible(); expect(files).toBe(0); await expect(page.getByRole('button', { name: '下載目前成分 JSON', exact: true })).toHaveCount(0);
  });
  test('leaving during a pending download cancels delivery and rescue administrators can download without a music profile', async ({ page, context }) => {
    await open(page, context); await page.getByRole('checkbox', { name: confirm, exact: true }).check();
    let release!: () => void, arrived!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { arrived = resolve; }); let files = 0; page.on('download', () => { files++; });
    await page.route('**/api/v2/admin/music-export', async route => { const response = await route.fetch(); arrived(); await gate; try { await route.fulfill({ response }); } catch { /* The navigation aborts this request. */ } });
    await page.getByRole('button', { name: '下載目前成分 JSON', exact: true }).click(); await started; await page.getByRole('link', { name: '管理後臺', exact: true }).click(); release(); await expect(page.getByRole('heading', { name: '管理後臺', exact: true })).toBeVisible(); expect(files).toBe(0);
    await page.unroute('**/api/v2/admin/music-export'); await login(context, 'bob'); await page.goto('/admin/backups'); await page.getByLabel('管理救援憑證', { exact: true }).fill('synthetic-admin-rescue-' + 'x'.repeat(32)); await page.getByRole('button', { name: '使用救援憑證登入', exact: true }).click();
    await page.getByRole('checkbox', { name: confirm, exact: true }).check(); expect(Object.keys((await download(page)).members)).toContain('10001');
  });
});
test('an isolated in-memory instance explains unavailable history while retaining current export', async ({ page, context }) => {
  await open(page, context); await expect(page.getByText('目前未啟用持久配對備份。', { exact: true })).toBeVisible(); await page.getByRole('checkbox', { name: confirm, exact: true }).check(); expect((await download(page)).entries).toBeDefined();
});
