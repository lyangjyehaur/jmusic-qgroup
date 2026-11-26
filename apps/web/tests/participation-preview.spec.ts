import { test, expect } from '@playwright/test';
import type { ActivityView } from '@qgroup/contracts';

// Run against the isolated production snapshot preview; this suite creates no fixtures.
const preview = process.env.REBUILD_PRODUCTION_PREVIEW_URL;
if (preview && !['127.0.0.1', 'localhost'].includes(new URL(preview).hostname)) throw Error('Preview acceptance requires an isolated localhost copy');
test.skip(!preview, '需指定隔離的線上資料副本預覽');
test.use({ baseURL: preview, serviceWorkers: 'block' });

test('participant records open in the viewport and return to the same real-data list', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/activities/participation');
    const rows = page.locator('.participation-table tbody tr');
    await expect(rows.first()).toBeVisible();
    const rowCount = await rows.count();
    const person = await rows.first().locator('.participation-name').innerText();
    const count = Number(await rows.first().locator('.participation-count').innerText());
    await expect(rows.first().locator('.participation-number')).toHaveText('1');
    await expect(rows.first().locator('.qq-avatar')).toBeVisible();
    const trigger = rows.first().getByRole('button');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '參加紀錄', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: person + '的參加紀錄', exact: true })).toBeInViewport();
    await expect(dialog.locator('.participation-record-list li')).toHaveCount(Math.min(count, 20));
    await dialog.getByRole('button', { name: '返回統計', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rows).toHaveCount(rowCount);
    await expect(trigger).toBeInViewport();
    await expect(page).not.toHaveURL(/member=/);
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeInViewport();
    await trigger.click();
    await expect(dialog).toBeVisible();
    const activity = dialog.locator('.participation-record-list a').first();
    const href = await activity.getAttribute('href');
    await activity.click();
    await expect(page).toHaveURL(url => url.pathname === href);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});

test('real-data participant ordinals continue across pages and avatars have a name fallback', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://**.qlogo.cn/**', route => route.abort());
  await page.goto('/activities/participation');
  const rows = page.locator('.participation-table tbody tr');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  await expect(rows.locator('.participation-number')).toHaveText(Array.from({ length: count }, (_, i) => String(i + 1)));
  await expect(rows.first().locator('.avatar-fallback')).toBeVisible();
  const name = await rows.first().locator('.participation-name').innerText();
  await expect(rows.first().locator('.avatar-fallback')).toHaveText(Array.from(name)[0] ?? '?');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const next = page.getByRole('button', { name: '下一頁', exact: true });
  if (await next.count()) {
    await next.click();
    await expect(rows.first().locator('.participation-number')).toHaveText('21');
    await page.getByRole('button', { name: '上一頁', exact: true }).click();
    await expect(rows.first().locator('.participation-number')).toHaveText('1');
  }
});

test('real historical activities below their minimum show an unformed status and can be filtered separately', async ({ page }) => {
  const events: ActivityView[] = [];
  for (let number = 1; ; number++) {
    const response = await page.request.get('/api/v2/activities?period=history&page=' + number);
    expect(response.ok()).toBe(true);
    const list = await response.json() as { events: ActivityView[]; hasMore: boolean };
    events.push(...list.events);
    if (!list.hasMore) break;
  }
  const unformed = events.filter(event => ['scheduled', 'ongoing', 'ended'].includes(event.phase) && (event.phase === 'ended' || event.estimatedOver) && event.confirmed < event.minimumParticipants);
  test.skip(!unformed.length, '線上副本沒有未成團的往期活動');
  const status = page.getByRole('combobox', { name: '篩選活動狀態', exact: true });
  async function chooseStatus(label: string) {
    await status.click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  for (const viewport of [{ width: 430, height: 932 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/activities?period=history');
    const target = unformed[0]!;
    const row = page.locator('.activity-row').filter({ has: page.getByRole('link', { name: target.title, exact: true }) });
    await expect(row.locator('.activity-status')).toContainText('未成團');
    await expect(row.locator('.activity-status')).toContainText('最低 ' + target.minimumParticipants + ' 人');
    await chooseStatus('未成團');
    await expect(page).toHaveURL(/status=unformed/);
    await expect(page.locator('.activity-row')).toHaveCount(Math.min(unformed.length, 20));
    await expect(row.locator('.activity-status')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(status).toHaveText('未成團');
    await expect(row.locator('.activity-status')).toContainText('未成團');
    await chooseStatus('已結束');
    await expect(row).toHaveCount(0);
    await chooseStatus('全部狀態');
    await expect(row).toBeVisible();
  }
});
