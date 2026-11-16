import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from '@playwright/test';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'qgroup-react-ui-'));
const stateFile=path.join(temp,'session.json');
const fixture=spawn(process.env.PYTHON || 'python3',['tests/react_ui_fixture.py',stateFile],{stdio:['ignore','pipe','pipe']});
let fixtureLog='';fixture.stderr.on('data',data=>fixtureLog+=data);
let browser, activePage;
const screenshots=path.resolve('artifacts/yahha-ui');
await fs.mkdir(screenshots,{recursive:true});
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Fixture startup timeout\n'+fixtureLog)),30000);
    fixture.stdout.on('data',data=>{if(String(data).includes('READY')){clearTimeout(timer);resolve();}});
    fixture.on('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited (${code})\n${fixtureLog}`));});
  });
  const {base,cookies}=JSON.parse(await fs.readFile(stateFile,'utf8'));
  const localChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath=process.env.CHROME_BIN || (await fs.stat(localChrome).catch(()=>null)?localChrome:undefined);
  browser=await chromium.launch({headless:true,executablePath});
  const context=await browser.newContext({locale:'zh-TW',viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.addCookies(cookies);
  await context.route('https://**/*',route=>route.fulfill({status:204,body:''}));
  const page=activePage=await context.newPage();
  page.setDefaultTimeout(10000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.stack));
  const go=async url=>{await page.goto(base+url);await page.waitForTimeout(350);};
  const wait=async selector=>page.locator(selector).first().waitFor({state:'visible'});
  const close=async id=>{
    await page.locator(`#${id} [data-close="${id}"]`).first().click();
    await page.locator(`#${id}`).waitFor({state:'hidden'});
    await page.waitForFunction(()=>!history.state?.kanbanDialog);
  };
  const select=async (model,value)=>{
    const wrapper=page.locator(model).locator('xpath=..');
    await wrapper.getByRole('combobox').click();
    const label=await page.locator(model).locator(`option[value="${value}"]`).textContent();
    await page.getByRole('option',{name:label,exact:true}).click();
    assert.equal(await page.locator(model).inputValue(),value);
  };
  await go('/');
  const later=page.locator('[data-identity="qq-refresh-later"]');
  if(await later.isVisible())await later.click();
  await wait('#board .event-card');
  assert.match(await page.locator('#create-button').getAttribute('class'),/_button_/);
  assert.match(await page.locator('#search').getAttribute('class'),/_input_/);
  assert.equal(await page.locator('#board .event-card').count(),3);
  await select('#category-filter','聚餐');
  assert.equal(await page.locator('#board .event-card').count(),1);
  await select('#category-filter','全部');
  await page.screenshot({path:path.join(screenshots,'board-desktop.png'),fullPage:true});

  // Native names, required checks, hidden/disabled fields and a real user submit.
  await page.locator('#create-button').click();await wait('#event-form-dialog[open]');
  await page.locator('#event-form [name=title]').fill('React 表单验证');
  await page.locator('#event-form [name=location]').fill('本机测试场地');
  await select('#event-form [name=category]','聚餐');
  assert.equal(await page.locator('#event-form [name=duration_hours]').inputValue(),'2');
  await page.locator('#event-form [name=description]').fill('用户原文：后台後臺 — 不作文字转换');
  await page.locator('#publish-button').click();
  await wait('#detail-dialog[open]');
  assert.match(await page.locator('#detail-content').innerText(),/React 表单验证/);
  assert.match(await page.locator('#detail-content').innerText(),/后台後臺/);
  await page.locator('#detail-dialog [data-advanced-toggle]').check();
  await page.locator('[data-roster-action="add"]').first().click();await wait('#party-dialog[open]');
  await page.locator('#add-guest').click();
  assert.equal(await page.locator('#party-rows .guest-row').count(),2);
  await page.locator('#party-rows [data-remove-guest]').first().click();
  assert.equal(await page.locator('#party-rows .guest-row').count(),1);
  await page.locator('#party-rows [name=guest_name]').fill('同行测试');
  await page.locator('#save-party').click();await wait('#party-preview .allocation-preview');
  await page.locator('#save-party').click();await page.locator('#party-dialog').waitFor({state:'hidden'});
  assert.match(await page.locator('#detail-content').innerText(),/同行测试/);

  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('#detail-dialog [data-advanced-toggle]').check();
  await page.locator('[data-roster-action="add"]').first().click();await wait('#party-dialog[open]');
  assert.equal(await page.locator('#party-rows .guest-row').count(),1);
  await close('party-dialog');

  // Re-rendered room controls and settlement preview/commit retain their IDs.
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('[data-detail-action=rooms]').click();await wait('#rooms-dialog[open]');
  await page.locator('#rooms-editor [data-room-add]').click();
  await page.locator('#rooms-editor [data-room-field=name]').fill('React 包间');
  const roomId=await page.locator('#rooms-editor [data-room-field=name]').getAttribute('data-room');
  await select('#rooms-editor [data-room-person] >> nth=0',roomId);
  await page.locator('#rooms-save').click();await page.locator('#rooms-dialog').waitFor({state:'hidden'});
  assert.match(await page.locator('#detail-content').innerText(),/React 包间/);
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('#detail-dialog [data-advanced-toggle]').check();
  await page.locator('[data-activity=cancel]').click();await wait('#activity-action-dialog[open]');
  await page.locator('#activity-action-form [name=reason]').fill('本机结算回归测试');
  await page.locator('#activity-action-save').click();await page.locator('#activity-action-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('[data-detail-action=settle]').click();await wait('#invoice-dialog[open]');
  await page.waitForFunction(()=>!document.querySelector('#preview-invoice').disabled);
  await page.locator('#invoice-form [name=room_mode]').uncheck();
  await page.locator('#invoice-items [data-prop=amount]').fill('120');
  await select('#invoice-form [name=merchant_mode]','unpaid');
  await page.locator('#invoice-form [name=reviewed_roster]').check();
  await page.locator('#preview-invoice').click();await wait('#invoice-preview');
  assert.match(await page.locator('#invoice-preview').innerText(),/120\.00/);
  await page.locator('#publish-invoice').click();await page.locator('#invoice-dialog').waitFor({state:'hidden'});
  assert.match(await page.locator('#detail-content').innerText(),/120\.00/);
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('#detail-dialog [data-advanced-toggle]').check();
  await page.locator('[data-detail-action=finance]').click();await wait('#finance-dialog[open]');
  await page.locator('[data-finance=record]').click();await wait('#finance-form-dialog[open]');
  await select('#finance-form [name=kind]','expense');
  await page.locator('#finance-form [name=amount]').fill('120');
  await page.locator('#finance-form [name=merchant]').fill('React 店家付款');
  assert.equal(await page.locator('#finance-form [name=from_id]').isDisabled(),true);
  await page.locator('#finance-preview-button').click();await wait('#finance-preview');
  assert.match(await page.locator('#finance-preview').innerText(),/120\.00/);
  await page.locator('#finance-confirm').click();await page.locator('#finance-form-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#finance-history')?.textContent.includes('React 店家付款'));
  await close('finance-dialog');
  await close('detail-dialog');

  // The options popup must live in the native dialog's top layer.
  await page.locator('#create-button').click();await wait('#event-form-dialog[open]');
  assert.equal(await page.locator('#event-form [name=category]').inputValue(),'约K');
  const categoryTrigger=page.locator('#event-form [name=category]').locator('xpath=..').getByRole('combobox');
  await categoryTrigger.click();
  await page.waitForFunction(()=>document.querySelector('#event-form-dialog [role=combobox]')?.getAttribute('aria-expanded')==='true');
  await wait('#event-form-dialog [role=listbox]');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#event-form-dialog').getAttribute('open'),'');
  await close('event-form-dialog');
  if(await page.locator('#confirm-dialog').isVisible())await page.locator('#confirm-action').click();

  await page.locator('[data-poll-action=create]').click();await wait('#time-poll-form-dialog[open]');
  await page.locator('#time-poll-form [name=title]').fill('React 日期投票');
  await page.locator('#time-poll-form [name=location]').fill('本机测试');
  await page.locator('#time-poll-form [name=bot_enabled]').uncheck();
  const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
  await page.locator('#poll-slots input[type=date]').nth(0).fill(day(4));
  await page.locator('#poll-slots input[type=date]').nth(1).fill(day(5));
  await page.locator('#time-poll-form [data-poll-form-action=add]').click();
  assert.equal(await page.locator('#poll-slots .poll-slot').count(),3);
  await page.locator('#poll-slots [data-poll-form-action=remove]').last().click();
  assert.equal(await page.locator('#poll-slots .poll-slot').count(),2);
  await page.locator('#time-poll-form [name=deadline_date]').fill(day(2));
  await page.locator('#time-poll-form button[type=submit]').click();await wait('#time-poll-dialog[open]');
  await page.locator('#time-poll-vote-form input[type=radio][value=yes]').first().check();
  await page.locator('#time-poll-vote-form input[type=radio][value=maybe]').last().check();
  await page.locator('#time-poll-vote-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#time-poll-content')?.textContent.includes('已投票'));
  await close('time-poll-dialog');

  await go('/music/');await wait('#rankListMain .rank-row');
  await page.locator('#musicLinkCard').waitFor({state:'hidden'});
  assert.equal(await page.locator('#tabBar .tab').count(),5);
  await page.locator('#mobBar').waitFor({state:'hidden'});
  assert.match(await page.locator('#themeBtn').getAttribute('class'),/_button_/);
  assert.equal(await page.locator('.section-heading').count(),0);
  assert.equal(await page.locator('.discovery-intro').count(),0);
  // Card-only overflow checks missed the zero-width name column at 614px.
  for(const width of [320,390,600,614,768,920,1039,1040,1280]) {
    await page.setViewportSize({width,height:923});
    const rows=await page.locator('#rankListMain .rank-row, #rankListSub .rank-row').evaluateAll(nodes=>nodes.map(row=>{
      const name=row.querySelector('.rank-name'),rect=name.getBoundingClientRect();
      return {text:name.textContent,width:rect.width,clipped:name.scrollWidth>name.clientWidth+1 || name.scrollHeight>name.clientHeight+1};
    }));
    assert.ok(rows.length && rows.every(row=>row.width>=120 && !row.clipped),`Ranking names are clipped at ${width}px: ${JSON.stringify(rows)}`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(width===614) {
      const main=await page.locator('#boardCardMain').boundingBox(),sub=await page.locator('#boardCardSub').boundingBox();
      assert.ok(sub.y>=main.y+main.height,'Intermediate screens squeeze rankings into two columns');
      await page.screenshot({path:path.join(screenshots,'music-614-fixed.png'),fullPage:true});
    }
  }
  await page.setViewportSize({width:1280,height:900});

  await page.screenshot({path:path.join(screenshots,'music-desktop.png'),fullPage:true});
  await page.screenshot({path:path.join(screenshots,'music-overview-desktop.png')});
  await page.locator('#tabBar [data-page=mine]').click();await wait('#page-mine.active');
  assert.equal(await page.locator('#selChips .kind-main .sel-seg-btn').count(),0);
  await page.locator('#selChips .sel-seg-btn').first().click();
  await wait('#mobBar');
  assert.equal(await page.locator('#selChips .sel-seg-btn').first().getAttribute('aria-pressed'),'true');
  // Editing account contact must keep selection drafts and show errors beside the form.
  await page.locator('#musicContactDetails summary').click();
  const originalContact=await page.locator('#musicContactQQ').inputValue();
  await page.locator('#musicContactQQ').fill('invalid');
  await page.locator('#musicContactSave').click();
  await page.waitForFunction(()=>document.querySelector('#musicContactError').textContent.length>0);
  assert.equal(await page.locator('#musicLinkCard').isVisible(),false);
  assert.equal(await page.locator('#musicContactError').isVisible(),true);
  await page.locator('#musicContactQQ').fill(originalContact);
  await page.locator('#musicContactSave').click();
  await page.waitForFunction(()=>document.querySelector('#musicContactError').textContent==='已保存');
  assert.equal(new URL(page.url()).hash,'#mine');
  assert.equal(await page.locator('#mobBar').isVisible(),true);

  await page.locator('#mobSave').click();await wait('#page-matches.active');
  assert.match(await page.locator('#page-matches').innerText(),/同好|匹配/);
  await page.locator('#mobBar').waitFor({state:'hidden'});
  await page.locator('#tabBar [data-page=board]').click();
  await page.locator('#discoverNav [data-go=rest]').click();await wait('#page-rest.active');
  await page.locator('#searchInput').fill('Aimer');
  assert.match(await page.locator('#rankListRest').innerText(),/Aimer/);
  assert.match(await page.locator('#rankListRestMain').innerText(),/没有匹配/);
  await page.locator('#searchInput').fill('动画');
  assert.match(await page.locator('#rankListRestMain').innerText(),/动画音乐/);
  await page.locator('#searchInput').fill('');
  for(const name of ['shout','room','event','trend']) {
    if(['shout','room','event'].includes(name)) {
      await page.locator('#tabBar [data-page=event]').click();
      await page.locator(`#gatherNav [data-go=${name}]`).click();
    } else await page.locator(`#tabBar [data-page=${name}]`).click();
    await wait(`#page-${name}.active`);
    if(name==='event') {
      await wait('#eventDetailCard');
      await page.waitForFunction(()=>!document.querySelector('#eventSplit').disabled);
      assert.equal(await page.locator('#eventList').count(),0);
      assert.equal(await page.locator('#eventParticipants .event-part').count(),2);
      const sourceId=await page.locator('#eventSelect').inputValue();
      assert.equal(await page.locator('#eventBoardLink').getAttribute('href'),'/?event='+sourceId);
      const before=await (await page.request.get(base+'/api/events/'+sourceId)).json();
      await page.locator('#eventSplit').click();await wait('#eventResults .event-room');
      assert.equal(await page.locator('#eventRooms .event-room').count(),2);
      assert.equal(await page.locator('#eventShare').isDisabled(),false);
      const after=await (await page.request.get(base+'/api/events/'+sourceId)).json();
      assert.equal(after.revision,before.revision,'Suggestions changed the board activity');
      await page.locator('#eventMode [data-mode=sizes]').click();
      await page.locator('#eventSizes').fill('1,1');
      await page.locator('#eventSplit').click();
      await page.waitForFunction(()=>document.querySelector('#eventSplitHint').textContent.includes('自定义人数'));
      await page.locator('#eventMode [data-mode=capacity]').click();
      await page.locator('#eventValue').fill('2');
      await page.locator('#eventSplit').click();
      await page.waitForFunction(()=>document.querySelector('#eventSplitHint').textContent.includes('每房 2 人'));
      const alternate=await page.locator('#eventSelect option').evaluateAll((nodes,id)=>nodes.find(n=>n.value!==id && !n.textContent.includes('React'))?.value,sourceId);
      await select('#eventSelect',alternate);
      await page.waitForFunction(()=>!document.querySelector('#eventSplit').disabled);
      assert.equal(await page.locator('#eventResults').isVisible(),false,'Previous activity rooms leaked after switching');
      await page.locator('#eventRefresh').click();
      await page.waitForFunction(()=>!document.querySelector('#eventRefresh').disabled);
      assert.equal(await page.locator('#eventSelect').inputValue(),alternate);
      assert.equal(await page.locator('#eventParticipants .event-part').count(),2);
      await go('/music/?event='+sourceId+'#event');await wait('#eventDetailCard');
      assert.equal(await page.locator('#eventSelect').inputValue(),sourceId);
      // Empty and failed sources must not leave a previous roster or suggestions usable.
      await page.route('**/music/api/qgroup/event?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试名单读取失败'})}));
      await page.locator('#eventRefresh').click();await wait('#eventError');
      assert.equal(await page.locator('#eventDetailCard').isVisible(),false);
      assert.equal(await page.locator('#eventSplit').isDisabled(),true);
      await page.unroute('**/music/api/qgroup/event?*');
      await page.route('**/music/api/qgroup/events?*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({events:[]})}));
      await page.locator('#eventRefresh').click();await wait('#eventEmpty');
      assert.equal(await page.locator('#eventError').isVisible(),false);
      assert.equal(await page.locator('#eventDetailCard').isVisible(),false);
      await page.unroute('**/music/api/qgroup/events?*');
      await page.locator('#eventRefresh').click();await wait('#eventDetailCard');
    }
    if(name==='room') {
      await wait('#roomPool button');
      await page.locator('#roomIncludeMe').check();
      await page.locator('#roomPool').getByRole('button',{name:'小林',exact:true}).click();
      await page.locator('#roomQuery').click();
      await wait('#roomResult');
      await page.locator('#roomSameGender').check();
      assert.equal(await page.locator('#tabBar .active').getAttribute('data-page'),'event');
    }
  }
  await page.locator('#tabBar [data-page=board]').click();await wait('#page-board.active');
  await page.locator('#discoverNav [data-go=rest]').click();
  await page.goBack();await wait('#page-board.active');
  await go('/music/#room');await wait('#page-room.active');await wait('#roomPool button');
  await page.locator('#tabBar [data-page=board]').click();
  await page.locator('#themeBtn').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.screenshot({path:path.join(screenshots,'music-dark.png'),fullPage:true});
  await page.locator('#themeBtn').click();

  await go('/admin');await wait('#admin-users .admin-user');
  await page.locator('[data-user-metadata]').first().click();await wait('#users-metadata[open]');
  await page.locator('#users-metadata-form [name=note]').fill('React 管理表单');
  await page.locator('#users-metadata-form button[type=submit]').click();
  await page.locator('#users-metadata').waitFor({state:'hidden'});
  assert.match(await page.locator('#admin-users').innerText(),/React 管理表单/);
  await page.screenshot({path:path.join(screenshots,'admin-desktop.png'),fullPage:true});
  await go('/music/admin.html');await wait('#entryTbody tr');
  await page.locator('#adminSearch').fill('米津');
  assert.equal(await page.locator('#entryTbody tr').count(),1);
  assert.match(await page.locator('#entryTbody input').first().getAttribute('class'),/_input_/);
  await page.locator('#newEntryText').fill('React 测试词条');
  await page.locator('#newEntryBtn').click();await page.waitForTimeout(350);
  await page.locator('#adminSearch').fill('React 测试词条');
  assert.equal(await page.locator('#entryTbody input').first().inputValue(),'React 测试词条');
  await page.screenshot({path:path.join(screenshots,'music-admin-desktop.png'),fullPage:true});

  // Every shipped page is usable at a narrow viewport; no clipped document.
  await page.setViewportSize({width:390,height:844});
  for(const [name,url] of [['board','/'],['music','/music/'],['admin','/admin'],['music-admin','/music/admin.html'],['guide','/guide.html'],['privacy','/privacy'],['contact','/contact'],['music-privacy','/music/privacy.html']]) {
    await go(url);
    if(await later.isVisible())await later.click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} overflows the mobile viewport`);
    await page.screenshot({path:path.join(screenshots,`${name}-mobile.png`),fullPage:true});
  }
  // Check every secondary page at mobile width, including the save dock and navigation.
  await go('/music/');
  await page.locator('#toast').waitFor({state:'hidden'});
  for(const name of ['board','rest','matches','mine','event','room','shout','trend']) {
    await page.evaluate(name=>window.__showPage(name,{top:true}),name);
    await wait(`#page-${name}.active`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} overflows`);
    if(name==='rest') {
      const names=await page.locator('#rankListRest .rank-name').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));
      assert.ok(names.length && names.every(width=>width>=100),'Artist names are squeezed by row controls');
    }
    await page.locator('#toast').waitFor({state:'hidden'});
    const mainNav=await page.locator('#tabBar').boundingBox();
    assert.ok(mainNav.y+mainNav.height<=844+1);
    await page.screenshot({path:path.join(screenshots,`music-${name}-mobile.png`),fullPage:true});
    if(name==='board') await page.screenshot({path:path.join(screenshots,'music-overview-mobile.png')});
    if(name==='mine') {
      await page.locator('#selChips .sel-seg-btn').first().click();
      const dock=await page.locator('#mobBar').boundingBox();
      assert.ok(dock.y+dock.height<=mainNav.y, 'Save dock covers primary navigation');
      await page.locator('#toast').waitFor({state:'hidden'});
      await page.screenshot({path:path.join(screenshots,'music-selection-mobile.png'),fullPage:true});
      await page.screenshot({path:path.join(screenshots,'music-selection-viewport.png')});
      await page.locator('#mobSave').click();await wait('#page-matches.active');
    }
  }
  for(const width of [320,768]) {
    await page.setViewportSize({width,height:844});
    for(const name of ['board','rest','mine','event','room']) {
      await page.evaluate(name=>window.__showPage(name,{top:true}),name);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} overflows at ${width}px`);
    }
  }
  await page.setViewportSize({width:1280,height:900});
  for(const name of ['mine','matches','event','room']) {
    await page.evaluate(name=>window.__showPage(name,{top:true}),name);
    await page.locator('#toast').waitFor({state:'hidden'});
    await page.screenshot({path:path.join(screenshots,`music-${name}-desktop.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  await context.clearCookies();
  for(const url of ['/','/music/']) {
    await go(url);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await wait('#musicEntryButton');
  assert.match(await page.locator('#musicNewName').getAttribute('class'),/_input_/);
  assert.deepEqual(errors,[]);
  console.log('React/Yahha browser checks passed: real submissions, dynamic rows, room assignments, settlement publish, finance records, poll votes, modal selects, music pages, admin edits, dark mode and 8 mobile pages');
} catch(error) {
  if(activePage) {
    await activePage.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true}).catch(()=>{});
    console.error((await activePage.locator('dialog[open], #musicLinkError, #toast').allTextContents()).join('\n'));
    console.error(await activePage.locator(':invalid').evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName,name:n.name,message:n.validationMessage}))));
  }
  throw error;
} finally {
  await browser?.close();
  fixture.kill('SIGTERM');
  await new Promise(resolve=>fixture.once('exit',resolve));
  await fs.rm(temp,{recursive:true,force:true});
}
