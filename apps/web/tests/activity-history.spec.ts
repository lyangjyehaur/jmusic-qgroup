import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context: BrowserContext) {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function headers(context: BrowserContext) {
  const viewer = await (await context.request.get('/api/v2/session')).json();
  return { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() };
}
test('same-named arrangement responses retain their original attendee targets in the visible history', async ({ page, context }) => {
  await login(context);
  const created = await context.request.post('/api/v2/activities/drafts', { headers: await headers(context), data: { values: {
    title: '同名安排核對', category: '约K', location: '原地點', startsAt: '2099-12-12T18:00:00+08:00', deadline: '2099-12-11T18:00:00+08:00', capacity: 5, feePolicy: '原費用',
  } } });
  expect(created.status()).toBe(200); const draft = await created.json(), base = '/api/v2/activities/' + draft.id;
  expect((await context.request.post(base + '/draft/publish', { headers: await headers(context), data: { revision: draft.revision, confirm: true, acceptConditions: true } })).status()).toBe(200);
  const current = await (await context.request.get(base + '/arrangements', { headers: await headers(context) })).json();
  const input = { revision: current.revision, people: [1, 2].map(() => ({ isSelf: false, name: '同名', note: '', payerKind: 'manager' })), queueMode: 'individual', intent: 'registered' };
  const preview = await context.request.post(base + '/registration/preview', { headers: await headers(context), data: input }); expect(preview.status()).toBe(200); const prepared = await preview.json();
  expect((await context.request.post(base + '/registration', { headers: await headers(context), data: { ...input, previewToken: prepared.token, conditionsVersion: prepared.conditionsVersion, acceptConditions: true, acceptPartial: true, confirm: true } })).status()).toBe(200);
  const edit = await (await context.request.get(base + '/arrangements', { headers: await headers(context) })).json();
  expect((await context.request.put(base + '/arrangements', { headers: await headers(context), data: { revision: edit.revision, values: { ...edit.values, location: '新地點' }, reason: '重新核對地點' } })).status()).toBe(200);
  const conditions = await (await context.request.get(base + '/conditions', { headers: await headers(context) })).json(), people = conditions.people.filter((p: { name: string }) => p.name === '同名'); expect(people).toHaveLength(2);
  for (const [index, person] of people.entries()) {
    const latest = await (await context.request.get(base + '/conditions', { headers: await headers(context) })).json();
    expect((await context.request.post(base + '/attendees/' + person.id + '/conditions', { headers: await headers(context), data: { revision: latest.revision, conditionsVersion: latest.current.version, decision: index ? 'declined' : 'accepted', reason: index ? '需要另行協調' : '' } })).status()).toBe(200);
  }
  await page.setViewportSize({ width: 360, height: 800 }); await page.goto('/activities/' + draft.id + '/history');
  const entries = page.locator('.history-entry').filter({ hasText: '確認新安排' }); await expect(entries).toHaveCount(2);
  for (const entry of await entries.all()) await entry.locator(".disclosure-trigger").click();
  for (const person of people) await expect(page.getByText('報名者：同名 · 報名編號：' + person.id, { exact: true })).toBeVisible();
  await expect(page.getByText('原因：需要另行協調', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-condition-history-mobile.png' });
});

test.describe('settlement audit metadata', () => {
  test.use({ settlementExamples: true });
  test('published settlement history shows its actual method and changed fields', async ({ page, context }) => {
    await login(context); await page.goto('/activities/listen/settlement/edit');
    await page.getByLabel('費用金額', { exact: true }).fill('10.00');
    await page.getByRole('checkbox', { name: '已逐人核對名單、費用約定、出席與付款歸屬。', exact: true }).check();
    await page.getByRole('button', { name: '預覽逐人結算', exact: true }).click();
    await expect(page.getByRole('region', { name: '逐人結算預覽', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: '已核對本版金額、圖片與群通知，確認發布。', exact: true }).check();
    await page.getByRole('button', { name: '發布逐人結算', exact: true }).click(); await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
    const history = await (await context.request.get('/api/v2/activities/listen/history', { headers: await headers(context) })).json();
    const saved = history.entries.find((entry: { action: string }) => entry.action === 'settlement_saved'); expect(saved.after.mode).toBe('detailed'); expect(saved.after.changed_fields.length).toBeGreaterThan(0);
    await page.goto('/activities/listen/history'); const entry = page.locator('.history-entry').filter({ hasText: '保存結算' }).first(); await entry.locator(".disclosure-trigger").click();
    await expect(entry.locator('dt').filter({ hasText: /^結算方式$/ })).toBeVisible(); await expect(entry.getByText('未設定 → 逐人結算', { exact: true })).toBeVisible();
    await expect(entry.getByText('未設定 → ' + saved.after.changed_fields.join('、'), { exact: true })).toBeVisible();
  });
});

test('draft participation changes alongside event snapshots remain visible in history', async ({ page, context }) => {
  await login(context);
  const created = await context.request.post('/api/v2/activities/drafts', { headers: await headers(context), data: { values: {
    title: '草稿本人參加核對', category: '其他', location: '原地點', startsAt: '2099-12-12T18:00:00+08:00', deadline: '2099-12-11T18:00:00+08:00', capacity: 5, joinOwner: false,
  } } });
  expect(created.status()).toBe(200); const draft = await created.json(), base = '/api/v2/activities/' + draft.id;
  const current = await (await context.request.get(base + '/draft', { headers: await headers(context) })).json();
  expect((await context.request.put(base + '/draft', { headers: await headers(context), data: { revision: current.revision, values: { ...current.values, joinOwner: true }, reason: '核對本人參加' } })).status()).toBe(200);
  await page.goto('/activities/' + draft.id + '/history'); const entry = page.locator('.history-entry').filter({ hasText: '修改活動' }).first(); await entry.locator(".disclosure-trigger").click();
  await expect(entry.getByText('草稿本人參加', { exact: true })).toBeVisible(); await expect(entry.getByText('否 → 是', { exact: true })).toBeVisible();
});
