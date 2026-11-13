'use strict';
function pollAddDays(day,offset) {
  const date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);
}
function pollMonthDays(month) {
  const first=new Date(month+'-01T12:00:00Z');
  if(!/^\d{4}-\d{2}$/.test(month)||!Number.isFinite(first.getTime()))throw new Error("請選擇有效月份");
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
    next=slots.map(s=>({...s}));
    const empty=next.find(s=>!s.date);
    if(empty)empty.date=day;else next.push({...makeSlot(),date:day});
  }
  while(next.length<2)next.push(makeSlot());
  return next.sort((a,b)=>Number(!a.date)-Number(!b.date)||a.date.localeCompare(b.date));
}
function pollDeadlineBounds(slots,exact,zone,wallDate,wallToISO,now=Date.now()) {
  const filled=slots.filter(slot=>slot.date);
  if(!filled.length)return null;
  const end=filled.reduce((latest,slot)=>Math.max(latest,Date.parse(wallToISO((exact?slot.date:pollAddDays(slot.date,1))+'T'+(exact?slot.time:'00:00'),zone))),-Infinity);
  const latest=end-60000;
  const suggested=exact?Math.min(latest,Math.max(Math.ceil((now+1)/60000)*60000,end-3600000)):latest;
  return {end,latest:wallDate(latest,zone),suggested:suggested>now?wallDate(suggested,zone):''};
}
function pollDeadlineValue(day,time,exact,zone,bounds,wallToISO,now=Date.now()) {
  const value=wallToISO(day+'T'+(exact?time:'23:59'),zone);
  if(Date.parse(value)<=now)throw new Error("投票截止時間已過，請選擇晚於現在的時間");
  if(bounds&&Date.parse(value)>=bounds.end)throw new Error(exact?
    "投票截止需早於最後一個候選的開始時間，最晚可選 "+bounds.latest.replace('T',' ')+'（'+zone+'）':
    "日期投票於所選截止日 23:59 結束，截止日期最晚可選 "+bounds.latest.slice(0,10)+'（'+zone+'）');
  return value;
}
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
  let slots=[],slotSerial=0,calendarMonth='';
  const newSlot=(day='',time='18:00')=>({key:++slotSerial,date:day,time});
  const dayLabel=day=>new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:'UTC',year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(new Date(day+'T12:00:00Z'));
  const optionLabel=(p,o)=>p.time_mode==='date'?dayLabel(o.date):shortDate(o.starts_at,p.timezone);
  const optionFuture=(p,o)=>!o.expired&&(p.time_mode==='date'?o.date>=wallDate(Date.now(),p.timezone).slice(0,10):Date.parse(o.starts_at)>Date.now());
  function renderCalendar() {
    const f=form().elements,today=wallDate(Date.now(),f.timezone.value).slice(0,10),earliest=today;
    if(!calendarMonth)calendarMonth=earliest.slice(0,7);
    const selected=new Set(slots.map(s=>s.date).filter(Boolean));
    const {offset,days}=pollMonthDays(calendarMonth);
    $('#poll-calendar-month').textContent=new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:'UTC',year:'numeric',month:'long'}).format(new Date(calendarMonth+'-01T12:00:00Z'));
    $('#poll-calendar-weekdays').innerHTML=Array.from({length:7},(_,i)=>`<span>${esc(new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:'UTC',weekday:'short'}).format(new Date('2024-01-0'+(i+1)+'T12:00:00Z')))}</span>`).join('');
    $('#poll-calendar-days').innerHTML='<span aria-hidden="true"></span>'.repeat(offset)+days.map(day=>`<button type="button" class="poll-calendar-day${day===today?' today':''}" data-poll-form-action="day" data-day="${day}" aria-label="${esc(dayLabel(day))}" aria-pressed="${selected.has(day)}"${day===today?' aria-current="date"':''}${!selected.has(day)&&day<earliest?' disabled':''}>${Number(day.slice(-2))}</button>`).join('');
    $('[data-poll-form-action="previous-month"]',form()).disabled=calendarMonth<=earliest.slice(0,7);
    $('#poll-calendar-selection').textContent=`已選 ${selected.size} 個日期，可繼續跨月選擇。${slots.length>14?"選項較多，建議聚焦最可能的日期；仍可繼續添加和發佈。":''}`;
  }
  function readSlots() {
    const f=form().elements;
    for(const slot of slots){slot.date=f['poll_day_'+slot.key].value;slot.time=f['poll_time_'+slot.key].value;}
    return slots;
  }
  function renderSlots() {
    $('#poll-slots').innerHTML=slots.map((slot,i)=>`<div class="poll-slot"><div class="poll-slot-heading"><strong>選項 ${i+1}</strong><button type="button" class="text-button danger" data-poll-form-action="remove" data-key="${slot.key}" aria-label="移除選項 ${i+1}"${slots.length<=2?' disabled':''}>移除</button></div><div class="form-row"><label class="field">候選日期 ${i+1}<input name="poll_day_${slot.key}" type="date" value="${esc(slot.date)}" required></label><label class="field poll-slot-time">開始時間 ${i+1}<input name="poll_time_${slot.key}" type="time" value="${esc(slot.time)}" required></label></div><p class="poll-slot-preview field-help"></p></div>`).join('');
    updateOptions();
  }
  function updateOptions(event) {
    if(['deadline_date','deadline_time'].includes(event?.target?.name))form().elements.deadline_date.dataset.touched='1';
    const f=form().elements,exact=f.exact_time.checked,zone=f.timezone.value;
    const today=wallDate(Date.now(),zone).slice(0,10),earliest=today;
    $('#poll-duration').hidden=!exact;f.duration_hours.disabled=!exact;
    $('#poll-deadline-time').hidden=!exact;f.deadline_time.disabled=!exact;
    $('#poll-mode-hint').textContent=exact?"逐項指定開始時間，發佈前核對開始與結束；凌晨按實際日期選擇。":"先投日期，開始時間和持續時長在定案時補充。選中某一天表示當天方便，再按最終安排確認報名。";
    for(const slot of slots){
      const input=f['poll_day_'+slot.key],clock=f['poll_time_'+slot.key],row=input.closest('.poll-slot');
      slot.date=input.value;slot.time=clock.value;input.min=earliest;
      clock.disabled=!exact;clock.closest('label').hidden=!exact;
      const preview=$('.poll-slot-preview',row);
      try{
        if(!slot.date)throw new Error();
        if(exact){const start=wallToISO(slot.date+'T'+slot.time,zone),end=new Date(Date.parse(start)+Number(f.duration_hours.value)*3600000).toISOString();preview.textContent=timeRange({starts_at:start,ends_at:end,timezone:zone});}
        else preview.textContent=dayLabel(slot.date)+" · 具體時間待定";
      }catch{preview.textContent=exact?"請選擇日期與開始時間":"請選擇候選日期";}
    }
    updateDeadline();
    $('#poll-slot-count').textContent=`${slots.length} 個選項，至少保留 2 項。${slots.length>14?"選項較多，建議聚焦最可能的日期；仍可繼續添加和發佈。":''}`;
    renderCalendar();
  }
  function deadlineBounds() {
    const f=form().elements;
    return pollDeadlineBounds(slots,f.exact_time.checked,f.timezone.value,wallDate,wallToISO);
  }
  function readDeadline(bounds=deadlineBounds()) {
    const f=form().elements;
    return pollDeadlineValue(f.deadline_date.value,f.deadline_time.value,f.exact_time.checked,f.timezone.value,bounds,wallToISO);
  }
  function updateDeadline() {
    const f=form().elements,exact=f.exact_time.checked,zone=f.timezone.value,hint=$('#poll-deadline-hint');
    f.deadline_date.min=wallDate(Date.now(),zone).slice(0,10);f.deadline_date.max='';
    try {
      const bounds=deadlineBounds();
      if(!bounds){hint.textContent="請先選擇候選日期，投票截止需晚於現在，並早於最後一個候選的失效時間。";return;}
      f.deadline_date.max=bounds.latest.slice(0,10);
      if(!f.deadline_date.dataset.touched&&bounds.suggested){
        f.deadline_date.value=bounds.suggested.slice(0,10);
        if(exact)f.deadline_time.value=bounds.suggested.slice(11,16);
      }
      const range=exact?"最晚可選 "+bounds.latest.replace('T',' '):"截止日當天 23:59 結束，最晚可選 "+bounds.latest.slice(0,10)+"；過期候選停止收票，其餘候選可繼續投票";
      hint.textContent=range+'（'+zone+'）。';
      try{readDeadline(bounds);}catch(error){hint.textContent=error.message+'。'+hint.textContent;}
    }catch(error){hint.textContent=error.message;}
  }
  function changedSlots(){renderSlots();form().dispatchEvent(new Event('change',{bubbles:true}));}
  form().addEventListener('click',event=>{
    const button=event.target.closest('[data-poll-form-action]');if(!button)return;
    const action=button.dataset.pollFormAction;readSlots();
    try{
      if(action==='add'){slots.push(newSlot());changedSlots();form().elements['poll_day_'+slots.at(-1).key].focus();}
      if(action==='remove'&&slots.length>2){slots=slots.filter(s=>s.key!==Number(button.dataset.key));changedSlots();}
      if(action==='previous-month'||action==='next-month'){
        calendarMonth=pollShiftMonth(calendarMonth,action==='previous-month'?-1:1);renderCalendar();
      }
      if(action==='current-month'){calendarMonth=wallDate(Date.now(),form().elements.timezone.value).slice(0,7);renderCalendar();}
      if(action==='day'){
        const day=button.dataset.day,removing=slots.some(s=>s.date===day);
        slots=pollToggleCalendarDate(slots,day,newSlot);changedSlots();
        $('#poll-calendar-message').textContent=removing?"已取消該日期，其他日期會保留。":"已加入候選，可繼續點選其他日期。";
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
          if(Array.isArray(data.slots))slots=data.slots.map(s=>newSlot(s.date,s.time));
          else {
            const fields=Object.fromEntries(data.fields.map(v=>[v.name,v.value]));
            f.exact_time.checked=true;
            slots=Array.from({length:Math.max(2,Number(fields.option_count)||3)},(_,i)=>{const value=fields['slot_'+i]||'';return newSlot(value.slice(0,10),value.slice(11,16));});
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
    const options=p.options.map((o,i)=>`<div data-poll-option="${o.id}" class="poll-option${p.selected_option_id===o.id?' selected':''}"><div class="poll-option-heading"><strong>${p.time_mode==='date'?esc(dayLabel(o.date)):"時段 "+(i+1)}</strong>${p.selected_option_id===o.id?"<span class=\"event-state\">已選定</span>":p.leading_option_ids.includes(o.id)&&optionFuture(p,o)?"<span class=\"event-state poll-leading\">最多人可以</span>":''}<span class="event-state poll-expiry"${optionFuture(p,o)?' hidden':''}>已過期 · 停止收票</span></div>${p.time_mode==='date'?'':`<p class="poll-time">${timeRange({...o,timezone:p.timezone})}</p>`}<div class="poll-totals"><span>${o.yes} 人可以</span><span>${o.maybe} 人勉強可以</span><span>${o.no} 人不行</span></div>${canVote&&optionFuture(p,o)?`<fieldset class="poll-choice"><legend class="poll-choice-legend">我的選擇</legend><div class="poll-choice-options">${Object.entries(choices).map(([value,label])=>`<label class="poll-choice-button"><input type="radio" name="choice_${o.id}" value="${value}"${p.my_choices[o.id]===value?' checked':''} required><span>${esc(label)}</span></label>`).join('')}</div></fieldset>`:p.my_choices[o.id]?`<p class="field-help">我的選擇：${esc(choices[p.my_choices[o.id]])}</p>`:''}</div>`).join('');
    const toolbar=canVote?`<div class="poll-vote-toolbar"><strong id="poll-vote-progress" role="status" aria-live="polite"></strong><p class="field-help">點選每個候選的意願，最後統一保存。批次填寫只補未選項，保留已選答案。</p><div class="poll-batch-options" role="group" aria-label="批次填寫未選日期">${Object.entries(choices).map(([value,label])=>`<button type="button" data-poll-action="fill" data-choice="${value}">未選填「${esc(label)}」</button>`).join('')}</div></div>`:'';
    $('#time-poll-content').innerHTML=`<p id="time-poll-live-status" class="activity-status">${esc(labels[p.status])} · ${p.respondent_count} 人已投票</p><p class="field-help">${shortDate(p.deadline,p.timezone)} 截止 · ${esc(p.owner_name)} 發起<br>時區：${esc(p.timezone)}</p><p class="poll-location">地點：${esc(p.location)}</p>${p.description?`<p class="detail-description">${esc(p.description)}</p>`:''}${p.fee_policy?`<p class="detail-description">費用約定：${esc(p.fee_policy)}</p>`:''}<p class="field-help">${p.capacity?"正式活動上限 "+p.capacity+" 人":"正式活動人數不限"}${p.minimum_participants?" · 最低成團 "+p.minimum_participants+" 人":''}。投票不佔名額；定案後請重新報名。</p>${p.reason?`<p class="activity-alert">發起者說明：${esc(p.reason)}</p>`:''}<form id="time-poll-vote-form">${toolbar}${options}${canVote?`<button class="button primary full" type="submit">${p.has_voted?"保存修改":"保存我的選擇"}</button>`:!state.me.authenticated&&p.status==='open'?"<button class=\"button primary full\" type=\"button\" data-poll-action=\"login\">登錄後投票</button>":''}<p class="form-error" role="alert"></p></form>${p.event_id?"<button type=\"button\" class=\"button primary full\" data-poll-action=\"event\">查看已定案活動並報名</button>":''}${owner?ownerTools(p):''}<p id="time-poll-error" class="form-error" role="alert"></p><button type="button" class="text-button full" data-poll-action="reload">刷新票數與安排</button>`;
    if(p.is_owner)$('#time-poll-content').innerHTML+=botStatus(p);
    if(p.event_time)$('#time-poll-content').innerHTML+=`<p class="activity-alert">正式活動當前安排：${timeRange(p.event_time)}</p>`;
    if(p.can_manage)updateFinalPreview();
    updateVoteProgress();
    if(p.event_deleted)$('#time-poll-content').innerHTML+="<p class=\"field-help\">已定案的正式活動已刪除。</p>";
    if(p.can_remove)$('#time-poll-content').innerHTML+="<button type=\"button\" class=\"text-button full danger\" data-poll-action=\"remove\">刪除投票</button>";
  }
  function updateVoteProgress() {
    const f=$('#time-poll-vote-form'),progress=$('#poll-vote-progress');
    if(!current||!f||!progress)return;
    const active=current.options.filter(o=>optionFuture(current,o));
    const filled=active.filter(o=>f.elements?.['choice_'+o.id]?.value).length;
    progress.textContent=`已選 ${filled} / ${active.length} 個未過期候選`;
  }
  function fillUnselected(choice) {
    const f=$('#time-poll-vote-form');
    if(!current?.can_vote||current.status!=='open'||Date.parse(current.deadline)<=Date.now()||f.inert)return;
    for(const option of current.options){
      if(!optionFuture(current,option))continue;
      const group=f.elements['choice_'+option.id];
      if(group&&!group.value)group.value=choice;
    }
    updateVoteProgress();
  }
  function refreshAvailability() {
    if(!current||!$('#time-poll-dialog').open)return;
    const voteForm=$('#time-poll-vote-form');if(!voteForm||voteForm.inert)return;
    const open=current.status==='open'&&Date.parse(current.deadline)>Date.now();
    let live=0;
    for(const option of current.options){
      const future=optionFuture(current,option);if(future)live++;
      const row=$(`[data-poll-option="${option.id}"]`);if(!row)continue;
      const group=$('fieldset',row);if(group)group.disabled=!open||!future;
      $('.poll-expiry',row).hidden=future;
      const leading=$('.poll-leading',row);if(leading)leading.hidden=!future;
      const finalOption=$(`#time-poll-finalize-form option[value="${option.id}"]`);
      if(finalOption)finalOption.disabled=!future;
    }
    const button=$('button[type=submit]',voteForm);if(button)button.disabled=!open||!live;
    updateVoteProgress();
    if(current.status==='open'&&(!open||!live))$('#time-poll-live-status').textContent=labels.closed+' · '+current.respondent_count+" 人已投票";
  }
  function botStatus(p) {
    const states={pending:"待送",sending:"投遞中",sent:"已發送",failed:"失敗",skipped:"已作廢",simulated:"模擬，未發送"};
    return `<details class="extra-settings"><summary>QQ 群通知 · ${p.bot_enabled?"已開啟":"未開啟"}</summary><p class="field-help">${p.bot_notice_enabled?"是否實際發送以投遞記錄為準，已發送不代表群友已讀。":"管理員尚未啟用機器人，當前不會排入通知。"}</p>${(p.bot_delivery||[]).map(r=>`<p class="field-help">${esc(states[r.state]||r.state)} · ${shortDate(r.sent_at||r.simulated_at||r.created_at,p.timezone)}${r.last_error&&r.state!=='simulated'?' · '+esc(r.last_error):''}${p.can_manage&&p.status==='open'&&p.bot_enabled&&['failed','simulated'].includes(r.state)?` <button type="button" class="text-button" data-poll-action="retry" data-id="${r.id}">重送通知</button>`:''}</p>`).join('')||"<p class=\"field-help\">暫無投遞記錄</p>"}${p.can_manage?`<button type="button" class="button secondary full" data-poll-action="bot-sync">${p.bot_enabled?"關閉主動群通知":"開啟主動群通知"}</button><p class="field-help">開啟後向後臺設置的目標群發送公開投票安排；定案後的正式活動沿用此設置。模擬通知不會自動重送，需手動選擇重送。</p>`:''}</details>`;
  }
  function ownerTools(p) {
    const suggested=p.options.find(o=>p.leading_option_ids.includes(o.id)&&optionFuture(p,o))||p.options.find(o=>optionFuture(p,o));
    let suggestedDeadline='';
    if(suggested){const start=p.time_mode==='date'?wallToISO(suggested.date+'T18:00',p.timezone):suggested.starts_at;suggestedDeadline=wallDate(new Date(Math.max(Date.now()+60000,Date.parse(start)-3600000)),p.timezone);}
    return `<section class="poll-management"><h3>發起者定案</h3><p class="field-help">請先確認場地與費用。最高票僅供參考；同票可自行選擇，未選最高票或未達最低人數時須說明原因。</p><form id="time-poll-finalize-form"><label class="field">最終時段<select name="option_id" required>${p.options.map((o,i)=>`<option value="${o.id}"${o.id===suggested?.id?' selected':''}${!optionFuture(p,o)?' disabled':''}>時段 ${i+1} · ${optionLabel(p,o)} · ${o.yes} 人可以</option>`).join('')}</select></label>${p.time_mode==='date'?"<div class=\"form-row\"><label class=\"field\">活動開始時間<input name=\"final_start_time\" type=\"time\" value=\"18:00\" required></label><label class=\"field\">持續小時<input name=\"final_duration_hours\" type=\"number\" min=\"1\" max=\"24\" value=\"3\" required></label></div><p class=\"poll-final-preview field-help\"></p>":''}<label class="field">正式報名截止<input name="registration_deadline" type="datetime-local" value="${suggestedDeadline}" required></label><label class="field">定案說明 <span class="optional">選填</span><textarea name="reason" maxlength="200" rows="2" placeholder="同票選擇、人數不足仍舉行或場地安排等"></textarea></label><label class="check-option"><input name="accept_terms" type="checkbox" required>我已確認場地與安排，定案後開放正式報名；本人會自動報名，其他投票者需另行報名。</label><p class="form-error" role="alert"></p><button type="submit" class="button primary full">確定時間併發布活動</button></form><details class="extra-settings"><summary>截止、重新開放與取消</summary>${p.status==='open'?"<button type=\"button\" class=\"button secondary full\" data-poll-action=\"close\">提前截止投票</button>":''}<form id="time-poll-extend-form"><label class="field">新的投票截止<input type="datetime-local" name="deadline" value="${wallDate(p.deadline,p.timezone)}" required></label><p class="field-help">可晚於前面的候選，但須早於最後一個候選失效；過期候選停止收票，已有選擇會保留。</p><p class="form-error" role="alert"></p><button class="button secondary full" type="submit">調整截止並開放投票</button></form><form id="time-poll-cancel-form"><label class="field">取消原因<textarea name="reason" maxlength="200" required rows="2"></textarea></label><p class="form-error" role="alert"></p><button class="button secondary full danger" type="submit">取消這次時間投票</button></form></details><details class="extra-settings"><summary>查看個人選擇（僅發起者）</summary>${p.respondents.map(r=>`<div class="poll-respondent"><strong>${esc(r.name)}</strong><p>${p.options.map((o,i)=>`時段 ${i+1}：${esc(choices[r.choices[o.id]]||"未選擇")}`).join(' · ')}</p></div>`).join('')||"<p class=\"field-help\">尚無人投票。</p>"}</details></section>`;
  }
  function updateFinalPreview(adjustDeadline=false) {
    if(!current||current.time_mode!=='date')return;
    const f=$('#time-poll-finalize-form');if(!f)return;
    try{
      const option=current.options.find(o=>o.id===f.elements.option_id.value),start=wallToISO(option.date+'T'+f.elements.final_start_time.value,current.timezone);
      const end=new Date(Date.parse(start)+Number(f.elements.final_duration_hours.value)*3600000).toISOString();
      $('.poll-final-preview',f).textContent=timeRange({starts_at:start,ends_at:end,timezone:current.timezone});
      if(adjustDeadline&&!f.elements.registration_deadline.dataset.touched)f.elements.registration_deadline.value=wallDate(new Date(Math.max(Date.now()+60000,Date.parse(start)-3600000)),current.timezone);
    }catch{$('.poll-final-preview',f).textContent="請選擇日期、開始時間與持續時長";}
  }
  $('#time-poll-dialog').addEventListener('change',event=>{if(event.target.name?.startsWith('choice_'))updateVoteProgress();});
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
    try {await task();}catch(problem){error.textContent=problem.message+(problem.status===409?"；請先刷新票數與安排，再重新確認。":'');}
    finally{formElement.inert=false;if(button)button.disabled=false;}
  }
  form().addEventListener('input',updateOptions);
  form().addEventListener('change',updateOptions);
  form().addEventListener('submit',event=>{
    event.preventDefault();if(!BoardDrafts.ready('time-poll-form-dialog'))return;
    submit(form(),async()=>{
      const f=form().elements,zone=f.timezone.value;readSlots();
      const data={title:f.title.value.trim(),category:f.category.value,location:f.location.value.trim(),
        description:f.description.value.trim(),timezone:zone,bot_enabled:f.bot_enabled.checked,
        duration_hours:Number(f.duration_hours.value),capacity:Number(f.capacity.value),
        minimum_participants:Number(f.minimum_participants.value),deadline:readDeadline(),
        time_mode:f.exact_time.checked?'exact':'date',
        options:readSlots().map(s=>f.exact_time.checked?{starts_at:wallToISO(s.date+'T'+s.time,zone)}:{date:s.date}),
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
          choices:p.options.filter(o=>optionFuture(p,o)).map(o=>({option_id:o.id,choice:f.elements['choice_'+o.id].value}))});
        toast("選擇已保存；投票不佔正式報名名額");
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
        toast(action==='finalize'?"時間已確定，已通知投票者到活動頁報名":action==='extend'?"已調整投票截止":"投票已取消");
      }
      render(updated);await refresh({detail:false});
    });
  });
  document.addEventListener('click',event=>{
    const card=event.target.closest('[data-time-poll]');
    if(card){if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();open(card.dataset.timePoll);return;}
    const action=event.target.closest('[data-poll-action]')?.dataset.pollAction;
    if(action==='fill')fillUnselected(event.target.closest('[data-poll-action]').dataset.choice);
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
  return {open,openCreate,renderBoard,refreshAvailability};
}
