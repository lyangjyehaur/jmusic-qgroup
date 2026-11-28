import { test, expect } from './fixtures';
import { closeMusicLevel } from './kimi-controls';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;

test('shell switches its brand, sidebar and dock together at both responsive boundaries', async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
  await page.goto('/activities');
  for (const width of [760, 761, 767, 768, 769, 1100, 1101, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const mobile = width <= 768;
    await expect(page.locator('.mobile-brand')).toBeVisible({ visible: mobile });
    await expect(page.locator('.sidebar')).toBeVisible({ visible: !mobile });
    await expect(page.locator('.mobile-dock')).toBeVisible({ visible: mobile });
    if (mobile) {
      const dock = page.locator('.mobile-dock');
      const bounds = (await dock.boundingBox())!;
      expect(bounds.y + bounds.height).toBe(900);
      for (const link of await dock.getByRole('link').all()) {
        const icon = (await link.locator('svg').boundingBox())!;
        const label = (await link.locator('span').boundingBox())!;
        expect(icon.y + icon.height).toBeLessThanOrEqual(label.y + 1);
        expect(Math.abs(icon.x + icon.width / 2 - label.x - label.width / 2)).toBeLessThanOrEqual(1);
      }
    } else {
      const sidebar = (await page.locator('.sidebar').boundingBox())!;
      const column = (await page.locator('.main-column').boundingBox())!;
      expect(sidebar.width).toBe(width <= 1100 ? 76 : 208);
      expect(column.x).toBe(sidebar.x + sidebar.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('restored drafts leave the end of a long term dialog reachable', async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/music?library=all');
  await page.getByRole('button', { name: '選取Aimer', exact: true }).click();
  await closeMusicLevel(page);
  const dock = page.getByRole('region', { name: '詞條變動保存', exact: true });
  await dock.getByRole('button', { name: '保存詞條變動', exact: true }).click();
  await expect(dock).toHaveCount(0);
  await page.route('**/api/v2/music/entries/sub-2/members', async route => {
    const response = await route.fetch(), data = await response.json();
    expect(data.members.length).toBeGreaterThan(0);
    // A popular term must still expose its last member after scrolling to the end.
    await route.fulfill({ response, json: { ...data, members: Array.from({ length: 40 }, (_, i) => ({ ...data.members[0], id: 'm_' + i.toString(16).padStart(32, '0') })) } });
  });
  await page.goto('/music/entries/sub-2');
  await page.getByRole('button', { name: '調整喜歡程度', exact: true }).click();
  await page.locator('.music-level-dialog').getByRole('button', { name: '只聽過幾首', exact: true }).click();
  page.on('dialog', d => void d.accept());
  await page.reload();
  await expect(dock).toContainText('有尚未保存的本機草稿');
  const dialog = page.locator('.discovery-dialog'), body = dialog.locator('[class*=dialogBody]');
  await expect(body.locator('.entry-selector-list > li')).toHaveCount(40);
  await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const last = body.locator('.term-selection-controls .page-actions').last();
  const content = (await last.boundingBox())!;
  expect(content.y + content.height).toBeLessThanOrEqual((await dock.boundingBox())!.y);
});
