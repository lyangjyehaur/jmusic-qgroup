import { expectOption, expectControlValue, closeMusicLevel } from './kimi-controls';
import type { BrowserContext } from '@playwright/test';
import { test, expect } from './fixtures';

test.use({ musicShouts: true });
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
const field = '搜尋活動、詞條或成分稱呼';
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}

test('opens one search from the shared header and restores the original query after activity navigation', async ({ page, context }) => {
  await login(context); await page.goto('/activities'); await page.getByRole('link', { name: '全站搜尋' }).click();
  await page.getByLabel(field).fill('日系'); await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page).toHaveURL(/\/search\?q=/); await expect(page.getByRole('region', { name: '活動搜尋結果' })).toBeVisible();
  await page.getByRole('link', { name: '週末一起聽日系音樂', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '週末一起聽日系音樂' })).toBeVisible();
  await page.getByRole('link', { name: '← 回到搜尋', exact: true }).click();
  await expectControlValue(page.getByLabel(field), '日系'); await expect(page.getByRole('link', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
});

test('keeps pinyin and kana searches available to visitors while explaining the member qualification beside people results', async ({ page }) => {
  await page.goto('/search?q=mjxs'); await expect(page.getByRole('link', { name: '米津玄師', exact: true })).toBeVisible();
  await expect(page.getByText('登入後可搜尋同好。', { exact: true })).toBeVisible();
  await page.getByLabel(field).fill('ｙｒｓｋ'); await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByRole('link', { name: 'ヨルシカ', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'ヨルシカ', exact: true }).click();
  await expect(page.getByRole('heading', { name: '詞條資料', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '← 回到搜尋', exact: true }).click(); await expectControlValue(page.getByLabel(field), 'ｙｒｓｋ');
});

test('does not carry private activity results across a device account change', async ({ page, context }) => {
  await login(context); await page.goto('/search?q=%E7%A7%81%E4%BA%BA');
  await expect(page.getByRole('link', { name: '私人活動', exact: true })).toBeVisible();
  await login(context, 'bob'); await page.reload();
  await expect(page.getByText('沒有符合條件且可查看的活動。', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '私人活動', exact: true })).toHaveCount(0);
  await page.getByLabel(field).fill('日系'); await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByRole('link', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
});

test('lets a member without music search activities and terms without inventing an empty people result', async ({ page, context }) => {
  await login(context, 'auth-owner'); await page.goto('/search?q=mjxs');
  await expect(page.getByRole('link', { name: '米津玄師', exact: true })).toBeVisible();
  await expect(page.getByText('保存成分後可搜尋同好。', { exact: true })).toBeVisible();
  await expect(page.getByText('沒有符合條件的成分稱呼。', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '建立或找回成分', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '我的成分' })).toBeVisible();
  await page.getByRole('link', { name: '← 回到搜尋', exact: true }).click(); await expectControlValue(page.getByLabel(field), 'mjxs');
});

test('returns from a visible person and comparison to the same submitted name search', async ({ page, context }) => {
  await login(context); await page.goto('/search?' + new URLSearchParams({ q: '找搭子乙' }));
  await page.getByRole('link', { name: '找搭子乙', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '找搭子乙', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '比較成分', exact: true }).click();
  await expect(page.getByRole('heading', { name: '成分比較', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '← 回到搜尋', exact: true }).click(); await expectControlValue(page.getByLabel(field), '找搭子乙');
  await expect(page.getByRole('link', { name: '找搭子乙', exact: true })).toBeVisible();
});

test('keeps the shared unsaved music selection while visiting search, a term and the profile editor', async ({ page, context }) => {
  await login(context); await page.goto('/search?q=mjxs'); await page.getByRole('link', { name: '米津玄師', exact: true }).click();
  await page.getByRole('button', { name: '選取此詞條', exact: true }).click();await closeMusicLevel(page);
  await expect(page.getByRole('button', { name: '調整喜歡程度', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: '← 回到搜尋', exact: true }).click();
  await page.getByRole('link', { name: '米津玄師', exact: true }).click();
  await expect(page.getByRole('button', { name: '調整喜歡程度', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: '編輯我的成分', exact: true }).click();
  await expectOption(page,'米津玄師喜歡程度','3');
  await page.getByRole('link', { name: '← 回到搜尋', exact: true }).click(); await expectControlValue(page.getByLabel(field), 'mjxs');
});

test('shows a source failure and retries the same search without substituting empty results', async ({ page, context }) => {
  await login(context); let first = true;
  await page.route('**/api/v2/search?**', async route => {
    if (first) { first = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SYNTHETIC_SOURCE_FAILURE', message: '合成來源暫停' }) }); }
    else await route.continue();
  });
  await page.goto('/search?q=mjxs'); await expect(page.getByRole('alert')).toContainText('合成來源暫停');
  await expect(page.getByText('沒有符合條件的詞條。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await expect(page.getByRole('link', { name: '米津玄師', exact: true })).toBeVisible();
  await expectControlValue(page.getByLabel(field), 'mjxs');
});

test('does not display a delayed earlier query over the current search or overwrite the typed input', async ({ page, context }) => {
  await login(context); let release!: () => void, seen!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { seen = resolve; });
  await page.route('**/api/v2/search?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'mjxs') { const response = await route.fetch(); seen(); await gate; await route.fulfill({ response }); }
    else await route.continue();
  });
  await page.goto('/search?q=mjxs'); await requested;
  await page.getByLabel(field).fill('yrsk'); await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByRole('link', { name: 'ヨルシカ', exact: true })).toBeVisible();
  await page.getByLabel(field).fill('尚未提交的查詢'); release();
  await expect(page.getByRole('link', { name: '米津玄師', exact: true })).toHaveCount(0); await expectControlValue(page.getByLabel(field), '尚未提交的查詢');
  await page.goBack(); await expectControlValue(page.getByLabel(field), 'mjxs'); await expect(page.getByRole('link', { name: '米津玄師', exact: true })).toBeVisible();
});

for (const width of [360, 390, 614, 768, 1280]) test(width + 'px: keeps the shared header, search control and long result names visible without horizontal overflow', async ({ page, context }, info) => {
  await login(context); await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v2/search?**', async route => {
    const response = await route.fetch(), body = await response.json();
    body.activities.items[0].title = '長活動名稱'.repeat(12) + 'LongUnbrokenName'.repeat(12);
    await route.fulfill({ response, json: body });
  });
  await page.goto('/search?' + new URLSearchParams({ q: '日系' }));
  await expect(page.getByRole('region', { name: '活動搜尋結果' })).toBeVisible();
  await expect(page.getByLabel(field)).toBeVisible(); await expect(page.getByRole('button', { name: '搜尋', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  for (const label of ['全部', '活動', '音樂詞條', '同好']) {
    const control = page.getByLabel('搜尋分類').getByRole('link', { name: label, exact: true });
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox(); expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  const screenshot = await page.screenshot({ fullPage: true }); await info.attach('search-' + width + 'px', { body: screenshot, contentType: 'image/png' });
  await page.getByRole('button', { name: '返回原頁', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: width <= 768 ? '手機主要導覽' : '主要導覽' });
  for (const label of ['活動', '音樂', '同好', '我的']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
});
