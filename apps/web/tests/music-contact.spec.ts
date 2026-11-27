import { toggleMusicTerm, expectMusicTerm, openMusicContact, expectControlValue } from './kimi-controls';
import { test, expect } from './fixtures';
import { durableRows, denyDraftWrites, damageDraft } from './draft-helpers';
import type { BrowserContext, Page } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context: BrowserContext, user = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function seed(context: BrowserContext, user = 'alice') {
  await login(context, user); const viewer = await (await context.request.get('/api/v2/session')).json();
  const headers = { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() };
  const profile = await (await context.request.put('/api/v2/me/music', { headers, data: { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'sub-2', level: 4 }] } })).json();
  return { viewer, profile, headers };
}
const input = (page: Page) => page.getByLabel('聯絡 QQ', { exact: true });
async function save(page: Page, number: string) { await input(page).fill(number); await page.getByRole('button', { name: '保存聯絡 QQ', exact: true }).click(); }
test('a member edits, finds, copies and clears a contact while keeping the same music and one navigation flow', async ({ page, context }) => {
  const { profile, viewer } = await seed(context);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => Object.assign(window, { copiedContact: text }) }, configurable: true }));
  await page.goto('/me/music'); await openMusicContact(page);
  await save(page, '123456'); await expect(page.getByText('已保存聯絡 QQ。', { exact: true })).toBeVisible();
  await expect(page.getByText('123456', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '複製 QQ', exact: true }).click(); await expect(page.getByText('已複製 QQ。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copiedContact: string }).copiedContact)).toBe('123456');
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-contact-mobile.png', fullPage: true });
  await page.getByRole('link', { name: '回到我的成分', exact: true }).click();
  await expectMusicTerm(page,'Aimer',true); await expect(page.getByRole('button', { name: '保存我的成分', exact: true }).and(page.locator(':enabled'))).toHaveCount(0);
  await page.getByRole('navigation',{name:'手機主要導覽',exact:true}).getByRole('link', { name: '同好', exact: true }).or(page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('link', { name: '同好', exact: true })).click();await page.getByRole('tab',{name:'查詢／比較',exact:true}).click();
  await page.getByLabel('QQ', { exact: true }).fill('123456'); await page.getByRole('button', { name: '查詢成分', exact: true }).click();
  await expect(page).toHaveURL('/people/' + profile.id + '?from=%2Fpeople%3Ftab%3Dsearch'); await expect(page.locator('.profile-person-name')).toHaveText('小青'); await page.locator(".profile-all-picks .disclosure-trigger").click();await expect(page.getByText('Aimer · 本命', { exact: true })).toBeVisible();
  await page.goto('/me/music/contact'); await save(page, ''); await expect(page.getByText('已保存聯絡 QQ。', { exact: true })).toBeVisible(); await expect(page.getByText('尚未填寫 QQ。', { exact: true })).toBeVisible();
  await page.goto('/people?tab=search'); await page.getByLabel('QQ', { exact: true }).fill('123456'); await page.getByRole('button', { name: '查詢成分', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('找不到這份成分，請核對 QQ');
  const after = await (await context.request.get('/api/v2/me/music', { headers: { 'X-Account-Scope': viewer.scope } })).json(); expect(after.id).toBe(profile.id); expect(after.selections).toEqual(profile.selections);
});
test('a malformed success response retains the exact contact operation through reload and confirms the latest value', async ({ page, context }) => {
  const { headers, profile } = await seed(context); const keys: string[] = []; const bodies: unknown[] = []; let first = true;
  await page.route('**/api/v2/me/music/contact', async route => {
    if (route.request().method() !== 'PUT') return route.continue(); keys.push(route.request().headers()['idempotency-key']!); bodies.push(route.request().postDataJSON());
    const response = await route.fetch(); if (first) { first = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response });
  });
  await page.goto('/me/music/contact'); await save(page, '123456'); await expect(page.getByText('尚未確認保存結果。操作編號已保留，請按「確認聯絡 QQ 結果」安全重試。', { exact: true })).toBeVisible(); await expect(input(page)).toBeDisabled();
  const remote = await context.request.put('/api/v2/me/music/contact', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { profileId: profile.id, musicEpoch: 0, revision: 1, contactQQ: '998877' } }); expect(remote.status()).toBe(200);
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await page.getByRole('button', { name: '確認聯絡 QQ 結果', exact: true }).click();
  await expect(page.getByText('原操作已保存，聯絡 QQ 已再次變更；請核對目前資料。', { exact: true })).toBeVisible(); await expectControlValue(input(page), '998877'); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(bodies[0]).toEqual(bodies[1]);
});
test('conflicting contact edits retain input and require an explicit read before overwriting', async ({ page, context, browser }) => {
  await seed(context); const remote = await browser.newContext({ baseURL: origin }); await login(remote);
  try {
    await page.goto('/me/music/contact'); await input(page).fill('654321');
    const other = await remote.newPage(); await other.goto('/me/music/contact'); await save(other, '123456'); await expect(other.getByText('已保存聯絡 QQ。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存聯絡 QQ', exact: true }).click(); await expect(page.getByText('聯絡 QQ 已變更；請核對目前資料後再保存', { exact: true })).toBeVisible(); await expectControlValue(input(page), '654321');
    await page.getByRole('button', { name: '核對目前聯絡 QQ，保留輸入', exact: true }).click(); await expect(page.getByText('123456', { exact: true })).toBeVisible(); await expectControlValue(input(page), '654321');
    await page.getByRole('button', { name: '保存聯絡 QQ', exact: true }).click(); await expect(page.getByText('已保存聯絡 QQ。', { exact: true })).toBeVisible();
  } finally { await remote.close(); }
});
test('a switched account rejects the old contact draft and keeps both account inputs separate', async ({ page, context }) => {
  await seed(context, 'bob'); await seed(context, 'alice'); await page.goto('/me/music/contact'); await input(page).fill('123456');
  await login(context, 'bob'); await page.getByRole('button', { name: '保存聯絡 QQ', exact: true }).click(); await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號', { exact: true })).toBeVisible();
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await expect(page.locator('.viewer')).toHaveText('小白'); await expectControlValue(input(page), '');
  await login(context); await page.reload(); await expectControlValue(input(page), '123456');
});
test('blocked storage prevents sending and damaged or invalid contact drafts remain recoverable', async ({ page, context }) => {
  await seed(context); let writes = 0; page.on('request', request => { if (request.method() === 'PUT') writes++; });
  await page.goto('/me/music/contact');await denyDraftWrites(page,'music:contact:'); await save(page, '123456'); await expect(page.getByText('無法保存原稿及操作編號，尚未送出。', { exact: true })).toBeVisible(); expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/me/music/contact');await input(clean).fill('123456');await expect(clean.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await damageDraft(clean,'music:contact:','damaged synthetic contact');clean.on('dialog',dialog=>void dialog.accept());await clean.reload();await expect(input(clean)).toBeDisabled();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged synthetic contact');await expect(input(clean)).toBeEnabled(); await input(clean).fill('not-a-number'); await clean.reload(); await expectControlValue(input(clean), 'not-a-number'); await expect(clean.getByText('無法讀取聯絡 QQ 草稿', { exact: false })).toHaveCount(0); await clean.close();
});
test('member cards offer manual copy recovery and visitors cannot read or query contacts', async ({ page, context }) => {
  const { profile, headers } = await seed(context);
  expect((await context.request.put('/api/v2/me/music/contact', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { profileId: profile.id, musicEpoch: 0, revision: 0, contactQQ: '123456' } })).status()).toBe(200);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('synthetic denial'); } }, configurable: true }));
  await page.goto('/people/' + profile.id); await page.getByRole('button', { name: '複製 QQ', exact: true }).click(); await expect(page.getByText('無法自動複製，請選取號碼手動複製。', { exact: true })).toBeVisible();
  await context.clearCookies(); await page.reload(); await expect(page.getByText('123456', { exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await page.goto('/people'); await expect(page.getByRole('button', { name: '查詢成分', exact: true })).toHaveCount(0);
});
test('editing a contact preserves an unfinished selection draft and requires a fresh revision before saving it', async ({ page, context }) => {
  await seed(context); await page.goto('/me/music'); await toggleMusicTerm(page,'YOASOBI');
  await openMusicContact(page); await expect(page.getByRole('heading', { name: '尚未提交的修改', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click(); await save(page, '123456'); await expect(page.getByText('已保存聯絡 QQ。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回到我的成分', exact: true }).click(); await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click(); await expectMusicTerm(page,'YOASOBI',true);
  await expect(page.getByRole('button', { name: '保存我的成分', exact: true })).toBeDisabled(); await expect(page.getByText('成分版本不同，尚未保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核對最新版本，保留我的選擇', exact: true }).click(); await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await expectMusicTerm(page,'Aimer',true); await expectMusicTerm(page,'YOASOBI',true);
});
test('music erasure clears another tab contact draft and a rebuilt profile begins with no contact', async ({ page, context }) => {
  await seed(context); await page.goto('/me/music/contact'); await input(page).fill('123456');
  const privacy = await context.newPage(); await privacy.goto('/me/privacy'); await privacy.getByRole('radio', { name: '只刪除成分', exact: true }).check();
  await privacy.getByRole('checkbox', { name: '我已確認範圍，瞭解此操作無法復原', exact: true }).check(); await privacy.getByRole('button', { name: '確認刪除成分', exact: true }).click();
  await expect(input(page)).toHaveCount(0); await expect(page.getByText('請先保存成分，再設定聯絡 QQ', { exact: true })).toBeVisible();
  expect((await durableRows(page)).filter(row=>row.key.includes('qgroup:rebuild:music:'))).toEqual([]);expect(await durableRows(page,'versions')).toEqual([]);
  await page.getByRole('link', { name: '回到我的成分', exact: true }).click(); await toggleMusicTerm(page,'Aimer'); await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await openMusicContact(page); await expectControlValue(input(page), ''); await privacy.close();
});
test('a signed-in account without music gets an actionable entry and cannot query member contacts', async ({ page, context }) => {
  await login(context); await page.goto('/people'); await expect(page.getByRole('button', { name: '查詢成分', exact: true })).toHaveCount(0);
  await expect(page.getByText('請先保存成分，再查看同好成分。',{exact:true})).toBeVisible(); await page.getByRole('link', { name: '保存成分', exact: true }).click();
  await toggleMusicTerm(page,'Aimer'); await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.getByRole('navigation',{name:'手機主要導覽',exact:true}).getByRole('link', { name: '同好', exact: true }).or(page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('link', { name: '同好', exact: true })).click();await page.getByRole('tab',{name:'查詢／比較',exact:true}).click(); await expect(page.getByRole('button', { name: '查詢成分', exact: true })).toBeVisible();
});
