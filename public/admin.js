'use strict';
 (()=>{
 const $=s=>document.querySelector(s);let csrf='',revision=0,botInfo=null,botTemplates={},templateKind='',botBusy=false;
 let previewData=null,lastTemplateField='#bot-template-text';
 let currentUserId=null,usersInfo=null,usersSearch='',usersFilter='all',usersOffset=0,usersBusy=false,pendingUser=null,metadataUser=null,metadataBusy=false;
 let botGroups=[];
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
  $('#admin-users').innerHTML=info.users.map(user=>`<article class="admin-user"><div class="admin-user-heading"><strong>${esc(user.nickname||'未设置称呼')}</strong><span class="admin-user-role">${user.is_admin?'管理员':'普通用户'}${user.id===currentUserId?' · 当前账号':''}</span></div><p class="receipt-id" translate="no">${esc(user.id)}</p><p class="field-help">${user.identities.length?user.identities.map(item=>`${esc(item.provider==='qq'?'QQ 绑定昵称':item.provider)}：<span translate="no">${esc(item.display_name)}</span>${item.provider==='qq'?` · UnionID：${item.unionid_bound?'已取得':'待补齐'}`:''}`).join('；'):'未绑定第三方账号'}${user.identities.some(item=>item.provider==='qq')?'':' · UnionID：未绑定 QQ'}</p><p class="field-help">手动关联 QQ 号：<span translate="no">${esc(user.manual_qq||'未填写')}</span></p>${user.note?`<p class="field-help admin-user-note">内部备注：<span translate="no">${esc(user.note)}</span></p>`:''}<p class="field-help">注册时间：${esc(new Date(user.created_at).toLocaleString())}</p><div class="bot-actions"><button type="button" class="button secondary" data-user-metadata="${esc(user.id)}" ${usersBusy?'disabled':''}>编辑备注与 QQ 号</button><button type="button" class="button secondary" data-admin-user="${esc(user.id)}" ${usersBusy||(user.id===currentUserId&&user.is_admin)?'disabled':''}>${user.is_admin?'撤销管理员':'设为管理员'}</button></div>${user.id===currentUserId?'<p class="field-help">当前账号的管理员权限须由其他管理员撤销。</p>':''}</article>`).join('')||'<p class="field-help">没有符合条件的账号</p>';
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
 function fillMetadata(user){
  metadataUser=user;
  $('#users-metadata-name').textContent=user.nickname||'未设置称呼';
  $('#users-metadata-id').textContent=user.id;
  $('#users-metadata-form').elements.manual_qq.value=user.manual_qq;
  $('#users-metadata-form').elements.note.value=user.note;
  $('#users-metadata-error').textContent='';
 }
 async function metadataAction(work){
  if(metadataBusy)return;metadataBusy=true;$('#users-metadata-error').textContent='';
  for(const field of $('#users-metadata-form').elements)field.disabled=true;
  try{await work();}catch(problem){$('#users-metadata-error').textContent=problem.message;}
  finally{metadataBusy=false;for(const field of $('#users-metadata-form').elements)field.disabled=false;}
 }
 $('#users-metadata').addEventListener('cancel',e=>{if(metadataBusy)e.preventDefault();});
 $('#users-metadata-cancel').addEventListener('click',()=>{if(!metadataBusy)$('#users-metadata').close();});
 $('#users-metadata-reload').addEventListener('click',()=>metadataAction(async()=>{
  const info=await request('/api/admin/users?'+new URLSearchParams({search:metadataUser.id}));
  const user=info.users.find(item=>item.id===metadataUser.id);
  if(!user)throw new Error('账号不存在或已注销');
  fillMetadata(user);
 }));
 $('#users-metadata-form').addEventListener('submit',e=>{
  e.preventDefault();
  const fields=e.currentTarget.elements;
  const data={user_id:metadataUser.id,note:fields.note.value,manual_qq:fields.manual_qq.value,base_revision:metadataUser.metadata_revision};
  metadataAction(async()=>{
   await request('/api/admin/users/metadata',data);
   $('#users-metadata').close();$('#users-saved').textContent='已保存内部备注与手动 QQ 关联';
   await usersAction(loadUsers);
  });
 });
 $('#admin-users').addEventListener('click',e=>{
  const edit=e.target.closest('[data-user-metadata]');
  if(edit&&!usersBusy){
   const user=usersInfo.users.find(item=>item.id===edit.dataset.userMetadata);if(!user)return;
   fillMetadata(user);$('#users-metadata').showModal();return;
  }
  const button=e.target.closest('[data-admin-user]');if(!button||usersBusy)return;
  const user=usersInfo.users.find(item=>item.id===button.dataset.adminUser);if(!user)return;
  pendingUser=user;
  $('#users-confirm-name').textContent=user.nickname||'未设置称呼';$('#users-confirm-id').textContent=user.id;
  $('#users-confirm-effect').textContent=user.is_admin?'撤销后，该账号无法继续使用管理后台或协助编辑其他人的活动。':'该账号将能管理全部后台设置及用户权限，并协助编辑有权查看的已发布活动安排。';
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
 const botLabels={enabled:'主动通知',replies_enabled:'指令回复',dry_run:'发送模式',broadcast_kinds:'通知事件',schedule_enabled:'定时提醒',deadline_hours:'截止提醒时间',estimated_over_delay_minutes:'预计结束提醒时间',quiet_enabled:'勿扰开关',quiet_start:'勿扰开始',quiet_end:'勿扰结束',timezone:'勿扰时区',min_interval_seconds:'发送间隔',templates:'消息模板',groups:'群组设置'};
 const groupReasons={group_not_allowed:'此群未允许指令回复',replies_disabled:'全局指令回复已关闭',dry_run:'模拟模式，未实际发送',duplicate:'重复事件，已去重',bot_author:'来自机器人，已忽略'};
 function rememberGroups(){
  for(const row of $('#bot-groups').querySelectorAll('[data-group-row]')){
   const item=botGroups.find(group=>group.id===row.dataset.groupRow);if(!item)continue;
   item.name=row.querySelector('[data-group-name]').value;
   item.replies=row.querySelector('[data-group-replies]').checked;
   item.broadcast=row.querySelector('[data-group-broadcast]').checked;
  }
 }
 function groupDiagnostics(status){
  $('#bot-group-ignores').innerHTML=status.ignores.map(item=>{const group=botGroups.find(g=>g.id===item.group_id);return `<p><strong translate="no">${esc(group?.name||group?.reference||item.group_id)}</strong> · ${esc(new Date(item.created_at).toLocaleString())}<br>${esc(groupReasons[item.reason]||item.reason)}</p>`;}).join('')||'<p class="field-help">暂无记录。可在测试群里 @ 一次，再刷新查看。</p>';
 }
 function renderGroups(){
  $('#bot-groups').innerHTML=botGroups.map(group=>`<article class="bot-group" data-group-row="${esc(group.id)}"><div class="bot-group-heading"><strong>${group.deployment_default?'原部署默认群':group.last_seen?'已发现的群':'手动配置的群'}</strong><span class="field-help">${group.membership==='removed'?'机器人已被移出':group.last_seen?'最近收到事件 '+esc(new Date(group.last_seen).toLocaleString()):'尚未收到群事件'}</span></div><label class="field">管理备注<input data-group-name value="${esc(group.name)}" maxlength="60" placeholder="例如：正式群、测试群" translate="no"></label><p class="field-help">日志对应标识：<code translate="no">${esc(group.reference||group.id)}</code></p><div class="bot-group-options"><label class="check-option"><input type="checkbox" data-group-replies ${group.replies?'checked':''}>允许此群 @ 回复</label><label class="check-option"><input type="radio" name="bot_broadcast_target" data-group-broadcast value="${esc(group.id)}" ${group.broadcast?'checked':''}>主动通知目标</label></div><details><summary>查看群标识</summary><p class="receipt-id" translate="no">${esc(group.id)}</p><button type="button" class="button secondary" data-group-clear="${esc(group.id)}">停用并清除此群配置</button><p class="field-help">保存后停用回复、取消此群通知目标并清空备注；发现记录仍保留。</p></details></article>`).join('')||'<p class="field-help">尚未发现群。在群里 @ 机器人一次，再点击刷新；新群须明确勾选并保存才会启用。</p>';
  botForm.querySelector('[name="bot_broadcast_target"][value=""]').checked=!botGroups.some(group=>group.broadcast);
 }
 function refreshGroups(info){
  rememberGroups();const status=info.group_status;
  for(const observed of status.groups){const existing=botGroups.find(group=>group.id===observed.id);if(existing)Object.assign(existing,{last_seen:observed.last_seen,membership:observed.membership,reference:observed.reference});else botGroups.push({...observed,replies:false,broadcast:false});}
  renderGroups();groupDiagnostics(status);
 }
 function botStatus(info){
  const runtime=info.runtime;
  const loaded=runtime.applied_revision===null?'机器人尚未回报配置状态':`机器人已载入第 ${runtime.applied_revision} 版`;
  const updated=info.revision!==botInfo?.revision?'；有新版配置，请重新载入':'';
  $('#bot-runtime').textContent=`当前配置第 ${info.revision} 版；${loaded}${runtime.checked_at?'；回报时间 '+new Date(runtime.checked_at).toLocaleString():''}${updated}`;
 }
function templateState(){
 const rich=Object.hasOwn(botTemplates,templateKind+botInfo.markdown_suffix);
 $('#bot-template-state').textContent=(Object.hasOwn(botTemplates,templateKind)?'纯文字：自定义模板':'纯文字：默认模板')
  +' · '+(rich?'Markdown：自定义模板':'Markdown：系统自动生成卡片');
}
function hidePreview(){
 previewData=null;$('#bot-preview-modes').hidden=true;
 $('#bot-preview-text').hidden=true;$('#bot-preview-render').hidden=true;
}
function rememberTemplate(){
 if(!templateKind)return;
 const text=$('#bot-template-text').value;
 if(text===botInfo.default_template)delete botTemplates[templateKind];else botTemplates[templateKind]=text;
 const rich=$('#bot-template-markdown').value;
 const key=templateKind+botInfo.markdown_suffix;
 if(!rich.trim())delete botTemplates[key];else botTemplates[key]=rich;
}
function showTemplate(){
 templateKind=$('#bot-template-kind').value;
 $('#bot-template-text').value=botTemplates[templateKind]??botInfo.default_template;
 $('#bot-template-markdown').value=botTemplates[templateKind+botInfo.markdown_suffix]||'';
 hidePreview();templateState();
}
// A deliberately small, escaped renderer for the QQ Markdown subset used by
// the bot. Everything is HTML-escaped first; links are limited to http(s).
function markdownToHtml(source){
 const inline=raw=>{
  let out=esc(raw);
  out=out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,(all,label,url)=>{
   let parsed;try{parsed=new URL(url);}catch{return label;}
   if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')return label;
   return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\u200B/g,'');
 };
 let html='',list='';
 const close=()=>{if(list){html+='</'+list+'>';list='';}};
 for(const line of String(source||'').split('\n')){
  const bare=line.replace(/\u200B/g,'').trim();
  if(!bare){close();html+='<p class="bot-md-gap"></p>';continue;}
  if(bare==='***'){close();html+='<hr>';continue;}
  let match=line.match(/^(#{1,6})\s+(.*)$/);
  if(match){close();const level=Math.min(6,match[1].length+2);html+=`<h${level}>${inline(match[2])}</h${level}>`;continue;}
  match=line.match(/^[-*]\s+(.*)$/);
  if(match){if(list!=='ul'){close();html+='<ul>';list='ul';}html+=`<li>${inline(match[1])}</li>`;continue;}
  match=line.match(/^\d+\.\s+(.*)$/);
  if(match){if(list!=='ol'){close();html+='<ol>';list='ol';}html+=`<li>${inline(match[1])}</li>`;continue;}
  match=line.match(/^>\s+(.*)$/);
  if(match){close();html+=`<blockquote>${inline(match[1])}</blockquote>`;continue;}
  close();html+=`<p>${inline(line)}</p>`;
 }
 close();return html;
}
function showPreview(){
 if(!previewData)return;
 const mode=botForm.querySelector('[name="bot-preview-mode"]:checked').value;
 const textEl=$('#bot-preview-text'),renderEl=$('#bot-preview-render');
 if(mode==='render'){
  textEl.hidden=true;renderEl.hidden=false;
  renderEl.innerHTML=previewData.markdown?markdownToHtml(previewData.markdown)
   :'<p class="field-help">此事件没有可送出的 Markdown 内容；投遞时会退回纯文字。</p>';
 }else{
  renderEl.hidden=true;textEl.hidden=false;
  textEl.textContent=mode==='source'?(previewData.markdown||'（无 Markdown 内容）'):previewData.text;
 }
}
 function botSetup(info){
  botInfo=info;botTemplates={...info.config.templates};templateKind='';
  botGroups=info.group_status.groups.map(group=>({...group}));renderGroups();groupDiagnostics(info.group_status);
  $('#bot-group-mode').textContent=info.group_status.inherited?'当前沿用原部署默认群；保存后改由本页管理群组。':'当前由本页管理群组，保存后即时生效。';
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
   if(key==='groups'){rememberGroups();config[key]=botGroups.filter(group=>group.name||group.replies||group.broadcast||group.manual||group.configured).map(({id,name,replies,broadcast})=>({id,name,replies,broadcast}));continue;}
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
$('#bot-groups-refresh').addEventListener('click',()=>botAction(async()=>{const info=await request('/api/admin/bot-settings');botStatus(info);refreshGroups(info);$('#bot-saved').textContent='已刷新群组与诊断，保留未保存的修改。';}));
$('#bot-group-add').addEventListener('click',()=>{const field=$('#bot-group-id');const id=field.value.trim();if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)){$('#bot-error').textContent='请输入 QQ 事件中的有效群标识，不是 QQ 群号。';return;}rememberGroups();const existing=botGroups.find(group=>group.id===id);if(existing)existing.manual=true;else botGroups.push({id,name:'',replies:false,broadcast:false,manual:true,membership:'unknown'});renderGroups();field.value='';$('#bot-error').textContent='';});
$('#bot-groups').addEventListener('click',event=>{const button=event.target.closest('[data-group-clear]');if(!button)return;rememberGroups();const group=botGroups.find(item=>item.id===button.dataset.groupClear);if(group)Object.assign(group,{name:'',replies:false,broadcast:false,manual:false,configured:false});renderGroups();});
$('#bot-template-text').addEventListener('focus',()=>{lastTemplateField='#bot-template-text';});
$('#bot-template-markdown').addEventListener('focus',()=>{lastTemplateField='#bot-template-markdown';});
$('#bot-template-text').addEventListener('input',()=>{rememberTemplate();templateState();hidePreview();});
$('#bot-template-markdown').addEventListener('input',()=>{rememberTemplate();templateState();hidePreview();});
$('#bot-template-reset').addEventListener('click',()=>{delete botTemplates[templateKind];showTemplate();});
$('#bot-template-md-example').addEventListener('click',()=>{const field=$('#bot-template-markdown');field.value=botInfo.default_markdown_template;field.focus();rememberTemplate();templateState();hidePreview();});
$('#bot-template-md-reset').addEventListener('click',()=>{$('#bot-template-markdown').value='';rememberTemplate();templateState();hidePreview();});
$('#bot-template-variables').addEventListener('click',e=>{const button=e.target.closest('[data-variable]');if(!button)return;const field=$(lastTemplateField);field.focus();field.setRangeText('{'+button.dataset.variable+'}',field.selectionStart,field.selectionEnd,'end');rememberTemplate();templateState();hidePreview();});
$('#bot-preview-modes').addEventListener('change',showPreview);
$('#bot-preview').addEventListener('click',()=>{if(!botForm.reportValidity())return;const config=botDraft();botAction(async()=>{const result=await request('/api/admin/bot-preview',{config,kind:templateKind});previewData=result;$('#bot-preview-modes').hidden=false;showPreview();});});
 botForm.addEventListener('submit',e=>{e.preventDefault();const config=botDraft();botAction(async()=>{const result=await request('/api/admin/bot-settings',{config,base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent='机器人设置已保存，等待机器人回报载入状态。';});});
 $('#bot-reload').addEventListener('click',()=>botAction(async()=>{botSetup(await request('/api/admin/bot-settings'));$('#bot-saved').textContent='已重新载入，未保存的修改已清除。';}));
 $('#bot-revert').addEventListener('click',()=>botAction(async()=>{const result=await request('/api/admin/bot-revert',{base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent='已恢复上一版配置，并保存为新版本。';}));
 setInterval(async()=>{if(!csrf||!botInfo||botBusy||document.hidden)return;try{const info=await request('/api/admin/bot-settings');botStatus(info);if(!$('#bot-groups').contains(document.activeElement))refreshGroups(info);else groupDiagnostics(info.group_status);}catch(problem){if(problem.status===401){csrf='';$('#admin-settings').hidden=true;$('#admin-login').hidden=false;error(problem);}}},10000);
 async function load(){
  try{const info=await request('/api/admin/session');csrf=info.csrf;currentUserId=info.current_user_id;$('#admin-access').textContent=info.auth_method==='account'?'管理员账号登录':'管理凭证登录 · 有效一小时';$('#admin-logout').textContent=info.auth_method==='account'?'退出管理后台及当前账号':'退出管理后台';privacyRequests(info.privacy_requests||[]);revision=info.settings.revision;botSetup(info.bot);$('#allow-name-registration').checked=info.settings.allow_name_registration;$('#admin-login').hidden=true;$('#admin-settings').hidden=false;$('#provider-status').textContent=info.providers.some(p=>p.enabled)?'QQ 登录已配置':'QQ 未配置，关闭称呼注册后将无法注册。';try{await loadUsers();}catch(problem){$('#users-error').textContent=problem.message;}}
  catch(problem){if(problem.status!==401)error(problem);csrf='';$('#admin-login').hidden=false;$('#admin-settings').hidden=true;}
 }
 $('#admin-login').addEventListener('submit',async e=>{e.preventDefault();$('#admin-error').textContent='';const button=e.currentTarget.querySelector('button');button.disabled=true;try{await request('/api/admin/login',{key:e.currentTarget.elements.key.value});e.target.reset();await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 $('#registration-settings').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;$('#admin-error').textContent='';$('#admin-saved').textContent='';try{const result=await request('/api/admin/settings',{allow_name_registration:$('#allow-name-registration').checked,base_revision:revision});revision=result.settings.revision;$('#admin-saved').textContent='注册设置已保存';}catch(problem){error(problem);await load();}finally{button.disabled=false;}});
 $('#admin-logout').addEventListener('click',async()=>{try{await request('/api/admin/logout',{});csrf='';await load();}catch(problem){error(problem);}});
 $('#privacy-requests').addEventListener('submit',async e=>{const form=e.target.closest('[data-privacy-request]');if(!form)return;e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await request('/api/admin/privacy-review',{request_id:form.dataset.privacyRequest,note:form.elements.note.value});await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 load();
})();
