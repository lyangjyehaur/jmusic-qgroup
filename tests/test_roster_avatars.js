import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
for(const filename of ['public/roster.js','public/locales/hans/roster.js','public/locales/hant/roster.js']) {
  const handlers={};
  const context=vm.createContext({document:{addEventListener:(type,handler,capture)=>{handlers[type]={handler,capture};}}});
  vm.runInContext(fs.readFileSync(filename,'utf8')+';this.create=createRosterUI;',context);
  const ui=context.create({$:()=>({addEventListener(){}}),state:{events:[]},esc});
  const person={id:'a',nickname:'群內稱呼 <測試>',status:'confirmed',is_me:true,avatar_url:'https://thirdqq.qlogo.cn/qqapp/test/100'};
  const event={participants:[person],my_attendees:[]};
  const html=ui.peopleSection(event);
  assert.match(html,/class="participant-avatar" aria-hidden="true"/);
  assert.match(html,/<span>群<\/span>/);
  assert.match(html,/width="24" height="24" loading="lazy" decoding="async" referrerpolicy="no-referrer"/);
  assert.ok(html.includes(esc(person.nickname)));
  assert.equal((html.match(/<img /g)||[]).length,1);
  const guest=ui.peopleSection({...event,participants:[{...person,nickname:'同行甲',avatar_url:'',is_guest:true,manager_name:'代報者'}]});
  assert.match(guest,/<span>同<\/span>/);
  assert.ok(!guest.includes('<img '));
  assert.ok(guest.includes('代報者'));
  const malicious=ui.peopleSection({...event,participants:[{...person,nickname:'<script>alert(1)</script>',avatar_url:'https://thirdqq.qlogo.cn/a" onerror="alert(1)'}]});
  assert.ok(!malicious.includes('<script>'));
  assert.ok(!malicious.includes(' onerror="'));
  assert.equal(handlers.error.capture,true);
  let removed=0;
  handlers.error.handler({target:{matches:selector=>selector==='.participant-avatar:not([data-ui-avatar]) img',remove:()=>removed++}});
  assert.equal(removed,1);
  // React Avatar owns its image fallback; the legacy listener must leave it alone.
  handlers.error.handler({target:{matches:selector=>selector==='.participant-avatar img',remove:()=>removed++}});
  assert.equal(removed,1);
  handlers.error.handler({target:{}});
}
console.log('Roster avatar rendering, original names, guest fallback, image errors, and escaping passed in all bundles.');
