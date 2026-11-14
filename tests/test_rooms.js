import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for(const file of ['public/rooms.js','public/locales/hans/rooms.js','public/locales/hant/rooms.js']){
  const ctx=vm.createContext({crypto:{getRandomValues:a=>a.fill(1)}});
  vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
  const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),cents=v=>(v/100).toFixed(2);
  const rows=[{id:'r1',name:'<牡丹>',payer_id:'a',payer_name:'<甲>',total_cents:12000,cost_cents:12000,held_cents:0,balances:[],transfers:[{from_id:'b',to_id:'a',from_name:'乙',to_name:'<甲>',amount_cents:6000,kind:'collection'}]},
    {id:'r2',name:'兰花',payer_id:'a',payer_name:'<甲>',total_cents:20000,cost_cents:20000,held_cents:0,balances:[],transfers:[{from_id:'c',to_id:'a',from_name:'丙',to_name:'<甲>',amount_cents:20000,kind:'collection'}]}];
  const html=ctx.roomTransfersBody(rows,esc,cents);
  assert.ok(html.includes('260.00'));assert.ok(html.includes('60.00'));assert.ok(html.includes('200.00'));
  assert.ok(!html.includes('<甲>'));assert.ok(html.includes('&lt;牡丹&gt;'));
  const rooms=[{id:'r1',name:'一',payer_id:'a',person_ids:['p1']},{id:'r2',name:'二',payer_id:'a',person_ids:['p2','old']}];
  const listeners={},container={innerHTML:'',addEventListener:(kind,fn)=>listeners[kind]=fn};let changed=0;
  const editor=ctx.createRoomEditor({container,getRooms:()=>rooms,getPeople:()=>[{id:'p1',name:'<同名>'},{id:'p2',name:'同名'}],getPayers:()=>[{id:'a',name:'甲'}],esc,onChange:()=>changed++,final:true,canArrange:()=>false});
  editor.render();assert.ok(container.innerHTML.includes('readonly'));assert.ok(container.innerHTML.includes('disabled'));
  assert.ok(container.innerHTML.includes('&lt;同名&gt;'));assert.ok(rooms[1].person_ids.includes('old'));
  listeners.change({target:{dataset:{roomPerson:'p1'},value:'r2'}});
  assert.deepEqual(rooms[0].person_ids,[]);assert.deepEqual(rooms[1].person_ids,['p2','old','p1']);assert.equal(changed,1);
  listeners.input({target:{dataset:{room:'r2',roomField:'amount'},value:'0.01'}});assert.equal(rooms[1].amount,'0.01');
  const section=ctx.roomPlanSection({room_plan:rooms,can_manage_rooms:true,participants:[{id:'p1',nickname:'<同名>'}]},esc);
  assert.ok(section.includes('&lt;同名&gt;'));assert.ok(!section.includes('<同名>'));
  const assignment={room_plan:[{id:'a',name:'牡丹',payer_name:'付款甲',person_ids:['other']},{id:'b',name:'兰花',payer_name:'付款乙',person_ids:['mine','guest']}],
    participants:[{id:'other',nickname:'同名',status:'confirmed'},{id:'mine',nickname:'同名',status:'waiting',is_me:true},
      {id:'guest',nickname:'同行',status:'confirmed',is_guest:true,managed_by_me:true},{id:'unassigned',nickname:'待分配者',status:'confirmed'}]};
  const visible=ctx.roomPlanSection(assignment,esc);
  assert.ok(!visible.includes('<details'));assert.ok(!visible.includes('data-advanced-only'));
  assert.ok(!visible.includes('data-detail-action="rooms"')); // Ordinary participants can read, not edit.
  assert.equal((visible.match(/room-assignment-mine/g)||[]).length,1);
  assert.ok(visible.includes('<h4>兰花</h4>'));assert.ok(visible.includes('待分配者'));assert.ok(visible.includes('同行'));
  assert.ok(visible.includes(file.includes('hant')?'我的包間：兰花':'我的包间：兰花')); // Names remain byte-for-byte.
  assert.ok(visible.includes(file.includes('hant')?'候補預分':'候补预分'));
  const pending=ctx.roomPlanSection({...assignment,participants:assignment.participants.map(p=>({...p,is_me:p.id==='unassigned'}))},esc);
  assert.ok(pending.includes(file.includes('hant')?'我的包間：待分配':'我的包间：待分配'));
  const managed=ctx.roomPlanSection({...assignment,participants:assignment.participants.map(p=>({...p,is_me:false}))},esc);
  assert.ok(!managed.includes('room-my-assignment'));assert.ok(managed.includes(file.includes('hant')?'我代報':'我代报'));
  const actual=ctx.roomPlanSection({...assignment,settlement:{detail:{rooms:[{id:'actual',name:'实际房',payer_name:'甲',person_ids:['gone','mine']}],
    people:[{id:'gone',name:'原名已退出',status:'withdrawn'},{id:'mine',name:'冻结称呼',status:'confirmed'}]}}},esc);
  assert.ok(actual.includes('原名已退出'));assert.ok(actual.includes('冻结称呼'));assert.ok(!actual.includes('名单已变更'));
  assert.ok(!actual.includes('<h4>牡丹</h4>')); // Published membership uses the bill snapshot.
}
console.log('Room transfers, recipient totals, escaped names, assignment moves and owner controls passed in all bundles');
