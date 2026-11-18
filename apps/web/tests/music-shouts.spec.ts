import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { damageDraft,denyDraftWrites,durableRows } from './draft-helpers';
const origin = 'http://127.0.0.1:5082';
test.use({ musicShouts: true });
async function login(context: BrowserContext, user = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function refresh(page: Page) { await page.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('refresh'); channel.close(); }); }
const list = (page: Page) => page.getByRole('region', { name: '目前找搭子名單', exact: true });
const detail = (page: Page) => page.getByRole('region', { name: '找搭子內容', exact: true });
test('guests and accounts without saved music use the shared gate without reading private shouts', async ({ page, context }) => {
  let reads = 0, writes = 0;
  page.on('request', request => { if (request.url().includes('/api/v2/music/shouts')) reads++; if (request.url().includes('/api/') && request.method() === 'POST') writes++; });
  await page.goto('/people'); await page.getByRole('link', { name: '找搭子', exact: true }).click();
  await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await login(context, 'auth-owner'); await refresh(page); await expect(page.getByRole('link', { name: '保存成分', exact: true })).toBeVisible();
  expect(reads).toBe(0); expect(writes).toBe(0);
});
test('details, author profiles, clipboard fallbacks and all history pages preserve the return path on mobile', async ({ page, context }) => {
  await login(context); await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('synthetic denied clipboard'); } } }));
  await page.goto('/people/shouts'); await list(page).getByRole('link', { name: '週末一起聽音樂', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(detail(page)).toContainText('234567 · 自填號碼，未經騰訊驗證');
  await page.getByRole('button', { name: '複製找搭子內容', exact: true }).click(); await expect(page.getByText('無法自動複製，請選取找搭子內容手動複製。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '複製聯絡 QQ', exact: true }).click(); await expect(page.getByText('無法自動複製，請選取號碼手動複製。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '查看發布者成分', exact: true }).click(); await page.getByRole('link', { name: '比較成分', exact: true }).click();
  await page.getByRole('link', { name: '查看同好成分', exact: true }).click(); await page.getByRole('link', { name: '回到找搭子', exact: true }).click();
  await expect(detail(page)).toContainText('週末一起聽音樂'); await page.getByRole('link', { name: '回到找搭子', exact: true }).click();
  await page.getByRole('link', { name: '找搭子歷史', exact: true }).click(); await expect(page.getByRole('heading', { name: '歷史 · 25 則', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一頁', exact: true }).click(); await page.getByRole('button', { name: '下一頁', exact: true }).click();
  await page.getByRole('link', { name: '未關聯舊發布內容', exact: true }).click(); await expect(detail(page)).toContainText('發布者成分已不存在，無法提供目前聯絡資料。');
  await page.getByRole('link', { name: '回到找搭子歷史', exact: true }).click(); await expect(page).toHaveURL('/people/shouts/history?offset=20');
  await expect(page.getByRole('button', { name: '下一頁', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-music-shouts-mobile.png', fullPage: true });
  await expect(page.getByText(/不可匯出|已不存在的私人識別/)).toHaveCount(0);
});
test('drafts survive explicit navigation and reload; Unicode limits, publication and cooldown stay consistent', async ({ page, context }) => {
  await login(context); await page.goto('/people/shouts'); await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('草稿保留');
  await page.getByRole('link', { name: '回到同好', exact: true }).click(); await expect(page.getByText('仍有未完成原稿。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click(); await page.getByRole('link', { name: '找搭子', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '找搭子內容', exact: true })).toHaveValue('草稿保留'); await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click(); page.on('dialog', dialog => void dialog.accept()); await page.reload();
  await expect(page.getByRole('textbox', { name: '找搭子內容', exact: true })).toHaveValue('草稿保留'); await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('\u0085\u001c'); await expect(page.getByRole('button', { name: '發布找搭子', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('\ufeff'); await expect(page.getByRole('button', { name: '發布找搭子', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('𠀀'.repeat(141));
  await expect(page.getByRole('button', { name: '發布找搭子', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('  '+'𠀀'.repeat(140)+'\n\u0085 '); await page.getByRole('button', { name: '發布找搭子', exact: true }).click();
  await expect(page.getByText('已發布。', { exact: true })).toBeVisible(); await expect(page.getByRole('textbox', { name: '找搭子內容', exact: true })).toHaveValue('');
  await expect(list(page).getByRole('link', { name: '𠀀'.repeat(140), exact: true })).toBeVisible(); await expect(page.getByText('下次可發布：', { exact: false })).toBeVisible();
  await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('冷卻期間的新草稿'); await expect(page.getByRole('button', { name: '發布找搭子', exact: true })).toBeDisabled();
});
test('lost publication responses keep the exact operation across reload and do not publish twice', async ({ page, context }) => {
  await login(context); const keys: string[] = []; let fail = true;
  await page.route('**/api/v2/me/music/shouts', async route => { keys.push(route.request().headers()['idempotency-key']!); const response = await route.fetch(); if (fail) { fail = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response }); });
  await page.goto('/people/shouts'); await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('安全重試的一則'); await page.getByRole('button', { name: '發布找搭子', exact: true }).click();
  await expect(page.getByText('尚未確認發布結果。', { exact: false })).toBeVisible(); await expect(page.getByRole('textbox', { name: '找搭子內容', exact: true })).toBeDisabled();
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await page.getByRole('button', { name: '確認發布結果', exact: true }).click();
  await expect(page.getByText('已發布。', { exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  await expect(list(page).getByRole('link', { name: '安全重試的一則', exact: true })).toHaveCount(1);
});
test('administrators recover an unknown deletion even after the detail is gone and can moderate history', async ({ page, context }) => {
  await login(context, 'registration-admin'); const keys: string[] = []; let fail = true;
  await page.route('**/api/v2/admin/shouts/*/delete', async route => { keys.push(route.request().headers()['idempotency-key']!); const response = await route.fetch(); if (fail) { fail = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response }); });
  await page.goto('/admin'); await page.getByRole('link', { name: '找搭子管理', exact: true }).click(); await page.getByRole('button', { name: '移除這則內容', exact: true }).click();
  await page.getByRole('checkbox', { name: '確認永久移除這則內容，發布者資料不會保留在刪除紀錄中', exact: true }).check(); await page.getByRole('button', { name: '確認刪除找搭子', exact: true }).click();
  await expect(page.getByText('尚未確認刪除結果。', { exact: false })).toBeVisible(); page.on('dialog', dialog => void dialog.accept()); await page.reload();
  await page.getByRole('button', { name: '確認刪除結果', exact: true }).click(); await expect(page.getByText('已刪除找搭子內容。', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); await expect(page.getByText('這一頁沒有找搭子內容。', { exact: true })).toBeVisible();
  await page.getByLabel('找搭子範圍', { exact: true }).selectOption('history'); await expect(page.getByRole('heading', { name: '歷史 · 25 則', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '移除這則內容', exact: true }).first().click(); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '確認刪除找搭子', exact: true }).click();
  await expect(page.getByRole('heading', { name: '歷史 · 24 則', exact: true })).toBeVisible();
});
test('damaged drafts are preserved and unavailable storage prevents publication', async ({ page, context }) => {
  await login(context); await page.goto('/people/shouts'); await expect(page.getByRole('textbox', { name: '找搭子內容', exact: true })).toBeVisible();
  await page.getByRole('textbox',{name:'找搭子內容',exact:true}).fill('損壞前的原稿');await damageDraft(page,':shout:','damaged shout draft');page.on('dialog',dialog=>void dialog.accept());await page.reload();
  await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'發布找搭子',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(page,'versions')).map(row=>row.raw)).toContain('damaged shout draft');
  await denyDraftWrites(page,':shout:');let writes=0;page.on('request',request=>{if(request.method()==='POST')writes++;});await page.getByRole('textbox',{name:'找搭子內容',exact:true}).fill('不可遺失');await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();await page.getByRole('button',{name:'發布找搭子',exact:true}).click();await expect(page.getByText('無法保存原稿及操作編號，尚未發布。',{exact:true})).toBeVisible();expect(writes).toBe(0);
});
test('late responses do not cross account changes and cross-tab erasure removes drafts and private details', async ({ page, context }) => {
  await login(context); let arrived!: () => void, release!: () => void; const captured = new Promise<void>(resolve => { arrived = resolve; }), pending = new Promise<void>(resolve => { release = resolve; }); let hold = true;
  await page.route('**/api/v2/music/shouts?*', async route => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); arrived(); await pending; await route.fulfill({ response }).catch(() => {}); });
  await page.goto('/people/shouts'); await captured; await login(context, 'auth-owner'); await refresh(page); await expect(page.getByRole('link', { name: '保存成分', exact: true })).toBeVisible(); release(); await expect(list(page)).toHaveCount(0);
  await login(context); await refresh(page); await page.getByRole('textbox', { name: '找搭子內容', exact: true }).fill('跨分頁刪除的草稿');
  const privacy = await context.newPage(); await privacy.goto('/me/privacy'); await privacy.getByRole('radio', { name: '只刪除成分', exact: true }).check(); await privacy.getByRole('checkbox', { name: '我已確認範圍，瞭解此操作無法復原', exact: true }).check(); await privacy.getByRole('button', { name: '確認刪除成分', exact: true }).click();
  await expect(page.getByRole('link', { name: '保存成分', exact: true })).toBeVisible(); await expect(list(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('qgroup:rebuild:music:shout:')))).toEqual([]); expect((await durableRows(page)).filter(row=>row.key.includes(':shout:'))).toEqual([]); await privacy.close();
});
test('failed refreshes hide old private results and offer a retry; unsafe return paths are discarded', async ({ page, context }) => {
  await login(context); let fail = false; await page.route('**/api/v2/music/shouts?*', route => fail ? route.fulfill({ status: 503, json: { code: 'FAIL', message: '找搭子暫時無法讀取' } }) : route.continue());
  await page.goto('/people/shouts'); await expect(list(page)).toContainText('週末一起聽音樂'); fail = true; await refresh(page);
  await expect(page.getByRole('alert')).toContainText('找搭子暫時無法讀取'); await expect(list(page)).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await expect(list(page)).toContainText('週末一起聽音樂');
  await page.goto('/people/shouts/shout-bob?from=%2F%2Fevil.example'); await expect(page.getByRole('link', { name: '回到找搭子', exact: true })).toHaveAttribute('href', '/people/shouts');
});
