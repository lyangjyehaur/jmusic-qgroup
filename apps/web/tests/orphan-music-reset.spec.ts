import {test,expect} from './fixtures';
import type {BrowserContext,Page} from '@playwright/test';
const origin='http://127.0.0.1:5082';
async function login(context:BrowserContext){await context.addCookies([{name:'kanban_session',value:'fixture-registration-admin',url:origin,httpOnly:true,sameSite:'Lax'}]);}
const review=(page:Page)=>page.getByRole('region',{name:'刪除範圍核對',exact:true});
async function confirm(page:Page){await page.getByLabel('輸入 RESET 確認',{exact:true}).fill('RESET');await page.getByRole('checkbox',{name:'我已核對刪除範圍及不可復原的影響',exact:true}).check();await page.getByRole('button',{name:'重置成分與詞庫',exact:true}).click();}
test.describe('anonymous and historical music reset',()=>{
  test.use({orphanMusicReset:'shouts',botDeliveryExamples:true});
  test('resets anonymous active and archived posts without profiles or terms and preserves the bot delivery list',async({page,context,request})=>{
    await login(context);const viewer=(await(await request.get(origin+'/api/v2/session',{headers:{Cookie:'kanban_session=fixture-alice'}})).json()),headers={Cookie:'kanban_session=fixture-alice','X-Account-Scope':viewer.scope};const notices=await request.get(origin+'/api/v2/activities/listen/bot-deliveries',{headers});expect(notices.status()).toBe(200);const before=await notices.json();
    await page.setViewportSize({width:360,height:800});await page.goto('/admin/music-reset');await expect(review(page)).toContainText('0 份成分 · 0 項選擇 · 2 則找搭子');await expect(review(page)).toContainText('留言與趨勢相關紀錄：4 筆');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await confirm(page);await expect(page.getByText('找搭子與趨勢歷史已清空。',{exact:true})).toBeVisible();
    expect((await(await request.get(origin+'/api/v2/activities/listen/bot-deliveries',{headers})).json())).toEqual(before);await page.goto('/activities');await expect(page.getByRole('link',{name:'週末一起聽日系音樂',exact:true})).toBeVisible();
    expect((await(await context.request.get('/api/v2/session')).json()).authenticated).toBe(true);await page.goto('/admin/music-reset');await expect(page.getByText('找搭子與趨勢歷史已清空。',{exact:true})).toBeVisible();await page.getByRole('button',{name:'完成',exact:true}).click();await expect(review(page)).toContainText('0 則找搭子');await expect(review(page)).toContainText('目前沒有可重置的成分、詞條、找搭子或歷史紀錄。');
  });
});
test.describe('trend-only music reset',()=>{
  test.use({orphanMusicReset:'trend'});
  test('recovers a lost trend-only reset response after reload and preserves the original single command',async({page,context})=>{
    await login(context);let writes=0;await page.route('**/api/v2/admin/music-reset',async route=>{if(route.request().method()!=='POST')return route.continue();writes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
    await page.goto('/admin/music-reset');await expect(review(page)).toContainText('0 份成分 · 0 項選擇 · 0 則找搭子');await expect(review(page)).toContainText('留言與趨勢相關紀錄：2 筆');await confirm(page);
    await expect(page.getByRole('button',{name:'查詢刪除結果',exact:true})).toBeVisible();page.on('dialog',dialog=>void dialog.accept());await page.reload();await page.getByRole('button',{name:'查詢刪除結果',exact:true}).click();
    await expect(page.getByText('成分與詞庫重置已完成。',{exact:true})).toBeVisible();expect(writes).toBe(1);expect((await(await context.request.get('/api/v2/session')).json()).authenticated).toBe(true);
  });
});
test.describe('empty music reset',()=>{
  test.use({orphanMusicReset:'empty'});
  test('explains why a settings-only catalog cannot submit a reset even after confirmation',async({page,context})=>{
    await login(context);let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/admin/music-reset'))writes++;});await page.goto('/admin/music-reset');
    await expect(review(page)).toContainText('目前沒有可重置的成分、詞條、找搭子或歷史紀錄。');await expect(page.getByText('留言與趨勢相關紀錄：',{exact:false})).toHaveCount(0);await page.getByLabel('輸入 RESET 確認',{exact:true}).fill('RESET');await page.getByRole('checkbox',{name:'我已核對刪除範圍及不可復原的影響',exact:true}).check();
    await expect(page.getByRole('button',{name:'重置成分與詞庫',exact:true})).toBeDisabled();expect(writes).toBe(0);
  });
});
