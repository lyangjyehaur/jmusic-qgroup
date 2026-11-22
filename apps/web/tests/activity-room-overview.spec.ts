import type { BrowserContext } from '@playwright/test';
import { test, expect } from './fixtures';
test.use({ settlementExamples: true });
const origin = 'http://127.0.0.1:5082',
  p1 = 'aaaaaaaaaaaaaaaa',
  p2 = 'bbbbbbbbbbbbbbbb',
  p3 = 'cccccccccccccccc',
  r1 = '1111111111111111';
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([
    { name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
}
async function access(context: BrowserContext) {
  const session = await (await context.request.get('/api/v2/session')).json();
  return { Origin: origin, 'X-Account-Scope': session.scope, 'X-CSRF-Token': session.csrf };
}
async function plan(context: BrowserContext, name = '一房', people = [p1, p3]) {
  const headers = await access(context),
    ctx = await (await context.request.get('/api/v2/activities/listen/rooms', { headers })).json();
  const response = await context.request.post('/api/v2/activities/listen/rooms', {
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    data: {
      revision: ctx.revision,
      rooms: [
        { id: r1, name, payer_id: ctx.payers.find((p: any) => p.name === '小青').id, person_ids: people },
      ],
      confirm: true,
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}
test('finds my room and managed guest on the activity, isolates account identity and fits 360px', async ({
  page,
  context,
}) => {
  await login(context);
  await plan(context);
  await page.goto('/activities/listen');
  const rooms = page.locator('#rooms');
  await expect(rooms.getByText('我的包間：一房', { exact: true })).toBeVisible();
  await expect(rooms.getByText('小青 · 我', { exact: true })).toBeVisible();
  await expect(rooms.getByText('同行 · 我代報', { exact: true })).toBeVisible();
  await expect(rooms.getByRole('region', { name: '未分配人員', exact: true })).toContainText('小白');
  await expect(rooms.getByRole('link', { name: '分配預分包間', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-room-overview-mobile.png', fullPage: true });
  await login(context, 'bob');
  await page.reload();
  await expect(rooms.getByText('我的包間：待分配', { exact: true })).toBeVisible();
  await expect(rooms.getByText('小白 · 我', { exact: true })).toBeVisible();
  await expect(rooms.getByText('同行 · 我代報', { exact: true })).toHaveCount(0);
  await expect(rooms.getByRole('link', { name: '分配預分包間', exact: true })).toHaveCount(0);
  await context.clearCookies();
  await page.reload();
  await expect(rooms.getByRole('heading', { name: '一房 · 2 人', exact: true })).toBeVisible();
  await expect(rooms.getByText(/我的包間/)).toHaveCount(0);
  await expect(rooms.getByText(/· 我/)).toHaveCount(0);
});
test('keeps the unassigned roster visible through moving people, removing a room and saving a partial plan', async ({page,context}) => {
  await login(context);
  await page.goto('/activities/listen/rooms');
  const unassigned = page.getByRole('region', {name:'未分配人員',exact:true});
  await expect(unassigned.getByText('未分配 · 3 人', {exact:true})).toBeVisible();
  for (const name of ['小青','小白','同行']) await expect(unassigned.getByText(name, {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'新增包間',exact:true}).click();
  const first = page.locator('.settlement-room').first();
  await first.getByLabel('包間名稱', {exact:true}).fill('第一房');
  await first.getByLabel('包間付款人', {exact:true}).selectOption({label:'小青'});
  await first.getByText('包間人員 · 0 人', {exact:true}).click();
  for (const name of ['小青','同行']) await first.getByRole('checkbox', {name,exact:true}).check();
  await expect(unassigned.getByText('未分配 · 1 人', {exact:true})).toBeVisible();
  await unassigned.getByText('未分配 · 1 人', {exact:true}).click();
  await expect(unassigned.getByText('小白', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'新增包間',exact:true}).click();
  const second = page.locator('.settlement-room').nth(1);
  await second.getByLabel('包間名稱', {exact:true}).fill('第二房');
  await second.getByLabel('包間付款人', {exact:true}).selectOption({label:'小青'});
  await second.getByText('包間人員 · 0 人', {exact:true}).click();
  await second.getByRole('checkbox', {name:'同行',exact:true}).check();
  await expect(first.getByRole('checkbox', {name:'同行',exact:true})).not.toBeChecked();
  await second.getByRole('checkbox', {name:'小白',exact:true}).check();
  await expect(unassigned.getByText('全部人員已分配。', {exact:true})).toBeVisible();
  await first.getByRole('button', {name:'移除包間 1',exact:true}).click();
  await expect(unassigned.getByText('未分配 · 1 人', {exact:true})).toBeVisible();
  await unassigned.getByText('未分配 · 1 人', {exact:true}).click();
  await expect(unassigned.getByText('小青', {exact:true})).toBeVisible();
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('checkbox', {name:'已核對包間人員與付款人，確認保存。',exact:true}).check();
  await page.getByRole('button', {name:'保存預分包間',exact:true}).click();
  await expect(page.getByText('已保存。', {exact:true})).toBeVisible();
  const headers = await access(context), saved = await (await context.request.get('/api/v2/activities/listen/rooms',{headers})).json();
  expect(saved.rooms).toMatchObject([{name:'第二房',person_ids:[p2,p3]}]);
  await page.goto('/activities/listen#rooms');
  await expect(page.locator('#rooms').getByText('我的包間：待分配', {exact:true})).toBeVisible();
  await expect(page.locator('#rooms').getByRole('region', {name:'未分配人員',exact:true})).toContainText('小青');
});
test('reads immutable plans after rename, preserves original payer and recovers a failed snapshot without writes', async ({
  page,
  context,
}) => {
  await login(context);
  await plan(context);
  await plan(context, '二房', [p2]);
  await page.goto('/me/profile');
  await page.getByLabel('站內稱呼', { exact: true }).fill('新稱呼');
  await page.getByRole('button', { name: '保存稱呼', exact: true }).click();
  await expect(page.getByText('已保存稱呼。', { exact: true })).toBeVisible();
  let fail = true,
    writes = 0;
  page.on('request', (request) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method())) writes++;
  });
  await page.route('**/api/v2/activities/listen/rooms/history/1', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'TEMPORARY', message: '歷史暫時無法讀取' }),
        })
      : route.continue(),
  );
  await page.goto('/activities/listen');
  await page.locator('#rooms').getByRole('link', { name: '預分安排歷史', exact: true }).click();
  await page.getByRole('button', { name: '預分第 1 版 · 1 間', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('歷史暫時無法讀取');
  fail = false;
  await page.getByRole('button', { name: '重新讀取', exact: true }).click();
  const historical = page.getByRole('region', { name: '歷史包間安排', exact: true });
  await expect(historical.getByText('我的包間：一房', { exact: true })).toBeVisible();
  await expect(historical.getByText('新稱呼 · 我', { exact: true })).toBeVisible();
  await expect(historical.getByText('店家付款／收款人：小青', { exact: true })).toBeVisible();
  await expect(historical.getByText(/預分歷史的姓名與本人標示依目前名單顯示/)).toBeVisible();
  await page.getByRole('link', { name: '回到活動包間', exact: true }).click();
  await expect(
    page.locator('#rooms').getByRole('heading', { name: '二房 · 1 人', exact: true }),
  ).toBeVisible();
  expect(writes).toBe(0);
});
test('links actual frozen room membership to the exact published settlement version', async ({
  page,
  context,
}) => {
  await login(context);
  await plan(context, '預分房', [p1, p2, p3]);
  const headers = await access(context),
    ctx = await (
      await context.request.get('/api/v2/activities/listen/settlement/context', { headers })
    ).json();
  const input = {
    revision: ctx.revision,
    base_version: 0,
    reviewed_roster: true,
    people: [{ id: p1 }, { id: p2 }, { id: p3 }],
    items: [],
    rooms: [{ id: r1, name: '實際房', payer_id: ctx.collector.id, person_ids: [p1, p2, p3], amount: '10' }],
  };
  const preview = await context.request.post('/api/v2/activities/listen/settlement/preview', {
    headers,
    data: input,
  });
  expect(preview.status(), await preview.text()).toBe(200);
  const saved = await context.request.post('/api/v2/activities/listen/settlement', {
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    data: { ...input, preview_token: (await preview.json()).preview_token, confirm: true },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.goto('/me/profile');
  await page.getByLabel('站內稱呼', { exact: true }).fill('新的稱呼');
  await page.getByRole('button', { name: '保存稱呼', exact: true }).click();
  await expect(page.getByText('已保存稱呼。', { exact: true })).toBeVisible();
  await page.goto('/activities/listen');
  const rooms = page.locator('#rooms');
  await expect(rooms.getByRole('heading', { name: '實際包間', exact: true })).toBeVisible();
  await expect(rooms.getByText('我的包間：實際房', { exact: true })).toBeVisible();
  await expect(rooms.getByText('小青 · 我', { exact: true })).toBeVisible();
  await expect(rooms.getByText('新的稱呼 · 我', { exact: true })).toHaveCount(0);
  await expect(rooms.getByRole('link', { name: '分配預分包間', exact: true })).toHaveCount(0);
  await rooms.getByRole('link', { name: '查看本版結算', exact: true }).click();
  await expect(page).toHaveURL('/activities/listen/settlement?version=1');
  await expect(page.getByRole('heading', { name: '第 1 版 · 逐人結算', exact: true })).toBeVisible();
});
test('paginates actual stored plan history, retries list reads and returns to the latest versions', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/v2/activities/past/rooms/history?before=3', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'TEMPORARY', message: '較早版本暫時無法讀取' }),
        })
      : route.continue(),
  );
  await page.goto('/activities/past/rooms/history');
  await expect(page.getByRole('button', { name: '預分第 52 版 · 1 間', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更早的版本', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('較早版本暫時無法讀取');
  fail = false;
  await page.getByRole('button', { name: '重新讀取', exact: true }).click();
  await page.getByRole('button', { name: '預分第 1 版 · 1 間', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '歷史包間安排', exact: true })
      .getByRole('heading', { name: '歷史房 1 · 1 人', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '更早的版本', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '最新版本', exact: true }).click();
  await expect(page.getByRole('button', { name: '預分第 52 版 · 1 間', exact: true })).toBeVisible();
});
test('shows useful empty and error states and protects invited history and post-logout identity', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/activities/listen');
  await expect(page.locator('#rooms').getByText('尚未安排包間。', { exact: true })).toBeVisible();
  await page.locator('#rooms').getByRole('link', { name: '預分安排歷史', exact: true }).click();
  await expect(page.getByText('尚無預分安排版本。', { exact: true })).toBeVisible();
  await plan(context);
  await page.goto('/activities/listen');
  await expect(page.locator('#rooms').getByText('小青 · 我', { exact: true })).toBeVisible();
  await page.goto('/me/accounts');
  await page.getByRole('button', { name: '登出此裝置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未登入', exact: true })).toBeVisible();
  await page.goto('/activities/listen');
  await expect(
    page.locator('#rooms').getByRole('heading', { name: '一房 · 2 人', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#rooms').getByText('小青 · 我', { exact: true })).toHaveCount(0);
  await page.goto('/activities/invite/rooms/history');
  await expect(page.getByRole('alert')).toContainText('找不到活動或尚未公開');
});
