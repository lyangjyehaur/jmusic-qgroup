import { toggleMusicTerm, chooseOption, expectMusicTerm, selectControl, expectControlValue } from './kimi-controls';
import { denyDraftWrites, damageDraft, durableRows } from './draft-helpers';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,
  endpoint = '/me/music/entries';
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([
    { name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
}
async function access(context: BrowserContext) {
  const s = await (await context.request.get('/api/v2/session')).json();
  return { Origin: origin, 'X-Account-Scope': s.scope, 'X-CSRF-Token': s.csrf };
}
async function mine(context: BrowserContext) {
  return (await context.request.get('/api/v2' + endpoint, { headers: await access(context) })).json();
}
async function seed(context: BrowserContext, name = '測試樂團') {
  const m = await mine(context),
    headers = await access(context),
    response = await context.request.post('/api/v2' + endpoint, {
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      data: {
        command: 'create',
        profileId: m.profileId,
        musicEpoch: m.musicEpoch,
        name,
        kind: 'sub',
        category: '乐队',
        confirm: true,
      },
    });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).id as string;
}
const field = (page: Page) => page.getByLabel('詞條名稱（最多 24 字）', { exact: true });
async function save(page: Page, label = '建立詞條') {
  await page.getByRole('checkbox', { name: '已核對名稱、類型與分類，確認保存。', exact: true }).check();
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
}
test('creates a first term and blank profile, edits its classification and protects it once selected', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/music');
  await page.getByRole('link', { name: '建立詞條', exact: true }).click();
  await expect(
    page.getByText('建立詞條會同時建立空白成分；不會自動選取詞條。', { exact: true }),
  ).toBeVisible();
  await field(page).fill('全新樂團');
  await selectControl(page.getByLabel('詞條分類', { exact: true }), '乐队');
  await save(page);
  await page.getByRole('link', { name: '我的詞條', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全新樂團', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '編輯 全新樂團', exact: true }).click();
  await field(page).fill('樂團新名稱');
  await selectControl(page.getByLabel('詞條分類', { exact: true }), '组合');
  await save(page, '保存詞條');
  await page.getByRole('link', { name: '我的成分', exact: true }).click();
  await toggleMusicTerm(page,'樂團新名稱');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '我的詞條', exact: true }).click();
  await expect(page.getByText('細分 · 組合 · 1 人選用', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '刪除 樂團新名稱', exact: true }).click();
  await expect(page.getByText('已有 1 人選用，不能刪除。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刪除詞條', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-music-entry-mobile.png', fullPage: true });
});
test('other selection locks an already-open form and stays visible after withdrawal without losing its draft', async ({page,context,browser})=>{
  await login(context);const id=await seed(context,'共享詞條');
  await page.goto(endpoint+'/'+id+'/edit');await field(page).fill('未送出的名稱');
  const other=await browser.newContext({baseURL:origin});
  try {
    await login(other,'bob');const profile=await(await other.request.get('/api/v2/me/music',{headers:await access(other)})).json();
    const put=async(selections:object[],revision:number,profileId:string|null)=>other.request.put('/api/v2/me/music',{headers:{...await access(other),'Idempotency-Key':crypto.randomUUID()},data:{profileId,revision,musicEpoch:0,selections}});
    const selected=await put([{entryId:id,level:3}],profile?.revision??0,profile?.id??null);expect(selected.status()).toBe(200);
    await page.getByRole('checkbox',{name:'已核對名稱、類型與分類，確認保存。',exact:true}).check();await page.getByRole('button',{name:'保存詞條',exact:true}).click();
    await expect(page.getByText('已被其他人選用，建立者不能修改或刪除；請聯絡管理員維護',{exact:true})).toBeVisible();
    const saved=await selected.json();expect((await put([{entryId:'main-0',level:4}],saved.revision,saved.id)).status()).toBe(200);
    await page.getByRole('button',{name:'核對最新詞條，保留輸入',exact:true}).click();
    await expect(page.getByText('已被其他人選用，建立者不能修改或刪除；請聯絡管理員維護。',{exact:true})).toBeVisible();
    await expect(field(page)).toHaveValue('未送出的名稱');await expect(field(page)).toBeDisabled();await expect(page.getByRole('button',{name:'保存詞條',exact:true})).toBeDisabled();
    await page.getByRole('link',{name:'我的詞條',exact:true}).click();
    await page.getByRole('button',{name:'捨棄並離開',exact:true}).click();
    await expect(page.getByText('細分 · 樂隊 · 0 人選用',{exact:true})).toBeVisible();
    await expect(page.getByText('已被其他人選用，請聯絡管理員維護。',{exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'編輯 共享詞條',exact:true})).toHaveCount(0);
    await page.goto(endpoint+'/'+id+'/delete');await expect(page.getByRole('button',{name:'刪除詞條',exact:true})).toBeDisabled();
    await expect(page.getByText('取消選取後仍保留鎖定。',{exact:true})).toBeVisible();
  } finally {await other.close();}
});
test('uses public classifications, alias/name normalization, independent type filters and the search keyboard shortcut', async ({
  page,
  context,
}) => {
  await login(context);
  const id = await seed(context, 'Ｓtraße');
  await page.goto('/music');
  await page.getByLabel('搜尋音樂詞條', { exact: true }).fill('STRASSE');
  await expect(page.locator('.term-row')).toHaveCount(1);
  await chooseOption(page,'詞庫分類','乐队');
  await chooseOption(page,'詞庫類型','main');
  await expect(page.getByText('沒有符合目前搜尋與篩選的詞條。', { exact: true })).toBeVisible();
  await chooseOption(page,'詞庫類型','sub');
  await page.getByRole('link', { name: 'Ｓtraße', exact: true }).click();
  await expect(page.getByRole('region', { name: '詞條資料', exact: true })).toContainText('建立者');
  await expect(page.getByRole('region',{name:'詞條資料',exact:true})).toContainText('小青');
  await page.getByRole('button',{name:'返回詞庫',exact:true}).click();
  await page.getByRole('button', { name: '清除搜尋', exact: true }).click();
  await page.getByRole('heading', { name: '音樂', exact: true }).click();
  await page.keyboard.press('/');
  await expect(page.getByLabel('搜尋音樂詞條', { exact: true })).toBeFocused();
  await page.goto(endpoint + '/new');
  await field(page).fill('stras\u200bse');
  await expect(page.getByRole('link', { name: '查看既有詞條', exact: true })).toHaveAttribute(
    'href',
    '/music?entry=' + id,
  );
  await page.getByRole('checkbox', { name: '已核對名稱、類型與分類，確認保存。', exact: true }).check();
  await page.getByRole('button', { name: '建立詞條', exact: true }).click();
  await expect(page.getByText('已有「Ｓtraße」詞條，請選用既有詞條', { exact: true })).toBeVisible();
});
for (const command of ['create', 'update', 'delete'] as const)
  test(
    'recovers exact ' + command + ' UUID/body through reload and inbox without automatic replay',
    async ({ page, context }) => {
      await login(context);
      const id = command === 'create' ? '' : await seed(context),
        url =
          command === 'create'
            ? endpoint + '/new'
            : endpoint + '/' + id + (command === 'update' ? '/edit' : '/delete');
      await page.goto(url);
      if (command !== 'delete') await field(page).fill(command === 'create' ? '未知建立' : '未知改名');
      const keys: string[] = [],
        bodies: string[] = [];
      let fail = true;
      await page.route('**/api/v2/me/music/entries', async (route) => {
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
        .getByRole('checkbox', {
          name: command === 'delete' ? '確認刪除此詞條。' : '已核對名稱、類型與分類，確認保存。',
          exact: true,
        })
        .check();
      await page
        .getByRole('button', {
          name: command === 'create' ? '建立詞條' : command === 'delete' ? '刪除詞條' : '保存詞條',
          exact: true,
        })
        .click();
      await expect(
        page.getByText('尚未確認操作結果。原操作已保留，請確認原操作結果。', { exact: true }),
      ).toBeVisible();
      page.on('dialog', (dialog) => void dialog.accept());
      await page.reload();
      await expect(page.getByRole('button', { name: '確認原詞條操作結果', exact: true })).toBeVisible();
      expect(keys).toHaveLength(1);
      await page
        .locator('header')
        .getByRole('link', { name: /^收件匣/ })
        .click();
      await page.getByRole('button', { name: '保留操作並離開', exact: true }).click();
      await page
        .getByRole('link', {
          name: command === 'create' ? '建立詞條' : command === 'delete' ? '刪除詞條' : '編輯詞條',
          exact: true,
        })
        .click();
      await page.getByRole('button', { name: '確認原詞條操作結果', exact: true }).click();
      await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect(bodies[0]).toBe(bodies[1]);
    },
  );
test('rebases a concurrent edit without losing the original input', async ({ page, context }) => {
  await login(context);
  const id = await seed(context);
  await page.goto(endpoint + '/' + id + '/edit');
  await field(page).fill('保留的本機名稱');
  const m = await mine(context),
    e = m.entries[0],
    response = await context.request.post('/api/v2' + endpoint, {
      headers: { ...(await access(context)), 'Idempotency-Key': crypto.randomUUID() },
      data: {
        command: 'update',
        id,
        profileId: m.profileId,
        musicEpoch: m.musicEpoch,
        revision: e.revision,
        name: '另一個新名稱',
        kind: e.kind,
        category: e.category,
        confirm: true,
      },
    });
  expect(response.status()).toBe(200);
  await page.getByRole('checkbox', { name: '已核對名稱、類型與分類，確認保存。', exact: true }).check();
  await page.getByRole('button', { name: '保存詞條', exact: true }).click();
  await expect(
    page.getByText('詞條已有更新；輸入保留，請核對目前版本後再保存', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '核對最新詞條，保留輸入', exact: true }).click();
  await expectControlValue(field(page), '保留的本機名稱');
  await expect(
    page.getByRole('checkbox', { name: '已核對名稱、類型與分類，確認保存。', exact: true }),
  ).not.toBeChecked();
  await save(page, '保存詞條');
});
test('storage denial prevents writes and damaged drafts require preservation before editing', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto(endpoint + '/new');
  await field(page).fill('保留原稿');
  await denyDraftWrites(page, 'qgroup:rebuild:music:entries:');
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/me/music/entries')) writes++;
  });
  await page.getByRole('checkbox', { name: '已核對名稱、類型與分類，確認保存。', exact: true }).check();
  await page.getByRole('button', { name: '建立詞條', exact: true }).click();
  await expect(page.getByText('無法保存原稿及操作編號，尚未送出。', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expectControlValue(field(page), '保留原稿');
  await damageDraft(page, 'qgroup:rebuild:music:entries:', 'DAMAGED_ENTRY_DRAFT');
  await page.reload();
  await expect(field(page)).toBeDisabled();
  await page.getByRole('button', { name: '保全原稿後繼續', exact: true }).click();
  await expect(field(page)).toBeEnabled();
  expect((await durableRows(page, 'versions')).map(row => row.raw)).toContain('DAMAGED_ENTRY_DRAFT');
});
test('preserves selection drafts while creating terms, isolates switched accounts and clears term drafts on logout', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/me/music');
  await toggleMusicTerm(page, 'YOASOBI');
  await page.getByRole('tab', { name: '我的詞條', exact: true }).click();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
  await page.getByRole('link', { name: '建立詞條', exact: true }).click();
  await field(page).fill('自己的詞條');
  await save(page);
  await page.getByRole('link', { name: '我的成分', exact: true }).click();
  await expectMusicTerm(page,'YOASOBI',true);
  await expectMusicTerm(page,'自己的詞條',false);
  await page.getByRole('tab', { name: '我的詞條', exact: true }).click();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
  await page.getByRole('link', { name: '建立詞條', exact: true }).click();
  await field(page).fill('小青尚未送出');
  await login(context, 'bob');
  await page.getByRole('checkbox', { name: '已核對名稱、類型與分類，確認保存。', exact: true }).check();
  await page.getByRole('button', { name: '建立詞條', exact: true }).click();
  await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號', { exact: true })).toBeVisible();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expectControlValue(field(page), '');
  await login(context);
  await page.reload();
  await expectControlValue(field(page), '小青尚未送出');
  await page.goto('/me/accounts');
  await page.getByRole('button', { name: '登出此裝置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未登入', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('qgroup:rebuild:music:entries:')),
    ),
  ).toEqual([]);
});
