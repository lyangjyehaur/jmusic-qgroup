import { test, expect } from './fixtures';
import { chooseOption } from './kimi-controls';
import { denyDraftWrites } from './draft-helpers';
import type { Page } from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;

async function startLayoutAudit(page:Page,selectors=['h1','.term-row']){
  for(const selector of selectors)await expect(page.locator(selector).first()).toBeVisible();
  await page.evaluate(selectors=>{
    const elements=selectors.map(selector=>document.querySelector(selector)!);
    const audit={positions:[] as number[][],stop:false};(window as any).__feedbackLayoutAudit=audit;
    const frame=()=>{audit.positions.push(elements.map(el=>el.getBoundingClientRect().top+scrollY));if(!audit.stop)requestAnimationFrame(frame);};frame();
  },selectors);
}
async function expectStableLayout(page:Page){
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const audit=await page.evaluate(()=>{const audit=(window as any).__feedbackLayoutAudit;audit.stop=true;return audit;});
  expect(audit.positions.length).toBeGreaterThan(1);
  for(let column=0;column<audit.positions[0].length;column++){
    const values=audit.positions.map((p:number[])=>p[column]);expect(Math.max(...values)-Math.min(...values)).toBeLessThanOrEqual(1);
  }
}

for(const width of [1440,390])test(`selection, send, success expiry, restore and offline feedback never move the catalog at ${width}px`,async({page,context})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:900});await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin}]);
  await page.goto('/music?q=Aimer&library=all');await expect(page.locator('.term-row')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'選取Aimer',exact:true})).toBeEnabled();
  await startLayoutAudit(page);
  await page.getByRole('button',{name:'選取Aimer',exact:true}).click();
  const dock=page.getByRole('region',{name:'詞條變動保存',exact:true});await expect(dock).toBeVisible();
  let release!:()=>void,arrive!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),arrived=new Promise<void>(resolve=>{arrive=resolve;});
  await page.route('**/api/v2/me/music',async route=>{
    if(route.request().method()!=='PUT')return route.continue();const response=await route.fetch();arrive();await gate;await route.fulfill({response});
  });
  await dock.getByRole('button',{name:'保存詞條變動',exact:true}).click();await arrived;
  await expect(dock).toHaveAttribute('aria-busy','true');release();
  await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
  await expect(page.locator('.feedback-layer')).toHaveCSS('position','fixed');
  await expect(dock).toHaveCount(0);await expect(page.locator('.catalog-draft-summary')).toHaveCount(0);
  await expect(page.getByText('已保存。',{exact:true})).toHaveCount(0,{timeout:6500});
  await context.setOffline(true);await expect(page.getByText('目前已離線；資料讀取與提交需要網路。未確認的操作請連線後明確核對。',{exact:true})).toBeVisible();
  await expect(page.locator('.app-status-notices')).toHaveCSS('position','fixed');await context.setOffline(false);
  await expect(page.getByText('目前已離線；資料讀取與提交需要網路。未確認的操作請連線後明確核對。',{exact:true})).toHaveCount(0);
  await expectStableLayout(page);
  await page.getByRole('button',{name:'取消選取Aimer',exact:true}).click();
  page.on('dialog',dialog=>void dialog.accept());await page.reload();
  const restore=page.getByRole('button',{name:'恢復本機原稿',exact:true});await expect(restore).toBeVisible();
  await startLayoutAudit(page);await restore.click();await expect(restore).toHaveCount(0);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expectStableLayout(page);await expect(dock).toBeVisible();
  expect(errors).toEqual([]);
});

for(const width of [1440,390])test(`unsaved term choices keep one reachable save dock across pages and dialogs at ${width}px`,async({page,context})=>{
  await page.setViewportSize({width,height:800});
  await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin}]);
  await page.goto('/music?library=all');
  await page.evaluate(()=>{
    const heading=document.querySelector('h1')!,first=document.querySelector('.term-row')!;
    const audit={positions:[] as number[][],progressInserted:false,stop:false};
    (window as any).__selectionLayoutAudit=audit;
    const observer=new MutationObserver(records=>{
      if(records.some(r=>[...r.addedNodes].some(node=>node.textContent?.includes('正在保存本機原稿'))))audit.progressInserted=true;
    });observer.observe(document.getElementById('main')!,{childList:true,subtree:true});
    const frame=()=>{audit.positions.push([heading.getBoundingClientRect().top,first.getBoundingClientRect().top]);if(!audit.stop)requestAnimationFrame(frame);else observer.disconnect();};requestAnimationFrame(frame);
  });
  const dock=page.getByRole('region',{name:'詞條變動保存',exact:true});
  await expect(dock).toHaveCount(0);
  await page.getByRole('button',{name:'選取J-POP',exact:true}).click();
  await expect(page.getByText('正在保存本機原稿…',{exact:true})).toHaveCount(0);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const audit=await page.evaluate(()=>{const audit=(window as any).__selectionLayoutAudit;audit.stop=true;return audit;});
  expect(audit.progressInserted).toBe(false);
  for(const column of [0,1]){const positions=audit.positions.map((p:number[])=>p[column]);expect(Math.max(...positions)-Math.min(...positions)).toBeLessThanOrEqual(1);}
  await dock.getByRole('button',{name:'保存詞條變動',exact:true}).click();
  await expect(dock).toHaveCount(0);await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
  const writes:string[]=[];page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/me/music'))writes.push(r.postData()!);});
  await page.getByRole('button',{name:'選取Aimer',exact:true}).click();
  await expect(dock).toBeVisible();await expect(dock).toHaveCSS('position','fixed');
  await page.getByRole('button',{name:'取消選取Aimer',exact:true}).click();await expect(dock).toHaveCount(0);
  await page.getByRole('button',{name:'選取Aimer',exact:true}).click();
  await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await expect(dock).toBeInViewport();
  const box=await dock.boundingBox();expect(box!.y).toBeGreaterThan(0);
  if(width<769){
    const nav=await page.locator('.mobile-dock').boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual(nav!.y);
    const top=page.getByRole('button',{name:'回到頂部',exact:true});await expect(top).toBeInViewport();
    const topBox=await top.boundingBox();expect(topBox!.y+topBox!.height).toBeLessThanOrEqual(box!.y);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:`test-results/music-save-dock-${width}.png`});
  await page.getByRole('link',{name:'同好',exact:true}).click();await expect(dock).toBeVisible();expect(writes).toEqual([]);
  await page.getByRole('link',{name:'全站搜尋',exact:true}).click();
  let dialog=page.getByRole('dialog');await expect(dialog.locator('.music-save-dock')).toBeInViewport();await expect(dock).toHaveCount(1);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(dock).toBeVisible();
  await page.getByRole('link',{name:'音樂',exact:true}).click();await page.getByRole('link',{name:'查看 Aimer',exact:true}).click();
  dialog=page.getByRole('dialog');await expect(dialog.locator('.music-entry-detail')).toBeVisible();
  await chooseOption(page,'Aimer喜歡程度','1');
  await dialog.locator('[class*="dialogBody"]').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect(dialog.locator('.music-save-dock')).toBeInViewport();await expect(dock).toHaveCount(1);
  const footer=dialog.locator('[class*="dialogFooter"]');
  expect(await footer.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(false);
  expect((await dock.boundingBox())!.height).toBeLessThan(150);
  await expect(footer.getByRole('button',{name:'返回詞庫',exact:true})).toBeInViewport();
  await expect(footer.getByRole('link',{name:'編輯我的成分',exact:true})).toBeInViewport();
  await page.screenshot({path:`test-results/music-save-dock-dialog-${width}.png`});
  await dock.getByRole('button',{name:'保存詞條變動',exact:true}).click();
  await expect(dock).toHaveCount(0);await expect(dialog.getByText('已保存。',{exact:true})).toBeVisible();
  expect(writes).toHaveLength(1);
  const session=await(await context.request.get('/api/v2/session')).json();
  const saved=await(await context.request.get('/api/v2/me/music',{headers:{'X-Account-Scope':session.scope}})).json();
  expect(saved.selections).toEqual([{entryId:'main-0',level:3},{entryId:'sub-2',level:1}]);
});

test('local draft write failure retains the floating reminder without sending choices',async({page,context})=>{
  await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin}]);
  await page.setViewportSize({width:390,height:800});await page.goto('/music?library=all');
  await page.getByRole('button',{name:'選取Aimer',exact:true}).click();await denyDraftWrites(page,'music:v1:');
  let writes=0;page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/me/music'))writes++;});
  const dock=page.getByRole('region',{name:'詞條變動保存',exact:true});
  await startLayoutAudit(page);
  await dock.getByRole('button',{name:'保存詞條變動',exact:true}).click();
  await expect(page.getByText('無法保存原稿及操作編號，尚未送出。',{exact:true})).toBeVisible();
  await expect(dock).toBeInViewport();await expect(dock).toContainText('有未保存的詞條變動');expect(writes).toBe(0);
  await expect(page.locator('.feedback-layer')).toHaveCSS('position','fixed');await expectStableLayout(page);
});

test('lost save response keeps the dock visible and retries the original operation safely',async({page,context})=>{
  await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin}]);
  await page.addInitScript(()=>localStorage.setItem('qgroup:appearance:v1',JSON.stringify({theme:'dark',preset:'pink',density:'comfortable',wallpapers:false})));
  await page.goto('/music?entry=sub-0');await page.getByRole('button',{name:'選取此詞條',exact:true}).click();
  const keys:string[]=[],bodies:string[]=[];
  await page.route('**/api/v2/me/music',async route=>{
    if(route.request().method()!=='PUT')return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);
    const response=await route.fetch();await route.fulfill({response,...(keys.length===1?{body:'{'}:{})});
  });
  const dock=page.getByRole('region',{name:'詞條變動保存',exact:true});
  await startLayoutAudit(page,['[role=dialog] [class*="dialogTitle"]','[role=dialog] .music-entry-detail']);
  await dock.getByRole('button',{name:'保存詞條變動',exact:true}).click();
  await expect(dock.getByText('保存結果待確認',{exact:true})).toBeVisible();await expect(dock).toBeInViewport();
  await expect(page.getByRole('button',{name:'取消選取',exact:true})).toBeDisabled();
  await dock.getByRole('button',{name:'確認詞條保存結果',exact:true}).click();
  await expect(dock).toHaveCount(0);await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toBe(bodies[1]);
  await expectStableLayout(page);
});
