import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Render the real board in each shipped language and inspect visible cards
// and the badge, including continued access through the participant tab.
for(const filename of ['public/app.js','public/locales/hans/app.js','public/locales/hant/app.js']){
  const source=fs.readFileSync(filename,'utf8');
  const base={category:'聚餐',location:'餐厅',description:'',owner_name:'发起者',
    lifecycle:'scheduled',title:'Upcoming',my_attendees:[],estimated_over:false};
  const state={events:[
    {...base,id:'future'},
    {...base,id:'ongoing',title:'Ongoing',lifecycle:'ongoing'},
    {...base,id:'overdue',title:'Overdue',estimated_over:true,is_owner:true},
    {...base,id:'ended',title:'Ended',lifecycle:'ended'},
    {...base,id:'draft',title:'Draft',lifecycle:'draft'},
    {...base,id:'archived',title:'Archived',lifecycle:'ended',archived_at:'2026-01-01'},
  ],filter:'upcoming',category:'全部',search:''};
  const nodes=Object.fromEntries(['#event-count','#archived-option','#category-filter','#board','#include-archived'].map(id=>[id,{}]));
  const context=vm.createContext({state,$:id=>nodes[id],
    financeUI:{cardLabel:()=>''},eventStatus:()=>['Status',''],
    esc:v=>v,timeRange:()=>'',countLabel:()=>'',BoardI18n:{category:v=>v}});
  vm.runInContext(source.slice(source.indexOf('const isPast='),source.indexOf('\n',source.indexOf('const isPast=')))+
    source.slice(source.indexOf('function renderBoard()'),source.indexOf('async function refresh(')),context);
  const render=()=>{context.renderBoard();return nodes['#board'].innerHTML;};
  let html=render();
  assert.equal(nodes['#event-count'].textContent,2,filename);
  for(const id of ['future','ongoing'])assert.ok(html.includes(`data-event="${id}"`),filename);
  for(const id of ['overdue','ended','draft','archived'])assert.ok(!html.includes(`data-event="${id}"`),filename);
  state.filter='mine';assert.ok(render().includes('data-event="overdue"'),filename);
  state.filter='past';html=render();
  assert.ok(html.includes('data-event="ended"'),filename);
  assert.ok(!html.includes('data-event="overdue"'),filename);
  state.filter='upcoming';state.events=state.events.filter(e=>e.id==='overdue');
  assert.ok(!render().includes('data-event='),filename);
  assert.equal(nodes['#event-count'].textContent,0,filename);
  state.events[0].estimated_over=false;
  assert.ok(render().includes('data-event="overdue"'),filename);
  assert.equal(nodes['#event-count'].textContent,1,filename);
}
console.log('Upcoming board counts, overdue filtering, participant access and extension assertions passed');
