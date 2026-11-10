import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context=vm.createContext({});
vm.runInContext(fs.readFileSync('public/experience.js','utf8'),context);
const plan=(...args)=>context.boardEntryPlan(...args).kind;
const base={can_join:true,can_manage_roster:false,can_attendance:false,can_onsite:false,
  is_owner:false,is_cohost:false,finance:{can_report:true}};
assert.equal(plan('join',base,false),'login');
assert.equal(plan('report',base,false),'login');
assert.equal(plan('mine',null,false),'login');
assert.equal(plan('create',null,true),'create');
assert.equal(plan('join',null,true),'missing');
assert.equal(plan('report',base,true),'report');
assert.equal(plan('conditions',base,false),'conditions');
assert.equal(plan('attendance',base,true),'denied');
assert.equal(plan('onsite',{...base,can_attendance:true},true),'denied');
assert.equal(plan('onsite',{...base,can_onsite:true},true),'onsite');
assert.equal(plan('management',{...base,is_cohost:true},true),'denied');
assert.equal(plan('manage',{...base,is_cohost:true},true),'manage');
for(const action of ['delete','accept','close','finish','record','reverse','javascript:alert(1)'])
  assert.equal(plan(action,{...base,is_owner:true},true),'unknown');

// Exercise the actual entry route in every shipped bundle. Basic navigation
// stays collapsed; advanced destinations remain reachable without submitting.
for(const folder of ['', 'locales/hans/', 'locales/hant/']) {
  const source=fs.readFileSync(`public/${folder}app.js`,'utf8');
  const route=source.slice(source.indexOf('async function routeBotEntry('),source.indexOf('\n(async()=>',source.indexOf('async function routeBotEntry(')));
  const event={...base,is_owner:true,can_manage_roster:true,can_attendance:true,can_onsite:true,
    my_attendees:[{id:'self',is_me:true,can_manage:true,can_change:true,can_withdraw:true}]};
  let expanded=false,opened=[],focused=false,authenticated=true;
  const node={click(){opened.push('click');},focus(){focused=true;},scrollIntoView(){}};
  const routeContext=vm.createContext({URL,location:{href:'https://example.test/?event=e&action=join'},history:{state:null,replaceState(){}},
    state:{me:{get authenticated(){return authenticated;}}},boardEntryPlan:context.boardEntryPlan,
    $:()=>node,BoardAdvanced:{set(target,on){expanded=on;}},
    openDetail:async()=>event,openEventForm:async()=>{opened.push('event');},changeFilter(){},toast(){},
    identityUI:{account:async()=>{opened.push('login');}},activityUI:{openConditions:async()=>{opened.push('conditions');}},
    financeUI:{open:async()=>{opened.push('finance');}},renderInbox:async()=>{},showDialog(){opened.push('dialog');},
    api(){throw new Error('A navigation link must not submit a request');},joinEvent(){throw new Error('No automatic signup');}});
  vm.runInContext(route+';this.route=routeBotEntry;',routeContext);
  const advanced=['party','tentative','invite','withdraw','management','manage','attendance','onsite'];
  for(const action of ['join','detail','conditions','settlement','finance','report','copy','todos','claim',...advanced]) {
    expanded=false;opened=[];focused=false;
    await routeContext.route(new URLSearchParams({event:'e',action}));
    assert.equal(expanded,advanced.includes(action),folder+action);
    if(action==='join'){assert.equal(focused,true);assert.deepEqual(opened,[]);}
  }
  expanded=false;opened=[];authenticated=false;
  await routeContext.route(new URLSearchParams({event:'e',action:'join'}));
  assert.deepEqual(opened,['login']);assert.equal(expanded,false);
  authenticated=true;event.can_attendance=false;expanded=false;opened=[];
  await routeContext.route(new URLSearchParams({event:'e',action:'attendance'}));
  assert.equal(expanded,false);assert.deepEqual(opened,[]);
}
// Bot navigation itself has no request client; only the existing forms submit.
console.log('Bot links: authentication, permissions, collapsed basic entries, reachable advanced entries and no automatic submissions passed in all bundles');
