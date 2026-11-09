'use strict';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Exercise the exact bundles shipped to browsers, including canonical protocol
// values and native validation when the device itself speaks another language.
for(const [folder,lang,category,required] of [
  ['hans','zh-Hans','运动','请填写这个栏位。'],
  ['hant','zh-Hant','運動','請填寫這個欄位。'],
]) {
  const listeners={};
  const context=vm.createContext({document:{documentElement:{lang},addEventListener:(type,handler)=>{listeners[type]=handler;}}});
  vm.runInContext(fs.readFileSync(`public/locales/${folder}/i18n.js`,'utf8')+';this.i18n=BoardI18n;',context);
  assert.equal(context.i18n.locale,lang);
  assert.equal(context.i18n.category('运动'),category);
  assert.equal(context.i18n.category('自定义后台後臺'),'自定义后台後臺');
  const field={tagName:'INPUT',type:'text',validity:{valueMissing:true},message:'',setCustomValidity(value){this.message=value;this.validity.customError=!!value;}};
  listeners.invalid({target:field});assert.equal(field.message,required);
  listeners.input({target:field});assert.equal(field.message,'');
  field.setCustomValidity('业务原文');listeners.invalid({target:field});assert.equal(field.message,'业务原文');
  const html=fs.readFileSync(`public/locales/${folder}/index.html`,'utf8');
  assert.match(html,/<option value="运动">/); // Localized label retains submitted value.
  assert.match(html,new RegExp(`<html lang="${lang}"`));
  const settlementContext=vm.createContext({});
  vm.runInContext(fs.readFileSync(`public/locales/${folder}/settlements.js`,'utf8'),settlementContext);
  const input=[{id:'x',name:'后台原话 · 後臺',amount:'100',scope:'common',mode:'shares',note:'报名须知',allocations:[]}];
  const output=JSON.parse(JSON.stringify(settlementContext.settlementItemsPayload(input,[{id:'a'}],3)));
  assert.equal(output[0].name,input[0].name);
  assert.equal(output[0].note,input[0].note);
  const codeContext=vm.createContext({});
  vm.runInContext(fs.readFileSync(`public/locales/${folder}/payment-codes.js`,'utf8')+';this.cards=settlementCodeCards;',codeContext);
  const name='后台後臺 <test>';
  const cards=codeContext.cards({payment_codes:[{kind:'alipay',name,url:'/api/events/abc/image'}]},value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'));
  assert.match(cards,folder==='hans'?/支付宝/:/支付寶/);
  assert.ok(cards.includes('后台後臺 &lt;test&gt;'));
  assert.ok(!cards.includes('/api/payment-codes/'));
  const allCodes=['wechat','alipay','other'].map(kind=>({kind,name,url:'/api/events/abc/'+kind}));
  const all=codeContext.cards({payment_codes:allCodes},value=>value);
  assert.match(all,/class="settlement-codes" data-count="3"/);
  assert.equal((all.match(/<img /g)||[]).length,3);
  assert.ok(!all.includes('<details'));
  assert.equal(codeContext.cards({payment_codes:[]},value=>value),'');
  const pickerListeners={},container={innerHTML:'',querySelector:()=>null,addEventListener:(type,handler)=>pickerListeners[type]=handler};
  const picker=codeContext.createPaymentCodePicker({$:()=>container,esc:value=>value});
  picker.open({id:'abc',settlement:{version:2,payment_codes:allCodes}},[]);
  const visible=container.innerHTML.slice(0,container.innerHTML.indexOf('<details'));
  assert.equal((visible.match(/<img /g)||[]).length,3);
  assert.equal((container.innerHTML.match(/data-code-select=/g)||[]).length,3);
  assert.ok(!container.innerHTML.includes('data-code-kind'));
  picker.restore([{kind:'wechat',version:2}]);
  assert.equal((container.innerHTML.match(/<img /g)||[]).length,1);

  const roster=fs.readFileSync(`public/locales/${folder}/roster.js`,'utf8');
  vm.runInContext(roster.slice(roster.indexOf('  function fieldValue('),roster.indexOf('  async function history('))+';this.fieldValue=fieldValue;',context);
  assert.equal(context.fieldValue('category','运动'),category);
  assert.equal(context.fieldValue('location','后台後臺'),'后台後臺');
  const app=fs.readFileSync(`public/locales/${folder}/app.js`,'utf8');
  const dates=app.slice(app.indexOf('const deviceZone='),app.indexOf('function formStart()'));
  const dateContext=vm.createContext({Intl,Date,Error,BoardI18n:context.i18n});
  vm.runInContext(dates+';this.dates={wallToISO,timeRange};',dateContext);
  assert.equal(dateContext.dates.wallToISO('2027-01-01T00:15','Asia/Shanghai'),'2026-12-31T16:15:00.000Z');
  assert.match(dateContext.dates.timeRange({starts_at:'2026-12-31T15:00Z',ends_at:'2026-12-31T17:00Z',timezone:'Asia/Shanghai'}),/1月1日/);
}
console.log('Both shipped language bundles: category protocol, validation, original settlement values and cross-day dates passed');
