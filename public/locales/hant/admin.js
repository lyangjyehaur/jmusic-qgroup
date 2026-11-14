'use strict';
 (()=>{
 const $=s=>document.querySelector(s);let csrf='',revision=0,botInfo=null,botTemplates={},templateKind='',botBusy=false;
 let previewData=null,lastTemplateField='#bot-template-text';
 let currentUserId=null,usersInfo=null,usersSearch='',usersFilter='all',usersOffset=0,usersBusy=false,pendingUser=null,metadataUser=null,metadataBusy=false;
 let botGroups=[];
 let musicInfo=null,musicMember=null,musicBusy=false,musicDialogBusy=false;
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
 const musicStatuses={unlinked:"未關聯",prelinked:"管理員預先對應",oauth:"已完成 QQ 授權"};
 function renderMusic(){
  if(!musicInfo)return;
  const fields=$('#music-links-search').elements,search=fields.search.value.trim().toLowerCase(),status=fields.status.value;
  const rows=musicInfo.members.filter(m=>(status==='all'||status===m.status)&&[m.qq,m.name,m.user_id,m.board_name].some(value=>String(value).toLowerCase().includes(search)));
  $('#music-links-summary').textContent=`共 ${musicInfo.members.length} 位成分會員，${musicInfo.members.filter(m=>m.user_id).length} 位已關聯；顯示 ${rows.length} 位`;
  $('#music-links-list').innerHTML=rows.map(m=>`<article class="admin-user"><div class="admin-user-heading"><strong translate="no">${esc(m.name||m.qq)}</strong><span class="admin-user-role">${esc(musicStatuses[m.status])}</span></div><p class="field-help">成分 QQ 號：<span translate="no">${esc(m.qq)}</span></p><p class="field-help">看板帳號：<span translate="no">${esc(m.user_id?(m.board_name||'—'):'—')}</span>${m.user_id&&!m.board_active?" · 帳號不存在或已註銷":''}</p>${m.user_id?`<p class="receipt-id" translate="no">${esc(m.user_id)}</p>`:''}${!m.has_pin&&!m.user_id?"<p class=\"field-help\">沒有舊口令，須由管理員核對後建立關聯。</p>":''}<button type="button" class="button secondary" data-music-qq="${esc(m.qq)}" ${musicBusy?'disabled':''}>${m.user_id?"修改或解除關聯":"建立關聯"}</button></article>`).join('')||"<p class=\"field-help\">沒有符合條件的成分會員</p>";
  $('#music-links-history').innerHTML=musicInfo.history.map(item=>`<p class="field-help"><span translate="no">${esc(item.qq)}</span>：<span translate="no">${esc(item.before_user_id||'—')}</span> → <span translate="no">${esc(item.after_user_id||'—')}</span><br><span translate="no">${esc(item.actor_name)}</span> · ${esc(new Date(item.created*1000).toLocaleString())}</p>`).join('')||"<p class=\"field-help\">暫無關聯變更記錄</p>";
 }
 async function loadMusic(){musicInfo=await request('/api/admin/music-links');renderMusic();}
 async function musicAction(work){
  if(musicBusy)return;musicBusy=true;$('#music-links-error').textContent='';
  for(const field of $('#music-links-search').elements)field.disabled=true;
  renderMusic();
  try{await work();}catch(problem){$('#music-links-error').textContent=problem.message;if(problem.status===401)await load();}
  finally{musicBusy=false;for(const field of $('#music-links-search').elements)field.disabled=false;renderMusic();}
 }
 function fillMusic(member){
  musicMember=member;$('#music-link-form').reset();
  $('#music-link-member').textContent=`${member.name||'—'} · QQ ${member.qq}`;
  $('#music-link-current').textContent=member.user_id?`${member.board_name||'—'} · ${member.user_id}`:'—';
  $('#music-link-form').elements.user_id.innerHTML="<option value=\"\">請先查找並選擇帳號</option>";
  $('#music-link-error').textContent='';$('#music-link-unlink').hidden=!member.user_id;
 }
 async function musicDialogAction(work){
  if(musicDialogBusy)return;musicDialogBusy=true;$('#music-link-error').textContent='';
  for(const field of $('#music-link-form').elements)field.disabled=true;
  try{await work();}catch(problem){$('#music-link-error').textContent=problem.message;if(problem.status===401){$('#music-link-dialog').close();await load();}}
  finally{musicDialogBusy=false;for(const field of $('#music-link-form').elements)field.disabled=false;}
 }
 async function saveMusic(userId){
  await request('/api/admin/music-links',{qq:musicMember.qq,user_id:userId,base_revision:musicMember.revision});
  $('#music-link-dialog').close();$('#music-links-saved').textContent=userId?"成分站關聯已保存":"成分站關聯已解除，原成分資料保留";
  await musicAction(loadMusic);
 }
 $('#music-links-search').addEventListener('submit',e=>{e.preventDefault();renderMusic();});
 $('#music-links-reload').addEventListener('click',()=>musicAction(loadMusic));
 $('#music-links-list').addEventListener('click',e=>{
  const button=e.target.closest('[data-music-qq]');if(!button||musicBusy)return;
  const member=musicInfo.members.find(m=>m.qq===button.dataset.musicQq);if(!member)return;
  fillMusic(member);$('#music-link-dialog').showModal();
 });
 $('#music-link-dialog').addEventListener('cancel',e=>{if(musicDialogBusy)e.preventDefault();});
 $('#music-link-cancel').addEventListener('click',()=>{if(!musicDialogBusy)$('#music-link-dialog').close();});
 $('#music-link-find').addEventListener('click',()=>{
  const search=$('#music-link-form').elements.search.value.trim();
  if(!search){$('#music-link-error').textContent="請輸入看板稱呼或帳號 ID";return;}
  musicDialogAction(async()=>{
   const result=await request('/api/admin/users?'+new URLSearchParams({search}));
   $('#music-link-form').elements.user_id.innerHTML="<option value=\"\">請選擇核對後的帳號</option>"+result.users.map(u=>`<option value="${esc(u.id)}">${esc(u.nickname||'—')} · ${esc(u.id)}</option>`).join('');
   if(!result.users.length)throw new Error("沒有符合條件的帳號");
  });
 });
 $('#music-link-refresh').addEventListener('click',()=>musicDialogAction(async()=>{await loadMusic();const member=musicInfo.members.find(m=>m.qq===musicMember.qq);if(!member)throw new Error("成分會員不存在");fillMusic(member);}));
 $('#music-link-form').addEventListener('submit',e=>{e.preventDefault();const uid=e.currentTarget.elements.user_id.value;if(uid)musicDialogAction(()=>saveMusic(uid));});
 $('#music-link-unlink').addEventListener('click',()=>{const confirmed=$('#music-link-form').elements.confirmed;if(!confirmed.reportValidity())return;musicDialogAction(()=>saveMusic(''));});
 function renderUsers(){
  const info=usersInfo;
  $('#users-summary').textContent=`共 ${info.total} 個帳號`;
  $('#users-page').textContent=info.total?`${Math.floor(info.offset/info.limit)+1} / ${Math.ceil(info.total/info.limit)}`:'0 / 0';
  $('#users-prev').disabled=usersBusy||info.offset===0;$('#users-next').disabled=usersBusy||info.offset+info.limit>=info.total;
  $('#admin-users').innerHTML=info.users.map(user=>`<article class="admin-user"><div class="admin-user-heading"><strong>${esc(user.nickname||"未設置稱呼")}</strong><span class="admin-user-role">${user.is_admin?"管理員":"普通用戶"}${user.id===currentUserId?" · 當前帳號":''}</span></div><p class="receipt-id" translate="no">${esc(user.id)}</p><p class="field-help">${user.identities.length?user.identities.map(item=>`${esc(item.provider==='qq'?"QQ 綁定暱稱":item.provider)}：<span translate="no">${esc(item.display_name)}</span>${item.provider==='qq'?` · UnionID：${item.unionid_bound?"已取得":"待補齊"}`:''}`).join('；'):"未綁定第三方帳號"}${user.identities.some(item=>item.provider==='qq')?'':" · UnionID：未綁定 QQ"}</p><p class="field-help">手動關聯 QQ 號：<span translate="no">${esc(user.manual_qq||"未填寫")}</span></p>${user.note?`<p class="field-help admin-user-note">內部備註：<span translate="no">${esc(user.note)}</span></p>`:''}<p class="field-help">註冊時間：${esc(new Date(user.created_at).toLocaleString())}</p><div class="bot-actions"><button type="button" class="button secondary" data-user-metadata="${esc(user.id)}" ${usersBusy?'disabled':''}>編輯備註與 QQ 號</button><button type="button" class="button secondary" data-admin-user="${esc(user.id)}" ${usersBusy||(user.id===currentUserId&&user.is_admin)?'disabled':''}>${user.is_admin?"撤銷管理員":"設為管理員"}</button></div>${user.id===currentUserId?"<p class=\"field-help\">當前帳號的管理員權限須由其他管理員撤銷。</p>":''}</article>`).join('')||"<p class=\"field-help\">沒有符合條件的帳號</p>";
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
  $('#users-metadata-name').textContent=user.nickname||"未設置稱呼";
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
  if(!user)throw new Error("帳號不存在或已註銷");
  fillMetadata(user);
 }));
 $('#users-metadata-form').addEventListener('submit',e=>{
  e.preventDefault();
  const fields=e.currentTarget.elements;
  const data={user_id:metadataUser.id,note:fields.note.value,manual_qq:fields.manual_qq.value,base_revision:metadataUser.metadata_revision};
  metadataAction(async()=>{
   await request('/api/admin/users/metadata',data);
   $('#users-metadata').close();$('#users-saved').textContent="已保存內部備註與手動 QQ 關聯";
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
  $('#users-confirm-name').textContent=user.nickname||"未設置稱呼";$('#users-confirm-id').textContent=user.id;
  $('#users-confirm-effect').textContent=user.is_admin?"撤銷後，該帳號無法繼續使用管理後臺或協助編輯其他人的活動。":"該帳號將能管理全部後臺設置及用戶權限，並協助編輯有權查看的已發佈活動安排。";
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
 const botLabels={enabled:"主動通知",replies_enabled:"指令回覆",dry_run:"發送模式",broadcast_kinds:"通知事件",schedule_enabled:"定時提醒",deadline_hours:"截止提醒時間",estimated_over_delay_minutes:"預計結束提醒時間",quiet_enabled:"勿擾開關",quiet_start:"勿擾開始",quiet_end:"勿擾結束",timezone:"勿擾時區",min_interval_seconds:"發送間隔",templates:"消息模板",groups:"群組設置"};
 const groupReasons={group_not_allowed:"此群未允許指令回覆",replies_disabled:"全局指令回覆已關閉",dry_run:"模擬模式，未實際發送",duplicate:"重複事件，已去重",bot_author:"來自機器人，已忽略"};
 function rememberGroups(){
  for(const row of $('#bot-groups').querySelectorAll('[data-group-row]')){
   const item=botGroups.find(group=>group.id===row.dataset.groupRow);if(!item)continue;
   item.name=row.querySelector('[data-group-name]').value;
   item.replies=row.querySelector('[data-group-replies]').checked;
   item.broadcast=row.querySelector('[data-group-broadcast]').checked;
  }
 }
 function groupDiagnostics(status){
  $('#bot-group-ignores').innerHTML=status.ignores.map(item=>{const group=botGroups.find(g=>g.id===item.group_id);return `<p><strong translate="no">${esc(group?.name||group?.reference||item.group_id)}</strong> · ${esc(new Date(item.created_at).toLocaleString())}<br>${esc(groupReasons[item.reason]||item.reason)}</p>`;}).join('')||"<p class=\"field-help\">暫無記錄。可在測試群裡 @ 一次，再刷新查看。</p>";
 }
 function renderGroups(){
  $('#bot-groups').innerHTML=botGroups.map(group=>`<article class="bot-group" data-group-row="${esc(group.id)}"><div class="bot-group-heading"><strong>${group.deployment_default?"原部署默認群":group.last_seen?"已發現的群":"手動配置的群"}</strong><span class="field-help">${group.membership==='removed'?"機器人已被移出":group.last_seen?"最近收到事件 "+esc(new Date(group.last_seen).toLocaleString()):"尚未收到群事件"}</span></div><label class="field">管理備註<input data-group-name value="${esc(group.name)}" maxlength="60" placeholder="例如：正式群、測試群" translate="no"></label><p class="field-help">日誌對應標識：<code translate="no">${esc(group.reference||group.id)}</code></p><div class="bot-group-options"><label class="check-option"><input type="checkbox" data-group-replies ${group.replies?'checked':''}>允許此群 @ 回覆</label><label class="check-option"><input type="radio" name="bot_broadcast_target" data-group-broadcast value="${esc(group.id)}" ${group.broadcast?'checked':''}>主動通知目標</label></div><details><summary>查看群標識</summary><p class="receipt-id" translate="no">${esc(group.id)}</p><button type="button" class="button secondary" data-group-clear="${esc(group.id)}">停用並清除此群配置</button><p class="field-help">保存後停用回覆、取消此群通知目標並清空備註；發現記錄仍保留。</p></details></article>`).join('')||"<p class=\"field-help\">尚未發現群。在群裡 @ 機器人一次，再點擊刷新；新群須明確勾選並保存才會啟用。</p>";
  botForm.querySelector('[name="bot_broadcast_target"][value=""]').checked=!botGroups.some(group=>group.broadcast);
 }
 function refreshGroups(info){
  rememberGroups();const status=info.group_status;
  for(const observed of status.groups){const existing=botGroups.find(group=>group.id===observed.id);if(existing)Object.assign(existing,{last_seen:observed.last_seen,membership:observed.membership,reference:observed.reference});else botGroups.push({...observed,replies:false,broadcast:false});}
  renderGroups();groupDiagnostics(status);
 }
 function botStatus(info){
  const runtime=info.runtime;
  const loaded=runtime.applied_revision===null?"機器人尚未回報配置狀態":`機器人已載入第 ${runtime.applied_revision} 版`;
  const updated=info.revision!==botInfo?.revision?"；有新版配置，請重新載入":'';
  $('#bot-runtime').textContent=`當前配置第 ${info.revision} 版；${loaded}${runtime.checked_at?"；回報時間 "+new Date(runtime.checked_at).toLocaleString():''}${updated}`;
 }
function templateState(){
 const rich=Object.hasOwn(botTemplates,templateKind+botInfo.markdown_suffix);
 $('#bot-template-state').textContent=(Object.hasOwn(botTemplates,templateKind)?"純文字：自定義模板":"純文字：默認模板")
  +' · '+(rich?"Markdown：自定義模板":"Markdown：系統自動生成卡片");
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
   :"<p class=\"field-help\">此事件沒有可送出的 Markdown 內容；投遞時會退回純文字。</p>";
 }else{
  renderEl.hidden=true;textEl.hidden=false;
  textEl.textContent=mode==='source'?(previewData.markdown||"（無 Markdown 內容）"):previewData.text;
 }
}
 function botSetup(info){
  botInfo=info;botTemplates={...info.config.templates};templateKind='';
  botGroups=info.group_status.groups.map(group=>({...group}));renderGroups();groupDiagnostics(info.group_status);
  $('#bot-group-mode').textContent=info.group_status.inherited?"當前沿用原部署默認群；保存後改由本頁管理群組。":"當前由本頁管理群組，保存後即時生效。";
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
$('#bot-groups-refresh').addEventListener('click',()=>botAction(async()=>{const info=await request('/api/admin/bot-settings');botStatus(info);refreshGroups(info);$('#bot-saved').textContent="已刷新群組與診斷，保留未保存的修改。";}));
$('#bot-group-add').addEventListener('click',()=>{const field=$('#bot-group-id');const id=field.value.trim();if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)){$('#bot-error').textContent="請輸入 QQ 事件中的有效群標識，不是 QQ 群號。";return;}rememberGroups();const existing=botGroups.find(group=>group.id===id);if(existing)existing.manual=true;else botGroups.push({id,name:'',replies:false,broadcast:false,manual:true,membership:'unknown'});renderGroups();field.value='';$('#bot-error').textContent='';});
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
 botForm.addEventListener('submit',e=>{e.preventDefault();const config=botDraft();botAction(async()=>{const result=await request('/api/admin/bot-settings',{config,base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent="機器人設置已保存，等待機器人回報載入狀態。";});});
 $('#bot-reload').addEventListener('click',()=>botAction(async()=>{botSetup(await request('/api/admin/bot-settings'));$('#bot-saved').textContent="已重新載入，未保存的修改已清除。";}));
 $('#bot-revert').addEventListener('click',()=>botAction(async()=>{const result=await request('/api/admin/bot-revert',{base_revision:botInfo.revision});botSetup(result.bot);$('#bot-saved').textContent="已恢復上一版配置，並保存為新版本。";}));
 setInterval(async()=>{if(!csrf||!botInfo||botBusy||document.hidden)return;try{const info=await request('/api/admin/bot-settings');botStatus(info);if(!$('#bot-groups').contains(document.activeElement))refreshGroups(info);else groupDiagnostics(info.group_status);}catch(problem){if(problem.status===401){csrf='';$('#admin-settings').hidden=true;$('#admin-login').hidden=false;error(problem);}}},10000);
 async function load(){
  try{const info=await request('/api/admin/session');csrf=info.csrf;currentUserId=info.current_user_id;$('#admin-access').textContent=info.auth_method==='account'?"管理員帳號登錄":"管理憑證登錄 · 有效一小時";$('#admin-logout').textContent=info.auth_method==='account'?"退出管理後臺及當前帳號":"退出管理後臺";privacyRequests(info.privacy_requests||[]);revision=info.settings.revision;botSetup(info.bot);$('#allow-name-registration').checked=info.settings.allow_name_registration;$('#admin-login').hidden=true;$('#admin-settings').hidden=false;$('#provider-status').textContent=info.providers.some(p=>p.enabled)?"QQ 登錄已配置":"QQ 未配置，關閉稱呼註冊後將無法註冊。";try{await loadUsers();}catch(problem){$('#users-error').textContent=problem.message;}}
  catch(problem){if(problem.status!==401)error(problem);csrf='';$('#admin-login').hidden=false;$('#admin-settings').hidden=true;return;}
  await musicAction(loadMusic);
 }
 $('#admin-login').addEventListener('submit',async e=>{e.preventDefault();$('#admin-error').textContent='';const button=e.currentTarget.querySelector('button');button.disabled=true;try{await request('/api/admin/login',{key:e.currentTarget.elements.key.value});e.target.reset();await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 $('#registration-settings').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;$('#admin-error').textContent='';$('#admin-saved').textContent='';try{const result=await request('/api/admin/settings',{allow_name_registration:$('#allow-name-registration').checked,base_revision:revision});revision=result.settings.revision;$('#admin-saved').textContent="註冊設置已保存";}catch(problem){error(problem);await load();}finally{button.disabled=false;}});
 $('#admin-logout').addEventListener('click',async()=>{try{await request('/api/admin/logout',{});csrf='';await load();}catch(problem){error(problem);}});
 $('#privacy-requests').addEventListener('submit',async e=>{const form=e.target.closest('[data-privacy-request]');if(!form)return;e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await request('/api/admin/privacy-review',{request_id:form.dataset.privacyRequest,note:form.elements.note.value});await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 load();
})();
