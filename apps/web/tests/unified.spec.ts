import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: 'http://127.0.0.1:5082', httpOnly: true, sameSite: 'Lax' }]);
}
test('guest browses activity and music in one responsive shell', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/activities');
  await expect(page.getByRole('heading', { name: '活動', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '私人活動' })).toHaveCount(0);
  await page.getByRole('heading', { name: '週末一起聽日系音樂' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: '活動安排' })).toBeVisible();
  await page.getByRole('link', { name: '編輯我的成分' }).click();
  await expect(page.getByRole('heading', { name: '登入後才能保存成分' })).toBeVisible();
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '音樂', exact: true }).click();
  await page.getByRole('searchbox').fill('YOASOBI');
  await expect(page.locator('.entry')).toHaveCount(1);
  await page.goto('/activities');
  for (const width of [360, 390, 614, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('navigation')).toBeVisible();
  }
  await page.screenshot({ path: 'test-results/unified-activity-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/unified-activity-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('scoped draft survives refresh, preserves activity return, and safely retries a lost response', async ({ context, page }) => {
  await login(context);
  await page.goto('/me/music?from=%2Factivities%2Flisten');
  await expect(page.getByRole('heading', { name: '我的成分', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'J-POP', exact: true }).click();
  await page.getByRole('button', { name: 'YOASOBI', exact: true }).click();
  await page.getByLabel('YOASOBI喜歡程度').selectOption('4');
  await page.reload();
  await expect(page.getByRole('button', { name: 'YOASOBI', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('YOASOBI喜歡程度')).toHaveValue('4');
  let first = true;
  await page.route('**/api/v2/me/music', async route => {
    if (route.request().method() === 'PUT' && first) { first = false; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('尚未確認保存結果。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'YOASOBI', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '確認保存結果', exact: true }).click();
  await expect(page.getByText('已保存。')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存我的成分', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/unified-music-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '回到剛才的活動' }).click();
  await expect(page.getByRole('heading', { name: '週末一起聽日系音樂' })).toBeVisible();
});
test('account change never loads another account into an old profile scope', async ({ context, page }) => {
  await login(context); await page.goto('/me/music');
  await page.getByRole('button', { name: 'Aimer', exact: true }).click();
  await login(context, 'bob');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號')).toBeVisible();
  await page.reload();
  await expect(page.getByText('小白 的音樂成分', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aimer', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
test('unsaved navigation is explicit and mobile selection stays usable', async ({ context, page }) => {
  await login(context, 'bob'); await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/me/music');
  await page.getByRole('button', { name: '動畫歌曲', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '活動', exact: true }).click();
  await expect(page.getByRole('heading', { name: '還有未保存的選擇' })).toBeVisible();
  await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-music-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。')).toBeVisible();
});
test('storage failure blocks sending and damaged drafts are preserved for recovery', async ({ context, page }) => {
  await login(context, 'bob');
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }; });
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PUT') writes++; });
  await page.goto('/me/music');
  await page.getByRole('button', { name: 'J-POP', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存我的成分', exact: true })).toBeDisabled();
  await expect(page.getByText('瀏覽器無法保存草稿', { exact: false })).toBeVisible();
  expect(writes).toBe(0);
  const clean = await context.newPage();
  await clean.goto('/me/music');
  await expect(clean.getByRole('heading', { name: '我的成分', exact: true })).toBeVisible();
  const viewer = await (await context.request.get('/api/v2/session')).json();
  await clean.evaluate(scope => sessionStorage.setItem('qgroup:rebuild:music:v1:' + scope, 'damaged synthetic draft'), viewer.scope);
  await clean.reload();
  await expect(clean.getByText('此分頁的原草稿無法讀取', { exact: false })).toBeVisible();
  await clean.getByRole('button', { name: '保全原稿，從已保存版本開始' }).click();
  expect(await clean.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes(':recovery:')).map(key => sessionStorage.getItem(key)))).toContain('damaged synthetic draft');
  await clean.close();
});
test('a concurrent profile update returns conflict without replacing the local selection', async ({ context, page }) => {
  await login(context, 'bob'); await page.goto('/me/music');
  await page.getByRole('button', { name: 'Eve', exact: true }).click();
  const viewer = await (await context.request.get('/api/v2/session')).json();
  const previous = await (await context.request.get('/api/v2/me/music', { headers: { 'X-Account-Scope': viewer.scope } })).json();
  const update = await context.request.put('/api/v2/me/music', { headers: { Origin: 'http://127.0.0.1:5082', 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() }, data: { profileId: previous?.id ?? null, musicEpoch: viewer.musicEpoch, revision: previous?.revision ?? 0, selections: [{ entryId: 'main-4', level: 3 }] } });
  expect(update.status()).toBe(200);
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('成分已有更新；你的選擇仍保留，請核對最新版本')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Eve', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '核對最新版本，保留我的選擇' }).click();
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。')).toBeVisible();
});
