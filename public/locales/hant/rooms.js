'use strict';
function roomId() {return Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>v.toString(16).padStart(2,'0')).join('');}
function roomTransfersBody(rows,esc,centsText) {
  const recipients=new Map();for(const r of rows)for(const t of r.transfers){const old=recipients.get(t.to_id)||{name:t.to_name,amount:0};old.amount+=t.amount_cents;recipients.set(t.to_id,old);}
  const totals=recipients.size?"<p class=\"field-help\">各收款人待收合計</p>"+[...recipients.values()].map(p=>`<p class="invoice-line"><span>${esc(p.name)}</span><strong>¥${centsText(p.amount)}</strong></p>`).join(''):'';
  return totals+rows.map(r=>`<section class="invoice-person"><h4>${esc(r.name)} · ¥${centsText(r.total_cents)}</h4><p class="field-help">店家付款／收款人：${esc(r.payer_label||r.payer_name)} · 已付店家 ¥${centsText(r.cost_cents)}${r.held_cents?" · 代收餘額 ¥"+centsText(r.held_cents):''}</p>${r.transfers.map(t=>`<p class="invoice-line"><span>${esc(t.from_name)} → ${esc(t.to_name)}${t.kind==='reimbursement'?"（退還／償還）":''}</span><strong>¥${centsText(t.amount_cents)}</strong></p>`).join('')||"<p class=\"field-help\">暫無人與人之間的待轉款。</p>"}${r.balances.some(b=>b.id===r.payer_id&&b.balance_cents>0)?"<p class=\"field-help\">付款人自己的份額仍須投入本包間；支付店家或登記實際款項後抵扣。</p>":''}</section>`).join('');
}
function roomPlanSection(e,esc) {
  const detail=e.settlement?.detail,actual=detail?.rooms,rooms=actual||e.room_plan||[];
  if(!rooms.length&&!e.can_manage_rooms)return '';
  const live=e.participants||[],people=actual?(detail.people||[]):live;
  const byId=new Map(people.map(p=>[p.id,p])),mine=live.find(p=>p.is_me);
  const myRoom=mine&&rooms.find(r=>r.person_ids.includes(mine.id));
  const assigned=new Set(rooms.flatMap(r=>r.person_ids)),unassigned=people.filter(p=>!assigned.has(p.id)&&['confirmed','waiting','tentative'].includes(p.status));
  const personName=p=>p.label||p.nickname||p.name;
  function member(uid) {
    const p=byId.get(uid);if(!p)return "<li class=\"room-person room-person-stale\">名單已變更</li>";
    const current=live.find(q=>q.id===uid),self=!!current?.is_me;
    const status={waiting:"候補",tentative:"待確認",withdrawn:"已退出"}[p.status];
    const duplicate=!p.label&&people.filter(q=>personName(q)===personName(p)).length>1;
    return `<li class="room-person${self?' room-person-me':''}"><span>${esc(personName(p))}${duplicate&&p.position?' · '+p.position:''}</span>${self?"<span class=\"room-person-badge\">我</span>":current?.is_guest&&current.managed_by_me?"<span class=\"room-person-badge\">我代報</span>":''}${status?`<span class="room-person-status">${status}</span>`:''}</li>`;
  }
  const mineBanner=mine&&rooms.length?`<p class="room-my-assignment">${myRoom?"我的包間："+esc(myRoom.name):"我的包間：待分配"}${myRoom&&mine.status==='waiting'?" · 候補預分，不代表正式名額":''}</p>`:'';
  const cards=rooms.map(r=>`<section class="room-assignment-card${myRoom?.id===r.id?' room-assignment-mine':''}" aria-label="${esc(r.name)}"><div class="room-assignment-heading"><h4>${esc(r.name)}</h4><span>${r.person_ids.length} 人</span></div><p class="room-assignment-payer">店家付款／收款人：${esc(r.payer_label||r.payer_name||"待指定")}</p><ul class="room-assignment-people">${r.person_ids.map(member).join('')||"<li class=\"room-empty\">暫無人員</li>"}</ul></section>`).join('');
  return `<section class="settlement-section room-assignments" aria-label="包間安排"><div class="settlement-heading"><h3>${actual?"實際包間":"預分包間"}</h3>${e.can_manage_rooms?"<button class=\"text-button\" data-detail-action=\"rooms\">分配包間</button>":''}</div>${mineBanner}${cards?`<div class="room-assignment-grid">${cards}</div>`:"<p class=\"field-help\">自定義包間名稱、分配人員並指定付款人；同一人可負責多個包間。</p>"}${rooms.length&&unassigned.length?`<section class="room-unassigned"><h4>待分配 · ${unassigned.length} 人</h4><ul class="room-assignment-people">${unassigned.map(p=>member(p.id)).join('')}</ul></section>`:''}${rooms.length?`<p class="field-help">${actual?"以上為本版結算確認的實際分配。":"預分安排不代表正式名額或已經付款，最終按核對後的實際包間結算。"}</p>`:''}</section>`;
}

function createRoomEditor({container,getRooms,getPeople,getPayers,esc,onChange,final=false,hasRecords=()=>false,canArrange=()=>true}) {
  function render() {
    const rooms=getRooms(),people=getPeople(),payers=getPayers(),assigned=new Set(rooms.flatMap(r=>r.person_ids));
    container.innerHTML=rooms.map(r=>`<section class="invoice-item"><div class="invoice-item-heading"><strong>${esc(r.name)}</strong><button type="button" class="text-button danger" data-room-remove="${r.id}"${canArrange()?'':' hidden'}>移除包間</button></div><label class="field">包間名稱<input maxlength="40" required data-room="${r.id}" data-room-field="name"${canArrange()?'':' readonly'} value="${esc(r.name)}"></label><label class="field">店家付款／收款人<select required${canArrange()?'':' disabled'} data-room="${r.id}" data-room-field="payer_id"><option value="">請選擇</option>${payers.map(p=>`<option value="${p.id}"${p.id===r.payer_id?' selected':''}>${esc(p.label||p.name)}</option>`).join('')}</select></label><p class="field-help">${r.person_ids.length} 人；指定付款人不會改變參加者的 AA 責任。</p>${final?`<label class="field">本包間實際費用（元）<input required inputmode="decimal" data-room="${r.id}" data-room-field="amount" value="${esc(r.amount??'')}" placeholder="0.00"></label><label class="field">店家實際付款情況<select data-room="${r.id}" data-room-field="merchant_mode"><option value="unpaid"${r.merchant_mode==='unpaid'?' selected':''}>尚未登記付款</option><option value="paid"${r.merchant_mode==='paid'?' selected':''}>指定付款人已墊付，隨結算登記</option><option value="recorded"${r.merchant_mode==='recorded'?' selected':''}>已在本包間帳本登記</option></select></label>${r.merchant_mode==='paid'?`<label class="field">實際已墊付金額（元）<input required inputmode="decimal" data-room="${r.id}" data-room-field="paid_amount" value="${esc(r.paid_amount??r.amount??'')}" placeholder="0.00"></label>`:''}${hasRecords(r.id)?"<p class=\"field-help\">已有該包間的店家記錄，請選已登記；補付、退款或更正請到帳本處理。</p>":''}`:''}</section>`).join('')+`<button class="text-button" type="button" data-room-add${canArrange()?'':' hidden'}>增加包間</button><h3 class="invoice-section-title">${final?"核對實際包間人員":"分配報名人員"}</h3><p class="field-help">未分配 ${people.filter(p=>!assigned.has(p.id)).length} 人${final?"；發佈前須全部分配，特殊份數在核對人員中調整。":"；可以先保存部分安排。"}</p>${people.map(p=>`<label class="field room-member">${esc(p.label||p.name)}<select${canArrange()?'':' disabled'} data-room-person="${p.id}"><option value="">未分配</option>${rooms.map(r=>`<option value="${r.id}"${r.person_ids.includes(p.id)?' selected':''}>${esc(r.name)}</option>`).join('')}</select></label>`).join('')}${rooms.some(r=>r.person_ids.some(uid=>!people.some(p=>p.id===uid)))?"<p class=\"field-help\">部分原分配人員已退出或未列入本版，請核對後移除。</p><button class=\"text-button\" type=\"button\" data-room-prune>移除未列入名單的分配</button>":''}`;
  }
  container.addEventListener('input',event=>{
    const el=event.target,room=getRooms().find(r=>r.id===el.dataset.room);
    if(room&&el.dataset.roomField){
      room[el.dataset.roomField]=el.value;onChange();
      if(el.dataset.roomField==='name'){
        // Keep focus and the next click stable while the room name is edited.
        el.closest('.invoice-item').querySelector('strong').textContent=el.value;
        for(const select of container.querySelectorAll('select[data-room-person]'))
          for(const option of select.options)if(option.value===room.id)option.textContent=el.value;
      }
    }
  });
  container.addEventListener('change',event=>{
    const el=event.target;
    if(el.dataset.roomPerson){for(const r of getRooms())r.person_ids=r.person_ids.filter(uid=>uid!==el.dataset.roomPerson);getRooms().find(r=>r.id===el.value)?.person_ids.push(el.dataset.roomPerson);onChange();render();}
    else if(['merchant_mode','payer_id'].includes(el.dataset.roomField)){onChange();render();}
  });
  container.addEventListener('click',event=>{
    const el=event.target.closest('[data-room-add],[data-room-remove],[data-room-prune]');if(!el)return;
    if(el.hasAttribute('data-room-add')){
      if(getRooms().length>=50)return;
      getRooms().push({id:roomId(),name:"包間 "+(getRooms().length+1),payer_id:getPayers()[0]?.id||'',person_ids:[],amount:'',merchant_mode:'unpaid'});
    }else if(el.dataset.roomRemove){const index=getRooms().findIndex(r=>r.id===el.dataset.roomRemove);if(index>=0)getRooms().splice(index,1);}
    else for(const r of getRooms())r.person_ids=r.person_ids.filter(uid=>getPeople().some(p=>p.id===uid));
    onChange();render();
  });
  return {render};
}
function createRoomsUI({api,$,esc,showDialog,toast,renderDetail,refresh}) {
  let ctx=null,generation=0;
  const form=$('#rooms-form'),clone=v=>JSON.parse(JSON.stringify(v));
  const editor=createRoomEditor({container:$('#rooms-editor'),getRooms:()=>ctx.rooms,getPeople:()=>ctx.roster.people.filter(p=>p.status!=='withdrawn'),getPayers:()=>ctx.roster.payers,esc,onChange:()=>BoardDrafts.touch('rooms-dialog')});
  async function open(e) {
    try{await BoardDrafts.detach('rooms-dialog');}catch(problem){toast(problem.message);return;}
    const load=++generation;ctx=null;form.reset();$('#rooms-editor').textContent="加載包間…";$('#rooms-form .form-error').textContent='';$('#rooms-save').disabled=true;$('#rooms-reload').hidden=true;showDialog('rooms-dialog');
    try{
      const latest=await api('/api/events/'+e.id),roster=await api('/api/events/'+e.id+'/settlement/roster');if(load!==generation)return;
      if(!latest.can_manage_rooms)throw new Error("當前不能修改預分包間，請重新查看活動");
      ctx={event:latest,roster,rooms:clone(latest.room_plan)};editor.render();$('#rooms-save').disabled=false;
      await BoardDrafts.bind('rooms-dialog','rooms:'+e.id,()=>({rooms:ctx.rooms,revision:ctx.event.revision}),data=>{
        ctx.rooms=data.rooms;editor.render();if(data.revision!==latest.revision){ctx.event={...latest,revision:data.revision};$('#rooms-reload').hidden=false;return "草稿基於舊版名單，請保留需要的內容並載入最新版後核對";}
      });
    }catch(problem){$('#rooms-form .form-error').textContent=problem.message;}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!ctx||!BoardDrafts.ready('rooms-dialog'))return;const current=ctx;$('#rooms-save').disabled=true;form.inert=true;
    try{
      const e=await api('/api/events/'+ctx.event.id+'/rooms','PUT',{rooms:ctx.rooms,base_revision:ctx.event.revision});
      if(ctx===current){await BoardDrafts.clear('rooms-dialog');$('#rooms-dialog').close();}renderDetail(e);await refresh({detail:false});toast("包間安排已保存");
    }catch(problem){$('#rooms-form .form-error').textContent=problem.message;$('#rooms-reload').hidden=problem.status!==409;}
    finally{form.inert=false;$('#rooms-save').disabled=false;}
  });
  $('#rooms-reload').addEventListener('click',async()=>{if(!ctx)return;try{const e=ctx.event;await BoardDrafts.clear('rooms-dialog');await open(e);}catch(problem){$('#rooms-form .form-error').textContent=problem.message;}});
  return {open};
}
