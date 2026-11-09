'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = {events:[], me:{nickname:''}, filter:'upcoming', category:'全部', search:'', current:null, loaded:false};
let profileContinuation = null, confirmCallback = null, toastTimer = null, refreshPromise = null;
let dialogStack=[],detailSignature='',historyReturning=false,modalBack=false;
const intentId=()=>crypto.randomUUID();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const deviceZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const effectiveZone=zone=>zone||deviceZone();
const dateFormat=(value,zone)=>new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:effectiveZone(zone),month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const shortDate=(value,zone)=>new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:effectiveZone(zone),month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
function wallDate(value,zone) {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:effectiveZone(zone),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const get=kind=>parts.find(p=>p.type===kind).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
const localDate=value=>wallDate(value,null);
function wallToISO(value,zone) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error("请填写完整日期与时间");
  const target=new Date(value+'Z').getTime();if(!Number.isFinite(target))throw new Error("请填写有效日期");
  const offsets=new Set();
  for(const hours of [-36,-24,-12,0,12,24,36]) {
    const sample=target+hours*3600000,display=wallDate(sample,zone);
    offsets.add(new Date(display+'Z').getTime()-Math.floor(sample/60000)*60000);
  }
  const candidates=[...offsets].map(offset=>target-offset).filter(stamp=>wallDate(stamp,zone)===value);
  if(candidates.length!==1)throw new Error(candidates.length?"这个时间处于夏令时重复时段，请选一个明确的时间":"这个时区没有这个本地时间，请重新选择");
  return new Date(candidates[0]).toISOString();
}
const zoneLabel=zone=>new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:effectiveZone(zone),timeZoneName:'short'}).formatToParts(new Date()).find(p=>p.type==='timeZoneName').value;
const clock=(value,zone)=>new Intl.DateTimeFormat(BoardI18n.locale,{timeZone:effectiveZone(zone),hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const endLabel=(start,end,zone)=>wallDate(start,zone).slice(0,10)===wallDate(end,zone).slice(0,10)?clock(end,zone):dateFormat(end,zone);
const timeRange=e=>`${dateFormat(e.starts_at,e.timezone)}${e.ends_at?'–'+endLabel(e.starts_at,e.ends_at,e.timezone):''} (${zoneLabel(e.timezone)})`;
function formStart() {
  const form=$('#event-form');
  return new Date(wallToISO(`${form.elements.event_date.value}T${form.elements.start_time.value}`,form.elements.timezone.value));
}
function updateEndPreview() {
  const form=$('#event-form');let start;try{start=formStart();}catch{$('#end-time-preview').textContent='';return;}const duration=Number(form.elements.duration_hours.value);
  $('#end-time-preview').textContent=Number.isNaN(start.getTime())?'':`结束时间：${endLabel(start,new Date(start.getTime()+duration*3600000),form.elements.timezone.value)}`;
  if(!Number.isNaN(start.getTime())) {
    const startValue=wallDate(start,form.elements.timezone.value),deadline=form.elements.deadline;
    if(!deadline.value||deadline.value===form.dataset.previousStart||deadline.value>startValue)deadline.value=startValue;
    form.dataset.previousStart=startValue;
    syncWithdrawalDeadline();
  }
}
const isPast=e=>['ended','cancelled'].includes(e.lifecycle);
const isFull = e => e.capacity>0 && e.confirmed_count>=e.capacity;
const countLabel = e => e.capacity ? `${e.confirmed_count}/${e.capacity} 人` : `${e.confirmed_count} 人报名`;
const canJoin = e => e.status === 'open' && new Date(e.deadline) > new Date() && new Date(e.starts_at) > new Date();

const api=BoardClient.request;
function toast(message) {
  clearTimeout(toastTimer);
  placeToast();
  $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function placeToast() {
  const host=dialogStack.filter(dialog=>dialog.open).slice(-1)[0]||document.body;
  if($('#toast').parentElement!==host)host.append($('#toast'));
  const footer=host===document.body?null:$('.form-footer,.join-panel',host);
  $('#toast').style.bottom=footer?`${Math.max(20,window.innerHeight-footer.getBoundingClientRect().top+8)}px`:'';
}
function showDialog(id) {
  const dialog=$('#'+id);
  if (!dialog.open) {dialog.showModal();dialogStack=dialogStack.filter(item=>item!==dialog);dialogStack.push(dialog);if(id!=='detail-dialog'){dialog.dataset.modalToken=intentId();history.pushState({kanbanDialog:dialog.dataset.modalToken},'',location.href);}}
  placeToast();
}
function setProfile() {
  $('#my-name').textContent = state.me.authenticated?(state.me.nickname || "设置称呼"):"登录";
  const qq=state.me.qq,visible=Boolean(state.me.authenticated&&qq?.bound);
  $('#home-account-title').textContent=state.me.authenticated?"我的账号":"QQ 登录";
  $('#home-qq-profile').hidden=!visible;$('#home-qq-name').textContent=visible?'QQ：'+qq.nickname:'';
  for(const selector of ['#my-qq-avatar','#home-qq-avatar']){
    const avatar=$(selector);avatar.hidden=!visible||!qq.avatar_url;
    if(visible&&qq.avatar_url)avatar.src=qq.avatar_url;else avatar.removeAttribute('src');
  }
  $('#qq-account-button').hidden=!state.me.qq?.enabled;
  $('#home-qq-button').disabled=!state.me.qq?.enabled&&!state.me.allow_name_registration;
  $('#home-qq-status').textContent=state.me.authenticated?"已登录，可在个人资料中修改称呼。":"登录后即可发起活动和报名。";
}
function openProfile(next=null) {
  if(!state.me.authenticated)return identityUI.account();
  profileContinuation=next;
  $('#nickname-input').value=state.me.nickname;
  $('#profile-form .form-error').textContent='';
  BoardAdvanced.set($('#profile-dialog'));showDialog('profile-dialog');
  profileCodes.open();$('#nickname-input').focus();
}
function withProfile(next) { if(!state.me.authenticated)return identityUI.account(); if (state.me.nickname) return next(); else openProfile(next); }
function eventStatus(e) {
  if(e.lifecycle==='draft')return ["草稿",'closed'];
  if(e.archived_at)return ["已归档",'closed'];
  if(e.lifecycle==='cancelled')return ["已取消",'closed'];
  if(e.lifecycle==='ended')return [e.settlement?"已公布结算":"已结束",'closed'];
  if(e.estimated_over)return ["待确认结束",'waiting'];
  if(e.phase==='ongoing')return ["进行中",''];
  if(!e.registration_open)return ["暂停报名",'closed'];
  if(new Date(e.deadline)<=new Date())return ["报名截止",'closed'];
  if(isFull(e))return ["满员 · 可候补",'waiting'];
  if(e.queue_blocked)return ["可候补",'waiting'];
  return ["可报名",''];
}
function renderBoard() {
  const upcoming=state.events.filter(e=>!isPast(e)&&e.lifecycle!=='draft'&&!e.archived_at);
  $('#archived-option').hidden=state.filter!=='past';
  $('#event-count').textContent=upcoming.length;
  $('#category-filter').hidden=new Set(state.events.map(e=>e.category)).size<2 && state.category==='全部';
  const list = state.events.filter(e => {
    if(state.filter==='upcoming'&&(isPast(e)||e.lifecycle==='draft'||e.archived_at))return false;
    if(state.filter==='past'&&(!isPast(e)||(e.archived_at&&!$('#include-archived').checked)))return false;
    if (state.filter==='mine' && !e.my_attendees?.length && !e.is_owner && !e.is_cohost && e.finance?.my_balance_cents==null) return false;
    return (state.category==='全部' || e.category===state.category) && (!state.search || `${e.title} ${e.location} ${e.description} ${e.owner_name}`.toLowerCase().includes(state.search));
  });
  if (state.filter==='past') list.reverse();
  if (!list.length) {
    const filtered=state.search || state.category!=='全部';
    const title=filtered?"没有符合条件的活动":state.filter==='mine'?"暂无参与的活动":state.filter==='past'?"暂无往期活动":"暂无活动";
    $('#board').innerHTML=`<div class="empty-state"><h3>${title}</h3>${!filtered&&state.filter==='mine'?"<button class=\"button secondary\" data-action=\"browse\">查看活动</button>":''}</div>`;
    return;
  }
  $('#board').innerHTML=list.map(e=>{
    const [label,kind]=eventStatus(e);
    const myState=financeUI.cardLabel(e)||(e.settlement?(e.settlement.mode==='detailed'?(e.my_payable_cents!=null?"我应付 ¥"+centsText(e.my_payable_cents):"已公布结算"):`每人 ¥${e.settlement.per_person_amount}`):e.my_registration?(e.my_registration.status==='waiting'?"候补中":e.my_registration.status==='tentative'?"待确认":"已报名"):e.my_attendees?.length?`代报 ${e.my_attendees.length} 人`:e.is_owner?"我发起的":e.is_cohost?"我协办的":'');
    return `<a class="event-card" href="/?event=${e.id}" data-event="${e.id}" aria-label="${esc(e.title)}，${label}"><div class="card-heading"><h3 class="card-title">${esc(e.title)}</h3><span class="event-state ${kind}">${label}</span></div><div class="card-facts"><span>${timeRange(e)}</span><span class="card-location">${esc(e.location)}</span></div><div class="card-bottom"><span class="capacity">${countLabel(e)}</span>${e.waiting_count?`<span class="waiting-count">候补 ${e.waiting_count}</span>`:''}${myState?`<span class="my-state">${myState}</span>`:''}<span class="category-label">${esc(BoardI18n.category(e.category))}</span><span class="card-chevron" aria-hidden="true">›</span></div></a>`;
  }).join('');
}

async function refresh({loud=false, detail=true}={}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise=(async()=>{
    try {
      const result=await api('/api/events'); state.events=result.events; state.loaded=true;
      $('#load-error').hidden=true; renderBoard();
      if (detail && state.current && $('#detail-dialog').open) {
        const e=state.events.find(x=>x.id===state.current);
        // Do not discard a note while someone is typing it.
        if (e && !$('#join-form')?.contains(document.activeElement)) renderDetail(e,{preserve:true});
      }
      await rosterUI.refreshNotifications();
      if (loud) toast("活动已更新");
      return true;
    } catch(error) {
      $('#load-error').textContent=error.message+"，请刷新重试。"; $('#load-error').hidden=false;
      if (!state.loaded) $('#board').innerHTML="<div class=\"empty-state\">无法加载活动，请刷新重试。</div>";
      return false;
    } finally { refreshPromise=null; }
  })(); return refreshPromise;
}
function changeFilter(filter) {
  state.filter=filter;
  $$('.tab').forEach(b=>{b.classList.toggle('active',b.dataset.filter===filter);b.setAttribute('aria-pressed',b.dataset.filter===filter?'true':'false');});
  renderBoard();
}
function setUrlEvent(id) {
  const url=new URL(location.href);
  if(id) url.searchParams.set('event',id); else url.searchParams.delete('event');
  if(url.href!==location.href) history.pushState(null,'',url);
}
async function openDetail(id, changeUrl=true) {
  try {
    const e=await api('/api/events/'+id); state.current=id; renderDetail(e); showDialog('detail-dialog');
    if(changeUrl) setUrlEvent(id);
  } catch(error) { toast(error.message); }
}
function renderDetail(e,{preserve=false}={}) {
  const content=$('#detail-content'),signature=JSON.stringify(e);
  preserve=preserve&&content.dataset.eventId===e.id;
  if(preserve&&signature===detailSignature)return;
  const advanced=preserve&&content.dataset.advanced==='true';
  const previous=preserve?{scroll:$('.detail-main',content)?.scrollTop||0,panel:$('.join-panel',content)?.scrollTop||0,
    note:$('#join-form [name=note]')?.value,noteDirty:$('#join-form [name=note]')?.value!==$('#join-form [name=note]')?.defaultValue,
    noteOpen:$('.note-options',content)?.open}:null;
  content.dataset.eventId=e.id;detailSignature=signature;
  const index=state.events.findIndex(item=>item.id===e.id);if(index<0)state.events.push(e);else state.events[index]=e;
  const [label,kind]=eventStatus(e);
  let panel=rosterUI.joinPanel(e);
  if(isPast(e))panel=e.can_settle?`<button class="button primary full" data-detail-action="settle">${e.settlement?(e.settlement.mode==='detailed'?"编辑结算":"核对并转逐人结算"):"填写结算"}</button>`:`<p class="status-banner">${e.settlement?"结算已公布":e.lifecycle==='cancelled'?"活动已取消":"活动已结束"}</p>`;
  if(e.lifecycle==='draft')panel="<p class=\"status-banner\">草稿尚未开放报名</p>";
  if(e.can_finish)panel+="<button class=\"button secondary full finish-button\" data-detail-action=\"finish\">结束并结算</button>";
  const canRespond=e.my_attendees.some(p=>p.can_respond&&p.confirmation_state!=='accepted');
  if(canRespond)panel="<button class=\"button primary full\" data-activity=\"conditions\">确认变更后的安排</button>"+panel;
  $('#detail-content').innerHTML=`<div class="detail-top"><div class="dialog-heading"><h2>${esc(e.title)}</h2><button class="icon-button" data-close="detail-dialog" aria-label="关闭">×</button></div><p class="detail-meta"><span>${esc(BoardI18n.category(e.category))}</span><span class="event-state ${kind}">${label}</span></p><dl class="detail-facts"><dt>时间</dt><dd>${timeRange(e)}</dd><dt>地点</dt><dd>${esc(e.location)} <a class="text-button navigation-link" href="https://uri.amap.com/search?keyword=${encodeURIComponent(e.location)}" target="_blank" rel="noopener noreferrer">导航</a></dd></dl><p class="detail-secondary">${shortDate(e.deadline,e.timezone)} 截止报名 · ${esc(e.owner_name)} 发起${e.withdrawal_deadline!==e.deadline?`<br>${shortDate(e.withdrawal_deadline,e.timezone)} 后退出需申请`:''}</p></div><div class="detail-main">${activityUI.alerts(e)}${settlementSection(e)}${e.finance?.has_records||e.finance?.pending_count?financeUI.section(e):''}${e.description?`<section class="event-notes"><h3>${e.category==='约K'?"注意事项":"活动说明"}</h3><p class="detail-description">${esc(e.description)}</p></section>`:''}${rosterUI.peopleSection(e)}${e.claim_invitations?.some(c=>c.can_decide||c.status==='requested')?identityUI.section(e):''}<div class="detail-tools"><button data-detail-action="share">复制活动链接</button>${e.can_edit_schedule?"<button data-activity=\"edit\">编辑活动</button>":''}${e.is_owner&&e.lifecycle==='draft'?"<button data-activity=\"publish\">发布草稿</button>":''}</div></div><div class="join-panel">${panel}${BoardAdvanced.control()}<div class="detail-extra-controls" data-advanced-only>${!e.finance?.has_records&&!e.finance?.pending_count?financeUI.section(e):''}${!e.claim_invitations?.some(c=>c.can_decide||c.status==='requested')?identityUI.section(e):''}<div class="detail-tools"><button data-detail-action="summary">复制活动摘要</button><button data-detail-action="copy">复制为新活动</button><button data-roster-action="history">活动记录</button>${activityUI.tools(e)}</div></div></div>`;
  BoardAdvanced.set(content,advanced);
  $('#join-form')?.addEventListener('submit', event=>{
    event.preventDefault();
    const note=new FormData(event.currentTarget).get('note') || '';
    withProfile(()=>joinEvent(e.id,note,e));
  });
  if(previous) {
    if($('.note-options',content))$('.note-options',content).open=previous.noteOpen;
    if(previous.noteDirty&&$('#join-form [name=note]'))$('#join-form [name=note]').value=previous.note;
    $('.detail-main',content).scrollTop=previous.scroll;
    $('.join-panel',content).scrollTop=previous.panel;
  }
}

async function joinEvent(id,note,viewedEvent) {
  const button=$('#join-form button[type=submit]'); if(button)button.disabled=true;
  try {
    const e=await api(`/api/events/${id}/registration`,'PUT',{note,base_revision:viewedEvent.revision,conditions_version:viewedEvent.conditions_version});
    renderDetail(e); await refresh({detail:false});
    toast(e.my_registration.status==='waiting'?"已加入候补，有空位会自动递补":"报名已保存");
  } catch(error) {if(error.status===409){try{renderDetail(await api('/api/events/'+id),{preserve:true});}catch{}}toast(error.message);if(button)button.disabled=false;}
}
function askConfirm(title,message,callback,labels={}) {
  $('#confirm-title').textContent=title; $('#confirm-message').textContent=message;
  $('#confirm-action').textContent=labels.confirm||"确认";$('#confirm-cancel').textContent=labels.cancel||"返回";
  confirmCallback=callback; showDialog('confirm-dialog');
}
async function mutateEvent(id,data,message) {
  try {
    const e=await api('/api/events/'+id,'PATCH',{...data,base_revision:state.events.find(e=>e.id===id)?.revision});
    if(data.status==='deleted') $('#detail-dialog').close(); else renderDetail(e);
    await refresh({detail:false});toast(message);
  } catch(error){toast(error.message);}
}
async function openEventForm(e=null,copy=false) {
  try{await BoardDrafts.detach('event-form-dialog');}catch(error){toast(error.message);return;}
  const source=copy?e:null;if(copy)e=null;
  const form=$('#event-form');form.reset();form.elements.id.value=e?.id||'';form.dataset.intent=intentId();
  BoardAdvanced.set($('#event-form-dialog'));for(const details of form.querySelectorAll('details'))details.open=false;form.dataset.revision=e?.revision??'';form.dataset.lifecycle=e?.lifecycle||'';
  const zone=e?e.timezone:'Asia/Shanghai',zoneSelect=form.elements.timezone;
  if(zone&&![...zoneSelect.options].some(option=>option.value===zone))zoneSelect.add(new Option(zone,zone));zoneSelect.value=zone||'';
  let start;
  if(e) {
    for(const key of ['title','category','location','description'])form.elements[key].value=e[key];
    form.elements.capacity_unlimited.checked=e.capacity===0;form.elements.capacity.value=e.capacity||8;
    start=new Date(e.starts_at);form.elements.deadline.value=wallDate(e.deadline,zone);form.elements.duration_hours.value=e.duration_hours||3;
  } else {
    const day=new Date(wallDate(Date.now(),'Asia/Shanghai').slice(0,10)+'T00:00:00Z');day.setUTCDate(day.getUTCDate()+1);
    start=new Date(wallToISO(day.toISOString().slice(0,10)+'T18:00',zone));form.elements.deadline.value=wallDate(start,zone);
  }
  form.elements.withdrawal_deadline.value=e?wallDate(e.withdrawal_deadline,zone):form.elements.deadline.value;
  form.elements.visibility.value=e?.visibility||'public';form.elements.minimum_participants.value=e?.minimum_participants||0;
  form.elements.fee_policy.value=e?e.fee_policy:"按正式参加人数均摊；同行正常 AA；迟到、早退默认不减免。费用以活动实际结算为准。";
  form.dataset.previousDeadline=form.elements.deadline.value;updateCapacityInput();
  const startValue=wallDate(start,zone);form.elements.event_date.value=startValue.slice(0,10);form.elements.start_time.value=startValue.slice(11,16);
  form.dataset.previousStart=startValue;updateEndPreview();
  $('#event-change-reason').hidden=!e||e.lifecycle==='draft';
  $('#save-draft').hidden=!!e&&e.lifecycle!=='draft';
  $('#form-title').textContent=e?"编辑活动":"发起活动";
  $('#publish-button').textContent=e?(e.lifecycle==='draft'?"发布草稿":"保存修改"):"发布活动";
  if(source) {
    for(const name of ['title','category','location','description','fee_policy','visibility','minimum_participants'])form.elements[name].value=source[name];
    form.elements.capacity_unlimited.checked=source.capacity===0;form.elements.capacity.value=source.capacity||8;
    form.elements.duration_hours.value=source.duration_hours||3;
    if(source.timezone&&![...zoneSelect.options].some(v=>v.value===source.timezone))zoneSelect.add(new Option(source.timezone,source.timezone));
    zoneSelect.value=source.timezone||'';form.elements.start_time.value=wallDate(source.starts_at,source.timezone).slice(11,16);
    form.elements.event_date.value='';form.elements.deadline.value='';form.elements.withdrawal_deadline.value='';updateCapacityInput();updateEndPreview();
    $('#form-title').textContent="复制活动";$('#publish-button').textContent="发布活动";
  }
  updateEventAdvancedSummary();form.dataset.presetDuration=form.elements.duration_hours.value;
  $('#event-reload').hidden=true;$('#event-form .form-error').textContent='';showDialog('event-form-dialog');
  try{await BoardDrafts.bind('event-form-dialog',e?'event:'+e.id:source?'copy:'+source.id:'event:new',
    ()=>({fields:BoardDrafts.fields(form),dataset:{...form.dataset}}),data=>{BoardDrafts.fill(form,data.fields);Object.assign(form.dataset,data.dataset);updateCapacityInput();updateEventAdvancedSummary();$('#end-time-preview').textContent='';try{const start=formStart();$('#end-time-preview').textContent="结束时间："+endLabel(start,new Date(start.getTime()+Number(form.elements.duration_hours.value)*3600000),form.elements.timezone.value);}catch{}if((e&&Number(form.dataset.revision)!==e.revision)||(form.elements.id.value&&Number(form.dataset.revision)<0)){$('#event-reload').hidden=false;return "草稿基于旧版活动；请保留需要的文字并载入最新版后重新核对";}});}catch(error){$('.form-error',form).textContent=error.message;}
  if(!source)form.elements.title.focus();else form.elements.event_date.focus();
}

const centsText = cents => `${cents<0?'-':''}${Math.floor(Math.abs(cents)/100)}.${String(Math.abs(cents)%100).padStart(2,'0')}`;
function roundingText(difference) {
  if(!difference)return '';
  return `四舍五入到分，合计${difference>0?"多":"少"} ¥${centsText(Math.abs(difference))}，尾差由发起人处理。`;
}
function qrUrl(e) { return `/api/events/${e.id}/payment-code?v=${encodeURIComponent(e.settlement.updated_at)}`; }
function settlementBody(bill,imageUrl,showEmpty=false,eventId=null) {
  if(bill.mode==='detailed')return invoiceUI.body(bill,eventId,imageUrl);
  return `<p class="settlement-amount">每人应付<strong>¥${esc(bill.per_person_amount)}</strong></p><p class="settlement-details">总金额 ¥${esc(bill.total_amount)} ÷ ${bill.headcount} 人</p>${bill.rounding_difference_cents?`<p class="field-help">${roundingText(bill.rounding_difference_cents)}</p>`:''}${bill.note?`<p class="settlement-note">${esc(bill.note)}</p>`:showEmpty?"<p class=\"field-help\">无备注</p>":''}${settlementCodeCards(bill,esc)|| (showEmpty?"<p class=\"field-help\">无收款码</p>":'')}`;
}
function settlementSection(e) {
  const bill=e.settlement;if(!bill)return '';
  return `<section class="settlement-section" aria-label="活动结算"><div class="settlement-heading"><h3>活动结算</h3><button class="text-button" data-detail-action="settlement-history">结算记录</button></div>${bill.mode==='detailed'&&e.my_payable_cents!=null?`<p class="my-obligation">我的应付合计 ¥${centsText(e.my_payable_cents)}</p>`:''}${settlementBody(bill,qrUrl(e),false,e.id)}</section>`;
}
async function openSettlementHistory(e) {
  const content=$('#settlement-history-content');content.textContent="加载中…";showDialog('settlement-history-dialog');
  try {
    const {revisions}=await api(`/api/events/${e.id}/settlement/history`);
    const labels={people:"人员与份数",items:"费用项目与凭证",payers:"付款归属",qr_digest:"收款码",total_amount:"总金额",headcount:"分摊人数",note:"备注",qr_image:"收款码"};
    const timestamp=value=>new Intl.DateTimeFormat(BoardI18n.locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));
    content.innerHTML=revisions.map((bill,index)=>{
      const kind=bill.kind==='converted'?"转为逐人结算":bill.kind==='detailed_published'?"发布逐人结算":bill.kind==='detailed_edited'?"修改"+bill.changed_fields.map(field=>labels[field]||field).join('、'):bill.kind==='baseline'?"已有结算":bill.kind==='published'?"首次发布":`修改${bill.changed_fields.map(field=>labels[field]||field).join('、')}`;
      return `<details class="settlement-revision"${index===0?' open':''}><summary><span>第 ${bill.version} 版 · ${esc(kind)}</span><span class="revision-meta">${timestamp(bill.updated_at)} · ${esc(bill.actor_name)}</span></summary>${bill.kind==='baseline'?"<p class=\"field-help\">启用记录前的已有结算，更早的修改未记录。</p>":''}<div class="revision-bill">${settlementBody(bill,`/api/events/${e.id}/settlement/history/${bill.version}/payment-code`,true,e.id)}</div></details>`;
    }).join('')||"<p class=\"muted\">暂无结算记录</p>";
  }catch(problem){content.textContent=problem.message;}
}
function openSettlement(e) {return invoiceUI.open(e);}
function readDataUrl(blob) {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("图片读取失败，请重试"));reader.readAsDataURL(blob);});
}
async function prepareCode(file) {
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error("请选择 PNG、JPG 或 WebP 图片");
  if(file.size>10*1024*1024)throw new Error("图片超过 10 MB，请裁剪后上传");
  const original=await readDataUrl(file),image=new Image();image.src=original;
  try{await image.decode();}catch{throw new Error("无法读取这张图片，请重新选择");}
  let scale=Math.min(1,1200/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
  for(let attempt=0;attempt<4;attempt++) {
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    const data=canvas.toDataURL('image/png');
    if(data.length<2700000)return data;
    scale*=.75;
  }
  throw new Error("图片过大，请裁剪图片后上传");
}
async function shareEvent(id) {
  try{await rosterUI.copyLink(rosterUI.eventUrl(state.events.find(e=>e.id===id)));}catch(problem){toast(problem.message);}
}

async function renderInbox(open=false) {
  let operations=[];try{operations=await BoardClient.pending();}catch(error){if(open)$('#pending-content').textContent=error.message;}
  const todos=boardTodos(state.events);
  if(open) {
    $('#pending-operations').hidden=!operations.length;$('#todo-section').hidden=!todos.length;
    $('#todo-content').innerHTML=todos.map(t=>`<button class="notification-entry" data-todo-event="${t.eventId}" data-kind="${t.kind}"><span>${esc(t.title)}</span><strong>${esc(t.label)}</strong></button>`).join('')||"<p class=\"field-help\">暂无待办</p>";
    $('#pending-content').innerHTML=operations.map((op,index)=>`<div class="pending-entry"><p>${esc(state.events.find(e=>op.path.includes(e.id))?.title||"活动／个人操作")} · ${esc(op.method==='POST'&&op.path==='/api/events'?"发起活动":op.path.endsWith('/finance')?"登记款项":op.path.endsWith('/settlement/detailed')?"发布结算":"保存操作")}</p><button class="text-button" type="button" data-operation="${index}">查询原结果</button><button class="text-button" type="button" data-operation-retry="${index}" hidden>原结果未提交，安全重试</button><p class="field-help operation-result"></p></div>`).join('')||"<p class=\"field-help\">没有结果未知的操作</p>";
    for(const button of $$('[data-operation],[data-operation-retry]'))button.onclick=async()=>{
      const retry=button.hasAttribute('data-operation-retry'),op=operations[Number(retry?button.dataset.operationRetry:button.dataset.operation)],row=button.closest('.pending-entry');button.disabled=true;
      try{
        const result=await BoardClient.recover(op.key,retry);
        if(!result.committed){$('.operation-result',row).textContent="服务器尚未提交；可按原内容、原版本安全重试。";$('[data-operation-retry]',row).hidden=false;return;}
        $('.operation-result',row).textContent="原操作已成功，请以最新活动／账本为准。";$$('button',row).forEach(b=>b.hidden=true);
        if(op.path==='/api/events'&&op.data.client_intent)await BoardDrafts.markCreated(op.data.client_intent,result.result);
        await refresh();
      }catch(error){$('.operation-result',row).textContent=error.message;}
      finally{button.disabled=false;}
    };
  }
  return todos.length+operations.length;
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-todo-event]');if(!button)return;
  $('#notifications-dialog').close();await openDetail(button.dataset.todoEvent);const e=state.events.find(v=>v.id===button.dataset.todoEvent);
  if(button.dataset.kind==='finance'&&e)financeUI.open(e);
  if(button.dataset.kind==='settle'&&e)openSettlement(e);
  if(button.dataset.kind==='conditions'&&e)$('[data-activity=conditions]',$('#detail-content'))?.click();
});

BoardAdvanced.init();
BoardDrafts.init({scope:()=>state.me.draft_scope,toast,showDialog});

const rosterUI=createRosterUI({inbox:renderInbox,api,$,state,esc,showDialog,toast,withProfile,renderDetail,refresh,shortDate});
const identityUI=createIdentityUI({api,$,esc,showDialog,toast,state,withProfile,refresh,renderDetail,askConfirm,copyLink:rosterUI.copyLink,openDetail});
const profileCodes=createPaymentCodeLibraryUI({api,$,esc,prepareCode,askConfirm,toast});
const invoiceUI=createSettlementUI({api,$,esc,showDialog,toast,renderDetail,refresh,prepareCode,centsText,askConfirm});
const financeUI=createFinanceUI({api,$,esc,showDialog,toast,renderDetail,refresh,centsText,wallDate,wallToISO,shortDate,withProfile});
const activityUI=createActivityUI({api,$,state,esc,showDialog,toast,withProfile,renderDetail,refresh,shortDate,timeRange,openEventForm,copyLink:rosterUI.copyLink,eventUrl:rosterUI.eventUrl});

document.addEventListener('click',event=>{
  const close=event.target.closest('[data-close]');if(close){BoardDrafts.close($('#'+close.dataset.close));return;}
  const card=event.target.closest('.event-card[data-event]');if(card){if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();openDetail(card.dataset.event);return;}
  const filter=event.target.closest('[data-filter]');if(filter){changeFilter(filter.dataset.filter);return;}

  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action==='create')withProfile(()=>openEventForm());
  if(action==='browse')changeFilter('upcoming');
  const detailAction=event.target.closest('[data-detail-action]')?.dataset.detailAction;
  const e=state.events.find(x=>x.id===state.current);
  if(!detailAction||!e)return;
  if(detailAction==='share')shareEvent(e.id);
  if(detailAction==='copy')withProfile(()=>openEventForm(e,true));
  if(detailAction==='summary')try{rosterUI.copyLink(`${e.title}\n${timeRange(e)}\n地点：${e.location}\n${e.description?e.description+'\n':''}${e.fee_policy?"费用："+e.fee_policy+'\n':''}报名截止：${dateFormat(e.deadline,e.timezone)}\n${e.conditions?.summary?"本版变更："+e.conditions.summary+'\n':''}${rosterUI.eventUrl(e)}`,"活动摘要");}catch(error){toast(error.message);}
  if(detailAction==='select-share')$('#share-fallback input').select();
  if(detailAction==='edit')openEventForm(e);
  if(detailAction==='settle')openSettlement(e);
  if(detailAction==='settlement-history')openSettlementHistory(e);
  if(detailAction==='finance')financeUI.open(e);
  if(detailAction==='finance-report')withProfile(()=>financeUI.open(e,true));
  if(detailAction==='finish')askConfirm("结束活动并结算？","结束后将停止报名并移入往期，报名名单保留。",async()=>{
    try{const updated=await api('/api/events/'+e.id,'PATCH',{status:'finished',base_revision:e.revision});renderDetail(updated);await refresh({detail:false});if(updated.can_settle)openSettlement(updated);else toast("活动已结束，由发起者填写结算");}
    catch(problem){toast(problem.message);}
  });
  if(detailAction==='toggle')mutateEvent(e.id,{status:e.status==='closed'?'open':'closed'},e.status==='closed'?"已恢复报名":"已暂停报名，现有名单保留");
  if(detailAction==='cancel-registration')askConfirm("取消报名？","取消后，候补的朋友会按顺序自动递补。重新报名会排在队尾。",async()=>{
    try{const updated=await api(`/api/events/${e.id}/registration`,'DELETE',{base_revision:e.revision});renderDetail(updated);await refresh({detail:false});toast("已取消报名");}catch(error){toast(error.message);}
  });
  if(detailAction==='cancel-event')askConfirm("确定取消这次活动？","活动会标记为已取消，报名名单保留在往期活动中。",()=>mutateEvent(e.id,{status:'cancelled'},"活动已取消"));
  if(detailAction==='remove')askConfirm("从看板移除这个活动？","这个已取消的活动将不再显示，原链接也会失效。",()=>mutateEvent(e.id,{status:'deleted'},"已从看板移除"));
});
$('#profile-button').addEventListener('click',()=>openProfile());
$('#create-button').addEventListener('click',()=>withProfile(()=>openEventForm()));
$('#refresh-button').addEventListener('click',()=>refresh({loud:true}));
$('#include-archived').addEventListener('change',renderBoard);
$('#category-filter').addEventListener('change',event=>{state.category=event.target.value;renderBoard();});
$('#search').addEventListener('input',event=>{state.search=event.target.value.trim().toLowerCase();renderBoard();});
$('#confirm-action').addEventListener('click',async()=>{
  const callback=confirmCallback;confirmCallback=null;$('#confirm-dialog').close();if(callback)await callback();
});
$('#profile-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;const button=$('button[type=submit]',form);button.disabled=true;
  try {
    state.me={...state.me,...await api('/api/profile','POST',{nickname:form.elements.nickname.value.trim()})};setProfile();
    $('#profile-dialog').close();await refresh();const next=profileContinuation;profileContinuation=null;if(next)next();else toast("称呼已更新");
  }catch(error){$('.form-error',form).textContent=error.message;}finally{button.disabled=false;}
});
$('#event-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=$('#publish-button');button.disabled=true;form.inert=true;
  try {
    if(!BoardDrafts.ready('event-form-dialog'))return;
    if(await BoardClient.hasPending(form.elements.id.value||'new'))throw new Error("先在消息的「待确认操作」查询上次保存结果，再继续发布");
    const data=Object.fromEntries(new FormData(form));data.client_intent=form.dataset.intent;const id=data.id;delete data.id;
    const draft=event.submitter?.value==='draft';
    if(!id||form.dataset.lifecycle==='draft')data.join_owner=true;
    data.withdrawal_deadline=wallToISO(form.elements.withdrawal_deadline.value,form.elements.timezone.value);if(id)data.base_revision=Number(form.dataset.revision);
    data.capacity=form.elements.capacity_unlimited.checked?0:Number(data.capacity);delete data.capacity_unlimited;data.duration_hours=Number(data.duration_hours);data.minimum_participants=Number(data.minimum_participants);
    data.timezone=data.timezone||null;data.starts_at=formStart().toISOString();data.deadline=wallToISO(data.deadline,form.elements.timezone.value);delete data.event_date;delete data.start_time;delete data.intent;
    if(!id)data.lifecycle=draft?'draft':'scheduled';
    let result=await api('/api/events'+(id?'/'+id:''),id?'PATCH':'POST',data);
    form.dataset.revision=result.revision;form.elements.id.value=result.id;
    await BoardDrafts.touch('event-form-dialog');
    if(id&&form.dataset.lifecycle==='draft'&&!draft)result=await api('/api/events/'+id,'PATCH',{action:'publish',base_revision:result.revision});
    await BoardDrafts.clear('event-form-dialog');$('#event-form-dialog').close();await refresh({detail:false});
    if(result.lifecycle==='draft')changeFilter('mine');
    await openDetail(result.id);toast(result.lifecycle==='draft'?"草稿已保存":id?"活动已更新":"活动已发布");
  }catch(error){$('.form-error',form).textContent=error.message;if(error.message.includes("截止"))BoardAdvanced.set($('#event-form-dialog'),true);}finally{button.disabled=false;form.inert=false;}
});
function updateCapacityInput() {
  const form=$('#event-form'),unlimited=form.elements.capacity_unlimited.checked;
  $('.limited-capacity').hidden=unlimited;
  form.elements.capacity.disabled=unlimited;
}
function syncWithdrawalDeadline() {
  const form=$('#event-form');
  if(!form.elements.withdrawal_deadline.value||form.elements.withdrawal_deadline.value===form.dataset.previousDeadline)form.elements.withdrawal_deadline.value=form.elements.deadline.value;
  form.dataset.previousDeadline=form.elements.deadline.value;
}
$('#event-form [name=category]').addEventListener('change',()=>{const f=$('#event-form'),hours={约K:'3',聚餐:'2',运动:'2',出游:'8',游戏:'3',其他:'3'}[f.elements.category.value];if(!f.elements.id.value&&f.elements.duration_hours.value===f.dataset.presetDuration){f.elements.duration_hours.value=hours;updateEndPreview();}f.dataset.presetDuration=hours;$('#form-title').textContent=f.elements.id.value?"编辑活动":"发起活动";$('#publish-button').textContent=f.elements.id.value?"保存修改":"发布活动";});
$('#event-form [name=deadline]').addEventListener('input',syncWithdrawalDeadline);
$('#event-form [name=capacity_unlimited]').addEventListener('change',updateCapacityInput);
for(const name of ['event_date','start_time','duration_hours','timezone']) {
  $('#event-form [name='+name+']').addEventListener('input',updateEndPreview);
  $('#event-form [name='+name+']').addEventListener('change',updateEndPreview);
}
$('#detail-dialog').addEventListener('close',()=>{state.current=null;if(!$('#detail-dialog').dataset.fromHistory)setUrlEvent(null);delete $('#detail-dialog').dataset.fromHistory;});
$$('dialog').forEach(dialog=>{
  dialog.addEventListener('close',()=>{if(!dialog.open)dialogStack=dialogStack.filter(item=>item!==dialog);placeToast();syncModalHistory();});
  dialog.addEventListener('cancel',event=>{event.preventDefault();BoardDrafts.close(dialog);});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)BoardDrafts.close(dialog);}});
});
function syncModalHistory() {
  const marker=history.state?.kanbanDialog;
  if(!modalBack&&marker&&!dialogStack.some(d=>d.open&&d.dataset.modalToken===marker)){modalBack=true;history.back();}
}
window.addEventListener('popstate',async()=>{
  if(modalBack){modalBack=false;syncModalHistory();return;}
  const top=dialogStack.filter(d=>d.open).slice(-1)[0];
  if(top&&top.id!=='detail-dialog'){
    // Restore this history entry before opening the unsaved-change question.
    if(BoardDrafts.isDirty(top.id)||top.querySelector('form[inert]'))history.pushState({kanbanDialog:top.dataset.modalToken},'',location.href);
    const closed=await BoardDrafts.close(top);
    if(!closed&&!BoardDrafts.isDirty(top.id)&&!top.querySelector('form[inert]'))history.pushState({kanbanDialog:top.dataset.modalToken},'',location.href);
    return;
  }
  const id=new URL(location.href).searchParams.get('event');
  if(id)openDetail(id,false);else if($('#detail-dialog').open){$('#detail-dialog').dataset.fromHistory='1';$('#detail-dialog').close();}
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
setInterval(()=>{if(document.visibilityState==='visible')refresh();},30000);
(async()=>{
  try{state.me=await api('/api/me');BoardClient.setIdentity(state.me.draft_scope);setProfile();}catch(error){toast(error.message);}
  const params=new URL(location.href).searchParams,id=params.get('event'),invite=params.get('invite'),participantInvite=params.get('attendee_invite'),managementInvite=params.get('management_invite'),claim=params.get('claim'),accountLink=params.get('account_link');
  if(id&&invite&&state.me.authenticated) {
    try{await api('/api/events/'+id+'/access','POST',{invite_token:invite});rosterUI.rememberInvite(id,invite);}catch(problem){toast(problem.message);}
  }
  await refresh();
  if(params.get('qq')==='return')await identityUI.receiveQQ();
  else if(accountLink&&state.me.authenticated)await identityUI.receiveDevice(accountLink);
  else if(id&&claim&&state.me.authenticated)await identityUI.receiveClaim(id,claim);
  else if(id&&managementInvite){try{await activityUI.showManagementInvitation(id,managementInvite);}catch(problem){toast(problem.message);}}
  else if(id&&participantInvite){try{await rosterUI.showInvitation(id,participantInvite);}catch(problem){toast(problem.message);}}
  else if(id)openDetail(id,false);
  identityUI.receipt();
  try{if(sessionStorage.getItem('kanban-welcome')){sessionStorage.removeItem('kanban-welcome');toast("欢迎使用群聚看板！可在个人资料修改群内称呼，再选择活动报名或发起新活动。");}}catch{}
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('.timezone-hint').textContent="日期和截止时间按所选活动时区填写；跨日会显示完整结束日期。";
})();

document.addEventListener('error',event=>{
  const img=event.target;if(img.tagName!=='IMG'||!img.getAttribute('src')||!img.closest('.payment-code-link,.invoice-image'))return;
  const parent=img.parentElement;if(parent.querySelector('.image-retry'))return;
  const button=document.createElement('button');button.type='button';button.className='text-button image-retry';button.textContent="图片加载失败，点击重试";
  button.onclick=e=>{e.preventDefault();e.stopPropagation();button.remove();const url=new URL(img.src,location.href);if(url.protocol==='data:')return;url.searchParams.set('retry',Date.now());img.src=url.href;};parent.append(button);
},true);

document.addEventListener('load',event=>{if(event.target.tagName==='IMG')event.target.parentElement?.querySelector('.image-retry')?.remove();},true);
$('#event-reload').onclick=async()=>{try{const latest=await api('/api/events/'+$('#event-form').elements.id.value);await BoardDrafts.clear('event-form-dialog');await openEventForm(latest);}catch(e){toast(e.message);}};
if(window.visualViewport){const sizeDialogs=()=>document.documentElement.style.setProperty('--visible-height',window.visualViewport.height+'px');window.visualViewport.addEventListener('resize',sizeDialogs);sizeDialogs();}

function updateEventAdvancedSummary() {
  const form=$('#event-form'),f=form.elements,parts=[];
  if(!f.capacity_unlimited.checked)parts.push("上限 "+f.capacity.value+" 人");
  if(f.visibility.value==='invitation')parts.push("邀请可见");
  if(Number(f.minimum_participants.value))parts.push("成团 "+f.minimum_participants.value+" 人");
  if(f.timezone.value!=='Asia/Shanghai')parts.push("时区 "+(f.timezone.value||"跟随设备"));
  const start=f.event_date.value+'T'+f.start_time.value;
  if(f.deadline.value&&f.deadline.value!==start)parts.push("已设报名截止");
  if(f.withdrawal_deadline.value&&f.withdrawal_deadline.value!==f.deadline.value)parts.push("已设退出期限");
  const defaults="按正式参加人数均摊；同行正常 AA；迟到、早退默认不减免。费用以活动实际结算为准。";
  if(f.fee_policy.value&&f.fee_policy.value!==defaults)parts.push("自定费用规则");
  const target=$('#event-advanced-summary');target.hidden=!parts.length;target.textContent="已设置："+parts.join(' · ');
}
$('#event-form').addEventListener('input',updateEventAdvancedSummary);
$('#event-form').addEventListener('change',updateEventAdvancedSummary);
