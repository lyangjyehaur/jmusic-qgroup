import { closeMusicLevel } from './kimi-controls';
import { test, expect } from './fixtures';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;

for (const size of [{ width: 430, height: 932, top: 47, bottom: 34, sides: 0 }, { width: 740, height: 430, top: 0, bottom: 21, sides: 44 }]) {
  test(`mobile shell reserves safe areas without hiding navigation at ${size.width}px`, async ({ page, context }) => {
    await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
    await page.setViewportSize(size); await page.goto('/activities');
    await expect(page.locator('meta[name=viewport]')).toHaveAttribute('content', /viewport-fit=cover/);
    await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'none');
    // Desktop engines have no Home indicator. Exercise the same safe-area tokens
    // with portrait/landscape insets, rather than claim an iOS device run.
    await page.evaluate(({ top, bottom, sides }) => {
      const root = document.documentElement.style;
      root.setProperty('--safe-area-top', `${top}px`);
      root.setProperty('--safe-area-bottom', `${bottom}px`);
      root.setProperty('--safe-area-left', `${sides}px`);
      root.setProperty('--safe-area-right', `${sides}px`);
    }, size);
    const dock = page.getByRole('navigation', { name: '手機主要導覽', exact: true });
    await expect(dock).toHaveCSS('height', `${62 + size.bottom}px`);
    await expect(dock).toHaveCSS('padding-bottom', `${size.bottom}px`);
    const nav = (await dock.boundingBox())!;
    expect(nav.y + nav.height).toBe(size.height);
    for (const link of await dock.getByRole('link').all()) {
      const box = (await link.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(52);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height - size.bottom);
      expect(box.x).toBeGreaterThanOrEqual(size.sides);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width - size.sides);
    }
    await expect(page.locator('.topbar')).toHaveCSS('height', `${56 + size.top}px`);
    const appearance = page.getByRole('button', { name: '外觀設定', exact: true });
    await expect(appearance.locator('span')).not.toBeVisible();
    const button = (await appearance.boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(40);
    expect(button.y).toBeGreaterThanOrEqual(size.top);
    const pageBottom = await page.locator('.kimi.page').first().evaluate(el => parseFloat(getComputedStyle(el).paddingBottom));
    expect(pageBottom).toBeGreaterThanOrEqual(nav.height);
    expect(await page.locator('.kimi.page').first().evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThanOrEqual(size.sides);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    expect((await dock.boundingBox())!.y).toBe(nav.y);
    await page.evaluate(() => scrollTo(0, 0));
    expect((await dock.boundingBox())!.y).toBe(nav.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('link', { name: '全站搜尋', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
    expect(await dialog.locator('[class*="dialogBody"]').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThanOrEqual(size.sides);
    const close = (await dialog.getByRole('button', { name: '返回原頁', exact: true }).boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(size.width - size.sides);
  });
}

test('overscroll and browser chrome changes never lift the dock or save reminder', async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
  await page.setViewportSize({ width: 430, height: 932 }); await page.goto('/music?library=all');
  await page.getByRole('button', { name: '選取Aimer', exact: true }).click();await closeMusicLevel(page);
  const dock = page.locator('.mobile-dock'), save = page.locator('.music-save-dock:not([hidden])');
  const nav = (await dock.boundingBox())!, actions = (await save.boundingBox())!;
  for (const change of [{ height: 932, offsetTop: -80 }, { height: 852, offsetTop: 0 }, { height: 700, offsetTop: 0 }]) {
    await page.evaluate(change => {
      Object.defineProperties(visualViewport!, {
        height: { configurable: true, value: change.height },
        offsetTop: { configurable: true, value: change.offsetTop },
        scale: { configurable: true, value: 1 },
      });
      visualViewport!.dispatchEvent(new Event('scroll'));
      visualViewport!.dispatchEvent(new Event('resize'));
    }, change);
    await expect(dock).toHaveCSS('bottom', '0px');
    await expect(save).toHaveCSS('bottom', '74px');
    expect((await dock.boundingBox())!.y).toBe(nav.y);
    expect((await save.boundingBox())!.y).toBe(actions.y);
  }
});

for (const width of [430, 1440]) test(`navigation and tabs use color states without underlines at ${width}px`, async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
  await page.setViewportSize({ width, height: 932 }); await page.goto('/activities');
  const nav = page.locator(width < 769 ? '.mobile-dock' : '.side-nav');
  for (const link of await nav.getByRole('link').all()) {
    await link.hover(); await expect(link).toHaveCSS('text-decoration-line', 'none');
  }
  const tabs = page.getByRole('tablist', { name: '活動篩選', exact: true });
  for (const tab of await tabs.getByRole('tab').all()) {
    await tab.hover();
    expect(await tab.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
    await expect(tab).toHaveCSS('text-decoration-line', 'none');
  }
  await tabs.getByRole('tab', { name: '我的活動', exact: true }).click();
  const active = tabs.getByRole('tab', { name: '我的活動', exact: true });
  await expect(active).toHaveAttribute('aria-selected', 'true');
  expect(await active.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
  expect(await active.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await active.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '往期與歸檔', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tabs.getByRole('tab', { name: '往期與歸檔', exact: true })).toHaveAttribute('aria-selected', 'true');
  const account = page.getByRole('button', { name: '帳號選單', exact: true });
  await account.click();
  const menuLink = page.locator('.menu-popover').getByRole('link', { name: '帳號與設定', exact: true });
  await menuLink.hover(); await expect(menuLink).toHaveCSS('text-decoration-line', 'none');
  await page.keyboard.press('Escape'); await expect(account).toBeFocused();
});
