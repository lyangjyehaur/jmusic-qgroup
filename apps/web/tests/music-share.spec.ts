import { chooseOption, expectOption, toggleMusicTerm, openMusicContact } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { durableRows, damageDraft } from './draft-helpers';
const origin = `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
test.use({ musicMatches: true });
async function login(context: BrowserContext, user = 'alice') { await context.addCookies([{ name: 'kanban_session', value: 'fixture-' + user, url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function auth(context: BrowserContext) { const viewer = await (await context.request.get('/api/v2/session')).json(); return { Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': crypto.randomUUID() }; }
async function inspectCanvas(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { shareLines: string[]; shareDraws: { text: string; x: number; y: number; width: number }[]; shareCreated: string[]; shareRevoked: string[]; shareCopied: string };
    state.shareLines = []; state.shareDraws = []; state.shareCreated = []; state.shareRevoked = [];
    const text = CanvasRenderingContext2D.prototype.fillText, rect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(...args) { state.shareLines = []; state.shareDraws = []; return rect.apply(this, args); };
    CanvasRenderingContext2D.prototype.fillText = function(value, ...args) { state.shareLines.push(String(value)); state.shareDraws.push({ text: String(value), x: args[0], y: args[1], width: this.measureText(value).width }); return text.call(this, value, ...args); };
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = blob => { const url = create(blob); state.shareCreated.push(url); return url; }; URL.revokeObjectURL = url => { state.shareRevoked.push(url); revoke(url); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { state.shareCopied = value; } } });
  });
}
const image = (page: Page) => page.getByRole('img', { name: '音樂成分分享圖片；完整詞條可見下方清單', exact: true });
const lines = (page: Page) => page.evaluate(() => (window as unknown as { shareLines: string[] }).shareLines);
async function ready(page: Page) { await expect(image(page)).toBeVisible(); await expect(image(page)).toHaveJSProperty('naturalWidth', 1440); await expect(page.getByRole('link', { name: '下載圖片', exact: true })).toBeVisible(); }
async function redraw(page: Page, act: () => Promise<unknown>) { await page.bringToFront(); const src = await image(page).getAttribute('src'); await act(); await ready(page); await expect(image(page)).not.toHaveAttribute('src', src!); }
test('shares current unsaved choices, exact ordered text and optional identities without saving or exposing private fields', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); const headers = await auth(context), own = await (await context.request.get('/api/v2/me/music', { headers })).json();
  expect((await context.request.put('/api/v2/me/music/contact', { headers, data: { profileId: own.id, musicEpoch: 0, revision: 0, contactQQ: '123456' } })).status()).toBe(200);
  let writes = 0; page.on('request', request => { if (!['GET','HEAD'].includes(request.method())) writes++; });
  await page.goto('/me/music'); await toggleMusicTerm(page,'米津玄師'); await chooseOption(page,'米津玄師喜歡程度','1');
  await page.getByRole('tab', { name: '分享圖片', exact: true }).click(); await ready(page);
  await expect(page.getByText('使用目前草稿產生分享，不會自動保存。推薦同好仍依已保存成分計算。', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '尚未提交的修改', exact: true })).toHaveCount(0);
  const expected = 'J-POP、動畫歌曲、YOASOBI、ヨルシカ、Aimer、ずっと真夜中でいいのに。、米津玄師';
  await expect(page.getByRole('textbox', { name: '詞條清單', exact: true })).toHaveValue(expected);
  await page.getByRole('button', { name: '複製詞條清單', exact: true }).click(); await expect(page.getByText('已複製詞條清單。', { exact: true })).toBeVisible(); expect(await page.evaluate(() => (window as unknown as { shareCopied: string }).shareCopied)).toBe(expected);
  const drawn = await lines(page); expect(drawn).toContain('7 項 · 目前草稿'); expect(drawn).toContain('米津玄師'); expect(drawn.some(line => line.startsWith('只聽過幾首'))).toBe(true);
  expect(drawn.join('')).not.toMatch(/123456|234567|留言|性別|private-pin|token|csrf/);
  await redraw(page, () => page.getByRole('checkbox', { name: '包含我的聯絡 QQ', exact: true }).check()); expect((await lines(page)).join('')).toContain('123456');
  await redraw(page, () => page.getByRole('checkbox', { name: '包含同好的聯絡 QQ', exact: true }).check()); expect((await lines(page)).join('')).toContain('234567');
  await redraw(page, () => chooseOption(page,'分享推薦排序','familiar')); expect((await lines(page)).join('')).toContain('共同本命'); expect((await lines(page)).join('')).toContain('345678');
  await redraw(page, () => page.getByRole('checkbox', { name: '包含推薦同好', exact: true }).uncheck()); expect((await lines(page)).join('')).not.toMatch(/共同本命|345678|匹配度/);
  await page.getByRole('link', { name: '回到我的成分', exact: true }).click(); await expectOption(page,'米津玄師喜歡程度','1'); expect(writes).toBe(0);
});
test('downloads a real complete PNG, supports dark rendering and revokes replaced image URLs', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); await page.goto('/me/music/share'); await ready(page);await redraw(page,()=>chooseOption(page,'圖片配色','light'));
  let download = page.waitForEvent('download'); await page.getByRole('link', { name: '下載圖片', exact: true }).click(); const light = await download; expect(light.suggestedFilename()).toBe('我的音樂成分.png'); await light.saveAs('test-results/unified-music-share-light.png');
  const size = await image(page).evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight })); expect(size.width).toBe(1440); expect(size.height).toBeGreaterThan(1000);
  expect((await lines(page)).filter(value => ['J-POP','動畫歌曲','YOASOBI','ヨルシカ','Aimer','ずっと真夜中でいいのに。'].includes(value))).toHaveLength(6);
  await redraw(page, () => chooseOption(page,'圖片配色','dark'));
  const pixel = await image(page).evaluate((element: HTMLImageElement) => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const context = canvas.getContext('2d')!; context.drawImage(element,0,0); return [...context.getImageData(0,0,1,1).data]; }); expect(pixel).toEqual([45,68,52,255]);
  download = page.waitForEvent('download'); await page.getByRole('link', { name: '下載圖片', exact: true }).click(); await (await download).saveAs('test-results/unified-music-share-dark.png');
  await page.getByRole('link', { name: '回到我的成分', exact: true }).click();
  await expect(page).toHaveURL('/me/music');
  await expect.poll(() => page.evaluate(() => { const state = window as unknown as { shareCreated: string[]; shareRevoked: string[] }; return state.shareCreated.length >= 2 && state.shareCreated.every(url => state.shareRevoked.includes(url)); })).toBe(true);
});
test('uses a prepared PNG File for native sharing and treats cancellation as cancellation', async ({ page, context }) => {
  await login(context); await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: ({ files }: ShareData) => files?.[0]?.type === 'image/png' });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files, title }: ShareData) => { Object.assign(window, { shareFile: { type: files![0]!.type, name: files![0]!.name, size: files![0]!.size, title } }); if ((window as unknown as { shareCancel: boolean }).shareCancel) throw new DOMException('Cancelled', 'AbortError'); } });
  });
  let downloads = 0; page.on('download', () => downloads++); await page.goto('/me/music/share'); await ready(page); await page.getByRole('button', { name: '分享圖片', exact: true }).click(); await expect(page.getByText('已完成圖片分享。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { shareFile: unknown }).shareFile)).toMatchObject({ type: 'image/png', name: '我的音樂成分.png', title: '我的音樂成分' });
  await page.evaluate(() => Object.assign(window, { shareCancel: true })); await page.getByRole('button', { name: '分享圖片', exact: true }).click(); await expect(page.getByText('已取消分享。', { exact: true })).toBeVisible(); expect(downloads).toBe(0);
});
test('unsupported or failed native sharing downloads the prepared image and missing clipboard has manual recovery', async ({ page, context }) => {
  await login(context); await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => !(window as unknown as { unsupported: boolean }).unsupported });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new Error('Synthetic denial'); } });
  });
  await page.goto('/me/music/share'); await ready(page); let download = page.waitForEvent('download'); await page.getByRole('button', { name: '分享圖片', exact: true }).click(); expect((await download).suggestedFilename()).toBe('我的音樂成分.png'); await expect(page.getByText('圖片分享失敗，已改為下載。', { exact: true })).toBeVisible();
  await page.evaluate(() => Object.assign(window, { unsupported: true })); download = page.waitForEvent('download'); await page.getByRole('button', { name: '分享圖片', exact: true }).click(); await download; await expect(page.getByText('此瀏覽器不支援圖片分享，已改為下載。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '複製詞條清單', exact: true }).click(); await expect(page.getByText('無法自動複製，請選取下方詞條清單手動複製。', { exact: true })).toBeVisible(); await expect(page.getByRole('textbox', { name: '詞條清單', exact: true })).toHaveValue(/YOASOBI/);
});
test('canvas and blob failures retain the full text export and offer a working image retry', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext, blob = HTMLCanvasElement.prototype.toBlob; Object.assign(window, { canvasFail: true, blobFail: false });
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, ...args: unknown[]) { return (window as unknown as { canvasFail: boolean }).canvasFail ? null : get.apply(this, args as never); } as typeof get;
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) { if ((window as unknown as { blobFail: boolean }).blobFail) callback(null); else blob.call(this, callback, ...args); };
  });
  await page.goto('/me/music/share'); await expect(page.getByRole('alert')).toContainText('瀏覽器無法產生圖片'); await expect(page.getByRole('textbox', { name: '詞條清單', exact: true })).toHaveValue(/Aimer/);
  await page.evaluate(() => Object.assign(window, { canvasFail: false, blobFail: true })); await page.getByRole('button', { name: '重新產生圖片', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('圖片轉換失敗');
  await page.evaluate(() => Object.assign(window, { blobFail: false })); await page.getByRole('button', { name: '重新產生圖片', exact: true }).click(); await ready(page);
  await image(page).evaluate((element: HTMLImageElement) => { element.src = 'data:image/png;base64,AA'; }); await expect(page.getByRole('alert')).toContainText('圖片無法顯示'); await page.getByRole('button', { name: '重新產生圖片', exact: true }).click(); await ready(page);
});
test('metadata failures remove the old preview, keep local copying and recover without a write', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); let failed = false; await page.route('**/api/v2/me/music/share?*', route => failed ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'READ_FAILURE', message: '分享資料暫時無法讀取' }) }) : route.continue());
  await page.goto('/me/music/share'); await ready(page); failed = true; await chooseOption(page,'分享推薦排序','familiar'); await expect(page.getByRole('alert')).toContainText('分享資料暫時無法讀取'); await expect(image(page)).toHaveCount(0); await page.getByRole('button', { name: '複製詞條清單', exact: true }).click(); await expect(page.getByText('已複製詞條清單。', { exact: true })).toBeVisible();
  await page.unroute('**/api/v2/me/music/share?*'); await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await ready(page);
});
test('late share metadata cannot cross an account switch and delayed PNG conversion cannot survive logout', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); let captured!: () => void, release!: () => void; const readyRequest = new Promise<void>(resolve => { captured = resolve; }), pending = new Promise<void>(resolve => { release = resolve; }); let hold = true;
  await page.route('**/api/v2/me/music/share?*', async route => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); captured(); await pending; await route.fulfill({ response }).catch(() => {}); });
  await page.goto('/me/music/share'); await readyRequest; await login(context, 'bob'); await page.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('refresh'); channel.close(); }); await ready(page); expect((await lines(page))[1]).toBe('共同最多'); release(); expect((await lines(page))[1]).toBe('共同最多');
  await page.addInitScript(() => {
    const blob = HTMLCanvasElement.prototype.toBlob; Object.assign(window, { delayedShareBlobs: [] });
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) { blob.call(this, value => (window as unknown as { delayedShareBlobs: (() => void)[] }).delayedShareBlobs.push(() => callback(value)), ...args); };
  });
  await page.reload(); await expect.poll(() => page.evaluate(() => (window as unknown as { delayedShareBlobs: unknown[] }).delayedShareBlobs.length)).toBeGreaterThan(0);
  await context.clearCookies(); await page.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('logout'); channel.close(); }); await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { delayedShareBlobs: (() => void)[] }).delayedShareBlobs.forEach(release => release())); await expect(image(page)).toHaveCount(0); expect(await page.evaluate(() => (window as unknown as { shareCreated: string[] }).shareCreated)).toEqual([]);
});
test('supports a first unsaved profile and preserves pending or damaged draft recovery instead of exporting a fallback', async ({ page, context }) => {
  await login(context, 'auth-owner'); await inspectCanvas(page); await page.goto('/me/music/share'); await expect(page.getByText('尚未選擇可分享的詞條', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '選擇成分', exact: true }).click(); await toggleMusicTerm(page,'YOASOBI'); await page.getByRole('tab', { name: '分享圖片', exact: true }).click(); await ready(page); expect((await lines(page)).join('')).toContain('1 項 · 目前草稿'); expect((await lines(page)).join('')).not.toContain('成分 ID');
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
  const row=(await durableRows(page)).find(row=>row.key.includes('music:v1:'))!, draft=JSON.parse(row.raw);draft.requestKey=crypto.randomUUID();
  await damageDraft(page,'music:v1:',JSON.stringify(draft)); page.on('dialog', dialog => void dialog.accept()); await page.reload(); await expect(page.getByText('成分保存結果尚未確認，請回到我的成分確認結果。', { exact: true })).toBeVisible(); await expect(image(page)).toHaveCount(0);
  await damageDraft(page,'music:v1:','damaged draft'); await page.reload(); await expect(page.getByText('請先在本機原稿提示中完成恢復或保全，再產生分享內容。', { exact: true })).toBeVisible(); await expect(image(page)).toHaveCount(0); expect((await durableRows(page)).find(row=>row.key.includes('music:v1:'))!.raw).toBe('damaged draft');
});
test('erasure removes prior images and rebuilt drafts use a fresh epoch; mobile controls remain legible', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); await page.setViewportSize({ width: 360, height: 800 }); await page.goto('/me/music/share'); await ready(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/unified-music-share-mobile.png', fullPage: true });
  const privacy = await context.newPage(); await privacy.goto('/me/privacy'); await privacy.getByRole('radio', { name: '只刪除成分', exact: true }).check(); await privacy.getByRole('checkbox', { name: '我已確認範圍，瞭解此操作無法復原', exact: true }).check(); await privacy.getByRole('button', { name: '確認刪除成分', exact: true }).click(); await expect(image(page)).toHaveCount(0); await expect(page.getByRole('link', { name: '選擇成分', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '選擇成分', exact: true }).click(); await toggleMusicTerm(page,'Aimer'); await page.getByRole('tab', { name: '分享圖片', exact: true }).click(); await ready(page); expect((await lines(page)).join('')).not.toMatch(/我的成分|共同最多/); expect((await lines(page)).join('')).toContain('Aimer'); await privacy.close();
});

test('renders all 20 choices with long grapheme names, keeps full copy text and bounds every image line', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); const headers = await auth(context), own = await (await context.request.get('/api/v2/me/music', { headers })).json();
  const selections = [...Array.from({ length: 5 }, (_, i) => ({ entryId: 'main-' + i, level: 3 })), ...Array.from({ length: 15 }, (_, i) => ({ entryId: 'sub-' + i, level: i % 4 + 1 }))];
  expect((await context.request.put('/api/v2/me/music', { headers, data: { profileId: own.id, musicEpoch: 0, revision: own.revision, selections } })).status()).toBe(200);
  const name = (entry: string) => entry + '👩🏽‍🎤' + '完整かな英文Label '.repeat(60);
  await page.route('**/api/v2/music/catalog', async route => { const response = await route.fetch(), body = await response.json(); for (const entry of body.entries) entry.name = name(entry.id); await route.fulfill({ response, json: body }); });
  await page.goto('/me/music/share'); await ready(page); await expect(page.getByRole('textbox', { name: '詞條清單', exact: true })).toHaveValue(selections.map(pick => name(pick.entryId)).join('、'));
  const drawn = await lines(page); expect(drawn).toContain('20 項 · 已保存成分'); expect(drawn).toContain('領域 · 5 項'); expect(drawn).toContain('細分 · 15 項');
  for (const pick of selections) expect(drawn.some(line => line.startsWith(pick.entryId + '👩🏽‍🎤'))).toBe(true);
  const rows = await page.evaluate(() => (window as unknown as { shareDraws: { text: string; x: number; y: number; width: number }[] }).shareDraws);
  expect(rows.every(row => row.x + row.width <= 672)).toBe(true); expect(rows.every((row,i)=>rows.slice(0,i).filter(previous=>previous.x===row.x).every(previous=>previous.y<row.y))).toBe(true);
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: '下載圖片', exact: true }).click(); await (await download).saveAs('test-results/unified-music-share-full.png');
});
test('a failed native share cannot start a fallback download after the account has logged out', async ({ page, context }) => {
  await login(context); await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: () => new Promise((_resolve, reject) => Object.assign(window, { rejectMusicShare: () => reject(new Error('Synthetic late failure')) })) });
  });
  let downloads = 0; page.on('download', () => downloads++); await page.goto('/me/music/share'); await ready(page); await page.getByRole('button', { name: '分享圖片', exact: true }).click();
  await context.clearCookies(); await page.evaluate(() => { const channel = new BroadcastChannel('qgroup:rebuild:session'); channel.postMessage('logout'); channel.close(); }); await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { rejectMusicShare: () => void }).rejectMusicShare()); await expect(image(page)).toHaveCount(0); expect(downloads).toBe(0);
});
test('cross-tab edits refresh share identity and contact without ever drawing the new private note or gender', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); await page.goto('/me/music/share'); await ready(page); const old = await image(page).getAttribute('src');
  const editor = await context.newPage(); await editor.goto('/me/music/details'); await editor.getByLabel('成分稱呼', { exact: true }).fill('分享用新稱呼'); await editor.getByLabel('私人留言', { exact: true }).fill('不可匯出私人留言');
  await editor.getByRole('button', { name: '保存成分資料', exact: true }).click(); await expect(editor.getByText('成分資料已保存。', { exact: true })).toBeVisible();
  await expect.poll(async () => (await lines(page))[1]).toBe('分享用新稱呼'); await expect(image(page)).not.toHaveAttribute('src', old!); expect((await lines(page)).join('')).not.toMatch(/不可匯出|不可外洩性別/);
  await openMusicContact(editor); await editor.getByLabel('聯絡 QQ', { exact: true }).fill('556677'); await editor.getByRole('button', { name: '保存聯絡 QQ', exact: true }).click(); await expect(editor.getByText('已保存聯絡 QQ。', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '包含我的聯絡 QQ', exact: true })).toBeEnabled(); await redraw(page, () => page.getByRole('checkbox', { name: '包含我的聯絡 QQ', exact: true }).check()); expect((await lines(page)).join('')).toContain('556677'); await editor.close();
});

test('recommendations and sharing reuse the original saved sort preference with URL override and blocked-storage recovery', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); await page.addInitScript(() => { if (!sessionStorage.getItem('share-pref-seeded')) { localStorage.setItem('jpm.matchSort', 'familiar'); sessionStorage.setItem('share-pref-seeded', '1'); } });
  await page.goto('/people'); await expectOption(page,'排序','familiar');
  await page.goto('/me/music/share'); await ready(page); await expectOption(page,'分享推薦排序','familiar'); expect((await lines(page)).join('')).toContain('共同本命');
  await page.goto('/me/music/share?sort=rare'); await ready(page); await expectOption(page,'分享推薦排序','rare');
  await redraw(page, () => chooseOption(page,'分享推薦排序','familiar')); await redraw(page, () => chooseOption(page,'分享推薦排序','rare'));
  await page.goto('/people'); await expectOption(page,'排序','rare');
  await page.evaluate(() => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Denied'); } }); });
  await chooseOption(page,'排序','familiar'); await expect(page).toHaveURL('/people?sort=familiar');
  await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('link', { name: '我的', exact: true }).click(); await page.getByRole('link', { name: '編輯我的成分', exact: true }).click(); await page.getByRole('tab', { name: '分享圖片', exact: true }).click(); await ready(page); await expectOption(page,'分享推薦排序','rare');
});

test('a stalled native PNG conversion still produces the latest valid image and ignores late callbacks', async ({ page, context }) => {
  await login(context); await inspectCanvas(page); await page.addInitScript(() => {
    const pending: (() => void)[] = []; Object.assign(window, { pendingNativePNGs: pending });
    HTMLCanvasElement.prototype.toBlob = function(callback) {
      const data = atob(this.toDataURL('image/png').split(',')[1]!), bytes = Uint8Array.from(data, char => char.charCodeAt(0)), blob = new Blob([bytes], { type: 'image/png' });
      pending.push(() => callback(blob));
    };
  });
  await page.goto('/me/music/share'); await ready(page); const old = await image(page).getAttribute('src');
  await redraw(page, () => page.getByRole('checkbox', { name: '包含推薦同好', exact: true }).uncheck());
  const current = await image(page).getAttribute('src'); expect(current).not.toBe(old); expect((await lines(page)).join('')).not.toContain('匹配度');
  await page.evaluate(() => (window as unknown as { pendingNativePNGs: (() => void)[] }).pendingNativePNGs.splice(0).forEach(release => release()));
  await expect(image(page)).toHaveAttribute('src', current!); await expect(image(page)).toHaveJSProperty('naturalWidth', 1440);
});
