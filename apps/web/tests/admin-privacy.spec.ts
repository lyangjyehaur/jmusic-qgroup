import { randomBytes, randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { durableRows, denyDraftWrites, damageDraft } from './draft-helpers';
const origin = 'http://127.0.0.1:5082';
async function login(context: BrowserContext) { await context.addCookies([{ name: 'kanban_session', value: 'fixture-registration-admin', url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function closeMember(browser: Browser, shared: boolean) {
  const member = await browser.newContext({ baseURL: origin });
  try {
    await member.addCookies([{ name: 'kanban_session', value: 'fixture-bob', url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const viewer = await (await member.request.get('/api/v2/session')).json();
    const headers = { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf };
    if (shared) expect((await member.request.put('/api/v2/me/music', { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'sub-2', level: 2 }] } })).ok()).toBe(true);
    const profile = await (await member.request.get('/api/v2/me/music', { headers })).json(); const requestId = randomUUID();
    const response = await member.request.post('/api/v2/me/privacy/erase', { headers, data: { requestId, secret: randomBytes(32).toString('hex'), target: 'account', confirm: true, profileId: profile?.id ?? null, profileRevision: profile?.revision ?? 0 } });
    expect(response.ok()).toBe(true); expect((await response.json()).status).toBe(shared ? 'shared_review' : 'completed'); return requestId;
  } finally { await member.close(); }
}
async function fillReview(page: Page, note: string) { await page.getByLabel('處理說明', { exact: true }).fill(note); await page.getByRole('checkbox', { name: '確認已核對目前保留範圍與處理說明', exact: true }).check(); }
test('administrators inspect retained records and save a note without claiming that shared history was erased', async ({ page, context, browser }) => {
  await login(context); await page.goto('/admin/privacy'); await expect(page.getByText('目前沒有刪除申請。', { exact: true })).toBeVisible();
  const id = await closeMember(browser, true); await page.reload(); await page.getByRole('link', { name: id, exact: true }).click();
  await expect(page.getByText('成分歷史：1', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存處理說明', exact: true })).toBeDisabled();
  await fillReview(page, '共享歷史保留，待核對。<script>'); await page.getByRole('button', { name: '保存處理說明', exact: true }).click();
  await expect(page.getByText('處理說明已保存，請核對目前狀態。', { exact: true })).toBeVisible(); await expect(page.getByText('申請狀態：共享紀錄待審', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/unified-admin-privacy-mobile.png', fullPage: true });
  expect(await page.locator('script').filter({ hasText: '共享歷史保留' }).count()).toBe(0); await page.getByRole('link', { name: '回到刪除申請', exact: true }).click(); await expect(page.getByText('處理說明：共享歷史保留，待核對。<script>', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: id, exact: true }).click(); await expect(page.getByLabel('處理說明', { exact: true })).toHaveValue('共享歷史保留，待核對。<script>'); await page.getByRole('link', { name: '回到刪除申請', exact: true }).click(); await expect(page.getByText('共 1 筆申請', { exact: true })).toBeVisible();
});
test('an unknown review result survives reload with the original operation key and completes only an empty retained scope', async ({ page, context, browser }) => {
  const id = await closeMember(browser, false); await login(context); await page.goto('/admin/privacy/' + id); const keys: string[] = []; let corrupt = true;
  await page.route('**/api/v2/admin/privacy/' + id + '/review', async route => { keys.push(route.request().headers()['idempotency-key']!); const response = await route.fetch(); if (corrupt) { corrupt = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response }); });
  await fillReview(page, '已核對目前無共享紀錄'); await page.getByRole('button', { name: '保存處理說明', exact: true }).click(); await expect(page.getByText('尚未確認審核結果。', { exact: false })).toBeVisible(); await expect(page.getByLabel('處理說明', { exact: true })).toBeDisabled();
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await page.getByRole('button', { name: '確認審核結果', exact: true }).click();
  await expect(page.getByText('處理說明已保存，請核對目前狀態。', { exact: true })).toBeVisible(); await expect(page.getByText('申請狀態：已完成', { exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
});
test('competing review notes require an explicit fresh assessment and preserve the original input', async ({ page, context, browser }) => {
  const id = await closeMember(browser, true); await login(context);const otherContext=await browser.newContext({baseURL:origin});await login(otherContext);const other=await otherContext.newPage();
  await page.goto('/admin/privacy/' + id); await other.goto('/admin/privacy/' + id); await fillReview(page, '我的待審說明'); await fillReview(other, '另一管理頁的說明'); await other.getByRole('button', { name: '保存處理說明', exact: true }).click(); await expect(other.getByText('處理說明已保存，請核對目前狀態。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存處理說明', exact: true }).click(); await expect(page.getByText('申請或共享紀錄已變更，請核對目前資料', { exact: true })).toBeVisible(); await expect(page.getByLabel('處理說明', { exact: true })).toHaveValue('我的待審說明');
  await page.getByRole('button', { name: '核對目前範圍，保留說明', exact: true }).click(); await expect(page.getByRole('checkbox')).not.toBeChecked(); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '保存處理說明', exact: true }).click(); await expect(page.getByText('處理說明已保存，請核對目前狀態。', { exact: true })).toBeVisible(); await otherContext.close();
});
test('unwritable and damaged review drafts block writes, preserve recovery data and clear on cross-tab admin logout', async ({ page, context, browser }) => {
  const id = await closeMember(browser, true); await login(context); let writes = 0;
  await page.goto('/admin/privacy/'+id);await denyDraftWrites(page,'admin-privacy:');page.on('request',request=>{if(request.method()==='POST')writes++;});
  await fillReview(page,'未送出的核對說明');await page.getByRole('button',{name:'保存處理說明',exact:true}).click();await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/admin/privacy/'+id);await clean.getByLabel('處理說明',{exact:true}).fill('保全前說明');await expect(clean.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
  await damageDraft(clean,'admin-privacy:','damaged synthetic review');clean.on('dialog',dialog=>void dialog.accept());await clean.reload();await expect(clean.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();
  await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged synthetic review');
  const logout = await context.newPage(); await logout.goto('/admin'); await logout.getByRole('checkbox').check(); await logout.getByRole('button', { name: '登出管理', exact: true }).click();
  await expect(clean.getByLabel('管理救援憑證', { exact: true })).toBeVisible(); await expect.poll(async()=>(await durableRows(clean)).filter(row=>row.key.startsWith('qgroup:rebuild:admin-'))).toEqual([]);expect(await durableRows(clean,'versions')).toEqual([]); await clean.close(); await logout.close();
});
