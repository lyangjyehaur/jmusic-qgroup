import { toggleMusicTerm, chooseOption } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { denyDraftWrites, durableRows } from './draft-helpers';
async function languageHeader(context: BrowserContext, language: string) {
  // Chrome's locale overrides extraHTTPHeaders for Accept-Language. Send the
  // requested header at the transport boundary, through the real fixture API.
  await context.route(`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}/**`, route => route.continue({ headers: { ...route.request().headers(), 'accept-language': language } }));
}
for (const language of ['zh-CN', 'zh-TW', 'en-US,zh-CN;q=0.9']) test('the highest-priority '+language+' header selects consistent public navigation, privacy and account labels', async ({ page, context }) => {
  await languageHeader(context, language);
  const simplified = language === 'zh-CN', expected = simplified ? 'zh-Hans' : 'zh-Hant';
  const response = await page.goto('/activities');
  expect(response?.headers()['content-language']).toBe(expected);expect(response?.headers().vary).toBe('Accept-Language');
  await expect(page.locator('html')).toHaveAttribute('lang', expected);
  await expect(page.getByRole('heading', { name: simplified ? '活动' : '活動', exact: true })).toBeVisible();
  await page.getByRole('link', { name: simplified ? '音乐' : '音樂', exact: true }).click();
  await expect(page.getByRole('heading', { name: simplified ? '音乐' : '音樂', exact: true })).toBeVisible();
  await page.goto('/privacy');await expect(page.getByRole('heading', { name: simplified ? '隐私政策' : '隱私政策', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '渝ICP备16002872号-1', exact: true })).toBeVisible();
  await expect(page.locator('article')).not.toHaveAttribute('lang', 'zh-Hans');
  await page.goto('/me/profile');await expect(page.getByRole('heading', { name: simplified ? '站内称呼' : '站內稱呼', exact: true })).toBeVisible();
});
test.describe('localized offline navigation', () => {
  test.use({ serviceWorkers: 'allow', locale: 'zh-CN' });
  test('the worker returns simplified recovery instructions and no cached account or activity data', async ({ page, context }) => {
    await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/me/app');await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')).toMatch(/\/sw.js$/);
    await page.goto('/activities/listen');await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
    try {
      await context.setOffline(true);const response = await page.goto('/activities/listen');expect(response?.status()).toBe(503);expect(response?.headers()['content-language']).toBe('zh-Hans');await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
      await expect(page.getByRole('heading', { name: '暂时无法连线', exact: true })).toBeVisible();await expect(page.locator('body')).not.toContainText('週末一起聽日系音樂');await expect(page.locator('body')).not.toContainText('小青');
    } finally { await context.setOffline(false); }
    await page.reload();await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
  });
});
for (const language of ['zh-CN', 'zh-TW']) test(language+' account saves retain original mixed-script user content and show the actual localized result', async ({ page, context }) => {
  await languageHeader(context, language);await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, httpOnly: true, sameSite: 'Lax' }]);
  const simplified = language === 'zh-CN', raw = '后台發 · 帐号後臺';
  await page.goto('/me/profile');const field = page.getByLabel(simplified ? '站内称呼' : '站內稱呼', { exact: true });await field.fill(raw);
  const sent = page.waitForRequest(request => request.url().endsWith('/api/v2/me/profile') && request.method() === 'PUT');
  await page.getByRole('button', { name: simplified ? '保存称呼' : '保存稱呼', exact: true }).click();expect((await sent).postDataJSON().nickname).toBe(raw);
  await expect(page.getByText(simplified ? '已保存称呼。' : '已保存稱呼。', { exact: true })).toBeVisible();await expect(field).toHaveValue(raw);
  await page.reload();await expect(field).toHaveValue(raw);await expect(page.locator('.viewer')).toHaveText(raw);
  if (simplified) {
    await page.setViewportSize({ width: 360, height: 800 });await expect(page.getByRole('banner')).toHaveCount(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await page.screenshot({ path: 'test-results/unified-language-mobile.png', fullPage: true });
  }
});
test('a simplified activity form preserves the original category protocol and mixed-script draft after reload', async ({ page, context }) => {
  await languageHeader(context, 'zh-CN');await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: `http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`, httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/activities/new');const field = page.getByLabel('活动名称', { exact: true });await field.fill('后台發 · 帐号後臺');
  await chooseOption(page,'活动类型',{label:'运动'});await expect(page.getByLabel('活动类型',{exact:true})).toContainText('运动');
  await expect(page.getByText('正在保存本机原稿…', { exact: true })).toHaveCount(0);await page.reload();await expect(field).toHaveValue('后台發 · 帐号後臺');await expect(page.getByLabel('活动类型', { exact: true })).toContainText('运动');
  await page.getByRole('button',{name:'恢复本机原稿',exact:true}).click();
  await page.getByLabel('地点',{exact:true}).fill('后台發');await page.getByLabel('开始时间（台北）',{exact:true}).fill('2099-12-12T14:30:25');await page.getByLabel('报名截止（台北）',{exact:true}).fill('2099-12-11T14:30:00');
  const sent=page.waitForRequest(request=>request.url().endsWith('/api/v2/activities/drafts')&&request.method()==='POST');
  await page.getByRole('button',{name:'建立活动草稿',exact:true}).click();expect((await sent).postDataJSON().values).toMatchObject({category:'运动',title:'后台發 · 帐号後臺',location:'后台發'});
  await expect(page).toHaveURL(/\/activities\/[a-f0-9]{16}\/edit$/);await expect(field).toHaveValue('后台發 · 帐号後臺');
});
test('simplified persistence failure prevents writes and keeps the original nickname draft',async({page,context})=>{
  await languageHeader(context,'zh-CN');await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);
  await page.goto('/me/profile');await page.getByLabel('站内称呼',{exact:true}).fill('后台發 · 帐号後臺');await expect(page.getByText('正在保存本机原稿…',{exact:true})).toHaveCount(0);
  const original=(await durableRows(page)).find(row=>row.key.includes('account-profile:'))!;let writes=0;page.on('request',request=>{if(request.method()==='PUT'&&request.url().endsWith('/me/profile'))writes++;});
  await denyDraftWrites(page,'account-profile:');await page.getByRole('button',{name:'保存称呼',exact:true}).click();
  await expect(page.getByText('无法保存原稿及操作编号，尚未送出。',{exact:true})).toBeVisible();expect(writes).toBe(0);expect((await durableRows(page)).find(row=>row.key===original.key)?.raw).toBe(original.raw);
});
test('simplified history interprets only state fields and preserves user text that matches protocol words',async({page,context})=>{
  await languageHeader(context,'zh-CN');const raw='后台發 · 帐号後臺';
  await page.route('**/api/v2/activities/listen/history',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,entries:[{id:'999',version:1,actorName:raw,action:'event_updated',before:{title:'confirmed',nickname:'waiting',fee_policy:raw,status:'waiting'},after:{title:'accepted',nickname:'pending',fee_policy:raw+' next',status:'confirmed'},reason:raw,createdAt:'2026-11-18T08:00:00Z'}],nextBefore:null}});});
  await page.goto('/activities/listen/history');await page.locator('.history-entry summary').click();
  await expect(page.getByText('confirmed → accepted',{exact:true})).toBeVisible();await expect(page.getByText('waiting → pending',{exact:true})).toBeVisible();await expect(page.getByText(raw+' → '+raw+' next',{exact:true})).toBeVisible();
  await expect(page.getByText('候补 → 正式／已确认',{exact:true})).toBeVisible();await expect(page.locator('.history-entry summary')).toContainText(raw);
});
test.describe('simplified bot delivery recovery',()=>{
  test.use({botDeliveryExamples:true});
  test('mismatched receipts localize the error and preserve the command without another queue',async({page,context})=>{
    await languageHeader(context,'zh-CN');await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);
    await page.goto('/activities/listen/bot-deliveries?delivery=1');await expect(page.getByRole('combobox',{name:'投递状态',exact:true}).locator('option[value="failed"]')).toHaveText('失败');await expect(page.getByRole('combobox',{name:'通知类型',exact:true}).locator('option[value="settlement_updated"]')).toHaveText('结算发布');
    let writes=0;await page.route('**/api/v2/activities/listen/bot-deliveries/1/retry',route=>{writes++;return route.abort();});
    await page.getByRole('checkbox',{name:'我已核对目标群、发送模式与重送内容',exact:true}).check();await page.getByRole('button',{name:'建立重送工作',exact:true}).click();const recover=page.getByRole('button',{name:'查回原重送结果',exact:true});await expect(recover).toBeVisible();
    const original=(await durableRows(page)).find(row=>row.key.includes('bot-delivery:')&&row.raw!=='null')!;
    await page.route('**/api/v2/bot-delivery-results/*',route=>route.fulfill({json:{state:'completed',result:{originalId:'1',queuedId:'7',entity:'activity',entityId:'other'}}}));await recover.click();
    await expect(page.getByText('原重送回执的通知或活动不符，请保全纪录后核对。',{exact:true})).toBeVisible();expect((await durableRows(page)).find(row=>row.key===original.key)?.raw).toBe(original.raw);expect(writes).toBe(1);await expect(page.getByRole('button',{name:'以原操作编号重送',exact:true})).toHaveCount(0);
  });
  test('a localized cross-tab conflict preserves both originals and sends only one command',async({page,context})=>{
    await languageHeader(context,'zh-CN');await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);
    await page.goto('/activities/listen/bot-deliveries?delivery=1');const other=await context.newPage();await other.goto('/activities/listen/bot-deliveries?delivery=1');await expect(other.getByRole('checkbox',{name:'我已核对目标群、发送模式与重送内容',exact:true})).toBeEnabled();let writes=0;await context.route('**/api/v2/activities/listen/bot-deliveries/1/retry',route=>{writes++;return route.abort();});
    for(const tab of [page,other]){await tab.getByRole('checkbox',{name:'我已核对目标群、发送模式与重送内容',exact:true}).check();await tab.getByRole('button',{name:'建立重送工作',exact:true}).click();}
    await expect(other.getByRole('status').filter({hasText:'其他分页已更新原稿。这个分页的内容已保全，请先读取已保存版本。'})).toBeVisible();expect(writes).toBe(1);expect((await durableRows(other,'versions')).filter(row=>row.key.includes('bot-delivery:')).length).toBeGreaterThan(0);
  });
});
for(const language of ['zh-CN','zh-TW']) test(language+' localized summary chunks keep original content and copy-field layout',async({page,context})=>{
  await languageHeader(context,language);const simplified=language==='zh-CN',raw='后台發 · 帐号後臺';
  await page.route('**/api/v2/activities/listen',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,title:raw,location:raw+' place',description:raw+' description',feePolicy:raw+' fee'}});});
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as unknown as {copied:string}).copied=text;}}});});
  let writes=0;page.on('request',request=>{if(['POST','PUT','DELETE'].includes(request.method()))writes++;});
  await page.goto('/activities/listen/share');const link=page.getByLabel(simplified?'活动连结':'活動連結',{exact:true}),summary=page.getByLabel(simplified?'活动摘要':'活動摘要',{exact:true});
  await expect(link).toHaveAttribute('rows','3');await expect(summary).toHaveAttribute('rows','10');
  const text=await summary.inputValue();for(const part of [raw,raw+' place',raw+' description',raw+' fee'])expect(text).toContain(part);
  expect(text).toContain(simplified?'地点：':'地點：');expect(text).toContain(simplified?'报名截止：':'報名截止：');expect(text).toContain(simplified?'安排版本：':'安排版本：');
  await page.getByRole('button',{name:simplified?'复制活动摘要':'複製活動摘要',exact:true}).click();expect(await page.evaluate(()=>(window as unknown as {copied:string}).copied)).toBe(text);
  await expect(page.getByText(simplified?'已复制活动摘要。':'已複製活動摘要。',{exact:true})).toBeVisible();expect(writes).toBe(0);
});
test('simplified filters and count fragments retain event titles and wire query values',async({page,context})=>{
  await languageHeader(context,'zh-CN');await page.route('**/api/v2/activities?*',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,events:body.events.map((event:Record<string,unknown>)=>({...event,title:'后台發 · 帐号後臺',waiting:2}))}});});
  await page.goto('/activities');await expect(page.getByRole('tab',{name:'近期活动',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'往期与归档',exact:true})).toBeVisible();
  await expect(page.locator('.activity-row').first()).toContainText('后台發 · 帐号後臺');await expect(page.locator('.activity-row').first()).toContainText(/候补\s*2\s*人/);
  await page.getByRole('tab',{name:'往期与归档',exact:true}).click();await expect(page).toHaveURL(/period=history/);
});
test('simplified QQ binding instructions preserve the original nickname and do not start authorization',async({page,context})=>{
  await languageHeader(context,'zh-CN');await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);
  await page.route('**/api/v2/session',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,nickname:'后台發 · 帐号後臺',qqEnabled:true}});});
  let writes=0;page.on('request',request=>{if(request.method()==='POST')writes++;});await page.goto('/login?mode=bind');
  await expect(page.getByText('绑定目前帐号「后台發 · 帐号後臺」，不搬移报名或款项。',{exact:true})).toBeVisible();expect(writes).toBe(0);
});
test.describe('simplified music display fragments',()=>{
  test.use({musicMatches:true});
  test('familiarity choices and canvas labels keep entry names, numeric levels and unsaved draft contents',async({page,context})=>{
    await languageHeader(context,'zh-CN');await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);
    await page.addInitScript(()=>{const original=CanvasRenderingContext2D.prototype.fillText,clear=CanvasRenderingContext2D.prototype.fillRect;const state=window as unknown as {lines:string[]};state.lines=[];CanvasRenderingContext2D.prototype.fillRect=function(...args){state.lines=[];return clear.apply(this,args);};CanvasRenderingContext2D.prototype.fillText=function(text,...args){state.lines.push(text);return original.call(this,text,...args);};});
    let writes=0;page.on('request',request=>{if(['PUT','POST','DELETE'].includes(request.method()))writes++;});await page.goto('/me/music');await toggleMusicTerm(page, '米津玄師');
    const level=page.getByLabel('米津玄師喜欢程度',{exact:true});await level.click();await expect(page.getByRole('option',{name:'只听过几首',exact:true})).toBeVisible();await expect(page.getByRole('option',{name:'常听',exact:true})).toBeVisible();await page.getByRole('option',{name:'只听过几首',exact:true}).click();await expect(level).toContainText('只听过几首');
    await expect(page.getByText('正在保存本机原稿…',{exact:true})).toHaveCount(0);const before=(await durableRows(page)).find(row=>row.key.includes(':music:v1:'));expect(before).toBeDefined();expect(JSON.parse(before!.raw).selections.find((row:{entryId:string})=>row.entryId==='sub-4').level).toBe(1);
    await page.getByRole('link',{name:'分享成分',exact:true}).click();await expect(page.getByRole('img',{name:'音乐成分分享图片；完整词条可见下方清单',exact:true})).toBeVisible();
    const lines=await page.evaluate(()=>(window as unknown as {lines:string[]}).lines);expect(lines).toContain('群聚・我的音乐成分');expect(lines).toContain('米津玄師');expect(lines).toContain('领域 · 2 项');expect(lines.some(line=>line.includes('只听过几首'))).toBe(true);expect(lines.some(line=>line.includes('目前草稿'))).toBe(true);
    expect((await durableRows(page)).find(row=>row.key===before!.key)?.raw).toBe(before!.raw);expect(writes).toBe(0);
  });
});
test.describe('simplified management display fragments',()=>{
  test.use({adminCatalog:true});
  test('catalog action labels preserve names and category wire values while keeping review unsent',async({page,context})=>{
    await languageHeader(context,'zh-CN');await context.addCookies([{name:'kanban_session',value:'fixture-registration-admin',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);
    let writes=0;page.on('request',request=>{if(['PUT','POST','DELETE'].includes(request.method()))writes++;});await page.goto('/admin/music-entries');await page.getByRole('button',{name:'编辑 YOASOBI',exact:true}).click();
    await expect(page.getByRole('region',{name:'词条操作核对',exact:true}).getByRole('heading',{name:'编辑词条',exact:true})).toBeVisible();await expect(page.getByLabel('词条名称',{exact:true})).toHaveValue('YOASOBI');
    await page.getByLabel('词条分类',{exact:true}).selectOption('领域');await expect(page.getByLabel('词条分类',{exact:true})).toHaveValue('领域');await expect(page.getByLabel('词条分类',{exact:true}).locator('option[value="领域"]')).toHaveText('领域');expect(writes).toBe(0);
  });
});

test.describe('complete browser-script display',()=>{
  test.use({pollExamples:true});
  for(const language of ['zh-CN','en-US','ja-JP']) test(language+' localizes dates, dialog controls and poll statistics while retaining original content',async({page,context})=>{
    await languageHeader(context,language);const simplified=language==='zh-CN',raw='后台發 · 帐号後臺';
    await page.route('**/api/v2/time-polls/poll-exact',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,title:raw}});});
    await page.route('**/api/v2/activities?*',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,events:body.events.map((event:Record<string,unknown>)=>({...event,startsAt:'2026-11-28T16:00:00Z',timezone:'Asia/Shanghai'}))}});});
    await page.goto('/activities');await expect(page.locator('.activity-meta').first()).toContainText(simplified?'周日':'週日');
    await page.getByRole('link',{name:simplified?'全站搜寻':'全站搜尋',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:simplified?'全站搜寻':'全站搜尋',exact:true});await expect(dialog).toBeVisible();
    await page.getByRole('searchbox',{name:simplified?'搜寻活动、词条或成分称呼':'搜尋活動、詞條或成分稱呼',exact:true}).fill('音');
    await dialog.getByRole('button',{name:simplified?'搜寻':'搜尋',exact:true}).click();
    await expect(dialog.getByRole('link',{name:simplified?'音乐词条':'音樂詞條',exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:simplified?'返回原页':'返回原頁',exact:true}).click();await expect(page).toHaveURL('/activities');
    await page.goto('/time-polls/poll-exact');await expect(page.getByRole('heading',{name:raw,exact:true})).toBeVisible();
    await expect(page.locator('.vote-stats').first()).toContainText(simplified?'勉强可以':'勉強可以');
  });
});
