import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
async function languageHeader(context: BrowserContext, language: string) {
  // Chrome's locale overrides extraHTTPHeaders for Accept-Language. Send the
  // requested header at the transport boundary, through the real fixture API.
  await context.route('http://127.0.0.1:5082/**', route => route.continue({ headers: { ...route.request().headers(), 'accept-language': language } }));
}
for (const language of ['zh-CN', 'zh-TW', 'en-US,zh-CN;q=0.9']) test('the highest-priority '+language+' header selects consistent public navigation, privacy and account labels', async ({ page, context }) => {
  await languageHeader(context, language);
  const simplified = language === 'zh-CN', expected = simplified ? 'zh-Hans' : 'zh-Hant';
  const response = await page.goto('/activities');
  expect(response?.headers()['content-language']).toBe(expected);expect(response?.headers().vary).toBe('Accept-Language');
  await expect(page.locator('html')).toHaveAttribute('lang', expected);
  await expect(page.getByRole('heading', { name: simplified ? '活动' : '活動', exact: true })).toBeVisible();
  await page.getByRole('link', { name: simplified ? '音乐' : '音樂', exact: true }).click();
  await expect(page.getByRole('heading', { name: simplified ? '音乐' : '音樂', exact: true })).toBeVisible();
  await page.goto('/privacy');await expect(page.getByRole('heading', { name: simplified ? '隐私政策' : '隱私政策', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '渝ICP备16002872号-1', exact: true })).toBeVisible();
  await expect(page.locator('article')).not.toHaveAttribute('lang', 'zh-Hans');
  await page.goto('/me/profile');await expect(page.getByRole('heading', { name: simplified ? '站内称呼' : '站內稱呼', exact: true })).toBeVisible();
});
test.describe('localized offline navigation', () => {
  test.use({ serviceWorkers: 'allow', locale: 'zh-CN' });
  test('the worker returns simplified recovery instructions and no cached account or activity data', async ({ page, context }) => {
    await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: 'http://127.0.0.1:5082', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/me/app');await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')).toMatch(/\/sw.js$/);
    await page.goto('/activities/listen');await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
    try {
      await context.setOffline(true);const response = await page.goto('/activities/listen');expect(response?.status()).toBe(503);expect(response?.headers()['content-language']).toBe('zh-Hans');await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
      await expect(page.getByRole('heading', { name: '暂时无法连线', exact: true })).toBeVisible();await expect(page.locator('body')).not.toContainText('週末一起聽日系音樂');await expect(page.locator('body')).not.toContainText('小青');
    } finally { await context.setOffline(false); }
    await page.reload();await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
  });
});
for (const language of ['zh-CN', 'zh-TW']) test(language+' account saves retain original mixed-script user content and show the actual localized result', async ({ page, context }) => {
  await languageHeader(context, language);await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: 'http://127.0.0.1:5082', httpOnly: true, sameSite: 'Lax' }]);
  const simplified = language === 'zh-CN', raw = '后台發 · 帐号後臺';
  await page.goto('/me/profile');const field = page.getByLabel(simplified ? '站内称呼' : '站內稱呼', { exact: true });await field.fill(raw);
  const sent = page.waitForRequest(request => request.url().endsWith('/api/v2/me/profile') && request.method() === 'PUT');
  await page.getByRole('button', { name: simplified ? '保存称呼' : '保存稱呼', exact: true }).click();expect((await sent).postDataJSON().nickname).toBe(raw);
  await expect(page.getByText(simplified ? '已保存称呼。' : '已保存稱呼。', { exact: true })).toBeVisible();await expect(field).toHaveValue(raw);
  await page.reload();await expect(field).toHaveValue(raw);await expect(page.locator('.viewer')).toHaveText(raw);
  if (simplified) {
    await page.setViewportSize({ width: 360, height: 800 });await expect(page.locator('header.header')).toHaveCount(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await page.screenshot({ path: 'test-results/unified-language-mobile.png', fullPage: true });
  }
});
test('a simplified activity form preserves the original category protocol and mixed-script draft after reload', async ({ page, context }) => {
  await languageHeader(context, 'zh-CN');await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: 'http://127.0.0.1:5082', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/activities/new');const field = page.getByLabel('活动名称', { exact: true });await field.fill('后台發 · 帐号後臺');
  await page.getByLabel('活动类型', { exact: true }).selectOption('运动');expect(await page.getByLabel('活动类型', { exact: true }).inputValue()).toBe('运动');
  await expect(page.getByText('正在保存本機原稿…', { exact: true })).toHaveCount(0);await page.reload();await expect(field).toHaveValue('后台發 · 帐号後臺');await expect(page.getByLabel('活动类型', { exact: true })).toHaveValue('运动');
});
