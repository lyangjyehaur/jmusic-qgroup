import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for(const bundle of ['public','public/locales/hans','public/locales/hant']) {
  const nodes={};
  const node=id=>nodes[id]??={addEventListener(){},dataset:{},close(){this.closed=true;}};
  let click,pendingConfirm,refreshes=0;const calls=[],messages=[];
  const state={polls:[],filter:'upcoming',category:'全部',search:'',me:{authenticated:true}};
  const context=vm.createContext({state,document:{addEventListener(type,callback){if(type==='click')click=callback;}},location:{origin:'https://example.test'},URL,
    BoardI18n:{category:v=>v},console});
  vm.runInContext(fs.readFileSync(bundle+'/time-polls.js','utf8')+'\nthis.createUI=createTimePollUI;',context);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let response;
  const ui=context.createUI({$:node,state,esc,shortDate:()=> '11/15 18:00',
    timeRange:()=> '11/15 18:00',wallDate:()=> '2099-11-15T17:00',wallToISO:value=>new Date(value+'Z').toISOString(),
    api:async(...args)=>{calls.push(args);return response;},showDialog(){},toast:message=>messages.push(message),
    refresh:async()=>{refreshes++;},askConfirm:(title,message,callback)=>{pendingConfirm=callback;}});
  const base={title:'<img src=x onerror=alert(1)>',location:'餐廳',description:'',owner_name:'甲',
    category:'运动',options:[{},{}],respondent_count:2,status:'open'};
  state.polls=[{...base,id:'open'},{...base,id:'closed',status:'closed'},
    {...base,id:'mine',is_owner:true},{...base,id:'voted',has_voted:true},
    {...base,id:'done',status:'finalized',has_voted:true},{...base,id:'cancel',status:'cancelled'},
    {...base,id:'removed',status:'deleted',is_owner:true,has_voted:true}];
  assert.equal(ui.renderBoard(),4,bundle);
  let html=node('#time-poll-board').innerHTML;
  assert.ok(html.includes('&lt;img'),bundle);
  assert.ok(!html.includes('<img'),bundle);
  assert.ok(html.includes('data-time-poll="closed"'),bundle);
  assert.ok(!html.includes('data-time-poll="done"'),bundle);
  state.filter='mine';assert.equal(ui.renderBoard(),3,bundle);
  state.filter='past';assert.equal(ui.renderBoard(),2,bundle);
  state.filter='upcoming';state.category='聚餐';assert.equal(ui.renderBoard(),0,bundle);
  assert.equal(node('#time-poll-section').hidden,true,bundle);
  state.category='运动';assert.equal(ui.renderBoard(),4,bundle); // Canonical category survives conversion.
  state.search='不存在';assert.equal(ui.renderBoard(),0,bundle);
  response={...base,id:'poll',options:[{id:'one',starts_at:'2099-11-15T18:00:00Z',yes:0}],
    is_owner:true,can_manage:true,can_remove:true,can_vote:false,my_choices:{},leading_option_ids:[],respondents:[],
    bot_enabled:true,bot_feature_enabled:true,bot_notice_enabled:true,
    bot_delivery:[{id:9,state:'simulated',created_at:'2099-11-10T18:00:00Z'}]};
  await ui.open('poll',false);
  html=node('#time-poll-content').innerHTML;
  assert.ok(html.includes('data-poll-action="retry" data-id="9"'),bundle);
  assert.ok(html.includes('data-poll-action="bot-sync"'),bundle);
  assert.ok(html.includes('data-poll-action="remove"'),bundle);
  response={...response,status:'cancelled',can_manage:false};
  await ui.open('poll',false);
  assert.ok(node('#time-poll-content').innerHTML.includes('data-poll-action="remove"'),bundle);
  response={...response,time_mode:'date',status:'open',can_manage:true,
    options:[{id:'one',date:'2099-11-15',starts_at:null,ends_at:null,yes:0}]};
  await ui.open('poll',false);html=node('#time-poll-content').innerHTML;
  assert.ok(html.includes('2099'),bundle);
  assert.ok(html.includes('name="final_start_time"'),bundle);
  assert.ok(html.includes('name="final_duration_hours"'),bundle);
  assert.ok(!html.includes('NaN'),bundle);
  const before=calls.length;
  click({target:{closest:selector=>selector==='[data-poll-action]'?{dataset:{pollAction:'remove'}}:null}});
  assert.equal(calls.length,before,'Deletion waits for confirmation');
  response={id:'poll',status:'deleted'};
  await pendingConfirm();
  assert.equal(calls.at(-1)[0],'/api/time-polls/poll');
  assert.equal(calls.at(-1)[1],'PATCH');
  assert.equal(calls.at(-1)[2].action,'remove');
  assert.equal(node('#time-poll-dialog').closed,true);
  assert.equal(refreshes,1);
  assert.equal(messages.length,1,'Successful deletion closes without rendering a tombstone as a poll');
  response={...base,id:'poll',options:[],my_choices:{},leading_option_ids:[],is_owner:false,can_manage:false,can_remove:false};
  await ui.open('poll',false);
  assert.ok(!node('#time-poll-content').innerHTML.includes('data-poll-action="retry"'),bundle);
  assert.ok(!node('#time-poll-content').innerHTML.includes('data-poll-action="remove"'),bundle);
  const createHTML=fs.readFileSync(bundle+'/index.html','utf8').split('id="time-poll-form"')[1].split('</form>')[0];
  assert.match(createHTML,/<input name="bot_enabled" type="checkbox" checked>/,bundle);
  assert.ok(!createHTML.includes('name="option_count"'),bundle);
  assert.match(createHTML,/data-poll-form-action="add"/);
  assert.match(createHTML,/name="exact_time" type="checkbox">/);
  assert.match(createHTML,/name="range_start" type="date"/);
  assert.match(createHTML,/name="range_end" type="date"/);
  const days=vm.runInContext("pollCalendarDays('2028-02-28','2028-03-01')",context);
  assert.equal(JSON.stringify(days),'["2028-02-28","2028-02-29","2028-03-01"]');
  assert.throws(()=>vm.runInContext("pollCalendarDays('2027-02-29','2027-03-01')",context));
  assert.throws(()=>vm.runInContext("pollCalendarDays('2028-03-02','2028-03-01')",context));
  assert.throws(()=>vm.runInContext("pollCalendarDays('2028-03-01','2028-03-07')",context));
}
console.log('Time polls: active/mine/past filters, canonical categories and safe cards passed in all bundles');
