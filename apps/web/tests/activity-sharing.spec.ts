import { expectControlValue, selectControl } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context: BrowserContext, id = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + id, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function headers(context: BrowserContext) { const viewer = await (await context.request.get('/api/v2/session')).json(); return { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() }; }
async function published(context: BrowserContext, invitation = false) {
  await login(context);
  const draft = await (await context.request.post('/api/v2/activities/drafts', { headers: await headers(context), data: { values: { title: '分享原名 台灣音乐 <b>字</b>', category: '约K', location: '原地點 &keyword=其他 #地址', startsAt: '2099-12-12T23:00:00+09:00', deadline: '2099-12-11T23:00:00+09:00', timezone: 'Asia/Tokyo', durationHours: 3, capacity: 5, description: '用戶原文\n第二行', feePolicy: '原費用規則', visibility: invitation ? 'invitation' : 'public' } } })).json();
  expect((await context.request.post('/api/v2/activities/' + draft.id + '/draft/publish', { headers: await headers(context), data: { revision: draft.revision, confirm: true, acceptConditions: true } })).status()).toBe(200);
  return draft.id as string;
}
async function clipboard(page: Page, mode = 'success') {
  await page.addInitScript(mode => {
    const state = window as unknown as { copied: string[]; finishCopy: () => void };
    state.copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : { writeText(text: string) { state.copied.push(text); if (mode === 'throw') throw Error('synthetic failure'); if (mode === 'reject') return Promise.reject(Error('synthetic denial')); if (mode === 'delay') return new Promise<void>(resolve => { state.finishCopy = resolve; }); return Promise.resolve(); } } });
  }, mode);
}
test("public activity .disclosure-trigger preserves original values, cross-day times and permission-free copying", async ({ page, context }) => {
  const id = await published(context); await context.clearCookies(); await clipboard(page);
  let writes = 0; page.on('request', request => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes++; });
  await page.goto('/activities/' + id + '/share'); const text = await page.getByLabel('活動摘要', { exact: true }).inputValue();
  for (const value of ['分享原名 台灣音乐 <b>字</b>', '原地點 &keyword=其他 #地址', '用戶原文\n第二行', '原費用規則', '2099/12/13', '02:00', 'Asia/Tokyo', '安排版本：1']) expect(text).toContain(value);
  expect(text.endsWith(origin + '/activities/' + id)).toBe(true); await page.getByRole('button', { name: '複製活動摘要', exact: true }).click(); await expect(page.getByText('已複製活動摘要。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([text]); expect(writes).toBe(0);
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-activity-sharing-mobile.png', fullPage: true });
});
for (const mode of ['missing', 'reject', 'throw']) test('clipboard ' + mode + " preserves and selects the complete .disclosure-trigger for manual copying", async ({ page }) => {
  await clipboard(page, mode); await page.goto('/activities/listen/share'); const field = page.getByLabel('活動摘要', { exact: true }), text = await field.inputValue();
  await page.getByRole('button', { name: '複製活動摘要', exact: true }).click(); await expect(page.getByText('請選取活動摘要手動複製。', { exact: true })).toBeVisible(); await expect(field).toBeFocused();
  expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, text.length]); await expectControlValue(field, text);
});
test('arrangement share uses the current version and does not publish participant decisions', async ({ page, context }) => {
  const id = await published(context), current = await (await context.request.get('/api/v2/activities/' + id + '/arrangements', { headers: await headers(context) })).json();
  expect((await context.request.put('/api/v2/activities/' + id + '/arrangements', { headers: await headers(context), data: { revision: current.revision, values: { ...current.values, feePolicy: '更新費用原文' }, reason: '費用更正' } })).status()).toBe(200);
  await clipboard(page); await page.goto('/activities/' + id + '/conditions'); await page.getByRole('link', { name: '分享目前安排', exact: true }).click(); await expect(page).toHaveURL('/activities/' + id + '/share?kind=conditions');
  const text = await page.getByLabel('安排摘要', { exact: true }).inputValue(); expect(text).toContain('更新費用原文'); expect(text).toContain('安排版本：2'); expect(text).toContain('原報名與原約定保留，變更需要逐人確認。'); expect(text).not.toContain('小青');
  await page.getByRole('button', { name: '複製安排摘要', exact: true }).click(); await expect(page.getByText('已複製安排摘要。', { exact: true })).toBeVisible();
});
test("only the invitation owner can obtain or copy an invitation .disclosure-trigger and viewing does not grant signup", async ({ page, context }) => {
  const id = await published(context, true); await clipboard(page); await page.goto('/activities/' + id + '/share');
  await expect(page.getByText('持有者登入並確認後可查看活動，請只傳給預期參加者。', { exact: true })).toBeVisible(); const link = await page.getByLabel('活動連結', { exact: true }).inputValue(); expect(link).toMatch(/\/access\/[A-Za-z0-9_-]{32}$/); expect(await page.getByLabel('活動摘要', { exact: true }).inputValue()).toContain(link);
  await login(context, 'bob'); const token = link.split('/').at(-1)!; const preview = await (await context.request.get('/api/v2/activities/' + id + '/access/' + token)).json();
  expect((await context.request.post('/api/v2/activities/' + id + '/access/' + token + '/accept', { headers: await headers(context), data: { revision: preview.revision, confirm: true } })).status()).toBe(200);
  await page.reload(); await expect(page.getByText('只有發起者可以取得邀請可見連結', { exact: true })).toBeVisible(); await expect(page.getByLabel('活動摘要', { exact: true })).toHaveCount(0); await expect(page.getByLabel('活動連結', { exact: true })).toHaveCount(0);
});
test('navigation encodes only the selected location and contacts the map only after a click without geolocation', async ({ page, context }) => {
  const id = await published(context); let calls = 0;
  await page.addInitScript(() => { const state = window as unknown as { geoCalls: number }; state.geoCalls = 0; Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition() { state.geoCalls++; }, watchPosition() { state.geoCalls++; } } }); });
  await context.route('https://uri.amap.com/**', async route => { calls++; await route.fulfill({ contentType: 'text/html', body: '<title>Synthetic map</title>' }); });
  await page.goto('/activities/' + id); const link = page.getByRole('link', { name: '高德導航', exact: true }); await expect(link).toBeVisible(); expect(calls).toBe(0);
  expect(await link.getAttribute('href')).toBe('https://uri.amap.com/search?keyword=' + encodeURIComponent('原地點 &keyword=其他 #地址'));
  const popup = page.waitForEvent('popup'); await link.click(); const map = await popup; await map.waitForLoadState(); expect(new URL(map.url()).searchParams.get('keyword')).toBe('原地點 &keyword=其他 #地址'); expect(calls).toBe(1); expect(await map.evaluate(() => window.opener)).toBeNull(); await map.close(); expect(await page.evaluate(() => (window as unknown as { geoCalls: number }).geoCalls)).toBe(0);
});
test("a delayed clipboard result cannot report success for a different .disclosure-trigger or resurrect a closed page", async ({ page }) => {
  await clipboard(page, 'delay'); await page.goto('/activities/listen/share'); await page.getByRole('button', { name: '複製活動摘要', exact: true }).click(); await selectControl(page.getByLabel('摘要內容', { exact: true }), 'conditions');
  await page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy()); await expect(page.getByLabel('安排摘要', { exact: true })).toBeVisible(); await expect(page.getByText('已複製活動摘要。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '複製安排摘要', exact: true }).click(); await page.getByRole('link', { name: '回到活動', exact: true }).click(); await page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy()); await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible(); await expect(page.getByText('已複製安排摘要。', { exact: true })).toHaveCount(0);
});
test("failed or mismatched activity reads expose no stale .disclosure-trigger and can recover explicitly", async ({ page }) => {
  let fail = true; await page.route('**/api/v2/activities/listen', async route => { if (fail) await route.abort(); else await route.continue(); });
  await page.goto('/activities/listen/share'); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByLabel('活動摘要', { exact: true })).toHaveCount(0); fail = false; await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await expect(page.getByLabel('活動摘要', { exact: true })).toBeVisible();
  await page.route('**/api/v2/activities/listen/share', async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...(await response.json()), path: '//external.example' } }); });
  await page.reload(); await expect(page.getByText('活動分享連結不符，請重新讀取。', { exact: true })).toBeVisible(); await expect(page.getByLabel('活動摘要', { exact: true })).toHaveCount(0);
});
test("late private activity data cannot restore an invitation .disclosure-trigger after logout in another tab", async ({ page, context }) => {
  const id = await published(context, true); let release!: () => void, seen!: () => void, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { seen = resolve; });
  await page.route('**/api/v2/activities/' + id, async route => { if (!first) { await route.continue(); return; } first = false; const response = await route.fetch(); seen(); await gate; await route.fulfill({ response }); });
  await page.goto('/activities/' + id + '/share'); await intercepted;
  const account = await context.newPage();
  try {
    await account.goto('/me/accounts'); await account.getByRole('button', { name: '登出此裝置', exact: true }).click();
    await expect(page.getByText('找不到活動或尚未公開', { exact: true })).toBeVisible(); release();
    await expect(page.getByLabel('活動摘要', { exact: true })).toHaveCount(0); await expect(page.getByLabel('活動連結', { exact: true })).toHaveCount(0);
  } finally { release(); await account.close(); }
});
test('current and saved arrangement locations keep separate encoded navigation targets', async ({ page, context }) => {
  const id = await published(context), current = await (await context.request.get('/api/v2/activities/' + id + '/arrangements', { headers: await headers(context) })).json();
  expect((await context.request.put('/api/v2/activities/' + id + '/arrangements', { headers: await headers(context), data: { revision: current.revision, values: { ...current.values, location: '新地點 /?q=原文' }, reason: '地點更正' } })).status()).toBe(200);
  await page.goto('/activities/' + id + '/conditions'); const latest = page.getByRole('region', { name: '目前安排', exact: true });
  expect(await latest.getByRole('link', { name: '高德導航', exact: true }).getAttribute('href')).toBe('https://uri.amap.com/search?keyword=' + encodeURIComponent('新地點 /?q=原文'));
  const saved = page.locator("section[aria-label=\"安排歷史\"] > .disclosure").filter({ has: page.locator(".disclosure-trigger", { hasText: /^第 1 版 ·/ }) });
  await saved.locator(".disclosure-trigger").click();
  expect(await saved.getByRole('region', { name: '保存的安排', exact: true }).getByRole('link', { name: '高德導航', exact: true }).getAttribute('href')).toBe('https://uri.amap.com/search?keyword=' + encodeURIComponent('原地點 &keyword=其他 #地址'));
});
