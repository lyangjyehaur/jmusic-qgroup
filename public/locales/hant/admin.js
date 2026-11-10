'use strict';
(()=>{
 const $=s=>document.querySelector(s);let csrf='',revision=0,botInfo=null,botTemplates={},templateKind='',botBusy=false;
 let currentUserId=null,usersInfo=null,usersSearch='',usersFilter='all',usersOffset=0,usersBusy=false,pendingUser=null;
 async function request(path,data){
  let status=0,outcome='network_error';
  try{
  const response=await fetch(path,{method:data?'POST':'GET',credentials:'same-origin',headers:{...(data?{'Content-Type':'application/json'}:{}),...(csrf?{'X-Kanban-Admin':csrf}:{})},body:data?JSON.stringify(data):undefined});
  status=response.status;outcome=response.ok?'success':'rejected';
  let result;try{result=await response.json();}catch(error){outcome='invalid_response';throw error;}
  if(!response.ok)throw Object.assign(new Error(result.error||"操作失敗，請重試"),{status:response.status});return result;
  }finally{try{globalThis.BoardAnalytics?.request(path,data?'POST':'GET',status,outcome);}catch{}}
 }
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function privacyRequests(items){
  $('#privacy-requests').innerHTML=items.map(item=>`<section class="privacy-request"><p><strong>${item.status==='completed'?"個人帳號資料已刪除":"共用記錄待核對"}</strong> · ${esc(item.created_at)}</p><p class="receipt-id">${esc(item.id)}</p><p class="field-help">${esc(Object.entries(item.shared_records).map(([table,count])=>table+': '+count).join('；')||"無關聯共用記錄")}</p><form data-privacy-request="${esc(item.id)}"><label class="field">處理說明<textarea name="note" required maxlength="1000">${esc(item.note)}</textarea></label><button class="button secondary" type="submit">保存處理說明</button></form></section>`).join('')||"<p class=\"field-help\">暫無資料刪除申請</p>";
 }
 const error=problem=>{$('#admin-error').textContent=problem.message;};
 function renderUsers(){
  const info=usersInfo;
  $('#users-summary').textContent=`共 ${info.total} 個帳號`;
  $('#users-page').textContent=info.total?`${Math.floor(info.offset/info.limit)+1} / ${Math.ceil(info.total/info.limit)}`:'0 / 0';
  $('#users-prev').disabled=usersBusy||info.offset===0;$('#users-next').disabled=usersBusy||info.offset+info.limit>=info.total;
  $('#admin-users').innerHTML=info.users.map(user=>`<article class="admin-user"><div class="admin-user-heading"><strong>${esc(user.nickname||"未設置稱呼")}</strong><span class="admin-user-role">${user.is_admin?"管理員":"普通用戶"}${user.id===currentUserId?" · 當前帳號":''}</span></div><p class="receipt-id" translate="no">${esc(user.id)}</p><p class="field-help">${user.identities.length?user.identities.map(item=>`${esc(item.provider==='qq'?"QQ 綁定暱稱":item.provider)}：<span translate="no">${esc(item.display_name)}</span>${item.provider==='qq'?` · UnionID：${item.unionid_bound?"已取得":"待補齊"}`:''}`).join('；'):"未綁定第三方帳號"}${user.identities.some(item=>item.provider==='qq')?'':" · UnionID：未綁定 QQ"}</p><p class="field-help">註冊時間：${esc(new Date(user.created_at).toLocaleString())}</p><button type="button" class="button secondary" data-admin-user="${esc(user.id)}" ${usersBusy||(user.id===currentUserId&&user.is_admin)?'disabled':''}>${user.is_admin?"撤銷管理員":"設為管理員"}</button>${user.id===currentUserId?"<p class=\"field-help\">當前帳號的管理員權限須由其他管理員撤銷。</p>":''}</article>`).join('')||"<p class=\"field-help\">沒有符合條件的帳號</p>";
 }
 async function loadUsers(){
  usersInfo=await request('/api/admin/users?'+new URLSearchParams({search:usersSearch,unionid:usersFilter,offset:String(usersOffset)}));
  if(usersOffset&&usersOffset>=usersInfo.total){usersOffset=Math.max(0,Math.floor((usersInfo.total-1)/usersInfo.limit)*usersInfo.limit);return loadUsers();}
  renderUsers();
 }
 async function usersAction(work){
  if(usersBusy)return;usersBusy=true;$('#users-error').textContent='';
  for(const field of $('#users-search').elements)field.disabled=true;
  if(usersInfo)renderUsers();
  try{await work();}catch(problem){$('#users-error').textContent=problem.message;if(problem.status===401)await load();}
  finally{usersBusy=false;for(const field of $('#users-search').elements)field.disabled=false;if(usersInfo)renderUsers();}
 }
 $('#users-search').addEventListener('submit',e=>{e.preventDefault();usersSearch=e.currentTarget.elements.search.value.trim();usersFilter=e.currentTarget.elements.unionid.value;usersOffset=0;usersAction(loadUsers);});
 $('#users-reload').addEventListener('click',()=>usersAction(loadUsers));
 $('#users-prev').addEventListener('click',()=>{if(usersBusy)return;usersOffset=Math.max(0,usersOffset-20);usersAction(loadUsers);});
 $('#users-next').addEventListener('click',()=>{if(usersBusy)return;usersOffset+=20;usersAction(loadUsers);});
 $('#admin-users').addEventListener('click',e=>{
  const button=e.target.closest('[data-admin-user]');if(!button||usersBusy)return;
  const user=usersInfo.users.find(item=>item.id===button.dataset.adminUser);if(!user)return;
  pendingUser=user;
  $('#users-confirm-name').textContent=user.nickname||"未設置稱呼";$('#users-confirm-id').textContent=user.id;
  $('#users-confirm-effect').textContent=user.is_admin?"撤銷後，該帳號無法繼續使用管理後臺。":"該帳號將能管理全部後臺設置及用戶權限。";
  $('#users-confirm-submit').textContent=user.is_admin?"撤銷管理員":"設為管理員";
  $('#users-confirm').returnValue='';$('#users-confirm').showModal();
 });
 $('#users-confirm').addEventListener('close',()=>{
  const user=pendingUser;pendingUser=null;
  if($('#users-confirm').returnValue!=='confirm'||!user)return;
  $('#users-saved').textContent='';
  usersAction(async()=>{try{await request('/api/admin/users',{user_id:user.id,is_admin:!user.is_admin,base_revision:user.revision});$('#users-saved').textContent=user.is_admin?"已撤銷管理員權限":"已設為管理員，該帳號登錄後可直接訪問後臺";}catch(problem){await loadUsers();throw problem;}await loadUsers();});
 });
 const botForm=$('#bot-settings-form');
 const botLabels={enabled:"主動通知",replies_enabled:"指令回覆",dry_run:"發送模式",broadcast_kinds:"通知事件",schedule_enabled:"定時提醒",deadline_hours:"截止提醒時間",estimated_over_delay_minutes:"預計結束提醒時間",quiet_enabled:"勿擾開關",quiet_start:"勿擾開始",quiet_end:"勿擾結束",timezone:"勿擾時區",min_interval_seconds:"發送間隔",templates:"消息模板"};
 function botStatus(info){
  const runtime=info.runtime;
  const loaded=runtime.applied_revision===null?"機器人尚未回報配置狀態":`機器人已載入第 ${runtime.applied_revision} 版`;
  const updated=info.revision!==botInfo?.revision?"；有新版配置，請重新載入":'';
  $('#bot-runtime').textContent=`當前配置第 ${info.revision} 版；${loaded}${runtime.checked_at?"；回報時間 "+new Date(runtime.checked_at).toLocaleString():''}${updated}`;
 }
 function templateState(){
  $('#bot-template-state').textContent=Object.hasOwn(botTemplates,templateKind)?"正在編輯自定義模板":"正在使用默認模板";
 }
 function rememberTemplate(){
  if(!templateKind)return;
  const value=$('#bot-template-text').value;
  if(value===botInfo.default_template)delete botTemplates[templateKind];else botTemplates[templateKind]=value;
 }
 function showTemplate(){
  templateKind=$('#bot-template-kind').value;
  $('#bot-template-text').value=botTemplates[templateKind]??botInfo.default_template;
  $('#bot-preview-text').hidden=true;templateState();
 }
 function botSetup(info){
  botInfo=info;botTemplates={...info.config.templates};templateKind='';
  for(const [key,value] of Object.entries(info.config)){
   const field=botForm.elements.namedItem(key);if(!field)continue;
   if(field.type==='checkbox')field.checked=value;else field.value=key==='dry_run'?(value===null?'inherit':value?'simulate':'live'):value;
  }
  $('#bot-kinds').innerHTML=Object.entries(info.kinds).map(([kind,label])=>`<label class="check-option"><input type="checkbox" name="broadcast_kind" value="${esc(kind)}" ${info.config.broadcast_kinds.includes(kind)?'checked':''}>${esc(label)}</label>`).join('');
  const selected=$('#bot-template-kind').value;
  $('#bot-template-kind').innerHTML=Object.entries(info.kinds).map(([kind,label])=>`<option value="${esc(kind)}">${esc(label)}</option>`).join('');
  if(Object.hasOwn(info.kinds,selected))$('#bot-template-kind').value=selected;
  $('#bot-template-variables').innerHTML=Object.entries(info.variables).map(([key,label])=>`<button type="button" data-variable="${esc(key)}" title="${esc(label)}">${esc(label)} {${esc(key)}}</button>`).join('');
  $('#bot-history').innerHTML=info.history.map(item=>`<p><strong>第 ${item.revision} 版</strong> · ${esc(new Date(item.created_at).toLocaleString())} · ${esc(item.action==='revert'?"恢復配置":item.action==='baseline'?"部署默認配置":"保存配置")}<br>${esc(item.changes.map(key=>botLabels[key]||key).join('、'))}</p>`).join('');
  $('#bot-revert').disabled=info.revision===0;
  showTemplate();botStatus(info);
 }
 function botDraft(){
  rememberTemplate();const config={};
  for(const key of Object.keys(botInfo.config)){
   if(key==='templates'){config[key]={...botTemplates};continue;}
   if(key==='broadcast_kinds'){config[key]=[...botForm.querySelectorAll('[name="broadcast_kind"]:checked')].map(field=>field.value);continue;}
   const field=botForm.elements.namedItem(key);
   config[key]=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.value;
  }
  config.dry_run=config.dry_run==='inherit'?null:config.dry_run==='simulate';
  return config;
 }
 async function botAction(work){
  if(botBusy||!botInfo)return;botBusy=true;$('#bot-error').textContent='';$('#bot-saved').textContent='';
  for(const fieldset of botForm.querySelectorAll('fieldset'))fieldset.disabled=true;
  for(const button of botForm.querySelectorAll('button'))button.disabled=true;
  $('#bot-revert').disabled=true;
  try{await work();}catch(problem){$('#bot-error').textContent=problem.message;}
  finally{botBusy=false;for(const fieldset of botForm.querySelectorAll('fieldset'))fieldset.disabled=false;for(const button of botForm.querySelectorAll('button'))button.disabled=false;$('#bot-revert').disabled=botInfo.revision===0;}
 }
 $('#bot-template-kind').addEventListener('change',()=>{rememberTemplate();showTemplate();});
 $('#bot-template-text').addEventListener('input',()=>{rememberTemplate();templateState();$('#bot-preview-text').hidden=true;});
 $('#bot-template-reset').addEventListener('click',()=>{delete botTemplates[templateKind];showTemplate();});
 $('#bot-template-variables').addEventListener('click',e=>{const button=e.target.closest('[data-variable]');if(!button)return;const field=$('#bot-template-text');field.setRangeText('{'+button.dataset.variable+'}',field.selectionStart,field.selectionEnd,'end');field.focus();rememberTemplate();templateState();$('#bot-preview-text').hidden=true;});
 $('#bot-preview').addEventListener('click',()=>{if(!botForm.reportValidity())return;const config=botDraft();botAction(async()=>{const result=await request('/api/admin/bot-preview',{config,kind:templateKind});$('#bot-preview-text').textContent=result.text;$('#bot-preview-text').hidden=false;});});
 botForm.addEventListener('submit',e=>{e.preventDefault();const config=botDraft();botAction(async()=>{const result=await request('/api/admin/bot-settings',{config,base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent="機器人設置已保存，等待機器人回報載入狀態。";});});
 $('#bot-reload').addEventListener('click',()=>botAction(async()=>{botSetup(await request('/api/admin/bot-settings'));$('#bot-saved').textContent="已重新載入，未保存的修改已清除。";}));
 $('#bot-revert').addEventListener('click',()=>botAction(async()=>{const result=await request('/api/admin/bot-revert',{base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent="已恢復上一版配置，並保存為新版本。";}));
 setInterval(async()=>{if(!csrf||!botInfo||botBusy||document.hidden)return;try{botStatus(await request('/api/admin/bot-settings'));}catch(problem){if(problem.status===401){csrf='';$('#admin-settings').hidden=true;$('#admin-login').hidden=false;error(problem);}}},10000);
 async function load(){
  try{const info=await request('/api/admin/session');csrf=info.csrf;currentUserId=info.current_user_id;$('#admin-access').textContent=info.auth_method==='account'?"管理員帳號登錄":"管理憑證登錄 · 有效一小時";$('#admin-logout').textContent=info.auth_method==='account'?"退出管理後臺及當前帳號":"退出管理後臺";privacyRequests(info.privacy_requests||[]);revision=info.settings.revision;botSetup(info.bot);$('#allow-name-registration').checked=info.settings.allow_name_registration;$('#admin-login').hidden=true;$('#admin-settings').hidden=false;$('#provider-status').textContent=info.providers.some(p=>p.enabled)?"QQ 登錄已配置":"QQ 未配置，關閉稱呼註冊後將無法註冊。";try{await loadUsers();}catch(problem){$('#users-error').textContent=problem.message;}}
  catch(problem){if(problem.status!==401)error(problem);csrf='';$('#admin-login').hidden=false;$('#admin-settings').hidden=true;}
 }
 $('#admin-login').addEventListener('submit',async e=>{e.preventDefault();$('#admin-error').textContent='';const button=e.currentTarget.querySelector('button');button.disabled=true;try{await request('/api/admin/login',{key:e.currentTarget.elements.key.value});e.target.reset();await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 $('#registration-settings').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;$('#admin-error').textContent='';$('#admin-saved').textContent='';try{const result=await request('/api/admin/settings',{allow_name_registration:$('#allow-name-registration').checked,base_revision:revision});revision=result.settings.revision;$('#admin-saved').textContent="註冊設置已保存";}catch(problem){error(problem);await load();}finally{button.disabled=false;}});
 $('#admin-logout').addEventListener('click',async()=>{try{await request('/api/admin/logout',{});csrf='';await load();}catch(problem){error(problem);}});
 $('#privacy-requests').addEventListener('submit',async e=>{const form=e.target.closest('[data-privacy-request]');if(!form)return;e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await request('/api/admin/privacy-review',{request_id:form.dataset.privacyRequest,note:form.elements.note.value});await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 load();
})();
