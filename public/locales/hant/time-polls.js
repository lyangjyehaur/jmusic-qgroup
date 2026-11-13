'use strict';
function createTimePollUI({api,$,state,esc,showDialog,toast,withProfile,refresh,shortDate,timeRange,wallDate,wallToISO,openDetail,copyLink,askConfirm}) {
  const labels={open:"時間投票中",closed:"投票截止 · 待定案",finalized:"已確定時間",cancelled:"投票已取消"};
  const choices={yes:"可以",maybe:"勉強可以",no:"不行"};
  let current=null;
  const form=()=>$('#time-poll-form');
  const pollUrl=id=>{const url=new URL('/',location.origin);url.searchParams.set('poll',id);return url.href;};
  function setUrl(id) {
    const url=new URL(location.href);url.searchParams.delete('event');
    if(id)url.searchParams.set('poll',id);else url.searchParams.delete('poll');
    if(url.href!==location.href)history.pushState(null,'',url);
  }
  function renderBoard() {
    const list=(state.polls||[]).filter(p=>{
      if(p.status==='deleted')return false;
      if(state.filter==='upcoming'&&!['open','closed'].includes(p.status))return false;
      if(state.filter==='past'&&!['finalized','cancelled'].includes(p.status))return false;
      if(state.filter==='mine'&&!p.is_owner&&!p.has_voted)return false;
      return (state.category==='全部'||p.category===state.category)&&(!state.search||`${p.title} ${p.location} ${p.description} ${p.owner_name}`.toLowerCase().includes(state.search));
    });
    $('#time-poll-section').hidden=!list.length;
    $('#time-poll-board').innerHTML=list.map(p=>`<a class="event-card poll-card" data-time-poll="${p.id}" href="${esc(pollUrl(p.id))}"><div class="card-heading"><h3 class="card-title">${esc(p.title)}</h3><span class="event-state waiting">${esc(labels[p.status])}</span></div><div class="card-facts"><span>${p.options.length} 個候選時段 · ${p.respondent_count} 人已投票</span><span>${shortDate(p.deadline,p.timezone)} 截止投票</span><span class="card-location">${esc(p.location)}</span></div><div class="card-bottom"><span>${p.has_voted?"已投票":p.is_owner?"我發起的":"一起選時間"}</span><span class="category-label">${esc(BoardI18n.category(p.category))}</span><span class="card-chevron" aria-hidden="true">›</span></div></a>`).join('');
    return list.length;
  }
  function updateOptions() {
    const f=form().elements,count=Number(f.option_count.value),zone=f.timezone.value;
    for(let i=0;i<6;i++){
      const input=f['slot_'+i],row=input.closest('.poll-slot');
      row.hidden=i>=count;input.disabled=i>=count;
      const preview=$('.poll-slot-preview',row);
      try {
        const start=wallToISO(input.value,zone),end=new Date(Date.parse(start)+Number(f.duration_hours.value)*3600000).toISOString();
        preview.textContent=timeRange({starts_at:start,ends_at:end,timezone:zone});
      }catch{preview.textContent="請選擇具體日期與時間";}
    }
  }
  async function openCreate() {
    try {
      await BoardDrafts.detach('time-poll-form-dialog');
      form().reset();form().dataset.intent=crypto.randomUUID();
      const f=form().elements;
      f.deadline.value=wallDate(new Date(Date.now()+86400000),f.timezone.value);
      for(let i=0;i<6;i++)f['slot_'+i].value=wallDate(new Date(Date.now()+(i+2)*86400000),f.timezone.value).slice(0,10)+'T18:00';
      $('.form-error',form()).textContent='';updateOptions();showDialog('time-poll-form-dialog');
      await BoardDrafts.bind('time-poll-form-dialog','time-poll:new',
        ()=>({fields:BoardDrafts.fields(form()),intent:form().dataset.intent}),
        data=>{BoardDrafts.fill(form(),data.fields);form().dataset.intent=data.intent;updateOptions();});
    }catch(error){toast(error.message);}
  }
  function render(p) {
    current=p;
    const canVote=p.can_vote,owner=p.can_manage;
    $('#time-poll-title').textContent=p.title;
    const options=p.options.map((o,i)=>`<div class="poll-option${p.selected_option_id===o.id?' selected':''}"><div class="poll-option-heading"><strong>時段 ${i+1}</strong>${p.selected_option_id===o.id?"<span class=\"event-state\">已選定</span>":p.leading_option_ids.includes(o.id)?"<span class=\"event-state\">最多人可以</span>":''}</div><p class="poll-time">${timeRange({...o,timezone:p.timezone})}</p><div class="poll-totals"><span>${o.yes} 人可以</span><span>${o.maybe} 人勉強可以</span><span>${o.no} 人不行</span></div>${canVote?`<label class="field poll-choice">我的選擇<select name="choice_${o.id}" required><option value="">請選擇</option>${Object.entries(choices).map(([value,label])=>`<option value="${value}"${p.my_choices[o.id]===value?' selected':''}>${label}</option>`).join('')}</select></label>`:p.my_choices[o.id]?`<p class="field-help">我的選擇：${esc(choices[p.my_choices[o.id]])}</p>`:''}</div>`).join('');
    $('#time-poll-content').innerHTML=`<p class="activity-status">${esc(labels[p.status])} · ${p.respondent_count} 人已投票</p><p class="field-help">${shortDate(p.deadline,p.timezone)} 截止 · ${esc(p.owner_name)} 發起<br>時區：${esc(p.timezone)}</p><p class="poll-location">地點：${esc(p.location)}</p>${p.description?`<p class="detail-description">${esc(p.description)}</p>`:''}${p.fee_policy?`<p class="detail-description">費用約定：${esc(p.fee_policy)}</p>`:''}<p class="field-help">${p.capacity?"正式活動上限 "+p.capacity+" 人":"正式活動人數不限"}${p.minimum_participants?" · 最低成團 "+p.minimum_participants+" 人":''}。投票不佔名額；定案後請重新報名。</p>${p.reason?`<p class="activity-alert">發起者說明：${esc(p.reason)}</p>`:''}<form id="time-poll-vote-form">${options}${canVote?`<button class="button primary full" type="submit">${p.has_voted?"更新我的選擇":"提交時間選擇"}</button>`:!state.me.authenticated&&p.status==='open'?"<button class=\"button primary full\" type=\"button\" data-poll-action=\"login\">登錄後投票</button>":''}<p class="form-error" role="alert"></p></form>${p.event_id?"<button type=\"button\" class=\"button primary full\" data-poll-action=\"event\">查看已定案活動並報名</button>":''}${owner?ownerTools(p):''}<p id="time-poll-error" class="form-error" role="alert"></p><button type="button" class="text-button full" data-poll-action="reload">刷新票數與安排</button>`;
    if(p.is_owner)$('#time-poll-content').innerHTML+=botStatus(p);
    if(p.event_deleted)$('#time-poll-content').innerHTML+="<p class=\"field-help\">已定案的正式活動已刪除。</p>";
    if(p.can_remove)$('#time-poll-content').innerHTML+="<button type=\"button\" class=\"text-button full danger\" data-poll-action=\"remove\">刪除投票</button>";
  }
  function botStatus(p) {
    const states={pending:"待送",sending:"投遞中",sent:"已發送",failed:"失敗",skipped:"已作廢",simulated:"模擬，未發送"};
    return `<details class="extra-settings"><summary>QQ 群通知 · ${p.bot_enabled?"已開啟":"未開啟"}</summary><p class="field-help">${p.bot_notice_enabled?"是否實際發送以投遞記錄為準，已發送不代表群友已讀。":"管理員尚未啟用機器人，當前不會排入通知。"}</p>${(p.bot_delivery||[]).map(r=>`<p class="field-help">${esc(states[r.state]||r.state)} · ${shortDate(r.sent_at||r.simulated_at||r.created_at,p.timezone)}${r.last_error&&r.state!=='simulated'?' · '+esc(r.last_error):''}${p.can_manage&&p.status==='open'&&p.bot_enabled&&['failed','simulated'].includes(r.state)?` <button type="button" class="text-button" data-poll-action="retry" data-id="${r.id}">重送通知</button>`:''}</p>`).join('')||"<p class=\"field-help\">暫無投遞記錄</p>"}${p.can_manage?`<button type="button" class="button secondary full" data-poll-action="bot-sync">${p.bot_enabled?"關閉主動群通知":"開啟主動群通知"}</button><p class="field-help">開啟後向後臺設置的目標群發送公開投票安排；定案後的正式活動沿用此設置。模擬通知不會自動重送，需手動選擇重送。</p>`:''}</details>`;
  }
  function ownerTools(p) {
    const suggested=p.options.find(o=>p.leading_option_ids.includes(o.id)&&Date.parse(o.starts_at)>Date.now())||p.options.find(o=>Date.parse(o.starts_at)>Date.now());
    const suggestedDeadline=suggested?wallDate(new Date(Math.max(Date.now()+60000,Date.parse(suggested.starts_at)-3600000)),p.timezone):'';
    return `<section class="poll-management"><h3>發起者定案</h3><p class="field-help">請先確認場地與費用。最高票僅供參考；同票可自行選擇，未選最高票或未達最低人數時須說明原因。</p><form id="time-poll-finalize-form"><label class="field">最終時段<select name="option_id" required>${p.options.map((o,i)=>`<option value="${o.id}"${o.id===suggested?.id?' selected':''}${Date.parse(o.starts_at)<=Date.now()?' disabled':''}>時段 ${i+1} · ${shortDate(o.starts_at,p.timezone)} · ${o.yes} 人可以</option>`).join('')}</select></label><label class="field">正式報名截止<input name="registration_deadline" type="datetime-local" value="${suggestedDeadline}" required></label><label class="field">定案說明 <span class="optional">選填</span><textarea name="reason" maxlength="200" rows="2" placeholder="同票選擇、人數不足仍舉行或場地安排等"></textarea></label><label class="check-option"><input name="accept_terms" type="checkbox" required>我已確認場地與安排，定案後開放正式報名；本人會自動報名，其他投票者需另行報名。</label><p class="form-error" role="alert"></p><button type="submit" class="button primary full">確定時間併發布活動</button></form><details class="extra-settings"><summary>截止、重新開放與取消</summary>${p.status==='open'?"<button type=\"button\" class=\"button secondary full\" data-poll-action=\"close\">提前截止投票</button>":''}<form id="time-poll-extend-form"><label class="field">新的投票截止<input type="datetime-local" name="deadline" value="${wallDate(p.deadline,p.timezone)}" required></label><p class="field-help">需早於所有候選時段，已有選擇會保留。</p><p class="form-error" role="alert"></p><button class="button secondary full" type="submit">調整截止並開放投票</button></form><form id="time-poll-cancel-form"><label class="field">取消原因<textarea name="reason" maxlength="200" required rows="2"></textarea></label><p class="form-error" role="alert"></p><button class="button secondary full danger" type="submit">取消這次時間投票</button></form></details><details class="extra-settings"><summary>查看個人選擇（僅發起者）</summary>${p.respondents.map(r=>`<div class="poll-respondent"><strong>${esc(r.name)}</strong><p>${p.options.map((o,i)=>`時段 ${i+1}：${esc(choices[r.choices[o.id]]||"未選擇")}`).join(' · ')}</p></div>`).join('')||"<p class=\"field-help\">尚無人投票。</p>"}</details></section>`;
  }
  async function open(id,changeUrl=true) {
    try {
      const poll=await api('/api/time-polls/'+id);render(poll);showDialog('time-poll-dialog');
      if(changeUrl)setUrl(id);
      return poll;
    }catch(error){toast(error.message);}
  }
  async function submit(formElement,task) {
    const error=$('.form-error',formElement),button=$('button[type=submit]',formElement);
    error.textContent='';formElement.inert=true;if(button)button.disabled=true;
    try {await task();}catch(problem){error.textContent=problem.message+(problem.status===409?"；請先刷新票數與安排，再重新確認。":'');}
    finally{formElement.inert=false;if(button)button.disabled=false;}
  }
  form().addEventListener('input',updateOptions);
  form().addEventListener('change',updateOptions);
  form().addEventListener('submit',event=>{
    event.preventDefault();if(!BoardDrafts.ready('time-poll-form-dialog'))return;
    submit(form(),async()=>{
      const f=form().elements,zone=f.timezone.value;
      const data={title:f.title.value.trim(),category:f.category.value,location:f.location.value.trim(),
        description:f.description.value.trim(),timezone:zone,bot_enabled:f.bot_enabled.checked,
        duration_hours:Number(f.duration_hours.value),capacity:Number(f.capacity.value),
        minimum_participants:Number(f.minimum_participants.value),deadline:wallToISO(f.deadline.value,zone),
        options:Array.from({length:Number(f.option_count.value)},(_,i)=>({starts_at:wallToISO(f['slot_'+i].value,zone)})),
        client_intent:form().dataset.intent};
      const poll=await api('/api/time-polls','POST',data);
      await BoardDrafts.clear('time-poll-form-dialog');$('#time-poll-form-dialog').close();
      await refresh({detail:false});await open(poll.id);toast("時間投票已發起，可複製鏈接發給群友");
    });
  });
  $('#time-poll-dialog').addEventListener('submit',event=>{
    event.preventDefault();const f=event.target,p=current;if(!p)return;
    submit(f,async()=>{
      let updated;
      if(f.id==='time-poll-vote-form'){
        updated=await api(`/api/time-polls/${p.id}/votes`,'PUT',{base_revision:p.revision,
          choices:p.options.map(o=>({option_id:o.id,choice:f.elements['choice_'+o.id].value}))});
        toast("選擇已保存；投票不佔正式報名名額");
      }else{
        const action={'time-poll-finalize-form':'finalize','time-poll-extend-form':'extend','time-poll-cancel-form':'cancel'}[f.id];
        if(!action)return;
        const data={action,base_revision:p.revision};
        if(action==='finalize')Object.assign(data,{option_id:f.elements.option_id.value,base_vote_revision:p.vote_revision,
          registration_deadline:wallToISO(f.elements.registration_deadline.value,p.timezone),
          reason:f.elements.reason.value.trim(),accept_terms:f.elements.accept_terms.checked});
        if(action==='extend')data.deadline=wallToISO(f.elements.deadline.value,p.timezone);
        if(action==='cancel')data.reason=f.elements.reason.value.trim();
        updated=await api('/api/time-polls/'+p.id,'PATCH',data);
        toast(action==='finalize'?"時間已確定，已通知投票者到活動頁報名":action==='extend'?"已調整投票截止":"投票已取消");
      }
      render(updated);await refresh({detail:false});
    });
  });
  document.addEventListener('click',event=>{
    const card=event.target.closest('[data-time-poll]');
    if(card){if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();open(card.dataset.timePoll);return;}
    const action=event.target.closest('[data-poll-action]')?.dataset.pollAction;
    if(action==='create')withProfile(openCreate);
    if(action==='login')withProfile(()=>open(current.id,false));
    if(action==='reload'&&current)open(current.id,false);
    if(action==='share'&&current)copyLink(`${current.title}\n一起選擇活動時間：\n${pollUrl(current.id)}`,"時間投票鏈接");
    if(action==='remove'&&current?.can_remove){
      const p=current;
      askConfirm("刪除這次時間投票？",`投票及已有選擇將從看板移除，原鏈接失效，未發送的通知會停止。${p.event_id?"已生成的正式活動保留，需要另行刪除。":''}已發到 QQ 群的消息不會撤回。`,async()=>{
        try{
          await api('/api/time-polls/'+p.id,'PATCH',{action:'remove',base_revision:p.revision});
          $('#time-poll-dialog').close();await refresh({detail:false});toast("投票已刪除");
        }catch(error){$('#time-poll-error').textContent=error.message;}
      });
    }
    if(action==='event'&&current?.event_id){const id=current.event_id;$('#time-poll-dialog').dataset.fromHistory='1';$('#time-poll-dialog').close();openDetail(id);}
    if(['bot-sync','retry'].includes(action)&&current){
      const p=current,data={action:action==='retry'?'bot_retry':'bot_sync',base_revision:p.revision};
      if(action==='retry')data.outbox_id=Number(event.target.closest('[data-poll-action]').dataset.id);
      else data.bot_enabled=!p.bot_enabled;
      api('/api/time-polls/'+p.id,'PATCH',data).then(async updated=>{render(updated);await refresh({detail:false});toast("群通知設置已更新，請查看投遞記錄");}).catch(error=>{$('#time-poll-error').textContent=error.message;});
    }
    if(action==='close'&&current){const p=current;api('/api/time-polls/'+p.id,'PATCH',{action:'close',base_revision:p.revision}).then(async updated=>{render(updated);await refresh({detail:false});}).catch(error=>{$('#time-poll-error').textContent=error.message;});}
  });
  $('#time-poll-dialog').addEventListener('close',()=>{
    current=null;if(!$('#time-poll-dialog').dataset.fromHistory)setUrl(null);delete $('#time-poll-dialog').dataset.fromHistory;
  });
  return {open,openCreate,renderBoard};
}
