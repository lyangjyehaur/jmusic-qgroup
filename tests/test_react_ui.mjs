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
    await page.locator(`#${id} .ui-dialog`).getByRole('button',{name:/^(关闭|關閉|关闭弹窗|關閉彈窗)$/}).click();
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
  const choose=async (scope,label,option)=>{
    const trigger=page.locator(scope).getByRole('combobox',{name:label,exact:true});
    await trigger.click();await page.getByRole('option',{name:option,exact:true}).click();
  };
  const dialog=async id=>wait(`#${id}[data-open=true] [role=dialog]`);
  await go('/');
  const later=page.locator('[data-identity="qq-refresh-later"]');
  if(await later.isVisible())await later.click();
  await wait('#board .event-card');
  assert.equal(await page.locator('.board-intro, ui-fragment, .ui-choice-model').count(),0);
  assert.equal(await page.locator('#board .event-card').count(),3);
  assert.equal(await page.locator('.event-card .category-label, .board-site-links').count(),0);
  assert.equal(await page.locator('header a[href="/music/"]').count(),1);
  assert.equal(await page.locator('.footer-filing').innerText(),'渝ICP备16002872号-1');
  await page.locator('#board .event-card').first().click();await dialog('detail-dialog');
  const member=page.locator('.participant-profile').filter({hasText:'小林'});
  const historyBefore=await page.evaluate(()=>JSON.stringify(history.state));
  const rosterBefore=await page.locator('.participant-list').first().boundingBox();
  await member.click();await wait('.member-music-popover .member-music-picks');
  assert.equal(await page.locator('[data-react-dialog]').count(),1,'Music card added another modal');
  assert.equal(await page.evaluate(()=>JSON.stringify(history.state)),historyBefore,'Music card changed navigation history');
  assert.equal((await page.locator('.participant-list').first().boundingBox()).height,rosterBefore.height,'Music card expanded the roster');
  assert.match(await page.locator('.member-music-popover').innerText(),/共同選擇|共同选择/);
  await page.keyboard.press('Escape');await page.locator('.member-music-popover').waitFor({state:'hidden'});
  assert.equal(await page.locator('#detail-dialog [role=dialog]').isVisible(),true);
  assert.equal(await member.evaluate(node=>node===document.activeElement),true,'Escape did not restore the member trigger');
  await member.click();await wait('.member-music-popover .member-music-picks');
  await page.locator('.participant-profile').filter({hasText:'饭团'}).click();
  await wait('.member-music-popover .member-music-picks');
  assert.equal(await page.locator('.member-music-popover:visible').count(),1);
  assert.match(await page.locator('.member-music-popover:visible').innerText(),/饭团/);
  await page.locator('.member-music-popover:visible').getByRole('button',{name:/關閉成分卡|关闭成分卡/}).click();
  await member.click();await wait('.member-music-popover .member-music-picks');
  await page.locator('#detail-dialog .ui-dialog > h2').click();
  await page.locator('.member-music-popover').waitFor({state:'hidden'});
  for(const width of [320,390,614,932]) {
    await page.setViewportSize({width,height:923});
    await member.click();await wait('.member-music-popover .member-music-picks');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Member profile overflows at ${width}`);
    const card=await page.locator('.member-music-popover').boundingBox();
    assert.ok(card.x>=0 && card.y>=0 && card.x+card.width<=width+1 && card.y+card.height<=924,`Music card leaves viewport at ${width}`);
    if(width===320)await page.screenshot({path:path.join(screenshots,'attendee-music-mobile.png')});
    if(width===932)await page.screenshot({path:path.join(screenshots,'attendee-music-desktop.png')});
    await page.keyboard.press('Escape');await page.locator('.member-music-popover').waitFor({state:'hidden'});
  }
  await close('detail-dialog');
  for(const width of [320,390,614,932]) {
    await page.setViewportSize({width,height:923});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Board header overflows at ${width}`);
    const link=await page.locator('header a[href="/music/"]').boundingBox();
    const header=await page.locator('.header-inner').boundingBox();
    assert.ok(link.y>=header.y && link.y+link.height<=header.y+header.height);
    const create=await page.locator('#create-button').boundingBox();
    assert.ok(Math.abs(link.y+link.height/2-create.y-create.height/2)<3,`Music link wastes another header row at ${width}`);
    if(width===320)await page.screenshot({path:path.join(screenshots,'board-mobile.png'),fullPage:true});
  }
  await page.setViewportSize({width:1280,height:900});

  assert.ok(await page.locator('.header-inner h1 a, .site-footer a').evaluateAll(nodes=>nodes.every(n=>getComputedStyle(n).textDecorationLine==='none')));
  await choose('.filters',/活動類型|活动类型/,'聚餐');
  assert.equal(await page.locator('#board .event-card').count(),1);
  await choose('.filters',/活動類型|活动类型/,/全部類型|全部类型/);
  await page.screenshot({path:path.join(screenshots,'board-desktop.png'),fullPage:true});
  await page.locator('#create-button').click();await dialog('event-form-dialog');
  await page.locator('#event-form [name=title]').fill('React 表单验证');
  await page.locator('#event-form [name=location]').fill('本机测试场地');
  await choose('#event-form',/類型|类型/,'聚餐');
  assert.equal(await page.locator('#event-form [name=duration_hours]').inputValue(),'2');
  await page.locator('#event-form [name=description]').fill('用户原文：后台後臺 — 不作文字转换');
  // State updates preserve the exact input node and focus.
  await page.locator('#event-form [name=title]').evaluate(node=>window.boardTitleBefore=node);
  await page.locator('#event-form [name=title]').fill('React 表单验证');
  assert.equal(await page.locator('#event-form [name=title]').evaluate(node=>node===window.boardTitleBefore&&node===document.activeElement),true);
  // Drafts survive closing the real React form, including both history layers.
  await page.locator('#event-form-dialog .ui-dialog').getByRole('button',{name:/^(关闭|關閉)$/}).click();
  await dialog('draft-close-dialog');
  await page.locator('#draft-save-close').click();
  await page.locator('#event-form-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('#create-button').click();await dialog('event-form-dialog');
  await page.locator('#event-form .draft-status').getByRole('button',{name:/恢[复復]/,exact:true}).click();
  assert.equal(await page.locator('#event-form [name=title]').inputValue(),'React 表单验证');
  assert.equal(await page.locator('#event-form [name=description]').inputValue(),'用户原文：后台後臺 — 不作文字转换');
  await page.locator('#publish-button').click();await dialog('detail-dialog');
  assert.match(await page.locator('#detail-content').innerText(),/React 表单验证|后台後臺/);
  const eventId=new URL(page.url()).searchParams.get('event');assert.ok(eventId);
  await page.locator('#detail-dialog [data-advanced-toggle]').check();
  await page.locator('[data-roster-action=add]').click();await dialog('party-dialog');
  await page.locator('#add-guest').click();assert.equal(await page.locator('#party-rows .guest-row').count(),2);
  await page.locator('#party-rows [data-remove-guest]').first().click();
  await page.locator('#party-rows [name=guest_name]').fill('同行测试');
  await page.locator('#save-party').click();await wait('#party-preview');
  await page.locator('#save-party').click();await page.locator('#party-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('同行测试'));
  await page.locator('.participant-profile').filter({hasText:'同行测试'}).click();await wait('.member-music-popover');
  await page.getByText(/這份報名尚未關聯|这份报名尚未关联/).waitFor();
  await page.keyboard.press('Escape');await page.locator('.member-music-popover').waitFor({state:'hidden'});
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('[data-detail-action=rooms]').click();await dialog('rooms-dialog');
  await page.locator('#rooms-editor [data-room-add]').click();
  await page.locator('#rooms-editor [data-room-field=name]').fill('React 包间');
  await page.locator('#rooms-editor [data-room-person]').first().click();
  await page.getByRole('option',{name:'React 包间',exact:true}).click();
  await page.locator('#rooms-save').click();await page.locator('#rooms-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('React 包间'));
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('[data-activity=cancel]').click();await dialog('activity-action-dialog');
  await page.locator('#activity-action-form [name=reason]').fill('本机结算回归测试');
  await page.locator('#activity-action-form button[type=submit]').click();await page.locator('#activity-action-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('[data-detail-action=settle]').click();await dialog('invoice-dialog');
  await page.locator('#invoice-form [name=room_mode]').uncheck();
  await page.locator('#invoice-items [data-prop=amount]').fill('120');
  await choose('#invoice-form',/店家款項：實際付款情況|店家款项：实际付款情况/,/尚未支付店家/);
  await page.locator('#invoice-form [name=reviewed_roster]').check();
  await page.locator('#preview-invoice').click();await wait('#invoice-preview');
  assert.match(await page.locator('#invoice-preview').innerText(),/120\.00/);
  // Editing a reviewed amount must invalidate its server preview.
  await page.locator('#invoice-items [data-prop=amount]').fill('121');
  assert.equal(await page.locator('#publish-invoice').count(),0);
  await page.locator('#invoice-items [data-prop=amount]').fill('120');
  await page.locator('#preview-invoice').click();await wait('#invoice-preview');
  await page.locator('#publish-invoice').click();await page.locator('#invoice-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#detail-content')?.textContent.includes('120.00'));
  await page.waitForFunction(()=>!history.state?.kanbanDialog);
  await page.locator('[data-detail-action=finance]').click();await dialog('finance-dialog');
  await page.locator('[data-finance=record]').click();await dialog('finance-form-dialog');
  await choose('#finance-form',/款項類型|款项类型/,/支付店家/);
  await page.locator('#finance-form [name=amount]').fill('120');
  await page.locator('#finance-form [name=merchant]').fill('React 店家付款');
  assert.equal(await page.locator('#finance-form [name=from_id]').count(),0);
  await page.locator('#finance-preview-button').click();await wait('#finance-preview');
  assert.match(await page.locator('#finance-preview').innerText(),/120\.00/);
  await page.locator('#finance-confirm').click();await page.locator('#finance-form-dialog').waitFor({state:'hidden'});
  await page.locator('#finance-dialog').getByRole('button',{name:/支付店家.*120/}).first().click();
  await wait('#finance-dialog .board-finance');
  assert.match(await page.locator('#finance-dialog').innerText(),/React 店家付款/);
  await close('finance-dialog');await close('detail-dialog');
  await page.locator('#create-button').click();await dialog('event-form-dialog');
  await page.locator('#event-form').getByRole('combobox',{name:/類型|类型/,exact:true}).click();
  await wait('[role=listbox]');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#event-form-dialog [role=dialog]').isVisible(),true);
  await close('event-form-dialog');
  await page.locator('[data-poll-action=create]').click();await dialog('time-poll-form-dialog');
  await page.locator('#time-poll-form [name=title]').fill('React 日期投票');
  await page.locator('#time-poll-form [name=location]').fill('本机测试');
  const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
  await page.locator('#poll-slots input[type=date]').nth(0).fill(day(4));
  await page.locator('#poll-slots input[type=date]').nth(1).fill(day(5));
  await page.locator('#time-poll-form').getByRole('button',{name:/增加選項|增加选项/}).click();
  assert.equal(await page.locator('#poll-slots .poll-slot').count(),3);
  await page.locator('#poll-slots .poll-slot').last().getByRole('button',{name:/移除/}).click();
  await page.locator('#time-poll-form [name=deadline_date]').fill(day(2));
  await page.locator('#time-poll-form button[type=submit]').click();await dialog('time-poll-dialog');
  await page.locator('#time-poll-vote-form input[type=radio][value=yes]').first().check();
  await page.locator('#time-poll-vote-form input[type=radio][value=maybe]').last().check();
  await page.locator('#time-poll-vote-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#time-poll-live-status')?.textContent.includes('1 人'));
  await close('time-poll-dialog');
  await page.locator('#profile-button').click();await dialog('profile-dialog');
  await page.locator('#nickname-input').fill('饭团 React');
  await page.locator('#profile-form button[type=submit]').click();await page.locator('#profile-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#my-name')?.textContent.includes('饭团 React'));
  // Browser history restores the same event via the public bot-compatible URL.
  await go('/?event='+eventId);await dialog('detail-dialog');
  assert.match(await page.locator('#detail-dialog [role=dialog]').innerText(),/React 表单验证/);
  for(const width of [320,390,614,768,1245]) {
    await page.setViewportSize({width,height:923});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Board detail overflows at ${width}`);
  }
  await close('detail-dialog');
  await go('/?event='+eventId+'&action=manage');await dialog('detail-dialog');
  assert.equal(await page.locator('#detail-dialog[data-open=true]').count(),1,'Bot management entry opened duplicate detail dialogs');
  assert.equal(await page.locator('#detail-dialog [data-advanced-toggle]').isChecked(),true);
  await close('detail-dialog');
  await page.setViewportSize({width:1280,height:900});

  await go('/music/');await wait('#rankListMain .rank-row');
  await page.locator('#musicLinkCard').waitFor({state:'hidden'});
  assert.equal(await page.locator('#tabBar .tab').count(),5);
  assert.equal(await page.locator('#tabBar [role=tab]').count(),5);
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
  assert.equal(await page.locator('#selChips .music-selection-main input').count(),0);
  assert.equal(await page.locator('#selChips .ui-choice-model, #selChips ui-fragment').count(),0);
  const selectedRow=page.locator('#selChips .music-selection-row:has(input)').first();
  const selectedId=await selectedRow.getAttribute('data-id');
  const levelRadio=selectedRow.locator('input[value="4"]');
  await levelRadio.evaluate(node=>window.selectionRadioBefore=node);
  await levelRadio.check();
  await wait('#mobBar');
  assert.equal(await levelRadio.isChecked(),true);
  assert.equal(await levelRadio.evaluate(node=>node===window.selectionRadioBefore),true,'Changing levels rebuilt the input');
  assert.equal(await levelRadio.evaluate(node=>node===document.activeElement),true,'Changing levels lost keyboard focus');
  await page.locator('#selToggle').click();
  assert.equal(await page.locator('#selBody').isVisible(),false);
  await page.locator('#selToggle').click();
  assert.equal(await levelRadio.isChecked(),true,'Collapsing the panel discarded the draft');
  // Check the reported label-margin leak and viewport-fixed utility positioning.
  for(const width of [320,390,614,920,1245]) {
    await page.setViewportSize({width,height:640});
    const trays=await page.locator('.music-selection-level-options').evaluateAll(nodes=>nodes.map(node=>{
      const rect=node.getBoundingClientRect(),labels=[...node.querySelectorAll('label')];
      return {top:labels[0].getBoundingClientRect().top-rect.top,
        bottom:rect.bottom-labels.at(-1).getBoundingClientRect().bottom,
        margins:labels.map(label=>getComputedStyle(label).margin)};
    }));
    assert.ok(trays.length && trays.every(tray=>tray.top===6 && tray.bottom===6 && tray.margins.every(margin=>margin==='0px')),`Extra segmented spacing at ${width}px: ${JSON.stringify(trays)}`);
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    await wait('#toTop');
    const top=await page.locator('#toTop').boundingBox(), dock=await page.locator('#mobBar').boundingBox();
    assert.equal(await page.locator('#toTop').evaluate(node=>getComputedStyle(node).position),'fixed');
    assert.ok(top.x>0 && Math.abs(width-top.x-top.width-16)<=1,`Back-to-top is not at the right edge at ${width}px`);
    assert.ok(top.y>=0 && top.y+top.height+15<=dock.y,'Back-to-top overlaps the save dock');
    if(width<=800)assert.ok(dock.y+dock.height<=(await page.locator('#tabBar').boundingBox()).y,'Save dock overlaps navigation');
    await page.locator('#toast').waitFor({state:'hidden'});
    await page.screenshot({path:path.join(screenshots,`music-react-selection-${width}.png`)});
    await page.locator('#toTop').click();
    await page.waitForFunction(()=>window.scrollY<1);
    await page.locator('#toTop').waitFor({state:'hidden'});
  }
  await page.setViewportSize({width:1280,height:900});
  // A rejected save leaves the React draft and save action available.
  const failSave=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试保存失败'})});
  await page.route('**/music/api/selection',failSave);
  await page.locator('#mobSave').click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('测试保存失败'));
  await page.unroute('**/music/api/selection',failSave);
  assert.equal(await levelRadio.isChecked(),true);
  assert.equal(await page.locator('#mobSave').isEnabled(),true);
  assert.equal(new URL(page.url()).hash,'#mine');
  // Editing account contact must keep selection drafts and show errors beside the form.
  await page.locator('#musicContactDetails [data-ui-summary]').click();
  assert.equal(await page.locator('#musicContactDetails [data-ui-summary]').getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#musicContactDetails').evaluate(n=>n.open),true);
  const originalContact=await page.locator('#musicContactQQ').inputValue();
  await page.locator('#musicContactQQ').fill('invalid');
  await page.locator('#musicContactSave').click();
  await page.waitForFunction(()=>document.querySelector('#musicContactError').textContent.length>0);
  assert.equal(await page.locator('#musicLinkCard').isVisible(),false);
  assert.equal(await page.locator('#musicContactError').isVisible(),true);
  await page.locator('#musicContactQQ').fill(originalContact);
  await page.locator('#musicContactSave').click();
  await page.waitForFunction(()=>document.querySelector('#musicContactError').textContent==='已保存');
  assert.equal(await page.locator('#musicContactDetails [data-ui-summary]').getAttribute('aria-expanded'),'true');
  assert.equal(new URL(page.url()).hash,'#mine');
  assert.equal(await page.locator('#mobBar').isVisible(),true);

  // The API acknowledges only its submitted revision, even when a user keeps editing.
  let releaseSave, submitted;
  const saveGate=new Promise(resolve=>releaseSave=resolve);
  const holdSave=async route=>{submitted=route.request().postDataJSON();const response=await route.fetch();await saveGate;await route.fulfill({response});};
  await page.route('**/music/api/selection',holdSave);
  await page.locator('#mobSave').click();
  await page.waitForFunction(()=>document.querySelector('#mobSave').disabled);
  await selectedRow.locator('input[value="2"]').check();
  releaseSave();
  await page.waitForFunction(()=>!document.querySelector('#mobSave').disabled);
  await page.unroute('**/music/api/selection',holdSave);
  assert.equal(submitted.selection.find(entry=>entry.id===selectedId).level,4);
  assert.equal(await selectedRow.locator('input[value="2"]').isChecked(),true);
  assert.equal(new URL(page.url()).hash,'#mine','A late response navigated away from a newer draft');
  assert.equal(await page.locator('#mobBar').isVisible(),true);
  const savedRequest=page.waitForRequest(request=>request.url().endsWith('/music/api/selection') && request.method()==='POST');
  await page.locator('#mobSave').click();await wait('#page-matches.active');
  assert.equal((await savedRequest).postDataJSON().selection.find(entry=>entry.id===selectedId).level,2);
  assert.match(await page.locator('#page-matches').innerText(),/同好|匹配/);
  await page.locator('#mobBar').waitFor({state:'hidden'});
  // A page reload uses the persisted payload, not an in-memory selection model.
  await go('/music/#mine');await wait('#selectionCard');
  assert.equal(await page.locator(`.music-selection-row[data-id="${selectedId}"] input[value="2"]`).isChecked(),true);
  await page.locator('#mobBar').waitFor({state:'hidden'});
  for(const width of [390,1245]) {
    await page.setViewportSize({width,height:640});
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await wait('#toTop');
    const top=await page.locator('#toTop').boundingBox();
    assert.ok(Math.abs(top.x+top.width-(width-16))<=1);
    if(width<=800)assert.ok(top.y+top.height<=(await page.locator('#tabBar').boundingBox()).y);
    else assert.ok(Math.abs(top.y+top.height-620)<=1,'Saved desktop top button has an unnecessary dock offset');
    await page.locator('#toTop').click();await page.waitForFunction(()=>window.scrollY<1);
  }
  await page.setViewportSize({width:1280,height:900});
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
      await page.locator('#eventMode .ui-segmented').getByRole('radio',{name:'自定义',exact:true}).check();
      await page.locator('#eventSizes').fill('1,1');
      await page.locator('#eventSplit').click();
      await page.waitForFunction(()=>document.querySelector('#eventSplitHint').textContent.includes('自定义人数'));
      await page.locator('#eventMode .ui-segmented').getByRole('radio',{name:'按人数',exact:true}).check();
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
  await page.locator('[data-user-metadata]').first().click();await wait('#users-metadata[data-open=true] [role=dialog]');
  await page.locator('#users-metadata-form [name=note]').fill('React 管理表单');
  await page.locator('#users-metadata-form button[type=submit]').click();
  await page.locator('#users-metadata').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#admin-users').textContent.includes('React 管理表单'));
  assert.match(await page.locator('#admin-users').innerText(),/React 管理表单/);
  assert.equal(await page.locator('ui-fragment, .ui-choice-model').count(),0);
  // Permission changes always stay behind an explicit confirmation.
  await page.locator('#admin-users .admin-user button:enabled').filter({hasText:/撤[销銷]管理[员員]|[设設][为為]管理[员員]/}).filter({visible:true}).last().click();
  await dialog('users-confirm');
  await page.locator('#users-confirm [role=dialog]').getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('#users-confirm').waitFor({state:'hidden'});
  const bot=page.locator('#bot-settings-form');
  await choose('#bot-settings-form',/發送模式|发送模式/,/模[拟擬]，不[实實][际際][发發]送/);
  await bot.getByRole('button',{name:/手[动動]添加群[标標][识識]/}).click();
  await bot.getByRole('textbox',{name:/群[标標][识識]/,exact:true}).fill('react_ui_group');
  await bot.getByRole('button',{name:/添加到待保存列表/}).click();
  await page.locator('#bot-groups').getByRole('textbox',{name:/管理[备備][注註]/}).last().fill('React 测试群');
  await page.locator('#bot-groups').getByRole('checkbox',{name:/允[许許]此群 @ 回[复覆]/}).last().check();
  await bot.getByRole('button',{name:/消息模板/}).click();
  await page.locator('#bot-template-text').fill('React 模板 {title}\n{url}');
  await page.locator('#bot-preview').click();await wait('#bot-settings-form .bot-preview');
  assert.match(await page.locator('#bot-settings-form .bot-preview').innerText(),/React 模板/);
  await page.locator('#bot-template-text').fill('React 新模板 {title}\n{url}');
  assert.equal(await page.locator('#bot-settings-form .bot-preview').count(),0,'Edited settings retained a stale preview');
  await page.locator('#bot-preview').click();await wait('#bot-settings-form .bot-preview');
  await bot.getByRole('button',{name:/保存机[器]?人[设設]置|保存機器人設置|保存机器人设置/}).click();
  await page.waitForFunction(()=>document.querySelector('.react-admin').textContent.includes('等待') && !document.querySelector('#bot-settings-form').inert);
  await bot.getByRole('button',{name:/重新[载載]入/,exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#bot-template-text')?.value.startsWith('React 新模板'));
  assert.equal(await page.locator('#bot-template-text').inputValue(),'React 新模板 {title}\n{url}');
  assert.equal(await page.locator('#bot-settings-form [name=dry_run]').inputValue(),'simulate');
  assert.equal(await page.locator('#bot-groups').getByRole('textbox',{name:/管理[备備][注註]/}).last().inputValue(),'React 测试群');
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
      await page.locator('#selChips .music-selection-level input:not(:checked)').first().check();
      await wait('#mobBar');
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
    console.error((await activePage.locator('[data-react-dialog] [role=dialog], dialog[open], #musicLinkError, #toast').allTextContents()).join('\n'));
    console.error(await activePage.locator(':invalid').evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName,name:n.name,message:n.validationMessage}))));
  }
  throw error;
} finally {
  await browser?.close();
  fixture.kill('SIGTERM');
  await new Promise(resolve=>fixture.once('exit',resolve));
  await fs.rm(temp,{recursive:true,force:true});
}
