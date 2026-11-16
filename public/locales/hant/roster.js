'use strict';
function createRosterUI({inbox,api,$,state,esc,showDialog,toast,withProfile,renderDetail,refresh,shortDate}) {
  const labels={confirmed:"正式",waiting:"候補",tentative:"待確認",invited:"待接受邀請",withdrawn:"已退出"};
  let context=null,personContext=null,invitationContext=null,unread=0;
  const current=()=>state.events.find(e=>e.id===state.current);
  const knownInvite=id=>{try{return sessionStorage.getItem('kanban-invite-'+id);}catch{return null;}};
  const rememberInvite=(id,token)=>{try{sessionStorage.setItem('kanban-invite-'+id,token);}catch{}};
  function eventUrl(e,participantToken=null) {
    const url=new URL(location.origin+'/?event='+e.id);
    const token=e.share_token||knownInvite(e.id);
    if(e.visibility==='invitation'&&!participantToken) {
      if(!token)throw new Error("請向發起者索取可轉發的邀請鏈接");
      url.searchParams.set('invite',token);
    }
    if(participantToken)url.searchParams.set('attendee_invite',participantToken);
    return url.href;
  }
  async function copyLink(link,label="鏈接") {
    try{await navigator.clipboard.writeText(link);toast(label+"已複製");}
    catch{showDialog('link-dialog');$('#link-title').textContent="手動複製"+label;$('#link-input').value=link;$('#link-input').select();}
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
    if(event.target.matches?.('.participant-avatar:not([data-ui-avatar]) img'))event.target.remove();
  },true);
  function peopleSection(e) {
    let html=e.my_attendees?.some(p=>!p.is_me)?`<details class="extra-settings"><summary>我的報名／同行 · ${e.my_attendees.length} 人</summary>${e.my_attendees.map(p=>`<p class="history-person">${esc(p.nickname)} · ${labels[p.status]}${p.waiting_position?" · 候補 "+p.waiting_position:''}${p.payer_kind==='manager'?" · 由"+esc(p.payer_name||p.manager_name)+"統一付款":" · 本人付款"}${p.can_manage&&(p.can_change||p.can_withdraw||p.can_claim)?` <button class="text-button" data-roster-action="manage" data-person="${p.id}">管理</button>`:''}</p>`).join('')}</details>`:'';
    for(const status of ['confirmed','waiting','tentative']) {
      const people=e.participants.filter(p=>p.status===status);if(!people.length)continue;
      html+=`<div class="detail-section-heading"><h3>${status==='confirmed'?(e.can_attendance?"現場名單":"報名名單"):labels[status]}</h3><span>${people.length} 人</span></div><ol class="participant-list">`;
      html+=people.map((p,index)=>{
        const extra=p.payment_locked?`保留原報名付款人：${esc(p.payer_name)}`:p.is_guest?`${esc(p.manager_name)}代報 · ${p.payer_kind==='manager'?"由"+esc(p.payer_name||p.manager_name)+"統一付款":"本人付款"}`:'';
        const confirmation=p.confirmation_state==='pending'?"新安排待確認":p.confirmation_state==='declined'?"暫不同意新安排":'';
        const attendance=({present:"到場",absent:"缺席",late:"遲到",left:"早退"})[p.attendance];
        return `<li class="participant ${status}"><span class="participant-position">${status==='waiting'?"候補 ":''}${index+1}</span><div class="participant-text"><div class="participant-heading">${personAvatar(p)}<div class="participant-name">${esc(p.nickname)}${p.is_me?"<span class=\"me-badge\">我</span>":''}${attendance?`<span class="attendance-badge">${attendance}</span>`:''}</div></div>${extra?`<p class="participant-note">${extra}</p>`:''}${p.note?`<p class="participant-note">${esc(p.note)}</p>`:''}${confirmation?`<p class="withdrawal-label">${confirmation}</p>`:''}${p.withdrawal_requested?"<p class=\"withdrawal-label\">已申請退出，待發起者處理</p>":''}</div>${p.can_manage&&(p.can_change||p.can_withdraw||p.can_claim)?`<button class="text-button participant-manage"${p.is_me?'':' data-advanced-only'} data-roster-action="manage" data-person="${p.id}">管理</button>`:''}</li>`;
      }).join('')+'</ol>';
    }
    if(!e.participants.length)html="<p class=\"muted\">暫無報名</p>";
    if(e.pending_invitations?.length)html+=`<div class="detail-section-heading invitations-heading"><h3>待接受邀請</h3><span>${e.pending_invitations.length} 人</span></div><ul class="participant-list">${e.pending_invitations.map(p=>`<li class="participant"><div class="participant-text"><span class="participant-name">${esc(p.nickname)}</span></div><button class="text-button" data-roster-action="copy-invitation" data-person="${p.id}">複製邀請</button><button class="text-button" data-roster-action="manage" data-person="${p.id}">管理</button></li>`).join('')}</ul>`;
    return html;
  }
  function joinPanel(e) {
    if(e.status==='cancelled')return "<p class=\"status-banner\">活動已取消</p>";
    const own=e.my_registration;
    let html='';
    if(own)html=`<div class="joined-row"><span class="join-status ${own.status==='waiting'?'waiting':''}">${own.status==='confirmed'?"已報名":own.status==='waiting'?`候補第 ${own.waiting_position} 位`:"待確認參加"}</span>${own.can_change||own.can_withdraw?`<button class="text-button" data-roster-action="manage" data-person="${own.id}">管理本人報名</button>`:''}</div>`;
    else if(e.can_join)html=`<form id="join-form"><details class="note-options"><summary>備註與報名規則</summary><label class="field">報名備註<span class="optional">活動內可見</span><input name="note" maxlength="100"></label><p class="field-help">${esc(e.fee_policy||"請先查看活動安排與注意事項。")} 退出期限：${shortDate(e.withdrawal_deadline,e.timezone)}。</p></details><button class="button primary full" type="submit">${e.queue_blocked||(e.capacity&&e.confirmed_count>=e.capacity)?"本人加入候補":"本人報名"}</button><p class="join-agreement">提交表示接受當前安排與費用規則 <button class="text-button" type="button" data-activity="conditions">查看</button></p></form>`;
    if(e.can_join)html+=`<div class="roster-extra-actions" data-advanced-only><button class="text-button" data-roster-action="add">同行／代報名</button>${!own?"<button class=\"text-button\" data-roster-action=\"tentative\">暫待確認</button>":''}</div>`;
    if(!html)html="<p class=\"status-banner\">報名已截止</p>";
    return html;
  }
  function invalidate() {
    if(!context)return;context.preview=null;$('#party-preview').innerHTML='';$('#save-party').textContent=context.invite?"生成邀請":"預覽報名";$('#save-party').disabled=false;
  }
  function rowHtml(index) {
    const invite=context?.invite;
    return `<div class="guest-row"><div class="guest-name-row"><label class="field">參加者稱呼<input name="guest_name" maxlength="24" required autocomplete="off"></label><button class="text-button" type="button" data-remove-guest aria-label="移除這位參加者">移除</button></div><details class="guest-options"><summary>${invite?"備註（選填）":"備註與付款"}</summary><label class="field">備註 <span class="optional">選填</span><input name="guest_note" maxlength="100"></label>${invite?'<input name="guest_payer" type="hidden" value="self">':"<label class=\"field\">付款歸屬<select name=\"guest_payer\"><option value=\"manager\">由我統一付款</option><option value=\"self\">參加者自己付款</option></select></label>"}</details></div>`;
  }
  function openParty(e,{tentative=false,invite=false}={}) {
    context={event:e,invite,preview:null};const form=$('#party-form');form.reset();
    $('#party-title').textContent=invite?"邀請補報名":"同行／代報名";
    $('#party-rows').innerHTML=tentative?'':rowHtml(0);
    $('#party-self-field').hidden=invite||!!e.my_registration;
    form.elements.include_self.checked=tentative&&!e.my_registration;
    $('#party-options').hidden=invite;$('#party-reason-field').hidden=!invite;form.elements.reason.required=invite;
    form.elements.intent.value=tentative?'tentative':'registered';
    $('#party-terms').textContent=invite?"對方接受邀請時自行確認安排與費用。":(e.fee_policy||"請先查看活動安排與注意事項。")+" 提交表示已與本人及代報者確認當前安排與費用規則。";
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
      const data=partyData();if(!data.people.length)throw new Error("請勾選本人參加，或添加一位參加者");
      if(context.invite) {
        const updated=await api(`/api/events/${context.event.id}/roster/invitations`,'POST',{...data,base_revision:context.event.revision});
        await apply(updated,"邀請已生成，請複製鏈接給受邀者",'party-dialog');return;
      }
      if(!context.preview) {
        const result=await api(`/api/events/${context.event.id}/roster/preview`,'POST',data);context.preview=result;
        const mixed=result.allocation.some(p=>p.status==='confirmed')&&result.allocation.some(p=>p.status==='waiting');
        $('#party-preview').innerHTML=`<div class="allocation-preview">${result.allocation.map(p=>`<p><span>${esc(p.name)}</span><strong class="allocation-${p.status}">${labels[p.status]}</strong></p>`).join('')}${mixed?"<label class=\"check-option\"><input type=\"checkbox\" name=\"accept_partial\">接受部分人正式、部分人候補</label>":''}</div>`;
        button.textContent=data.intent==='tentative'?"保存待確認":"確認報名";
        $('#party-preview').scrollIntoView({block:'start',behavior:'smooth'});return;
      }
      const updated=await api(`/api/events/${context.event.id}/roster/parties`,'POST',{...data,...context.preview,accept_partial:form.elements.accept_partial?.checked===true});
      await apply(updated,"報名已保存",'party-dialog');
    }catch(problem){
      $('.form-error',form).textContent=problem.message;
      if(problem.status===409) {
        if(!context.invite) {
          invalidate();
          try{context.event=await api('/api/events/'+context.event.id);$('#party-terms').textContent=(context.event.fee_policy||"請查看最新活動安排。")+" 提交表示本人及代報人員接受當前安排。";$('.form-error',form).textContent=problem.message+"；請核對最新規則後重新預覽。";}catch{}
        }
        else try{context.event=await api('/api/events/'+context.event.id);$('.form-error',form).textContent=problem.message+"；已載入最新活動，請核對後再生成邀請。";}catch{}
      }
    }
    finally{button.disabled=false;}
  });
  function openPerson(e,id) {
    const p=[...e.participants,...e.pending_invitations].find(p=>p.id===id);if(!p)return;
    BoardAdvanced.set($('#attendee-dialog'));personContext={event:e,person:p};const form=$('#attendee-form');form.reset();
    $('#attendee-title').textContent=p.nickname;$('#attendee-status').textContent=labels[p.status]+(p.withdrawal_requested?" · 已申請退出":'');
    form.elements.name.value=p.nickname;form.elements.name.readOnly=!p.is_guest;form.elements.name.closest('.field').hidden=!p.is_guest;
    $('#attendee-reason-field').toggleAttribute('data-advanced-only',!p.needs_withdrawal_request&&!p.withdrawal_requested&&p.managed_by_me);
    form.elements.note.value=p.note;form.elements.payer_kind.value=p.payer_kind;
    form.elements.payer_kind.disabled=!p.is_guest||p.payment_locked;
    $('#claim-attendee').hidden=!p.can_claim;$('#claim-attendee').onclick=()=>identityUI.issueClaim(e,p);
    $('#attendee-payment').hidden=!p.payment_locked;$('#attendee-payment').textContent="原報名付款人："+p.payer_name+"；已有帳單以對應版本的付款分配為準。更改請核對並保存新結算版本。";form.elements.reason.value='';
    $('#attendee-edit-fields').hidden=!p.can_change;
    $('#save-attendee').hidden=!p.can_change||p.status==='invited';
    $('#confirm-attendee').hidden=!p.can_change||p.status!=='tentative';
    $('#confirm-attendee').textContent=p.queue_mode==='together'?"確認整組參加":"確認參加";
    $('#split-attendee').hidden=!p.can_change||p.status!=='waiting'||p.queue_mode!=='together';
    $('#withdraw-attendee').hidden=!p.can_withdraw||!!p.withdrawal_requested;
    $('#withdraw-attendee').textContent=p.status==='invited'?"撤銷邀請":p.needs_withdrawal_request&&p.managed_by_me?"申請退出":"撤銷這位報名";
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
    try{const updated=await api(`/api/events/${e.id}/attendees/${p.id}${suffix}`,method,data);await apply(updated,action==='withdraw'&&p.needs_withdrawal_request&&p.managed_by_me?"退出申請已提交":"名單已更新",'attendee-dialog');}
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
      toast("已載入最新名單，請重新核對操作");
    }catch(problem){$('#attendee-form .form-error').textContent=problem.message;}
    finally{button.disabled=false;}
  });
  for(const action of ['confirm','split','withdraw'])$('#'+action+'-attendee').addEventListener('click',()=>personAction(action));
  $('#approve-withdrawal').addEventListener('click',()=>personAction('approve'));
  $('#reject-withdrawal').addEventListener('click',()=>personAction('reject'));
  async function refreshNotifications() {
    try{const result=await api('/api/notifications');unread=result.unread_count+await inbox();$('#notification-count').textContent=unread>99?'99+':unread;$('#notification-count').hidden=!unread;$('#notifications-button').setAttribute('aria-label',unread?`${unread} 項待辦或未讀消息`:"消息");}
    catch{}
  }
  $('#notifications-button').addEventListener('click',async()=>{
    showDialog('notifications-dialog');const content=$('#notifications-content');content.textContent="加載中…";
    await inbox(true);
    try {
      const {notifications}=await api('/api/notifications');
      content.innerHTML=notifications.length?notifications.map(n=>`<button class="notification-entry ${n.read_at?'':'unread'}" data-notification-event="${n.event_id}"><span>${esc(n.message)}</span><time>${shortDate(n.created_at)}</time></button>`).join(''):"<p class=\"muted\">暫無消息</p>";
      const ids=notifications.filter(n=>!n.read_at).map(n=>n.id);if(ids.length)await api('/api/notifications/read','POST',{ids});await refreshNotifications();
    }catch(problem){content.textContent=problem.message;}
  });
  const actionNames={claim_invited:"邀請本人認領",claim_requested:"申請認領",claim_approved:"核對通過認領",claim_reject:"拒絕認領",claim_revoke:"撤銷認領",finance_record:"登記款項",finance_report:"申報款項",finance_accept:"確認款項申報",finance_reject:"暫不確認申報",finance_withdraw:"撤回款項申報",finance_reverse:"沖銷款項",finance_close:"確認帳務結清",finance_reopen:"重新核對帳務",event_publish:"發佈草稿",event_pause:"暫停報名",event_resume:"恢復報名",event_start:"確認實際開始",event_finish:"確認實際結束",event_cancel:"取消活動",event_archive:"歸檔",event_unarchive:"取消歸檔",event_formation:"確認成團",conditions_response:"確認新安排",attendance_updated:"核對出席",onsite_added:"現場補錄",management_invited:"發出管理邀請",management_invitation_revoked:"撤銷管理邀請",cohost_joined:"接受協辦",cohost_removed:"撤銷協辦",ownership_transferred:"轉交發起者",event_created:"發起活動",event_updated:"修改活動",event_admin_updated:"管理員協助修改活動",signup:"報名",attendee_edit:"修改報名",attendee_confirm:"確認參加",attendee_split:"改為分開排隊",withdraw:"退出報名",withdrawal_request:"申請退出",withdrawal_approve:"同意退出",withdrawal_reject:"拒絕退出",invite:"邀請補報名",invitation_accepted:"接受補報名",nickname_changed:"修改稱呼",settlement_saved:"保存結算"};
  function describe(data) {
    let html='';
    if(data.participants?.length)html+=data.participants.map(p=>`<p class="history-person">${esc(p.nickname)} · ${labels[p.status]||esc(p.status)}${p.note?' · '+esc(p.note):''}${p.withdrawal_requested?" · 申請退出":''}${p.manager_name?' · '+esc(p.manager_name)+"管理":''}${p.payer_kind==='manager'?" · 統一付款":''}${p.confirmation_state==='pending'?" · 新安排待確認":p.confirmation_state==='declined'?" · 暫不同意新安排":''}${p.attendance&&p.attendance!=='unknown'?' · '+({present:"到場",absent:"缺席",late:"遲到",left:"早退"})[p.attendance]:''}${p.attendance_note?' · '+esc(p.attendance_note):''}${p.arrived_at?" · 到場 "+shortDate(p.arrived_at):''}${p.left_at?" · 離場 "+shortDate(p.left_at):''}</p>`).join('');
    if(data.nickname)html+=`<p class="history-person">${esc(data.nickname)} · ${({accepted:"已接受",declined:"暫不同意",pending:"待確認"})[data.confirmation]||''}${data.accepted_version?" · 保留已接受的第 "+data.accepted_version+" 版約定":''}</p>`;
    if(data.owner_name)html+=`<p class="history-person">發起者：${esc(data.owner_name)}</p>`;
    if(data.roles)html+=data.roles.map(p=>`<p class="history-person">協辦 ${esc(p.name)} · ${p.permissions.map(scope=>({schedule:"修改安排",roster:"管理報名",attendance:"核對出席"})[scope]).join('、')}</p>`).join('');
    if(data.target_name)html+=`<p class="history-person">${esc(data.target_name)} · ${data.kind==='transfer'?"接任發起者":"協辦"}</p>`;
    return html;
  }
  const fields={lifecycle:"活動階段",registration_open:"報名開關",actual_started_at:"實際開始",actual_ended_at:"實際結束",archived_at:"歸檔時間",timezone:"活動時區",minimum_participants:"最低成團人數",formation_state:"成團狀態",fee_policy:"費用規則",conditions_version:"安排版本",cancellation_reason:"取消原因",title:"標題",category:"類型",location:"地點",starts_at:"開始時間",deadline:"報名截止",capacity:"人數上限",description:"注意事項",duration_hours:"持續小時",status:"活動狀態",withdrawal_deadline:"退出期限",visibility:"可見性"};
  function fieldValue(key,value,zone) {
    if(key==='category')return BoardI18n.category(value);
    if(value==null||value==='')return "未設置";
    if(['starts_at','deadline','withdrawal_deadline','actual_started_at','actual_ended_at','archived_at'].includes(key))return shortDate(value,zone);
    if(key==='lifecycle')return ({draft:"草稿",scheduled:"待開始",ongoing:"進行中",ended:"已結束",cancelled:"已取消"})[value]||value;
    if(key==='registration_open')return value?"開放":"關閉";
    if(key==='formation_state')return value==='confirmed'?"已確認成團":"待確認";
    if(key==='capacity'&&value===0)return "不限";
    if(key==='visibility')return value==='public'?"公開":"持邀請鏈接可見";
    if(key==='status')return ({open:"開放報名",closed:"暫停報名",finished:"已結束",cancelled:"已取消",deleted:"已移除"})[value]||value;
    return value;
  }
  async function history(e,before=null) {
    if(!before){$('#activity-history-content').textContent="加載中…";showDialog('activity-history-dialog');}
    try {
      const result=await api(`/api/events/${e.id}/history${before?'?before='+before:''}`);
      const html=result.entries.map(entry=>{
        const prior=entry.before.event||entry.before,after=entry.after.event||entry.after;
        const eventChanges=Object.keys(fields).filter(key=>key in after&&JSON.stringify(prior[key])!==JSON.stringify(after[key])).map(key=>`<p class="history-person">${fields[key]}：${esc(fieldValue(key,prior[key],prior.timezone))} → ${esc(fieldValue(key,after[key],after.timezone))}</p>`).join('');
        return `<details class="activity-revision"><summary>${actionNames[entry.action]||"更新記錄"}<span class="revision-meta">${shortDate(entry.created_at)} · ${esc(entry.actor_name)}</span></summary>${entry.reason?`<p class="settlement-note">${esc(entry.reason)}</p>`:''}${eventChanges}${describe(entry.before)?"<p class=\"field-help\">變更前</p>"+describe(entry.before):''}${describe(entry.after)?"<p class=\"field-help\">變更後</p>"+describe(entry.after):''}${entry.action.startsWith('finance_')?"<p class=\"field-help\">金額、流向及沖銷關係詳見「收付款帳本」。</p>":''}${entry.action==='settlement_saved'?"<p class=\"field-help\">金額及收款碼詳見「結算記錄」。</p>":''}</details>`;
      }).join('');
      if(before){$('#load-more-history')?.remove();$('#activity-history-content').insertAdjacentHTML('beforeend',html);}
      else $('#activity-history-content').innerHTML=html||"<p class=\"muted\">暫無新增記錄；舊報名已按原順序保留。</p>";
      if(result.next_before)$('#activity-history-content').insertAdjacentHTML('beforeend',`<button class="text-button full" id="load-more-history" data-roster-action="more-history" data-before="${result.next_before}">加載更早記錄</button>`);
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
    $('#invitation-conditions').innerHTML=`<p class="settlement-note">${esc(info.conditions.arrangement.fee_policy||"活動未填寫費用規則，請先與發起者確認。")}</p><p class="field-help">${esc(info.conditions.arrangement.description||'')}</p>`;
  }
  $('#accept-invitation-form').addEventListener('submit',event=>{
    event.preventDefault();withProfile(async()=>{
      const form=$('#accept-invitation-form'),button=$('#accept-invitation-button');button.disabled=true;
      try {
        const {id,token,info}=invitationContext;
        const updated=await api(`/api/events/${id}/invitations/${token}/accept`,'POST',{base_revision:info.base_revision,conditions_version:info.conditions.version,accept_waiting:form.elements.accept_waiting.checked});
        const url=new URL(location.href);url.searchParams.delete('attendee_invite');historyReplace(url);
        state.current=updated.id;showDialog('detail-dialog');await apply(updated,"邀請已接受",'accept-invitation-dialog');
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
