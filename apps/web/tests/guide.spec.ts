import { expectControlValue } from './kimi-controls';
import { test, expect } from './fixtures';
import { readFileSync } from 'node:fs';
// Read the actual fixed alias declaration without importing worker/domain code
// into Playwright's separate ESM loader.
const botSource=readFileSync(new URL('../../bot/src/commands.ts',import.meta.url),'utf8');
const BOT_ALIASES=JSON.parse(botSource.match(/export const BOT_ALIASES = (\{[\s\S]*?\}) as const;/)![1]!) as Record<string,string>;
for(const language of ['zh-CN','zh-TW'])test(language+' handbook keeps the legacy bot chapter and every command without business writes',async({page,context})=>{
  await context.route(`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}/**`,route=>route.continue({headers:{...route.request().headers(),'accept-language':language}}));
  let writes=0;page.on('request',request=>{if(['POST','PUT','PATCH','DELETE'].includes(request.method()))writes++;});
  const response=await page.goto('/guide.html#section-11');expect(response?.headers()['content-language']).toBe(language==='zh-CN'?'zh-Hans':'zh-Hant');await expect(page).toHaveURL('/guide#section-11');await expect(page.getByRole('heading',{name:language==='zh-CN'?'使用说明':'使用說明',exact:true})).toBeVisible();
  const chapter=page.locator('#section-11');await expect(chapter).toHaveAttribute('data-open','true');const commands=await chapter.locator('code').allTextContents();
  for(const command of new Set(Object.values(BOT_ALIASES)))expect(commands.join(' ')).toContain('/'+command);
  await expect(page.locator('.guide-section')).toHaveCount(17);await expect(chapter).toContainText(language==='zh-CN'?'没有自动报名、退出、确认出席或记帐':'沒有自動報名、退出、確認出席或記帳');
  await page.getByRole('button',{name:language==='zh-CN'?'隐私与删除':'隱私與刪除',exact:true}).click();await expect(page.locator('#privacy')).toHaveAttribute('data-open','true');await expect(page.getByRole('link',{name:'渝ICP备16002872号-1',exact:true})).toBeVisible();expect(writes).toBe(0);
});
test('handbook and contact links remain available anonymously when session lookup fails',async({page})=>{
  await page.route('**/api/v2/session',route=>route.fulfill({status:503,json:{code:'SYNTHETIC',message:'session unavailable'}}));await page.goto('/me');await expect(page.getByRole('alert')).toContainText('session unavailable');await page.getByRole('link',{name:'使用說明',exact:true}).click();await expect(page.getByRole('heading',{name:'使用說明',exact:true})).toBeVisible();await page.getByRole('button',{name:'隱私與刪除',exact:true}).click();await expect(page.locator('#privacy')).toHaveAttribute('data-open','true');
});
test('legacy settlement chapters remain readable at phone width and guide task links only navigate',async({page,context})=>{
  await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);await page.setViewportSize({width:360,height:800});let writes=0;page.on('request',request=>{if(['POST','PUT','PATCH','DELETE'].includes(request.method()))writes++;});
  await page.goto('/guide.html#section-6');await expect(page).toHaveURL('/guide#section-6');await expect(page.locator('#section-6')).toHaveAttribute('data-open','true');await expect(page.locator('#section-6')).toContainText('不同包間的債務不以一個淨額互相抵銷');
  await page.getByRole('button',{name:'QQ bot',exact:true}).click();await expect(page.locator('#section-11')).toHaveAttribute('data-open','true');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await page.locator('#section-11 tbody td').first().boundingBox())!.width).toBeGreaterThan(60);await page.screenshot({path:'test-results/unified-guide-mobile.png'});
  await page.getByRole('button',{name:'發起與時間投票',exact:true}).click();await page.getByRole('link',{name:'新增活動',exact:true}).click();await expect(page).toHaveURL('/activities/new');await expectControlValue(page.getByLabel('活動名稱',{exact:true}), '');expect(writes).toBe(0);
});
test('unknown legacy fragments and query credentials are discarded before opening the public handbook',async({page})=>{
  await page.goto('/guide.html?event=PRIVATE&token=SECRET#unknown');await expect(page).toHaveURL('/guide');await expect(page.getByRole('heading',{name:'使用說明',exact:true})).toBeVisible();expect(await page.locator('.guide').textContent()).not.toMatch(/PRIVATE|SECRET/);
});
