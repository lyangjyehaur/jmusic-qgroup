import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from '@playwright/test';

// Exercise the real React confirmation and API with isolated data. A slow,
// intercepted QQ page exposes history traversal cancelling a pending navigation.
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'qgroup-qq-navigation-'));
const stateFile=path.join(temp,'session.json');
const fixture=spawn(process.env.PYTHON || 'python3',['tests/react_ui_fixture.py',stateFile],{stdio:['ignore','pipe','pipe']});
let log='',browser;
fixture.stderr.on('data',data=>log+=data);
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Fixture startup timeout\n'+log)),30000);
    fixture.stdout.on('data',data=>{if(String(data).includes('READY')){clearTimeout(timer);resolve();}});
    fixture.on('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}\n${log}`));});
  });
  const {base,cookies}=JSON.parse(await fs.readFile(stateFile,'utf8'));
  const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath=process.env.CHROME_BIN || (await fs.stat(chrome).catch(()=>null)?chrome:undefined);
  browser=await chromium.launch({headless:true,executablePath});
  for(const [locale,mode,member] of [['zh-TW','login',false],['zh-CN','login',false],['zh-TW','bind',true]]) {
    const context=await browser.newContext({locale,serviceWorkers:'block'});
    if(member)await context.addCookies(cookies);
    await context.route('https://**/*',route=>route.fulfill({status:204,body:''}));
    if(member)for(const endpoint of ['/api/me','/api/account'])await context.route('**'+endpoint,async route=>{
      const response=await route.fetch(),data=await response.json();
      data.qq={...data.qq,bound:false,needs_reauth:false};
      await route.fulfill({response,json:data});
    });
    const page=await context.newPage();
    page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let starts=0,failOnce=!member;
    await context.route('**/api/auth/qq/start',async route=>{
      starts++;
      assert.equal(route.request().postDataJSON().mode,mode);
      if(failOnce){failOnce=false;return route.fulfill({status:503,json:{error:'QQ navigation test unavailable'}});}
      await route.continue();
    });
    await context.route('https://graph.qq.com/oauth2.0/authorize?**',async route=>{
      await new Promise(resolve=>setTimeout(resolve,400));
      await route.fulfill({status:200,contentType:'text/html',body:'<h1>Mock QQ authorization reached</h1>'});
    });
    await page.goto(base);
    await page.locator('#home-qq-button').click();
    const account=page.locator('#identity-dialog');
    await account.getByRole('button',{name:mode==='bind'?/绑定 QQ|綁定 QQ/:/使用 QQ 登/}).waitFor();
    const privacy=account.locator('input[name=privacy]');
    if(await privacy.count())await privacy.check();
    const begin=()=>account.getByRole('button',{name:mode==='bind'?/绑定 QQ|綁定 QQ/:/使用 QQ 登/}).click();
    await begin();
    await page.locator('#confirm-cancel').click();
    await page.locator('#confirm-dialog').waitFor({state:'hidden'});
    assert.equal(starts,0,'Cancel must not start OAuth');
    await begin();
    await page.locator('#confirm-action').click();
    if(!member){
      await page.locator('#confirm-dialog').getByText('QQ navigation test unavailable',{exact:true}).waitFor();
      assert.equal(page.url(),base+'/');
      await page.locator('#confirm-action').click();
    }
    await page.getByRole('heading',{name:'Mock QQ authorization reached'}).waitFor();
    assert.equal(new URL(page.url()).host,'graph.qq.com');
    assert.equal(starts,member?1:2);
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('QQ navigation: simplified/traditional login, binding, cancellation and failed-start retry passed');
} finally {
  await browser?.close();
  fixture.kill('SIGTERM');
  await new Promise(resolve=>fixture.exitCode!==null?resolve():fixture.once('exit',resolve));
  await fs.rm(temp,{recursive:true,force:true});
}
