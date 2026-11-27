import { chooseOption, expectControlValue, closeMusicLevel, toggleMusicTerm } from './kimi-controls';
import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`;
async function login(context:BrowserContext,user='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function add(page:import('@playwright/test').Page,name:string){await toggleMusicTerm(page,name);}

test('uses the supplied prototype activity toolbar with complete server filtering, scoped summaries and source tabs',async({page,context})=>{
 await login(context);await page.goto('/activities');await expect(page.locator('.kimi.activities-page')).toBeVisible();
 await expect(page.getByLabel('活動摘要')).toContainText('近期活動');await expect(page.getByLabel('活動摘要')).toContainText('我的待辦');
 await page.getByLabel('搜尋活動或地點',{exact:true}).fill('河岸');await page.getByLabel('搜尋活動或地點',{exact:true}).press('Enter');
 await expect(page.getByRole('link',{name:'週末一起聽日系音樂',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'冬日的第一場合唱',exact:true})).toHaveCount(0);
 await expect(page).toHaveURL(/q=/);await page.reload();await expectControlValue(page.getByLabel('搜尋活動或地點',{exact:true}), '河岸');
 await page.getByRole('tab',{name:'我的活動',exact:true}).click();await expect(page).toHaveURL(/\/me\/activities/);
 await page.getByLabel('搜尋活動或地點',{exact:true}).fill('');await page.getByRole('tab',{name:'往期與歸檔',exact:true}).click();
 await expect(page).toHaveURL(/period=history/);await expect(page.getByRole('link',{name:'上次的相聚',exact:true})).toBeVisible();
});

test('keeps domains independent, edits prototype familiarity groups, and saves through the existing durable API',async({page,context})=>{
 await login(context);await page.goto('/me/music');await add(page,'J-POP');await add(page,'Aimer');
 await expect(page.getByLabel('J-POP喜歡程度')).toContainText('常聽');await chooseOption(page,'Aimer喜歡程度','4');
 await expect(page.locator('.familiarity-group').filter({has:page.getByRole('heading',{name:'本命',exact:true})})).toContainText('Aimer');
 await page.locator('.selection-summary').getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
 const viewer=await(await context.request.get('/api/v2/session')).json(),saved=await(await context.request.get('/api/v2/me/music',{headers:{'X-Account-Scope':viewer.scope}})).json();expect(saved.selections).toEqual([{entryId:'main-0',level:3},{entryId:'sub-2',level:4}]);
 await page.getByRole('tab',{name:'分享圖片',exact:true}).click();await expect(page).toHaveURL('/me/music/share');
});

test('prototype catalog rows select real terms, keep dialog controls and restore filters on return',async({page,context})=>{
 await login(context);await page.goto('/music?q=Aimer');await expect(page.locator('.term-row')).toHaveCount(1);
 await page.getByRole('button',{name:'選取Aimer',exact:true}).click();await closeMusicLevel(page);await page.getByRole('link',{name:'Aimer',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await chooseOption(page,'Aimer喜歡程度','1');
 await dialog.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(dialog.getByText('已保存。',{exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'返回詞庫',exact:true}).click();await expect(dialog).toHaveCount(0);await expectControlValue(page.getByLabel('搜尋音樂詞條',{exact:true}), 'Aimer');
 await page.getByRole('tab',{name:'完整詞庫',exact:true}).click();await expect(page).toHaveURL(/library=all/);await page.getByRole('button',{name:'細分氣泡',exact:true}).click();const bubbles=page.getByRole('group',{name:'細分氣泡圖',exact:true});await expect(bubbles).toBeVisible();await expect(bubbles.getByRole('link')).toHaveCount(1);await expect(bubbles.getByRole('link')).toHaveAccessibleName(/^Aimer，/);
});

for(const width of [360,390,768,1440])test('prototype pages preserve responsive geometry at '+width+'px',async({page,context},info)=>{
 await login(context);await page.setViewportSize({width,height:900});
 for(const [name,path]of [['activities','/activities'],['music','/music'],['editor','/me/music'],['detail','/activities/listen'],['me','/me']]){
  await page.goto(path!);await expect(page.locator('main .kimi.page')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name).toBe(true);
  if(width===390||width===1440)await info.attach(name+'-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }
 await page.goto('/music/entries/sub-2');const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});


test('refreshes the original prototype list immediately after a completed signup',async({page,context})=>{
 await login(context,'bob');await page.goto('/activities');const row=()=>page.locator('.activity-row').filter({has:page.getByRole('link',{name:'週末一起聽日系音樂',exact:true})});await expect(row().locator('.my-registration')).toHaveCount(0);
 await row().getByRole('link',{name:'週末一起聽日系音樂',exact:true}).click();await page.getByRole('button',{name:'本人報名',exact:true}).click();await expect(page.getByText('報名已保存。',{exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('navigation',{name:'主要導覽',exact:true}).getByRole('link',{name:'活動',exact:true}).click();await expect(row().locator('.my-registration')).toContainText('正式');
});
