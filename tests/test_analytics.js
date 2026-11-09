import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag,attrs={},parent=null) {
    this.tagName=tag.toUpperCase();this.attrs=attrs;this.parent=parent;
    this.id=attrs.id||'';this.name=attrs.name||'';this.type=attrs.type||'';
    this.classList=(attrs.class||'').split(' ').filter(Boolean);
    this.dataset={close:attrs['data-close']};this.open=false;this.checked=false;
  }
  getAttribute(key){return this.attrs[key]??null;}
  hasAttribute(key){return key in this.attrs;}
  matches(selector) {
    return selector.split(',').some(part=>{
      if(part.startsWith('.'))return this.classList.includes(part.slice(1));
      const match=part.match(/^(\w+)?(?:\[([^=\]]+)(?:=([^\]]+))?\])?$/);
      return !!match&&(!match[1]||match[1].toUpperCase()===this.tagName)&&(!match[2]||(this.hasAttribute(match[2])&&(match[3]===undefined||this.getAttribute(match[2])===match[3])));
    });
  }
  closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
}
function page(href='https://kanban.danndann.cn/?event=PRIVATE_EVENT&invite=SECRET_INVITE#SECRET_HASH') {
  const listeners={},windowListeners={},events=[],timers=new Map();let timerId=0,observer;
  const form=new Element('form',{id:'event-form'}),dialog=new Element('dialog',{id:'event-form-dialog'});
  form.parent=dialog;
  const field=new Element('input',{id:'nickname-input',name:'nickname',type:'text'},form);
  field.value='PRIVATE_NAME';
  const location=new URL(href);
  const history={};
  for(const method of ['pushState','replaceState'])history[method]=(_state,_unused,url)=>{if(url)location.href=new URL(url,location.href).href;return 'unchanged';};
  const box={URL,Promise,Set,WeakMap,location,history,screen:{width:1200,height:800},navigator:{language:'zh-TW'},
    localStorage:{getItem:()=>null},
    setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
    MutationObserver:class {constructor(fn){observer=fn;}observe(){}},
    document:{title:'PRIVATE_TITLE',referrer:'https://example.com/PRIVATE_REFERRER?token=SECRET',documentElement:{lang:'zh-Hant'},
      querySelectorAll:selector=>selector==='[id]'?[form,dialog,field]:[field],
      addEventListener:(name,fn)=>{(listeners[name]??=[]).push(fn);}},
    addEventListener:(name,fn)=>{(windowListeners[name]??=[]).push(fn);},
  };
  box.window=box;box.top=box;
  vm.createContext(box);vm.runInContext(fs.readFileSync('public/analytics.js','utf8'),box);
  const emit=(name,target,extra={})=>(listeners[name]||[]).forEach(fn=>fn({target,...extra}));
  const tick=()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());};
  function load() {
    if(process.env.UMAMI_SCRIPT) {
      // Optional contract check against the actual deployed Umami client; no requests leave this VM.
      box.document.currentScript={src:'https://u.danndann.cn/script.js',getAttribute:key=>({'data-website-id':'5244d326-3db9-4499-9c7a-6e3568b296cd','data-domains':'kanban.danndann.cn','data-auto-track':'false','data-exclude-search':'true','data-exclude-hash':'true'}[key]??null)};
      box.fetch=async(_url,options)=>{events.push(JSON.parse(options.body).payload);return {json:async()=>({})};};
      vm.runInContext(fs.readFileSync(process.env.UMAMI_SCRIPT,'utf8'),box);
    } else box.umami={track:fn=>{events.push(fn({url:location.href,title:'PRIVATE_TITLE',referrer:'PRIVATE_REFERRER'}));}};
    emit('load',new Element('script'));
  }
  return {box,events,emit,tick,load,form,dialog,field,windowListeners,mutate:records=>observer(records),timers};
}

const p=page();
assert.equal(p.events.length,0); // Buffer the initial view until Umami is ready.
p.load();
assert.equal(p.events.length,1);assert.equal(p.events[0].url,'/event');assert.equal(p.events[0].name,undefined);
const dynamic=new Element('button',{'data-roster-action':'manage','data-person':'PRIVATE_PERSON'},p.dialog);
p.emit('click',new Element('svg',{},dynamic));
assert.equal(p.events.at(-1).name,'ui_click');assert.equal(p.events.at(-1).data.control,'roster-action:manage');
assert.equal(p.events.at(-1).data.context,'event-form-dialog');
dynamic.disabled=true;const before=p.events.length;p.emit('click',dynamic);assert.equal(p.events.length,before);
p.emit('input',p.field);p.emit('input',p.field);p.tick();
assert.equal(p.events.filter(e=>e.name==='ui_input').length,1);
p.emit('input',p.field);p.emit('change',p.field);p.tick();
assert.equal(p.events.filter(e=>e.name==='ui_input').length,1);
assert.equal(p.events.at(-1).name,'ui_change');
const checkbox=new Element('input',{type:'checkbox','data-advanced-toggle':''},p.dialog);checkbox.checked=true;
p.emit('change',checkbox);assert.equal(p.events.at(-1).data.checked,true);
p.emit('submit',p.form,{submitter:new Element('button',{type:'submit'},p.form)});
assert.equal(p.events.at(-1).name,'ui_submit');
p.emit('invalid',p.field);assert.equal(p.events.at(-1).name,'ui_invalid');
const details=new Element('details',{class:'invoice-person'},p.dialog);details.textContent='PRIVATE_NAME ¥123';details.open=true;
p.emit('toggle',details);assert.equal(p.events.at(-1).name,'ui_expand');assert.equal(p.events.at(-1).data.control,'invoice-person');
details.open=false;p.emit('toggle',details);assert.equal(p.events.at(-1).name,'ui_collapse');
p.dialog.open=true;p.dialog.attrs.open='';p.mutate([{type:'attributes',target:p.dialog,oldValue:null}]);
assert.equal(p.events.at(-1).name,'dialog_open');
p.dialog.open=false;delete p.dialog.attrs.open;p.mutate([{type:'attributes',target:p.dialog,oldValue:''}]);
assert.equal(p.events.at(-1).name,'dialog_close');
p.emit('cancel',p.dialog);assert.equal(p.events.at(-1).name,'dialog_cancel');
assert.equal(p.box.history.pushState({},'',p.box.location.href),'unchanged');
assert.equal(p.events.filter(e=>!e.name).length,1); // Modal history does not inflate views.
p.box.history.pushState({},'','/?event=ANOTHER_PRIVATE_EVENT&claim=SECRET_CLAIM');
assert.equal(p.events.filter(e=>!e.name).length,2);assert.equal(p.events.at(-1).url,'/event');
p.box.history.replaceState({},'','/');assert.equal(p.events.at(-1).url,'/');
p.box.location.href='https://kanban.danndann.cn/?event=PRIVATE_EVENT&account_link=SECRET_ACCOUNT';
p.windowListeners.popstate.forEach(fn=>fn());assert.equal(p.events.at(-1).url,'/event');
p.box.BoardAnalytics.request('/api/events/PRIVATE_EVENT/claims/SECRET_CLAIM/request?invite=SECRET','POST',409,'rejected');
assert.equal(p.events.at(-1).name,'api_result');
assert.equal(p.events.at(-1).data.operation,'/api/events/:id/claims/:id/request');
const n=p.events.length;p.box.BoardAnalytics.request('/api/events','GET',200,'success');assert.equal(p.events.length,n);
const password=new Element('input',{type:'password',name:'key'},p.form);password.value='SECRET_ADMIN_KEY';
p.emit('input',password);p.emit('change',password);p.emit('invalid',password);p.tick();assert.equal(p.events.length,n);
p.box.BoardAnalytics.request('/api/auth/qq/start','POST',200,'success');
assert.equal(p.events.at(-1).data.operation,'/api/auth/qq/start');
p.box.BoardAnalytics.request('/api/admin/privacy-review','POST',200,'success');
assert.equal(p.events.at(-1).data.operation,'/api/admin/privacy-review');
assert.doesNotMatch(JSON.stringify(p.events),/PRIVATE|SECRET|123/);
const guide=page('https://kanban.danndann.cn/guide.html');guide.load();
assert.equal(guide.events[0].url,'/guide.html');
const section=new Element('details',{class:'guide-topic'});section.open=true;guide.emit('toggle',section);
assert.equal(guide.events.at(-1).data.page,'guide');
for(const [path,expected] of [['/privacy','privacy'],['/contact','contact'],['/admin','admin'],['/auth/qq/callback','qq-callback']]){
 const other=page('https://kanban.danndann.cn'+path+'?code=SECRET_CODE');other.load();
 assert.equal(other.events[0].url,path);other.emit('click',new Element('button'));
 assert.equal(other.events.at(-1).data.page,expected);assert.doesNotMatch(JSON.stringify(other.events),/SECRET/);
}
for(const name of ['index','guide','privacy','contact','admin']){
 const html=fs.readFileSync('public/'+name+'.html','utf8');
 assert.match(html,/<script async src="https:\/\/u\.danndann\.cn\/script\.js"/);
 assert.match(html,/data-auto-track="false"/);
 assert.match(html,/\/analytics\.js\?v=20261109-umami2/);
}
const offline=page();for(let i=0;i<120;i++)offline.emit('click',new Element('button'));
for(let i=0;i<40;i++)offline.tick();assert.equal(offline.timers.size,0);
offline.load();assert.equal(offline.events.length,100); // Bound buffering if the tracker is blocked.
if(process.env.UMAMI_SCRIPT){const local=page('http://127.0.0.1:8792/');local.load();local.emit('click',new Element('button'));assert.equal(local.events.length,0);}
p.box.umami.track=()=>{throw new Error('blocked');};dynamic.disabled=false;assert.doesNotThrow(()=>p.emit('click',dynamic));
console.log('Analytics: dynamic interactions, safe payloads, virtual views, delayed/blocked tracker passed');
