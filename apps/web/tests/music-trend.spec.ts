import { durableRows } from './draft-helpers';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin = 'http://127.0.0.1:5082';
test.use({ musicTrend: true });
const recentMembers = (page: Page) => page.getByRole('region', { name: '最近新增同好', exact: true });
async function login(context: BrowserContext, user = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function auth(context: BrowserContext) { const viewer = await (await context.request.get('/api/v2/session')).json(); return { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() }; }
async function refresh(page: Page) { await page.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('refresh'); channel.close(); }); }
test('visitors see aggregate trends, complete legends and recent terms while member identities stay behind the shared gate', async ({ page }) => {
  let writes = 0, privateReads = 0; page.on('request', request => { if (request.url().includes('/api/')) { if (!['GET','HEAD'].includes(request.method())) writes++; if (request.url().includes('/trend/members')) privateReads++; } });
  await page.goto('/music'); await page.getByRole('link', { name: '音樂趨勢', exact: true }).click(); await expect(page.getByRole('heading', { name: '音樂趨勢', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '詞條每段新增人數折線圖', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: '趨勢圖例', exact: true })).toContainText('J-POP · 新增 5 人');
  await expect(page.getByRole('list', { name: '排行漲幅', exact: true })).toContainText('目前 6 人 · +5 人');
  await expect(page.getByRole('definition').filter({ hasText: '22 詞條 · 13 成分' })).toHaveCount(1);
  await expect(recentMembers(page).getByRole('link', { name: '登入', exact: true })).toBeVisible(); await expect(page.getByText('我的成分', { exact: true })).toHaveCount(0);
  await page.getByText('快照資料表', { exact: true }).click(); await expect(page.getByRole('table')).toBeVisible(); await expect(page.getByRole('table').getByRole('row')).toHaveCount(5);
  expect(writes).toBe(0); expect(privateReads).toBe(0);
});
test('trend terms share the original unsaved selection, preserve search and return without an extra draft or automatic save', async ({ page, context }) => {
  await login(context); let writes = 0; page.on('request', request => { if (request.url().includes('/api/') && !['GET','HEAD'].includes(request.method())) writes++; });
  await page.goto('/me/music?q=Yoa'); await page.getByRole('button', { name: '移除Aimer', exact: true }).click();
  await page.getByRole('link', { name: '音樂詞庫', exact: true }).click(); await page.getByRole('link', { name: '音樂趨勢', exact: true }).click();
  await expect(page).toHaveURL('/music/trends?q=Yoa'); await expect(page.getByRole('heading', { name: '還有未保存的選擇', exact: true })).toHaveCount(0);
  await page.getByRole('list', { name: '趨勢圖例', exact: true }).getByRole('link', { name: 'J-POP', exact: true }).click();
  await expect(page.getByRole('region', { name: '詞條資料', exact: true })).toBeVisible(); await page.getByRole('button', { name: '取消選取', exact: true }).click();
  await page.getByRole('link', { name: '回到音樂趨勢', exact: true }).click(); await expect(page).toHaveURL('/music/trends?q=Yoa');
  await expect(page.getByRole('button', { name: '移除Aimer', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '移除J-POP', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '回到音樂詞庫', exact: true }).click(); await expect(page).toHaveURL('/music?q=Yoa'); expect(writes).toBe(0);
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);const drafts=(await durableRows(page)).filter(row=>row.key.startsWith('qgroup:rebuild:music:v1:'));expect(drafts).toHaveLength(1);
});
test('new members link through scoped profiles and keyboard navigation; mobile chart and data table remain within the page', async ({ page, context }) => {
  await login(context); await page.setViewportSize({ width: 360, height: 800 }); await page.goto('/music/trends');
  const member = recentMembers(page).getByRole('link', { name: '共同最多', exact: true }); await expect(member).toBeVisible(); await member.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '共同最多', exact: true })).toBeVisible(); await page.getByRole('link', { name: '比較成分', exact: true }).click(); await expect(page.getByRole('heading', { name: '成分比較', exact: true })).toBeVisible(); await page.getByRole('link', { name: '回到音樂趨勢', exact: true }).click();
  await page.getByText('快照資料表', { exact: true }).click(); await page.getByRole('region', { name: '快照資料表，可橫向捲動', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const labels = await page.getByRole('img', { name: '詞條每段新增人數折線圖', exact: true }).locator('text').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)); expect(labels.every(height => height >= 11)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-music-trend-mobile.png', fullPage: true });
});
test('saved choices update the live trend without persisting a new snapshot, while leaving the workspace still protects unsaved changes', async ({ page, context }) => {
  await login(context); await page.goto('/music/trends'); const headers = await auth(context), before = await (await context.request.get('/api/v2/music/trend')).json();
  await page.getByRole('button', { name: '移除J-POP', exact: true }).click(); await page.getByRole('button', { name: '保存我的成分', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: '排行漲幅', exact: true })).toContainText('目前 5 人'); const after = await (await context.request.get('/api/v2/music/trend')).json();
  expect(after.points.slice(0, -1)).toEqual(before.points.slice(0, -1)); expect(after.points.at(-1).counts['main-0']).toBe(5);
  await page.getByRole('button', { name: '移除Aimer', exact: true }).click(); await page.getByRole('navigation').getByRole('link', { name: '活動', exact: true }).click();
  await expect(page.getByRole('heading', { name: '還有未保存的選擇', exact: true })).toBeVisible(); await page.getByRole('button', { name: '繼續編輯', exact: true }).click(); await expect(page).toHaveURL('/music/trends');
  expect((await context.request.get('/api/v2/me/music', { headers })).status()).toBe(200);
});
test('public and private errors offer independent retries and never keep a failed stale chart or send writes', async ({ page, context }) => {
  await login(context); let failPublic = true, failMembers = true;
  await page.route('**/api/v2/music/trend', route => failPublic ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'FAIL', message: '趨勢暫時無法讀取' }) }) : route.continue());
  await page.route('**/api/v2/music/trend/members', route => failMembers ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'FAIL', message: '新增同好暫時無法讀取' }) }) : route.continue());
  await page.goto('/music/trends'); await expect(page.getByRole('alert').filter({ hasText: '趨勢暫時無法讀取' })).toBeVisible(); await expect(page.getByRole('img', { name: '詞條每段新增人數折線圖', exact: true })).toHaveCount(0);
  failPublic = false; await page.getByRole('button', { name: '重新讀取', exact: true }).first().click(); await expect(page.getByRole('img', { name: '詞條每段新增人數折線圖', exact: true })).toBeVisible();
  failMembers = false; await recentMembers(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await expect(recentMembers(page).getByRole('link', { name: '共同最多', exact: true })).toBeVisible();
  failPublic = true; await refresh(page); await expect(page.getByRole('alert').filter({ hasText: '趨勢暫時無法讀取' })).toBeVisible(); await expect(page.getByRole('img', { name: '詞條每段新增人數折線圖', exact: true })).toHaveCount(0);
});
test('late new-member reads cannot cross an account change, logout or loss of the saved-profile gate', async ({ page, context }) => {
  await login(context); let arrived!: () => void, release!: () => void; const captured = new Promise<void>(resolve => { arrived = resolve; }), pending = new Promise<void>(resolve => { release = resolve; }); let hold = true;
  await page.route('**/api/v2/music/trend/members', async route => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); arrived(); await pending; await route.fulfill({ response }).catch(() => {}); });
  await page.goto('/music/trends'); await captured; await login(context, 'auth-owner'); await refresh(page); await expect(recentMembers(page).getByRole('link', { name: '保存成分', exact: true })).toBeVisible(); release();
  await expect(recentMembers(page).getByRole('link', { name: '共同最多', exact: true })).toHaveCount(0);
  await context.clearCookies(); await refresh(page); await expect(recentMembers(page).getByRole('link', { name: '登入', exact: true })).toBeVisible(); await expect(recentMembers(page).getByRole('link', { name: '共同最多', exact: true })).toHaveCount(0);
});
test('cross-tab erasure removes the member identity and totals, refreshes the live point and keeps previously anonymous history', async ({ page, context }) => {
  await login(context); await page.goto('/music/trends'); await expect(recentMembers(page).getByRole('link', { name: '我的成分', exact: true })).toBeVisible();
  const before = await (await context.request.get('/api/v2/music/trend')).json();
  const privacy = await context.newPage(); await privacy.goto('/me/privacy'); await privacy.getByRole('radio', { name: '只刪除成分', exact: true }).check(); await privacy.getByRole('checkbox', { name: '我已確認範圍，瞭解此操作無法復原', exact: true }).check(); await privacy.getByRole('button', { name: '確認刪除成分', exact: true }).click();
  await expect(recentMembers(page).getByRole('link', { name: '保存成分', exact: true })).toBeVisible(); await expect(page.getByRole('definition').filter({ hasText: '22 詞條 · 12 成分' })).toHaveCount(1);
  const after = await (await context.request.get('/api/v2/music/trend')).json(); expect(after.points.slice(0, -1)).toEqual(before.points.slice(0, -1)); await privacy.close();
});
test('insufficient, flat and empty history states stay actionable and large or unknown creation timestamps do not break rendering', async ({ page, context }) => {
  await login(context); let mode = 'single';
  await page.route('**/api/v2/music/trend', async route => { const response = await route.fetch(), body = await response.json(); const counts = mode === 'empty' ? {} : { 'main-0': 3 };
    body.points = mode === 'single' ? [{ t: 1, counts }] : [{ t: 1, counts }, { t: 1801, counts }]; body.recentEntries[0].createdAt = Number.MAX_SAFE_INTEGER; body.entries[0].name = '👩🏽‍🎤'.repeat(200); await route.fulfill({ response, json: body }); });
  await page.goto('/music/trends'); await expect(page.getByText('尚不足兩個快照，取樣後可查看變化。', { exact: true })).toBeVisible(); await expect(page.getByText(/時間未記錄/).first()).toBeVisible();
  mode = 'flat'; await refresh(page); await expect(page.getByText('這段時間沒有新增選用人數。', { exact: true })).toBeVisible(); await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mode = 'empty'; await refresh(page); await expect(page.getByText('目前快照沒有可顯示的詞條。', { exact: true })).toBeVisible();
});
