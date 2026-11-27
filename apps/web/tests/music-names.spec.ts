import { test,expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
test.use({adminCatalog:true});
async function login(context:BrowserContext){await context.addCookies([{name:'kanban_session',value:'fixture-registration-admin',url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function maintain(page:import('@playwright/test').Page){
 await page.goto('/admin/music-entries');await page.getByRole('button',{name:'編輯 YOASOBI',exact:true}).click();
 await page.getByLabel('繁中譯名',{exact:true}).fill('夜遊樂團');await page.getByLabel('簡中譯名',{exact:true}).fill('夜游乐队');await page.getByLabel('官方英文名',{exact:true}).fill('Night Music');await page.getByLabel('日文讀音',{exact:true}).fill('よあそび');await page.getByLabel('羅馬字',{exact:true}).fill('Yoasobi');
 await page.getByRole('button',{name:'新增別名',exact:true}).click();const last=page.locator('.music-alias-row').last();await last.getByRole('textbox').fill('NightBand');
 await page.getByRole('checkbox',{name:'我已核對詞條及影響範圍',exact:true}).check();await page.getByRole('button',{name:'確認詞條變更',exact:true}).click();await expect(page.getByText('已保存詞條。',{exact:true})).toBeVisible();
}
test('administrator maintains named fields and individual aliases; mobile catalog, detail, search and reload retain one term',async({page,context})=>{
 await login(context);await page.setViewportSize({width:430,height:932});await maintain(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.reload();await page.getByRole('button',{name:'編輯 YOASOBI',exact:true}).click();await expect(page.getByLabel('繁中譯名',{exact:true})).toHaveValue('夜遊樂團');await expect(page.locator('.music-alias-row').last().getByRole('textbox')).toHaveValue('NightBand');await page.getByRole('button',{name:'放棄原稿',exact:true}).click();
 await page.goto('/music?q=nightband');const row=page.locator('.term-row').filter({has:page.getByRole('link',{name:'YOASOBI',exact:true})});await expect(row.locator('.music-translation')).toHaveText('夜遊樂團');await row.getByRole('link',{name:'YOASOBI',exact:true}).click();
 const detail=page.getByRole('region',{name:'詞條資料',exact:true});for(const label of ['夜遊樂團','夜游乐队','Night Music','よあそび','Yoasobi','NightBand'])await expect(detail).toContainText(label);
 await page.goto('/search?q=nightband');await expect(page.getByRole('region',{name:'音樂搜尋結果',exact:true}).getByRole('link',{name:'YOASOBI',exact:true})).toBeVisible();
 await page.goto('/music?q=ヨアソビ');await expect(page.locator('.term-row')).toHaveCount(1);
});
test('Chinese name display follows the browser script while both regional names remain searchable',async({page,context})=>{
 await login(context);await maintain(page);await context.route(origin+'/**',route=>route.continue({headers:{...route.request().headers(),'accept-language':'zh-CN'}}));await page.goto('/music?q=夜遊樂團');await expect(page.locator('.term-row .music-translation')).toHaveText('夜游乐队');await expect(page.locator('.term-row .term-name > a')).toHaveText('YOASOBI');
 await page.goto('/music?q=夜游乐队');await expect(page.locator('.term-row')).toHaveCount(1);await context.unroute(origin+'/**');await page.goto('/music?q=NightMusic');await expect(page.locator('.term-row .music-translation')).toHaveText('夜遊樂團');
});
