'use strict';
(()=>{
 const $=s=>document.querySelector(s);let csrf='',revision=0;
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
 async function load(){
  try{const info=await request('/api/admin/session');csrf=info.csrf;privacyRequests(info.privacy_requests||[]);revision=info.settings.revision;$('#allow-name-registration').checked=info.settings.allow_name_registration;$('#admin-login').hidden=true;$('#admin-settings').hidden=false;$('#provider-status').textContent=info.providers.some(p=>p.enabled)?"已配置第三方登錄：QQ。平臺是否開通以實際授權結果為準。":"第三方登錄尚未配置；關閉免第三方註冊後，訪客無法建立帳號。";}
  catch(problem){if(problem.status!==401)error(problem);csrf='';$('#admin-login').hidden=false;$('#admin-settings').hidden=true;}
 }
 $('#admin-login').addEventListener('submit',async e=>{e.preventDefault();$('#admin-error').textContent='';const button=e.currentTarget.querySelector('button');button.disabled=true;try{await request('/api/admin/login',{key:e.currentTarget.elements.key.value});e.target.reset();await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 $('#registration-settings').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;$('#admin-error').textContent='';$('#admin-saved').textContent='';try{const result=await request('/api/admin/settings',{allow_name_registration:$('#allow-name-registration').checked,base_revision:revision});revision=result.settings.revision;$('#admin-saved').textContent="註冊設置已保存";}catch(problem){error(problem);await load();}finally{button.disabled=false;}});
 $('#admin-logout').addEventListener('click',async()=>{try{await request('/api/admin/logout',{});csrf='';await load();}catch(problem){error(problem);}});
 $('#privacy-requests').addEventListener('submit',async e=>{const form=e.target.closest('[data-privacy-request]');if(!form)return;e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await request('/api/admin/privacy-review',{request_id:form.dataset.privacyRequest,note:form.elements.note.value});await load();}catch(problem){error(problem);}finally{button.disabled=false;}});
 load();
})();
