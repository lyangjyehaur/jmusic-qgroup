import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
const origin='http://127.0.0.1:5082';
test.use({legacyHistoryExamples:true});
test('downloads both original formats through the unified admin page with private confirmation, source labels and no browser persistence',async({page,context})=>{
  await page.setViewportSize({width:360,height:800});await context.addCookies([{name:'kanban_session',value:'fixture-registration-admin',url:origin,httpOnly:true,sameSite:'Lax'}]);
  await page.goto('/admin/backups');await expect(page.getByText('舊備份顯示原始檔名時間，時區未經確認。',{exact:true})).toBeVisible();
  for(const name of ['下載 20261118-010203 舊配對','下載 20261118-010203 舊 JSON'])await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();
  await page.getByRole('checkbox',{name:'確認下載並保管私人資料',exact:true}).focus();await page.keyboard.press('Space');
  const bodies=[];
  for(const [name,type] of [['下載 20261118-010203 舊配對','pair'],['下載 20261118-010203 舊 JSON','json']]){
    const pending=page.waitForEvent('download');await page.getByRole('button',{name,exact:true}).click();const file=await pending;expect(file.suggestedFilename()).toBe('music-data-legacy-'+type+'-20261118-010203.json');
    const body=JSON.parse(readFileSync((await file.path())!,'utf8'));expect(body.members['10002']).toMatchObject({name:'原稱呼bob',pinHash:'CURRENT-PIN',boardUserId:'bob'});expect(body.members['10004']).toMatchObject({boardUserId:'',pinHash:'',contactQQ:''});expect(body.settings).toEqual({});bodies.push(body);
  }
  expect(bodies[0]).toEqual(bodies[1]);expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toMatch(/pinHash|contactQQ|"members"/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-legacy-backups-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});await page.reload();await expect(page.getByRole('button',{name:'下載 20261118-010203 舊配對',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/unified-legacy-backups-desktop.png',fullPage:true});
});
test('downloads legacy profiles with a newer explicit contact clearing while retaining their original selections',async({page,context})=>{
  await context.addCookies([{name:'kanban_session',value:'fixture-contact-owner',url:origin,httpOnly:true,sameSite:'Lax'}]);await page.goto('/me/music/contact');
  const state=await page.evaluate(async()=>{const viewer=await(await fetch('/api/v2/session')).json();const contact=await(await fetch('/api/v2/me/music/contact',{headers:{'X-Account-Scope':viewer.scope}})).json();return {viewer,contact};});
  const response=await context.request.put('/api/v2/me/music/contact',{headers:{Origin:origin,'X-Account-Scope':state.viewer.scope,'X-CSRF-Token':state.viewer.csrf,'Idempotency-Key':crypto.randomUUID()},data:{contactQQ:'',revision:state.contact.revision,profileId:state.contact.profileId,musicEpoch:state.viewer.musicEpoch}});expect(response.status(),await response.text()).toBe(200);
  await context.addCookies([{name:'kanban_session',value:'fixture-registration-admin',url:origin,httpOnly:true,sameSite:'Lax'}]);await page.goto('/admin/backups');await page.getByRole('checkbox',{name:'確認下載並保管私人資料',exact:true}).check();
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'下載 20261118-010203 舊配對',exact:true}).click();const file=await pending,body=JSON.parse(readFileSync((await file.path())!,'utf8'));
  const member=body.members['m_'+'a'.repeat(24)];expect(member.contactQQ).toBe('');expect(member.selection).toEqual([{id:'e',level:4},{id:'e',level:'2'}]);
});
