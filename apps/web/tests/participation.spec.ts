import { test, expect } from './fixtures';
test.use({ participationExamples: true });
async function login(context: import('@playwright/test').BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}` }]);
}
test('opens from activities, filters expected totals, and drills down to the original public activities', async ({ page }) => {
  await page.goto('/activities');
  await page.getByRole('tab', { name: '參與統計', exact: true }).click();
  await expect(page).toHaveURL(/\/activities\/participation$/);
  await expect(page.getByRole('heading', { name: '參與統計', exact: true })).toBeVisible();
  await expect(page.locator('[aria-label="整體參與摘要"]')).toContainText('10');
  await expect(page.locator('.participation-table tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: '查看小青的參加紀錄', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '參加紀錄', exact: true });
  await expect(dialog).toBeVisible();
  const records = dialog.getByRole('region', { name: '小青的參加紀錄', exact: true });
  await expect(records.getByRole('heading')).toBeInViewport();
  await expect(records.locator('li')).toHaveCount(3);
  await expect(records.getByRole('link', { name: '河濱散步', exact: true })).toHaveAttribute('href', '/activities/stats-walk?' + new URLSearchParams({ from: new URL(page.url()).pathname + new URL(page.url()).search }));
  await expect(page.getByText('已取消的聚餐', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '關閉參加紀錄', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('combobox', { name: '活動類型', exact: true }).click();
  await page.getByRole('option', { name: '聚餐', exact: true }).click();
  await expect(page.locator('.participation-table tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: '查看小青的參加紀錄', exact: true }).click();
  await expect(records.locator('li')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('combobox', { name: '期間', exact: true }).click();
  await page.getByRole('option', { name: '2026 年 11 月', exact: true }).click();
  await expect(page).toHaveURL(/period=2026-11/);
  await page.screenshot({ path: 'artifacts/design/participation-implemented-desktop.png', fullPage: true });
});
test('shows the personal overview entry and participant records on mobile without horizontal overflow', async ({ page, context }) => {
  await login(context); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/me');
  const summary = page.getByRole('region', { name: '我的參與統計', exact: true });
  await expect(summary).toContainText('3');
  await summary.getByRole('link', { name: '參加紀錄', exact: true }).click();
  await expect(page).toHaveURL(/\/me\/participation$/);
  const records = page.getByRole('region', { name: '我的參加紀錄', exact: true });
  await expect(records.locator('li')).toHaveCount(3);
  await expect(page.getByRole('tab', { name: '我的', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/design/participation-implemented-mobile.png', fullPage: true });
  await context.clearCookies(); await page.reload();
  await expect(page.getByText('再查看本人參加紀錄。', { exact: false })).toBeVisible();
  await expect(page.locator('.participation-record-list li')).toHaveCount(0);
});
test('shows invalid-filter and empty states and keeps member details separate from another account', async ({ page, context }) => {
  await page.goto('/activities/participation?period=2026-13');
  await expect(page.getByText('統計篩選條件無效，請重新選擇。', { exact: true })).toBeVisible();
  await page.goto('/activities/participation?period=2025');
  await expect(page.getByText('這個期間沒有符合條件的已結束活動。', { exact: true })).toBeVisible();
  await login(context, 'bob'); await page.goto('/me/participation');
  await expect(page.getByRole('region', { name: '我的參加紀錄', exact: true }).locator('li')).toHaveCount(2);
  await expect(page.getByRole('link', { name: '河濱散步', exact: true })).toHaveCount(0);
});
