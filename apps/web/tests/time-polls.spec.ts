import { denyDraftWrites, damageDraft, durableRows } from './draft-helpers';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
test.use({ pollExamples: true });
const origin = 'http://127.0.0.1:5082';
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([
    { name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
}
async function write(context: BrowserContext, path: string, data: Record<string, unknown>) {
  const session = await (await context.request.get('/api/v2/session')).json();
  return context.request.post('/api/v2/time-polls' + path, {
    headers: {
      Origin: origin,
      'X-Account-Scope': session.scope,
      'X-CSRF-Token': session.csrf,
      'Idempotency-Key': crypto.randomUUID(),
    },
    data,
  });
}
async function definition(page: Page) {
  await page.getByLabel('投票名稱', { exact: true }).fill('不連續日期');
  await page.getByLabel('預計地點', { exact: true }).fill('台北');
  await page.getByLabel('候選日期 1', { exact: true }).fill('2099-12-20');
  await page.getByLabel('候選日期 2', { exact: true }).fill('2099-12-23');
  await page.getByLabel('投票截止（含時區）', { exact: true }).fill('2099-12-19T18:00:00+08:00');
}
async function management(page: Page, action: string) {
  await page.getByLabel('管理操作', { exact: true }).selectOption(action);
}
test('creates date/exact polls with durable incomplete drafts and dynamic candidates, then follows the old bot link without a write', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/activities');
  await page.getByRole('link', { name: '時間投票', exact: true }).click();
  await page.getByRole('link', { name: '發起時間投票', exact: true }).click();
  await definition(page);
  await page.getByRole('button', { name: '新增候選', exact: true }).click();
  await page.getByLabel('候選日期 3', { exact: true }).fill('2099-12-27');
  await page.getByRole('button', { name: '移除候選 2', exact: true }).click();
  await expect.poll(async () => { const row = (await durableRows(page)).find(row => row.key.includes('activity-draft:poll-create:')); return row ? JSON.parse(row.raw).value.options : []; }).toEqual(['2099-12-20', '2099-12-27']);
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await page.getByRole('button', { name: '恢復本機原稿', exact: true }).click();
  await expect(page.getByLabel('候選日期 2', { exact: true })).toHaveValue('2099-12-27');
  await page.getByRole('button', { name: '建立時間投票', exact: true }).click();
  await expect(page.getByRole('heading', { name: '不連續日期', exact: true })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  expect((await context.request.get('/api/v2/activities')).ok()).toBe(true);
  await context.clearCookies();
  await page.reload();
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST') writes++;
  });
  await page.goto('/?poll=' + id);
  await expect(page).toHaveURL('/time-polls/' + id);
  await expect(page.getByRole('region', { name: '投票統計' })).toContainText('2099-12-27');
  expect(writes).toBe(0);
});
test('fills only unanswered active choices, preserves expired history, allows keyboard changes and never signs up a voter', async ({
  page,
  context,
}) => {
  await login(context, 'bob');
  await page.goto('/time-polls/poll-exact');
  await expect(page.getByText('已填 1 / 2 個有效候選', { exact: true })).toBeVisible();
  const fields = page.locator('fieldset.poll-choice');
  await expect(fields.nth(0).getByRole('radio', { name: '可以', exact: true })).toBeChecked();
  await expect(fields.nth(0).getByRole('radio', { name: '不行', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '未填項全選不行', exact: true }).click();
  await expect(fields.nth(1).getByRole('radio', { name: '可以', exact: true })).toBeChecked();
  await expect(fields.nth(2).getByRole('radio', { name: '不行', exact: true })).toBeChecked();
  await fields.nth(2).getByRole('radio', { name: '勉強可以', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: '保存改票', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '管理時間投票', exact: true })).toHaveCount(0);
  await login(context);
  await page.goto('/time-polls/poll-exact/manage');
  await page.getByText('填答者 · 1 人', { exact: true }).click();
  await expect(page.getByText('2099年12月12日 上午8:00：勉強可以', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-time-poll-mobile.png', fullPage: true });
});
test('requires latest vote counts before date finalization, preserves reasoned choice, creates a unique event and notifies without voter signup', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/time-polls/poll-date/manage');
  await management(page, 'finalize');
  await page.getByLabel('定案候選', { exact: true }).selectOption('poll-date-2');
  await page.getByLabel('活動開始（含時區，須在候選日期內）', { exact: true }).fill('2099-12-12T18:00:00+08:00');
  await page.getByLabel('正式報名截止（含時區）', { exact: true }).fill('2099-12-11T18:00:00+08:00');
  await page.getByLabel('操作原因', { exact: true }).fill('場地只剩此時段');
  await login(context, 'bob');
  expect(
    (
      await write(context, '/poll-date/votes', {
        revision: 1,
        choices: [
          { option_id: 'poll-date-1', choice: 'yes' },
          { option_id: 'poll-date-2', choice: 'maybe' },
        ],
      })
    ).status(),
  ).toBe(200);
  await login(context);
  await page.getByRole('checkbox', { name: /已核對場地、票數/ }).check();
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page.getByText('票數已有更新，請重新核對後定案', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核對最新票數與安排，保留輸入', exact: true }).click();
  await expect(page.getByLabel('操作原因', { exact: true })).toHaveValue('場地只剩此時段');
  await expect(page.getByRole('checkbox', { name: /已核對場地、票數/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /已核對場地、票數/ }).check();
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '查看定案活動並報名', exact: true }).click();
  await expect(page.getByRole('heading', { name: '時間投票 date', exact: true })).toBeVisible();
  await expect(page.getByText('1 / 5 人 · 最低 1 人', { exact: true })).toBeVisible();
  await login(context, 'bob');
  await page.goto('/inbox');
  await expect(page.getByText('時間投票 date 的时间已确定，请查看安排后报名', { exact: true })).toBeVisible();
});
for (const kind of ['create', 'vote', 'manage'] as const)
  test(
    'retains exact ' + kind + ' operation through uncertain delivery, reload and explicit inbox recovery',
    async ({ page, context }) => {
      await login(context, kind === 'vote' ? 'bob' : 'alice');
      await page.goto(
        kind === 'create'
          ? '/time-polls/new'
          : kind === 'manage'
            ? '/time-polls/poll-exact/manage'
            : '/time-polls/poll-exact',
      );
      if (kind === 'create') await definition(page);
      else if (kind === 'vote') await page.getByRole('button', { name: '未填項全選不行', exact: true }).click();
      else await page.getByRole('checkbox', { name: '已核對操作，確認提交。', exact: true }).check();
      const path =
          kind === 'create'
            ? '/time-polls'
            : kind === 'vote'
              ? '/time-polls/poll-exact/votes'
              : '/time-polls/poll-exact/manage',
        keys: string[] = [],
        bodies: string[] = [];
      let fail = true;
      await page.route('**/api/v2' + path, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        keys.push(route.request().headers()['idempotency-key']!);
        bodies.push(route.request().postData()!);
        const response = await route.fetch();
        if (fail) {
          fail = false;
          await route.fulfill({ response, body: '{' });
        } else await route.fulfill({ response });
      });
      await page
        .getByRole('button', {
          name: kind === 'create' ? '建立時間投票' : kind === 'vote' ? '保存改票' : '提交管理操作',
          exact: true,
        })
        .click();
      await expect(page.getByText('尚未確認操作結果。原操作已保留，請確認原操作結果。', { exact: true })).toBeVisible();
      page.on('dialog', (d) => void d.accept());
      await page.reload();
      const retry =
        kind === 'create' ? '確認原投票建立結果' : kind === 'vote' ? '確認原填答結果' : '確認原管理操作結果';
      await expect(page.getByRole('button', { name: retry, exact: true })).toBeVisible();
      expect(keys).toHaveLength(1);
      await page
        .locator('header')
        .getByRole('link', { name: /^收件匣/ })
        .click();
      await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
      await page
        .getByRole('link', {
          name: kind === 'create' ? '建立時間投票' : kind === 'vote' ? '投票填答' : '投票管理',
          exact: true,
        })
        .click();
      await page.getByRole('button', { name: retry, exact: true }).click();
      if (kind === 'create') await expect(page.getByRole('heading', { name: '不連續日期', exact: true })).toBeVisible();
      else await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect(bodies[0]).toBe(bodies[1]);
    },
  );
test('blocks writes when storage is denied, preserves damaged drafts and isolates account scopes', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/time-polls/new');
  await definition(page);
  await denyDraftWrites(page, 'poll-create:');
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST') writes++;
  });
  await page.getByRole('button', { name: '建立時間投票', exact: true }).click();
  await expect(page.getByText('無法保存原稿及操作編號，尚未送出。', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await damageDraft(page, 'poll-create:', 'DAMAGED_POLL');
  await page.reload();
  await page.getByRole('button', { name: '保全原稿後繼續', exact: true }).click();
  expect((await durableRows(page, 'versions')).map(row => row.raw)).toContain('DAMAGED_POLL');
  await page.getByLabel('投票名稱', { exact: true }).fill('只屬於小青');
  await login(context, 'bob');
  await page.reload();
  await expect(page.getByLabel('投票名稱', { exact: true })).toHaveValue('');
  await login(context);
  await page.reload();
  await page.getByRole('button', { name: '恢復本機原稿', exact: true }).click();
  await expect(page.getByLabel('投票名稱', { exact: true })).toHaveValue('只屬於小青');
});
test('explicitly closes, extends, cancels with reason and removes while preserving the result history', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/time-polls/poll-exact/manage');
  await page.getByRole('checkbox', { name: '已核對操作，確認提交。', exact: true }).check();
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await management(page, 'extend');
  await page.getByLabel('新的投票截止（含時區）', { exact: true }).fill('2099-12-11T00:00:00Z');
  await page.getByRole('checkbox', { name: '已核對操作，確認提交。', exact: true }).check();
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await management(page, 'cancel');
  await page.getByRole('checkbox', { name: '已核對操作，確認提交。', exact: true }).check();
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page.getByText('請填寫取消投票原因', { exact: true })).toBeVisible();
  await page.getByLabel('操作原因', { exact: true }).fill('場地取消');
  await page.getByRole('checkbox', { name: '已核對操作，確認提交。', exact: true }).check();
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page.getByText('原因：場地取消', { exact: true })).toBeVisible();
  await management(page, 'remove');
  await page.getByRole('checkbox', { name: /確認移除投票；/ }).check();
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page).toHaveURL('/time-polls');
});
test('creates exact candidates with explicit offsets and duration and confirms switching modes before clearing filled dates', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/time-polls/new');
  await definition(page);
  page.once('dialog', (d) => void d.dismiss());
  await page.getByLabel('候選模式', { exact: true }).selectOption('exact');
  await expect(page.getByLabel('候選模式', { exact: true })).toHaveValue('date');
  await expect(page.getByLabel('候選日期 1', { exact: true })).toHaveValue('2099-12-20');
  page.once('dialog', (d) => void d.accept());
  await page.getByLabel('候選模式', { exact: true }).selectOption('exact');
  await page.getByLabel('候選時間 1', { exact: true }).fill('2099-12-20T18:00:00+08:00');
  await page.getByLabel('候選時間 2', { exact: true }).fill('2099-12-23T18:00:00+08:00');
  await page.getByLabel('預計持續小時', { exact: true }).fill('4');
  await page.getByRole('button', { name: '建立時間投票', exact: true }).click();
  await expect(page.getByRole('heading', { name: '不連續日期', exact: true })).toBeVisible();
  const session = await (await context.request.get('/api/v2/session')).json(),
    p = await (
      await context.request.get('/api/v2' + new URL(page.url()).pathname, {
        headers: { 'X-Account-Scope': session.scope },
      })
    ).json();
  expect(p.duration_hours).toBe(4);
  expect(p.options[0].starts_at).toBe('2099-12-20T10:00:00+00:00');
  expect(p.options[0].ends_at).toBe('2099-12-20T14:00:00+00:00');
});
test('selects non-contiguous calendar dates across months, keeps keyboard state and removes only the selected date at 360px', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/time-polls/new');
  await page.getByLabel('投票名稱', { exact: true }).fill('跨月候選');
  await page.getByLabel('預計地點', { exact: true }).fill('台北');
  await page.getByLabel('投票截止（含時區）', { exact: true }).fill('2099-12-01T00:00:00Z');
  await page.getByLabel('月曆月份', { exact: true }).fill('2099-12');
  await page.getByRole('button', { name: '選擇日期 2099-12-03', exact: true }).click();
  await page.getByRole('button', { name: '選擇日期 2099-12-09', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '選擇日期 2099-12-09', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '下個月', exact: true }).click();
  await page.getByRole('button', { name: '選擇日期 2100-01-02', exact: true }).click();
  await expect(page.getByText('已選 3 個日期', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上個月', exact: true }).click();
  await page.getByRole('button', { name: '選擇日期 2099-12-03', exact: true }).click();
  await expect(page.getByLabel('候選日期 1', { exact: true })).toHaveValue('2099-12-09');
  await expect(page.getByLabel('候選日期 2', { exact: true })).toHaveValue('2100-01-02');
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-poll-calendar-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '建立時間投票', exact: true }).click();
  await expect(page.getByRole('heading', { name: '跨月候選', exact: true })).toBeVisible();
});
test('recovers an uncertain removal from its owner-only management context after public deletion', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/time-polls/poll-exact/manage');
  await management(page, 'remove');
  await page.getByRole('checkbox', { name: /確認移除投票；/ }).check();
  const keys: string[] = [];
  let fail = true;
  await page.route('**/api/v2/time-polls/poll-exact/manage', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    const response = await route.fetch();
    if (fail) {
      fail = false;
      await route.fulfill({ response, body: '{' });
    } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '提交管理操作', exact: true }).click();
  await expect(page.getByText('尚未確認操作結果。原操作已保留，請確認原操作結果。', { exact: true })).toBeVisible();
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByRole('button', { name: '確認原管理操作結果', exact: true })).toBeVisible();
  expect(keys).toHaveLength(1);
  await page.getByRole('button', { name: '確認原管理操作結果', exact: true }).click();
  await expect(page).toHaveURL('/time-polls');
  expect(keys[0]).toBe(keys[1]);
  const session = await (await context.request.get('/api/v2/session')).json();
  expect(
    (
      await context.request.get('/api/v2/time-polls/poll-exact', { headers: { 'X-Account-Scope': session.scope } })
    ).status(),
  ).toBe(404);
});
