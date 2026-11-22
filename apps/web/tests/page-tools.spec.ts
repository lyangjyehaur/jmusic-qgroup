import { test, expect } from './fixtures';
import { durableRows } from './draft-helpers';
const origin = 'http://127.0.0.1:5082';

for (const mobile of [false, true]) test(`returning to the top preserves unfinished music at ${mobile ? '360px with reduced motion' : 'desktop width'}`, async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await page.setViewportSize({ width: mobile ? 360 : 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: mobile ? 'reduce' : 'no-preference' });
  await page.goto('/me/music');
  const top = page.getByRole('button', { name: '回到頂部', exact: true });
  await expect(top).toHaveCount(0);
  await page.getByRole('button', { name: 'Aimer', exact: true }).click();
  await page.getByLabel('Aimer喜歡程度').selectOption('4');
  await expect(page.getByText('正在保存本機原稿…', { exact: true })).toHaveCount(0);
  const original = await durableRows(page);
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PUT') writes++; });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(top).toBeInViewport();
  if (mobile) {
    const tool = await top.boundingBox(), save = await page.locator('.editor-actions').boundingBox();
    expect(tool!.y + tool!.height).toBeLessThanOrEqual(save!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => {
    const original = window.scrollTo.bind(window);
    window.scrollTo = ((options: ScrollToOptions) => {
      document.documentElement.dataset.topScrollBehavior = options.behavior;
      original(options);
    }) as typeof window.scrollTo;
  });
  await top.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(page.locator('#main')).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-top-scroll-behavior', mobile ? 'instant' : 'smooth');
  await expect(top).toHaveCount(0);
  await expect(page.getByLabel('Aimer喜歡程度')).toHaveValue('4');
  expect(await durableRows(page)).toEqual(original);
  expect(writes).toBe(0);
});

test('mobile save stays above a reduced visual viewport and returns after the keyboard closes without losing input', async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/me/music');
  await page.getByRole('button', { name: 'Aimer', exact: true }).click();
  await page.getByLabel('Aimer喜歡程度').selectOption('4');
  await expect(page.getByText('正在保存本機原稿…', { exact: true })).toHaveCount(0);
  const original = await durableRows(page);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.getByRole('button', { name: '回到頂部', exact: true })).toBeInViewport();
  await page.getByLabel('尋找喜歡的音樂', { exact: true }).focus();
  // Exercise the browser's keyboard viewport contract without claiming a real phone keyboard run.
  await page.evaluate(() => {
    const viewport = visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 450 }, offsetTop: { configurable: true, value: 20 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  const save = page.getByRole('button', { name: '保存我的成分', exact: true });
  await expect.poll(async () => { const box = await save.boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(470);
  await expect(page.getByRole('button', { name: '回到頂部', exact: true })).toHaveCount(0);
  expect(await durableRows(page)).toEqual(original);
  await page.evaluate(() => {
    for (const key of ['height', 'offsetTop', 'scale']) Reflect.deleteProperty(visualViewport!, key);
    visualViewport!.dispatchEvent(new Event('resize'));
    (document.activeElement as HTMLElement)?.blur();
    scrollTo(0, document.documentElement.scrollHeight);
  });
  await expect.poll(async () => { const box = await page.locator('.editor-actions').boundingBox(); return box!.y + box!.height; }).toBe(800);
  const top = page.getByRole('button', { name: '回到頂部', exact: true });
  await expect(top).toBeInViewport();
  const tool = await top.boundingBox(), bar = await page.locator('.editor-actions').boundingBox();
  expect(tool!.y + tool!.height).toBeLessThanOrEqual(bar!.y);
  await save.click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await expect(page.locator('.editor-actions')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-actions-height'))).toBe('0px');
});
