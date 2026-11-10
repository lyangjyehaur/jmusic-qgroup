'use strict';
(()=>{
 const $=s=>document.querySelector(s);let csrf='',revision=0,botInfo=null,botTemplates={},templateKind='',botBusy=false;
 let currentUserId=null,usersInfo=null,usersSearch='',usersOffset=0,usersBusy=false,pendingUser=null;
 async function request(path,data){
  let status=0,outcome='network_error';
  try{
  const response=await fetch(path,{method:data?'POST':'GET',credentials:'same-origin',headers:{...(data?{'Content-Type':'application/json'}:{}),...(csrf?{'X-Kanban-Admin':csrf}:{})},body:data?JSON.stringify(data):undefined});
  status=response.status;outcome=response.ok?'success':'rejected';
  let result;try{result=await response.json();}catch(error){outcome='invalid_response';throw error;}
  if(!response.ok)throw Object.assign(new Error(result.error||'操作失败，请重试'),{status:response.status});return result;
  }finally{try{globalThis.BoardAnalytics?.request(path,data?'POST':'GET',status,outcome);}catch{}}
 }
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function privacyRequests(items){
  $('#privacy-requests').innerHTML=items.map(item=>`<section class="privacy-request"><p><strong>${item.status==='completed'?'个人账号资料已删除':'共用记录待核对'}</strong> · ${esc(item.created_at)}</p><p class="receipt-id">${esc(item.id)}</p><p class="field-help">${esc(Object.entries(item.shared_records).map(([table,count])=>table+': '+count).join('；')||'无关联共用记录')}</p><form data-privacy-request="${esc(item.id)}"><label class="field">处理说明<textarea name="note" required maxlength="1000">${esc(item.note)}</textarea></label><button class="button secondary" type="submit">保存处理说明</button></form></section>`).join('')||'<p class="field-help">暂无资料删除申请</p>';
 }
 const error=problem=>{$('#admin-error').textContent=problem.message;};
 function renderUsers(){
  const info=usersInfo;
  $('#users-summary').textContent=`共 ${info.total} 个账号`;
  $('#users-page').textContent=info.total?`${Math.floor(info.offset/info.limit)+1} / ${Math.ceil(info.total/info.limit)}`:'0 / 0';
  $('#users-prev').disabled=usersBusy||info.offset===0;$('#users-next').disabled=usersBusy||info.offset+info.limit>=info.total;
  $('#admin-users').innerHTML=info.users.map(user=>`<article class="admin-user"><div class="admin-user-heading"><strong>${esc(user.nickname||'未设置称呼')}</strong><span class="admin-user-role">${user.is_admin?'管理员':'普通用户'}${user.id===currentUserId?' · 当前账号':''}</span></div><p class="receipt-id" translate="no">${esc(user.id)}</p><p class="field-help">${user.identities.length?user.identities.map(item=>`${esc(item.provider==='qq'?'QQ 绑定昵称':item.provider)}：<span translate="no">${esc(item.display_name)}</span>`).join('；'):'未绑定第三方账号'}</p><p class="field-help">注册时间：${esc(new Date(user.created_at).toLocaleString())}</p><button type="button" class="button secondary" data-admin-user="${esc(user.id)}" ${usersBusy||(user.id===currentUserId&&user.is_admin)?'disabled':''}>${user.is_admin?'撤销管理员':'设为管理员'}</button>${user.id===currentUserId?'<p class="field-help">当前账号的管理员权限须由其他管理员撤销。</p>':''}</article>`).join('')||'<p class="field-help">没有符合条件的账号</p>';
 }
 async function loadUsers(){
  usersInfo=await request('/api/admin/users?'+new URLSearchParams({search:usersSearch,offset:String(usersOffset)}));
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
 $('#users-search').addEventListener('submit',e=>{e.preventDefault();usersSearch=e.currentTarget.elements.search.value.trim();usersOffset=0;usersAction(loadUsers);});
 $('#users-reload').addEventListener('click',()=>usersAction(loadUsers));
 $('#users-prev').addEventListener('click',()=>{if(usersBusy)return;usersOffset=Math.max(0,usersOffset-20);usersAction(loadUsers);});
 $('#users-next').addEventListener('click',()=>{if(usersBusy)return;usersOffset+=20;usersAction(loadUsers);});
 $('#admin-users').addEventListener('click',e=>{
  const button=e.target.closest('[data-admin-user]');if(!button||usersBusy)return;
  const user=usersInfo.users.find(item=>item.id===button.dataset.adminUser);if(!user)return;
  pendingUser=user;
  $('#users-confirm-name').textContent=user.nickname||'未设置称呼';$('#users-confirm-id').textContent=user.id;
  $('#users-confirm-effect').textContent=user.is_admin?'撤销后，该账号无法继续使用管理后台。':'该账号将能管理全部后台设置及用户权限。';
  $('#users-confirm-submit').textContent=user.is_admin?'撤销管理员':'设为管理员';
  $('#users-confirm').returnValue='';$('#users-confirm').showModal();
 });
 $('#users-confirm').addEventListener('close',()=>{
  const user=pendingUser;pendingUser=null;
  if($('#users-confirm').returnValue!=='confirm'||!user)return;
  $('#users-saved').textContent='';
  usersAction(async()=>{try{await request('/api/admin/users',{user_id:user.id,is_admin:!user.is_admin,base_revision:user.revision});$('#users-saved').textContent=user.is_admin?'已撤销管理员权限':'已设为管理员，该账号登录后可直接访问后台';}catch(problem){await loadUsers();throw problem;}await loadUsers();});
 });
 const botForm=$('#bot-settings-form');
 const botLabels={enabled:'主动通知',replies_enabled:'指令回复',dry_run:'发送模式',broadcast_kinds:'通知事件',schedule_enabled:'定时提醒',deadline_hours:'截止提醒时间',estimated_over_delay_minutes:'预计结束提醒时间',quiet_enabled:'勿扰开关',quiet_start:'勿扰开始',quiet_end:'勿扰结束',timezone:'勿扰时区',min_interval_seconds:'发送间隔',templates:'消息模板'};
 function botStatus(info){
  const runtime=info.runtime;
  const loaded=runtime.applied_revision===null?'机器人尚未回报配置状态':`机器人已载入第 ${runtime.applied_revision} 版`;
  const updated=info.revision!==botInfo?.revision?'；有新版配置，请重新载入':'';
  $('#bot-runtime').textContent=`当前配置第 ${info.revision} 版；${loaded}${runtime.checked_at?'；回报时间 '+new Date(runtime.checked_at).toLocaleString():''}${updated}`;
 }
 function templateState(){
  $('#bot-template-state').textContent=Object.hasOwn(botTemplates,templateKind)?'正在编辑自定义模板':'正在使用默认模板';
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
  $('#bot-history').innerHTML=info.history.map(item=>`<p><strong>第 ${item.revision} 版</strong> · ${esc(new Date(item.created_at).toLocaleString())} · ${esc(item.action==='revert'?'恢复配置':item.action==='baseline'?'部署默认配置':'保存配置')}<br>${esc(item.changes.map(key=>botLabels[key]||key).join('、'))}</p>`).join('');
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
 botForm.addEventListener('submit',e=>{e.preventDefault();const config=botDraft();botAction(async()=>{const result=await request('/api/admin/bot-settings',{config,base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent='机器人设置已保存，等待机器人回报载入状态。';});});
 $('#bot-reload').addEventListener('click',()=>botAction(async()=>{botSetup(await request('/api/admin/bot-settings'));$('#bot-saved').textContent='已重新载入，未保存的修改已清除。';}));
 $('#bot-revert').addEventListener('click',()=>botAction(async()=>{const result=await request('/api/admin/bot-revert',{base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent='已恢复上一版配置，并保存为新版本。';}));
 setInterval(async()=>{if(!csrf||!botInfo||botBusy||document.hidden)return;try{botStatus(await request('/api/admin/bot-settings'));}catch(problem){if(problem.status===401){csrf='';$('#admin-settings').hidden=true;$('#admin-login').hidden=false;error(problem);}}},10000);
 async function load(){
  try{const info=await request('/api/admin/session');csrf=info.csrf;currentUserId=info.current_user_id;$('#admin-access').textContent=info.auth_method==='account'?'当前通过管理员账号访问，无需输入管理凭证。退出时会同时登出当前账号。':'当前通过独立管理凭证访问，有效一小时。';$('#admin-logout').textContent=info.auth_method==='account'?'退出管理后台及当前账号':'退出管理后台';privacyRequests(info.privacy_requests||[]);revision=info.settings.revision;botSetup(info.bot);$('#allow-name-registration').checked=info.settings.allow_name_registration;$('#admin-login').hidden=true;$('#admin-settings').hidden=false;$('#provider-status').textContent=info.providers.some(p=>p.enabled)?'已配置第三方登录：QQ。平台是否开通以实际授权结果为准。':'第三方登录尚未配置；关闭免第三方注册后，访客无法建立账号。';try{await loadUsers();}catch(problem){$('#users-error').textContent=problem.message;}}
  catch(problem){if(problem.status!==401)error(problem);csrf='';$('#admin-login').hidden=false;$('#admin-settings').hidden=true;}
 }
 $('#admin-login').addEventListener('submit',async e=>{e.preventDefault();$('#admin-error').textContent='';const button=e.currentTarget.querySelector('button');button.disabled=true;try{await request('/api/admin/login',{key:e.currentTarget.elements.key.value});e.target.reset();await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 $('#registration-settings').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;$('#admin-error').textContent='';$('#admin-saved').textContent='';try{const result=await request('/api/admin/settings',{allow_name_registration:$('#allow-name-registration').checked,base_revision:revision});revision=result.settings.revision;$('#admin-saved').textContent='注册设置已保存';}catch(problem){error(problem);await load();}finally{button.disabled=false;}});
 $('#admin-logout').addEventListener('click',async()=>{try{await request('/api/admin/logout',{});csrf='';await load();}catch(problem){error(problem);}});
 $('#privacy-requests').addEventListener('submit',async e=>{const form=e.target.closest('[data-privacy-request]');if(!form)return;e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await request('/api/admin/privacy-review',{request_id:form.dataset.privacyRequest,note:form.elements.note.value});await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 load();
})();
