import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Use the shipped timezone conversion and form update handlers, including translations.
const stamp=Date.parse('2026-11-13T09:00:00Z');
class FixedDate extends Date {static now(){return stamp;}}
for(const bundle of ['public','public/locales/hans','public/locales/hant']) {
  const app=fs.readFileSync(bundle+'/app.js','utf8');
  const source=fs.readFileSync(bundle+'/time-polls.js','utf8');
  const context=vm.createContext({Date:FixedDate,Intl,BoardI18n:{locale:'zh-CN'}});
  vm.runInContext(app.slice(app.indexOf('const deviceZone='),app.indexOf('const zoneLabel='))+
    source.slice(0,source.indexOf('function createTimePollUI')),context);
  const {wallDate,wallToISO,pollDeadlineBounds:bounds,pollDeadlineValue:value}=vm.runInContext('({wallDate,wallToISO,pollDeadlineBounds,pollDeadlineValue})',context);
  const check=(slots,exact,zone)=>bounds(slots,exact,zone,wallDate,wallToISO,stamp);
  let limit=check([{date:'2026-11-14'},{date:'2026-11-16'}],false,'Asia/Taipei');
  assert.equal(limit.latest,'2026-11-16T23:59');
  assert.equal(value('2026-11-13','',false,'Asia/Taipei',limit,wallToISO,stamp),'2026-11-13T15:59:00.000Z');
  assert.throws(()=>value('2026-11-17','',false,'Asia/Taipei',limit,wallToISO,stamp),/2026-11-16/);
  assert.throws(()=>value('2026-11-12','',false,'Asia/Taipei',limit,wallToISO,stamp));
  limit=check([{date:'2026-11-13',time:'21:00'},{date:'2026-11-13',time:'20:00'}],true,'Asia/Taipei');
  assert.equal(limit.latest,'2026-11-13T20:59');assert.equal(limit.suggested,'2026-11-13T20:00');
  assert.doesNotThrow(()=>value('2026-11-13','19:59',true,'Asia/Taipei',limit,wallToISO,stamp));
  assert.throws(()=>value('2026-11-13','21:00',true,'Asia/Taipei',limit,wallToISO,stamp),/20:59/);
  assert.throws(()=>value('2026-11-13','17:00',true,'Asia/Taipei',limit,wallToISO,stamp));
  for(const [zone,day,expected] of [['Asia/Tokyo','2026-11-14','2026-11-14T23:59'],['UTC','2027-01-01','2027-01-01T23:59'],['America/New_York','2027-03-15','2027-03-15T23:59']]) {
    assert.equal(check([{date:day}],false,zone).suggested,expected);
  }
  assert.equal(check([{date:'2026-11-13',time:'17:01'}],true,'Asia/Taipei').suggested,'');
  assert.equal(check([],false,'Asia/Taipei'),null);

  const elements={timezone:{value:'Asia/Taipei'},exact_time:{checked:true},duration_hours:{value:'3'},
    deadline_date:{value:'2026-11-14',dataset:{}},deadline_time:{value:'23:59'}};
  const slots=[{key:1,date:'2026-11-13',time:'20:00'},{key:2,date:'2026-11-13',time:'21:00'}];
  for(const slot of slots){
    elements['poll_day_'+slot.key]={value:slot.date,closest:()=>({})};
    elements['poll_time_'+slot.key]={value:slot.time,closest:()=>({})};
  }
  const nodes={};
  Object.assign(context,{slots,form:()=>({elements}),$:selector=>nodes[selector]??={},renderCalendar(){},dayLabel:day=>day,timeRange:()=>''});
  vm.runInContext(source.slice(source.indexOf('  function updateOptions('),source.indexOf('  function changedSlots(')),context);
  context.updateOptions();
  assert.equal(elements.deadline_date.value,'2026-11-13','Today’s exact options must not retain tomorrow’s default deadline');
  assert.equal(elements.deadline_time.value,'20:00');
  elements.deadline_time.value='17:30';context.updateOptions({target:{name:'deadline_time'}});
  elements.poll_time_1.value='21:00';context.updateOptions();
  assert.equal(elements.deadline_time.value,'17:30','Editing cutoff time protects both fields from automatic changes');
  // A restored/custom cutoff must survive candidate edits; invalid choices get a specific range.
  elements.exact_time.checked=false;elements.poll_day_1.value='2026-11-14';elements.poll_day_2.value='2026-11-16';
  elements.deadline_date.value='2026-11-17';context.updateOptions();
  assert.equal(elements.deadline_date.value,'2026-11-17');
  assert.equal(elements.deadline_date.max,'2026-11-16');
  assert.match(nodes['#poll-deadline-hint'].textContent,/23:59.*2026-11-16/);
  assert.throws(()=>context.readDeadline(),/2026-11-16/);
  elements.deadline_date.value='2026-11-13';context.updateOptions();
  assert.equal(context.readDeadline(),'2026-11-13T15:59:00.000Z');
  elements.exact_time.checked=true;elements.deadline_time.value='20:10';context.updateOptions();
  assert.equal(elements.deadline_time.value,'20:10');assert.equal(elements.deadline_date.value,'2026-11-13');
}
console.log('Poll cutoffs: defaults, manual/draft preservation, date/exact boundaries and timezone conversion passed in all bundles');
