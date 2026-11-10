'use strict';
function createIdentityUI({api,$,esc,showDialog,toast,state,withProfile,refresh,renderDetail,askConfirm,copyLink,openDetail}) {
  let incoming=null,link=null,qqResult=null;
  let qqReminderReady=false;
  const remindedScopes=new Set(),qqReminderInterval=24*60*60*1000;
  const fail=problem=>{$('#identity-error').textContent=problem.message;};
  function privacyConsent() {
    return state.me.privacy_accepted?'':`<label class="check-option privacy-consent"><input id="privacy-consent" type="checkbox"><span>我已閱讀並同意<a href="/privacy" target="_blank" rel="noopener">隱私政策</a>，同意為登錄與帳號功能處理必要資料。<a href="/contact" target="_blank" rel="noopener">聯繫運營者</a></span></label>`;
  }
  function privacyData() {
    if(!state.me.privacy_accepted&&!$('#privacy-consent')?.checked)throw new Error("請閱讀並勾選同意隱私政策後繼續");
    return {accept_privacy:true,privacy_version:state.me.privacy_version};
  }
  function qqProfile(nickname,avatarUrl) {
    return `<div class="qq-profile">${avatarUrl?`<img class="qq-avatar" src="${esc(avatarUrl)}" alt="QQ頭像" width="40" height="40" referrerpolicy="no-referrer">`:''}<span>QQ：${esc(nickname)}</span></div>`;
  }
  async function account() {
    $('#identity-title').textContent="帳號與設備";$('#identity-error').textContent='';$('#identity-content').textContent="加載中…";showDialog('identity-dialog');
    try {
      if(!state.me.authenticated){
        const me=await api('/api/me');state.me=me;BoardClient.setIdentity(me.draft_scope);
        $('#identity-title').textContent="登錄";
        if(me.authenticated)return account();
        $('#identity-content').innerHTML=`<p>登錄後即可發起活動、報名並管理自己的記錄。</p>${me.qq?.enabled?"<button type=\"button\" class=\"button secondary full qq-button\" data-identity=\"qq-login\"><img src=\"/qq-login.png\" alt=\"QQ登錄\" width=\"76\" height=\"24\"><span>使用 QQ 登錄</span></button>":"<p class=\"field-help\">QQ 登錄暫不可用，請稍後重試。</p>"}<p class="field-help">首次登錄將自動創建帳號，登錄後可修改群內稱呼。</p>${privacyConsent()}${me.allow_name_registration?"<details class=\"extra-settings\"><summary>使用稱呼註冊</summary><p class=\"field-help\">只創建當前瀏覽器可用的帳號，不能僅憑稱呼找回。以後可綁定 QQ。</p><label class=\"field\">群內稱呼<input id=\"register-nickname\" required maxlength=\"24\" autocomplete=\"nickname\"></label><button type=\"button\" class=\"button secondary full\" data-identity=\"name-register\">創建帳號</button></details>":''}`;
        return;
      }
      const info=await api('/api/account');
      $('#identity-content').innerHTML=`<p class="field-help">當前帳號：${esc(state.me.nickname||"未設置稱呼")}</p>${qqSection(info.qq)}<details class="extra-settings"><summary>${info.qq?.bound?"備用：連接另一臺設備":"連接另一臺設備"}</summary><p class="field-help">鏈接有效 10 分鐘、僅限一次。持有者可管理帳號與帳務，請只發給自己的設備。</p><label class="check-option"><input id="authorize-device" type="checkbox">只授權自己的另一臺設備</label><button class="button secondary full" type="button" data-identity="issue-device">生成限時連接</button><textarea class="summary-fallback" id="device-link" rows="4" readonly aria-label="設備連接，可手動複製" hidden></textarea><button class="text-button full" data-identity="copy-device" hidden>複製設備連接</button></details><details class="extra-settings"><summary>此設備上的帳號 · ${info.accounts.length}</summary><p class="field-help">帳號分開保留，不合並報名或款項；切換前請暫存並關閉表單。</p>${info.accounts.map(a=>`<p class="account-row"><span>${esc(a.nickname||"未設置稱呼")} · ${esc(a.scope.slice(-6))}</span>${a.current?"<span>當前</span>":`<button type="button" class="text-button" data-account-scope="${a.scope}">切換</button>`}</p>`).join('')}</details><details class="extra-settings"><summary>已授權設備 · ${info.devices.length}</summary>${info.devices.map(d=>`<p class="account-row"><span>${d.current?"當前設備":"其他設備 · "+esc(d.id.slice(-6))}<br><small>${esc(d.created_at.slice(0,10))}</small></span>${d.current?'':`<button type="button" class="text-button danger" data-revoke-device="${d.id}">撤銷</button>`}</p>`).join('')}</details><details class="extra-settings"><summary>帳號操作記錄</summary>${info.history.map(h=>`<p class="field-help">${esc({name_registered:"創建帳號",device_link_issued:"生成設備連接",device_link_accepted:"設備已連接",device_revoked:"撤銷設備",account_switched:"切換帳號",qq_bound:"綁定 QQ",qq_login:"QQ 登錄"}[h.action]||h.action)} · ${esc(h.created_at)}</p>`).join('')||"<p class=\"field-help\">暫無記錄</p>"}</details>${privacyConsent()}<section class="privacy-controls"><h3>隱私與資料刪除</h3><p class="field-help"><a href="/privacy" target="_blank" rel="noopener">隱私政策</a> · <a href="/contact" target="_blank" rel="noopener">聯繫與投訴</a></p><p class="field-help">註銷會撤銷所有設備對本帳號的登錄權限，移除 QQ 身份和私人收款碼。共用的活動、報名、款項與憑證需進一步核對，申請會保留至處理完畢。請先轉交仍由你管理的活動，並核對未結款項。</p><label class="check-option"><input id="confirm-close-account" type="checkbox">我瞭解註銷影響，並申請刪除帳號資料</label><button type="button" class="text-button full danger" data-identity="close-account">註銷帳號並申請刪除資料</button><button type="button" class="button secondary full" data-identity="logout">退出登錄</button></section>`;
    }catch(e){fail(e);}
  }
  async function receiveDevice(token) {
    incoming={kind:'device',token};$('#identity-content').textContent="加載中…";$('#identity-title').textContent="連接另一設備上的帳號";$('#identity-error').textContent='';showDialog('identity-dialog');
    try {const info=await api('/api/account-links/'+token);
      $('#identity-content').innerHTML=`<p>將「${esc(info.nickname)}」帳號授權給當前設備。</p><p class="field-help">有效至 ${esc(info.expires_at)}。此設備原有帳號、活動與款項會分開保留，不自動合併；接受後可在帳號列表切換。只有在你自己的設備之間連接時才接受。</p><label class="check-option"><input id="accept-device" type="checkbox">這是我的帳號，確認授權當前設備</label><button type="button" class="button primary full" data-identity="accept-device">接受設備連接</button>`;
    }catch(e){fail(e);}
  }
  async function receiveClaim(eventId,token) {
    incoming={kind:'claim',eventId,token};$('#identity-content').textContent="加載中…";$('#identity-title').textContent="認領我的報名";$('#identity-error').textContent='';showDialog('identity-dialog');
    try {
      const info=await api(`/api/events/${eventId}/claims/${token}`);incoming.info=info;
      if(info.claimed){$('#identity-content').innerHTML=`<h3>${esc(info.title)}</h3><p>認領已通過，原名額及付款責任保留。</p><button type="button" class="button primary full" data-identity="existing-signup">查看我的報名</button>`;return;}
      $('#identity-content').innerHTML=`<h3>${esc(info.title)}</h3><p>認領「${esc(info.name)}」的${esc({confirmed:"正式",waiting:"候補",tentative:"待確認"}[info.status])}報名。</p><p class="field-help">原名額、排隊順序、已接受的約定和帳單均保留。報名默認付款人為 ${esc(info.payer_name)}；已有帳單以該版本的付款分配為準，認領不轉移款項或重算舊帳。申請後由原管理人核對。</p>${info.duplicate?"<p class=\"error-banner\">你已經有本人報名，不能自動合併。請先管理現有報名並核對重複項；截止後、已有費用或款項時請和發起者協調，歷史及原款項會保留。</p><button type=\"button\" class=\"button secondary full\" data-identity=\"existing-signup\">處理現有報名</button>":info.claim_status==='requested'?`<p class="status-banner">${info.requested_by_me?"申請已提交，等待管理人核對":"這份邀請已有認領申請，請聯繫管理人"}</p>`:"<label class=\"check-option\"><input id=\"claim-person\" type=\"checkbox\">這條報名確實是我本人</label><label class=\"check-option\"><input id=\"claim-payment\" type=\"checkbox\">已核對並保留原付款責任</label><button type=\"button\" class=\"button primary full\" data-identity=\"request-claim\">提交認領申請</button>"}`;
    }catch(e){fail(e);}
  }
  function section(e) {
    const claims=e.claim_invitations||[];if(!claims.length)return '';
    return `<details class="extra-settings"><summary>報名認領 · ${claims.filter(c=>c.can_decide).length} 待核對</summary>${claims.map(c=>`<div class="pending-entry"><p>${esc(c.name)} · ${esc({invited:"等待本人申請",requested:"等待管理人核對",approved:"已認領",rejected:"未通過",revoked:"已撤銷",expired:"已過期"}[c.status])}${c.requester_name?" · 申請人 "+esc(c.requester_name):''}</p>${c.token?`<button type="button" class="text-button" data-claim-copy="${c.id}">複製認領鏈接</button><button type="button" class="text-button danger" data-claim-decision="revoke" data-id="${c.id}">撤銷</button>`:''}${c.can_decide?`<button type="button" class="text-button" data-claim-decision="approve" data-id="${c.id}">核對並同意</button><button type="button" class="text-button danger" data-claim-decision="reject" data-id="${c.id}">拒絕</button>`:''}</div>`).join('')}</details>`;
  }
  async function copyClaimLink(eventId,token) {
    const url=location.origin+'/?event='+eventId+'&claim='+token;
    await copyLink(url,"認領鏈接");$('#link-title').textContent="認領鏈接";$('#link-input').value=url;showDialog('link-dialog');
  }
  async function issueClaim(e,p) {
    askConfirm("邀請本人認領？","只把鏈接發給這位參加者。對方先申請，你再核對同意；原名額、排隊與款項均保留。",async()=>{
      try {const latest=await api('/api/events/'+e.id),updated=await api(`/api/events/${e.id}/claims`,'POST',{base_revision:latest.revision,attendee_id:p.id,reason:"管理人邀請本人核對認領"});$('#attendee-dialog').close();renderDetail(updated);await refresh({detail:false});const c=updated.claim_invitations.find(v=>v.attendee_id===p.id&&v.status==='invited');if(c)await copyClaimLink(e.id,c.token);}catch(error){toast(error.message);}
    });
  }
  document.addEventListener('click',async event=>{
    const accountButton=event.target.closest('[data-identity]'),switcher=event.target.closest('[data-account-scope]'),revoke=event.target.closest('[data-revoke-device]'),claimCopy=event.target.closest('[data-claim-copy]'),decision=event.target.closest('[data-claim-decision]');
    const e=state.events.find(e=>e.id===state.current);
    if(claimCopy&&e){const c=e.claim_invitations.find(c=>c.id===claimCopy.dataset.claimCopy);return copyClaimLink(e.id,c.token);}
    if(decision&&e){const c=e.claim_invitations.find(c=>c.id===decision.dataset.id),action=decision.dataset.claimDecision;askConfirm(action==='approve'?"確認認領人為這位參加者？":"結束這份認領邀請？",`報名：${c.name}${c.requester_name?"；申請人："+c.requester_name:''}。請通過群內溝通核對身份。原排隊、費用責任及歷史保留。`,async()=>{try{const updated=await api(`/api/events/${e.id}/claims/${c.id}`,'POST',{base_revision:e.revision,decision:action,confirm_person:true,reason:"管理人核對認領："+action});renderDetail(updated);await refresh({detail:false});toast("認領處理已保存");}catch(error){toast(error.message);}});return;}
    if(revoke){askConfirm("撤銷這臺設備？","這臺設備將失去當前帳號的訪問權；它自己的其他帳號保留。",async()=>{try{await api('/api/account/revoke','POST',{device_id:revoke.dataset.revokeDevice,operation:crypto.randomUUID()});await account();}catch(error){fail(error);}});return;}
    if(switcher){
      if($('#profile-dialog').open&&$('#nickname-input').value!==state.me.nickname){toast("請先保存或關閉稱呼修改");return;}
      if([...document.querySelectorAll('dialog[open]')].some(d=>d.id!=='profile-dialog'&&d.querySelector('form'))){toast("請先暫存並關閉正在編輯的表單");return;}
      askConfirm("切換帳號？","帳號與本機草稿分開保留，不合並報名、活動或款項。",async()=>{try{await api('/api/account/switch','POST',{scope:switcher.dataset.accountScope,operation:crypto.randomUUID()});location.reload();}catch(error){const me=await api('/api/me').catch(()=>null);if(me&&me.draft_scope!==state.me.draft_scope)location.reload();else fail(error);}});return;
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
      askConfirm("退出當前瀏覽器？","當前瀏覽器中的所有帳號授權都會退出，再次使用時請重新登錄。共用設備請同時清理瀏覽器網站數據和本機草稿。",async()=>{
        try{await api('/api/auth/logout','POST',{});location.replace('/');}catch(error){toast(error.message);}
      });return;
    }
    if(action==='close-account'){
      if(!$('#confirm-close-account')?.checked){fail(new Error("請先勾選確認註銷影響"));return;}
      if(!canLeave())return;
      askConfirm("確認註銷帳號並申請刪除？","所有設備將失去本帳號的訪問權限。QQ 再次登錄會創建新帳號，原記錄不會自動找回。涉及共用記錄的申請將繼續核對。",async()=>{
        try{const result=await api('/api/auth/close','POST',{confirm_close:true});try{sessionStorage.setItem('kanban-privacy-receipt',JSON.stringify(result));}catch{}location.replace('/');}catch(error){fail(error);}
      });return;
    }
    if(action==='name-register'){
      const field=$('#register-nickname');if(!field.reportValidity())return;
      let consent;try{consent=privacyData();}catch(error){fail(error);return;}
      askConfirm("使用這個稱呼創建帳號？","請保留當前瀏覽器，或在帳號設置中綁定 QQ，方便以後找回帳號。",async()=>{
        try{await api('/api/register','POST',{nickname:field.value.trim(),confirm:true,...consent});location.reload();}catch(error){fail(error);}
      });return;
    }
    if(action==='qq-bind'||action==='qq-login')return beginQQ(action==='qq-bind'?'bind':'login');
    if(action==='qq-finish'){
      if(!$('#qq-confirm')?.checked){fail(new Error("請先核對並確認帳號操作"));return;}
      if(!canLeave())return;
      accountButton.disabled=true;
      try{const result=await api('/api/auth/qq/finish','POST',{attempt_id:qqResult.attempt_id,confirm:true});try{const wasRefresh=qqResult.mode==='bind'&&sessionStorage.getItem('kanban-qq-refresh-scope')===state.me.draft_scope;sessionStorage.setItem('kanban-qq-authorized',wasRefresh?'refresh':'login');sessionStorage.removeItem('kanban-qq-refresh-scope');if(result.new_account)sessionStorage.setItem('kanban-welcome','1');}catch{}location.replace(result.return_path||'/');}
      catch(error){const me=await api('/api/me').catch(()=>null);if(me&&me.draft_scope!==state.me.draft_scope)location.replace('/');else fail(error);accountButton.disabled=false;}
      return;
    }
    accountButton.disabled=true;
    try {
      if(action==='issue-device'){
        if(!$('#authorize-device').checked)throw new Error("請先確認只連接自己的設備");
        const result=await api('/api/account/link','POST',{authorize_device:true,operation:crypto.randomUUID()});link=location.origin+'/?account_link='+result.link_token;$('#device-link').value=link;$('#device-link').hidden=false;$('[data-identity=copy-device]').hidden=false;
      }
      if(action==='copy-device')await copyLink(link,"設備連接");
      if(action==='accept-device'){
        if(!$('#accept-device').checked)throw new Error("請先確認帳號歸屬和授權內容");
        await api('/api/account/accept','POST',{token:incoming.token,accept_access:true});const url=new URL(location.href);url.searchParams.delete('account_link');history.replaceState(history.state,'',url);await account();toast("設備已連接，可選擇帳號切換");
      }
      if(action==='request-claim'){
        if(!$('#claim-person').checked||!$('#claim-payment').checked)throw new Error("請確認本人身份和原付款責任");
        return await withProfile(async()=>{try{const {eventId,token,info}=incoming;await api(`/api/events/${eventId}/claims/${token}/request`,'POST',{base_revision:info.base_revision,confirm_identity:true,keep_payment:true});await receiveClaim(eventId,token);toast("認領申請已提交");}catch(error){fail(error);}});
      }
      if(action==='existing-signup'){if(incoming.info?.claimed){const url=new URL(location.href);url.searchParams.delete('claim');history.replaceState(history.state,'',url);}$('#identity-dialog').close();await openDetail(incoming.eventId);}
    }catch(error){fail(error);}finally{accountButton.disabled=false;}
  });
  function qqSection(qq) {
    if(!qq?.enabled)return "<p class=\"field-help\">QQ 登錄暫不可用，可連接自己的另一臺設備。</p>";
    return `<section class="qq-account-section"><h3>QQ 帳號</h3>${qq.bound?qqProfile(qq.nickname,qq.avatar_url):''}<p class="field-help">${qq.bound?"換設備時，用此 QQ 登錄即可。":"綁定 QQ 可找回當前帳號。直接登錄將進入該 QQ 對應的帳號。"}</p>${qq.bound?qq.needs_reauth?"<p class=\"field-help\">資料待更新，bot 暫時無法識別帳號。</p><button type=\"button\" class=\"button secondary full\" data-identity=\"qq-refresh-info\">重新登錄 QQ</button>":'':"<button type=\"button\" class=\"button secondary full qq-button\" data-identity=\"qq-bind\"><img src=\"/qq-login.png\" alt=\"QQ登錄\" width=\"76\" height=\"24\"><span>綁定到當前帳號</span></button>"}<button type="button" class="text-button full" data-identity="qq-login">${qq.bound?"換個 QQ 登錄":"使用 QQ 登錄"}</button></section>`;
  }
  function reminderKey(){return 'kanban-qq-reauth-v1:'+state.me.draft_scope;}
  function stampQQReminder(){
    remindedScopes.add(state.me.draft_scope);
    try{localStorage.setItem(reminderKey(),String(Date.now()));}catch{}
  }
  function qqRefresh(){
    if(!state.me.authenticated||!state.me.qq?.enabled||!state.me.qq.needs_reauth)return;
    stampQQReminder();
    $('#identity-title').textContent="重新登錄 QQ";$('#identity-error').textContent='';
    $('#identity-content').innerHTML=`${qqProfile(state.me.qq.nickname,state.me.qq.avatar_url)}<p>bot 暫時無法識別你的帳號，請用原 QQ 重新登錄。</p><p class="field-help">稍後處理不影響網站使用。</p>${privacyConsent()}<button type="button" class="button primary full" data-identity="qq-refresh">重新登錄 QQ</button><button type="button" class="text-button full" data-identity="qq-refresh-later">稍後處理</button>`;
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
      if(state.me.qq.needs_reauth){stampQQReminder();toast("QQ 資料未補齊，bot 仍無法識別帳號。可在「帳號與設備」重試。");}
      else if(authorized==='refresh')toast("QQ 登錄資料已更新。");
    }
    qqReminderReady=true;maybeQQRefresh();
  }
  document.addEventListener('close',()=>{if(qqReminderReady)setTimeout(maybeQQRefresh,0);},true);
  function canLeave() {
    if($('#profile-dialog').open&&$('#nickname-input').value!==state.me.nickname){toast("請先保存或關閉稱呼修改");return false;}
    if([...document.querySelectorAll('dialog[open]')].some(d=>d.id!=='profile-dialog'&&d.querySelector('form'))){toast("請先暫存並關閉正在編輯的表單");return false;}
    return true;
  }
  function beginQQ(mode) {
    if(!canLeave())return;
    let consent;try{consent=privacyData();}catch(error){fail(error);return;}
    askConfirm(mode==='bind'?"綁定 QQ 到當前帳號？":"使用 QQ 登錄帳號？",mode==='bind'?"授權後還需要核對確認。綁定保留當前帳號的活動、報名和款項，QQ 暱稱不會覆蓋群內稱呼。":state.me.authenticated?"將進入這個 QQ 對應的帳號；當前帳號分開保留，不自動合併報名或款項。":"將前往 QQ 官方授權，首次登錄會創建帳號。返回後核對並確認登錄即可。",async()=>{
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
    $('#identity-title').textContent="確認 QQ 授權";$('#identity-error').textContent='';$('#identity-content').textContent="加載中…";showDialog('identity-dialog');
    const url=new URL(location.href);url.searchParams.delete('qq');history.replaceState(history.state,'',url);
    try {
      qqResult=await api('/api/auth/qq/status');
      if(qqResult.status!=='verified'){
        $('#identity-content').innerHTML="<p>QQ 授權未完成或已過期，請重新登錄。</p><button type=\"button\" class=\"button secondary full\" data-identity=\"account\">返回帳號與設備</button>";return;
      }
      const q=qqResult;
      $('#identity-content').innerHTML=`${qqProfile(q.qq_nickname,q.avatar_url)}${q.conflict?"<p class=\"error-banner\">這個 QQ 已綁定其他帳號，不能綁定到當前帳號。請使用 QQ 登錄，原帳號與款項分開保留。</p><button type=\"button\" class=\"button secondary full\" data-identity=\"qq-login\">使用 QQ 登錄帳號</button>":`<p>${q.mode==='bind'?`將綁定到當前帳號「${esc(q.current_nickname||"未設置稱呼")}」，保留現有活動、報名和款項，不修改群內稱呼。`:`將登錄「${esc(q.target_nickname||q.qq_nickname)}」${q.existing_account?'':"的新帳號"}。當前瀏覽器原有帳號分開保留，可在帳號與設備中切換。`}</p><label class="check-option"><input id="qq-confirm" type="checkbox">這是我的 QQ，確認${q.mode==='bind'?"綁定當前帳號":"登錄此帳號"}</label><button type="button" class="button primary full" data-identity="qq-finish">確認${q.mode==='bind'?"綁定":"登錄"}</button>`}`;
    }catch(error){fail(error);}
  }
  function receipt() {
    let result;try{result=JSON.parse(sessionStorage.getItem('kanban-privacy-receipt')||'null');sessionStorage.removeItem('kanban-privacy-receipt');}catch{return;}
    if(!result?.request_id)return;
    $('#identity-title').textContent="註銷與資料刪除";$('#identity-error').textContent='';
    $('#identity-content').innerHTML=`<p>帳號登錄身份、QQ 資料及私人收款碼已移除。</p><p>申請編號：</p><p class="receipt-id">${esc(result.request_id)}</p><p>${result.status==='shared_review'?"共同活動、報名或帳務記錄仍待核對。請把申請編號發送至下方郵箱，說明希望進一步刪除的範圍。":"個人帳號資料刪除已完成。必要的註銷處理記錄及隔離備份會按隱私政策處理。"}</p><p><a href="mailto:203008876@qq.com">203008876@qq.com</a></p><p class="field-help">請保存申請編號，便於跟進處理。</p>`;
    showDialog('identity-dialog');
  }
  return {account,receiveClaim,receiveDevice,receiveQQ,section,issueClaim,receipt,initQQRefresh};
}
