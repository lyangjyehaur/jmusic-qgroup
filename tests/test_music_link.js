import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

async function screen(state, authenticated, complete = false) {
  const elements = new Map(), hooks = {}, requests = [], navigations=[];
  const el = id => {
    if (!elements.has(id)) elements.set(id, {value:'',checked:false,hidden:false,disabled:false,textContent:'',
      addEventListener(type, fn) { this[type] = fn; }});
    return elements.get(id);
  };
  const context = vm.createContext({
    document:{getElementById:el,addEventListener:(event,fn)=>{hooks[event]=fn;}},
    window:{addEventListener(){}}, crypto:{randomUUID:()=> 'test-request'},
    location:{assign:url=>navigations.push(url),replace:url=>navigations.push(url)},
    fetch:async (path, options) => {
      requests.push({path, body: options.body && JSON.parse(options.body),headers:options.headers});
      return {ok:true,json:async()=>path==='/music/api/session'?state:path==='/api/me'?
        {authenticated,draft_scope:'scope',privacy_version:'version'}:
        {complete,authorize_url:'https://example.test/authorize'}};
    }
  });
  vm.runInContext(fs.readFileSync('music_site/public/link.js','utf8'),context);
  hooks.DOMContentLoaded();
  await new Promise(resolve=>setImmediate(resolve));
  return {el,requests,navigations};
}
for (const [state, authenticated, expected] of [
  [{authenticated:false,board_authenticated:false},false,'login'],
  [{authenticated:true,linked:false,board_authenticated:true,qq:'10001'},true,'bind'],
  [{authenticated:true,linked:true,qq_connected:false,board_authenticated:true,qq:'m_abc'},true,'bind'],
  [{authenticated:false,board_authenticated:false},true,'bind']
]) {
  const {el,requests,navigations}=await screen(state,authenticated);
  el('musicPrivacy').checked=true;
  el('musicEntryQQ').value='23456789';
  await el('musicEntryForm').submit({preventDefault(){}});
  const oauth=requests.find(r=>r.path==='/api/auth/qq/start');
  assert.equal(oauth.body.mode,expected);
  assert.equal(oauth.body.return_path,'/music/');
  assert.equal(oauth.headers['X-Kanban-Identity'],'scope');
  assert.equal(requests.some(r=>r.path==='/music/api/link/start'),state.authenticated===true && !state.linked);
  if (!state.authenticated || state.linked) {
    assert.equal(requests.find(r=>r.path==='/music/api/entry/start').body.contactQQ,'23456789');
  }
  assert.deepEqual(navigations,['https://example.test/authorize']);
}
{
  const {el,requests,navigations}=await screen({board_authenticated:true,qq_connected:true,board_name:'board user'},true,true);
  assert.equal(el('musicEntryForm').hidden,false);
  assert.equal(el('musicNewName').value,'board user');
  await el('musicEntryForm').submit({preventDefault(){}});
  assert.equal(requests.some(r=>r.path==='/music/api/entry/start'),false);
  el('musicPrivacy').checked=true;
  el('musicEntryQQ').value='invalid';
  await el('musicEntryForm').submit({preventDefault(){}});
  assert.equal(requests.some(r=>r.path==='/music/api/entry/start'),false);
  el('musicEntryQQ').value='';
  await el('musicEntryForm').submit({preventDefault(){}});
  assert.deepEqual(requests.find(r=>r.path==='/music/api/entry/start').body,{name:'board user',consent:true,contactQQ:''});
  assert.equal(requests.some(r=>r.path==='/api/auth/qq/start'),false);
  assert.deepEqual(navigations,['/music/']);
}
for (const key of ['pending_entry','pending']) {
  const {el,requests,navigations}=await screen({[key]:true,entry_name:'draft',entry_contactQQ:'23456789'},true);
  assert.equal(el('musicEntryButton').disabled,true);
  assert.equal(el('musicCancelLink').hidden,false);
  assert.equal(requests.some(r=>r.path===`/music/api/${key==='pending_entry'?'entry':'link'}/complete`),true);
  assert.deepEqual(navigations,['/music/']);
}
for (const number of ['34567890','']) {
  const {el,requests,navigations}=await screen({authenticated:true,linked:true,qq_connected:true,qq:'m_abc',contactQQ:'23456789'},true);
  assert.equal(el('musicEntryForm').hidden,true);
  assert.equal(el('musicContactDetails').hidden,false);
  el('musicContactQQ').value=number;
  await el('musicContactForm').submit({preventDefault(){}});
  assert.deepEqual(requests.find(r=>r.path==='/music/api/profile/contact').body,{contactQQ:number});
  assert.deepEqual(navigations,['/music/']);
}
{
  const {el}=await screen({authenticated:true,linked:true,qq_connected:true,qq:'10001',contactQQ:'10001'},true);
  assert.equal(el('musicContactDetails').hidden,true);
}
const labels=vm.createContext({window:{}});
vm.runInContext(fs.readFileSync('music_site/public/member-id.js','utf8'),labels);
const mid='m_'+'a'.repeat(24), w=labels.window;
assert.equal(w.musicMemberKind('10001'),'QQ 号');
assert.equal(w.musicMemberKind(mid),'成分 ID');
w.musicRememberContacts({members:[{qq:mid,contactQQ:'23456789'}]});
assert.equal(w.musicMemberValue(mid),'23456789');
assert.equal(w.musicMemberLabel(mid),'QQ 号 23456789（自填）');
w.musicRememberContacts({qq:mid,contactQQ:''});
assert.equal(w.musicMemberValue(mid),mid);
assert.equal(w.musicMemberKind(mid),'成分 ID');
const html=fs.readFileSync('music_site/public/index.html','utf8');
assert.equal(html.includes('musicCreateButton'),false);
assert.equal(html.includes('musicQQButton'),false);
assert.equal((html.match(/id="musicEntryButton"/g)||[]).length,1);
console.log('Unified entry, consent, optional QQ, old-profile binding, auto-completion, contact editing and copy labels passed.');
