import { denyDraftWrites, damageDraft, durableRows } from './draft-helpers';
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
test.use({ paymentExamples: true });
const baseURL = 'http://127.0.0.1:5082';
async function login(context: BrowserContext, account = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + account, url: baseURL, httpOnly: true, sameSite: 'Lax' }]); }
async function image(page: Page, type = 'image/png') {
  const value = await page.evaluate(type => { const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 200; const context = canvas.getContext('2d')!; context.fillStyle = '#123456'; context.fillRect(0, 0, 240, 200); return canvas.toDataURL(type).split(',')[1]!; }, type);
  return { name: type === 'image/jpeg' ? 'payment.jpg' : 'payment.png', mimeType: type, buffer: Buffer.from(value, 'base64') };
}
async function upload(page: Page, name = '本次收款碼', kind = 'wechat', type = 'image/png') {
  await page.getByLabel('收款方式', { exact: true }).selectOption(kind); await page.getByLabel('名稱（選填）', { exact: true }).fill(name);
  await page.getByLabel('收款碼圖片', { exact: true }).setInputFiles(await image(page, type)); await expect(page.getByRole('img', { name: '待保存收款碼', exact: true })).toBeVisible();
}
async function save(page: Page) { await page.getByRole('button', { name: '保存收款碼', exact: true }).click(); await expect(page.getByText('收款碼已保存。', { exact: true })).toBeVisible(); }
test('uploads every method, converts photos locally, restores drafts, displays and downloads exact originals at 360px', async ({ page, context }) => {
  await login(context); await page.goto('/me/payment-codes'); await upload(page, '照片收款碼', 'wechat', 'image/jpeg');
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await expect(page.getByLabel('名稱（選填）', { exact: true })).toHaveValue('照片收款碼');await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click(); await expect(page.getByRole('img', { name: '待保存收款碼', exact: true })).toBeVisible(); await save(page);
  for (const [kind, name] of [['alipay', '支付寶原圖'], ['other', '其他原圖']]) { await upload(page, name, kind); await save(page); }
  await expect(page.getByRole('heading', { name: '已保存（3／30）', exact: true })).toBeVisible();
  const first = page.locator('.payment-library > li').filter({ has: page.getByRole('heading', { name: '微信 · 照片收款碼', exact: true }) });
  await expect(first.getByRole('img')).toHaveJSProperty('naturalWidth', 240); await first.getByRole('button', { name: '查看原圖', exact: true }).click(); await expect(first.getByRole('button', { name: '收起原圖', exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download'); await first.getByRole('link', { name: '下載原圖', exact: true }).click(); const download = await downloading; expect(download.suggestedFilename()).toBe('payment-code.png');
  const viewer = await (await context.request.get('/api/v2/session')).json(), codes = await (await context.request.get('/api/v2/me/payment-codes', { headers: { 'X-Account-Scope': viewer.scope } })).json(), code = codes.codes.find((code: { kind: string }) => code.kind === 'wechat');
  const raw = await (await context.request.get(code.url, { headers: { 'X-Account-Scope': viewer.scope } })).body(); expect(readFileSync((await download.path())!)).toEqual(raw); expect(raw.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await page.setViewportSize({ width: 360, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/unified-payment-library-mobile.png', fullPage: true });
});
test('unknown create results preserve exact input and UUID across reload, appear in inbox recovery and never auto replay', async ({ page, context }) => {
  await login(context); await page.goto('/me/payment-codes'); const keys: string[] = [], bodies: string[] = []; let fail = true;
  await page.route('**/api/v2/me/payment-codes', async route => {
    if (route.request().method() !== 'POST') return route.continue(); keys.push(route.request().headers()['idempotency-key']!); bodies.push(route.request().postData()!); const response = await route.fetch();
    if (fail) { fail = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response });
  });
  await upload(page, '\ufeff斷線原圖\ufeff'); await page.getByRole('button', { name: '保存收款碼', exact: true }).click(); await expect(page.getByText('尚未確認操作結果。原圖與操作編號已保留，請按「確認操作結果」安全重試。', { exact: true })).toBeVisible();
  expect(JSON.parse(bodies[0]!).name).toBe('\ufeff斷線原圖\ufeff');
  await expect(page.getByLabel('名稱（選填）', { exact: true })).toBeDisabled();
  const serialized = (await durableRows(page)).filter(row=>row.key.includes('payment-codes:')).map(row=>JSON.parse(row.raw));
  expect(serialized[0].form.image).toBe(''); expect(serialized[0].pending.input.data.image.length).toBeGreaterThan(0);
  page.on('dialog', dialog => void dialog.accept()); await page.reload(); await expect(page.getByRole('button', { name: '確認操作結果', exact: true })).toBeVisible(); await expect(page.getByLabel('名稱（選填）',{exact:true})).toHaveValue('\ufeff斷線原圖\ufeff'); expect(keys).toHaveLength(1);
  await page.getByRole('link', { name: '回到帳號', exact: true }).click(); await page.getByRole('button', { name: '保留草稿並離開', exact: true }).click(); await page.goto('/inbox');
  await expect(page.getByRole('link', { name: '我的收款碼', exact: true })).toBeVisible(); expect(keys).toHaveLength(1); await page.getByRole('link', { name: '我的收款碼', exact: true }).click();
  await page.getByRole('button', { name: '確認操作結果', exact: true }).click(); await expect(page.getByText('收款碼已保存。', { exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(bodies[0]).toBe(bodies[1]); await expect(page.getByRole('heading', { name: '已保存（1／30）', exact: true })).toBeVisible();
});
test('archives only after confirmation, recovers unknown deletion and keeps previously frozen invoice images', async ({ page, context }) => {
  await login(context); await page.goto('/activities/past/settlement/images?version=1'); await expect(page.getByRole('img', { name: '微信收款碼', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '保存到我的收款碼', exact: true }).click(); await page.getByRole('button', { name: '帶入原版收款碼', exact: true }).click(); await save(page);
  await page.getByRole('button', { name: '移除 本版原碼', exact: true }).click(); await page.getByRole('button', { name: '取消移除', exact: true }).click(); await expect(page.getByRole('heading', { name: '已保存（1／30）', exact: true })).toBeVisible();
  const keys: string[] = []; let fail = true;
  await page.route('**/api/v2/me/payment-codes/*', async route => {
    if (route.request().method() !== 'DELETE') return route.continue(); keys.push(route.request().headers()['idempotency-key']!); const response = await route.fetch(); if (fail) { fail = false; await route.fulfill({ response, body: '{' }); } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '移除 本版原碼', exact: true }).click(); await expect(page.getByText('已發布帳單及歷史圖片會保留。', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '確認移除', exact: true }).click();
  await expect(page.getByRole('button', { name: '確認操作結果', exact: true })).toBeVisible(); page.on('dialog', dialog => void dialog.accept()); await page.reload(); await page.getByRole('button', { name: '確認操作結果', exact: true }).click();
  await expect(page.getByText('已從我的收款碼移除。', { exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); await expect(page.getByRole('heading', { name: '已保存（0／30）', exact: true })).toBeVisible();
  await page.goto('/activities/past/settlement/images?version=1'); await expect(page.getByRole('img', { name: '微信收款碼', exact: true })).toBeVisible(); await expect(page.getByRole('img', { name: '消費憑證 · 店家單據', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第 2 版 · ¥2.00 · 小白', exact: true }).click(); await expect(page.getByText('本版未附收款碼或消費憑證。', { exact: true })).toBeVisible(); await expect(page.getByRole('img')).toHaveCount(0);
});
test('public version assets allow anonymous read, preserve private access and only allow the original publisher to save a code', async ({ page, context }) => {
  await page.goto('/activities/past/settlement/images?version=1'); await expect(page.getByRole('img', { name: '微信收款碼', exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: '保存到我的收款碼', exact: true })).toHaveCount(0);
  await page.goto('/activities/invite/settlement/images?version=1'); await expect(page.getByText('找不到活動或尚未公開', { exact: true })).toBeVisible(); await expect(page.getByRole('img')).toHaveCount(0);
  await login(context, 'bob'); await page.goto('/activities/past/settlement/images?version=1'); await expect(page.getByRole('img', { name: '微信收款碼', exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: '保存到我的收款碼', exact: true })).toHaveCount(0);
  await page.goto('/me/payment-codes?event=past&version=1&kind=wechat'); await expect(page.getByText('只能保存自己發布結算時使用的收款碼。', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '帶入原版收款碼', exact: true })).toHaveCount(0);
  await page.goto('/activities/past/settlement/images?version=invalid'); await expect(page.getByText('結算版本格式不正確，請重新選擇。', { exact: true })).toBeVisible();
});
test('image and metadata failures expose retry, retain history and never show a different version’s image', async ({ page, context }) => {
  await login(context); let failImage = true;
  await page.route('**/api/v2/activities/past/settlement/history/1/payment-codes/wechat', async route => failImage ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'PAYMENT_IMAGE', message: '圖片暫時無法讀取，請稍後重試' }) }) : route.continue());
  await page.goto('/activities/past/settlement/images?version=1'); await expect(page.getByText('圖片暫時無法讀取，請稍後重試', { exact: true })).toBeVisible(); await expect(page.getByRole('img', { name: '消費憑證 · 店家單據', exact: true })).toBeVisible();
  failImage = false; await page.getByRole('button', { name: '重試圖片', exact: true }).click(); await expect(page.getByRole('img', { name: '微信收款碼', exact: true })).toBeVisible();
  let failMetadata = true; await page.route('**/api/v2/activities/past/settlement/history/2/assets', async route => failMetadata ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'TEMPORARY', message: '合成版本讀取失敗' }) }) : route.continue());
  await page.getByRole('button', { name: '第 2 版 · ¥2.00 · 小白', exact: true }).click(); await expect(page.getByText('合成版本讀取失敗', { exact: true })).toBeVisible(); await expect(page.getByRole('img')).toHaveCount(0);
  failMetadata = false; await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await expect(page.getByText('本版未附收款碼或消費憑證。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第 1 版 · ¥1.00 · 小青', exact: true }).click(); await expect(page.getByRole('img', { name: '微信收款碼', exact: true })).toBeVisible();
});
test('blocked storage prevents upload writes and damaged originals require preservation before editing', async ({ page, context }) => {
  await login(context);let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/me/payment-codes'))writes++;});
  await page.goto('/me/payment-codes');await upload(page);await denyDraftWrites(page,'payment-codes:');await page.getByRole('button',{name:'保存收款碼',exact:true}).click();await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/me/payment-codes');await expect(clean.getByRole('img',{name:'待保存收款碼',exact:true})).toBeVisible();await damageDraft(clean,'payment-codes:','damaged payment image');await clean.reload();await expect(clean.getByText('無法讀取原稿，請先保全原稿再繼續。',{exact:false})).toBeVisible();
  await expect(clean.getByLabel('收款碼圖片',{exact:true})).toBeDisabled();await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();await expect(clean.getByLabel('收款碼圖片',{exact:true})).toBeEnabled();expect((await durableRows(clean,'versions')).map(row=>row.raw)).toContain('damaged payment image');await clean.close();
});
test('account refresh removes private images, keeps each account draft separate and clears all image drafts on device logout', async ({ page, context }) => {
  await login(context); await page.goto('/me/payment-codes'); await upload(page, '原帳號草稿');
  await login(context, 'bob'); const signal = await context.newPage(); await signal.goto('/activities'); await signal.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('refresh'); channel.close(); });
  await expect(page.getByLabel('名稱（選填）', { exact: true })).toHaveValue(''); await expect(page.getByRole('img')).toHaveCount(0); await upload(page, '另一帳號草稿');
  await login(context); await signal.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('refresh'); channel.close(); });
  await expect(page.getByLabel('名稱（選填）', { exact: true })).toHaveValue('原帳號草稿'); await expect(page.getByRole('img', { name: '待保存收款碼', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '回到帳號', exact: true }).click(); await page.getByRole('button', { name: '保留草稿並離開', exact: true }).click(); await page.getByRole('button', { name: '登出此裝置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未登入', exact: true })).toBeVisible(); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('qgroup:rebuild:payment-codes:')))).toEqual([]); await signal.close();
});
test('rejects unsupported files and oversize originals without losing an already selected valid image', async ({ page, context }) => {
  await login(context); await page.goto('/me/payment-codes'); await upload(page, '有效原圖');
  await page.getByLabel('收款碼圖片', { exact: true }).setInputFiles({ name: 'invalid.gif', mimeType: 'image/gif', buffer: Buffer.from('gif') }); await expect(page.getByText('請選擇 PNG、JPEG 或 WebP 圖片', { exact: true })).toBeVisible(); await expect(page.getByRole('img', { name: '待保存收款碼', exact: true })).toBeVisible();
  await page.getByLabel('收款碼圖片', { exact: true }).setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(15 * 1024 * 1024 + 1) }); await expect(page.getByText('原始圖片超過 15 MB，請先裁剪', { exact: true })).toBeVisible();
  await page.getByLabel('收款碼圖片', { exact: true }).setInputFiles({ name: 'damaged.png', mimeType: 'image/png', buffer: Buffer.from('damaged') }); await expect(page.getByText('圖片無法讀取，請重新選擇', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '待保存收款碼', exact: true })).toBeVisible(); await save(page); await expect(page.getByRole('heading', { name: '微信 · 有效原圖', exact: true })).toBeVisible();
});
