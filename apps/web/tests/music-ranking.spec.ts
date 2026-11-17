import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
const origin = 'http://127.0.0.1:5082';
async function login(context: BrowserContext) {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function largeCatalog(page: Page) {
  await page.route('**/api/v2/music/catalog', async route => {
    const response = await route.fetch(), catalog = await response.json(), sample = catalog.entries[0];
    for (const kind of ['main', 'sub']) for (let n = 0; n < 25; n++) catalog.entries.push({ ...sample, id: kind + '-extra-' + n, kind, name: kind + '測試詞條' + n, count: 0 });
    catalog.stats.entries = catalog.entries.length;
    await route.fulfill({ response, json: catalog });
  });
}
test('keeps independent source ranking caps, Chinese ordering and full-library access with URL restoration', async ({ page }) => {
  await largeCatalog(page); await page.goto('/music');
  const main = page.getByRole('region', { name: '領域排行', exact: true }), sub = page.getByRole('region', { name: '細分排行', exact: true });
  await expect(main.getByRole('listitem')).toHaveCount(10); await expect(sub.getByRole('listitem')).toHaveCount(10);
  const catalog = await (await page.request.get('/api/v2/music/catalog')).json();
  expect(await sub.locator('ol a').first().textContent()).toBe('Aimer');
  // Actual display ties use the legacy controller's Chinese collation, not payload Unicode order.
  const realNames = catalog.entries.filter((e: any) => e.kind === 'main').sort((a: any, b: any) => b.count - a.count || a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id)).map((e: any) => e.name);
  const mainVisible = await main.locator('ol a').allTextContents();
  expect(mainVisible.filter(name => realNames.includes(name))).toEqual(realNames.slice(0, mainVisible.filter(name => realNames.includes(name)).length));
  await main.getByRole('button', { name: '展開全部領域', exact: true }).click();
  await expect(main.getByRole('listitem')).toHaveCount(31); await expect(sub.getByRole('listitem')).toHaveCount(10);
  await sub.getByRole('button', { name: '展開細分前 20 名', exact: true }).click();
  await expect(sub.getByRole('listitem')).toHaveCount(20);
  await sub.getByRole('button', { name: '查看完整細分詞庫', exact: true }).click();
  await expect(sub.getByRole('listitem')).toHaveCount(41);
  await page.reload(); await expect(main.getByRole('listitem')).toHaveCount(31); await expect(sub.getByRole('listitem')).toHaveCount(41);
  await page.getByRole('button', { name: '熱門排行', exact: true }).click();
  await expect(sub.getByRole('listitem')).toHaveCount(20);
  await main.getByRole('button', { name: '收合領域排行', exact: true }).click();
  await expect(main.getByRole('listitem')).toHaveCount(10); await expect(sub.getByRole('listitem')).toHaveCount(20);
});
test('searches and filters the entire catalog independently of popular caps and restores the chosen range', async ({ page }) => {
  await largeCatalog(page); await page.goto('/music');
  const search = page.getByLabel('搜尋音樂詞條', { exact: true }), sub = page.getByRole('region', { name: '細分排行', exact: true });
  await search.fill('測試詞條'); await expect(sub.getByRole('listitem')).toHaveCount(25);
  await page.getByLabel('詞庫類型').selectOption('sub'); await expect(page.getByRole('region', { name: '領域排行', exact: true })).toHaveCount(0);
  await expect(sub.getByRole('listitem')).toHaveCount(25);
  await search.press('Escape'); await expect(sub.getByRole('listitem')).toHaveCount(41);
  await page.getByLabel('詞庫類型').selectOption(''); await expect(sub.getByRole('listitem')).toHaveCount(10);
  await page.getByRole('button', { name: '完整詞庫', exact: true }).click();
  await search.fill('yrsk'); await expect(sub.getByRole('link', { name: 'ヨルシカ', exact: true })).toBeVisible();
  await search.press('Escape'); await expect(sub.getByRole('listitem')).toHaveCount(41);
});
test('keeps both bubble views independent, includes terms beyond rank caps and offers the complete accessible list', async ({ page }) => {
  await largeCatalog(page); await page.goto('/music');
  const main = page.getByRole('region', { name: '領域排行', exact: true }), sub = page.getByRole('region', { name: '細分排行', exact: true });
  await sub.getByRole('button', { name: '細分氣泡', exact: true }).click();
  await expect(sub.locator('svg a')).toHaveCount(41); await expect(main.getByRole('listitem')).toHaveCount(10);
  await main.getByRole('button', { name: '領域氣泡', exact: true }).click();
  await expect(main.locator('svg a')).toHaveCount(31); await page.reload(); await expect(sub.locator('svg a')).toHaveCount(41);
  await sub.getByRole('button', { name: '細分清單', exact: true }).click();
  await expect(main.locator('svg a')).toHaveCount(31); await expect(sub.getByRole('listitem')).toHaveCount(10);
  await page.getByRole('button', { name: '完整詞庫', exact: true }).click(); await expect(sub.getByRole('listitem')).toHaveCount(41);
});
test('opens bubbles by keyboard and preserves draft levels, selection markers and view settings through detail and save', async ({ page, context }) => {
  await login(context); await page.goto('/music?mainView=bubbles&subView=bubbles');
  const sub = page.getByRole('region', { name: '細分排行', exact: true });
  const bubble = sub.getByRole('link', { name: 'YOASOBI，0 人', exact: true });
  await bubble.focus(); await expect(bubble).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/music/entries/sub-0?mainView=bubbles&subView=bubbles');
  await expect(page.locator('#main')).toBeFocused();
  await page.getByRole('button', { name: '選取此詞條', exact: true }).click();
  await page.getByLabel('YOASOBI喜歡程度').selectOption('4');
  await page.getByRole('link', { name: '回到音樂詞庫', exact: true }).click();
  await expect(sub.getByRole('link', { name: 'YOASOBI，0 人，已選', exact: true })).toBeVisible();
  await expect(page.getByLabel('YOASOBI喜歡程度')).toHaveValue('4');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(sub.getByRole('link', { name: 'YOASOBI，1 人，已選', exact: true })).toBeVisible();
  await sub.getByRole('button', { name: '細分清單', exact: true }).click();
  await expect(sub.locator('li.is-selected')).toContainText('YOASOBI');
  await expect(sub.locator('li.is-selected')).toContainText('已選');
  await expect(page.getByRole('heading', { name: '還有未保存的選擇' })).toHaveCount(0);
});
test('shows current aggregates and refreshes another tab after erasing a profile without discarding its catalog view', async ({ page, context }) => {
  await login(context); await page.goto('/music?entry=sub-0&subView=bubbles');
  const stat = (name: string) => page.getByLabel('音樂統計', { exact: true }).locator('div').filter({ has: page.getByText(name, { exact: true }) }).locator('dd');
  await expect(stat('成分')).toHaveText('3');
  await page.getByRole('button', { name: '選取此詞條', exact: true }).click();
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(stat('成分')).toHaveText('4'); await expect(stat('24 小時新增成分')).toHaveText('1');
  const privacy = await context.newPage(); await privacy.goto('/me/privacy');
  await privacy.getByRole('checkbox').check(); await privacy.getByRole('button', { name: '確認刪除成分', exact: true }).click();
  await expect(privacy.getByRole('heading', { name: '成分已刪除', exact: true })).toBeVisible();
  await expect(stat('成分')).toHaveText('3'); await expect(stat('24 小時新增成分')).toHaveText('0');
  await expect(page.getByRole('button', { name: '細分氣泡', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: 'YOASOBI，0 人', exact: true })).toBeVisible();
  await privacy.close();
});
test('keeps long bubble labels, counts and every link readable at 360px without horizontal overflow', async ({ page, context }) => {
  await login(context); await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/music?subView=bubbles');
  const sub = page.getByRole('region', { name: '細分排行', exact: true });
  await expect(sub.locator('svg a')).toHaveCount(16);
  await expect(sub.getByRole('link', { name: 'ずっと真夜中でいいのに。，0 人', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/music-ranking-mobile.png', fullPage: true });
  const before = await sub.locator('svg').getAttribute('height');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(sub.locator('svg')).not.toHaveAttribute('height', before!);
  await sub.getByRole('link', { name: 'ずっと真夜中でいいのに。，0 人', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ずっと真夜中でいいのに。', exact: true })).toBeVisible();
});
test('preserves the active editor and draft when a background catalog refresh fails, then retries without writing selections', async ({ page, context }) => {
  await login(context); await page.clock.install();
  let fail = false, writes = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/me/music')) writes++; });
  await page.route('**/api/v2/music/catalog', async route => fail
    ? route.fulfill({ status: 503, contentType: 'application/json', json: { code: 'TEMPORARY', message: '合成詞庫暫時不可用' } })
    : route.continue());
  await page.goto('/music?entry=sub-0');
  await page.getByRole('button', { name: '選取此詞條', exact: true }).click();
  await page.getByLabel('YOASOBI喜歡程度').selectOption('4');
  fail = true; await page.clock.fastForward(10001);
  await expect(page.getByRole('alert')).toContainText('合成詞庫暫時不可用');
  await expect(page.getByLabel('搜尋音樂詞條', { exact: true })).toBeVisible();
  await expect(page.getByLabel('YOASOBI喜歡程度')).toHaveValue('4');
  await expect(page.getByRole('button', { name: '保存我的成分', exact: true })).toBeEnabled();
  fail = false; await page.getByRole('button', { name: '重新讀取', exact: true }).click();
  await expect(page.getByRole('heading', { name: '熱門排行', exact: true })).toBeVisible();
  await expect(page.getByLabel('YOASOBI喜歡程度')).toHaveValue('4');
  expect(writes).toBe(0);
});
