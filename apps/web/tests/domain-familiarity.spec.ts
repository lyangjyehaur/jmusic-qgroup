import { test, expect } from './fixtures';
import { chooseOption, expectOption } from './kimi-controls';

test.use({ musicMatches: true });
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;

for (const width of [390, 1440]) test(`domain familiarity preserves saved choices across editing, details, comparison and sharing at ${width}px`, async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const viewer = await (await context.request.get('/api/v2/session')).json();
  const headers = { 'X-Account-Scope': viewer.scope };
  const read = async () => (await context.request.get('/api/v2/me/music', { headers })).json();
  const before = await read();
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/me/music')) writes++; });
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/me/music');
  await expectOption(page, 'J-POP喜歡程度', '1');
  for (const value of ['2', '3', '1', '4']) {
    await chooseOption(page, 'J-POP喜歡程度', value);
    await expectOption(page, 'J-POP喜歡程度', value);
  }
  expect(writes).toBe(0);
  expect((await read()).selections).toEqual(before.selections);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: width < 768 ? '保存詞條變動' : '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.reload();
  await expectOption(page, 'J-POP喜歡程度', '4');
  const saved = await read();
  expect(saved.selections).toEqual(before.selections.map((pick: { entryId: string; level: number }) => pick.entryId === 'main-0' ? { ...pick, level: 4 } : pick));

  await page.goto('/people');
  const recommendedDomain = page.locator('.common-terms > div').filter({ has: page.getByRole('link', { name: 'J-POP', exact: true }) }).first();
  await expect(recommendedDomain).toContainText('我・本命');
  await expect(recommendedDomain).toContainText('對方・只聽過幾首');
  await page.goto('/people/' + 'm_' + '2'.padStart(24, '0') + '/compare');
  const common = page.locator('.music-comparison').locator('.match-picks li').filter({ has: page.getByRole('link', { name: 'J-POP', exact: true }) });
  await expect(common).toContainText('你：本命／對方：只聽過幾首');
  await page.goto('/people/' + saved.id);
  await page.locator('.profile-all-picks .disclosure-trigger').click();
  await expect(page.locator('.profile-all-picks li').filter({ has: page.getByRole('link', { name: 'J-POP', exact: true }) })).toContainText('本命');

  await page.addInitScript(() => {
    const texts: string[] = [];
    Object.assign(window, { domainShareTexts: texts });
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      texts.push(text);
      if (maxWidth === undefined) original.call(this, text, x, y);
      else original.call(this, text, x, y, maxWidth);
    };
  });
  await page.goto('/me/music/share');
  await expect(page.getByRole('img', { name: '音樂成分分享圖片；完整詞條可見下方清單', exact: true })).toBeVisible();
  const texts = await page.evaluate(() => (window as unknown as { domainShareTexts: string[] }).domainShareTexts);
  expect(texts[texts.indexOf('J-POP') + 1]).toMatch(/^本命 · \d+ 人選用$/);

  await page.goto('/music/entries/main-0');
  await expectOption(page, 'J-POP喜歡程度', '4');
  await chooseOption(page, 'J-POP喜歡程度', '2');
  await page.getByRole('dialog').getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.reload();
  await expectOption(page, 'J-POP喜歡程度', '2');
  expect((await read()).selections).toEqual(before.selections.map((pick: { entryId: string; level: number }) => pick.entryId === 'main-0' ? { ...pick, level: 2 } : pick));
  expect(writes).toBe(2);
});
