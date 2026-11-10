'use strict';
function createActivityUI({api,$,state,esc,showDialog,toast,withProfile,renderDetail,refresh,shortDate,timeRange,openEventForm,copyLink,eventUrl}) {
  const scopes={schedule:'修改安排与开始／结束',roster:'管理报名',attendance:'核对出席'};
  const attendanceNames={unknown:'未核对',present:'到场',absent:'缺席',late:'迟到',left:'早退'};
  let actionContext=null,conditionsContext=null,managementContext=null,attendanceContext=null,roleContext=null;
  const current=()=>state.events.find(e=>e.id===state.current);
  async function apply(e,message,dialogId) {
    if(dialogId)$('#'+dialogId).close();
    renderDetail(e);await refresh({detail:false});if(message)toast(message);
  }
  function alerts(e) {
    let html='';
    if(e.lifecycle==='draft')html+='<p class="activity-alert">草稿，仅发起者与已接受邀请的协办可见。</p>';
    if(e.estimated_over)html+='<p class="activity-alert">已过预计结束时间，待确认结束或延长。</p>';
    if(e.archived_at)html+='<p class="activity-alert">已归档，名单与结算记录保留。</p>';
    if(e.cancellation_reason)html+=`<p class="activity-alert">取消原因：${esc(e.cancellation_reason)}</p>`;
    if(e.minimum_participants&&!['ended','cancelled'].includes(e.lifecycle))html+=`<p class="activity-status">成团 ${e.confirmed_count}/${e.minimum_participants} 人${e.formation_state==='confirmed'?' · 已确认成团':e.minimum_met?' · 已达最低人数，待发起者确认':' · 尚未达到最低人数'}${e.is_owner&&e.formation_state==='confirmed'&&!e.minimum_met?'，请重新核对是否照常举行':''}</p>`;
    if(e.pending_confirmation_count||e.declined_confirmation_count)html+=`<p class="activity-status">安排已变更${e.pending_confirmation_count?' · '+e.pending_confirmation_count+' 人待确认':''}${e.declined_confirmation_count?' · '+e.declined_confirmation_count+' 人暂不同意':''} <button class="text-button" data-activity="conditions">查看安排</button></p>`;
    if(e.fee_policy)html+=`<details class="event-policy"><summary>费用与退出规则</summary><p>${esc(e.fee_policy)}</p><p>退出期限：${shortDate(e.withdrawal_deadline,e.timezone)}。期限后退出需提交申请；是否负担费用须按已接受的约定协调，不会自动加收。</p></details>`;
    if(e.actual_started_at||e.actual_ended_at)html+=`<p data-advanced-only class="activity-status">${e.actual_started_at?'实际开始 '+shortDate(e.actual_started_at,e.timezone):''}${e.actual_started_at&&e.actual_ended_at?' · ':''}${e.actual_ended_at?'实际结束 '+shortDate(e.actual_ended_at,e.timezone):''}</p>`;
    if(e.cohosts.length)html+=`<p data-advanced-only class="activity-status">协办：${e.cohosts.map(p=>esc(p.name)).join('、')}</p>`;
    if(e.is_owner){
      const states={pending:'待送',sending:'投递中',sent:'已发送',failed:'失败',skipped:'已作废',simulated:'模拟，未发送'};
      html+=`<details data-advanced-only class="extra-settings"><summary>QQ 群同步 · ${e.bot_enabled?'已开启':'未开启'}</summary><p class="field-help">${e.bot_feature_enabled?'通知是否实际发送，以投递记录为准；已发送不代表群友已读。':'管理员尚未启用机器人，当前不会排入通知。'}</p>${(e.bot_delivery||[]).map(r=>`<p class="field-help">${esc({activity_published:'活动信息',conditions_changed:'安排变更',deadline_reminder:'截止提醒',estimated_over_reminder:'结束提醒',settlement_updated:'结算发布',finance_closed:'账务结清',finance_reopened:'重新核对',event_started:'实际开始',event_finished:'实际结束',event_cancelled:'活动取消',formation_confirmed:'成团确认',registration_paused:'暂停报名',registration_resumed:'恢复报名',ownership_changed:'管理交接'}[r.kind]||'活动通知')} · ${esc(states[r.state]||r.state)} · ${shortDate(r.sent_at||r.simulated_at||r.created_at)}${r.last_error&&r.state!=='simulated'?' · '+esc(r.last_error):''}${e.bot_enabled&&['failed','simulated'].includes(r.state)?` <button class="text-button" data-activity="bot_retry" data-id="${r.id}">重送通知</button>`:''}</p>`).join('')||'<p class="field-help">暂无投递记录</p>'}</details>`;
    }
    return html;
  }
  function tools(e) {
    if(!e.is_owner&&!e.is_cohost)return '';
    const buttons=[];
    if(e.can_edit_schedule&&e.lifecycle!=='draft') {
      if(e.phase==='scheduled')buttons.push(`<button data-activity="${e.registration_open?'pause':'resume'}">${e.registration_open?'暂停报名':'恢复报名'}</button>`);
      if(!e.actual_started_at)buttons.push('<button data-activity="start">确认实际开始</button>');
    }
    if(e.can_manage_roster)buttons.push('<button data-roster-action="invite">邀请补报名</button>');
    if(e.can_attendance)buttons.push('<button data-activity="attendance">出席管理</button>');
    if(e.can_onsite)buttons.push('<button data-activity="onsite">现场补录</button>');
    if(e.is_owner) {
      if(!e.archived_at)buttons.push('<button data-activity="bot_sync">QQ 群同步设置</button>');
      if(e.lifecycle!=='draft'&&!['ended','cancelled'].includes(e.lifecycle)&&!e.archived_at&&e.formation_state!=='confirmed')buttons.push('<button data-activity="formation">确认成团</button>');
      if(!e.archived_at)buttons.push('<button data-activity="management">协办与转交</button>');
      if(e.lifecycle!=='draft'&&e.lifecycle!=='cancelled'&&!e.archived_at)buttons.push('<button class="danger" data-activity="cancel">取消活动</button>');
      if(['ended','cancelled'].includes(e.lifecycle))buttons.push(`<button data-activity="${e.archived_at?'unarchive':'archive'}">${e.archived_at?'取消归档':'归档'}</button>`);
    }
    return `<div class="activity-tools"><div class="owner-tools">${buttons.join('')}</div></div>`;
  }
  function openAction(e,action,extra={}) {
    const config={cancel:['取消活动','取消原因',true,'保留名单与所有帐务，仍可结算已发生的费用。'],
      archive:['归档活动','备注',false,'从默认往期列表收起，原链接与所有记录仍可查看。'],
      unarchive:['取消归档','备注',false,'重新显示于往期列表，不会重新开放报名。'],
      publish:['发布草稿','备注',false,'发布当前安排，并自动为发起者报名。'],
      start:['确认实际开始','备注',false,'记录现在为实际开始时间，停止普通报名；临时加入使用现场补录。'],
      formation:['确认成团','原因',!e.minimum_met,'未达到最低人数也可由发起者决定照常举行，请写明原因。'],
      pause:['暂停报名','备注',false,'现有名单与候补保留。'],resume:['恢复报名','备注',false,'在截止时间内按原候补顺序递补。'],
      bot_sync:['QQ 群同步设置','备注',false,'只同步公开活动。开启后会排入活动信息，并同步后续重要节点；关闭后不再查询或发送。'],
      bot_retry:['重送 QQ 通知','备注',false,'只重新排入这条通知，不重做原报名或款项操作。请核对原活动信息仍适合群成员查看；机器人仍在模拟模式时会继续模拟。'],
      revoke_role:['撤销协办','原因',true,'撤销管理权限；对方自己的报名管理权保留。'],
      revoke_invite:['撤销交接邀请','原因',true,'尚未接受的链接将失效。']}[action];
    if(!config)return;
    actionContext={event:e,action,...extra};const form=$('#activity-action-form');form.reset();
    $('#bot-sync-options').hidden=action!=='bot_sync';
    form.elements.bot_enabled.checked=!!e.bot_enabled;
    form.elements.bot_enabled.disabled=e.visibility!=='public';
    $('#bot-sync-preview').textContent=[e.title,timeRange(e),'地点：'+e.location,e.description||'',e.fee_policy||''].filter(Boolean).join('\n');
    $('#activity-action-title').textContent=config[0];$('#activity-action-hint').textContent=config[3];
    $('#activity-reason-label').textContent=config[1]+(config[2]?'':'（选填）');form.elements.reason.required=config[2];
    $('#activity-action-save').textContent=config[0];$('.form-error',form).textContent='';showDialog('activity-action-dialog');
  }
  $('#activity-action-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#activity-action-save');if(button.disabled)return;button.disabled=true;
    try {
      const {event:e,action,id}=actionContext;let path='/api/events/'+e.id,method='PATCH';
      if(action==='revoke_role'){path+='/management/roles/'+id;method='DELETE';}
      if(action==='revoke_invite'){path+='/management/invitations/'+id;method='DELETE';}
      const data={action,base_revision:e.revision,reason:form.elements.reason.value.trim()};
      if(action==='bot_sync')data.bot_enabled=form.elements.bot_enabled.checked;
      if(action==='bot_retry')data.outbox_id=Number(id);
      const updated=await api(path,method,data);
      await apply(updated,'活动已更新','activity-action-dialog');
      if(action.startsWith('revoke_'))openManagement(updated);
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{button.disabled=false;}
  });
  function arrangementHtml(arrangement,e) {
    const when={...e,starts_at:arrangement.starts_at,duration_hours:arrangement.duration_hours,timezone:arrangement.timezone,
      ends_at:arrangement.duration_hours?new Date(new Date(arrangement.starts_at).getTime()+arrangement.duration_hours*3600000).toISOString():null};
    return `<dl class="arrangement-facts"><dt>时间</dt><dd>${esc(timeRange(when))}</dd><dt>地点</dt><dd>${esc(arrangement.location)}</dd><dt>费用</dt><dd>${esc(arrangement.fee_policy||'原记录未填写费用规则')}</dd><dt>注意事项</dt><dd>${esc(arrangement.description||'无')}</dd><dt>退出期限</dt><dd>${shortDate(arrangement.withdrawal_deadline||e.deadline,arrangement.timezone)}</dd></dl>`;
  }
  async function openConditions(e) {
    conditionsContext={event:e,versions:[]};$('#conditions-current').innerHTML=arrangementHtml(e.conditions.arrangement,e);
    $('#conditions-summary').textContent=e.conditions.summary;$('#conditions-version').textContent='当前安排 · 第 '+e.conditions_version+' 版';
    const select=$('#conditions-form [name=person_id]');select.innerHTML=e.my_attendees.filter(p=>p.can_respond).sort((a,b)=>(a.confirmation_state==='accepted')-(b.confirmation_state==='accepted')).map(p=>`<option value="${p.id}">${esc(p.nickname)} · ${p.confirmation_state==='accepted'?'已接受':p.confirmation_state==='declined'?'暂不同意':'待确认'}</option>`).join('');
    $('#change-summary-fallback').hidden=true;
    $('#conditions-response-fields').hidden=!select.options.length;
    $('#conditions-response-footer').hidden=!select.options.length;
    $('#conditions-form .form-error').textContent='';$('#conditions-form [name=reason]').value='';showDialog('conditions-dialog');
    try {conditionsContext.versions=(await api('/api/events/'+e.id+'/conditions')).versions;renderPrior();}
    catch(problem){$('#conditions-form .form-error').textContent=problem.message;}
  }
  function renderPrior() {
    if(!conditionsContext)return;
    const {event:e,versions}=conditionsContext,p=e.my_attendees.find(p=>p.id===$('#conditions-form [name=person_id]').value);
    const previous=versions.find(v=>v.version===p?.accepted_conditions_version);
    $('#conditions-prior').innerHTML=previous&&previous.version!==e.conditions_version?`<details class="event-policy"><summary>这位参加者上次接受的安排 · 第 ${previous.version} 版</summary>${arrangementHtml(previous.arrangement,e)}</details>`:'';
  }
  $('#conditions-form [name=person_id]').addEventListener('change',renderPrior);
  $('#copy-change-summary').addEventListener('click',async()=>{
    const e=conditionsContext.event,a=e.conditions.arrangement;
    let link;try{link=eventUrl(e);}catch{link='请向发起者索取活动邀请链接。';}
    const summary=`${e.title}\n${e.conditions.summary}\n${timeRange(e)}\n地点：${a.location}${a.fee_policy?'\n费用规则：'+a.fee_policy:''}\n请打开活动核对安排，原报名与原约定保留，变更需要逐人确认。\n${link}`;
    try{await navigator.clipboard.writeText(summary);toast('变更摘要已复制');}
    catch{$('#change-summary-fallback').hidden=false;$('#change-summary-fallback').value=summary;$('#change-summary-fallback').select();}
  });
  async function respond(decision) {
    const form=$('#conditions-form');if(form.dataset.busy)return;form.dataset.busy='1';
    try {
      const e=conditionsContext.event,id=form.elements.person_id.value;if(!id)return;
      const updated=await api(`/api/events/${e.id}/attendees/${id}/conditions`,'PATCH',{base_revision:e.revision,conditions_version:e.conditions_version,decision,reason:form.elements.reason.value.trim()});
      await apply(updated,decision==='accepted'?'已接受当前安排':'已通知发起者协调，原报名和约定保留','conditions-dialog');
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{delete form.dataset.busy;}
  }
  $('#conditions-form').addEventListener('submit',event=>{event.preventDefault();respond('accepted');});
  $('#decline-conditions').addEventListener('click',()=>respond('declined'));
  function managementUrl(e,token) {return location.origin+'/?event='+e.id+'&management_invite='+token;}
  function openManagement(e) {
    managementContext=e;const form=$('#management-form');form.reset();
    const target=form.elements.attendee_id;
    target.innerHTML='<option value="">专属链接，由持链接者接受</option>'+e.participants.filter(p=>!p.is_guest&&!p.is_me).map(p=>`<option value="${p.id}">${esc(p.nickname)}（仅限原报名浏览器）</option>`).join('');
    $('#management-roles').innerHTML=e.cohosts.length?e.cohosts.map(p=>`<div class="management-row"><div><strong>${esc(p.name)}</strong><p>${p.permissions.map(s=>scopes[s]).join('、')}</p></div><button class="text-button danger" type="button" data-activity="revoke_role" data-id="${p.id}">撤销</button></div>`).join(''):'<p class="muted">暂无协办</p>';
    $('#management-pending').innerHTML=e.pending_management.map(p=>`<div class="management-row"><div><strong>${esc(p.target_name)} · ${p.kind==='transfer'?'接任发起者':'协办'}</strong><p>${shortDate(p.expires_at)} 前有效</p></div><button class="text-button" type="button" data-activity="copy_role" data-id="${p.id}">复制链接</button><button class="text-button danger" type="button" data-activity="revoke_invite" data-id="${p.id}">撤销</button></div>`).join('');
    $('#management-scopes').hidden=false;$('.form-error',form).textContent='';showDialog('management-dialog');
  }
  $('#management-form [name=kind]').addEventListener('change',event=>{$('#management-scopes').hidden=event.target.value==='transfer';});
  $('#management-form').addEventListener('invalid',()=>{$('#management-form .extra-settings').open=true;},true);
  $('#management-form [name=attendee_id]').addEventListener('change',event=>{
    const e=managementContext,p=e.participants.find(p=>p.id===event.target.value);if(p)$('#management-form [name=target_name]').value=p.nickname;
  });
  $('#management-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#save-management');if(button.disabled)return;button.disabled=true;
    try {
      const e=managementContext,selected=[...form.querySelectorAll('[name=permission]:checked')].map(input=>input.value);
      const updated=await api(`/api/events/${e.id}/management/invitations`,'POST',{base_revision:e.revision,kind:form.elements.kind.value,target_name:form.elements.target_name.value.trim(),attendee_id:form.elements.attendee_id.value||null,permissions:selected,reason:form.elements.reason.value.trim()});
      await apply(updated,'交接邀请已生成，请只发送给指定接任人');openManagement(updated);
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{button.disabled=false;}
  });
  async function showManagementInvitation(id,token) {
    const info=await api(`/api/events/${id}/management/invitations/${token}`);roleContext={id,token,info};
    $('#accept-role-title').textContent=info.kind==='transfer'?'接任发起者':'接受协办';
    $('#accept-role-description').textContent=info.title+' · '+info.owner_name+' 邀请 '+info.target_name;
    $('#accept-role-permissions').textContent=info.kind==='transfer'?'接受后，你将管理此活动的名单、安排和全部结算；原发起者不再拥有发起者权限。':info.permissions.map(p=>scopes[p]).join('、')+'。协办不能操作结算或转交活动。';
    $('#accept-role-form').reset();$('#accept-role-form .form-error').textContent='';showDialog('accept-role-dialog');
  }
  $('#accept-role-form').addEventListener('submit',event=>{
    event.preventDefault();withProfile(async()=>{
      const form=$('#accept-role-form'),button=$('#accept-role-button');button.disabled=true;
      try {
        const {id,token,info}=roleContext;
        const updated=await api(`/api/events/${id}/management/invitations/${token}/accept`,'POST',{base_revision:info.base_revision,accept_responsibility:form.elements.accept_responsibility.checked});
        const url=new URL(location.href);url.searchParams.delete('management_invite');window.history.replaceState(null,'',url);
        state.current=updated.id;showDialog('detail-dialog');await apply(updated,'已接受交接','accept-role-dialog');
      }catch(problem){$('.form-error',form).textContent=problem.message;if(problem.status===409){try{roleContext.info=await api(`/api/events/${roleContext.id}/management/invitations/${roleContext.token}`);}catch{}}}
      finally{button.disabled=false;}
    });
  });
  function openAttendance(e) {
    attendanceContext=e;const form=$('#attendance-form');form.reset();
    form.elements.person_id.innerHTML=e.attendance_roster.map(p=>`<option value="${p.id}">${esc(p.nickname)} · ${attendanceNames[p.attendance]}${p.status==='withdrawn'?'（已退出）':''}</option>`).join('');
    $('#attendance-empty').hidden=!!form.elements.person_id.options.length;$('#attendance-fields').hidden=!form.elements.person_id.options.length;
    $('#save-attendance').disabled=!form.elements.person_id.options.length;$('.form-error',form).textContent='';renderAttendancePerson();showDialog('attendance-dialog');
  }
  function renderAttendancePerson() {
    const form=$('#attendance-form'),p=attendanceContext?.attendance_roster.find(p=>p.id===form.elements.person_id.value);if(!p)return;
    form.elements.attendance.value=p.attendance;form.elements.attendance_note.value=p.attendance_note;
    form.elements.arrived_at.value=p.arrived_at?wallDate(p.arrived_at,attendanceContext.timezone):'';
    form.elements.left_at.value=p.left_at?wallDate(p.left_at,attendanceContext.timezone):'';
    form.elements.reason.value='';form.elements.reason.required=['ended','cancelled'].includes(attendanceContext.lifecycle);
    $('#attendance-reason-hint').textContent=form.elements.reason.required?'活动已结束或取消，补录／更正需填写原因。':'出席状态不自动改动费用或已发布结算。';
    $('#attendance-time-label').textContent='实际到离场时间（'+zoneLabel(attendanceContext.timezone)+'，选填）';
  }
  $('#attendance-form [name=person_id]').addEventListener('change',renderAttendancePerson);
  $('#attendance-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#save-attendance');if(button.disabled)return;button.disabled=true;
    try {
      const e=attendanceContext,updated=await api(`/api/events/${e.id}/attendance/${form.elements.person_id.value}`,'PATCH',{
        base_revision:e.revision,attendance:form.elements.attendance.value,attendance_note:form.elements.attendance_note.value.trim(),reason:form.elements.reason.value.trim(),
        arrived_at:form.elements.arrived_at.value?wallToISO(form.elements.arrived_at.value,e.timezone):null,left_at:form.elements.left_at.value?wallToISO(form.elements.left_at.value,e.timezone):null});
      await apply(updated,'出席已记录');openAttendance(updated);
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{button.disabled=false;}
  });
  function openOnsite(e) {
    $('#onsite-form').reset();$('#onsite-form').dataset.event=e.id;$('#onsite-form').dataset.revision=e.revision;
    $('#onsite-capacity').textContent=`目前正式 ${e.confirmed_count} 人${e.capacity?'，上限 '+e.capacity+' 人':'，人数不限'}${e.waiting_count?'；仍有 '+e.waiting_count+' 人候补':''}。`;
    $('#onsite-terms').textContent=e.fee_policy||'费用按双方已确认的实际约定处理。';$('#onsite-form .form-error').textContent='';showDialog('onsite-dialog');
  }
  $('#onsite-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#save-onsite');if(button.disabled)return;button.disabled=true;
    try {
      const e=state.events.find(e=>e.id===form.dataset.event);
      const updated=await api(`/api/events/${e.id}/onsite`,'POST',{base_revision:Number(form.dataset.revision),conditions_version:e.conditions_version,
        people:[{name:form.elements.name.value.trim(),note:form.elements.note.value.trim(),payer_kind:form.elements.payer_kind.value}],
        reason:form.elements.reason.value.trim(),allow_over_capacity:form.elements.allow_over_capacity.checked,override_waitlist:form.elements.override_waitlist.checked,
        accept_terms:form.elements.accept_terms.checked});
      await apply(updated,'已补录为正式到场人员','onsite-dialog');
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{button.disabled=false;}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-activity]');if(!button)return;
    const e=current();if(!e)return;
    const action=button.dataset.activity;
    try {
      if(action==='edit')openEventForm(e);
      else if(action==='conditions')openConditions(e);
      else if(action==='management')openManagement(e);
      else if(action==='attendance')openAttendance(e);
      else if(action==='onsite')openOnsite(e);
      else if(action==='copy_role'){const p=e.pending_management.find(p=>p.id===button.dataset.id);if(p)await copyLink(managementUrl(e,p.token));}
      else openAction(e,action,{id:button.dataset.id});
    }catch(problem){toast(problem.message);}
  });
  return {alerts,tools,showManagementInvitation,arrangementHtml,openConditions};
}
