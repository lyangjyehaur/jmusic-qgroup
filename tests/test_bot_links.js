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
// Bot navigation itself has no request client; only the existing forms submit.
console.log('Bot links: authentication, roles, lifecycle permissions and navigation-only actions passed');
