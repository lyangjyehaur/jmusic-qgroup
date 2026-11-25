import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
// Usage: node tools/rebuild/check-kimi-extended.mjs <fixture URL> <output directory>
const [base,dir]=process.argv.slice(2);if(!dir)throw Error('Provide fixture URL and output directory');await mkdir(dir,{recursive:true});
const browser=await chromium.launch({channel:'chrome'}),results=[];
for(const width of [1440,390])for(const preset of ['pink','gunju','blue','yellow'])for(const [theme,density]of [['dark','comfortable'],['light','compact']])for(const [name,path]of [['activities','/activities'],['new','/activities/new'],['editor','/me/music'],['appearance','/me/appearance'],['person','/people/m_000000000000000000000002'],['share','/me/music/share']]){
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:base}]);await context.addInitScript(prefs=>localStorage.setItem('qgroup:appearance:v1',JSON.stringify(prefs)),{theme,density,preset,wallpapers:false});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+path);await page.waitForLoadState('networkidle');await page.locator('h1,[role=dialog]').first().waitFor();
 const result={width,preset,theme,density,name,errors,...await page.evaluate(()=>{const dialog=document.querySelector('[role=dialog]'),s=getComputedStyle(dialog??document.querySelector('.kimi.page'));return {overflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:!!dialog&&dialog.scrollWidth>dialog.clientWidth,color:s.color,background:s.backgroundColor,theme:document.documentElement.dataset.theme,density:document.documentElement.dataset.density}})};results.push(result);
 if(preset==='pink')await page.screenshot({path:dir+'/'+name+'-'+width+'-'+theme+'-'+density+'.png',fullPage:true});await context.close();await new Promise(resolve=>setTimeout(resolve,1000));
}
await browser.close();const failures=results.filter(x=>x.overflow||x.dialogOverflow||x.errors.length);await writeFile(dir+'/results.json',JSON.stringify({states:results.length,failures,results},null,2));console.log(JSON.stringify({states:results.length,failures}));if(failures.length)process.exitCode=1;
