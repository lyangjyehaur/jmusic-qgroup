import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const local='http://127.0.0.1:5082',production='https://kanban.danndann.cn',tracker='https://u.danndann.cn';
async function records(page:Page){return page.evaluate(()=>(window as unknown as {analyticsRecords:Record<string,unknown>[]}).analyticsRecords);}
async function isolatedProduction(context:BrowserContext,mode='ready'){
  await context.addInitScript(()=>{(window as unknown as {analyticsRecords:unknown[]}).analyticsRecords=[];});
  let release!:()=>void,seen!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),intercepted=new Promise<void>(resolve=>{seen=resolve;});
  const wireRecords:{type:string;payload:Record<string,unknown>}[]=[];
  const client=mode==='actual'?readFileSync(process.env.REBUILD_UMAMI_CLIENT!,'utf8'):'';
  if(client&&createHash('sha256').update(client).digest('hex')!=='1ad1145d19d4558c20f5469ca4a5fc50a1a46f860858c9c91bfcd56fd29a522a')throw Error('The supplied public client differs from the recorded verification source');
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===tracker){seen();if(mode==='actual'&&url.pathname==='/api/send'){wireRecords.push(request.postDataJSON());await route.fulfill({json:{}});return;}if(mode==='actual'){await route.fulfill({contentType:'application/javascript',body:client});return;}if(mode==='blocked'){await route.abort();return;}if(mode==='delay')await gate;
      await route.fulfill({contentType:'application/javascript',body:`window.umami={track:function(render){${mode==='throw'?'throw new Error("synthetic tracker denial");':'window.analyticsRecords.push(render({url:location.href,title:document.title,referrer:"SECRET_REFERRER",token:"SECRET_IDENTITY"}));return Promise.resolve();'}}};`});return;
    }
    if(url.origin!==production){await route.abort();return;}
    const headers={...request.headers()};delete headers.host;if(headers.origin)headers.origin=local;
    const response=await route.fetch({url:local+url.pathname+url.search,headers});
    const resultHeaders=response.headers();if(resultHeaders['content-security-policy'])resultHeaders['content-security-policy']=resultHeaders['content-security-policy'].replace("script-src 'self'","script-src 'self' "+tracker).replace("connect-src 'self'","connect-src 'self' "+tracker);
    await route.fulfill({response,headers:resultHeaders});
  });
  return {release,intercepted,wireRecords};
}
test('local development never loads the tracker or sends analytics while all controls remain usable',async({page})=>{
  const requests:string[]=[];page.on('request',r=>{if(r.url().includes('u.danndann.cn'))requests.push(r.url());});
  await page.goto('/activities/listen/share');await page.getByRole('button',{name:'複製活動摘要',exact:true}).click();await expect(page.getByLabel('活動摘要',{exact:true})).toBeVisible();expect(requests).toEqual([]);expect(await page.locator('#qgroup-analytics').count()).toBe(0);
});
test('production-shaped fixture records virtual pages and interactions while removing names, IDs, paths and tracker defaults',async({page,context})=>{
  await isolatedProduction(context);await page.goto(production+'/activities/listen/share?invite=SECRET_INVITE#SECRET_HASH');
  await expect.poll(async()=>records(page)).not.toEqual([]);const script=page.locator('#qgroup-analytics');await expect(script).toHaveAttribute('data-auto-track','false');await expect(script).toHaveAttribute('data-exclude-search','true');await expect(script).toHaveAttribute('data-exclude-hash','true');
  await page.evaluate(()=>{document.title='PRIVATE_TITLE';const button=document.createElement('button');button.id='PRIVATE_PERSON';button.setAttribute('name','SECRET_TOKEN');button.textContent='PRIVATE_NAME 12345';document.querySelector('main')!.append(button);button.click();});
  await page.getByRole('link',{name:'回到活動',exact:true}).click();await expect(page.getByRole('heading',{name:'週末一起聽日系音樂',exact:true})).toBeVisible();
  const data=await records(page);expect(data.filter(row=>!row.name).map(row=>row.url)).toEqual(['/activities/:id/share','/activities/:id']);expect(data.some(row=>row.name==='ui_click')).toBe(true);expect(JSON.stringify(data)).not.toMatch(/PRIVATE|SECRET|12345|listen/);
});
test('native field edits and write success send only fixed operation metadata',async({page,context})=>{
  await isolatedProduction(context);await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:production,httpOnly:true,sameSite:'Lax',secure:true}]);
  await page.goto(production+'/me/profile');await page.getByLabel('站內稱呼',{exact:true}).fill('PRIVATE_NAME');await expect.poll(async()=>(await records(page)).some(row=>row.name==='ui_input')).toBe(true);
  await page.getByRole('button',{name:'保存稱呼',exact:true}).click();await expect.poll(async()=>(await records(page)).some(row=>row.name==='api_result'&&(row.data as {outcome:string}).outcome==='success')).toBe(true);
  const data=await records(page);expect(JSON.stringify(data)).not.toMatch(/PRIVATE|SECRET|fixture-alice/);expect(data.filter(row=>row.name==='api_result').every(row=>(row.data as {operation:string}).operation==='/api/v2/me/profile')).toBe(true);
});
for(const outcome of ['rejected','parse_error','network_error'])test('native write '+outcome+' preserves the user result and reports no private input',async({page,context})=>{
  await isolatedProduction(context);await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:production,httpOnly:true,sameSite:'Lax',secure:true}]);
  await page.route(production+'/api/v2/me/profile',async route=>{
    if(route.request().method()!=='PUT'){await route.fallback();return;}
    if(outcome==='network_error')await route.abort();
    else if(outcome==='parse_error')await route.fulfill({status:200,contentType:'application/json',body:'{'});
    else await route.fulfill({status:409,json:{code:'REVISION_CONFLICT',message:'合成拒絕 PRIVATE_REASON'}});
  });
  await page.goto(production+'/me/profile');await page.getByLabel('站內稱呼',{exact:true}).fill('PRIVATE_NAME');await page.getByRole('button',{name:'保存稱呼',exact:true}).click();
  await expect.poll(async()=>(await records(page)).some(row=>row.name==='api_result'&&(row.data as {outcome:string}).outcome===outcome)).toBe(true);
  const data=await records(page);expect(JSON.stringify(data)).not.toMatch(/PRIVATE|SECRET|fixture-alice/);expect(data.filter(row=>row.name==='api_result').every(row=>(row.data as {operation:string}).operation==='/api/v2/me/profile')).toBe(true);await expect(page.getByLabel('站內稱呼',{exact:true})).toHaveValue('PRIVATE_NAME');
});
test('delayed tracker buffering is bounded without retaining private labels',async({page,context})=>{
  const slow=await isolatedProduction(context,'delay');
  try {
    await page.goto(production+'/activities');await slow.intercepted;await expect(page.getByRole('heading',{name:'活動',exact:true})).toBeVisible();
    await page.evaluate(()=>{const button=document.createElement('button');button.textContent='PRIVATE_LABEL';document.querySelector('main')!.append(button);for(let n=0;n<120;n++)button.click();});slow.release();await expect.poll(async()=>(await records(page)).length).toBe(100);expect(JSON.stringify(await records(page))).not.toContain('PRIVATE');
  } finally { slow.release(); }
});
for(const mode of ['blocked','throw'])test(mode+' trackers do not prevent activity navigation or summary copying',async({page,context})=>{
  await isolatedProduction(context,mode);await page.goto(production+'/activities/listen/share');await page.getByRole('button',{name:'複製活動摘要',exact:true}).click();await expect(page.getByLabel('活動摘要',{exact:true})).toBeVisible();await page.getByRole('link',{name:'回到活動',exact:true}).click();await expect(page.getByRole('heading',{name:'週末一起聽日系音樂',exact:true})).toBeVisible();
});
test('a script insertion failure cleans up tracking and leaves the React application usable',async({page,context})=>{
  await isolatedProduction(context);await page.addInitScript(()=>{const original=Element.prototype.append;Element.prototype.append=function(...nodes){if(nodes.some(node=>node instanceof HTMLScriptElement&&node.src.startsWith('https://u.danndann.cn/')))throw Error('Synthetic script blocker');return original.apply(this,nodes);};});
  await page.goto(production+'/activities/listen/share');await expect(page.getByLabel('活動摘要',{exact:true})).toBeVisible();await page.getByRole('button',{name:'複製活動摘要',exact:true}).click();expect(await records(page)).toEqual([]);await expect(page.locator('#qgroup-analytics')).toHaveCount(0);
});
test('form validation, choices, disclosure and dialog events omit all field values and sensitive edits',async({page,context})=>{
  await isolatedProduction(context);await page.goto(production+'/activities');await expect.poll(async()=>records(page)).not.toEqual([]);
  await page.evaluate(async()=>{
    const form=document.createElement('form');form.addEventListener('submit',event=>event.preventDefault());
    form.innerHTML='<input required name="PRIVATE_FIELD"><input type="password" name="PRIVATE_PASSWORD"><input type="hidden" name="PRIVATE_TOKEN"><input type="checkbox" name="PRIVATE_CHOICE" value="SECRET_VALUE"><button>PRIVATE_SUBMIT</button>';
    document.querySelector('main')!.append(form);const fields=form.querySelectorAll('input');
    for(const field of fields){field.value='SECRET_INPUT';field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
    fields[0]!.value='';form.requestSubmit();fields[0]!.value='SECRET_INPUT';fields[3]!.checked=true;fields[3]!.dispatchEvent(new Event('change',{bubbles:true}));form.requestSubmit();
    const details=document.createElement('details');details.innerHTML='<summary>PRIVATE_SUMMARY</summary>SECRET_CONTENT';document.querySelector('main')!.append(details);details.open=true;await new Promise(resolve=>setTimeout(resolve,20));details.open=false;await new Promise(resolve=>setTimeout(resolve,20));
    const dialog=document.createElement('dialog');dialog.textContent='PRIVATE_DIALOG';document.querySelector('main')!.append(dialog);dialog.showModal();await new Promise(resolve=>setTimeout(resolve,20));dialog.dispatchEvent(new Event('cancel'));dialog.close();
    await new Promise(resolve=>setTimeout(resolve,1100));
  });
  const data=await records(page),names=data.map(row=>row.name);
  for(const name of ['ui_invalid','ui_change','ui_submit','ui_expand','ui_collapse','dialog_open','dialog_close','dialog_cancel'])expect(names).toContain(name);
  expect(data.some(row=>row.name==='ui_change'&&(row.data as {checked?:boolean}).checked===true)).toBe(true);
  expect(data.filter(row=>['ui_input','ui_change','ui_invalid'].includes(String(row.name))).every(row=>(row.data as {control:string}).control==='field:text'||(row.data as {control:string}).control==='field:checkbox')).toBe(true);
  expect(JSON.stringify(data)).not.toMatch(/PRIVATE|SECRET|password|hidden/);
});
if(process.env.REBUILD_UMAMI_CLIENT)test('the recorded public Umami client sends only sanitized event payloads through an intercepted transport',async({page,context})=>{
  const {wireRecords}=await isolatedProduction(context,'actual');await page.goto(production+'/activities/listen/share?invite=SECRET_INVITE#SECRET_HASH');await expect.poll(()=>wireRecords.length).toBe(1);
  await page.evaluate(()=>{document.title='PRIVATE_TITLE';});await page.getByRole('button',{name:'複製活動摘要',exact:true}).click();await page.getByRole('link',{name:'回到活動',exact:true}).click();await expect.poll(()=>wireRecords.filter(row=>!row.payload.name).length).toBe(2);
  expect(wireRecords.every(row=>row.type==='event')).toBe(true);expect(wireRecords.filter(row=>!row.payload.name).map(row=>row.payload.url)).toEqual(['/activities/:id/share','/activities/:id']);expect(JSON.stringify(wireRecords)).not.toMatch(/PRIVATE|SECRET|listen|identify/);
});
