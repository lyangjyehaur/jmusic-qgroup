import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin = 'http://127.0.0.1:5082';
async function login(context: BrowserContext, user = 'registration-admin') {
  await context.addCookies([
    {
      name: 'kanban_session',
      value: 'fixture-' + user,
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
async function confirm(page: Page, label = '確認 bot 設定') {
  await page
    .getByRole('checkbox', {
      name: '我已核對發送模式、群政策與設定變更',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: label, exact: true }).click();
}
async function value(context: BrowserContext) {
  const viewer = await (await context.request.get('/api/v2/session')).json();
  return (
    await context.request.get('/api/v2/admin/bot', {
      headers: { 'X-Account-Scope': viewer.scope },
    })
  ).json();
}

test('administrator edits shared policy, previews templates, retains disabled group routing and reverts as a new version', async ({
  page,
  context,
}) => {
  await login(context);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/admin');
  await page.getByRole('link', { name: 'bot 設定', exact: true }).click();
  await page.getByLabel('啟用主動通知', { exact: true }).check();
  await page.getByLabel('發送模式', { exact: true }).selectOption('simulate');
  await page.getByLabel('沿用部署目標群', { exact: true }).uncheck();
  await page.getByRole('button', { name: '新增群政策', exact: true }).click();
  await page.getByLabel('群標識 1', { exact: true }).fill('synthetic-group');
  await page.getByLabel('群名稱 1', { exact: true }).fill('合成群');
  await page.getByLabel('主動通知此群', { exact: true }).check();
  await page.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('60');
  await page.getByLabel('啟用勿擾時段', { exact: true }).check();
  await page.getByLabel('Markdown 模板', { exact: true }).check();
  await page.getByLabel('自訂模板', { exact: true }).fill('## {title}\n[查看活動]({url})');
  await page.getByRole('button', { name: '預覽模板', exact: true }).click();
  await expect(page.getByRole('region', { name: '模板預覽', exact: true })).toContainText('查看活動');
  await expect(page.getByRole('button', { name: '確認 bot 設定', exact: true })).toBeDisabled();
  await confirm(page);
  await expect(page.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  const after = await value(context);
  expect(after.config).toMatchObject({
    enabled: true,
    dry_run: true,
    min_interval_seconds: 60,
    quiet_enabled: true,
    groups: [{ id: 'synthetic-group', name: '合成群', broadcast: true }],
  });
  expect(after.revision).toBe(1);
  await page.getByLabel('沿用部署目標群', { exact: true }).check();
  await page.getByLabel('沿用部署目標群', { exact: true }).uncheck();
  await page.getByRole('button', { name: '移除群政策 1', exact: true }).click();
  await confirm(page);
  await expect(page.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  expect((await value(context)).config.groups).toEqual([]);
  await page.getByRole('button', { name: '恢復上一版', exact: true }).click();
  await expect(
    page.getByText('將恢復上一版設定並追加新版本；不回放已投遞或模擬紀錄。', {
      exact: true,
    }),
  ).toBeVisible();
  await confirm(page, '確認恢復上一版');
  await expect(page.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  expect((await value(context)).revision).toBe(3);
  expect((await value(context)).config).toEqual(after.config);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/unified-admin-bot-mobile.png',
    fullPage: true,
  });
});
test('lost save response survives reload and replays the same UUID exactly once', async ({
  page,
  context,
}) => {
  await login(context);
  let lose = true;
  const writes: { key: string | undefined; body: string | null }[] = [];
  await page.route('**/api/v2/admin/bot', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    writes.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    if (!lose) return route.continue();
    lose = false;
    const response = await route.fetch();
    await route.fulfill({ response, body: '{' });
  });
  await page.goto('/admin/bot');
  await page.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('45');
  await confirm(page);
  await expect(page.getByRole('button', { name: '確認原操作結果', exact: true })).toBeVisible();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(page.getByLabel('主動發送最小間隔（秒）', { exact: true })).toHaveValue('45');
  await expect(page.getByLabel('主動發送最小間隔（秒）', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '確認原操作結果', exact: true }).click();
  await expect(page.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect((await value(context)).revision).toBe(1);
});
test('concurrent edits preserve input and require explicit review of the latest revision', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/admin/bot');
  await page.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('31');
  const other = await context.newPage();
  await other.goto('/admin/bot');
  await other.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('32');
  await confirm(other);
  await expect(other.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核對最新版，保留輸入', exact: true }).click();
  await expect(page.getByLabel('主動發送最小間隔（秒）', { exact: true })).toHaveValue('31');
  await expect(page.getByRole('button', { name: '確認 bot 設定', exact: true })).toBeDisabled();
  await page.getByText('核對目前保存的設定', { exact: true }).click();
  await expect(page.locator('dl').filter({ hasText: '發送間隔' })).toContainText('32');
  await confirm(page);
  await expect(page.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  expect((await value(context)).config.min_interval_seconds).toBe(31);
  await other.close();
});
test('storage failure blocks submission and broken drafts are preserved before recovery; navigation protects unfinished work', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/admin/bot');
  await expect(page.getByLabel('發送模式', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.includes('admin-bot')) throw Error('synthetic storage full');
      return original.call(this, key, value);
    };
  });
  await page.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('61');
  await expect(page.getByRole('alert')).toContainText('無法保存 bot 原稿');
  await expect(page.getByRole('button', { name: '確認 bot 設定', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: '管理後台', exact: true }).click();
  await expect(page.getByText('仍有 bot 設定原稿或待確認操作。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '繼續核對', exact: true }).click();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  const key = await page.evaluate(async () => {
    const viewer = await (await fetch('/api/v2/session')).json(),
      access = await (
        await fetch('/api/v2/admin/session', {
          headers: { 'X-Account-Scope': viewer.scope },
        })
      ).json(),
      key = 'qgroup:rebuild:admin-bot:v1:' + viewer.scope + ':' + access.scope;
    sessionStorage.setItem(key, '{damaged');
    return key;
  });
  await page.reload();
  await expect(
    page.getByText('無法讀取 bot 設定原稿，請先保全原稿再繼續。', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: '保全原稿後繼續', exact: true }).click();
  await expect(page.getByLabel('發送模式', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      (key) =>
        Object.keys(sessionStorage)
          .filter((k) => k.startsWith(key + ':recovery:'))
          .map((k) => sessionStorage.getItem(k)),
      key,
    ),
  ).toEqual(['{damaged']);
});
test('rescue access works without music membership and a late response cannot revive revoked settings', async ({
  page,
  context,
}) => {
  await page.goto('/admin/bot');
  await page.getByLabel('管理救援憑證', { exact: true }).fill('synthetic-admin-rescue-' + 'x'.repeat(32));
  await page.getByRole('button', { name: '使用救援憑證登入', exact: true }).click();
  await page.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('20');
  await confirm(page);
  await expect(page.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(false);
  await context.clearCookies();
  await login(context);
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  await page.route('**/api/v2/admin/bot', async (route) => {
    const response = await route.fetch();
    arrive();
    await blocked;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.reload();
  await arrived;
  await login(context, 'alice');
  await page.evaluate(() => {
    const channel = new BroadcastChannel('qgroup:rebuild:session');
    channel.postMessage('refresh');
    channel.close();
  });
  await expect(page.getByLabel('管理救援憑證', { exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('region', { name: 'bot 設定核對', exact: true })).toHaveCount(0);
});

test('a completed save retains its exact operation when local receipt cleanup fails', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/admin/bot');
  await page.getByLabel('主動發送最小間隔（秒）', { exact: true }).fill('90');
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.includes('admin-bot')) throw Error('synthetic cleanup failure');
      return remove.call(this, key);
    };
    window.addEventListener(
      'test:restore-storage',
      () => {
        Storage.prototype.removeItem = remove;
      },
      { once: true },
    );
  });
  const writes: { key: string | undefined; body: string | null }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/admin/bot') && request.method() === 'POST')
      writes.push({
        key: request.headers()['idempotency-key'],
        body: request.postData(),
      });
  });
  await confirm(page);
  await expect(
    page.getByText('設定已保存，但本機操作紀錄尚未清除；請確認原操作結果。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '確認原操作結果', exact: true })).toBeVisible();
  expect((await value(context)).revision).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('test:restore-storage')));
  await page.getByRole('button', { name: '重試保存原稿', exact: true }).click();
  await page.getByRole('button', { name: '確認原操作結果', exact: true }).click();
  await expect(page.getByText('bot 設定已保存。', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect((await value(context)).revision).toBe(1);
});
