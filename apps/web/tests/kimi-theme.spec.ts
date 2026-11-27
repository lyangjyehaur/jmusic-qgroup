import { test, expect } from './fixtures';
import { chooseOption } from './kimi-controls';
import type { Locator } from '@playwright/test';

const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
const color = (locator: Locator, property: 'color' | 'backgroundColor' | 'borderLeftColor' | 'fill' = 'color') =>
  locator.evaluate((el, key) => getComputedStyle(el)[key], property);

// Check visible regions, not only the data attributes or individual buttons:
// the original regression left the entire prototype accent fixed to moss green.
for (const width of [1440, 390]) test(`theme colors reach page regions and portal dialogs at ${width}px`, async ({ page, context }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const paper: string[] = [];
  for (const theme of ['light', 'dark']) {
    const samples: Record<string, string>[] = [];
    for (const preset of ['pink', 'gunju', 'blue', 'yellow']) {
      await page.goto('/activities');
      await page.getByLabel('外觀設定', { exact: true }).click();
      await chooseOption(page, '快速明暗模式', theme);
      await chooseOption(page, '快速主題色', preset);
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-preset', preset);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const navigation = page.locator(width > 768 ? '.sidebar .nav-item.active' : '.mobile-dock .dock-item.active');
      const accent = await page.locator('html').evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--app-accent)'; el.append(probe);
        const resolved = getComputedStyle(probe).color; probe.remove(); return resolved;
      });
      // Navigation has a color transition. Wait for its visible final state.
      await expect(navigation).toHaveCSS(width > 768 ? 'background-color' : 'color', accent);
      const summary = page.getByLabel('活動摘要', { exact: true });
      await expect(summary).toBeVisible();
      const sample = {
        navigation: await color(navigation, width > 768 ? 'backgroundColor' : 'color'),
        summary: await color(summary, 'backgroundColor'),
        summaryBorder: await color(summary, 'borderLeftColor'),
        success: await color(page.locator('.activity-status .badge-green').first()),
      };
      const background = await color(page.locator('html'), 'backgroundColor');
      if (preset === 'pink') {
        paper.push(background);
      }
      await page.screenshot({ path: `test-results/theme-activities-${width}-${theme}-${preset}.png`, fullPage: true });
      await page.goto('/music?explorer=bubbles');
      const domains = page.getByRole('region', { name: '領域排行', exact: true });
      const bubble = domains.getByRole('group', { name: '領域氣泡圖', exact: true }).locator('a').first();
      await expect(bubble).toBeVisible();
      await expect(page.getByRole('region', { name: '細分排行', exact: true }).getByRole('group', { name: '細分氣泡圖', exact: true })).toBeVisible();
      Object.assign(sample, {
        searchPanel: await color(page.locator('.music-search-area'), 'backgroundColor'),
        bubble: await color(bubble.locator('.bubble-circle'), 'fill'),
        link: await color(page.getByRole('contentinfo').getByRole('link', {name:'使用說明',exact:true})),
      });
      await bubble.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.music-entry-detail')).toBeVisible();
      Object.assign(sample, { dialogButton: await color(dialog.locator('.music-entry-detail .page-actions button').first(), 'backgroundColor') });
      // Portals share the same paper and dark-mode text as the page cards.
      expect(await color(dialog, 'backgroundColor')).toBe(await page.locator('html').evaluate(el => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--app-surface)'; el.append(probe);
        const resolved = getComputedStyle(probe).color; probe.remove(); return resolved;
      }));
      expect(await dialog.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (preset === 'pink') await page.screenshot({ path: `test-results/theme-dialog-${width}-${theme}.png`, fullPage: true });
      samples.push(sample);
    }
    await testInfo.attach(`${theme}-colors`, { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
    for (const region of ['navigation', 'summary', 'summaryBorder', 'searchPanel', 'bubble', 'link', 'dialogButton']) {
      expect(new Set(samples.map(sample => sample[region])).size, `${theme} ${region} must follow all four palettes`).toBe(4);
    }
    expect(new Set(samples.map(sample => sample.success)).size, 'registration success keeps its semantic green').toBe(1);
  }
  expect(paper[0]).not.toBe(paper[1]);
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-preset', 'yellow');
});
