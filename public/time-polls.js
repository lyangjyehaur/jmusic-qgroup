'use strict';
function createTimePollUI({api,$,state,esc,showDialog,toast,withProfile,refresh,shortDate,timeRange,wallDate,wallToISO,openDetail,copyLink}) {
  const labels={open:'时间投票中',closed:'投票截止 · 待定案',finalized:'已确定时间',cancelled:'投票已取消'};
  const choices={yes:'可以',maybe:'勉强可以',no:'不行'};
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
      if(state.filter==='upcoming'&&!['open','closed'].includes(p.status))return false;
      if(state.filter==='past'&&!['finalized','cancelled'].includes(p.status))return false;
      if(state.filter==='mine'&&!p.is_owner&&!p.has_voted)return false;
      return (state.category==='全部'||p.category===state.category)&&(!state.search||`${p.title} ${p.location} ${p.description} ${p.owner_name}`.toLowerCase().includes(state.search));
    });
    $('#time-poll-section').hidden=!list.length;
    $('#time-poll-board').innerHTML=list.map(p=>`<a class="event-card poll-card" data-time-poll="${p.id}" href="${esc(pollUrl(p.id))}"><div class="card-heading"><h3 class="card-title">${esc(p.title)}</h3><span class="event-state waiting">${esc(labels[p.status])}</span></div><div class="card-facts"><span>${p.options.length} 个候选时段 · ${p.respondent_count} 人已投票</span><span>${shortDate(p.deadline,p.timezone)} 截止投票</span><span class="card-location">${esc(p.location)}</span></div><div class="card-bottom"><span>${p.has_voted?'已投票':p.is_owner?'我发起的':'一起选时间'}</span><span class="category-label">${esc(BoardI18n.category(p.category))}</span><span class="card-chevron" aria-hidden="true">›</span></div></a>`).join('');
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
      }catch{preview.textContent='请选择具体日期与时间';}
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
    const options=p.options.map((o,i)=>`<div class="poll-option${p.selected_option_id===o.id?' selected':''}"><div class="poll-option-heading"><strong>时段 ${i+1}</strong>${p.selected_option_id===o.id?'<span class="event-state">已选定</span>':p.leading_option_ids.includes(o.id)?'<span class="event-state">最多人可以</span>':''}</div><p class="poll-time">${timeRange({...o,timezone:p.timezone})}</p><div class="poll-totals"><span>${o.yes} 人可以</span><span>${o.maybe} 人勉强可以</span><span>${o.no} 人不行</span></div>${canVote?`<label class="field poll-choice">我的选择<select name="choice_${o.id}" required><option value="">请选择</option>${Object.entries(choices).map(([value,label])=>`<option value="${value}"${p.my_choices[o.id]===value?' selected':''}>${label}</option>`).join('')}</select></label>`:p.my_choices[o.id]?`<p class="field-help">我的选择：${esc(choices[p.my_choices[o.id]])}</p>`:''}</div>`).join('');
    $('#time-poll-content').innerHTML=`<p class="activity-status">${esc(labels[p.status])} · ${p.respondent_count} 人已投票</p><p class="field-help">${shortDate(p.deadline,p.timezone)} 截止 · ${esc(p.owner_name)} 发起<br>时区：${esc(p.timezone)}</p><p class="poll-location">地点：${esc(p.location)}</p>${p.description?`<p class="detail-description">${esc(p.description)}</p>`:''}${p.fee_policy?`<p class="detail-description">费用约定：${esc(p.fee_policy)}</p>`:''}<p class="field-help">${p.capacity?'正式活动上限 '+p.capacity+' 人':'正式活动人数不限'}${p.minimum_participants?' · 最低成团 '+p.minimum_participants+' 人':''}。投票不占名额；定案后请重新报名。</p>${p.reason?`<p class="activity-alert">发起者说明：${esc(p.reason)}</p>`:''}<form id="time-poll-vote-form">${options}${canVote?`<button class="button primary full" type="submit">${p.has_voted?'更新我的选择':'提交时间选择'}</button>`:!state.me.authenticated&&p.status==='open'?'<button class="button primary full" type="button" data-poll-action="login">登录后投票</button>':''}<p class="form-error" role="alert"></p></form>${p.event_id?'<button type="button" class="button primary full" data-poll-action="event">查看已定案活动并报名</button>':''}${owner?ownerTools(p):''}<p id="time-poll-error" class="form-error" role="alert"></p><button type="button" class="text-button full" data-poll-action="reload">刷新票数与安排</button>`;
    if(p.is_owner)$('#time-poll-content').innerHTML+=botStatus(p);
  }
  function botStatus(p) {
    const states={pending:'待送',sending:'投递中',sent:'已发送',failed:'失败',skipped:'已作废',simulated:'模拟，未发送'};
    return `<details class="extra-settings"><summary>QQ 群通知 · ${p.bot_enabled?'已开启':'未开启'}</summary><p class="field-help">${p.bot_notice_enabled?'是否实际发送以投递记录为准，已发送不代表群友已读。':'管理员尚未启用机器人，当前不会排入通知。'}</p>${(p.bot_delivery||[]).map(r=>`<p class="field-help">${esc(states[r.state]||r.state)} · ${shortDate(r.sent_at||r.simulated_at||r.created_at,p.timezone)}${r.last_error&&r.state!=='simulated'?' · '+esc(r.last_error):''}${p.can_manage&&p.status==='open'&&p.bot_enabled&&['failed','simulated'].includes(r.state)?` <button type="button" class="text-button" data-poll-action="retry" data-id="${r.id}">重送通知</button>`:''}</p>`).join('')||'<p class="field-help">暂无投递记录</p>'}${p.can_manage?`<button type="button" class="button secondary full" data-poll-action="bot-sync">${p.bot_enabled?'关闭主动群通知':'开启主动群通知'}</button><p class="field-help">开启后向后台设置的目标群发送公开投票安排；定案后的正式活动沿用此设置。模拟通知不会自动重送，需手动选择重送。</p>`:''}</details>`;
  }
  function ownerTools(p) {
    const suggested=p.options.find(o=>p.leading_option_ids.includes(o.id)&&Date.parse(o.starts_at)>Date.now())||p.options.find(o=>Date.parse(o.starts_at)>Date.now());
    const suggestedDeadline=suggested?wallDate(new Date(Math.max(Date.now()+60000,Date.parse(suggested.starts_at)-3600000)),p.timezone):'';
    return `<section class="poll-management"><h3>发起者定案</h3><p class="field-help">请先确认场地与费用。最高票仅供参考；同票可自行选择，未选最高票或未达最低人数时须说明原因。</p><form id="time-poll-finalize-form"><label class="field">最终时段<select name="option_id" required>${p.options.map((o,i)=>`<option value="${o.id}"${o.id===suggested?.id?' selected':''}${Date.parse(o.starts_at)<=Date.now()?' disabled':''}>时段 ${i+1} · ${shortDate(o.starts_at,p.timezone)} · ${o.yes} 人可以</option>`).join('')}</select></label><label class="field">正式报名截止<input name="registration_deadline" type="datetime-local" value="${suggestedDeadline}" required></label><label class="field">定案说明 <span class="optional">选填</span><textarea name="reason" maxlength="200" rows="2" placeholder="同票选择、人数不足仍举行或场地安排等"></textarea></label><label class="check-option"><input name="accept_terms" type="checkbox" required>我已确认场地与安排，定案后开放正式报名；本人会自动报名，其他投票者需另行报名。</label><p class="form-error" role="alert"></p><button type="submit" class="button primary full">确定时间并发布活动</button></form><details class="extra-settings"><summary>截止、重新开放与取消</summary>${p.status==='open'?'<button type="button" class="button secondary full" data-poll-action="close">提前截止投票</button>':''}<form id="time-poll-extend-form"><label class="field">新的投票截止<input type="datetime-local" name="deadline" value="${wallDate(p.deadline,p.timezone)}" required></label><p class="field-help">需早于所有候选时段，已有选择会保留。</p><p class="form-error" role="alert"></p><button class="button secondary full" type="submit">调整截止并开放投票</button></form><form id="time-poll-cancel-form"><label class="field">取消原因<textarea name="reason" maxlength="200" required rows="2"></textarea></label><p class="form-error" role="alert"></p><button class="button secondary full danger" type="submit">取消这次时间投票</button></form></details><details class="extra-settings"><summary>查看个人选择（仅发起者）</summary>${p.respondents.map(r=>`<div class="poll-respondent"><strong>${esc(r.name)}</strong><p>${p.options.map((o,i)=>`时段 ${i+1}：${esc(choices[r.choices[o.id]]||'未选择')}`).join(' · ')}</p></div>`).join('')||'<p class="field-help">尚无人投票。</p>'}</details></section>`;
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
    try {await task();}catch(problem){error.textContent=problem.message+(problem.status===409?'；请先刷新票数与安排，再重新确认。':'');}
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
      await refresh({detail:false});await open(poll.id);toast('时间投票已发起，可复制链接发给群友');
    });
  });
  $('#time-poll-dialog').addEventListener('submit',event=>{
    event.preventDefault();const f=event.target,p=current;if(!p)return;
    submit(f,async()=>{
      let updated;
      if(f.id==='time-poll-vote-form'){
        updated=await api(`/api/time-polls/${p.id}/votes`,'PUT',{base_revision:p.revision,
          choices:p.options.map(o=>({option_id:o.id,choice:f.elements['choice_'+o.id].value}))});
        toast('选择已保存；投票不占正式报名名额');
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
        toast(action==='finalize'?'时间已确定，已通知投票者到活动页报名':action==='extend'?'已调整投票截止':'投票已取消');
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
    if(action==='share'&&current)copyLink(`${current.title}\n一起选择活动时间：\n${pollUrl(current.id)}`,'时间投票链接');
    if(action==='event'&&current?.event_id){const id=current.event_id;$('#time-poll-dialog').dataset.fromHistory='1';$('#time-poll-dialog').close();openDetail(id);}
    if(['bot-sync','retry'].includes(action)&&current){
      const p=current,data={action:action==='retry'?'bot_retry':'bot_sync',base_revision:p.revision};
      if(action==='retry')data.outbox_id=Number(event.target.closest('[data-poll-action]').dataset.id);
      else data.bot_enabled=!p.bot_enabled;
      api('/api/time-polls/'+p.id,'PATCH',data).then(async updated=>{render(updated);await refresh({detail:false});toast('群通知设置已更新，请查看投递记录');}).catch(error=>{$('#time-poll-error').textContent=error.message;});
    }
    if(action==='close'&&current){const p=current;api('/api/time-polls/'+p.id,'PATCH',{action:'close',base_revision:p.revision}).then(async updated=>{render(updated);await refresh({detail:false});}).catch(error=>{$('#time-poll-error').textContent=error.message;});}
  });
  $('#time-poll-dialog').addEventListener('close',()=>{
    current=null;if(!$('#time-poll-dialog').dataset.fromHistory)setUrl(null);delete $('#time-poll-dialog').dataset.fromHistory;
  });
  return {open,openCreate,renderBoard};
}
