import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
test.use({ settlementExamples: true });
const origin = 'http://127.0.0.1:5082',
  base = '/activities/listen/settlement';
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([
    { name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
}
async function prepare(page: Page, amount = '10.00') {
  await page.getByLabel('費用金額', { exact: true }).fill(amount);
  await page.getByRole('checkbox', { name: '已逐人核對名單、費用約定、出席與付款歸屬。', exact: true }).check();
}
async function preview(page: Page) {
  await page.getByRole('button', { name: '預覽逐人結算', exact: true }).click();
  await expect(page.getByRole('region', { name: '逐人結算預覽', exact: true })).toBeVisible();
}
async function save(page: Page) {
  await page.getByRole('checkbox', { name: '已核對本版金額、圖片與群通知，確認發布。', exact: true }).check();
  await page.getByRole('button', { name: '發布逐人結算', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
}
async function image(page: Page) {
  const raw = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 50;
    c.height = 50;
    const x = c.getContext('2d')!;
    x.fillStyle = '#345678';
    x.fillRect(0, 0, 50, 50);
    return c.toDataURL().split(',')[1]!;
  });
  return { name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(raw, 'base64') };
}
test('publishes exact independent allocation with receipt, opted-in group preview and a reasoned second version', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(base + '/edit');
  await prepare(page, '0.05');
  await page.getByLabel('消費憑證（最多三項附圖）', { exact: true }).setInputFiles(await image(page));
  await expect(page.getByRole('img', { name: '新消費憑證 · 消費', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /允許群通知包含逐人金額/ }).check();
  await preview(page);
  const region = page.getByRole('region', { name: '逐人結算預覽', exact: true });
  await expect(region.getByText('小青 · ¥0.02 · 1 份', { exact: true })).toBeVisible();
  await expect(region.getByRole('img', { name: '本版消費憑證預覽', exact: true })).toBeVisible();
  await expect(region.getByText('群通知明細預覽', { exact: true })).toBeVisible();
  await save(page);
  await page.getByRole('link', { name: '查看已發布結算', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第 1 版 · 逐人結算', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '核對並發布逐人結算', exact: true }).click();
  await page.getByLabel('費用金額', { exact: true }).fill('0.08');
  await page.getByLabel('發布／修改原因（最多 300 字）', { exact: true }).fill('店家修正');
  await page.getByRole('checkbox', { name: /已逐人核對名單/ }).check();
  await preview(page);
  await save(page);
  await page.getByRole('link', { name: '查看已發布結算', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第 2 版 · 逐人結算', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第 1 版 · 0.05 元', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第 1 版 · 逐人結算', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '查看本版收款碼與消費憑證', exact: true }).click();
  await expect(page.getByRole('img', { name: '消費憑證 · 消費', exact: true })).toBeVisible();
});
test('plans rooms without money and publishes actual rooms with frozen separate transfers at 360px', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/activities/listen/rooms');
  await page.getByRole('button', { name: '新增包間', exact: true }).click();
  await page.getByLabel('包間名稱', { exact: true }).fill('一房');
  await page.getByLabel('包間付款人', { exact: true }).selectOption({ label: '小青' });
  await page.getByText('包間人員 · 0 人', { exact: true }).click();
  for (const name of ['小青', '小白', '同行']) await page.getByRole('checkbox', { name, exact: true }).check();
  await page.getByRole('checkbox', { name: /已核對包間人員與付款人/ }).check();
  await page.getByRole('button', { name: '保存預分包間', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '收付款帳本', exact: true }).click();
  await expect(page.getByText('尚無已確認款項，申報確認後才會列入。', { exact: true })).toBeVisible();
  await page.goto(base + '/edit');
  await expect(page.getByLabel('結算方式', { exact: true })).toHaveValue('rooms');
  await page.getByLabel('包間消費金額', { exact: true }).fill('10');
  await page.getByLabel('店家款項狀態', { exact: true }).selectOption('paid');
  await page.getByLabel('實際付款時間（含時區）', { exact: true }).fill('2026-11-16T00:00:00Z');
  await page.getByRole('checkbox', { name: /已逐人核對名單/ }).check();
  await preview(page);
  await expect(page.getByRole('region', { name: '逐人結算預覽', exact: true })).toContainText(
    '一房 · ¥10.00 · 收款人 小青',
  );
  await save(page);
  await page.goto(base);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByRole('heading', { name: '第 1 版 · 逐人結算', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-settlement-mobile.png', fullPage: true });
});
test('keeps original UUID and body through uncertain save, reload and inbox recovery without automatic replay', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(base + '/edit');
  await prepare(page);
  await preview(page);
  const keys: string[] = [],
    bodies: string[] = [];
  let fail = true;
  await page.route('**/api/v2/activities/listen/settlement', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    bodies.push(route.request().postData()!);
    const response = await route.fetch();
    if (fail) {
      fail = false;
      await route.fulfill({ response, body: '{' });
    } else await route.fulfill({ response });
  });
  await page.getByRole('checkbox', { name: /已核對本版金額/ }).check();
  await page.getByRole('button', { name: '發布逐人結算', exact: true }).click();
  await expect(page.getByText('尚未確認操作結果。原操作已保留，請確認原操作結果。', { exact: true })).toBeVisible();
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByRole('button', { name: '確認原結算發布結果', exact: true })).toBeVisible();
  expect(keys).toHaveLength(1);
  await page
    .locator('header')
    .getByRole('link', { name: /^收件匣/ })
    .click();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
  await expect(page.getByRole('link', { name: '逐人結算', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '逐人結算', exact: true }).click();
  await page.getByRole('button', { name: '確認原結算發布結果', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(bodies[0]).toBe(bodies[1]);
});
test('restores incomplete payer drafts, requires preservation for damaged drafts and blocks writes when storage is full', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(base + '/edit');
  await prepare(page);
  await page.getByLabel('店家款項狀態', { exact: true }).selectOption('paid');
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByLabel('實際付款金額', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '保全原稿後繼續', exact: true })).toHaveCount(0);
  await page.getByLabel('店家款項狀態', { exact: true }).selectOption('unpaid');
  await preview(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes('activity-draft:settlement:')) throw Error('storage denied');
      return original.call(this, key, value);
    };
  });
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/settlement')) writes++;
  });
  await page.getByRole('checkbox', { name: /已核對本版金額/ }).check();
  await page.getByRole('button', { name: '發布逐人結算', exact: true }).click();
  await expect(page.getByText('無法保存原稿及操作編號，尚未送出。', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  await page.reload();
  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.includes('activity-draft:settlement:'))!;
    sessionStorage.setItem(key, 'DAMAGED_ORIGINAL');
  });
  await page.reload();
  await expect(page.getByText('無法讀取原稿，請先保全原稿再繼續。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '保全原稿後繼續', exact: true }).click();
  expect(
    await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([k]) => k.includes(':recovery:'))
        .map(([, v]) => v),
    ),
  ).toContain('DAMAGED_ORIGINAL');
});
test('bot settlement links open the published bill without writes and preserve invitation access', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(base + '/edit');
  await prepare(page);
  await preview(page);
  await save(page);
  await context.clearCookies();
  await page.reload();
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST') writes++;
  });
  await page.goto('/?event=listen&action=settlement');
  await expect(page).toHaveURL(base);
  await expect(page.getByRole('heading', { name: '第 1 版 · 逐人結算', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '核對並發布逐人結算', exact: true })).toHaveCount(0);
  await page.goto('/activities/listen?task=settlement');
  await expect(page).toHaveURL(base);
  await page.goto('/?event=invite&action=settlement');
  await expect(page.getByRole('alert')).toContainText('找不到活動或尚未公開');
  expect(writes).toBe(0);
});
test('edits all five allocation modes, selected scope and split payer ownership with explicit reasons', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(base + '/edit');
  await prepare(page, '10');
  await page.getByLabel('分攤依據', { exact: true }).fill('已核對分攤');
  for (const mode of ['shares', 'equal', 'weights', 'fixed', 'duration']) {
    await page.getByLabel('分攤方式', { exact: true }).selectOption(mode);
    if (mode === 'weights')
      for (const [name, n] of [
        ['小青', '1'],
        ['小白', '2'],
        ['同行', '0'],
      ] as const)
        await page.getByLabel(name + ' 比例', { exact: true }).fill(n);
    if (mode === 'fixed')
      for (const [name, n] of [
        ['小青', '2'],
        ['小白', '3'],
        ['同行', '5'],
      ] as const)
        await page.getByLabel(name + ' 固定金額', { exact: true }).fill(n);
    if (mode === 'duration')
      for (const [name, n] of [
        ['小青', '20'],
        ['小白', '40'],
        ['同行', '0'],
      ] as const)
        await page.getByLabel(name + ' 分鐘（0–1440）', { exact: true }).fill(n);
    await preview(page);
  }
  await page.getByLabel('分攤方式', { exact: true }).selectOption('shares');
  await page.getByLabel('分攤範圍', { exact: true }).selectOption('selected');
  await page.getByRole('checkbox', { name: '同行', exact: true }).uncheck();
  const person = page.locator('.settlement-person').first();
  await person.locator('summary').first().click();
  await person.getByLabel('核對原因', { exact: true }).fill('兩人合付');
  await person.getByRole('button', { name: '新增付款歸屬', exact: true }).click();
  await person.getByLabel('付款人', { exact: true }).nth(1).selectOption({ label: '小白' });
  await person.getByLabel('付款比例', { exact: true }).nth(1).fill('2');
  await preview(page);
  await expect(
    page.getByRole('region', { name: '逐人結算預覽', exact: true }).getByText('同行 · ¥0.00 · 1 份', { exact: true }),
  ).toBeVisible();
  await save(page);
});
test('previews and freezes a code from the private library and preserves the code image after an edit', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(base + '/edit');
  const png = await image(page),
    session = await (await context.request.get('/api/v2/session')).json();
  const created = await context.request.post('/api/v2/me/payment-codes', {
    headers: {
      Origin: origin,
      'X-Account-Scope': session.scope,
      'X-CSRF-Token': session.csrf,
      'Idempotency-Key': crypto.randomUUID(),
    },
    data: { kind: 'wechat', name: '本次微信', image: png.buffer.toString('base64'), confirm: true },
  });
  expect(created.status(), await created.text()).toBe(200);
  await page.reload();
  await prepare(page);
  await page.getByText('本版收款碼 · 0 張', { exact: true }).click();
  await page.getByLabel('微信收款碼來源', { exact: true }).selectOption({ label: '本次微信' });
  await preview(page);
  await expect(
    page
      .getByRole('region', { name: '逐人結算預覽', exact: true })
      .getByRole('img', { name: '本版收款碼預覽', exact: true }),
  ).toBeVisible();
  await save(page);
  await page.getByLabel('結算備註（最多 1000 字）', { exact: true }).fill('第二版');
  await page.getByLabel('發布／修改原因（最多 300 字）', { exact: true }).fill('補備註');
  await page.getByRole('checkbox', { name: /已逐人核對名單/ }).check();
  await preview(page);
  await save(page);
  await page.goto('/activities/listen/settlement/images?version=1');
  await expect(page.getByRole('img', { name: '微信收款碼', exact: true })).toBeVisible();
});
test('rebases concurrent changes without losing edits and rejects an account-switched submit', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(base + '/edit');
  await prepare(page, '7.25');
  await page.getByLabel('結算備註（最多 1000 字）', { exact: true }).fill('保留核對');
  await preview(page);
  const session = await (await context.request.get('/api/v2/session')).json(),
    ctx = await (
      await context.request.get('/api/v2/activities/listen/settlement/context', {
        headers: { 'X-Account-Scope': session.scope },
      })
    ).json(),
    headers = { Origin: origin, 'X-Account-Scope': session.scope, 'X-CSRF-Token': session.csrf },
    operation = {
      command: 'report',
      id: 'eeeeeeeeeeeeeeee',
      transaction: {
        kind: 'expense',
        amount: '1',
        payer_id: ctx.collector.id,
        funding: 'payer',
        merchant: '測試',
        occurred_at: '2026-11-16T00:00:00Z',
        method: 'other',
        note: '',
        reason: '',
        custom_parties: [],
      },
    },
    p = await context.request.post('/api/v2/activities/listen/finance/preview', {
      headers,
      data: { revision: ctx.revision, operation },
    });
  expect(p.status()).toBe(200);
  const sent = await context.request.post('/api/v2/activities/listen/finance', {
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    data: { revision: ctx.revision, operation, preview_token: (await p.json()).preview_token, confirm: true },
  });
  expect(sent.status()).toBe(200);
  await page.getByRole('checkbox', { name: /已核對本版金額/ }).check();
  await page.getByRole('button', { name: '發布逐人結算', exact: true }).click();
  await expect(page.getByText('活動或名單已有更新；輸入仍保留，請核對目前安排後再保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核對最新名冊與帳本，保留輸入', exact: true }).click();
  await expect(page.getByLabel('費用金額', { exact: true })).toHaveValue('7.25');
  await expect(page.getByLabel('結算備註（最多 1000 字）', { exact: true })).toHaveValue('保留核對');
  await expect(page.getByRole('checkbox', { name: /已逐人核對名單/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /已逐人核對名單/ }).check();
  await preview(page);
  await login(context, 'bob');
  await page.getByRole('checkbox', { name: /已核對本版金額/ }).check();
  await page.getByRole('button', { name: '發布逐人結算', exact: true }).click();
  await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號', { exact: true })).toBeVisible();
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByLabel('費用金額', { exact: true })).toHaveValue('');
  await login(context);
  await page.reload();
  await expect(page.getByLabel('費用金額', { exact: true })).toHaveValue('7.25');
  await page.locator('header').getByRole('link', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
  await page.getByRole('link', { name: '帳號', exact: true }).click();
  await page.getByRole('button', { name: '登出此裝置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未登入', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes('activity-draft:settlement:'))),
  ).toEqual([]);
});
