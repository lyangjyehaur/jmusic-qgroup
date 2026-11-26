import { chooseOption, expectControlValue } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]);
}

test('quick appearance keeps color, brightness and density independent without losing or submitting an activity draft', async ({ page, context }) => {
  await login(context); await page.goto('/activities/new');
  await page.getByLabel('活動名稱', { exact: true }).fill('保留中的活動');
  const writes: string[] = []; page.on('request', request => { if (['POST','PUT','PATCH','DELETE'].includes(request.method()) && request.url().includes('/api/v2/')) writes.push(request.url()); });
  await expect(page.locator('html')).toHaveAttribute('data-preset', 'pink');
  await page.getByLabel('外觀設定', { exact: true }).click();
  await chooseOption(page,'快速明暗模式','dark');
  for (const preset of ['gunju','pink','blue','yellow']) {
    await chooseOption(page,'快速主題色',preset);
    await expect(page.locator('html')).toHaveAttribute('data-preset', preset);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  }
  await chooseOption(page,'快速資訊密度','compact');
  await chooseOption(page,'快速明暗模式','light');
  await expect(page.locator('html')).toHaveAttribute('data-preset', 'yellow');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.keyboard.press('Escape');
  await expectControlValue(page.getByLabel('活動名稱', { exact: true }), '保留中的活動');
  expect(writes).toEqual([]);
  page.on('dialog', dialog => void dialog.accept()); await page.reload();
  await expectControlValue(page.getByLabel('活動名稱', { exact: true }), '保留中的活動');
  await expect(page.locator('html')).toHaveAttribute('data-preset', 'yellow');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
});

test('search and term dialogs restore the mounted activity, including the member tab, with safe focus', async ({ page, context }) => {
  await login(context); await page.goto('/activities/listen?view=members#participants');
  await page.locator('.activity-overview-mount').evaluate(node => node.setAttribute('data-retained', 'yes'));
  await page.getByRole('link', { name: '全站搜尋', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await page.getByLabel('搜尋活動、詞條或成分稱呼').fill('mjxs');
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await page.getByRole('link', { name: '米津玄師', exact: true }).click();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('heading', { name: '米津玄師', exact: true })).toBeVisible();
  expect(await dialog.evaluate(el=>el.getBoundingClientRect().height<=innerHeight-64)).toBe(true);
  expect(await dialog.locator('.inline-definitions dd').first().evaluate(el=>el.getBoundingClientRect().width>40)).toBe(true);
  await page.getByRole('link', { name: '← 回到搜尋', exact: true }).click();
  await expectControlValue(page.getByLabel('搜尋活動、詞條或成分稱呼'), 'mjxs');
  await page.getByRole('button', { name: '返回原頁', exact: true }).click();
  await expect(page).toHaveURL('/activities/listen?view=members#participants');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.activity-overview-mount')).toHaveAttribute('data-retained', 'yes');
  await expect(page.getByRole('tab', { name: '成員', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('activity tabs keep existing management and settlement destinations accessible', async ({ page, context }) => {
  await login(context); await page.goto('/activities/listen');
  await page.getByRole('tab', { name: '分房', exact: true }).click();
  await expect(page.locator('#rooms')).toBeVisible();
  await expect(page.getByRole('link', { name: '自由分房試算', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '管理', exact: true }).click();
  for (const name of ['管理報名','補報名邀請','代報認領','現場出席','管理分工','群通知紀錄']) await expect(page.locator('.activity-tools').getByRole('link', { name, exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '結算', exact: true }).click();
  await expect(page).toHaveURL('/activities/listen/settlement');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '結算', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
});

test('search from a saved local authoring draft avoids duplicate controllers and restores its original input', async ({ page, context }) => {
  await login(context); await page.goto('/activities/new');
  const errors: string[] = []; page.on('console', message => { if (/only supports one blocker|useBlocker/i.test(message.text())) errors.push(message.text()); });
  await page.getByLabel('活動名稱', { exact: true }).fill('搜尋前的草稿');
  await page.getByRole('link', { name: '全站搜尋', exact: true }).click();
  await page.getByRole('button', { name: '保留原稿並離開', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '全站搜尋', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回原頁', exact: true }).click();
  await expect(page).toHaveURL('/activities/new');
  const restore = page.getByRole('button', { name: '恢復本機原稿', exact: true });
  if (await restore.isVisible()) await restore.click();
  await expectControlValue(page.getByLabel('活動名稱', { exact: true }), '搜尋前的草稿');
  expect(errors).toEqual([]);
});

test('personal and music subpages preserve their frame, native URLs and return tabs',async({page,context})=>{
 await login(context);await page.goto('/me');await page.getByRole('tab',{name:'帳號與裝置',exact:true}).click();await expect(page).toHaveURL('/me/accounts');await expect(page.locator('.profile-banner')).toBeVisible();await expect(page.getByRole('tab',{name:'帳號與裝置',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByRole('tab',{name:'隱私與外觀',exact:true}).click();await expect(page).toHaveURL('/me/appearance');await expect(page.getByLabel('主題',{exact:true})).toBeVisible();await page.getByRole('tab',{name:'總覽',exact:true}).click();await expect(page).toHaveURL('/me');
 await page.goto('/me/music');await page.getByRole('tab',{name:'成分資料',exact:true}).click();await expect(page).toHaveURL('/me/music/details');await expect(page.getByRole('tab',{name:'成分資料',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('link',{name:'回到我的成分',exact:true})).toBeVisible();
});

for (const width of [789, 390]) test(`activity browsing owns polls and hides administration at ${width}px`, async ({ page, context }) => {
  await login(context, 'registration-admin'); await page.setViewportSize({ width, height: 925 });
  await page.goto('/activities');
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
  await expect(page.locator('.sidebar a[href="/time-polls"]')).toHaveCount(0);
  const date = page.locator('.activity-row .activity-meta').first();
  await expect(date).toContainText('2099'); await expect(date).not.toContainText('GMT'); await expect(date).not.toContainText('Asia/');
  await page.getByRole('tab', { name: '時間投票', exact: true }).click();
  await expect(page).toHaveURL('/time-polls');
  await expect(page.getByRole('tab', { name: '時間投票', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(width > 768 ? '.side-nav a[href="/activities"]' : '.mobile-dock a[href="/activities"]')).toHaveClass(/active/);
  await expect(page.getByRole('link', { name: '發起時間投票', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '往期與歸檔', exact: true }).click();
  await expect(page).toHaveURL('/activities?period=history');
  await page.getByRole('tab', { name: '近期活動', exact: true }).click();
  await expect(page).toHaveURL('/activities');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const path of ['/me', '/me/accounts', '/guide']) {
    await page.goto(path); await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
  }
  await page.goto('/admin'); await expect(page.getByRole('heading', { name: '管理後臺', exact: true })).toBeVisible();
});

test('elapsed activities use historical labels and leave the personal current list while settlement remains accessible',async({page,context})=>{
 await login(context);
 const event=await (await context.request.get('/api/v2/activities/listen')).json();
 const elapsed={...event,startsAt:'2020-11-17T23:00:00+08:00',durationHours:3,estimatedOver:true,phase:'ongoing',lifecycle:'scheduled'};
 await page.route(/\/api\/v2\/(?:me\/)?activities(?:\?.*)?$/,async route=>{
  const url=new URL(route.request().url()),mine=url.pathname.includes('/me/'),history=url.searchParams.get('period')==='history';
  const events=mine||history?[elapsed]:[];
  await route.fulfill({json:{events,page:1,hasMore:false,total:events.length,summary:{upcoming:0,mine:1}}});
 });
 await page.route('**/api/v2/activities/listen',route=>route.fulfill({json:elapsed}));
 await page.goto('/activities');await expect(page.getByRole('region',{name:'活動列表',exact:true})).not.toContainText(event.title);
 await expect(page.locator('.activity-overview')).toContainText('0');
 await page.getByRole('tab',{name:'往期與歸檔',exact:true}).click();
 const list=page.getByRole('region',{name:'活動列表',exact:true});await expect(list).toContainText(event.title);await expect(list).toContainText('已過預定時間');await expect(list).not.toContainText('進行中');
 await list.getByRole('link',{name:event.title,exact:true}).click();await expect(page.locator('.status-strip')).toContainText('已過預定時間');
 await page.getByRole('tab',{name:'結算',exact:true}).click();await expect(page).toHaveURL('/activities/listen/settlement');await expect(page.getByRole('tab',{name:'結算',exact:true})).toHaveAttribute('aria-selected','true');
 await page.goto('/me');await expect(page.getByText('目前沒有與你相關的活動。',{exact:true})).toBeVisible();await expect(page.locator('.me-activity-list')).toHaveCount(0);await expect(page.getByRole('link',{name:'全部活動',exact:true})).toBeVisible();
});
