'use strict';
function createActivityUI({api,$,state,esc,showDialog,toast,withProfile,renderDetail,refresh,shortDate,timeRange,openEventForm,copyLink,eventUrl}) {
  const scopes={schedule:"修改安排與開始／結束",roster:"管理報名",attendance:"核對出席",settlement:"發佈結算、管理帳款與使用本人收款碼"};
  const attendanceNames={unknown:"未核對",present:"到場",absent:"缺席",late:"遲到",left:"早退"};
  let actionContext=null,conditionsContext=null,managementContext=null,attendanceContext=null,roleContext=null;
  const current=()=>state.events.find(e=>e.id===state.current);
  async function apply(e,message,dialogId) {
    if(dialogId)$('#'+dialogId).close();
    renderDetail(e);await refresh({detail:false});if(message)toast(message);
  }
  function alerts(e) {
    let html='';
    if(e.lifecycle==='draft')html+="<p class=\"activity-alert\">草稿，僅發起者與已接受邀請的協辦可見。</p>";
    if(e.estimated_over)html+="<p class=\"activity-alert\">已過預計結束時間，待確認結束或延長。</p>";
    if(e.archived_at)html+="<p class=\"activity-alert\">已歸檔，名單與結算記錄保留。</p>";
    if(e.cancellation_reason)html+=`<p class="activity-alert">取消原因：${esc(e.cancellation_reason)}</p>`;
    if(e.minimum_participants&&!['ended','cancelled'].includes(e.lifecycle))html+=`<p class="activity-status">成團 ${e.confirmed_count}/${e.minimum_participants} 人${e.formation_state==='confirmed'?" · 已確認成團":e.minimum_met?" · 已達最低人數，待發起者確認":" · 尚未達到最低人數"}${e.is_owner&&e.formation_state==='confirmed'&&!e.minimum_met?"，請重新核對是否照常舉行":''}</p>`;
    if(e.pending_confirmation_count||e.declined_confirmation_count)html+=`<p class="activity-status">安排已變更${e.pending_confirmation_count?' · '+e.pending_confirmation_count+" 人待確認":''}${e.declined_confirmation_count?' · '+e.declined_confirmation_count+" 人暫不同意":''} <button class="text-button" data-activity="conditions">查看安排</button></p>`;
    if(e.fee_policy)html+=`<details class="event-policy"><summary>費用與退出規則</summary><p>${esc(e.fee_policy)}</p><p>退出期限：${shortDate(e.withdrawal_deadline,e.timezone)}。期限後退出需提交申請；是否負擔費用須按已接受的約定協調，不會自動加收。</p></details>`;
    if(e.actual_started_at||e.actual_ended_at)html+=`<p data-advanced-only class="activity-status">${e.actual_started_at?"實際開始 "+shortDate(e.actual_started_at,e.timezone):''}${e.actual_started_at&&e.actual_ended_at?' · ':''}${e.actual_ended_at?"實際結束 "+shortDate(e.actual_ended_at,e.timezone):''}</p>`;
    const settler=e.cohosts.find(p=>p.permissions.includes('settlement'));
    if(settler)html+=`<p class="activity-status">指定結算人：${esc(settler.name)}</p>`;
    if(e.cohosts.length)html+=`<p data-advanced-only class="activity-status">協辦：${e.cohosts.map(p=>esc(p.name)).join('、')}</p>`;
    if(e.is_owner||e.management_scopes?.includes('settlement')){
      const states={pending:"待送",sending:"投遞中",sent:"已發送",failed:"失敗",skipped:"已作廢",simulated:"模擬，未發送"};
      html+=`<details data-advanced-only class="extra-settings"><summary>QQ 群同步 · ${e.bot_enabled?"已開啟":"未開啟"}</summary><p class="field-help">${e.bot_feature_enabled?"通知是否實際發送，以投遞記錄為準；已發送不代表群友已讀。":"管理員尚未啟用機器人，當前不會排入通知。"}</p>${(e.bot_delivery||[]).map(r=>`<p class="field-help">${esc(r.payment_kind?({wechat:"微信收款碼",alipay:"支付寶收款碼",other:"其他收款碼"}[r.payment_kind]||"收款碼"):{activity_published:"活動信息",conditions_changed:"安排變更",deadline_reminder:"截止提醒",estimated_over_reminder:"結束提醒",settlement_updated:"結算發佈",finance_closed:"帳務結清",finance_reopened:"重新核對",event_started:"實際開始",event_finished:"實際結束",event_cancelled:"活動取消",formation_confirmed:"成團確認",registration_paused:"暫停報名",registration_resumed:"恢復報名",ownership_changed:"管理交接"}[r.kind]||"活動通知")} · ${esc(states[r.state]||r.state)} · ${shortDate(r.sent_at||r.simulated_at||r.created_at)}${r.last_error&&r.state!=='simulated'?' · '+esc(r.last_error):''}${e.bot_enabled&&['failed','simulated'].includes(r.state)?` <button class="text-button" data-activity="bot_retry" data-id="${r.id}">重送通知</button>`:''}</p>`).join('')||"<p class=\"field-help\">暫無投遞記錄</p>"}</details>`;
    }
    return html;
  }
  function tools(e) {
    if(!e.is_owner&&!e.is_cohost)return '';
    const buttons=[];
    if(e.can_edit_schedule&&e.lifecycle!=='draft'&&(e.management_scopes||[]).includes('schedule')) {
      if(e.phase==='scheduled')buttons.push(`<button data-activity="${e.registration_open?'pause':'resume'}">${e.registration_open?"暫停報名":"恢復報名"}</button>`);
      if(!e.actual_started_at)buttons.push("<button data-activity=\"start\">確認實際開始</button>");
    }
    if(e.can_manage_roster)buttons.push("<button data-roster-action=\"invite\">邀請補報名</button>");
    if(e.can_attendance)buttons.push("<button data-activity=\"attendance\">出席管理</button>");
    if(e.can_onsite)buttons.push("<button data-activity=\"onsite\">現場補錄</button>");
    if(e.is_owner) {
      if(!e.archived_at)buttons.push("<button data-activity=\"bot_sync\">QQ 群同步設置</button>");
      if(e.lifecycle!=='draft'&&!['ended','cancelled'].includes(e.lifecycle)&&!e.archived_at&&e.formation_state!=='confirmed')buttons.push("<button data-activity=\"formation\">確認成團</button>");
      if(!e.archived_at)buttons.push("<button data-activity=\"management\">協辦與轉交</button>");
      if(e.lifecycle!=='draft'&&e.lifecycle!=='cancelled'&&!e.archived_at)buttons.push("<button class=\"danger\" data-activity=\"cancel\">取消活動</button>");
      if(['ended','cancelled'].includes(e.lifecycle))buttons.push(`<button data-activity="${e.archived_at?'unarchive':'archive'}">${e.archived_at?"取消歸檔":"歸檔"}</button>`);
    }
    return `<div class="activity-tools"><div class="owner-tools">${buttons.join('')}</div></div>`;
  }
  function openAction(e,action,extra={}) {
    const config={cancel:["取消活動","取消原因",true,"保留名單與所有帳務，仍可結算已發生的費用。"],
      archive:["歸檔活動","備註",false,"從默認往期列表收起，原鏈接與所有記錄仍可查看。"],
      unarchive:["取消歸檔","備註",false,"重新顯示於往期列表，不會重新開放報名。"],
      publish:["發佈草稿","備註",false,"發佈當前安排，並自動為發起者報名。"],
      start:["確認實際開始","備註",false,"記錄現在為實際開始時間，停止普通報名；臨時加入使用現場補錄。"],
      formation:["確認成團","原因",!e.minimum_met,"未達到最低人數也可由發起者決定照常舉行，請寫明原因。"],
      pause:["暫停報名","備註",false,"現有名單與候補保留。"],resume:["恢復報名","備註",false,"在截止時間內按原候補順序遞補。"],
      bot_sync:["QQ 群同步設置","備註",false,"此開關只控制主動通知。開啟後會排入公開活動信息，並同步後續重要節點；關閉後停止主動通知，已發佈的公開活動仍可在群內查詢。"],
      bot_retry:["重送 QQ 通知","備註",false,"只重新排入這條通知，不重做原報名或款項操作。請核對原活動信息仍適合群成員查看；機器人仍在模擬模式時會繼續模擬。"],
      revoke_role:["撤銷協辦","原因",true,"撤銷管理權限；對方自己的報名管理權保留。"],
      revoke_invite:["撤銷交接邀請","原因",true,"尚未接受的鏈接將失效。"]}[action];
    if(!config)return;
    actionContext={event:e,action,...extra};const form=$('#activity-action-form');form.reset();
    $('#bot-sync-options').hidden=action!=='bot_sync';
    form.elements.bot_enabled.checked=!!e.bot_enabled;
    form.elements.bot_enabled.disabled=e.visibility!=='public';
    $('#bot-sync-preview').textContent=[e.title,timeRange(e),"地點："+e.location,e.description||'',e.fee_policy||''].filter(Boolean).join('\n');
    $('#activity-action-title').textContent=config[0];$('#activity-action-hint').textContent=config[3];
    $('#activity-reason-label').textContent=config[1]+(config[2]?'':"（選填）");form.elements.reason.required=config[2];
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
      await apply(updated,"活動已更新",'activity-action-dialog');
      if(action.startsWith('revoke_'))openManagement(updated);
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{button.disabled=false;}
  });
  function arrangementHtml(arrangement,e) {
    const when={...e,starts_at:arrangement.starts_at,duration_hours:arrangement.duration_hours,timezone:arrangement.timezone,
      ends_at:arrangement.duration_hours?new Date(new Date(arrangement.starts_at).getTime()+arrangement.duration_hours*3600000).toISOString():null};
    return `<dl class="arrangement-facts"><dt>時間</dt><dd>${esc(timeRange(when))}</dd><dt>地點</dt><dd>${esc(arrangement.location)}</dd><dt>費用</dt><dd>${esc(arrangement.fee_policy||"原記錄未填寫費用規則")}</dd><dt>注意事項</dt><dd>${esc(arrangement.description||"無")}</dd><dt>退出期限</dt><dd>${shortDate(arrangement.withdrawal_deadline||e.deadline,arrangement.timezone)}</dd></dl>`;
  }
  async function openConditions(e) {
    conditionsContext={event:e,versions:[]};$('#conditions-current').innerHTML=arrangementHtml(e.conditions.arrangement,e);
    $('#conditions-summary').textContent=e.conditions.summary;$('#conditions-version').textContent="當前安排 · 第 "+e.conditions_version+" 版";
    const select=$('#conditions-form [name=person_id]');select.innerHTML=e.my_attendees.filter(p=>p.can_respond).sort((a,b)=>(a.confirmation_state==='accepted')-(b.confirmation_state==='accepted')).map(p=>`<option value="${p.id}">${esc(p.nickname)} · ${p.confirmation_state==='accepted'?"已接受":p.confirmation_state==='declined'?"暫不同意":"待確認"}</option>`).join('');
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
    $('#conditions-prior').innerHTML=previous&&previous.version!==e.conditions_version?`<details class="event-policy"><summary>這位參加者上次接受的安排 · 第 ${previous.version} 版</summary>${arrangementHtml(previous.arrangement,e)}</details>`:'';
  }
  $('#conditions-form [name=person_id]').addEventListener('change',renderPrior);
  $('#copy-change-summary').addEventListener('click',async()=>{
    const e=conditionsContext.event,a=e.conditions.arrangement;
    let link;try{link=eventUrl(e);}catch{link="請向發起者索取活動邀請鏈接。";}
    const summary=`${e.title}\n${e.conditions.summary}\n${timeRange(e)}\n地點：${a.location}${a.fee_policy?"\n費用規則："+a.fee_policy:''}\n請打開活動核對安排，原報名與原約定保留，變更需要逐人確認。\n${link}`;
    try{await navigator.clipboard.writeText(summary);toast("變更摘要已複製");}
    catch{$('#change-summary-fallback').hidden=false;$('#change-summary-fallback').value=summary;$('#change-summary-fallback').select();}
  });
  async function respond(decision) {
    const form=$('#conditions-form');if(form.dataset.busy)return;form.dataset.busy='1';
    try {
      const e=conditionsContext.event,id=form.elements.person_id.value;if(!id)return;
      const updated=await api(`/api/events/${e.id}/attendees/${id}/conditions`,'PATCH',{base_revision:e.revision,conditions_version:e.conditions_version,decision,reason:form.elements.reason.value.trim()});
      await apply(updated,decision==='accepted'?"已接受當前安排":"已通知發起者協調，原報名和約定保留",'conditions-dialog');
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{delete form.dataset.busy;}
  }
  $('#conditions-form').addEventListener('submit',event=>{event.preventDefault();respond('accepted');});
  $('#decline-conditions').addEventListener('click',()=>respond('declined'));
  function managementUrl(e,token) {return location.origin+'/?event='+e.id+'&management_invite='+token;}
  function openManagement(e,settlement=false) {
    managementContext=e;const form=$('#management-form');form.reset();
    const target=form.elements.attendee_id;
    target.innerHTML="<option value=\"\">專屬鏈接，由持鏈接者接受</option>"+e.participants.filter(p=>!p.is_guest&&!p.is_me).map(p=>`<option value="${p.id}">${esc(p.nickname)}（僅限原報名瀏覽器）</option>`).join('');
    $('#management-roles').innerHTML=e.cohosts.length?e.cohosts.map(p=>`<div class="management-row"><div><strong>${esc(p.name)}</strong><p>${p.permissions.map(s=>scopes[s]).join('、')}</p></div><button class="text-button danger" type="button" data-activity="revoke_role" data-id="${p.id}">撤銷</button></div>`).join(''):"<p class=\"muted\">暫無協辦</p>";
    $('#management-pending').innerHTML=e.pending_management.map(p=>`<div class="management-row"><div><strong>${esc(p.target_name)} · ${p.kind==='transfer'?"接任發起者":p.permissions.includes('settlement')?"結算人":"協辦"}</strong><p>${shortDate(p.expires_at)} 前有效</p></div><button class="text-button" type="button" data-activity="copy_role" data-id="${p.id}">複製鏈接</button><button class="text-button danger" type="button" data-activity="revoke_invite" data-id="${p.id}">撤銷</button></div>`).join('');
    form.elements.kind.value=settlement?'settlement':'cohost';$('#management-form .extra-settings').open=settlement;
    $('#management-scopes').hidden=settlement;$('.form-error',form).textContent='';showDialog('management-dialog');
  }
  $('#management-form [name=kind]').addEventListener('change',event=>{$('#management-scopes').hidden=event.target.value!=='cohost';});
  $('#management-form').addEventListener('invalid',()=>{$('#management-form .extra-settings').open=true;},true);
  $('#management-form [name=attendee_id]').addEventListener('change',event=>{
    const e=managementContext,p=e.participants.find(p=>p.id===event.target.value);if(p)$('#management-form [name=target_name]').value=p.nickname;
  });
  $('#management-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#save-management');if(button.disabled)return;button.disabled=true;
    try {
      const e=managementContext,selected=[...form.querySelectorAll('[name=permission]:checked')].map(input=>input.value);
      const updated=await api(`/api/events/${e.id}/management/invitations`,'POST',{base_revision:e.revision,kind:form.elements.kind.value==='settlement'?'cohost':form.elements.kind.value,target_name:form.elements.target_name.value.trim(),attendee_id:form.elements.attendee_id.value||null,permissions:form.elements.kind.value==='settlement'?['settlement']:selected,reason:form.elements.reason.value.trim()});
      await apply(updated,"交接邀請已生成，請只發送給指定接任人");openManagement(updated);
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{button.disabled=false;}
  });
  async function showManagementInvitation(id,token) {
    const info=await api(`/api/events/${id}/management/invitations/${token}`);roleContext={id,token,info};
    $('#accept-role-title').textContent=info.kind==='transfer'?"接任發起者":info.permissions.includes('settlement')?"接受結算責任":"接受協辦";
    $('#accept-role-description').textContent=info.title+' · '+info.owner_name+" 邀請 "+info.target_name;
    $('#accept-role-permissions').textContent=info.kind==='transfer'?"接受後，你將管理此活動的名單、安排和全部結算；原發起者不再擁有發起者權限。":info.permissions.map(p=>scopes[p]).join('、')+(info.permissions.includes('settlement')?"。結算時使用你自己的收款碼；發起者保留管理權。":"。協辦不能操作結算或轉交活動。");
    $('#accept-role-form').reset();$('#accept-role-form .form-error').textContent='';showDialog('accept-role-dialog');
  }
  $('#accept-role-form').addEventListener('submit',event=>{
    event.preventDefault();withProfile(async()=>{
      const form=$('#accept-role-form'),button=$('#accept-role-button');button.disabled=true;
      try {
        const {id,token,info}=roleContext;
        const updated=await api(`/api/events/${id}/management/invitations/${token}/accept`,'POST',{base_revision:info.base_revision,accept_responsibility:form.elements.accept_responsibility.checked});
        const url=new URL(location.href);url.searchParams.delete('management_invite');window.history.replaceState(null,'',url);
        state.current=updated.id;showDialog('detail-dialog');await apply(updated,"已接受交接",'accept-role-dialog');
      }catch(problem){$('.form-error',form).textContent=problem.message;if(problem.status===409){try{roleContext.info=await api(`/api/events/${roleContext.id}/management/invitations/${roleContext.token}`);}catch{}}}
      finally{button.disabled=false;}
    });
  });
  function openAttendance(e) {
    attendanceContext=e;const form=$('#attendance-form');form.reset();
    form.elements.person_id.innerHTML=e.attendance_roster.map(p=>`<option value="${p.id}">${esc(p.nickname)} · ${attendanceNames[p.attendance]}${p.status==='withdrawn'?"（已退出）":''}</option>`).join('');
    $('#attendance-empty').hidden=!!form.elements.person_id.options.length;$('#attendance-fields').hidden=!form.elements.person_id.options.length;
    $('#save-attendance').disabled=!form.elements.person_id.options.length;$('.form-error',form).textContent='';renderAttendancePerson();showDialog('attendance-dialog');
  }
  function renderAttendancePerson() {
    const form=$('#attendance-form'),p=attendanceContext?.attendance_roster.find(p=>p.id===form.elements.person_id.value);if(!p)return;
    form.elements.attendance.value=p.attendance;form.elements.attendance_note.value=p.attendance_note;
    form.elements.arrived_at.value=p.arrived_at?wallDate(p.arrived_at,attendanceContext.timezone):'';
    form.elements.left_at.value=p.left_at?wallDate(p.left_at,attendanceContext.timezone):'';
    form.elements.reason.value='';form.elements.reason.required=['ended','cancelled'].includes(attendanceContext.lifecycle);
    $('#attendance-reason-hint').textContent=form.elements.reason.required?"活動已結束或取消，補錄／更正需填寫原因。":"出席狀態不自動改動費用或已發佈結算。";
    $('#attendance-time-label').textContent="實際到離場時間（"+zoneLabel(attendanceContext.timezone)+"，選填）";
  }
  $('#attendance-form [name=person_id]').addEventListener('change',renderAttendancePerson);
  $('#attendance-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#save-attendance');if(button.disabled)return;button.disabled=true;
    try {
      const e=attendanceContext,updated=await api(`/api/events/${e.id}/attendance/${form.elements.person_id.value}`,'PATCH',{
        base_revision:e.revision,attendance:form.elements.attendance.value,attendance_note:form.elements.attendance_note.value.trim(),reason:form.elements.reason.value.trim(),
        arrived_at:form.elements.arrived_at.value?wallToISO(form.elements.arrived_at.value,e.timezone):null,left_at:form.elements.left_at.value?wallToISO(form.elements.left_at.value,e.timezone):null});
      await apply(updated,"出席已記錄");openAttendance(updated);
    }catch(problem){$('.form-error',form).textContent=problem.message;}
    finally{button.disabled=false;}
  });
  function openOnsite(e) {
    $('#onsite-form').reset();$('#onsite-form').dataset.event=e.id;$('#onsite-form').dataset.revision=e.revision;
    $('#onsite-capacity').textContent=`目前正式 ${e.confirmed_count} 人${e.capacity?"，上限 "+e.capacity+" 人":"，人數不限"}${e.waiting_count?"；仍有 "+e.waiting_count+" 人候補":''}。`;
    $('#onsite-terms').textContent=e.fee_policy||"費用按雙方已確認的實際約定處理。";$('#onsite-form .form-error').textContent='';showDialog('onsite-dialog');
  }
  $('#onsite-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('#save-onsite');if(button.disabled)return;button.disabled=true;
    try {
      const e=state.events.find(e=>e.id===form.dataset.event);
      const updated=await api(`/api/events/${e.id}/onsite`,'POST',{base_revision:Number(form.dataset.revision),conditions_version:e.conditions_version,
        people:[{name:form.elements.name.value.trim(),note:form.elements.note.value.trim(),payer_kind:form.elements.payer_kind.value}],
        reason:form.elements.reason.value.trim(),allow_over_capacity:form.elements.allow_over_capacity.checked,override_waitlist:form.elements.override_waitlist.checked,
        accept_terms:form.elements.accept_terms.checked});
      await apply(updated,"已補錄為正式到場人員",'onsite-dialog');
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
      else if(action==='appoint_settlement')openManagement(e,true);
      else if(action==='attendance')openAttendance(e);
      else if(action==='onsite')openOnsite(e);
      else if(action==='copy_role'){const p=e.pending_management.find(p=>p.id===button.dataset.id);if(p)await copyLink(managementUrl(e,p.token));}
      else openAction(e,action,{id:button.dataset.id});
    }catch(problem){toast(problem.message);}
  });
  return {alerts,tools,showManagementInvitation,arrangementHtml,openConditions};
}
