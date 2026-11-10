import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture({me={},stored=new Map(),session=new Map(),storageFails=false}={}) {
 const elements=new Map(),listeners={},timers=[],calls=[],toasts=[],navigation=[],confirmed=[];
 const $=selector=>{
  if(!elements.has(selector))elements.set(selector,{open:false,innerHTML:'',textContent:'',value:'',checked:false,disabled:false,querySelector:()=>null});
  return elements.get(selector);
 };
 const state={me:{authenticated:true,draft_scope:'account-a',nickname:'成员',privacy_accepted:true,privacy_version:'2026-11-10',
  qq:{enabled:true,bound:true,needs_reauth:true,unionid_bound:false,nickname:'原QQ <script>',avatar_url:''},...me},events:[]};
 const storage=map=>({getItem:key=>{if(storageFails)throw Error('disabled');return map.get(key)??null;},setItem:(key,value)=>{if(storageFails)throw Error('disabled');map.set(key,String(value));},removeItem:key=>{if(storageFails)throw Error('disabled');map.delete(key);}});
 const document={addEventListener:(kind,handler)=>{(listeners[kind]??=[]).push(handler);},
  querySelector:()=>[...elements.values()].find(el=>el.open)||null,
  querySelectorAll:()=>[...elements.values()].filter(el=>el.open)};
 const location={pathname:'/',search:'?event=preserved&invite=kept',href:'https://board.test/?event=preserved&invite=kept',assign:url=>navigation.push(url),replace:url=>navigation.push(url)};
 const api=async(path,method,data)=>{
  calls.push({path,method,data});
  if(path==='/api/auth/qq/start')return {authorize_url:'https://graph.qq.com/authorize'};
  if(path==='/api/auth/qq/status')return {status:'verified',mode:'bind',attempt_id:'verified-attempt',qq_nickname:'原QQ',current_nickname:'成员'};
  if(path==='/api/auth/qq/finish')return {ok:true,return_path:'/?event=preserved&invite=kept'};
  throw Error('Unexpected API '+path);
 };
 const context=vm.createContext({document,localStorage:storage(stored),sessionStorage:storage(session),Date,Set,URL,
  location,history:{replaceState(){}},crypto:{randomUUID:()=> 'operation-id'},setTimeout:fn=>timers.push(fn),
  BoardClient:{setIdentity(){}},
 });
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 vm.runInContext(fs.readFileSync('public/identity.js','utf8'),context);
 const ui=context.createIdentityUI({api,$,esc,state,showDialog:id=>{$('#'+id).open=true;},toast:message=>toasts.push(message),
  askConfirm:(title,body,callback)=>confirmed.push({title,body,callback})});
 for(const selector of ['#identity-dialog','#profile-dialog'])$(selector).close=()=>{$(selector).open=false;for(const handler of listeners.close||[])handler();};
 const click=async action=>{
  const button={dataset:{identity:action},disabled:false};
  for(const handler of listeners.click||[])await handler({target:{closest:selector=>selector==='[data-identity]'?button:null}});
  return button;
 };
 const tick=()=>{for(const timer of timers.splice(0))timer();};
 return {ui,state,$,stored,session,calls,toasts,navigation,confirmed,click,tick};
}

const prompt=fixture();prompt.ui.initQQRefresh();
assert.equal(prompt.$('#identity-dialog').open,true);
assert.match(prompt.$('#identity-content').innerHTML,/bot/);
assert.match(prompt.$('#identity-content').innerHTML,/稍后处理不影响网站使用/);
assert.match(prompt.$('#identity-content').innerHTML,/原QQ &lt;script&gt;/);
assert.equal(prompt.calls.length,0,'Showing the guide does not log out or start authorization');
await prompt.click('qq-refresh');
assert.equal(prompt.confirmed.length,0,'The explicit relogin button starts OAuth directly');
assert.equal(prompt.calls.length,1);assert.equal(prompt.calls[0].path,'/api/auth/qq/start');
assert.equal(prompt.calls[0].data.mode,'bind','Refresh cannot silently switch to a different QQ account');
assert.equal(prompt.calls[0].data.return_path,'/?event=preserved&invite=kept');
assert.equal(prompt.navigation[0],'https://graph.qq.com/authorize');

const later=fixture();later.ui.initQQRefresh();await later.click('qq-refresh-later');later.tick();
assert.equal(later.$('#identity-dialog').open,false);assert.equal(later.calls.length,0);
const reload=fixture({stored:later.stored});reload.ui.initQQRefresh();
assert.equal(reload.$('#identity-dialog').open,false,'Deferring survives page reload');
const tomorrow=fixture({stored:new Map([['kanban-qq-reauth-v1:account-a',String(Date.now()-25*3600*1000)]])});tomorrow.ui.initQQRefresh();
assert.equal(tomorrow.$('#identity-dialog').open,true);
const otherAccount=fixture({me:{draft_scope:'account-b'},stored:later.stored});otherAccount.ui.initQQRefresh();
assert.equal(otherAccount.$('#identity-dialog').open,true,'Cooldown is per account');

for(const me of [{authenticated:false},{qq:{enabled:true,bound:false,needs_reauth:false}},
 {qq:{enabled:false,bound:true,needs_reauth:true}},{qq:{enabled:true,bound:true,needs_reauth:false,unionid_bound:true}}]){
 const f=fixture({me});f.ui.initQQRefresh();assert.equal(f.$('#identity-dialog').open,false);
}
const form=fixture();form.$('#profile-dialog').open=true;form.ui.initQQRefresh();
assert.equal(form.$('#identity-dialog').open,false,'Do not interrupt existing dialogs or forms');
form.$('#profile-dialog').close();form.tick();assert.equal(form.$('#identity-dialog').open,true);
const noStorage=fixture({storageFails:true});noStorage.ui.initQQRefresh();await noStorage.click('qq-refresh-later');noStorage.tick();
assert.equal(noStorage.$('#identity-dialog').open,false,'Storage failure does not cause a popup loop');

const noUnion=fixture({session:new Map([['kanban-qq-authorized','refresh']])});noUnion.ui.initQQRefresh();
assert.equal(noUnion.$('#identity-dialog').open,false,'A completed OAuth that still lacks UnionID cannot cause a relogin loop');
assert.match(noUnion.toasts[0],/QQ 资料未补齐/);
await noUnion.click('qq-refresh-info');assert.equal(noUnion.$('#identity-dialog').open,true,'Manual retry remains available during cooldown');
const success=fixture({me:{qq:{enabled:true,bound:true,needs_reauth:false,unionid_bound:true}},session:new Map([['kanban-qq-authorized','refresh']])});success.ui.initQQRefresh();
assert.equal(success.$('#identity-dialog').open,false);assert.match(success.toasts[0],/已更新/);

const consent=fixture({me:{privacy_accepted:false}});consent.ui.initQQRefresh();
await consent.click('qq-refresh');assert.equal(consent.calls.length,0);assert.match(consent.$('#identity-error').textContent,/隐私政策/);
consent.$('#privacy-consent').checked=true;await consent.click('qq-refresh');assert.equal(consent.calls.length,1);
const dirty=fixture();dirty.ui.initQQRefresh();dirty.$('#profile-dialog').open=true;dirty.$('#nickname-input').value='未保存';
await dirty.click('qq-refresh');assert.equal(dirty.calls.length,0);assert.match(dirty.toasts[0],/先保存/);

const returning=fixture({session:new Map([['kanban-qq-refresh-scope','account-a']])});
await returning.ui.receiveQQ();returning.$('#qq-confirm').checked=true;await returning.click('qq-finish');
assert.equal(returning.session.get('kanban-qq-authorized'),'refresh');
assert.equal(returning.navigation[0],'/?event=preserved&invite=kept');
assert.equal(returning.session.has('kanban-qq-refresh-scope'),false);
console.log('QQ refresh guide: eligibility, bot impact, direct safe reauth, consent, deferral, account isolation and missing-provider loop prevention passed');
