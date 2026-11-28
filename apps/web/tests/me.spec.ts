import { test, expect } from './fixtures';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;

test('personal overview opens each settings destination and retains direct and legacy URLs', async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
  await page.goto('/me');
  await expect(page.getByRole('region', { name: '我的資料', exact: true })).toContainText('小青');
  await page.getByRole('link', { name: '全部設定', exact: true }).click();
  const settings = page.getByRole('navigation', { name: '我的設定', exact: true });
  const destinations = [
    ['帳號與 QQ 綁定', '/me/accounts', '帳號'], ['站內稱呼', '/me/profile', '站內稱呼'],
    ['登入裝置', '/me/devices', '裝置與帳號紀錄'], ['我的收款碼', '/me/payment-codes', '我的收款碼'],
    ['外觀', '/me/appearance', '外觀設定'], ['應用程式', '/me/app', '應用程式'],
    ['資料與隱私', '/me/privacy', '隱私與資料刪除'],
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [label, path, title] of destinations) {
    await settings.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(origin + path);
    await expect(page.locator('.me-settings-panel').getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '我的資料', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('link', { name: '全部設定', exact: true }).click();
    await expect(page.getByRole('tab', { name: '設定', exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  for (const tab of ['account', 'privacy', 'danger']) {
    await page.goto('/me?tab=' + tab);
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('link')).toHaveCount(7);
    await expect(page.getByRole('tab', { name: '設定', exact: true })).toHaveAttribute('aria-selected', 'true');
  }
});

test('changing personal tabs still protects unfinished settings and permits discarding edits', async ({ page, context }) => {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin }]);
  await page.goto('/me/profile');
  await page.getByLabel('站內稱呼', { exact: true }).fill('尚未保存的稱呼');
  await page.getByRole('tab', { name: '總覽', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
  await expect(page).toHaveURL(origin + '/me/profile');
  await expect(page.getByLabel('站內稱呼', { exact: true })).toHaveValue('尚未保存的稱呼');
  await page.getByRole('tab', { name: '總覽', exact: true }).click();
  await page.getByRole('button', { name: '捨棄並離開', exact: true }).click();
  await expect(page).toHaveURL(origin + '/me');
  await page.goto('/me/profile');
  await expect(page.getByLabel('站內稱呼', { exact: true })).toHaveValue('小青');
});

test('guest has a clear login destination, local appearance access and an explicit draft state', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/me');
  await expect(page.getByRole('region', { name: '我的資料', exact: true }).getByRole('link', { name: '登入', exact: true })).toHaveAttribute('href', '/login?returnTo=%2Fme');
  await expect(page.getByRole('region', { name: '我的資料概覽', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '活動草稿', exact: true }).click();
  await expect(page.getByText('請先登入，再查看活動草稿。', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '設定', exact: true }).click();
  await page.getByRole('navigation', { name: '我的設定', exact: true }).getByRole('link', { name: '外觀', exact: true }).click();
  await expect(page.getByRole('radio', { name: '粉色', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
