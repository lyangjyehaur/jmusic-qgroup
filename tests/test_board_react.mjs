import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {build} from 'esbuild';
import {localizeReact} from '../deploy/localize_react.mjs';
import {boardTodos,boardEntryPlan,settlementItemsPayload} from '../ui/board/rules.ts';
import * as polls from '../ui/board/poll-rules.ts';
import {markEventCreated} from '../ui/board/recovery.ts';

globalThis.document={documentElement:{lang:'zh-Hant'}};
const dates=await import('../ui/board/domain.ts');
// Check the new React roots themselves: neither may import the HTML bridge.
const graph=await build({entryPoints:['ui/board/BoardApp.tsx','ui/board/AdminApp.tsx'],bundle:true,write:false,metafile:true,outdir:'unused-react-check',logLevel:'silent'});
assert.ok(!Object.keys(graph.metafile.inputs).some(file=>/react-view|react_controllers|html-react-parser|public\//.test(file)));
for(const name of ['index','admin']) {
  const shell=fs.readFileSync(`public/${name}.html`,'utf8');
  assert.match(shell,new RegExp(`id="${name==='index'?'board':'admin'}-root"`));
  assert.ok(!shell.includes('<form'));
}
// Compare extracted rules against the verified business rules, including denied bot entry actions.
const legacy=vm.createContext({});
vm.runInContext(fs.readFileSync('public/experience.js','utf8'),legacy);
const event={id:'e',title:'原文後臺',lifecycle:'ongoing',is_owner:true,can_join:true,minimum_participants:2,minimum_met:true,formation_state:'pending',
  can_finish:true,estimated_over:true,can_manage_roster:true,participants:[{withdrawal_requested:true}],
  my_attendees:[{can_respond:true,confirmation_state:'pending'}],claim_invitations:[{can_decide:true}],finance:{can_manage:true,pending_count:1,detailed:true,my_outstanding_cents:10,my_refund_due_cents:20}};
assert.deepEqual(boardTodos([event]),JSON.parse(JSON.stringify(legacy.boardTodos([event]))));
for(const action of ['create','join','party','invite','manage','attendance','settlement','unknown','delete'])for(const authenticated of [true,false]) {
  for(const value of [null,event,{id:'no-permission'}]) assert.deepEqual(boardEntryPlan(action,value,authenticated),JSON.parse(JSON.stringify(legacy.boardEntryPlan(action,value,authenticated))));
}
assert.equal(dates.wallToISO('2027-01-01T00:15','Asia/Taipei'),'2026-12-31T16:15:00.000Z');
assert.throws(()=>dates.wallToISO('2027-03-14T02:30','America/New_York'));
assert.throws(()=>dates.wallToISO('2027-11-07T01:30','America/New_York'));
assert.equal(dates.eventStartValue('2027-01-31','02:30','1'),'2027-02-01T02:30');
assert.throws(()=>dates.eventStartValue('2027-01-01','02:30',''));
assert.match(dates.timeRange({starts_at:'2026-12-31T15:00Z',ends_at:'2026-12-31T17:00Z',timezone:'Asia/Taipei'}),/1月1日/);
assert.equal(polls.pollMonthDays('2028-02').days.length,29);
assert.equal(polls.pollShiftMonth('2028-12',1),'2029-01');
const selected=[{date:'2028-02-20',time:'19:30'}];
const next=polls.pollToggleCalendarDate(selected,'2028-03-07',()=>({date:'',time:'18:00'}));
assert.equal(next[0].time,'19:30');assert.equal(selected.length,1);
const bounds=polls.pollDeadlineBounds(next,false,'Asia/Taipei',dates.wallDate,dates.wallToISO,0);
assert.equal(bounds.latest,'2028-03-07T23:59');
assert.throws(()=>polls.pollDeadlineValue('2028-03-08','',false,'Asia/Taipei',bounds,dates.wallToISO,0));
const items=[{id:'original',name:'后台後臺',note:'用户原文',mode:'fixed',scope:'common',allocations:[],receipt_digest:'not-submitted'}];
const payload=settlementItemsPayload(items,[{id:'p'}],3);
assert.equal(payload[0].name,'后台後臺');assert.equal(payload[0].note,'用户原文');
assert.deepEqual(payload[0].allocations,[{person_id:'p',amount:'0.00'}]);
assert.ok(!('receipt_digest' in payload[0]));assert.ok('receipt_digest' in items[0]);
// Recover an uncertain create across old and React drafts, preserving unsent text and other identities.
const rows=new Map([
  ['draft:me:event:new',{data:{react:1,value:{_intent:'same',id:'',title:'unsent edit'}}}],
  ['draft:me:copy:old',{data:{dataset:{intent:'same'},fields:[{name:'id',value:''},{name:'title',value:'legacy edit'}]}}],
  ['draft:me:event:other',{data:{react:1,value:{_intent:'other',id:''}}}],
  ['draft:someone:event:new',{data:{react:1,value:{_intent:'same',id:''}}}],
]);
const storage={list:async prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,...value})),put:async(key,value)=>rows.set(key,value)};
await markEventCreated(storage,'me','same',{id:'created',lifecycle:'scheduled'});
assert.equal(rows.get('draft:me:event:new').data.value.id,'created');
assert.equal(rows.get('draft:me:event:new').data.value._revision,-1);
assert.equal(rows.get('draft:me:event:new').data.value.title,'unsent edit');
assert.equal(rows.get('draft:me:copy:old').data.fields[0].value,'created');
assert.equal(rows.get('draft:me:copy:old').data.fields[1].value,'legacy edit');
assert.equal(rows.get('draft:me:event:other').data.value.id,'');
assert.equal(rows.get('draft:someone:event:new').data.value.id,'');
for(const locale of ['hans','hant']) {
  const source=`type Kind="运动"|"约K"; type Name="后台"; const category:Kind="运动"; const labels={"运动":"运动说明"}; const match=input==="运动"; const Ui=({user})=><div><span>后台设置</span><a translate="no">飯糰</a>{user.title}<p>{\`报名人数：\${user.count}\`}</p></div>`;
  const output=localizeReact(source,locale);
  assert.match(output,/type Name="后台"/);assert.match(output,/category:Kind="运动"/);assert.match(output,/input==="运动"/);assert.match(output,/"运动":/);
  assert.match(output,/<a translate="no">飯糰<\/a>/);assert.match(output,/\{user.title\}/);
  assert.ok(output.includes(locale==='hant'?'後臺設置':'后台设置'));
}
console.log('Direct React roots, date/DST and rule parity, preview payloads, recovery isolation and TSX localization passed');
