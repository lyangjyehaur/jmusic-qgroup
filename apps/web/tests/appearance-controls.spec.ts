import {test,expect} from './fixtures';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
test.use({inboxExamples:true,musicMatches:true});

for(const width of [320,749,1440]) test(`appearance choices stay visible and keyboard accessible at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:932});await page.goto('/inbox');
 const trigger=page.getByRole('button',{name:'外觀設定',exact:true});
 expect(await trigger.evaluate(el=>getComputedStyle(el).color)).toBe(await page.locator('.inbox-button').evaluate(el=>getComputedStyle(el).color));
 await trigger.click();const menu=page.locator('.menu-popover[data-open]');
 await expect(menu.getByRole('heading',{name:'外觀設定',exact:true})).toBeVisible();
 await expect(menu.locator('h2')).toHaveCSS('border-bottom-width','0px');
 const presets=menu.getByRole('group',{name:'快速主題色',exact:true});
 await expect(presets.getByRole('radio')).toHaveCount(4);await expect(presets.getByRole('radio',{name:'粉色',exact:true})).toBeChecked();
 for(const option of await presets.locator('label').all())expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 await presets.getByRole('radio',{name:'淺藍',exact:true}).check();await expect(page.locator('html')).toHaveAttribute('data-preset','blue');
 const modes=menu.getByRole('group',{name:'快速明暗模式',exact:true});
 await modes.getByRole('radio',{name:'深色',exact:true}).check();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await modes.getByRole('radio',{name:'深色',exact:true}).focus();await page.keyboard.press('ArrowLeft');
 await expect(modes.getByRole('radio',{name:'淺色',exact:true})).toBeChecked();await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await menu.getByRole('group',{name:'快速資訊密度',exact:true}).getByRole('radio',{name:'緊湊',exact:true}).check();
 await expect(page.locator('html')).toHaveAttribute('data-density','compact');
 expect(await menu.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await page.getByRole('button',{name:'帳號選單',exact:true}).click();await expect(menu.getByRole('heading',{name:'訪客',exact:true})).toBeVisible();await expect(menu.locator('h2')).toHaveCSS('border-bottom-width','0px');
 await menu.getByRole('link',{name:'帳號與設定',exact:true}).click();await expect(menu).toHaveCount(0);
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-preset','blue');await expect(page.locator('html')).toHaveAttribute('data-density','compact');
});

for(const width of [430,1440]) test(`compact density reduces real content spacing and retains touch targets at ${width}px`,async({page,context})=>{
 await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin}]);await page.setViewportSize({width,height:932});
 const samples:Record<string,number[]>={};
 for(const density of ['comfortable','compact']){
  await page.goto('/activities');await page.getByRole('button',{name:'外觀設定',exact:true}).click();
  await page.getByRole('group',{name:'快速資訊密度',exact:true}).getByRole('radio',{name:density==='compact'?'緊湊':'舒適',exact:true}).check();await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-density',density);
  for(const [path,selector,key] of [['/activities','.activity-row','activities'],['/music','.term-row','music'],['/inbox','.notification-item','inbox'],['/people','.person-card','people']] as const){
   await page.goto(path);await expect(page.locator(selector).first()).toBeVisible();
   const padding=await page.locator(selector).first().evaluate(el=>parseFloat(getComputedStyle(el).paddingTop)+parseFloat(getComputedStyle(el).paddingBottom));
   (samples[key]??=[]).push(padding);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }
 for(const [key,values] of Object.entries(samples)){expect(values).toHaveLength(2);expect(values[1]!,key+' spacing').toBeLessThan(values[0]!);}
 await page.goto('/music');for(const control of await page.locator('.term-row').first().locator(':scope > .button').all())expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
