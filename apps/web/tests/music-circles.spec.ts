import { chooseOption } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
const id = (n: number) => 'm_c' + n.toString(16).padStart(23, '0');
test.use({ musicCircles: true });
async function login(context: BrowserContext, user = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function refresh(page: Page) { await page.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('refresh'); channel.close(); }); }
const circles = (page: Page) => page.getByRole('region', { name: '圈子名單', exact: true });
const singles = (page: Page) => page.getByRole('region', { name: '未連入圈子名單', exact: true });
const stats = (page: Page) => page.getByRole('definition');
test('guests and accounts without saved music receive the shared gate without fetching circles or writing', async ({ page, context }) => {
  let privateReads = 0, writes = 0;
  page.on('request', request => { if (request.url().includes('/music/circles')) privateReads++; if (request.url().includes('/api/') && !['GET','HEAD'].includes(request.method())) writes++; });
  await page.goto('/people'); await page.getByRole('link', { name: '同好圈子', exact: true }).click();
  await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible(); await expect(circles(page)).toHaveCount(0);
  await login(context, 'auth-owner'); await refresh(page); await expect(page.getByRole('link', { name: '保存成分', exact: true })).toBeVisible();
  expect(privateReads).toBe(0); expect(writes).toBe(0);
});
test('all circles, distinct same-name members and independent picks remain accessible without private fields', async ({ page, context }) => {
  await login(context); let writes = 0;
  page.on('request', request => { if (request.url().includes('/api/') && !['GET','HEAD'].includes(request.method())) writes++; });
  await page.goto('/people/circles'); await expect(stats(page).filter({ hasText: '28 人' })).toHaveCount(1); await expect(stats(page).filter({ hasText: '12 個' })).toHaveCount(1);
  await expect(circles(page).locator('.music-circle:visible')).toHaveCount(8);
  await expect(circles(page).getByRole('heading', { name: '圈子 1 · 3 人', exact: true })).toBeVisible();
  const duplicates = circles(page).getByRole('link', { name: '同名0', exact: true }); await expect(duplicates).toHaveCount(2); expect(await duplicates.first().getAttribute('href')).not.toBe(await duplicates.last().getAttribute('href'));
  await circles(page).getByText('其餘圈子 · 4 個', { exact: true }).click(); await expect(circles(page).locator('.music-circle:visible')).toHaveCount(12);
  await expect(circles(page).getByRole('heading', { name: '圈子 12 · 2 人', exact: true })).toBeVisible();
  await expect(singles(page).locator('.music-circle-singles > li')).toHaveCount(2); await expect(singles(page)).toContainText('10 個詞條，列出前 8 個');
  await expect(singles(page).getByRole('link', { name: /^圈子詞 independent-/ })).toHaveCount(8);
  await expect(page.getByText(/不可匯出|998877/)).toHaveCount(0); expect(writes).toBe(0);
});
test('thresholds persist through member and comparison navigation, keyboard links and mobile wrapping', async ({ page, context }) => {
  await login(context); await page.setViewportSize({ width: 360, height: 800 }); await page.goto('/people/circles?minLink=100');
  await expect(stats(page).filter({ hasText: '11 個' })).toHaveCount(1); await expect(stats(page).filter({ hasText: '5 人' })).toHaveCount(1);
  const member = circles(page).getByRole('link', { name: '同名0', exact: true }).last(); await member.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/people/' + id(11) + '?from=%2Fpeople%2Fcircles%3FminLink%3D100');
  await page.getByRole('link', { name: '比較成分', exact: true }).click(); await expect(page.getByRole('heading', { name: '成分比較', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '查看同好成分', exact: true }).click(); await page.getByRole('dialog').getByRole('link', { name: '回到同好圈子', exact: true }).click();
  await expect(page).toHaveURL('/people/circles?minLink=100'); await expect(page.getByLabel('圈子連結門檻',{exact:true})).toContainText('嚴格重合 100%');
  await chooseOption(page,'圈子連結門檻',{label:'嚴格重合 40%'}); await expect(circles(page).getByRole('heading', { name: '圈子 1 · 3 人', exact: true })).toBeVisible();
  await circles(page).getByText('其餘圈子 · 4 個', { exact: true }).click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-music-circles-mobile.png', fullPage: true });
});
test('term editing uses the shared draft, confirms leaving, saves explicitly and updates circles', async ({ page, context }) => {
  await login(context); await page.goto('/people/circles?minLink=40');
  await circles(page).getByRole('link', { name: '圈子詞 chain-b', exact: true }).click();
  await page.getByRole('button', { name: '取消選取', exact: true }).click(); await page.getByRole('link', { name: '回到同好圈子', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未提交的修改', exact: true })).toBeVisible(); await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
  await expect(page.getByRole('button', { name: '選取此詞條', exact: true })).toBeVisible(); await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible(); await page.getByRole('link', { name: '回到同好圈子', exact: true }).click();
  await expect(page).toHaveURL('/people/circles?minLink=40'); await expect(circles(page).locator('.music-circle').filter({ has: page.getByRole('link', { name: '橋接', exact: true }) }).getByRole('heading', { name: /2 人$/ })).toBeVisible();
  await expect(singles(page).getByRole('link', { name: '鏈首', exact: true })).toBeVisible(); await expect(stats(page).filter({ hasText: '3 人' })).toHaveCount(1);
  await singles(page).getByRole('link', { name: '圈子詞 chain-a', exact: true }).click(); await page.getByRole('button', { name: '取消選取', exact: true }).click();
  await page.getByRole('link', { name: '回到同好圈子', exact: true }).click(); await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
  await page.goto('/me/music?from=%2Fpeople%2Fcircles%3FminLink%3D40'); await expect(page.getByRole('button', { name: '移除圈子詞 chain-a', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '回到同好圈子', exact: true })).toHaveAttribute('href', '/people/circles?minLink=40');
});
test('late threshold responses are discarded; failures remove old results and can be retried', async ({ page, context }) => {
  await login(context); let arrived!: () => void, release!: () => void;
  const captured = new Promise<void>(resolve => { arrived = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v2/music/circles?minLink=40', async route => { const response = await route.fetch(); arrived(); await pending; await route.fulfill({ response }).catch(() => {}); });
  await page.goto('/people/circles'); await captured; await chooseOption(page,'圈子連結門檻',{label:'嚴格重合 100%'});
  await expect(stats(page).filter({ hasText: '11 個' })).toHaveCount(1); release(); await expect(singles(page).getByRole('link', { name: '鏈首', exact: true })).toBeVisible();
  let fail = true; await page.route('**/api/v2/music/circles?minLink=100', route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'FAIL', message: '圈子暫時無法讀取' }) }) : route.continue());
  await refresh(page); await expect(page.getByRole('alert')).toContainText('圈子暫時無法讀取'); await expect(circles(page)).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await expect(stats(page).filter({ hasText: '11 個' })).toHaveCount(1);
});
test('late private reads never restore circles after account changes or logout', async ({ page, context }) => {
  await login(context); let arrived!: () => void, release!: () => void; const captured = new Promise<void>(resolve => { arrived = resolve; }), pending = new Promise<void>(resolve => { release = resolve; }); let hold = true;
  await page.route('**/api/v2/music/circles?*', async route => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); arrived(); await pending; await route.fulfill({ response }).catch(() => {}); });
  await page.goto('/people/circles'); await captured; await login(context, 'auth-owner'); await refresh(page); await expect(page.getByRole('link', { name: '保存成分', exact: true })).toBeVisible(); release();
  await expect(circles(page)).toHaveCount(0); await expect(page.getByRole('link', { name: '鏈首', exact: true })).toHaveCount(0);
  await context.clearCookies(); await refresh(page); await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible(); await expect(circles(page)).toHaveCount(0);
});
test('cross-tab saved selections and name changes refresh circles; erasure revokes the entire list', async ({ page, context }) => {
  await login(context); await page.goto('/people/circles'); await expect(circles(page).getByRole('link', { name: '鏈首', exact: true })).toBeVisible();
  const editor = await context.newPage(); await editor.goto('/me/music/details'); await editor.getByLabel('成分稱呼', { exact: true }).fill('圈子新稱呼');
  await editor.getByRole('button', { name: '保存成分資料', exact: true }).click(); await expect(editor.getByText('成分資料已保存。', { exact: true })).toBeVisible();
  await expect(circles(page).getByRole('link', { name: '圈子新稱呼', exact: true })).toBeVisible(); await expect(circles(page).getByRole('link', { name: '鏈首', exact: true })).toHaveCount(0);
  await editor.goto('/me/music'); await editor.getByRole('button', { name: '移除圈子詞 chain-b', exact: true }).click(); await editor.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(editor.getByText('已保存。', { exact: true })).toBeVisible(); await expect(singles(page).getByRole('link', { name: '圈子新稱呼', exact: true })).toBeVisible();
  await editor.goto('/me/privacy'); await editor.getByRole('radio', { name: '只刪除成分', exact: true }).check(); await editor.getByRole('checkbox', { name: '我已確認範圍，瞭解此操作無法復原', exact: true }).check(); await editor.getByRole('button', { name: '確認刪除成分', exact: true }).click();
  await expect(page.getByRole('link', { name: '保存成分', exact: true })).toBeVisible(); await expect(circles(page)).toHaveCount(0); await expect(singles(page)).toHaveCount(0); await editor.close();
});
test('empty data and unmatched thresholds provide useful guidance; URL thresholds and return paths are bounded', async ({ page, context }) => {
  await login(context); let empty = false;
  await page.route('**/api/v2/music/circles?*', async route => { const response = await route.fetch(), body = await response.json(); body.clusters = []; if (empty) Object.assign(body, { membersWithSelection: 0, singles: 0, singleMembers: [] }); await route.fulfill({ response, json: body }); });
  await page.goto('/people/circles?minLink=55'); await expect(page.getByLabel('圈子連結門檻',{exact:true})).toContainText('嚴格重合 55%'); await expect(page.getByText('目前門檻下沒有兩人以上的圈子，可調整連結門檻。', { exact: true })).toBeVisible();
  empty = true; await refresh(page); await expect(page.getByRole('link', { name: '保存成分選擇', exact: true })).toBeVisible(); await expect(singles(page)).toHaveCount(0);
  await page.goto('/people/circles?minLink=999'); await expect(page.getByLabel('圈子連結門檻',{exact:true})).toContainText('嚴格重合 40%');
  await page.goto('/people/' + id(2) + '/compare?from=%2F%2Fevil.example'); await expect(page.getByRole('link', { name: '回到同好圈子', exact: true })).toHaveCount(0);
  await page.goto('/music/entries/chain-b?from=%2Fpeople%2Fcircles-extra'); await expect(page.getByRole('link', { name: '回到同好圈子', exact: true })).toHaveCount(0);
});
test('same-name tags retain their separate term links and long names wrap on mobile', async ({ page, context }) => {
  await login(context); await page.setViewportSize({ width: 360, height: 800 });
  await page.route('**/api/v2/music/circles?*', async route => { const response = await route.fetch(), body = await response.json();
    body.clusters[0].members[0].name = '👩🏽‍🎤'.repeat(80); body.clusters[0].tags = [{ name: '同名長詞條'.repeat(40), count: 4, entries: [{ id: 'chain-a', kind: 'main' }, { id: 'chain-b', kind: 'sub' }] }]; await route.fulfill({ response, json: body }); });
  await page.goto('/people/circles?minLink=40'); const card = circles(page).locator('.music-circle').first();
  await expect(card).toContainText('· 4 次'); await expect(card.getByRole('link', { name: '領域 · chain-a', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.getByRole('link', { name: '細分 · chain-b', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('heading',{name:'圈子詞 chain-b',exact:true})).toBeVisible();
  await page.getByRole('link', { name: '回到同好圈子', exact: true }).click(); await expect(page).toHaveURL('/people/circles?minLink=40');
});

// Circle computation now runs asynchronously. Finish intercepted background
// reads before closing their request context, keeping callback errors visible.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });
