import { chooseOption, expectOption, toggleMusicTerm, expectMusicTerm } from './kimi-controls';
import { test, expect } from './fixtures';
import { durableRows, denyDraftWrites, damageDraft } from './draft-helpers';
import type { BrowserContext } from '@playwright/test';
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, httpOnly: true, sameSite: 'Lax' }]);
}
test('guest browses activity and music in one responsive shell', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/activities');
  await expect(page.getByRole('heading', { name: '活動', exact: true })).toBeVisible();
  await expect(page.getByText('開發預覽',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '私人活動' })).toHaveCount(0);
  await page.getByRole('heading', { name: '週末一起聽日系音樂' }).getByRole('link').click();
  await expect(page.getByRole('region', { name: '活動安排' })).toBeVisible();
  await page.getByRole('link', { name: '編輯我的成分' }).click();
  await expect(page.getByRole('heading', { name: '登入後才能保存成分' })).toBeVisible();
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '音樂', exact: true }).click();
  await page.getByRole('searchbox').fill('YOASOBI');
  await expect(page.locator('.term-row')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'YOASOBI', exact: true })).toBeVisible();
  await page.goto('/activities');
  for (const width of [360, 390, 614, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('navigation', { name: width <= 768 ? '手機主要導覽' : '主要導覽', exact: true })).toBeVisible();
  }
  await page.screenshot({ path: 'test-results/unified-activity-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/unified-activity-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('scoped draft survives refresh, preserves activity return, and safely retries a lost response', async ({ context, page }) => {
  await login(context);
  await page.goto('/me/music?from=%2Factivities%2Flisten');
  await expect(page.getByRole('heading', { name: '我的成分', exact: true })).toBeVisible();
  await toggleMusicTerm(page, 'J-POP');
  await toggleMusicTerm(page, 'YOASOBI');
  await chooseOption(page,'YOASOBI喜歡程度','4');
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await page.reload();
  await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();
  await expectMusicTerm(page, 'YOASOBI', true);
  await expectOption(page,'YOASOBI喜歡程度','4');
  let first = true;
  await page.route('**/api/v2/me/music', async route => {
    if (route.request().method() === 'PUT' && first) { first = false; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('尚未確認保存結果。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', {name:'移除YOASOBI',exact:true})).toBeDisabled();
  await page.getByRole('button', { name: '確認保存結果', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存我的成分', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/unified-music-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '回到剛才的活動' }).click();
  await expect(page.getByRole('heading', { name: '週末一起聽日系音樂' })).toBeVisible();
});
test('account change never loads another account into an old profile scope', async ({ context, page }) => {
  await login(context); await page.goto('/me/music');
  await toggleMusicTerm(page, 'Aimer');
  await login(context, 'bob');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('目前帳號已變更；請重新整理並確認帳號')).toBeVisible();
  await page.reload();
  await expect(page.locator('.viewer')).toHaveText('小白');
  await expectMusicTerm(page, 'Aimer', false);
});
test('unsaved navigation is explicit and mobile selection stays usable', async ({ context, page }) => {
  await login(context, 'bob'); await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/me/music');
  await toggleMusicTerm(page,'動畫歌曲');
  await page.getByRole('navigation').getByRole('link', { name: '活動', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未提交的修改' })).toBeVisible();
  await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/unified-music-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '保存詞條變動', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
});
test('storage failure blocks sending and damaged drafts are preserved for recovery', async ({ context, page }) => {
  await login(context,'bob');await page.goto('/me/music');await denyDraftWrites(page,'music:v1:');
  let writes=0;page.on('request',request=>{if(request.method()==='PUT')writes++;});await toggleMusicTerm(page, 'J-POP');await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/me/music');await toggleMusicTerm(clean, 'J-POP');await expect(clean.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);await damageDraft(clean,'music:v1:','damaged synthetic draft');clean.on('dialog',dialog=>void dialog.accept());await clean.reload();await clean.locator('.quick-add input').fill('J-POP');await expect(clean.locator('.quick-add-results').getByRole('button').filter({hasText:'J-POP'})).toBeDisabled();await expect(clean.getByRole('button',{name:'保存我的成分',exact:true})).toBeDisabled();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged synthetic draft');await clean.close();
});
test('a concurrent profile update returns conflict without replacing the local selection', async ({ context, page }) => {
  await login(context, 'bob'); await page.goto('/me/music');
  await toggleMusicTerm(page, 'Eve');
  const viewer = await (await context.request.get('/api/v2/session')).json();
  const previous = await (await context.request.get('/api/v2/me/music', { headers: { 'X-Account-Scope': viewer.scope } })).json();
  const update = await context.request.put('/api/v2/me/music', { headers: { Origin: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() }, data: { profileId: previous?.id ?? null, musicEpoch: viewer.musicEpoch, revision: previous?.revision ?? 0, selections: [{ entryId: 'main-4', level: 3 }] } });
  expect(update.status()).toBe(200);
  const conflict = page.waitForResponse(response => response.url().endsWith('/api/v2/me/music') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByRole('status').filter({ hasText: '成分版本不同，尚未保存' })).toBeVisible();
  await expect(page.getByText('目前草稿和已保存的成分版本不同。你的勾選仍保留，請先讀取最新版本再保存。', { exact: true })).toBeVisible();
  await expectMusicTerm(page,'Eve',true);
  await page.getByRole('button', { name: '讀取最新版本', exact: true }).click();
  await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
});
