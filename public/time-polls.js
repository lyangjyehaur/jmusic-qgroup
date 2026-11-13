'use strict';
function pollAddDays(day,offset) {
  const date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);
}
function pollMonthDays(month) {
  const first=new Date(month+'-01T12:00:00Z');
  if(!/^\d{4}-\d{2}$/.test(month)||!Number.isFinite(first.getTime()))throw new Error('请选择有效月份');
  const end=new Date(first);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  return {offset:(first.getUTCDay()+6)%7,days:Array.from({length:end.getUTCDate()},(_,i)=>month+'-'+String(i+1).padStart(2,'0'))};
}
function pollShiftMonth(month,offset) {
  const date=new Date(month+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+offset);return date.toISOString().slice(0,7);
}
function pollToggleCalendarDate(slots,day,makeSlot) {
  let next;
  if(slots.some(s=>s.date===day))next=slots.filter(s=>s.date!==day);
  else {
    if(slots.filter(s=>s.date).length>=6)throw new Error('最多选择 6 个选项，请先取消不需要的日期');
    next=slots.map(s=>({...s}));
    const empty=next.find(s=>!s.date);
    if(empty)empty.date=day;else next.push({...makeSlot(),date:day});
  }
  while(next.length<2)next.push(makeSlot());
  return next.sort((a,b)=>Number(!a.date)-Number(!b.date)||a.date.localeCompare(b.date));
}
function createTimePollUI({api,$,state,esc,showDialog,toast,withProfile,refresh,shortDate,timeRange,wallDate,wallToISO,openDetail,copyLink,askConfirm}) {
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
      if(p.status==='deleted')return false;
      if(state.filter==='upcoming'&&!['open','closed'].includes(p.status))return false;
      if(state.filter==='past'&&!['finalized','cancelled'].includes(p.status))return false;
      if(state.filter==='mine'&&!p.is_owner&&!p.has_voted)return false;
      return (state.category==='全部'||p.category===state.category)&&(!state.search||`${p.title} ${p.location} ${p.description} ${p.owner_name}`.toLowerCase().includes(state.search));
    });
    $('#time-poll-section').hidden=!list.length;
    $('#time-poll-board').innerHTML=list.map(p=>`<a class="event-card poll-card" data-time-poll="${p.id}" href="${esc(pollUrl(p.id))}"><div class="card-heading"><h3 class="card-title">${esc(p.title)}</h3><span class="event-state waiting">${esc(labels[p.status])}</span></div><div class="card-facts"><span>${p.options.length} 个候选时段 · ${p.respondent_count} 人已投票</span><span>${shortDate(p.deadline,p.timezone)} 截止投票</span><span class="card-location">${esc(p.location)}</span></div><div class="card-bottom"><span>${p.has_voted?'已投票':p.is_owner?'我发起的':'一起选时间'}</span><span class="category-label">${esc(BoardI18n.category(p.category))}</span><span class="card-chevron" aria-hidden="true">›</span></div></a>`).join('');
    return list.length;
  }
  let slots=[],slotSerial=0,calendarMonth='';
  const newSlot=(day='',time='18:00')=>({key:++slotSerial,date:day,time});
  const dayLabel=day=>new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:'UTC',year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(new Date(day+'T12:00:00Z'));
  const optionLabel=(p,o)=>p.time_mode==='date'?dayLabel(o.date):shortDate(o.starts_at,p.timezone);
  const optionFuture=(p,o)=>p.time_mode==='date'?o.date>=wallDate(Date.now(),p.timezone).slice(0,10):Date.parse(o.starts_at)>Date.now();
  function renderCalendar() {
    const f=form().elements,today=wallDate(Date.now(),f.timezone.value).slice(0,10),earliest=f.exact_time.checked?today:pollAddDays(today,1);
    if(!calendarMonth)calendarMonth=earliest.slice(0,7);
    const selected=new Set(slots.map(s=>s.date).filter(Boolean)),full=slots.filter(s=>s.date).length>=6;
    const {offset,days}=pollMonthDays(calendarMonth);
    $('#poll-calendar-month').textContent=new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:'UTC',year:'numeric',month:'long'}).format(new Date(calendarMonth+'-01T12:00:00Z'));
    $('#poll-calendar-weekdays').innerHTML=Array.from({length:7},(_,i)=>`<span>${esc(new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:'UTC',weekday:'short'}).format(new Date('2024-01-0'+(i+1)+'T12:00:00Z')))}</span>`).join('');
    $('#poll-calendar-days').innerHTML='<span aria-hidden="true"></span>'.repeat(offset)+days.map(day=>`<button type="button" class="poll-calendar-day${day===today?' today':''}" data-poll-form-action="day" data-day="${day}" aria-label="${esc(dayLabel(day))}" aria-pressed="${selected.has(day)}"${day===today?' aria-current="date"':''}${!selected.has(day)&&(day<earliest||full)?' disabled':''}>${Number(day.slice(-2))}</button>`).join('');
    $('[data-poll-form-action="previous-month"]',form()).disabled=calendarMonth<=earliest.slice(0,7);
    $('#poll-calendar-selection').textContent=`已选 ${selected.size} 个日期，可跨月选择；最多 6 个选项。`;
  }
  function readSlots() {
    const f=form().elements;
    for(const slot of slots){slot.date=f['poll_day_'+slot.key].value;slot.time=f['poll_time_'+slot.key].value;}
    return slots;
  }
  function renderSlots() {
    $('#poll-slots').innerHTML=slots.map((slot,i)=>`<div class="poll-slot"><div class="poll-slot-heading"><strong>选项 ${i+1}</strong><button type="button" class="text-button danger" data-poll-form-action="remove" data-key="${slot.key}" aria-label="移除选项 ${i+1}"${slots.length<=2?' disabled':''}>移除</button></div><div class="form-row"><label class="field">候选日期 ${i+1}<input name="poll_day_${slot.key}" type="date" value="${esc(slot.date)}" required></label><label class="field poll-slot-time">开始时间 ${i+1}<input name="poll_time_${slot.key}" type="time" value="${esc(slot.time)}" required></label></div><p class="poll-slot-preview field-help"></p></div>`).join('');
    updateOptions();
  }
  function updateOptions(event) {
    if(event?.target?.name==='deadline_date')event.target.dataset.touched='1';
    const f=form().elements,exact=f.exact_time.checked,zone=f.timezone.value;
    const today=wallDate(Date.now(),zone).slice(0,10),earliest=exact?today:pollAddDays(today,1);
    $('#poll-duration').hidden=!exact;f.duration_hours.disabled=!exact;
    $('#poll-deadline-time').hidden=!exact;f.deadline_time.disabled=!exact;
    $('#poll-mode-hint').textContent=exact?'逐项指定开始时间，发布前核对开始与结束；凌晨按实际日期选择。':'先投日期，开始时间和持续时长在定案时补充。选中某一天表示当天方便，再按最终安排确认报名。';
    for(const slot of slots){
      const input=f['poll_day_'+slot.key],clock=f['poll_time_'+slot.key],row=input.closest('.poll-slot');
      slot.date=input.value;slot.time=clock.value;input.min=earliest;
      clock.disabled=!exact;clock.closest('label').hidden=!exact;
      const preview=$('.poll-slot-preview',row);
      try{
        if(!slot.date)throw new Error();
        if(exact){const start=wallToISO(slot.date+'T'+slot.time,zone),end=new Date(Date.parse(start)+Number(f.duration_hours.value)*3600000).toISOString();preview.textContent=timeRange({starts_at:start,ends_at:end,timezone:zone});}
        else preview.textContent=dayLabel(slot.date)+' · 具体时间待定';
      }catch{preview.textContent=exact?'请选择日期与开始时间':'请选择候选日期';}
    }
    const first=slots.map(s=>s.date).filter(Boolean).sort()[0];
    if(!exact&&first&&!f.deadline_date.dataset.touched)f.deadline_date.value=pollAddDays(first,-1);
    $('[data-poll-form-action="add"]',form()).disabled=slots.length>=6;
    $('#poll-slot-count').textContent=`${slots.length} / 6 个选项，至少保留 2 项`;
    renderCalendar();
  }
  function changedSlots(){renderSlots();form().dispatchEvent(new Event('change',{bubbles:true}));}
  form().addEventListener('click',event=>{
    const button=event.target.closest('[data-poll-form-action]');if(!button)return;
    const action=button.dataset.pollFormAction;readSlots();
    try{
      if(action==='add'&&slots.length<6){slots.push(newSlot());changedSlots();form().elements['poll_day_'+slots.at(-1).key].focus();}
      if(action==='remove'&&slots.length>2){slots=slots.filter(s=>s.key!==Number(button.dataset.key));changedSlots();}
      if(action==='previous-month'||action==='next-month'){
        calendarMonth=pollShiftMonth(calendarMonth,action==='previous-month'?-1:1);renderCalendar();
      }
      if(action==='current-month'){calendarMonth=wallDate(Date.now(),form().elements.timezone.value).slice(0,7);renderCalendar();}
      if(action==='day'){
        const day=button.dataset.day,removing=slots.some(s=>s.date===day);
        slots=pollToggleCalendarDate(slots,day,newSlot);changedSlots();
        $('#poll-calendar-message').textContent=removing?'已取消该日期，其他日期会保留。':slots.filter(s=>s.date).length>=6?'已选满 6 个选项，可先取消某日再换选。':'已加入候选，可继续点选其他日期。';
        $(`[data-day="${day}"]`,form()).focus();
      }
    }catch(error){$('#poll-calendar-message').textContent=error.message;}
  });
  async function openCreate() {
    try {
      await BoardDrafts.detach('time-poll-form-dialog');
      form().reset();delete form().elements.deadline_date.dataset.touched;form().dataset.intent=crypto.randomUUID();
      const f=form().elements,today=wallDate(Date.now(),f.timezone.value).slice(0,10);
      f.deadline_date.value=pollAddDays(today,1);
      calendarMonth=pollAddDays(today,1).slice(0,7);
      slots=[newSlot(),newSlot()];$('#poll-calendar-message').textContent='';
      $('.form-error',form()).textContent='';renderSlots();showDialog('time-poll-form-dialog');
      await BoardDrafts.bind('time-poll-form-dialog','time-poll:new',
        ()=>({fields:BoardDrafts.fields(form()),slots:readSlots().map(s=>({...s})),intent:form().dataset.intent}),
        data=>{
          BoardDrafts.fill(form(),data.fields);form().dataset.intent=data.intent;
          if(Array.isArray(data.slots))slots=data.slots.slice(0,6).map(s=>newSlot(s.date,s.time));
          else {
            const fields=Object.fromEntries(data.fields.map(v=>[v.name,v.value]));
            f.exact_time.checked=true;
            slots=Array.from({length:Math.max(2,Math.min(6,Number(fields.option_count)||3))},(_,i)=>{const value=fields['slot_'+i]||'';return newSlot(value.slice(0,10),value.slice(11,16));});
            f.deadline_date.value=(fields.deadline||'').slice(0,10);f.deadline_time.value=(fields.deadline||'').slice(11,16)||'23:59';
          }
          const first=slots.map(s=>s.date).filter(Boolean).sort()[0];if(first)calendarMonth=first.slice(0,7);
          f.deadline_date.dataset.touched='1';renderSlots();
        });
    }catch(error){toast(error.message);}
  }
  function render(p) {
    current=p;
    const canVote=p.can_vote,owner=p.can_manage;
    $('#time-poll-title').textContent=p.title;
    const options=p.options.map((o,i)=>`<div class="poll-option${p.selected_option_id===o.id?' selected':''}"><div class="poll-option-heading"><strong>时段 ${i+1}</strong>${p.selected_option_id===o.id?'<span class="event-state">已选定</span>':p.leading_option_ids.includes(o.id)?'<span class="event-state">最多人可以</span>':''}</div><p class="poll-time">${p.time_mode==='date'?esc(dayLabel(o.date))+' · 具体时间待定':timeRange({...o,timezone:p.timezone})}</p><div class="poll-totals"><span>${o.yes} 人可以</span><span>${o.maybe} 人勉强可以</span><span>${o.no} 人不行</span></div>${canVote?`<label class="field poll-choice">我的选择<select name="choice_${o.id}" required><option value="">请选择</option>${Object.entries(choices).map(([value,label])=>`<option value="${value}"${p.my_choices[o.id]===value?' selected':''}>${label}</option>`).join('')}</select></label>`:p.my_choices[o.id]?`<p class="field-help">我的选择：${esc(choices[p.my_choices[o.id]])}</p>`:''}</div>`).join('');
    $('#time-poll-content').innerHTML=`<p class="activity-status">${esc(labels[p.status])} · ${p.respondent_count} 人已投票</p><p class="field-help">${shortDate(p.deadline,p.timezone)} 截止 · ${esc(p.owner_name)} 发起<br>时区：${esc(p.timezone)}</p><p class="poll-location">地点：${esc(p.location)}</p>${p.description?`<p class="detail-description">${esc(p.description)}</p>`:''}${p.fee_policy?`<p class="detail-description">费用约定：${esc(p.fee_policy)}</p>`:''}<p class="field-help">${p.capacity?'正式活动上限 '+p.capacity+' 人':'正式活动人数不限'}${p.minimum_participants?' · 最低成团 '+p.minimum_participants+' 人':''}。投票不占名额；定案后请重新报名。</p>${p.reason?`<p class="activity-alert">发起者说明：${esc(p.reason)}</p>`:''}<form id="time-poll-vote-form">${options}${canVote?`<button class="button primary full" type="submit">${p.has_voted?'更新我的选择':'提交时间选择'}</button>`:!state.me.authenticated&&p.status==='open'?'<button class="button primary full" type="button" data-poll-action="login">登录后投票</button>':''}<p class="form-error" role="alert"></p></form>${p.event_id?'<button type="button" class="button primary full" data-poll-action="event">查看已定案活动并报名</button>':''}${owner?ownerTools(p):''}<p id="time-poll-error" class="form-error" role="alert"></p><button type="button" class="text-button full" data-poll-action="reload">刷新票数与安排</button>`;
    if(p.is_owner)$('#time-poll-content').innerHTML+=botStatus(p);
    if(p.event_time)$('#time-poll-content').innerHTML+=`<p class="activity-alert">正式活动当前安排：${timeRange(p.event_time)}</p>`;
    if(p.can_manage)updateFinalPreview();
    if(p.event_deleted)$('#time-poll-content').innerHTML+='<p class="field-help">已定案的正式活动已删除。</p>';
    if(p.can_remove)$('#time-poll-content').innerHTML+='<button type="button" class="text-button full danger" data-poll-action="remove">删除投票</button>';
  }
  function botStatus(p) {
    const states={pending:'待送',sending:'投递中',sent:'已发送',failed:'失败',skipped:'已作废',simulated:'模拟，未发送'};
    return `<details class="extra-settings"><summary>QQ 群通知 · ${p.bot_enabled?'已开启':'未开启'}</summary><p class="field-help">${p.bot_notice_enabled?'是否实际发送以投递记录为准，已发送不代表群友已读。':'管理员尚未启用机器人，当前不会排入通知。'}</p>${(p.bot_delivery||[]).map(r=>`<p class="field-help">${esc(states[r.state]||r.state)} · ${shortDate(r.sent_at||r.simulated_at||r.created_at,p.timezone)}${r.last_error&&r.state!=='simulated'?' · '+esc(r.last_error):''}${p.can_manage&&p.status==='open'&&p.bot_enabled&&['failed','simulated'].includes(r.state)?` <button type="button" class="text-button" data-poll-action="retry" data-id="${r.id}">重送通知</button>`:''}</p>`).join('')||'<p class="field-help">暂无投递记录</p>'}${p.can_manage?`<button type="button" class="button secondary full" data-poll-action="bot-sync">${p.bot_enabled?'关闭主动群通知':'开启主动群通知'}</button><p class="field-help">开启后向后台设置的目标群发送公开投票安排；定案后的正式活动沿用此设置。模拟通知不会自动重送，需手动选择重送。</p>`:''}</details>`;
  }
  function ownerTools(p) {
    const suggested=p.options.find(o=>p.leading_option_ids.includes(o.id)&&optionFuture(p,o))||p.options.find(o=>optionFuture(p,o));
    let suggestedDeadline='';
    if(suggested){const start=p.time_mode==='date'?wallToISO(suggested.date+'T18:00',p.timezone):suggested.starts_at;suggestedDeadline=wallDate(new Date(Math.max(Date.now()+60000,Date.parse(start)-3600000)),p.timezone);}
    return `<section class="poll-management"><h3>发起者定案</h3><p class="field-help">请先确认场地与费用。最高票仅供参考；同票可自行选择，未选最高票或未达最低人数时须说明原因。</p><form id="time-poll-finalize-form"><label class="field">最终时段<select name="option_id" required>${p.options.map((o,i)=>`<option value="${o.id}"${o.id===suggested?.id?' selected':''}${!optionFuture(p,o)?' disabled':''}>时段 ${i+1} · ${optionLabel(p,o)} · ${o.yes} 人可以</option>`).join('')}</select></label>${p.time_mode==='date'?'<div class="form-row"><label class="field">活动开始时间<input name="final_start_time" type="time" value="18:00" required></label><label class="field">持续小时<input name="final_duration_hours" type="number" min="1" max="24" value="3" required></label></div><p class="poll-final-preview field-help"></p>':''}<label class="field">正式报名截止<input name="registration_deadline" type="datetime-local" value="${suggestedDeadline}" required></label><label class="field">定案说明 <span class="optional">选填</span><textarea name="reason" maxlength="200" rows="2" placeholder="同票选择、人数不足仍举行或场地安排等"></textarea></label><label class="check-option"><input name="accept_terms" type="checkbox" required>我已确认场地与安排，定案后开放正式报名；本人会自动报名，其他投票者需另行报名。</label><p class="form-error" role="alert"></p><button type="submit" class="button primary full">确定时间并发布活动</button></form><details class="extra-settings"><summary>截止、重新开放与取消</summary>${p.status==='open'?'<button type="button" class="button secondary full" data-poll-action="close">提前截止投票</button>':''}<form id="time-poll-extend-form"><label class="field">新的投票截止<input type="datetime-local" name="deadline" value="${wallDate(p.deadline,p.timezone)}" required></label><p class="field-help">需早于所有候选时段，已有选择会保留。</p><p class="form-error" role="alert"></p><button class="button secondary full" type="submit">调整截止并开放投票</button></form><form id="time-poll-cancel-form"><label class="field">取消原因<textarea name="reason" maxlength="200" required rows="2"></textarea></label><p class="form-error" role="alert"></p><button class="button secondary full danger" type="submit">取消这次时间投票</button></form></details><details class="extra-settings"><summary>查看个人选择（仅发起者）</summary>${p.respondents.map(r=>`<div class="poll-respondent"><strong>${esc(r.name)}</strong><p>${p.options.map((o,i)=>`时段 ${i+1}：${esc(choices[r.choices[o.id]]||'未选择')}`).join(' · ')}</p></div>`).join('')||'<p class="field-help">尚无人投票。</p>'}</details></section>`;
  }
  function updateFinalPreview(adjustDeadline=false) {
    if(!current||current.time_mode!=='date')return;
    const f=$('#time-poll-finalize-form');if(!f)return;
    try{
      const option=current.options.find(o=>o.id===f.elements.option_id.value),start=wallToISO(option.date+'T'+f.elements.final_start_time.value,current.timezone);
      const end=new Date(Date.parse(start)+Number(f.elements.final_duration_hours.value)*3600000).toISOString();
      $('.poll-final-preview',f).textContent=timeRange({starts_at:start,ends_at:end,timezone:current.timezone});
      if(adjustDeadline&&!f.elements.registration_deadline.dataset.touched)f.elements.registration_deadline.value=wallDate(new Date(Math.max(Date.now()+60000,Date.parse(start)-3600000)),current.timezone);
    }catch{$('.poll-final-preview',f).textContent='请选择日期、开始时间与持续时长';}
  }
  $('#time-poll-dialog').addEventListener('input',event=>{
    if(event.target.name==='registration_deadline')event.target.dataset.touched='1';
    if(['option_id','final_start_time','final_duration_hours'].includes(event.target.name))updateFinalPreview(true);
  });
  $('#time-poll-dialog').addEventListener('change',event=>{if(event.target.name==='option_id')updateFinalPreview(true);});
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
        minimum_participants:Number(f.minimum_participants.value),deadline:wallToISO(f.deadline_date.value+'T'+(f.exact_time.checked?f.deadline_time.value:'23:59'),zone),
        time_mode:f.exact_time.checked?'exact':'date',
        options:readSlots().map(s=>f.exact_time.checked?{starts_at:wallToISO(s.date+'T'+s.time,zone)}:{date:s.date}),
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
        if(action==='finalize'&&p.time_mode==='date'){
          const option=p.options.find(o=>o.id===f.elements.option_id.value);
          data.starts_at=wallToISO(option.date+'T'+f.elements.final_start_time.value,p.timezone);
          data.duration_hours=Number(f.elements.final_duration_hours.value);
        }
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
    if(action==='remove'&&current?.can_remove){
      const p=current;
      askConfirm('删除这次时间投票？',`投票及已有选择将从看板移除，原链接失效，未发送的通知会停止。${p.event_id?'已生成的正式活动保留，需要另行删除。':''}已发到 QQ 群的消息不会撤回。`,async()=>{
        try{
          await api('/api/time-polls/'+p.id,'PATCH',{action:'remove',base_revision:p.revision});
          $('#time-poll-dialog').close();await refresh({detail:false});toast('投票已删除');
        }catch(error){$('#time-poll-error').textContent=error.message;}
      });
    }
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
