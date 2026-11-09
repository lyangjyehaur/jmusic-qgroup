'use strict';
const BoardDrafts=(()=>{
  const sessions=new Map();let env,closing=null;
  const snapshot=value=>JSON.stringify(value);
  function fields(form) {return [...form.elements].filter(v=>v.name&&v.type!=='file'&&!['submit','button'].includes(v.type)).map(v=>({name:v.name,value:v.value,checked:v.checked}));}
  function fill(form,values) {for(const item of values){const el=[...form.elements].find(v=>v.name===item.name);if(el){if(el.tagName==='SELECT'&&![...el.options].some(v=>v.value===item.value))el.add(new Option("草稿原选项（请核对）",item.value));el.value=item.value;if(el.type==='checkbox'||el.type==='radio')el.checked=item.checked;}}}
  const dirty=s=>snapshot(s.capture())!==s.baseline;
  function status(s,text) {s.status.textContent=text;}
  async function save(s) {
    clearTimeout(s.timer);if(s.choice||!dirty(s))return;
    const data=structuredClone(s.capture()),scope=env.scope();if(!scope||scope!==s.scope)throw new Error("身份已改变，无法保存此表单，请刷新页面");
    const work=()=>BoardStore.put(s.key,{data,at:Date.now()});
    s.queue=(s.queue||Promise.resolve()).catch(()=>{}).then(work);
    await s.queue;status(s,s.warning||"已暂存到本机，尚未发布");
  }
  function touch(id) {
    const s=sessions.get(id);if(!s||s.choice)return;
    clearTimeout(s.timer);status(s,"暂存中…");s.timer=setTimeout(()=>save(s).catch(e=>status(s,e.message)),350);
  }
  async function bind(id,key,capture,restore,busy=()=>false) {
    const old=sessions.get(id);if(old){clearTimeout(old.timer);await old.queue?.catch(()=>{});}
    const dialog=document.getElementById(id),form=dialog.querySelector('form'),scope=env.scope();
    dialog.querySelector('.draft-status')?.remove();
    const box=document.createElement('div');box.className='draft-status';box.setAttribute('aria-live','polite');
    (dialog.querySelector('.form-body')||form).prepend(box);
    const s={id,key:`draft:${scope}:${key}`,scope,capture,restore,busy,baseline:snapshot(capture()),status:box,form,choice:false};sessions.set(id,s);
    const stored=await BoardStore.get(s.key);if(sessions.get(id)!==s)return;
    if(!stored){status(s,'');return;}
    s.choice=true;box.innerHTML="<span>此表单有本机草稿。</span> <button type=\"button\" class=\"text-button\" data-draft=\"restore\">恢复</button> <button type=\"button\" class=\"text-button\" data-draft=\"discard\">舍弃草稿</button>";
    box.querySelector('[data-draft=restore]').onclick=()=>{
      s.warning=restore(stored.data)||'';s.choice=false;status(s,"已恢复本机草稿；请核对最新安排，再重新预览／发布");touch(id);
    };
    box.querySelector('[data-draft=discard]').onclick=async()=>{
      try{await BoardStore.remove(s.key);s.choice=false;status(s,"旧草稿已舍弃");if(dirty(s))touch(id);}catch(e){env.toast(e.message);}
    };
  }
  async function detach(id) {
    const s=sessions.get(id);if(!s)return;
    clearTimeout(s.timer);if(document.getElementById(id).open)await save(s);
    await s.queue?.catch(()=>{});sessions.delete(id);
  }
  async function clear(id) {
    const s=sessions.get(id);if(!s)return;clearTimeout(s.timer);await s.queue?.catch(()=>{});await BoardStore.remove(s.key);sessions.delete(id);s.status.remove();
  }
  async function markCreated(intent,result) {
    const warning="原活动已创建；请保留需要的文字，载入该活动最新版后再编辑";
    // Keep edits made after the uncertain submission, but attach them to the created event.
    for(const s of sessions.values())if(s.id==='event-form-dialog'&&document.getElementById(s.id).open&&s.capture().dataset?.intent===intent)await save(s);
    for(const row of await BoardStore.list(`draft:${env.scope()}:`)) {
      if(row.data?.dataset?.intent!==intent)continue;
      const data=structuredClone(row.data);const id=data.fields.find(v=>v.name==='id');if(id)id.value=result.id;
      data.dataset.revision='-1';data.dataset.lifecycle=result.lifecycle;
      await BoardStore.put(row.key,{...row,data});
      for(const s of sessions.values())if(s.key===row.key&&document.getElementById(s.id).open){s.restore(data);s.warning=warning;status(s,warning);}
    }
  }
  async function close(dialog) {
    if(dialog.inert||dialog.querySelector('form[inert]')){env.toast("正在提交，请稍候");return false;}
    const s=sessions.get(dialog.id);
    if(s?.busy()){env.toast("图片仍在处理中，请稍候");return false;}
    if(!s||!dirty(s)){dialog.close();return true;}
    closing={dialog,s};env.showDialog('draft-close-dialog');return false;
  }
  function ready(id) {const s=sessions.get(id);if(s?.warning){env.toast(s.warning);return false;}if(s?.choice){env.toast("请先恢复或舍弃已有的本机草稿");return false;}return true;}
  function init(options) {
    env=options;
    document.addEventListener('input',e=>{if(!e.target.matches('[data-advanced-toggle]'))touch(e.target.closest('dialog')?.id);});
    document.addEventListener('change',e=>{if(e.target.matches('[data-advanced-toggle]'))return;const id=e.target.closest('dialog')?.id;touch(id);const s=sessions.get(id);if(s)save(s).catch(e=>status(s,e.message));});
    document.addEventListener('submit',e=>{const id=e.target.closest('dialog')?.id;if(!ready(id)){e.preventDefault();e.stopImmediatePropagation();}},true);
    window.addEventListener('beforeunload',e=>{if([...sessions.values()].some(s=>document.getElementById(s.id).open&&dirty(s))){for(const s of sessions.values())if(document.getElementById(s.id).open)save(s).catch(e=>status(s,e.message));e.preventDefault();e.returnValue='';}});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')for(const s of sessions.values())if(document.getElementById(s.id).open)save(s).catch(e=>status(s,e.message));});
    document.getElementById('draft-save-close').onclick=async()=>{
      const current=closing;if(!current)return;
      try{if(current.s.choice)throw new Error("请先恢复或舍弃旧草稿");await save(current.s);document.getElementById('draft-close-dialog').close();current.dialog.close();closing=null;}catch(e){env.toast(e.message);}
    };
    document.getElementById('draft-discard-close').onclick=async()=>{
      const current=closing;if(!current)return;
      try{await clear(current.dialog.id);document.getElementById('draft-close-dialog').close();current.dialog.close();closing=null;}catch(e){env.toast(e.message);}
    };
  }
  const isDirty=id=>{const s=sessions.get(id);return !!s&&dirty(s);};
  return {init,bind,detach,clear,touch,close,ready,fields,fill,isDirty,markCreated};
})();
// Display-only switches. Never reset inputs, saved rules, bills or permissions.
const BoardAdvanced=(()=>{
  function set(scope,on=false) {
    if(!scope)return;
    scope.dataset.advanced=String(!!on);
    for(const input of scope.querySelectorAll('[data-advanced-toggle]'))input.checked=!!on;
  }
  function control() {
    return "<label class=\"advanced-switch\"><span>高级选项</span><input type=\"checkbox\" role=\"switch\" data-advanced-toggle><span class=\"switch-track\" aria-hidden=\"true\"></span></label>";
  }
  function init() {
    document.addEventListener('change',event=>{if(event.target.matches('[data-advanced-toggle]'))set(event.target.closest('[data-advanced-scope]'),event.target.checked);});
    document.addEventListener('invalid',event=>{
      if(!event.target.closest('[data-advanced-only]'))return;
      set(event.target.closest('[data-advanced-scope]'),true);
      let parent=event.target.parentElement;
      while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}
    },true);
  }
  return {set,control,init};
})();
function boardTodos(events) {
  const rows=[];const add=(e,label,kind='detail')=>rows.push({eventId:e.id,title:e.title,label,kind});
  for(const e of events) {
    const active=!['ended','cancelled','draft'].includes(e.lifecycle)&&!e.archived_at;
    if(e.my_attendees?.some(p=>p.can_respond&&p.confirmation_state!=='accepted'))add(e,"确认变更后的安排",'conditions');
    if(e.claim_invitations?.some(c=>c.can_decide))add(e,"核对报名认领");
    if(e.can_manage_roster&&e.participants?.some(p=>p.withdrawal_requested))add(e,"处理退出申请");
    if(active&&e.is_owner&&e.minimum_participants&&e.formation_state!=='confirmed'&&(e.minimum_met||new Date(e.deadline)<=new Date()))add(e,"决定是否成团");
    if(e.can_finish&&e.estimated_over)add(e,"确认活动结束／延长");
    if(e.can_settle&&!e.settlement&&!e.archived_at)add(e,"核对并发布结算",'settle');
    if(e.finance?.can_manage&&e.finance.pending_count)add(e,`${e.finance.pending_count} 笔款项申报待核对`,'finance');
    if(e.finance?.my_outstanding_cents>0)add(e,"我的款项待补",'finance');
    if(e.finance?.my_refund_due_cents>0)add(e,"我的退款／垫付待收回",'finance');
    if(e.finance?.can_manage&&e.finance.detailed&&e.finance.state!=='closed')add(e,"核对收退款与结清",'finance');
  }
  return rows;
}
