import { test, expect } from './fixtures';
import { chooseMusicLevel, expectMusicTerm, toggleMusicTerm } from './kimi-controls';
import { denyDraftWrites, durableRows } from './draft-helpers';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
async function login(context:import('@playwright/test').BrowserContext){await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin,httpOnly:true,sameSite:'Lax'}]);}

for(const [name,id] of [['J-POP','main-0'],['Aimer','sub-2']] as const)test(`catalog ${name} selection prompts for four levels, keeps the default on close, and submits only on save`,async({page,context})=>{
 await login(context);await page.goto('/music?q='+encodeURIComponent(name));let writes=0;page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/me/music'))writes++;});
 await page.getByRole('button',{name:'選取'+name,exact:true}).click();const picker=page.getByRole('dialog',{name:'「'+name+'」的喜歡程度',exact:true});
 await expect(picker).toBeVisible();for(const level of ['本命','常聽','聽過一些','只聽過幾首'])await expect(picker.getByRole('button',{name:level,exact:true})).toBeVisible();
 await expect(picker.getByRole('button',{name:'常聽',exact:true})).toHaveAttribute('aria-pressed','true');
 await picker.getByRole('button',{name:'關閉喜歡程度',exact:true}).click();
 await expect(page.getByRole('button',{name:'調整喜歡程度：'+name,exact:true})).toContainText('常聽');expect(writes).toBe(0);
 await page.getByRole('button',{name:'調整喜歡程度：'+name,exact:true}).click();await chooseMusicLevel(page,'本命');
 await page.getByRole('button',{name:'保存詞條變動',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();expect(writes).toBe(1);
 const session=await(await context.request.get('/api/v2/session')).json();const saved=await(await context.request.get('/api/v2/me/music',{headers:{'X-Account-Scope':session.scope}})).json();expect(saved.selections).toEqual([{entryId:id,level:4}]);
 await page.reload();await expect(page.getByRole('button',{name:'調整喜歡程度：'+name,exact:true})).toContainText('本命');
 await page.getByRole('button',{name:'調整喜歡程度：'+name,exact:true}).click();await picker.getByRole('button',{name:'從已選中移除',exact:true}).click();await expect(page.getByRole('button',{name:'選取'+name,exact:true})).toBeVisible();expect(writes).toBe(1);
});

test('quick-add prompts for both domains and sub terms',async({page,context})=>{
 await login(context);await page.goto('/me/music');
 for(const [name,level] of [['J-POP','本命'],['Aimer','聽過一些']] as const){
  await page.locator('.quick-add input').fill(name);await page.locator('.quick-add-results').getByRole('button').filter({hasText:name}).click();
  await expect(page.getByRole('dialog',{name:'「'+name+'」的喜歡程度',exact:true})).toBeVisible();await chooseMusicLevel(page,level);
  await expectMusicTerm(page,name);await expect(page.getByLabel(name+'喜歡程度')).toContainText(level);
 }
 expect((await durableRows(page)).filter(row=>row.key.includes('music:v1:'))).toHaveLength(1);
});

for(const [name,id] of [['J-POP','main-0'],['Aimer','sub-2']] as const)for(const width of [390,1440])for(const direct of [false,true])test(`nested ${name} ${direct?'direct':'inline'} details remain open after changing, Escape and removal at ${width}px`,async({page,context})=>{
 const path=direct?'/music/entries/'+id+'?q='+encodeURIComponent(name):'/music?entry='+id+'&q='+encodeURIComponent(name);
 await login(context);await page.setViewportSize({width,height:900});await page.goto(path);
 const parent=page.getByRole('dialog',{name,exact:true});await parent.getByRole('button',{name:'選取此詞條',exact:true}).click();const picker=page.locator('.music-level-dialog');await expect(picker).toBeVisible();
 await expect(picker).toHaveCSS('position','fixed');const box=await picker.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);expect(box!.height).toBeLessThan(700);expect(box!.width).toBeLessThanOrEqual(420);
 await chooseMusicLevel(page,'只聽過幾首');await expect(parent).toBeVisible();await expect(page).toHaveURL(path);
 await parent.getByRole('button',{name:'調整喜歡程度',exact:true}).click();await expect(picker).toBeVisible();await expect(picker.getByRole('button',{name:'關閉喜歡程度',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(picker).toHaveCount(0);await expect(parent).toBeVisible();
 await expect(parent.getByRole('button',{name:'調整喜歡程度',exact:true})).toBeFocused();
 await parent.getByRole('button',{name:'調整喜歡程度',exact:true}).click();await picker.getByRole('button',{name:'從已選中移除',exact:true}).click();await expect(parent.getByRole('button',{name:'選取此詞條',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'詞條變動保存',exact:true})).toHaveCount(0);
});

test('storage failure keeps the choice visible with its cause and never writes to the API',async({page,context})=>{
 await login(context);await page.goto('/music?q=Aimer');await denyDraftWrites(page,'music:v1:');let writes=0;page.on('request',r=>{if(r.method()==='PUT')writes++;});
 await page.getByRole('button',{name:'選取Aimer',exact:true}).click();const picker=page.locator('.music-level-dialog');await expect(picker.getByRole('alert')).toContainText('無法保存');
 await picker.getByRole('button',{name:'關閉喜歡程度',exact:true}).click();await expect(page.getByRole('region',{name:'詞條變動保存',exact:true})).toContainText('本機草稿保存失敗');expect(writes).toBe(0);
});

test('member cards copy an individual term through floating feedback without changing layout',async({page,context})=>{
 await login(context);await context.grantPermissions(['clipboard-read','clipboard-write']);await page.goto('/me/music');await toggleMusicTerm(page,'J-POP');await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
 await page.goto('/music/entries/sub-2');await page.locator('.entry-selector-list').getByRole('link',{name:'舊成分 10001',exact:true}).click();await page.locator('.profile-all-picks .disclosure-trigger').click();
 const row=page.locator('.profile-all-picks li').filter({has:page.getByRole('link',{name:'Aimer',exact:true})});const before=await row.boundingBox();await row.getByRole('button',{name:'複製詞條',exact:true}).click();
 await expect(page.getByText('已複製詞條。',{exact:true})).toBeVisible();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('Aimer');const after=await row.boundingBox();expect(after!.y).toBe(before!.y);await expect(page.locator('.person-profile .feedback-layer')).toHaveCSS('position','absolute');
});

 test.describe('recommendation term shortcuts',()=>{
  test.use({musicMatches:true});
  test('domain recommendation shortcuts open the picker for existing and newly added choices',async({page,context})=>{
   await login(context);await page.goto('/people');const card=page.getByRole('region',{name:'推薦名單',exact:true}).locator('.match-card').first();
   await card.getByRole('button',{name:'調整喜歡程度：J-POP',exact:true}).click();const picker=page.getByRole('dialog',{name:'「J-POP」的喜歡程度',exact:true});await expect(picker).toBeVisible();
   await picker.getByRole('button',{name:'從已選中移除',exact:true}).click();await card.getByRole('button',{name:'選取J-POP',exact:true}).click();await expect(picker).toBeVisible();await chooseMusicLevel(page,'本命');
   await expect(page).toHaveURL('/people');await expect(card.getByRole('button',{name:'調整喜歡程度：J-POP',exact:true})).toHaveAttribute('aria-pressed','true');
   await page.goto('/me/music');await expect(page.getByLabel('J-POP喜歡程度',{exact:true})).toContainText('本命');
  });
  test('shared and other-only terms edit the same draft without leaving the recommendation',async({page,context})=>{
   await login(context);await page.goto('/people?sort=familiar');let writes=0;page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/me/music'))writes++;});
   const card=page.getByRole('region',{name:'推薦名單',exact:true}).locator('.match-card').first();
   await card.getByRole('button',{name:'調整喜歡程度：YOASOBI',exact:true}).click();await chooseMusicLevel(page,'只聽過幾首');
   await card.getByText('更多成分資料',{exact:true}).click();await card.getByText('對方獨有 · 2 項',{exact:true}).click();
   await card.getByRole('button',{name:'選取宇多田光',exact:true}).click();await chooseMusicLevel(page,'聽過一些');
   await expect(card.getByRole('button',{name:'調整喜歡程度：宇多田光',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page).toHaveURL('/people?sort=familiar');expect(writes).toBe(0);
   await page.goto('/me/music');await expect(page.getByLabel('YOASOBI喜歡程度',{exact:true})).toContainText('只聽過幾首');await expect(page.getByLabel('宇多田光喜歡程度',{exact:true})).toContainText('聽過一些');
  });
 });

for(const language of ['zh-CN','en-US'])test(`picker follows ${language} without converting term names`,async({page,context})=>{
 await context.route(origin+'/**',route=>route.continue({headers:{...route.request().headers(),'accept-language':language}}));await login(context);await page.goto('/music?q=米津玄師');const simple=language==='zh-CN';
 await page.getByRole('button',{name:(simple?'选取':'選取')+'米津玄師',exact:true}).click();const picker=page.getByRole('dialog',{name:'「米津玄師」的'+(simple?'喜欢程度':'喜歡程度'),exact:true});await expect(picker).toBeVisible();
 for(const name of simple?['本命','常听','听过一些','只听过几首']:['本命','常聽','聽過一些','只聽過幾首'])await expect(picker.getByRole('button',{name,exact:true})).toBeVisible();await chooseMusicLevel(page,'聽過一些');
 await expect(page.getByRole('button',{name:(simple?'调整喜欢程度：':'調整喜歡程度：')+'米津玄師',exact:true})).toContainText(simple?'听过一些':'聽過一些');
});
