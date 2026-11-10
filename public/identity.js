'use strict';
function createIdentityUI({api,$,esc,showDialog,toast,state,withProfile,refresh,renderDetail,askConfirm,copyLink,openDetail}) {
  let incoming=null,link=null,qqResult=null;
  let qqReminderReady=false;
  const remindedScopes=new Set(),qqReminderInterval=24*60*60*1000;
  const fail=problem=>{$('#identity-error').textContent=problem.message;};
  function privacyConsent() {
    return state.me.privacy_accepted?'':`<label class="check-option privacy-consent"><input id="privacy-consent" type="checkbox"><span>我已阅读并同意<a href="/privacy" target="_blank" rel="noopener">隐私政策</a>，同意为登录与账号功能处理必要资料。<a href="/contact" target="_blank" rel="noopener">联系运营者</a></span></label>`;
  }
  function privacyData() {
    if(!state.me.privacy_accepted&&!$('#privacy-consent')?.checked)throw new Error('请阅读并勾选同意隐私政策后继续');
    return {accept_privacy:true,privacy_version:state.me.privacy_version};
  }
  function qqProfile(nickname,avatarUrl) {
    return `<div class="qq-profile">${avatarUrl?`<img class="qq-avatar" src="${esc(avatarUrl)}" alt="QQ头像" width="40" height="40" referrerpolicy="no-referrer">`:''}<span>QQ：${esc(nickname)}</span></div>`;
  }
  async function account() {
    $('#identity-title').textContent='账号与设备';$('#identity-error').textContent='';$('#identity-content').textContent='加载中…';showDialog('identity-dialog');
    try {
      if(!state.me.authenticated){
        const me=await api('/api/me');state.me=me;BoardClient.setIdentity(me.draft_scope);
        $('#identity-title').textContent='登录';
        if(me.authenticated)return account();
        $('#identity-content').innerHTML=`<p>登录后即可发起活动、报名并管理自己的记录。</p>${me.qq?.enabled?'<button type="button" class="button secondary full qq-button" data-identity="qq-login"><img src="/qq-login.png" alt="QQ登录" width="76" height="24"><span>使用 QQ 登录</span></button>':'<p class="field-help">QQ 登录暂不可用，请稍后重试。</p>'}<p class="field-help">首次登录将自动创建账号，登录后可修改群内称呼。</p>${privacyConsent()}${me.allow_name_registration?'<details class="extra-settings"><summary>使用称呼注册</summary><p class="field-help">只创建当前浏览器可用的账号，不能仅凭称呼找回。以后可绑定 QQ。</p><label class="field">群内称呼<input id="register-nickname" required maxlength="24" autocomplete="nickname"></label><button type="button" class="button secondary full" data-identity="name-register">创建账号</button></details>':''}`;
        return;
      }
      const info=await api('/api/account');
      $('#identity-content').innerHTML=`<p class="field-help">当前账号：${esc(state.me.nickname||'未设置称呼')}</p>${qqSection(info.qq)}<details class="extra-settings"><summary>${info.qq?.bound?'备用：连接另一台设备':'连接另一台设备'}</summary><p class="field-help">链接有效 10 分钟、仅限一次。持有者可管理账号与账务，请只发给自己的设备。</p><label class="check-option"><input id="authorize-device" type="checkbox">只授权自己的另一台设备</label><button class="button secondary full" type="button" data-identity="issue-device">生成限时连接</button><textarea class="summary-fallback" id="device-link" rows="4" readonly aria-label="设备连接，可手动复制" hidden></textarea><button class="text-button full" data-identity="copy-device" hidden>复制设备连接</button></details><details class="extra-settings"><summary>此设备上的账号 · ${info.accounts.length}</summary><p class="field-help">账号分开保留，不合并报名或款项；切换前请暂存并关闭表单。</p>${info.accounts.map(a=>`<p class="account-row"><span>${esc(a.nickname||'未设置称呼')} · ${esc(a.scope.slice(-6))}</span>${a.current?'<span>当前</span>':`<button type="button" class="text-button" data-account-scope="${a.scope}">切换</button>`}</p>`).join('')}</details><details class="extra-settings"><summary>已授权设备 · ${info.devices.length}</summary>${info.devices.map(d=>`<p class="account-row"><span>${d.current?'当前设备':'其他设备 · '+esc(d.id.slice(-6))}<br><small>${esc(d.created_at.slice(0,10))}</small></span>${d.current?'':`<button type="button" class="text-button danger" data-revoke-device="${d.id}">撤销</button>`}</p>`).join('')}</details><details class="extra-settings"><summary>账号操作记录</summary>${info.history.map(h=>`<p class="field-help">${esc({name_registered:'创建账号',device_link_issued:'生成设备连接',device_link_accepted:'设备已连接',device_revoked:'撤销设备',account_switched:'切换账号',qq_bound:'绑定 QQ',qq_login:'QQ 登录'}[h.action]||h.action)} · ${esc(h.created_at)}</p>`).join('')||'<p class="field-help">暂无记录</p>'}</details>${privacyConsent()}<section class="privacy-controls"><h3>隐私与资料删除</h3><p class="field-help"><a href="/privacy" target="_blank" rel="noopener">隐私政策</a> · <a href="/contact" target="_blank" rel="noopener">联系与投诉</a></p><p class="field-help">注销会撤销所有设备对本账号的登录权限，移除 QQ 身份和私人收款码。共用的活动、报名、款项与凭证需进一步核对，申请会保留至处理完毕。请先转交仍由你管理的活动，并核对未结款项。</p><label class="check-option"><input id="confirm-close-account" type="checkbox">我了解注销影响，并申请删除账号资料</label><button type="button" class="text-button full danger" data-identity="close-account">注销账号并申请删除资料</button><button type="button" class="button secondary full" data-identity="logout">退出登录</button></section>`;
    }catch(e){fail(e);}
  }
  async function receiveDevice(token) {
    incoming={kind:'device',token};$('#identity-content').textContent='加载中…';$('#identity-title').textContent='连接另一设备上的账号';$('#identity-error').textContent='';showDialog('identity-dialog');
    try {const info=await api('/api/account-links/'+token);
      $('#identity-content').innerHTML=`<p>将「${esc(info.nickname)}」账号授权给当前设备。</p><p class="field-help">有效至 ${esc(info.expires_at)}。此设备原有账号、活动与款项会分开保留，不自动合并；接受后可在账号列表切换。只有在你自己的设备之间连接时才接受。</p><label class="check-option"><input id="accept-device" type="checkbox">这是我的账号，确认授权当前设备</label><button type="button" class="button primary full" data-identity="accept-device">接受设备连接</button>`;
    }catch(e){fail(e);}
  }
  async function receiveClaim(eventId,token) {
    incoming={kind:'claim',eventId,token};$('#identity-content').textContent='加载中…';$('#identity-title').textContent='认领我的报名';$('#identity-error').textContent='';showDialog('identity-dialog');
    try {
      const info=await api(`/api/events/${eventId}/claims/${token}`);incoming.info=info;
      if(info.claimed){$('#identity-content').innerHTML=`<h3>${esc(info.title)}</h3><p>认领已通过，原名额及付款责任保留。</p><button type="button" class="button primary full" data-identity="existing-signup">查看我的报名</button>`;return;}
      $('#identity-content').innerHTML=`<h3>${esc(info.title)}</h3><p>认领「${esc(info.name)}」的${esc({confirmed:'正式',waiting:'候补',tentative:'待确认'}[info.status])}报名。</p><p class="field-help">原名额、排队顺序、已接受的约定和账单均保留。报名默认付款人为 ${esc(info.payer_name)}；已有账单以该版本的付款分配为准，认领不转移款项或重算旧账。申请后由原管理人核对。</p>${info.duplicate?'<p class="error-banner">你已经有本人报名，不能自动合并。请先管理现有报名并核对重复项；截止后、已有费用或款项时请和发起者协调，历史及原款项会保留。</p><button type="button" class="button secondary full" data-identity="existing-signup">处理现有报名</button>':info.claim_status==='requested'?`<p class="status-banner">${info.requested_by_me?'申请已提交，等待管理人核对':'这份邀请已有认领申请，请联系管理人'}</p>`:'<label class="check-option"><input id="claim-person" type="checkbox">这条报名确实是我本人</label><label class="check-option"><input id="claim-payment" type="checkbox">已核对并保留原付款责任</label><button type="button" class="button primary full" data-identity="request-claim">提交认领申请</button>'}`;
    }catch(e){fail(e);}
  }
  function section(e) {
    const claims=e.claim_invitations||[];if(!claims.length)return '';
    return `<details class="extra-settings"><summary>报名认领 · ${claims.filter(c=>c.can_decide).length} 待核对</summary>${claims.map(c=>`<div class="pending-entry"><p>${esc(c.name)} · ${esc({invited:'等待本人申请',requested:'等待管理人核对',approved:'已认领',rejected:'未通过',revoked:'已撤销',expired:'已过期'}[c.status])}${c.requester_name?' · 申请人 '+esc(c.requester_name):''}</p>${c.token?`<button type="button" class="text-button" data-claim-copy="${c.id}">复制认领链接</button><button type="button" class="text-button danger" data-claim-decision="revoke" data-id="${c.id}">撤销</button>`:''}${c.can_decide?`<button type="button" class="text-button" data-claim-decision="approve" data-id="${c.id}">核对并同意</button><button type="button" class="text-button danger" data-claim-decision="reject" data-id="${c.id}">拒绝</button>`:''}</div>`).join('')}</details>`;
  }
  async function copyClaimLink(eventId,token) {
    const url=location.origin+'/?event='+eventId+'&claim='+token;
    await copyLink(url,'认领链接');$('#link-title').textContent='认领链接';$('#link-input').value=url;showDialog('link-dialog');
  }
  async function issueClaim(e,p) {
    askConfirm('邀请本人认领？','只把链接发给这位参加者。对方先申请，你再核对同意；原名额、排队与款项均保留。',async()=>{
      try {const latest=await api('/api/events/'+e.id),updated=await api(`/api/events/${e.id}/claims`,'POST',{base_revision:latest.revision,attendee_id:p.id,reason:'管理人邀请本人核对认领'});$('#attendee-dialog').close();renderDetail(updated);await refresh({detail:false});const c=updated.claim_invitations.find(v=>v.attendee_id===p.id&&v.status==='invited');if(c)await copyClaimLink(e.id,c.token);}catch(error){toast(error.message);}
    });
  }
  document.addEventListener('click',async event=>{
    const accountButton=event.target.closest('[data-identity]'),switcher=event.target.closest('[data-account-scope]'),revoke=event.target.closest('[data-revoke-device]'),claimCopy=event.target.closest('[data-claim-copy]'),decision=event.target.closest('[data-claim-decision]');
    const e=state.events.find(e=>e.id===state.current);
    if(claimCopy&&e){const c=e.claim_invitations.find(c=>c.id===claimCopy.dataset.claimCopy);return copyClaimLink(e.id,c.token);}
    if(decision&&e){const c=e.claim_invitations.find(c=>c.id===decision.dataset.id),action=decision.dataset.claimDecision;askConfirm(action==='approve'?'确认认领人为这位参加者？':'结束这份认领邀请？',`报名：${c.name}${c.requester_name?'；申请人：'+c.requester_name:''}。请通过群内沟通核对身份。原排队、费用责任及历史保留。`,async()=>{try{const updated=await api(`/api/events/${e.id}/claims/${c.id}`,'POST',{base_revision:e.revision,decision:action,confirm_person:true,reason:'管理人核对认领：'+action});renderDetail(updated);await refresh({detail:false});toast('认领处理已保存');}catch(error){toast(error.message);}});return;}
    if(revoke){askConfirm('撤销这台设备？','这台设备将失去当前账号的访问权；它自己的其他账号保留。',async()=>{try{await api('/api/account/revoke','POST',{device_id:revoke.dataset.revokeDevice,operation:crypto.randomUUID()});await account();}catch(error){fail(error);}});return;}
    if(switcher){
      if($('#profile-dialog').open&&$('#nickname-input').value!==state.me.nickname){toast('请先保存或关闭称呼修改');return;}
      if([...document.querySelectorAll('dialog[open]')].some(d=>d.id!=='profile-dialog'&&d.querySelector('form'))){toast('请先暂存并关闭正在编辑的表单');return;}
      askConfirm('切换账号？','账号与本机草稿分开保留，不合并报名、活动或款项。',async()=>{try{await api('/api/account/switch','POST',{scope:switcher.dataset.accountScope,operation:crypto.randomUUID()});location.reload();}catch(error){const me=await api('/api/me').catch(()=>null);if(me&&me.draft_scope!==state.me.draft_scope)location.reload();else fail(error);}});return;
    }
    if(!accountButton)return;const action=accountButton.dataset.identity;
    if(action==='account')return account();
    if(action==='qq-refresh-info')return qqRefresh();
    if(action==='qq-refresh-later'){$('#identity-dialog').close();return;}
    if(action==='qq-refresh'){
      if(!state.me.qq?.needs_reauth||!canLeave())return;
      let consent;try{consent=privacyData();}catch(error){fail(error);return;}
      accountButton.disabled=true;
      try{await startQQ('bind',consent,true);}catch(error){fail(error);accountButton.disabled=false;}
      return;
    }
    if(action==='logout'){
      if(!canLeave())return;
      askConfirm('退出当前浏览器？','当前浏览器中的所有账号授权都会退出，再次使用时请重新登录。共用设备请同时清理浏览器网站数据和本机草稿。',async()=>{
        try{await api('/api/auth/logout','POST',{});location.replace('/');}catch(error){toast(error.message);}
      });return;
    }
    if(action==='close-account'){
      if(!$('#confirm-close-account')?.checked){fail(new Error('请先勾选确认注销影响'));return;}
      if(!canLeave())return;
      askConfirm('确认注销账号并申请删除？','所有设备将失去本账号的访问权限。QQ 再次登录会创建新账号，原记录不会自动找回。涉及共用记录的申请将继续核对。',async()=>{
        try{const result=await api('/api/auth/close','POST',{confirm_close:true});try{sessionStorage.setItem('kanban-privacy-receipt',JSON.stringify(result));}catch{}location.replace('/');}catch(error){fail(error);}
      });return;
    }
    if(action==='name-register'){
      const field=$('#register-nickname');if(!field.reportValidity())return;
      let consent;try{consent=privacyData();}catch(error){fail(error);return;}
      askConfirm('使用这个称呼创建账号？','请保留当前浏览器，或在账号设置中绑定 QQ，方便以后找回账号。',async()=>{
        try{await api('/api/register','POST',{nickname:field.value.trim(),confirm:true,...consent});location.reload();}catch(error){fail(error);}
      });return;
    }
    if(action==='qq-bind'||action==='qq-login')return beginQQ(action==='qq-bind'?'bind':'login');
    if(action==='qq-finish'){
      if(!$('#qq-confirm')?.checked){fail(new Error('请先核对并确认账号操作'));return;}
      if(!canLeave())return;
      accountButton.disabled=true;
      try{const result=await api('/api/auth/qq/finish','POST',{attempt_id:qqResult.attempt_id,confirm:true});try{const wasRefresh=qqResult.mode==='bind'&&sessionStorage.getItem('kanban-qq-refresh-scope')===state.me.draft_scope;sessionStorage.setItem('kanban-qq-authorized',wasRefresh?'refresh':'login');sessionStorage.removeItem('kanban-qq-refresh-scope');if(result.new_account)sessionStorage.setItem('kanban-welcome','1');}catch{}location.replace(result.return_path||'/');}
      catch(error){const me=await api('/api/me').catch(()=>null);if(me&&me.draft_scope!==state.me.draft_scope)location.replace('/');else fail(error);accountButton.disabled=false;}
      return;
    }
    accountButton.disabled=true;
    try {
      if(action==='issue-device'){
        if(!$('#authorize-device').checked)throw new Error('请先确认只连接自己的设备');
        const result=await api('/api/account/link','POST',{authorize_device:true,operation:crypto.randomUUID()});link=location.origin+'/?account_link='+result.link_token;$('#device-link').value=link;$('#device-link').hidden=false;$('[data-identity=copy-device]').hidden=false;
      }
      if(action==='copy-device')await copyLink(link,'设备连接');
      if(action==='accept-device'){
        if(!$('#accept-device').checked)throw new Error('请先确认账号归属和授权内容');
        await api('/api/account/accept','POST',{token:incoming.token,accept_access:true});const url=new URL(location.href);url.searchParams.delete('account_link');history.replaceState(history.state,'',url);await account();toast('设备已连接，可选择账号切换');
      }
      if(action==='request-claim'){
        if(!$('#claim-person').checked||!$('#claim-payment').checked)throw new Error('请确认本人身份和原付款责任');
        return await withProfile(async()=>{try{const {eventId,token,info}=incoming;await api(`/api/events/${eventId}/claims/${token}/request`,'POST',{base_revision:info.base_revision,confirm_identity:true,keep_payment:true});await receiveClaim(eventId,token);toast('认领申请已提交');}catch(error){fail(error);}});
      }
      if(action==='existing-signup'){if(incoming.info?.claimed){const url=new URL(location.href);url.searchParams.delete('claim');history.replaceState(history.state,'',url);}$('#identity-dialog').close();await openDetail(incoming.eventId);}
    }catch(error){fail(error);}finally{accountButton.disabled=false;}
  });
  function qqSection(qq) {
    if(!qq?.enabled)return '<p class="field-help">QQ 登录暂不可用，可连接自己的另一台设备。</p>';
    return `<section class="qq-account-section"><h3>QQ 账号</h3>${qq.bound?qqProfile(qq.nickname,qq.avatar_url):''}<p class="field-help">${qq.bound?'换设备时，用此 QQ 登录即可。':'绑定 QQ 可找回当前账号。直接登录将进入该 QQ 对应的账号。'}</p>${qq.bound?qq.needs_reauth?'<p class="field-help">资料待更新，bot 暂时无法识别账号。</p><button type="button" class="button secondary full" data-identity="qq-refresh-info">重新登录 QQ</button>':'':'<button type="button" class="button secondary full" data-identity="qq-bind">绑定 QQ</button>'}<button type="button" class="text-button full" data-identity="qq-login">${qq.bound?'换个 QQ 登录':'使用 QQ 登录'}</button></section>`;
  }
  function reminderKey(){return 'kanban-qq-reauth-v1:'+state.me.draft_scope;}
  function stampQQReminder(){
    remindedScopes.add(state.me.draft_scope);
    try{localStorage.setItem(reminderKey(),String(Date.now()));}catch{}
  }
  function qqRefresh(){
    if(!state.me.authenticated||!state.me.qq?.enabled||!state.me.qq.needs_reauth)return;
    stampQQReminder();
    $('#identity-title').textContent='重新登录 QQ';$('#identity-error').textContent='';
    $('#identity-content').innerHTML=`${qqProfile(state.me.qq.nickname,state.me.qq.avatar_url)}<p>bot 暂时无法识别你的账号，请用原 QQ 重新登录。</p><p class="field-help">稍后处理不影响网站使用。</p>${privacyConsent()}<button type="button" class="button primary full" data-identity="qq-refresh">重新登录 QQ</button><button type="button" class="text-button full" data-identity="qq-refresh-later">稍后处理</button>`;
    showDialog('identity-dialog');
  }
  function maybeQQRefresh(){
    if(!qqReminderReady||!state.me.authenticated||!state.me.qq?.enabled||!state.me.qq.bound||!state.me.qq.needs_reauth||!state.me.draft_scope)return;
    if(document.querySelector('dialog[open]')||remindedScopes.has(state.me.draft_scope))return;
    try{const stamp=Number(localStorage.getItem(reminderKey()));if(stamp>0&&Date.now()-stamp<qqReminderInterval)return;}catch{}
    qqRefresh();
  }
  function initQQRefresh(){
    let authorized;try{authorized=sessionStorage.getItem('kanban-qq-authorized');sessionStorage.removeItem('kanban-qq-authorized');}catch{}
    if(authorized&&state.me.authenticated&&state.me.qq?.bound){
      if(state.me.qq.needs_reauth){stampQQReminder();toast('QQ 资料未补齐，bot 仍无法识别账号。可在「账号与设备」重试。');}
      else if(authorized==='refresh')toast('QQ 登录资料已更新。');
    }
    qqReminderReady=true;maybeQQRefresh();
  }
  document.addEventListener('close',()=>{if(qqReminderReady)setTimeout(maybeQQRefresh,0);},true);
  function canLeave() {
    if($('#profile-dialog').open&&$('#nickname-input').value!==state.me.nickname){toast('请先保存或关闭称呼修改');return false;}
    if([...document.querySelectorAll('dialog[open]')].some(d=>d.id!=='profile-dialog'&&d.querySelector('form'))){toast('请先暂存并关闭正在编辑的表单');return false;}
    return true;
  }
  function beginQQ(mode) {
    if(!canLeave())return;
    let consent;try{consent=privacyData();}catch(error){fail(error);return;}
    askConfirm(mode==='bind'?'绑定 QQ 到当前账号？':'使用 QQ 登录账号？',mode==='bind'?'授权后还需要核对确认。绑定保留当前账号的活动、报名和款项，QQ 昵称不会覆盖群内称呼。':state.me.authenticated?'将进入这个 QQ 对应的账号；当前账号分开保留，不自动合并报名或款项。':'将前往 QQ 官方授权，首次登录会创建账号。返回后核对并确认登录即可。',async()=>{
      try{await startQQ(mode,consent);}catch(error){fail(error);}
    });
  }
  async function startQQ(mode,consent,refresh=false){
    if(state.me.qq?.needs_reauth)stampQQReminder();
    const result=await api('/api/auth/qq/start','POST',{mode,confirm:true,...consent,operation:crypto.randomUUID(),return_path:location.pathname+location.search});
    try{if(refresh)sessionStorage.setItem('kanban-qq-refresh-scope',state.me.draft_scope);else sessionStorage.removeItem('kanban-qq-refresh-scope');}catch{}
    location.assign(result.authorize_url);
  }
  async function receiveQQ() {
    $('#identity-title').textContent='确认 QQ 授权';$('#identity-error').textContent='';$('#identity-content').textContent='加载中…';showDialog('identity-dialog');
    const url=new URL(location.href);url.searchParams.delete('qq');history.replaceState(history.state,'',url);
    try {
      qqResult=await api('/api/auth/qq/status');
      if(qqResult.status!=='verified'){
        $('#identity-content').innerHTML='<p>QQ 授权未完成或已过期，请重新登录。</p><button type="button" class="button secondary full" data-identity="account">返回账号与设备</button>';return;
      }
      const q=qqResult;
      $('#identity-content').innerHTML=`${qqProfile(q.qq_nickname,q.avatar_url)}${q.conflict?'<p class="error-banner">这个 QQ 已绑定其他账号，不能绑定到当前账号。请使用 QQ 登录，原账号与款项分开保留。</p><button type="button" class="button secondary full" data-identity="qq-login">使用 QQ 登录账号</button>':`<p>${q.mode==='bind'?`将绑定到当前账号「${esc(q.current_nickname||'未设置称呼')}」，保留现有活动、报名和款项，不修改群内称呼。`:`将登录「${esc(q.target_nickname||q.qq_nickname)}」${q.existing_account?'':'的新账号'}。当前浏览器原有账号分开保留，可在账号与设备中切换。`}</p><label class="check-option"><input id="qq-confirm" type="checkbox">这是我的 QQ，确认${q.mode==='bind'?'绑定当前账号':'登录此账号'}</label><button type="button" class="button primary full" data-identity="qq-finish">确认${q.mode==='bind'?'绑定':'登录'}</button>`}`;
    }catch(error){fail(error);}
  }
  function receipt() {
    let result;try{result=JSON.parse(sessionStorage.getItem('kanban-privacy-receipt')||'null');sessionStorage.removeItem('kanban-privacy-receipt');}catch{return;}
    if(!result?.request_id)return;
    $('#identity-title').textContent='注销与资料删除';$('#identity-error').textContent='';
    $('#identity-content').innerHTML=`<p>账号登录身份、QQ 资料及私人收款码已移除。</p><p>申请编号：</p><p class="receipt-id">${esc(result.request_id)}</p><p>${result.status==='shared_review'?'共同活动、报名或账务记录仍待核对。请把申请编号发送至下方邮箱，说明希望进一步删除的范围。':'个人账号资料删除已完成。必要的注销处理记录及隔离备份会按隐私政策处理。'}</p><p><a href="mailto:203008876@qq.com">203008876@qq.com</a></p><p class="field-help">请保存申请编号，便于跟进处理。</p>`;
    showDialog('identity-dialog');
  }
  return {account,receiveClaim,receiveDevice,receiveQQ,section,issueClaim,receipt,initQQRefresh};
}
