import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';

const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function headers(context: BrowserContext) {
  const viewer = await (await context.request.get('/api/v2/session')).json();
  return { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() };
}
async function setup(context: BrowserContext) {
  await login(context);
  const created = await context.request.post('/api/v2/activities/drafts', { headers: await headers(context), data: { values: {
    title: '活動操作驗收', category: '约K', location: '隔離測試', startsAt: '2099-12-12T18:00:00+08:00',
    deadline: '2099-12-11T18:00:00+08:00', capacity: 5, feePolicy: '依公布帳單結算',
  } } });
  expect(created.status()).toBe(200);
  const event = await created.json();
  expect((await context.request.post(`/api/v2/activities/${event.id}/draft/publish`, {
    headers: await headers(context), data: { revision: event.revision, confirm: true, acceptConditions: true },
  })).status()).toBe(200);
  await login(context, 'bob');
  return event.id as string;
}
async function submit(page: Page) {
  await page.getByRole('button', { name: '預覽逐人分配', exact: true }).click();
  await page.getByLabel(/^已核對第 \d+ 版安排、費用與逐人分配/).check();
  await page.getByRole('button', { name: '提交報名', exact: true }).click();
}
test('signup returns to the mounted activity with current personal status and roster', async ({ page, context }) => {
  const id = await setup(context);
  await page.goto('/activities/' + id);
  await page.locator('.activity-overview-mount').evaluate(node => node.setAttribute('data-retained', 'yes'));
  await page.getByRole('button', { name: '本人報名', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('報名已保存。', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '管理本人報名', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '本人報名', exact: true })).toHaveCount(0);
  await expect(page.locator('#participants')).toContainText('小白');
  await expect(page.locator('.activity-overview-mount')).toHaveAttribute('data-retained', 'yes');
});
test('closing a companion operation preserves the draft and returning restores it', async ({ page, context }) => {
  const id = await setup(context);
  await page.goto('/activities/' + id);
  await page.getByRole('link', { name: '同行／代報名', exact: true }).click();
  await page.locator('#signup-name-0').fill('保留的同行');
  await page.getByRole('button', { name: '返回活動', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '繼續編輯', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
  await expect(page.locator('#signup-name-0')).toHaveValue('保留的同行');
  await page.getByRole('button', { name: '返回活動', exact: true }).click();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: '同行／代報名', exact: true }).click();
  await page.getByRole('button', { name: '恢復本機原稿', exact: true }).click();
  await expect(page.locator('#signup-name-0')).toHaveValue('保留的同行');
});
test('a roster withdrawal targets that person and refreshes the activity after confirmation', async ({ page, context }) => {
  const id = await setup(context);
  await page.goto('/activities/' + id + '/signup');
  await submit(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const info = await (await context.request.get(`/api/v2/activities/${id}/registration`, { headers: await headers(context) })).json();
  const person = info.people.find((item: { isMe: boolean }) => item.isMe);
  await page.locator('#participants').getByRole('link', { name: '退出報名', exact: true }).click();
  await expect(page.getByLabel('報名者', { exact: true })).toHaveValue(person.id);
  await expect(page.getByLabel('報名操作', { exact: true })).toHaveValue('withdraw');
  await page.getByLabel(/^已核對此人的報名，確認/).check();
  await page.getByRole('button', { name: '提交報名操作', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('報名操作已保存。', { exact: true })).toBeVisible();
  await expect(page.locator('#participants')).not.toContainText('小白');
  await expect(page.getByRole('button', { name: '本人報名', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '本人報名', exact: true }).click();
  await expect(page.getByRole('link', { name: '管理本人報名', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('a self note can continue in the companion dialog without a competing navigation blocker', async ({ page, context }) => {
  const id = await setup(context);
  await page.goto('/activities/' + id);
  await page.getByText('報名備註與規則', { exact: true }).click();
  await page.getByLabel('報名備註（活動內可見）', { exact: true }).fill('本人的原備註');
  await page.getByRole('link', { name: '同行／代報名', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '恢復本機原稿', exact: true }).click();
  await expect(page.locator('#signup-note-0')).toHaveValue('本人的原備註');
  await page.getByRole('button', { name: '新增同行', exact: true }).click();
  await page.locator('#signup-name-1').fill('新增同行');
  await submit(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#participants')).toContainText('本人的原備註');
  await expect(page.locator('#participants')).toContainText('新增同行');
});
test('a lost signup response stays in the operation until the same request is confirmed', async ({ page, context }) => {
  const id = await setup(context), keys: string[] = [];
  let first = true;
  await page.route(`**/api/v2/activities/${id}/registration`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    if (first) { first = false; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.goto('/activities/' + id + '/signup');
  await submit(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '確認報名操作結果', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '確認報名操作結果', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const info = await (await context.request.get(`/api/v2/activities/${id}/registration`, { headers: await headers(context) })).json();
  expect(info.people.filter((item: { isMe: boolean }) => item.isMe)).toHaveLength(1);
});
test('activity and operation stay usable on narrow and wide screens', async ({ page, context }) => {
  const id = await setup(context);
  await page.goto('/activities/' + id);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: '同行／代報名', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCSS('opacity', '1');
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '預覽逐人分配', exact: true })).toBeVisible();
    if (width === 360 || width === 1280) await page.screenshot({ path: `test-results/board-signup-${width}.png` });
    await page.getByRole('button', { name: '返回活動', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});
