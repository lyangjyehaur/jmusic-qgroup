import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

// Exercise native-controller contracts against real Yahha components in isolation.
const bundle=await build({stdin:{contents:"import {UI} from './ui/react-view.tsx';UI.boot();window.ui=UI;",resolveDir:path.resolve('.')},bundle:true,write:false,format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
const css=await fs.readFile('public/ui.css','utf8');
const markup=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"></head><body>
<form id="form"><div class="room-mode" id="mode"><button type="button" class="room-mode-btn on" data-mode="one" aria-pressed="true">一个</button><button type="button" class="room-mode-btn" data-mode="two" aria-pressed="false">两个</button></div>
<fieldset class="poll-choice"><legend>我的选择</legend><div><label><input type="radio" name="choice" value="yes" checked required>可以</label><label><input type="radio" name="choice" value="no" required>不行</label></div></fieldset></form>
<details id="fold"><summary>联系资料</summary><input id="contact"><p id="error" class="error"></p></details>
<dialog id="first"><form class="event-form"><div class="dialog-heading"><h2>第一个窗口</h2></div><input id="draft" value="原内容"><button type="button" id="next">下一步</button></form></dialog>
<dialog id="second"><form method="dialog"><h2>第二个窗口</h2><button value="confirmed">确认</button></form></dialog>
<a class="invoice-image"><img id="receipt" src="/bad.png" alt="消费凭证"></a>
<script type="module" src="/ui.mjs"></script></body></html>`;
const localChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN || (await fs.stat(localChrome).catch(()=>null)?localChrome:undefined)});
try {
 const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://ui.local/**',route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/')return route.fulfill({contentType:'text/html',body:markup});
  if(pathname==='/ui.css')return route.fulfill({contentType:'text/css',body:css});
  if(pathname==='/ui.mjs')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
  if(pathname==='/good.png')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=','base64')});
  return route.fulfill({status:404,body:''});
 });
 await page.goto('http://ui.local/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.ui);
 await page.evaluate(()=>document.querySelectorAll('#mode .room-mode-btn').forEach(b=>b.onclick=()=>document.querySelectorAll('#mode .room-mode-btn').forEach(other=>{other.classList.toggle('on',b===other);other.setAttribute('aria-pressed',String(b===other));})));
 await page.locator('#mode .ui-segmented').getByRole('radio',{name:'两个'}).check();
 await page.waitForFunction(()=>document.querySelector('#mode [data-mode=two]').getAttribute('aria-pressed')==='true');
 assert.deepEqual(await page.locator('#form').evaluate(f=>[...new FormData(f)]),[['choice','yes']]);
 await page.getByRole('radio',{name:'不行',exact:true}).check();
 assert.deepEqual(await page.locator('#form').evaluate(f=>[...new FormData(f)]),[['choice','no']]);
 await page.evaluate(()=>{document.querySelector('[name=choice][value=yes]').checked=true;});
 await page.waitForFunction(()=>document.querySelector('[name=choice][value=yes]').checked && !document.querySelector('[name=choice][value=no]').checked);
 await page.locator('#fold [data-ui-summary]').click();await page.locator('#contact').fill('保留输入');
 await page.evaluate(()=>window.ui.text(document.querySelector('#error'),'测试错误'));
 assert.equal(await page.locator('#error').isVisible(),true);
 assert.equal(await page.locator('#fold').evaluate(n=>n.open),true);
 await page.evaluate(()=>document.querySelector('#fold').open=false);
 await page.locator('#contact').waitFor({state:'hidden'});
 await page.evaluate(()=>document.querySelector('#fold').open=true);
 assert.equal(await page.locator('#contact').inputValue(),'保留输入');
 await page.evaluate(()=>document.querySelector('#first').showModal());
 await page.locator('#draft').fill('尚未保存的草稿');
 await page.evaluate(()=>document.querySelector('#second').showModal());
 assert.equal(await page.locator('#second .ui-dialog').getAttribute('role'),'dialog');
 assert.equal(await page.locator('#second').getAttribute('aria-hidden'),null);
 await page.locator('#second .ui-dialog').getByRole('button',{name:'确认',exact:true}).click();
 await page.locator('#second').waitFor({state:'hidden'});
 assert.equal(await page.locator('#draft').inputValue(),'尚未保存的草稿');
 await page.locator('#first .ui-dialog').getByRole('textbox').waitFor();
 assert.equal(await page.locator('#first').getAttribute('aria-hidden'),null);
 await page.keyboard.press('Escape');await page.locator('#first').waitFor({state:'hidden'});
 await page.evaluate(()=>document.querySelector('#first').showModal());
 assert.equal(await page.locator('#draft').inputValue(),'尚未保存的草稿');
 await page.evaluate(()=>document.querySelector('#first').close());
 await page.locator('.ui-content-image[data-status=error]').waitFor();
 await page.evaluate(()=>document.querySelector('#receipt').src='/good.png');
 await page.locator('.ui-content-image[data-status=loaded]').waitFor();
 assert.equal(await page.locator('#receipt').isVisible(),true);
 assert.deepEqual(errors,[]);
 console.log('Yahha contracts passed: segmented payloads, radio state, persistent disclosures, stacked dialogs, drafts and image recovery');
} finally {await browser.close();}
