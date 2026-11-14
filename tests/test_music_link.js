import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

async function screen(state, authenticated) {
  const elements = new Map(), hooks = {}, requests = [];
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {value:'',checked:false,hidden:false,disabled:false,textContent:'',
      addEventListener(type, fn) { this[type] = fn; }});
    return elements.get(id);
  };
  const context = vm.createContext({
    document:{getElementById:el,addEventListener:(event,fn)=>{hooks[event]=fn;}},
    window:{addEventListener(){}}, crypto:{randomUUID:()=> 'test-request'},
    location:{assign(){},replace(){}},
    fetch:async (path, options) => {
      requests.push({path, body: options.body && JSON.parse(options.body)});
      return {ok:true,json:async()=>path==='/music/api/session'?state:path==='/api/me'?
        {authenticated,draft_scope:'scope',privacy_version:'version'}:{authorize_url:'https://example.test/authorize'}};
    }
  });
  vm.runInContext(fs.readFileSync('music_site/public/link.js','utf8'),context);
  hooks.DOMContentLoaded();
  // Flush the asynchronous initial session read.
  await new Promise(resolve=>setImmediate(resolve));
  return {el,requests};
}
for (const [state, authenticated, expected] of [
  [{authenticated:false,board_authenticated:false},false,'login'],
  [{authenticated:true,linked:false,board_authenticated:true},true,'bind'],
  [{authenticated:true,linked:true,qq_connected:false,board_authenticated:true},true,'bind'],
  // A second tab can authenticate after the initial session display.
  [{authenticated:false,board_authenticated:false},true,'bind']
]) {
  const {el,requests}=await screen(state,authenticated);
  el('musicPrivacy').checked=true;
  await el('musicQQButton').click();
  assert.equal(requests.find(r=>r.path==='/api/auth/qq/start').body.mode,expected);
  assert.equal(requests.some(r=>r.path==='/music/api/link/start'),state.authenticated===true && !state.linked);
}
{
  const {el,requests}=await screen({authenticated:false,board_authenticated:true,board_name:'board user'},true);
  assert.equal(el('musicCreateForm').hidden,false);
  assert.equal(el('musicNewName').value,'board user');
  await el('musicCreateForm').submit({preventDefault(){}});
  assert.equal(requests.some(r=>r.path==='/music/api/profile/create'),false);
  el('musicNewConsent').checked=true;
  await el('musicCreateForm').submit({preventDefault(){}});
  assert.deepEqual(requests.find(r=>r.path==='/music/api/profile/create').body,
    {name:'board user',consent:true,confirm_new:true});
}
for (const state of [
  {board_authenticated:false},
  {board_authenticated:true,authenticated:true,linked:true,qq_connected:true},
  {board_authenticated:true,pending:true}
]) {
  const {el}=await screen(state,!!state.board_authenticated);
  assert.equal(el('musicCreateForm').hidden,true);
}
const labels=vm.createContext({window:{}});
vm.runInContext(fs.readFileSync('music_site/public/member-id.js','utf8'),labels);
assert.equal(labels.window.musicMemberKind('10001'),'QQ 号');
assert.equal(labels.window.musicMemberKind('m_'+'a'.repeat(24)),'成分 ID');
console.log('Music onboarding, consent, binding current accounts, and member ID labels passed.');
