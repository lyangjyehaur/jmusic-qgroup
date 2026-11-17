import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { denyDraftWrites, durableRows } from './draft-helpers';
const origin='http://127.0.0.1:5082';
async function login(context:BrowserContext,id='alice'){await context.addCookies([{name:'kanban_session',value:'fixture-'+id,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function headers(context:BrowserContext){const viewer=await(await context.request.get('/api/v2/session')).json();return {Origin:origin,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':crypto.randomUUID()};}
async function published(context:BrowserContext){
  await login(context);const result=await(await context.request.post('/api/v2/activities/drafts',{headers:await headers(context),data:{values:{title:'舊邀請連結驗收',category:'约K',location:'私人測試地點',startsAt:'2099-12-12T18:00:00+08:00',deadline:'2099-12-11T18:00:00+08:00',capacity:5,visibility:'invitation',feePolicy:'原費用規則'}}})).json();
  expect((await context.request.post('/api/v2/activities/'+result.id+'/draft/publish',{headers:await headers(context),data:{revision:result.revision,confirm:true,acceptConditions:true}})).status()).toBe(200);
  const share=await(await context.request.get('/api/v2/activities/'+result.id+'/share',{headers:await headers(context)})).json();return {id:result.id as string,token:share.path.split('/').at(-1) as string};
}
test('old private links preserve login return and grant only view access after explicit consent',async({page,context})=>{
  const {id,token}=await published(context);await context.clearCookies();let grants=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/access/'))grants++;});
  await page.goto('/index.html?event='+id+'&invite='+token);await expect(page).toHaveURL('/activities/'+id+'/access/'+token);
  const link=page.getByRole('link',{name:'登入',exact:true});await expect(link).toBeVisible();expect(await link.getAttribute('href')).toContain(encodeURIComponent('/activities/'+id+'/access/'+token));await login(context,'bob');await page.reload();
  await expect(page.getByRole('heading',{name:'舊邀請連結驗收',exact:true})).toBeVisible();expect(grants).toBe(0);expect((await context.request.get('/api/v2/activities/'+id,{headers:await headers(context)})).status()).toBe(404);
  await expect(page.getByRole('button',{name:'接受查看邀請',exact:true})).toBeDisabled();await page.getByLabel('確認接受活動查看邀請',{exact:true}).check();await page.getByRole('button',{name:'接受查看邀請',exact:true}).click();await expect(page.getByText('已取得活動查看權限。',{exact:true})).toBeVisible();expect(grants).toBe(1);
  const event=await(await context.request.get('/api/v2/activities/'+id,{headers:await headers(context)})).json();expect(event.confirmed).toBe(1);const registration=await(await context.request.get('/api/v2/activities/'+id+'/registration',{headers:await headers(context)})).json();expect(registration.selfRegistered).toBe(false);
  await page.getByRole('link',{name:'查看活動',exact:true}).click();await expect(page.getByRole('heading',{name:'舊邀請連結驗收',exact:true})).toBeVisible();
});
test('an unknown access result survives reload and replays the same operation once',async({page,context})=>{
  const {id,token}=await published(context);await login(context,'bob');const keys:string[]=[],bodies:unknown[]=[];let first=true;
  await page.route('**/api/v2/activities/'+id+'/access/'+token+'/accept',async route=>{keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postDataJSON());const response=await route.fetch();await route.fulfill({response,...(first?{body:'{'}:{})});first=false;});
  await page.goto('/?event='+id+'&invite='+token);await page.getByLabel('確認接受活動查看邀請',{exact:true}).check();await page.getByRole('button',{name:'接受查看邀請',exact:true}).click();await expect(page.getByRole('button',{name:'確認原邀請操作結果',exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'確認原邀請操作結果',exact:true}).click();await expect(page.getByText('已取得活動查看權限。',{exact:true})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toEqual(bodies[1]);
});
test('bot party and tentative links preset forms and never replace an existing signup draft or submit',async({page,context})=>{
  await login(context,'bob');page.on('dialog',dialog=>void dialog.accept());let writes=0;page.on('request',r=>{if(['POST','PUT','DELETE'].includes(r.method())&&r.url().includes('/activities/'))writes++;});
  await page.goto('/?event=listen&action=party');await expect(page).toHaveURL('/activities/listen/signup?preset=party');await expect(page.getByLabel('稱呼',{exact:true})).toBeVisible();await page.getByLabel('稱呼',{exact:true}).fill('保留的同行');
  await page.goto('/?event=listen&action=tentative');await expect(page).toHaveURL('/activities/listen/signup?preset=tentative');await expect(page.getByLabel('稱呼',{exact:true})).toHaveValue('保留的同行');
  await page.goto('/?event=karaoke&action=tentative');await expect(page.locator('#signup-intent')).toHaveValue('tentative');expect(writes).toBe(0);
});
test('bot report and onsite links open the intended controls without recording money or attendance',async({page,context})=>{
  await login(context);page.on('dialog',dialog=>void dialog.accept());let writes=0;page.on('request',r=>{if(['POST','PUT','DELETE'].includes(r.method())&&r.url().includes('/activities/'))writes++;});
  await page.goto('/?event=listen&action=report');await expect(page).toHaveURL('/activities/listen/finance?preset=report#finance-operation');await expect(page.locator('#finance-command')).toHaveValue('report');await expect(page.locator('.finance-operation-panel')).toHaveAttribute('open','');
  await page.goto('/?event=listen&action=onsite');await expect(page).toHaveURL('/activities/listen/attendance?preset=onsite');await expect(page.getByText('現場參加者 1',{exact:true})).toBeVisible();expect(writes).toBe(0);
});
test('copy starts an independent draft, clears dates and notification consent, and creates no roster',async({page,context})=>{
  await login(context);page.on('dialog',dialog=>void dialog.accept());let writes=0;page.on('request',r=>{if(['POST','PUT','DELETE'].includes(r.method())&&r.url().includes('/activities/'))writes++;});
  await page.goto('/activities/new');await page.getByLabel('活動名稱',{exact:true}).fill('原本的新活動草稿');await page.goto('/?event=listen&action=copy');await expect(page).toHaveURL('/activities/new?copyFrom=listen');await expect(page.getByLabel('活動名稱',{exact:true})).toHaveValue('週末一起聽日系音樂');
  await expect(page.getByLabel('開始時間（台北）',{exact:true})).toHaveValue('');await expect(page.getByLabel('報名截止（台北）',{exact:true})).toHaveValue('');await expect(page.getByLabel('發布後同步到 QQ 群',{exact:true})).not.toBeChecked();expect(writes).toBe(0);
  await page.getByLabel('活動名稱',{exact:true}).fill('獨立的再約草稿');await page.getByLabel('開始時間（台北）',{exact:true}).fill('2099-12-25T18:00:00');await page.getByLabel('報名截止（台北）',{exact:true}).fill('2099-12-24T18:00:00');await page.route('**/api/v2/activities/listen/copy-source',route=>route.abort());await page.reload();await expect(page.getByLabel('活動名稱',{exact:true})).toHaveValue('獨立的再約草稿');await page.getByRole('button',{name:'恢復本機原稿',exact:true}).click();await page.getByRole('button',{name:'建立活動草稿',exact:true}).click();await expect(page).toHaveURL(/\/activities\/[^/]+\/edit$/);const id=new URL(page.url()).pathname.split('/')[2]!;expect(id).not.toBe('listen');
  expect((await(await context.request.get('/api/v2/activities/'+id+'/draft',{headers:await headers(context)})).json()).values.botEnabled).toBe(false);await page.goto('/activities/new');await expect(page.getByLabel('活動名稱',{exact:true})).toHaveValue('原本的新活動草稿');
});
test('old music hashes and HTML aliases enter native pages; replace redirects preserve back navigation',async({page})=>{
  await page.goto('/contact');await expect(page.getByRole('heading',{name:'聯絡與投訴',exact:true})).toBeVisible();await page.goto('/music/index.html#rest');await expect(page).toHaveURL('/music?library=all');await expect(page.getByRole('heading',{name:'音樂詞庫',exact:true})).toBeVisible();await page.goBack();await expect(page).toHaveURL('/contact');
  await page.goto('/music/#event');await expect(page).toHaveURL('/activities?task=rooms');await page.getByRole('link',{name:'分析活動成分',exact:true}).first().click();await expect(page).toHaveURL(/\/tools\/room-lab\?eventId=/);
  await page.goto('/music/admin.html');await expect(page).toHaveURL('/admin');await page.goto('/music/privacy.html');await expect(page).toHaveURL('/privacy');await expect(page.getByRole('heading',{name:'隐私政策',exact:true})).toBeVisible();
  await page.setViewportSize({width:360,height:800});await page.goto('/contact.html');await expect(page.getByRole('link',{name:'203008876@qq.com',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('malformed control links display an error before opening private pages or sending business operations',async({page})=>{
  let privateReads=0,writes=0;page.on('request',r=>{if(r.url().includes('/api/v2/activities/'))privateReads++;if(['POST','PUT','DELETE'].includes(r.method()))writes++;});
  for(const query of ['event=listen&claim=bad','event=listen&action=join&action=finance','event=listen&poll=one','account_link=bad']){await page.goto('/?'+query);await expect(page.getByText('連結不完整或包含衝突的操作，請重新取得連結。',{exact:true})).toBeVisible();}
  expect(privateReads).toBe(0);expect(writes).toBe(0);
});
test('the bot mine entry lists owner drafts and published activities behind the member gate',async({page,context})=>{
  await page.goto('/?action=mine');await expect(page).toHaveURL('/me/activities');await expect(page.getByRole('link',{name:'登入',exact:true})).toBeVisible();await login(context);await page.reload();await expect(page.getByRole('heading',{name:'我的活動',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'未發布活動',exact:true})).toBeVisible();await page.getByRole('link',{name:'未發布活動',exact:true}).click();await expect(page).toHaveURL('/activities/draft/edit');
});

test('damaged access receipts are preserved and unavailable storage prevents a grant request',async({page,context})=>{
  const {id,token}=await published(context);await login(context,'bob');await page.goto('/?event='+id+'&invite='+token);await expect(page.getByLabel('確認接受活動查看邀請',{exact:true})).toBeVisible();
  await page.evaluate(({id,token})=>{const key='qgroup:rebuild:activity-draft:access:v1:';return fetch('/api/v2/session').then(r=>r.json()).then(viewer=>sessionStorage.setItem(key+viewer.scope+':'+id+':'+token,'damaged access receipt'));},{id,token});
  await page.reload();await expect(page.getByRole('button',{name:'接受查看邀請',exact:true})).toBeDisabled();await page.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect((await durableRows(page,'versions')).map(row=>row.raw)).toContain('damaged access receipt');
  let grants=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/access/'))grants++;});await denyDraftWrites(page,':access:');
  await page.getByLabel('確認接受活動查看邀請',{exact:true}).check();await page.getByRole('button',{name:'接受查看邀請',exact:true}).click();await expect(page.getByText('無法保存邀請操作編號，尚未送出授權。',{exact:true})).toBeVisible();expect(grants).toBe(0);
});

test('anonymous visitors can copy ordinary public links without obtaining invitation credentials',async({page})=>{
  await page.goto('/activities/listen/share');await expect(page.getByLabel('活動連結',{exact:true})).toHaveValue(origin+'/activities/listen');await expect(page.getByRole('button',{name:'複製活動連結',exact:true})).toBeEnabled();await expect(page.getByRole('link',{name:'登入',exact:true})).toHaveCount(0);
  await page.goto('/activities/invite/share');await expect(page.getByLabel('活動連結',{exact:true})).toHaveCount(0);await expect(page.getByText('找不到活動或尚未公開',{exact:true})).toBeVisible();
});
