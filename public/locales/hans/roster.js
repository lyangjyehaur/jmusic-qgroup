'use strict';
function createRosterUI({inbox,api,$,state,esc,showDialog,toast,withProfile,renderDetail,refresh,shortDate}) {
  const labels={confirmed:"正式",waiting:"候补",tentative:"待确认",invited:"待接受邀请",withdrawn:"已退出"};
  let context=null,personContext=null,invitationContext=null,unread=0;
  const current=()=>state.events.find(e=>e.id===state.current);
  const knownInvite=id=>{try{return sessionStorage.getItem('kanban-invite-'+id);}catch{return null;}};
  const rememberInvite=(id,token)=>{try{sessionStorage.setItem('kanban-invite-'+id,token);}catch{}};
  function eventUrl(e,participantToken=null) {
    const url=new URL(location.origin+'/?event='+e.id);
    const token=e.share_token||knownInvite(e.id);
    if(e.visibility==='invitation'&&!participantToken) {
      if(!token)throw new Error("请向发起者索取可转发的邀请链接");
      url.searchParams.set('invite',token);
    }
    if(participantToken)url.searchParams.set('attendee_invite',participantToken);
    return url.href;
  }
  async function copyLink(link,label="链接") {
    try{await navigator.clipboard.writeText(link);toast(label+"已复制");}
    catch{showDialog('link-dialog');$('#link-title').textContent="手动复制"+label;$('#link-input').value=link;$('#link-input').select();}
  }
  async function apply(updated,message,dialogId) {
    if(dialogId)$('#'+dialogId).close();
    const index=state.events.findIndex(e=>e.id===updated.id);
    if(index<0)state.events.push(updated);else state.events[index]=updated;
    renderDetail(updated);await refresh({detail:false});if(message)toast(message);
  }
  function personAvatar(person) {
    const initial=Array.from(String(person.nickname||'').trim())[0]||'?';
    return `<span class="participant-avatar" aria-hidden="true"><span>${esc(initial)}</span>${person.avatar_url?`<img src="${esc(person.avatar_url)}" alt="" width="24" height="24" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}</span>`;
  }
  document.addEventListener('error',event=>{
    if(event.target.matches?.('.participant-avatar img'))event.target.remove();
  },true);
  function peopleSection(e) {
    let html=e.my_attendees?.some(p=>!p.is_me)?`<details class="extra-settings"><summary>我的报名／同行 · ${e.my_attendees.length} 人</summary>${e.my_attendees.map(p=>`<p class="history-person">${esc(p.nickname)} · ${labels[p.status]}${p.waiting_position?" · 候补 "+p.waiting_position:''}${p.payer_kind==='manager'?" · 由"+esc(p.payer_name||p.manager_name)+"统一付款":" · 本人付款"}${p.can_manage&&(p.can_change||p.can_withdraw||p.can_claim)?` <button class="text-button" data-roster-action="manage" data-person="${p.id}">管理</button>`:''}</p>`).join('')}</details>`:'';
    for(const status of ['confirmed','waiting','tentative']) {
      const people=e.participants.filter(p=>p.status===status);if(!people.length)continue;
      html+=`<div class="detail-section-heading"><h3>${status==='confirmed'?(e.can_attendance?"现场名单":"报名名单"):labels[status]}</h3><span>${people.length} 人</span></div><ol class="participant-list">`;
      html+=people.map((p,index)=>{
        const extra=p.payment_locked?`保留原报名付款人：${esc(p.payer_name)}`:p.is_guest?`${esc(p.manager_name)}代报 · ${p.payer_kind==='manager'?"由"+esc(p.payer_name||p.manager_name)+"统一付款":"本人付款"}`:'';
        const confirmation=p.confirmation_state==='pending'?"新安排待确认":p.confirmation_state==='declined'?"暂不同意新安排":'';
        const attendance=({present:"到场",absent:"缺席",late:"迟到",left:"早退"})[p.attendance];
        return `<li class="participant ${status}"><span class="participant-position">${status==='waiting'?"候补 ":''}${index+1}</span><div class="participant-text"><div class="participant-heading">${personAvatar(p)}<div class="participant-name">${esc(p.nickname)}${p.is_me?"<span class=\"me-badge\">我</span>":''}${attendance?`<span class="attendance-badge">${attendance}</span>`:''}</div></div>${extra?`<p class="participant-note">${extra}</p>`:''}${p.note?`<p class="participant-note">${esc(p.note)}</p>`:''}${confirmation?`<p class="withdrawal-label">${confirmation}</p>`:''}${p.withdrawal_requested?"<p class=\"withdrawal-label\">已申请退出，待发起者处理</p>":''}</div>${p.can_manage&&(p.can_change||p.can_withdraw||p.can_claim)?`<button class="text-button participant-manage"${p.is_me?'':' data-advanced-only'} data-roster-action="manage" data-person="${p.id}">管理</button>`:''}</li>`;
      }).join('')+'</ol>';
    }
    if(!e.participants.length)html="<p class=\"muted\">暂无报名</p>";
    if(e.pending_invitations?.length)html+=`<div class="detail-section-heading invitations-heading"><h3>待接受邀请</h3><span>${e.pending_invitations.length} 人</span></div><ul class="participant-list">${e.pending_invitations.map(p=>`<li class="participant"><div class="participant-text"><span class="participant-name">${esc(p.nickname)}</span></div><button class="text-button" data-roster-action="copy-invitation" data-person="${p.id}">复制邀请</button><button class="text-button" data-roster-action="manage" data-person="${p.id}">管理</button></li>`).join('')}</ul>`;
    return html;
  }
  function joinPanel(e) {
    if(e.status==='cancelled')return "<p class=\"status-banner\">活动已取消</p>";
    const own=e.my_registration;
    let html='';
    if(own)html=`<div class="joined-row"><span class="join-status ${own.status==='waiting'?'waiting':''}">${own.status==='confirmed'?"已报名":own.status==='waiting'?`候补第 ${own.waiting_position} 位`:"待确认参加"}</span>${own.can_change||own.can_withdraw?`<button class="text-button" data-roster-action="manage" data-person="${own.id}">管理本人报名</button>`:''}</div>`;
    else if(e.can_join)html=`<form id="join-form"><details class="note-options"><summary>备注与报名规则</summary><label class="field">报名备注<span class="optional">活动内可见</span><input name="note" maxlength="100"></label><p class="field-help">${esc(e.fee_policy||"请先查看活动安排与注意事项。")} 退出期限：${shortDate(e.withdrawal_deadline,e.timezone)}。</p></details><button class="button primary full" type="submit">${e.queue_blocked||(e.capacity&&e.confirmed_count>=e.capacity)?"本人加入候补":"本人报名"}</button><p class="join-agreement">提交表示接受当前安排与费用规则 <button class="text-button" type="button" data-activity="conditions">查看</button></p></form>`;
    if(e.can_join)html+=`<div class="roster-extra-actions" data-advanced-only><button class="text-button" data-roster-action="add">同行／代报名</button>${!own?"<button class=\"text-button\" data-roster-action=\"tentative\">暂待确认</button>":''}</div>`;
    if(!html)html="<p class=\"status-banner\">报名已截止</p>";
    return html;
  }
  function invalidate() {
    if(!context)return;context.preview=null;$('#party-preview').innerHTML='';$('#save-party').textContent=context.invite?"生成邀请":"预览报名";$('#save-party').disabled=false;
  }
  function rowHtml(index) {
    const invite=context?.invite;
    return `<div class="guest-row"><div class="guest-name-row"><label class="field">参加者称呼<input name="guest_name" maxlength="24" required autocomplete="off"></label><button class="text-button" type="button" data-remove-guest aria-label="移除这位参加者">移除</button></div><details class="guest-options"><summary>${invite?"备注（选填）":"备注与付款"}</summary><label class="field">备注 <span class="optional">选填</span><input name="guest_note" maxlength="100"></label>${invite?'<input name="guest_payer" type="hidden" value="self">':"<label class=\"field\">付款归属<select name=\"guest_payer\"><option value=\"manager\">由我统一付款</option><option value=\"self\">参加者自己付款</option></select></label>"}</details></div>`;
  }
  function openParty(e,{tentative=false,invite=false}={}) {
    context={event:e,invite,preview:null};const form=$('#party-form');form.reset();
    $('#party-title').textContent=invite?"邀请补报名":"同行／代报名";
    $('#party-rows').innerHTML=tentative?'':rowHtml(0);
    $('#party-self-field').hidden=invite||!!e.my_registration;
    form.elements.include_self.checked=tentative&&!e.my_registration;
    $('#party-options').hidden=invite;$('#party-reason-field').hidden=!invite;form.elements.reason.required=invite;
    form.elements.intent.value=tentative?'tentative':'registered';
    $('#party-terms').textContent=invite?"对方接受邀请时自行确认安排与费用。":(e.fee_policy||"请先查看活动安排与注意事项。")+" 提交表示已与本人及代报者确认当前安排与费用规则。";
    $('.form-error',form).textContent='';invalidate();showDialog('party-dialog');
  }
  function partyData() {
    const form=$('#party-form'),people=[];
    if(form.elements.include_self.checked&&!$('#party-self-field').hidden)people.push({is_self:true});
    for(const row of form.querySelectorAll('.guest-row'))people.push({name:$('[name=guest_name]',row).value.trim(),note:$('[name=guest_note]',row).value.trim(),payer_kind:$('[name=guest_payer]',row).value});
    return {people,base_revision:context.event.revision,queue_mode:form.elements.queue_mode.value,intent:form.elements.intent.value,reason:form.elements.reason.value.trim()};
  }
  $('#party-form').addEventListener('input',event=>{if(event.target.name!=='accept_partial')invalidate();});
  $('#party-form').addEventListener('change',event=>{if(event.target.name!=='accept_partial')invalidate();});
  $('#party-form').addEventListener('click',event=>{const button=event.target.closest('[data-remove-guest]');if(button){button.closest('.guest-row').remove();invalidate();}});
  $('#add-guest').addEventListener('click',()=>{
    if($('#party-rows').children.length>=20){toast("每次最多添加 20 人");return;}
    $('#party-rows').insertAdjacentHTML('beforeend',rowHtml($('#party-rows').children.length));invalidate();
    $('#party-rows').lastElementChild.querySelector('input').focus();
  });
  $('#party-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#save-party');if(button.disabled)return;button.disabled=true;
    try {
      const data=partyData();if(!data.people.length)throw new Error("请勾选本人参加，或添加一位参加者");
      if(context.invite) {
        const updated=await api(`/api/events/${context.event.id}/roster/invitations`,'POST',{...data,base_revision:context.event.revision});
        await apply(updated,"邀请已生成，请复制链接给受邀者",'party-dialog');return;
      }
      if(!context.preview) {
        const result=await api(`/api/events/${context.event.id}/roster/preview`,'POST',data);context.preview=result;
        const mixed=result.allocation.some(p=>p.status==='confirmed')&&result.allocation.some(p=>p.status==='waiting');
        $('#party-preview').innerHTML=`<div class="allocation-preview">${result.allocation.map(p=>`<p><span>${esc(p.name)}</span><strong class="allocation-${p.status}">${labels[p.status]}</strong></p>`).join('')}${mixed?"<label class=\"check-option\"><input type=\"checkbox\" name=\"accept_partial\">接受部分人正式、部分人候补</label>":''}</div>`;
        button.textContent=data.intent==='tentative'?"保存待确认":"确认报名";
        $('#party-preview').scrollIntoView({block:'start',behavior:'smooth'});return;
      }
      const updated=await api(`/api/events/${context.event.id}/roster/parties`,'POST',{...data,...context.preview,accept_partial:form.elements.accept_partial?.checked===true});
      await apply(updated,"报名已保存",'party-dialog');
    }catch(problem){
      $('.form-error',form).textContent=problem.message;
      if(problem.status===409) {
        if(!context.invite) {
          invalidate();
          try{context.event=await api('/api/events/'+context.event.id);$('#party-terms').textContent=(context.event.fee_policy||"请查看最新活动安排。")+" 提交表示本人及代报人员接受当前安排。";$('.form-error',form).textContent=problem.message+"；请核对最新规则后重新预览。";}catch{}
        }
        else try{context.event=await api('/api/events/'+context.event.id);$('.form-error',form).textContent=problem.message+"；已载入最新活动，请核对后再生成邀请。";}catch{}
      }
    }
    finally{button.disabled=false;}
  });
  function openPerson(e,id) {
    const p=[...e.participants,...e.pending_invitations].find(p=>p.id===id);if(!p)return;
    BoardAdvanced.set($('#attendee-dialog'));personContext={event:e,person:p};const form=$('#attendee-form');form.reset();
    $('#attendee-title').textContent=p.nickname;$('#attendee-status').textContent=labels[p.status]+(p.withdrawal_requested?" · 已申请退出":'');
    form.elements.name.value=p.nickname;form.elements.name.readOnly=!p.is_guest;form.elements.name.closest('.field').hidden=!p.is_guest;
    $('#attendee-reason-field').toggleAttribute('data-advanced-only',!p.needs_withdrawal_request&&!p.withdrawal_requested&&p.managed_by_me);
    form.elements.note.value=p.note;form.elements.payer_kind.value=p.payer_kind;
    form.elements.payer_kind.disabled=!p.is_guest||p.payment_locked;
    $('#claim-attendee').hidden=!p.can_claim;$('#claim-attendee').onclick=()=>identityUI.issueClaim(e,p);
    $('#attendee-payment').hidden=!p.payment_locked;$('#attendee-payment').textContent="原报名付款人："+p.payer_name+"；已有账单以对应版本的付款分配为准。更改请核对并保存新结算版本。";form.elements.reason.value='';
    $('#attendee-edit-fields').hidden=!p.can_change;
    $('#save-attendee').hidden=!p.can_change||p.status==='invited';
    $('#confirm-attendee').hidden=!p.can_change||p.status!=='tentative';
    $('#confirm-attendee').textContent=p.queue_mode==='together'?"确认整组参加":"确认参加";
    $('#split-attendee').hidden=!p.can_change||p.status!=='waiting'||p.queue_mode!=='together';
    $('#withdraw-attendee').hidden=!p.can_withdraw||!!p.withdrawal_requested;
    $('#withdraw-attendee').textContent=p.status==='invited'?"撤销邀请":p.needs_withdrawal_request&&p.managed_by_me?"申请退出":"撤销这位报名";
    const canDecide=e.can_manage_roster&&p.withdrawal_requested;
    $('#approve-withdrawal').hidden=!canDecide;$('#reject-withdrawal').hidden=!canDecide;
    $('#attendee-request').textContent=p.withdrawal_requested?"退出原因："+p.withdrawal_reason:'';
    $('#reload-attendee').hidden=true;
    $('.form-error',form).textContent='';showDialog('attendee-dialog');
  }
  async function personAction(action) {
    const form=$('#attendee-form'),{event:e,person:p}=personContext,button=$('#'+action+'-attendee');
    const reason=form.elements.reason.value.trim();let method='PATCH',suffix='',data={base_revision:e.revision,reason};
    if(action==='withdraw')method='DELETE';
    else if(action==='approve'||action==='reject'){suffix='/withdrawal';data.decision=action;}
    else if(action==='save')Object.assign(data,{name:form.elements.name.value.trim(),note:form.elements.note.value.trim(),payer_kind:form.elements.payer_kind.value});
    else data.action=action;
    if(form.dataset.busy)return;form.dataset.busy='1';
    try{const updated=await api(`/api/events/${e.id}/attendees/${p.id}${suffix}`,method,data);await apply(updated,action==='withdraw'&&p.needs_withdrawal_request&&p.managed_by_me?"退出申请已提交":"名单已更新",'attendee-dialog');}
    catch(problem){$('.form-error',form).textContent=problem.message;$('#reload-attendee').hidden=problem.status!==409;}
    finally{delete form.dataset.busy;}
  }
  $('#attendee-form').addEventListener('submit',event=>{event.preventDefault();personAction('save');});
  $('#reload-attendee').addEventListener('click',async()=>{
    const button=$('#reload-attendee');button.disabled=true;
    try {
      const {event:e,person:p}=personContext,updated=await api('/api/events/'+e.id);
      renderDetail(updated);
      if([...updated.participants,...updated.pending_invitations].some(person=>person.id===p.id))openPerson(updated,p.id);
      else $('#attendee-dialog').close();
      toast("已载入最新名单，请重新核对操作");
    }catch(problem){$('#attendee-form .form-error').textContent=problem.message;}
    finally{button.disabled=false;}
  });
  for(const action of ['confirm','split','withdraw'])$('#'+action+'-attendee').addEventListener('click',()=>personAction(action));
  $('#approve-withdrawal').addEventListener('click',()=>personAction('approve'));
  $('#reject-withdrawal').addEventListener('click',()=>personAction('reject'));
  async function refreshNotifications() {
    try{const result=await api('/api/notifications');unread=result.unread_count+await inbox();$('#notification-count').textContent=unread>99?'99+':unread;$('#notification-count').hidden=!unread;$('#notifications-button').setAttribute('aria-label',unread?`${unread} 项待办或未读消息`:"消息");}
    catch{}
  }
  $('#notifications-button').addEventListener('click',async()=>{
    showDialog('notifications-dialog');const content=$('#notifications-content');content.textContent="加载中…";
    await inbox(true);
    try {
      const {notifications}=await api('/api/notifications');
      content.innerHTML=notifications.length?notifications.map(n=>`<button class="notification-entry ${n.read_at?'':'unread'}" data-notification-event="${n.event_id}"><span>${esc(n.message)}</span><time>${shortDate(n.created_at)}</time></button>`).join(''):"<p class=\"muted\">暂无消息</p>";
      const ids=notifications.filter(n=>!n.read_at).map(n=>n.id);if(ids.length)await api('/api/notifications/read','POST',{ids});await refreshNotifications();
    }catch(problem){content.textContent=problem.message;}
  });
  const actionNames={claim_invited:"邀请本人认领",claim_requested:"申请认领",claim_approved:"核对通过认领",claim_reject:"拒绝认领",claim_revoke:"撤销认领",finance_record:"登记款项",finance_report:"申报款项",finance_accept:"确认款项申报",finance_reject:"暂不确认申报",finance_withdraw:"撤回款项申报",finance_reverse:"冲销款项",finance_close:"确认账务结清",finance_reopen:"重新核对账务",event_publish:"发布草稿",event_pause:"暂停报名",event_resume:"恢复报名",event_start:"确认实际开始",event_finish:"确认实际结束",event_cancel:"取消活动",event_archive:"归档",event_unarchive:"取消归档",event_formation:"确认成团",conditions_response:"确认新安排",attendance_updated:"核对出席",onsite_added:"现场补录",management_invited:"发出管理邀请",management_invitation_revoked:"撤销管理邀请",cohost_joined:"接受协办",cohost_removed:"撤销协办",ownership_transferred:"转交发起者",event_created:"发起活动",event_updated:"修改活动",event_admin_updated:"管理员协助修改活动",signup:"报名",attendee_edit:"修改报名",attendee_confirm:"确认参加",attendee_split:"改为分开排队",withdraw:"退出报名",withdrawal_request:"申请退出",withdrawal_approve:"同意退出",withdrawal_reject:"拒绝退出",invite:"邀请补报名",invitation_accepted:"接受补报名",nickname_changed:"修改称呼",settlement_saved:"保存结算"};
  function describe(data) {
    let html='';
    if(data.participants?.length)html+=data.participants.map(p=>`<p class="history-person">${esc(p.nickname)} · ${labels[p.status]||esc(p.status)}${p.note?' · '+esc(p.note):''}${p.withdrawal_requested?" · 申请退出":''}${p.manager_name?' · '+esc(p.manager_name)+"管理":''}${p.payer_kind==='manager'?" · 统一付款":''}${p.confirmation_state==='pending'?" · 新安排待确认":p.confirmation_state==='declined'?" · 暂不同意新安排":''}${p.attendance&&p.attendance!=='unknown'?' · '+({present:"到场",absent:"缺席",late:"迟到",left:"早退"})[p.attendance]:''}${p.attendance_note?' · '+esc(p.attendance_note):''}${p.arrived_at?" · 到场 "+shortDate(p.arrived_at):''}${p.left_at?" · 离场 "+shortDate(p.left_at):''}</p>`).join('');
    if(data.nickname)html+=`<p class="history-person">${esc(data.nickname)} · ${({accepted:"已接受",declined:"暂不同意",pending:"待确认"})[data.confirmation]||''}${data.accepted_version?" · 保留已接受的第 "+data.accepted_version+" 版约定":''}</p>`;
    if(data.owner_name)html+=`<p class="history-person">发起者：${esc(data.owner_name)}</p>`;
    if(data.roles)html+=data.roles.map(p=>`<p class="history-person">协办 ${esc(p.name)} · ${p.permissions.map(scope=>({schedule:"修改安排",roster:"管理报名",attendance:"核对出席"})[scope]).join('、')}</p>`).join('');
    if(data.target_name)html+=`<p class="history-person">${esc(data.target_name)} · ${data.kind==='transfer'?"接任发起者":"协办"}</p>`;
    return html;
  }
  const fields={lifecycle:"活动阶段",registration_open:"报名开关",actual_started_at:"实际开始",actual_ended_at:"实际结束",archived_at:"归档时间",timezone:"活动时区",minimum_participants:"最低成团人数",formation_state:"成团状态",fee_policy:"费用规则",conditions_version:"安排版本",cancellation_reason:"取消原因",title:"标题",category:"类型",location:"地点",starts_at:"开始时间",deadline:"报名截止",capacity:"人数上限",description:"注意事项",duration_hours:"持续小时",status:"活动状态",withdrawal_deadline:"退出期限",visibility:"可见性"};
  function fieldValue(key,value,zone) {
    if(key==='category')return BoardI18n.category(value);
    if(value==null||value==='')return "未设置";
    if(['starts_at','deadline','withdrawal_deadline','actual_started_at','actual_ended_at','archived_at'].includes(key))return shortDate(value,zone);
    if(key==='lifecycle')return ({draft:"草稿",scheduled:"待开始",ongoing:"进行中",ended:"已结束",cancelled:"已取消"})[value]||value;
    if(key==='registration_open')return value?"开放":"关闭";
    if(key==='formation_state')return value==='confirmed'?"已确认成团":"待确认";
    if(key==='capacity'&&value===0)return "不限";
    if(key==='visibility')return value==='public'?"公开":"持邀请链接可见";
    if(key==='status')return ({open:"开放报名",closed:"暂停报名",finished:"已结束",cancelled:"已取消",deleted:"已移除"})[value]||value;
    return value;
  }
  async function history(e,before=null) {
    if(!before){$('#activity-history-content').textContent="加载中…";showDialog('activity-history-dialog');}
    try {
      const result=await api(`/api/events/${e.id}/history${before?'?before='+before:''}`);
      const html=result.entries.map(entry=>{
        const prior=entry.before.event||entry.before,after=entry.after.event||entry.after;
        const eventChanges=Object.keys(fields).filter(key=>key in after&&JSON.stringify(prior[key])!==JSON.stringify(after[key])).map(key=>`<p class="history-person">${fields[key]}：${esc(fieldValue(key,prior[key],prior.timezone))} → ${esc(fieldValue(key,after[key],after.timezone))}</p>`).join('');
        return `<details class="activity-revision"><summary>${actionNames[entry.action]||"更新记录"}<span class="revision-meta">${shortDate(entry.created_at)} · ${esc(entry.actor_name)}</span></summary>${entry.reason?`<p class="settlement-note">${esc(entry.reason)}</p>`:''}${eventChanges}${describe(entry.before)?"<p class=\"field-help\">变更前</p>"+describe(entry.before):''}${describe(entry.after)?"<p class=\"field-help\">变更后</p>"+describe(entry.after):''}${entry.action.startsWith('finance_')?"<p class=\"field-help\">金额、流向及冲销关系详见「收付款账本」。</p>":''}${entry.action==='settlement_saved'?"<p class=\"field-help\">金额及收款码详见「结算记录」。</p>":''}</details>`;
      }).join('');
      if(before){$('#load-more-history')?.remove();$('#activity-history-content').insertAdjacentHTML('beforeend',html);}
      else $('#activity-history-content').innerHTML=html||"<p class=\"muted\">暂无新增记录；旧报名已按原顺序保留。</p>";
      if(result.next_before)$('#activity-history-content').insertAdjacentHTML('beforeend',`<button class="text-button full" id="load-more-history" data-roster-action="more-history" data-before="${result.next_before}">加载更早记录</button>`);
    }catch(problem){$('#activity-history-content').textContent=problem.message;}
  }
  async function showInvitation(id,token) {
    const info=await api(`/api/events/${id}/invitations/${token}`);invitationContext={id,token,info};
    $('#accept-invitation-form').reset();$('#invitation-description').textContent=`${info.title} · ${info.name}`;
    renderInvitation(info);
    $('#accept-invitation-form .form-error').textContent='';showDialog('accept-invitation-dialog');
  }
  function renderInvitation(info) {
    $('#invitation-time').textContent=`${shortDate(info.starts_at,info.timezone)} · ${info.location}`;
    $('#invitation-conditions').innerHTML=`<p class="settlement-note">${esc(info.conditions.arrangement.fee_policy||"活动未填写费用规则，请先与发起者确认。")}</p><p class="field-help">${esc(info.conditions.arrangement.description||'')}</p>`;
  }
  $('#accept-invitation-form').addEventListener('submit',event=>{
    event.preventDefault();withProfile(async()=>{
      const form=$('#accept-invitation-form'),button=$('#accept-invitation-button');button.disabled=true;
      try {
        const {id,token,info}=invitationContext;
        const updated=await api(`/api/events/${id}/invitations/${token}/accept`,'POST',{base_revision:info.base_revision,conditions_version:info.conditions.version,accept_waiting:form.elements.accept_waiting.checked});
        const url=new URL(location.href);url.searchParams.delete('attendee_invite');historyReplace(url);
        state.current=updated.id;showDialog('detail-dialog');await apply(updated,"邀请已接受",'accept-invitation-dialog');
      }catch(problem){$('.form-error',form).textContent=problem.message;if(problem.status===409){try{invitationContext.info=await api(`/api/events/${invitationContext.id}/invitations/${invitationContext.token}`);renderInvitation(invitationContext.info);}catch{}}}
      finally{button.disabled=false;}
    });
  });
  function historyReplace(url){window.history.replaceState(null,'',url);}
  document.addEventListener('click',async event=>{
    const notification=event.target.closest('[data-notification-event]');
    if(notification){$('#notifications-dialog').close();try{const e=await api('/api/events/'+notification.dataset.notificationEvent);state.current=e.id;showDialog('detail-dialog');await apply(e,'');const url=new URL(location.href);url.searchParams.set('event',e.id);historyReplace(url);}catch(problem){toast(problem.message);}return;}
    const button=event.target.closest('[data-roster-action]');if(!button)return;
    const e=current();if(!e)return;
    try {
      const action=button.dataset.rosterAction;
      if(action==='add')withProfile(()=>openParty(e));
      if(action==='tentative')withProfile(()=>openParty(e,{tentative:true}));
      if(action==='invite')openParty(e,{invite:true});
      if(action==='manage')openPerson(e,button.dataset.person);
      if(action==='history')history(e);
      if(action==='more-history')history(e,button.dataset.before);
      if(action==='copy-invitation'){const p=e.pending_invitations.find(p=>p.id===button.dataset.person);if(p)await copyLink(eventUrl(e,p.invitation_token));}
    }catch(problem){toast(problem.message);}
  });
  return {peopleSection,joinPanel,refreshNotifications,eventUrl,copyLink,rememberInvite,showInvitation};
}
