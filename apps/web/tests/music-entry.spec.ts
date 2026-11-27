import { chooseOption, expectOption, expectControlValue, closeMusicLevel } from './kimi-controls';
import type { BrowserContext } from '@playwright/test';
import { test, expect } from './fixtures';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}
async function seed(context: BrowserContext, user = 'alice', entryId = 'sub-0') {
  await login(context, user);
  const viewer = await (await context.request.get('/api/v2/session')).json();
  const headers = { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() };
  const result = await context.request.put('/api/v2/me/music', { headers, data: { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId, level: 4 }] } });
  expect(result.status()).toBe(200);
  return { viewer, profile: await result.json(), headers };
}
test('keeps selector identities behind login and saved-profile gates on inline and direct term pages', async ({ page, context }) => {
  let reads = 0; page.on('request', request => { if (request.url().endsWith('/sub-2/members')) reads++; });
  await page.goto('/music/entries/sub-2?q=ai');
  await expect(page.getByRole('heading', { name: 'Aimer', exact: true })).toBeVisible();
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  await expect(members.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await expect(members.getByText('舊成分 10001', { exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
  await login(context); await page.reload();
  await expect(members).toContainText('請先保存成分，再查看選取者。');
  expect(reads).toBe(0);
  await members.getByRole('link', { name: '保存成分', exact: true }).click();
  await page.getByLabel('尋找喜歡的音樂', { exact: true }).fill('YOASOBI');
  await page.locator('.quick-add-results').getByRole('button').filter({hasText:'YOASOBI'}).click();await closeMusicLevel(page);
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.getByRole('complementary',{name:'我的選擇',exact:true}).getByRole('link', { name: '音樂詞庫', exact: true }).click();
  await page.getByRole('link', { name: 'Aimer', exact: true }).click();
  await expect(members.getByRole('link', { name: '舊成分 10001', exact: true })).toBeVisible();
});
test('shares the draft and filters with the direct page but adds selectors only after save, then opens and returns from a member profile', async ({ page, context }) => {
  await seed(context); await page.goto('/music?q=ai&entry=sub-2');
  const detail = page.getByRole('region', { name: '詞條資料', exact: true });
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  await expect(members.getByRole('listitem')).toHaveCount(3);
  await detail.getByRole('button', { name: '選取此詞條', exact: true }).click();await closeMusicLevel(page);
  await chooseOption(page,'Aimer喜歡程度','4');
  await expect(members.getByRole('link', { name: '小青', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('link', { name: '開啟詞條頁面', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '關閉詞條資料', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '尚未提交的修改' })).toHaveCount(0);
  await expectOption(page,'Aimer喜歡程度','4');
  await expect(detail.locator('.inline-definitions')).toContainText('3 人');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(members.getByRole('listitem')).toHaveCount(4);
  await expect(detail.locator('.inline-definitions')).toContainText('4 人');
  await members.getByRole('link', { name: '舊成分 10001', exact: true }).click();
  await expect(page.getByRole('heading', { name: '舊成分 10001', exact: true })).toBeVisible();
  await page.locator(".profile-all-picks .disclosure-trigger").click();await expect(page.getByText('Aimer · 本命', { exact: true })).toBeVisible();
  await expect(page.getByText(/private note|private gender/)).toHaveCount(0);
  await page.getByRole('link', { name: '回到詞條資料', exact: true }).click();
  await expect(page).toHaveURL('/music/entries/sub-2?q=ai');
  await expect(detail.getByRole('button', { name: '調整喜歡程度', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: '回到音樂詞庫', exact: true }).click();
  await expectControlValue(page.getByLabel('搜尋音樂詞條', { exact: true }), 'ai');
  await page.goBack(); await expect(page).toHaveURL('/music/entries/sub-2?q=ai');
});
test('preserves unfinished selections when visiting a selector and restores the term and filters on return', async ({ page, context }) => {
  await seed(context); await page.goto('/music?entry=sub-2&q=ai&kind=sub');
  await page.getByRole('button', { name: '選取此詞條', exact: true }).click();await closeMusicLevel(page);
  await chooseOption(page,'Aimer喜歡程度','1');
  await page.getByRole('link', { name: '舊成分 10001', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未提交的修改', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '舊成分 10001', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回到詞條資料', exact: true }).click();
  await expect(page).toHaveURL('/music/entries/sub-2?q=ai&kind=sub');
  await expectOption(page,'Aimer喜歡程度','1');
  await expect(page.getByRole('button', { name: '保存我的成分', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '誰選了', exact: true }).getByRole('listitem')).toHaveCount(3);
});
test('copies names and QQ without exposing internal IDs, with explicit recovery when the clipboard is denied on mobile', async ({ page, context }) => {
  const { profile, headers } = await seed(context, 'alice', 'sub-2');
  const longName = '很長的成分稱呼🟢'.repeat(2);
  const fields = await context.request.put('/api/v2/me/music/fields', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: {
    profileId: profile.id, musicEpoch: 0, revision: 0, name: longName, note: '', gender: '', genderPublic: false,
  } });
  expect(fields.status()).toBe(200);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => Object.assign(window, { copiedMusic: value }) } }));
  await page.setViewportSize({ width: 360, height: 800 }); await page.goto('/music/entries/sub-2');
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  const legacy = members.getByRole('listitem').filter({ has: page.getByRole('link', { name: '舊成分 10001', exact: true }) });
  await legacy.getByRole('button', { name: '複製名稱', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedMusic: string }).copiedMusic)).toBe('舊成分 10001');
  await legacy.getByRole('button', { name: '複製 QQ', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedMusic: string }).copiedMusic)).toBe('10001');
  const native = members.getByRole('listitem').filter({ has: page.getByRole('link', { name: longName, exact: true }) });
  await expect(native.getByRole('button', { name: '複製成分 ID', exact: true })).toHaveCount(0);
  await expect(native).not.toContainText(profile.id);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw Error('synthetic denied'); } } }));
  await native.getByRole('button', { name: '複製名稱', exact: true }).click();
  await expect(native.getByText('無法自動複製，請選取名稱手動複製。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-music-entry-mobile.png', fullPage: true });
  await native.getByRole('link', { name: longName, exact: true }).click();
  await expect(page.getByRole('button', { name: '複製成分 ID', exact: true })).toHaveCount(0);
});
test('shows member-list failures with retry, empty results and missing terms without stale selectors or unsafe return links', async ({ page, context }) => {
  const { profile } = await seed(context);
  let fail = true;
  await page.route('**/api/v2/music/entries/sub-2/members', async route => {
    if (fail) return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: '合成名單暫時不可用' } });
    return route.continue();
  });
  await page.goto('/music/entries/sub-2');
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  await expect(members.getByRole('alert')).toHaveText('合成名單暫時不可用');
  await expect(members.getByRole('listitem')).toHaveCount(0);
  fail = false; await members.getByRole('button', { name: '重新讀取', exact: true }).click();
  await expect(members.getByRole('listitem')).toHaveCount(3);
  await page.goto('/music/entries/main-0');
  await expect(members.getByRole('status')).toHaveText('尚無人選用此詞條。');
  await page.goto('/music/entries/missing');
  await expect(page.getByText('這個詞條不存在或已刪除。', { exact: true })).toBeVisible();
  await expect(members).toHaveCount(0);
  for (const from of ['https://evil.example', '//evil.example', '/music/entries/..', '/music/entries/%2e%2e', '/music/entries/term#https://evil.example']) {
    await page.goto('/people/' + profile.id + '?' + new URLSearchParams({ from }));
    await expect(page.getByRole('heading', { name: '小青', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '回到詞條資料', exact: true })).toHaveCount(0);
  }
});
test('refreshes selector names and cleared self-reported contacts when returning from the shared profile editor', async ({ page, context }) => {
  const { profile, headers } = await seed(context, 'alice', 'sub-2');
  expect((await context.request.put('/api/v2/me/music/contact', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { profileId: profile.id, musicEpoch: 0, revision: 0, contactQQ: '234567' } })).status()).toBe(200);
  await page.goto('/music?entry=sub-2');
  await expect(page.getByText('QQ 234567', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '編輯我的成分', exact: true }).click();
  await page.getByRole('tab', { name: '成分資料', exact: true }).click();
  await page.getByLabel('成分稱呼', { exact: true }).fill('目前成分名稱');
  await page.getByRole('button', { name: '保存成分資料', exact: true }).click();
  await expect(page.getByText('成分資料已保存。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回到我的成分', exact: true }).click();
  await page.locator(".music-profile-tools .disclosure-trigger").click();await page.getByRole('link', { name: '聯絡 QQ', exact: true }).click();
  await page.getByLabel('聯絡 QQ', { exact: true }).fill('');
  await page.getByRole('button', { name: '保存聯絡 QQ', exact: true }).click();
  await expect(page.getByText('已保存聯絡 QQ。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回到我的成分', exact: true }).click();
  await page.getByRole('complementary',{name:'我的選擇',exact:true}).getByRole('link', { name: '音樂詞庫', exact: true }).click();
  await page.getByRole('link', { name: 'Aimer', exact: true }).click();
  const member = page.getByRole('region', { name: '誰選了', exact: true }).getByRole('listitem').filter({ has: page.getByRole('link', { name: '目前成分名稱', exact: true }) });
  await expect(member).not.toContainText(profile.id);
  await expect(member.getByRole('button', { name: '複製 QQ', exact: true })).toHaveCount(0);
  await expect(page.getByText('QQ 234567', { exact: true })).toHaveCount(0);
});
test('discards a delayed selector response after another tab logs out and does not restore private rows', async ({ page, context }) => {
  await seed(context);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), sent = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v2/music/entries/sub-2/members', async route => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await page.goto('/music/entries/sub-2'); await sent;
  const account = await context.newPage(); await account.goto('/me/accounts');
  await account.getByRole('button', { name: '登出此裝置', exact: true }).click();
  await expect(page.locator('.viewer')).toHaveText('訪客'); release();
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  await expect(members.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await expect(members.getByRole('listitem')).toHaveCount(0);
  await expect(members.getByText('舊成分 10001', { exact: true })).toHaveCount(0);
  await account.close();
});
test('removes selector access on music erasure in another tab, isolates an account switch and uses the rebuilt profile only', async ({ page, context }) => {
  await seed(context, 'bob'); await seed(context);
  await page.goto('/music/entries/sub-2');
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  await expect(members.getByRole('listitem')).toHaveCount(3);
  const privacy = await context.newPage(); await privacy.goto('/me/privacy');
  await privacy.getByRole('radio', { name: '只刪除成分', exact: true }).check();
  await privacy.getByRole('checkbox', { name: '我已確認範圍，瞭解此操作無法復原', exact: true }).check();
  await privacy.getByRole('button', { name: '確認刪除成分', exact: true }).click();
  await expect(members).toContainText('請先保存成分，再查看選取者。');
  await expect(members.getByRole('listitem')).toHaveCount(0);
  await login(context, 'bob'); await page.reload();
  await expect(page.locator('.viewer')).toHaveText('小白');
  await expect(members.getByRole('listitem')).toHaveCount(3);
  await login(context); await page.reload();
  await expect(members).toContainText('請先保存成分，再查看選取者。');
  await page.getByRole('button', { name: '選取此詞條', exact: true }).click();await closeMusicLevel(page);
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(members.getByRole('link', { name: '小青', exact: true })).toBeVisible();
  await privacy.close();
});
test('waits for a fresh profile check before displaying cached selectors when reentering the music workspace', async ({ page, context }) => {
  const { headers, profile } = await seed(context);
  await page.goto('/music/entries/sub-2');
  await expect(page.getByRole('region', { name: '誰選了', exact: true }).getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: '返回原頁', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '我的', exact: true }).click();
  const erased = await context.request.post('/api/v2/me/privacy/erase', { headers, data: {
    target: 'music', profileId: profile.id, profileRevision: profile.revision, requestId: crypto.randomUUID(), secret: 'a'.repeat(64), confirm: true,
  } });
  expect(erased.status()).toBe(200);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), sent = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v2/me/music', async route => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('navigation').getByRole('link', { name: '音樂', exact: true }).click();
  await sent;
  await expect(page.getByLabel('搜尋音樂詞條', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('正在確認成分…');
  await expect(page.getByRole('region', { name: '誰選了', exact: true })).toHaveCount(0);
  release();
  await page.getByRole('link', { name: 'Aimer', exact: true }).click();
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  await expect(members.getByRole('listitem')).toHaveCount(0);
  await expect(members).toContainText('請先保存成分，再查看選取者。');
  await expect(members.getByRole('listitem')).toHaveCount(0);
});
test('does not flash a deleted selector or member card from cache on browser back and forward', async ({ page, context }) => {
  const bob = await seed(context, 'bob', 'sub-2'); await seed(context);
  await page.goto('/music/entries/sub-2');
  await page.getByRole('region', { name: '誰選了', exact: true }).getByRole('link', { name: '小白', exact: true }).click();
  await expect(page.getByRole('heading', { name: '小白', exact: true })).toBeVisible();
  const erased = await context.request.post('/api/v2/me/privacy/erase', { headers: { ...bob.headers, Cookie: 'kanban_session=fixture-bob' }, data: {
    target: 'music', profileId: bob.profile.id, profileRevision: bob.profile.revision, requestId: crypto.randomUUID(), secret: 'd'.repeat(64), confirm: true,
  } });
  expect(erased.status()).toBe(200);
  let releaseList!: () => void, listStarted!: () => void;
  const listGate = new Promise<void>(resolve => { releaseList = resolve; }), listSent = new Promise<void>(resolve => { listStarted = resolve; });
  await page.route('**/api/v2/music/entries/sub-2/members', async route => {
    const response = await route.fetch(); listStarted(); await listGate; await route.fulfill({ response });
  });
  await page.goBack(); await listSent;
  const members = page.getByRole('region', { name: '誰選了', exact: true });
  await expect(members.getByRole('listitem')).toHaveCount(0);
  await expect(members.getByRole('status')).toHaveText('正在讀取選取者…');
  releaseList(); await expect(members.getByRole('listitem')).toHaveCount(3);
  await expect(members.getByRole('link', { name: '小白', exact: true })).toHaveCount(0);
  let releaseProfile!: () => void, profileStarted!: () => void;
  const profileGate = new Promise<void>(resolve => { releaseProfile = resolve; }), profileSent = new Promise<void>(resolve => { profileStarted = resolve; });
  await page.route('**/api/v2/music/profiles/' + bob.profile.id, async route => {
    const response = await route.fetch(); profileStarted(); await profileGate; await route.fulfill({ response });
  });
  await page.goForward(); await profileSent;
  await expect(page.getByRole('heading', { name: '小白', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('正在讀取成分…');
  releaseProfile();
  await expect(page.getByRole('alert')).toHaveText('找不到這份成分，請核對 QQ');
});
test('initializes the selection controller before mounting search so a delayed profile cannot erase the first input', async ({ page, context }) => {
  await login(context);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), sent = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v2/me/music', async route => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await page.goto('/music'); await sent;
  await expect(page.getByRole('status')).toHaveText('正在確認成分…');
  await expect(page.getByLabel('搜尋音樂詞條', { exact: true })).toHaveCount(0);
  release();
  const search = page.getByLabel('搜尋音樂詞條', { exact: true });
  await search.fill('mijin');
  await expect(page.locator('.term-row')).toHaveCount(1);
  await page.getByRole('link', { name: '米津玄師', exact: true }).click();
  await expectControlValue(page.locator('.music-search-area input[type=search]'), 'mijin');
  await expect(page.getByRole('dialog').getByRole('heading',{name:'米津玄師',exact:true})).toBeVisible();
  await page.getByRole('button', { name: '返回詞庫', exact: true }).click();
  await expectControlValue(search, 'mijin');
  await page.getByRole('link', { name: '查看 米津玄師', exact: true }).click();
  await expect(page).toHaveURL('/music/entries/sub-4?q=mijin');
});
