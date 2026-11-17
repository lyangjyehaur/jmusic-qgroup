import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin='http://127.0.0.1:5082';
async function login(context:BrowserContext,user='bob'){await context.addCookies([{name:'kanban_session',value:'fixture-'+user,url:origin,httpOnly:true,sameSite:'Lax'}]);}
async function pin(page:Page,qq='10001'){
  await page.getByLabel('舊 QQ',{exact:true}).fill(qq);await page.getByLabel('原口令',{exact:true}).fill('123456');
  await page.getByRole('checkbox',{name:'確認以舊資料驗證取回權利，並將原成分關聯至完成 QQ 授權的帳號',exact:true}).check();await page.getByRole('button',{name:'驗證原口令',exact:true}).click();
}
async function oauth(page:Page,member=false){
  await expect(page.getByRole('button',{name:'前往 QQ 授權找回',exact:true})).toBeVisible();
  const consent=page.getByRole('checkbox',{name:/我已閱讀並同意/});if(await consent.count()) await consent.check();
  await page.getByRole('button',{name:'前往 QQ 授權找回',exact:true}).click();await page.getByRole('button',{name:member?'確認綁定':'確認登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'找回舊成分',exact:true})).toBeVisible();
}
async function complete(page:Page){await page.getByRole('checkbox',{name:'確認這是我的原成分，關聯至目前帳號',exact:true}).check();await page.getByRole('button',{name:'確認關聯原成分',exact:true}).click();await expect(page.getByRole('link',{name:'編輯原成分',exact:true})).toBeVisible();}
test('a guest recovers original music through one login and explicit linking without persisting the PIN',async({page,context})=>{
  await page.goto('/me/music');await page.getByRole('link',{name:'找回舊成分',exact:true}).click();await pin(page);
  await expect(page.getByRole('heading',{name:'舊成分 10001',exact:true})).toBeVisible();
  const stored=await page.evaluate(()=>JSON.stringify({session:{...sessionStorage},local:{...localStorage}}));expect(stored).not.toMatch(/123456|jpm-pin|pin_proof|pinHash/);
  await page.reload();await oauth(page);await expect(page.getByRole('button',{name:'確認關聯原成分',exact:true})).toBeDisabled();
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-recovery-mobile.png',fullPage:true});
  await complete(page);await page.getByRole('link',{name:'編輯原成分',exact:true}).click();await expect(page.getByRole('button',{name:'Aimer',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByLabel('Aimer喜歡程度')).toHaveValue('4');
  const viewer=await(await context.request.get('/api/v2/session')).json();expect(viewer.authenticated).toBe(true);expect(viewer.musicEpoch).toBe(1);
  await page.getByRole('link',{name:'聯絡 QQ',exact:true}).click();await expect(page.getByText('10001 · 舊成分查詢號碼，未經騰訊驗證',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'保存聯絡 QQ',exact:true})).toHaveCount(0);
});
test('an existing account binds QQ, keeps its name and reopens the original selections after an untouched blank editor',async({page,context})=>{
  await login(context);await page.goto('/me/music');await expect(page.getByRole('button',{name:'Aimer',exact:true})).toHaveAttribute('aria-pressed','false');await page.getByRole('link',{name:'找回舊成分',exact:true}).click();await pin(page);await oauth(page,true);await complete(page);
  await page.getByRole('link',{name:'編輯原成分',exact:true}).click();await expect(page.locator('.viewer')).toHaveText('小白');await expect(page.getByRole('button',{name:'Aimer',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('button',{name:'保存我的成分',exact:true})).toHaveCount(0);
});
test('an unreadable PIN response is checked from the server and never resends or stores the PIN automatically',async({page})=>{
  let requests=0;await page.route('**/api/v2/music/claim/start',async route=>{requests++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.goto('/me/music/recover');await pin(page);await expect(page.getByText('尚未確認口令驗證結果。口令未保存，請先核對找回狀態。',{exact:true})).toBeVisible();await expect(page.getByLabel('原口令',{exact:true})).toHaveValue('');
  await page.reload();await expect(page.getByRole('heading',{name:'舊成分 10001',exact:true})).toBeVisible();expect(requests).toBe(1);expect(await page.evaluate(()=>JSON.stringify({...sessionStorage}))).not.toContain('123456');
});
test('lost login and linking results are recovered from the same browser without duplicate claims',async({page,context})=>{
  let logins=0,finishes=0;
  await page.route('**/api/v2/auth/qq/finish',async route=>{logins++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.goto('/me/music/recover');await pin(page);await page.getByRole('checkbox',{name:/我已閱讀並同意/}).check();await page.getByRole('button',{name:'前往 QQ 授權找回',exact:true}).click();await page.getByRole('button',{name:'確認登入',exact:true}).click();
  await expect(page.getByText('尚未確認登入結果，請先核對目前帳號。',{exact:true})).toBeVisible();await page.getByRole('link',{name:'核對找回狀態',exact:true}).click();await expect(page.getByRole('button',{name:'確認關聯原成分',exact:true})).toBeVisible();
  await page.route('**/api/v2/music/claim/finish',async route=>{finishes++;const response=await route.fetch();await route.fulfill({response,body:'{'});});
  await page.getByRole('checkbox',{name:'確認這是我的原成分，關聯至目前帳號',exact:true}).check();await page.getByRole('button',{name:'確認關聯原成分',exact:true}).click();await expect(page.getByText('尚未確認操作結果，請先核對找回狀態。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'核對找回狀態',exact:true}).click();await expect(page.getByRole('link',{name:'編輯原成分',exact:true})).toBeVisible();expect(logins).toBe(1);expect(finishes).toBe(1);
  const viewer=await(await context.request.get('/api/v2/session')).json();const history=await(await context.request.get('/api/v2/me/account-history',{headers:{'X-Account-Scope':viewer.scope}})).json();expect(history.history.filter((row:{action:string})=>row.action==='music_claimed')).toHaveLength(1);
});
test('QQ cancellation preserves the PIN intent and explicit cancellation leaves the original profile available',async({page})=>{
  await page.goto('/me/music/recover');await pin(page);await page.getByRole('checkbox',{name:/我已閱讀並同意/}).check();await page.getByRole('button',{name:'前往 QQ 授權找回',exact:true}).click();await page.getByRole('button',{name:'取消並返回',exact:true}).click();
  await expect(page.getByRole('heading',{name:'舊成分 10001',exact:true})).toBeVisible();await page.getByRole('button',{name:'取消找回',exact:true}).click();await expect(page.getByText('已取消找回，原成分與目前帳號均保留。',{exact:true})).toBeVisible();
  await pin(page);await oauth(page);await complete(page);
});
test('storage failure blocks sending PINs, and damaged operation records are preserved before recovery',async({page,context})=>{
  let writes=0;page.on('request',request=>{if(request.url().endsWith('/music/claim/start'))writes++;});
  await page.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('qgroup:rebuild:music:claim:'))throw new DOMException('synthetic failure');original.call(this,key,value);};});
  await page.goto('/me/music/recover');await pin(page);await expect(page.getByText('無法保存找回操作編號，尚未送出口令。',{exact:true})).toBeVisible();expect(writes).toBe(0);
  const clean=await context.newPage();await clean.goto('/me/music/recover');const viewer=await(await context.request.get('/api/v2/session')).json();await clean.evaluate(scope=>sessionStorage.setItem('qgroup:rebuild:music:claim:v1:'+scope,'damaged synthetic operation'),viewer.scope);await clean.reload();await expect(clean.getByText('無法讀取找回操作編號，原始內容已保留。請先保全原稿。',{exact:true})).toBeVisible();await expect(clean.getByLabel('原口令',{exact:true})).toBeDisabled();
  await clean.getByRole('button',{name:'保全原稿後繼續',exact:true}).click();expect(await clean.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.includes(':recovery:')).map(key=>sessionStorage.getItem(key)))).toContain('damaged synthetic operation');await clean.close();
});
test('an already populated account cannot replace its selections with a PIN claim',async({page,context})=>{
  await login(context);await page.goto('/me/music');await page.getByRole('button',{name:'YOASOBI',exact:true}).click();await page.getByRole('button',{name:'保存我的成分',exact:true}).click();await expect(page.getByText('已保存。',{exact:true})).toBeVisible();
  await page.goto('/me/music/recover');await pin(page);await expect(page.getByText('目前帳號已有成分，請聯絡管理員核對；原資料不會覆蓋',{exact:true})).toBeVisible();await expect(page.getByLabel('原口令',{exact:true})).toHaveValue('');
  await page.getByRole('link',{name:'回到我的成分',exact:true}).click();await expect(page.getByRole('button',{name:'YOASOBI',exact:true})).toHaveAttribute('aria-pressed','true');
});
