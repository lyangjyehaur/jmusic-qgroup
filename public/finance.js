'use strict';
const FinanceText={
  kinds:{collection:'收款',refund:'退还参加者',reimbursement:'偿还垫付',expense:'支付店家',merchant_refund:'店家退差价',deposit:'支付订金／押金',deposit_return:'店家退订金／押金',deposit_apply:'订金抵消费／押金转损失',credit_transfer:'更正款项归属',cash_transfer:'移交代收资金',reversal:'冲销记录',close:'确认结清',reopen:'重新核对'},
  methods:{wechat:'微信',alipay:'支付宝',qq:'QQ',cash:'现金',other:'其他'},
  states:{closed:'已结清',collecting:'收退款中',unpublished:'尚未发布逐人结算'},
  reports:{pending:'待发起者核对',accepted:'已确认',rejected:'未确认',withdrawn:'已撤回'}
};
function financeBalanceLabel(balance,centsText) {
  return balance==null?'结算前预收／垫付':balance>0?'待补 ¥'+centsText(balance):balance<0?'应退／待偿还 ¥'+centsText(-balance):'已对平';
}
function createFinanceUI({api,$,esc,showDialog,toast,renderDetail,refresh,centsText,wallDate,wallToISO,shortDate,withProfile}) {
  let ctx=null,edit=null,generation=0,loadGeneration=0;
  const form=()=>$('#finance-form');
  const uid=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>v.toString(16).padStart(2,'0')).join('');
  const name=(p,key)=>p.parties?.find(v=>v.id===key)?.label||ctx?.view.parties.find(v=>v.id===key)?.label||'款项人员';
  function flow(p) {
    const kind=p.kind;
    const actual=p.actual_party_id||p.payer_id,attribution=actual!==p.payer_id?' · 计入 '+name(p,p.payer_id)+' 的款项':'';
    if(kind==='collection')return name(p,actual)+' → '+name(p,p.custodian_id)+'（代收）'+attribution;
    if(['refund','reimbursement'].includes(kind))return (p.funding==='payer'?name(p,p.funder_id)+'（个人先垫）':name(p,p.custodian_id)+'（代收资金）')+' → '+name(p,actual)+attribution;
    if(['credit_transfer','cash_transfer'].includes(kind))return name(p,p.from_id)+' → '+name(p,p.to_id)+(kind==='credit_transfer'?'（仅更正归属）':'（代收资金）');
    if(kind==='deposit_apply')return p.merchant+' · 已付订金转计实际消费／损失';
    const person=p.funding==='payer'?name(p,p.payer_id):name(p,p.custodian_id)+'（代收资金）';
    return ['merchant_refund','deposit_return'].includes(kind)?p.merchant+' → '+person:person+' → '+p.merchant;
  }
  function transactionBody(p) {
    return `<p class="finance-value">${esc(FinanceText.kinds[p.kind])}<strong>¥${centsText(p.amount_cents)}</strong></p><p>${esc(flow(p))}</p><p class="field-help">${['credit_transfer','deposit_apply'].includes(p.kind)?'记账时间':esc(FinanceText.methods[p.method])} · ${shortDate(p.occurred_at,ctx.event.timezone)}</p>${p.note?`<p class="settlement-note">${esc(p.note)}</p>`:''}${p.reason?`<p class="field-help">依据：${esc(p.reason)}</p>`:''}${p.reference_id?`<p class="field-help">关联记录 ${esc(p.reference_id)}</p>`:''}`;
  }
  function section(e) {
    const f=e.finance;if(!f||e.lifecycle==='draft'||(!f.can_manage&&!f.can_report&&!f.has_records&&!f.detailed))return '';
    const mine=f.my_outstanding_cents!=null?`<p class="my-obligation">${f.my_outstanding_cents?'我的待补 ¥'+centsText(f.my_outstanding_cents):'我的待补 ¥0.00'}${f.my_refund_due_cents?' · 应退／待偿还 ¥'+centsText(f.my_refund_due_cents):''}</p>`:'';
    return `<section class="settlement-section"${!f.has_records&&!f.pending_count?' data-advanced-only':''} aria-label="收付款"><div class="settlement-heading"><h3>收付款</h3><button class="text-button" data-detail-action="finance">查看账本</button></div><p class="field-help">${FinanceText.states[f.state]}${f.pending_count?' · '+f.pending_count+' 笔申报待核对':''}</p>${mine}${f.can_report?'<button class="text-button" data-detail-action="finance-report">已转账／垫付？申报款项</button>':''}</section>`;
  }
  function cardLabel(e) {
    const f=e.finance;if(!f?.detailed)return null;
    if(f.state==='closed')return '已结清';
    if(f.my_outstanding_cents>0)return '待补 ¥'+centsText(f.my_outstanding_cents);
    if(f.my_refund_due_cents>0)return '应退／待偿还 ¥'+centsText(f.my_refund_due_cents);
    if(f.my_balance_cents===0)return '我已对平';
    return e.is_owner?'收退款中':null;
  }
  function entryBody(e) {
    if(FinanceText.kinds[e.kind]&&e.payload.amount_cents)return transactionBody(e.payload);
    return `<p>${esc(FinanceText.kinds[e.kind]||e.kind)}${e.kind==='close'?' · 结算第 '+e.payload.bill_version+' 版':''}</p>${e.payload.reason?`<p class="settlement-note">${esc(e.payload.reason)}</p>`:''}${e.reversal_of?`<p class="field-help">原款项 ${esc(e.reversal_of)}；原记录仍保留。</p>`:''}`;
  }
  function historyRows(entries) {
    return entries.map(e=>`<details class="finance-entry"><summary><span>${esc(FinanceText.kinds[e.kind]||e.kind)}${e.reversed?' · 已冲销':''}</span><span>${e.payload.amount_cents?'¥'+centsText(e.payload.amount_cents):''}</span></summary><p class="field-help">${shortDate(e.created_at,ctx.event.timezone)} · ${esc(e.actor_name)} 确认 · ${esc(e.id)}</p>${entryBody(e)}${e.source_report_id?'<p class="field-help">来自已确认申报；申报不会重复入账。</p>':''}${ctx.view.summary.can_manage&&!e.reversed&&e.payload.amount_cents?`<button class="text-button danger" data-finance="reverse" data-id="${e.id}">冲销此笔记录</button>`:''}</details>`).join('');
  }
  function render() {
    const v=ctx.view,s=v.summary,owner=s.can_manage;
    $('#finance-content').innerHTML=`<p class="finance-state">${FinanceText.states[s.state]}</p>${s.my_outstanding_cents!=null?`<p class="my-obligation">我的待补 ¥${centsText(s.my_outstanding_cents)}${s.my_refund_due_cents?' · 应退／待偿还 ¥'+centsText(s.my_refund_due_cents):''}</p>`:''}<div class="finance-totals"><p><span>结算费用</span><strong>${s.total_due_cents==null?'待核对':'¥'+centsText(s.total_due_cents)}</strong></p><p><span>已付店家净消费</span><span>¥${centsText(s.cost_cents)}</span></p><p><span>活动代收资金余额</span><span>¥${centsText(s.held_cents)}</span></p>${s.deposit_cents?`<p><span>待退／待抵订金押金</span><span>¥${centsText(s.deposit_cents)}</span></p>`:''}</div>${s.state==='closed'?'<details class="extra-settings"><summary>补录或更正款项</summary>':''}<div class="finance-actions">${owner?'<button class="button primary full" data-finance="record">登记款项</button>':''}${s.can_report?'<button class="button secondary full" data-finance="report">申报我已转账／垫付</button>':''}</div>${s.state==='closed'?'</details>':''}<details class="invoice-breakdown"><summary>逐付款人对账${s.outstanding_cents!=null?' · 待补 ¥'+centsText(s.outstanding_cents)+(s.refund_due_cents?' · 应退 ¥'+centsText(s.refund_due_cents):''):''}</summary>${s.balances.map(b=>`<div class="finance-balance"><strong>${esc(b.label)}</strong><p>${financeBalanceLabel(b.balance_cents,centsText)}</p><p class="field-help">${b.due_cents==null?'尚未确定应付':'应付 ¥'+centsText(b.due_cents)+' · '}已确认净投入 ¥${centsText(b.contributed_cents)}</p></div>`).join('')||'<p class="field-help">暂无应付或已确认款项。</p>'}<p class="field-help">净投入含预收与个人先付店家的款项，扣除已退还及已偿还垫付。改账不会移动原款项。</p></details><details class="invoice-breakdown"><summary>代收资金与订金</summary>${s.custodians.map(p=>`<p class="invoice-line"><span>${esc(p.label)}</span><span>代收余额 ¥${centsText(p.held_cents)}</span></p>`).join('')||'<p class="field-help">暂无代收资金。</p>'}${v.references.filter(r=>r.kind==='deposit').map(r=>`<p class="field-help">${esc(r.payload.merchant)}：订金／押金剩余 ¥${centsText(r.remaining_cents)} · ${esc(r.id)}</p>`).join('')}<p class="field-help">个人垫付和活动代收资金分开记录。已含在最终账单的订金先抵扣，仅登记剩余店家支出；可退押金不计消费。</p></details><h3 class="invoice-section-title">款项申报</h3>${v.reports.map(r=>`<details class="finance-entry"${r.status==='pending'?' open':''}><summary><span>${esc(r.reporter_name)} · ${FinanceText.reports[r.status]}${r.entry_reversed?' · 入账已冲销':''}</span><span>¥${centsText(r.payload.amount_cents)}</span></summary>${transactionBody(r.payload)}${r.reason?`<p class="field-help">${esc(r.decision_by)}：${esc(r.reason)}</p>`:''}${r.status==='pending'&&owner?`<div class="finance-actions"><button class="button secondary" data-finance="accept" data-id="${r.id}">核对并确认</button><button class="text-button" data-finance="reject" data-id="${r.id}">暂不确认</button></div>`:''}${r.can_withdraw?`<button class="text-button" data-finance="withdraw" data-id="${r.id}">撤回申报</button>`:''}${r.entry_id?`<p class="field-help">入账记录 ${esc(r.entry_id)}</p>`:''}</details>`).join('')||'<p class="field-help">暂无可查看的申报。</p>'}<button type="button" class="text-button full" data-finance="more-reports"${v.next_report_before?'':' hidden'}>更早申报</button><h3 class="invoice-section-title">已确认记录</h3><div id="finance-history">${historyRows(v.entries)||'<p class="field-help">暂无已确认款项。</p>'}</div><button type="button" class="text-button full" id="finance-more" data-finance="more"${v.next_before?'':' hidden'}>更早记录</button>${owner?`<details class="invoice-breakdown"><summary>账务结清</summary>${s.state==='closed'?'<p class="field-help">当前版本已结清。更正款项或结算会重新进入待处理。</p><button class="text-button" data-finance="reopen">重新打开核对</button>':`${v.close_blockers.map(message=>`<p class="field-help">${esc(message)}</p>`).join('')}<button class="button secondary full" data-finance="close"${v.close_blockers.length?' disabled':''}>确认账务结清</button>`}</details>`:''}`;
  }
  async function open(e,report=false) {
    const loading=++loadGeneration;$('#finance-content').textContent='加载账本…';$('#finance-error').textContent='';showDialog('finance-dialog');
    try {
      const latest=await api('/api/events/'+e.id),view=await api('/api/events/'+e.id+'/finance');if(loading!==loadGeneration)return;
      ctx={event:latest,view};renderDetail(latest);render();if(report&&view.summary.can_report)openEdit('report');
    }catch(problem){$('#finance-error').textContent=problem.message;}
  }
  function partyOptions(allowed=null) {return ctx.view.parties.filter(p=>!allowed||allowed.includes(p.id)).concat(edit.custom).map(p=>`<option value="${p.id}">${esc(p.label||p.name)}</option>`).join('');}
  function invalidate() {
    generation++;if(edit)edit.preview=null;$('#finance-preview').hidden=true;$('#finance-confirm').hidden=true;$('#finance-preview-button').hidden=false;
    $('#finance-form .form-error').textContent='';
  }
  function settings() {
    const f=form(),k=f.elements.kind?.value;if(!k)return;
    const refund=['refund','reimbursement'].includes(k),funded=['expense','deposit','merchant_refund','deposit_return'].includes(k)||refund,transfer=['cash_transfer','credit_transfer'].includes(k),ref=['deposit_apply','deposit_return','merchant_refund'].includes(k);
    const payer=k==='collection'||refund||(funded&&f.elements.funding.value==='payer');
    const custodian=k==='collection'||(funded&&f.elements.funding.value==='pool');
    for(const [key,visible] of Object.entries({payer_id:payer,custodian_id:custodian,funder_id:refund&&f.elements.funding.value==='payer',funding:funded&&edit.command!=='report',merchant:['expense','deposit'].includes(k),from_id:transfer,to_id:transfer,reference_id:ref})) {
      const el=f.elements[key];el.closest('.field').hidden=!visible;el.required=visible;el.disabled=!visible;
    }
    const references=ctx.view.references.filter(r=>k==='merchant_refund'?r.kind==='expense'||r.kind==='deposit_apply':r.kind==='deposit');
    const reference=f.elements.reference_id,old=reference.value;
    reference.innerHTML=references.map(r=>`<option value="${r.id}">${esc(r.payload.merchant)} · 剩 ¥${centsText(r.remaining_cents)} · ${esc(r.id)}</option>`).join('');
    if(references.some(r=>r.id===old))reference.value=old;
    f.elements.reason.required=['deposit_apply','cash_transfer','credit_transfer'].includes(k);
    f.elements.reason.closest('.field').hidden=!f.elements.reason.required;
    const actual=f.elements.actual_party_id;
    actual.closest('details').hidden=!['collection','refund','reimbursement'].includes(k);actual.disabled=actual.closest('details').hidden;
    f.elements.actual_reason.disabled=actual.disabled;
    f.elements.method.disabled=['credit_transfer','deposit_apply'].includes(k);f.elements.method.closest('.field').hidden=f.elements.method.disabled;
    $('#finance-kind-help').textContent=k==='credit_transfer'?'只更正已有净投入归属，不代表实际转账；原记录仍可回查。':k==='deposit_apply'?'这笔不产生新转账。请同时核对结算费用；已经包含的订金不要再记一次店家支出。':k==='refund'||k==='reimbursement'?'只登记实际已退还／已偿还的款项，不会发起真实转账。':funded?'活动代收资金是已收款余额；个人直接先付店家时选个人垫付。可退押金不计消费。':'只登记实际款项；申报须发起者核对后才计入已收。';
  }
  async function openEdit(command,id=null) {
    try{await BoardDrafts.detach('finance-form-dialog');}catch(problem){toast(problem.message);return;}
    const eRevision=ctx.event.revision;generation++;const report=ctx.view.reports.find(r=>r.id===id),entry=ctx.view.entries.find(r=>r.id===id);
    edit={command,id,custom:[],recordId:uid(),preview:null};form().reset();$('#finance-form .form-error').textContent='';$('#finance-reload').hidden=true;
    $('#finance-preview').hidden=true;$('#finance-confirm').hidden=true;$('#finance-preview-button').hidden=false;$('#finance-preview-button').disabled=false;
    const titles={record:'登记实际款项',report:'申报我的款项',accept:'确认收到／已垫付',reject:'暂不确认申报',withdraw:'撤回申报',reverse:'冲销款项记录',close:'确认账务结清',reopen:'重新打开核对'};
    $('#finance-form-title').textContent=titles[command];
    if(command==='record'||command==='report') {
      const reporting=command==='report',kinds=reporting?['collection','expense','deposit']:Object.keys(FinanceText.kinds).filter(k=>!['reversal','close','reopen'].includes(k));
      $('#finance-fields').innerHTML=`<label class="field">款项类型<select name="kind">${kinds.map(k=>`<option value="${k}">${k==='expense'&&reporting?'个人先付店家':FinanceText.kinds[k]}</option>`).join('')}</select></label><p class="field-help" id="finance-kind-help"></p><label class="field">金额（元）<input name="amount" inputmode="decimal" required placeholder="0.00"></label><label class="field">资金来源／去向<select name="funding"><option value="payer">个人垫付／个人收回</option><option value="pool">活动代收资金</option></select></label><label class="field">付款归属人员<select name="payer_id">${partyOptions(reporting?ctx.view.reportable_ids:null)}</select></label><label class="field">代收资金持有人<select name="custodian_id">${partyOptions()}</select></label><label class="field">个人垫退／偿还的出资人<select name="funder_id">${partyOptions()}</select></label><label class="field">转出人员<select name="from_id">${partyOptions()}</select></label><label class="field">转入人员<select name="to_id">${partyOptions()}</select></label><label class="field">店家／项目<input name="merchant" maxlength="80"></label><label class="field">关联原记录<select name="reference_id"></select></label><label class="field">依据／更正原因<textarea name="reason" rows="2" maxlength="300"></textarea></label><details class="extra-settings"><summary>代付／代收说明</summary><label class="field">实际转款／收款人<select name="actual_party_id"><option value="">与款项归属人员相同</option>${partyOptions()}</select></label><label class="field">代付依据<textarea name="actual_reason" rows="2" maxlength="300"></textarea></label></details><details class="extra-settings"><summary>付款方式、时间与备注</summary><label class="field">付款方式<select name="method">${Object.entries(FinanceText.methods).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label class="field">实际款项时间（活动时区）<input name="occurred_at" type="datetime-local" required></label><label class="field">备注（选填）<textarea name="note" rows="2" maxlength="1000"></textarea></label></details>${reporting?'':`<details class="extra-settings"><summary>添加未报名的款项人员</summary><label class="field">称呼<input id="finance-custom-name" maxlength="24"></label><button class="text-button" type="button" data-finance="add-party">加入人员选项</button></details>`}`;
      const f=form();f.elements.custodian_id.value=ctx.view.default_custodian_id;
      f.elements.payer_id.value=reporting?ctx.view.reportable_ids[0]:(ctx.view.summary.balances.find(p=>p.balance_cents>0)?.id||ctx.view.default_custodian_id);
      f.elements.occurred_at.value=wallDate(new Date().toISOString(),ctx.event.timezone);
      f.elements.from_id.value=ctx.view.default_custodian_id;
      f.elements.to_id.value=ctx.view.parties.find(p=>p.id!==f.elements.from_id.value)?.id||'';
      f.elements.funding.value=reporting?'payer':ctx.view.summary.held_cents>0?'pool':'payer';settings();
    } else {
      const p=report?.payload||entry?.payload;
      $('#finance-fields').innerHTML=(p?.amount_cents?transactionBody(p):'')+(command==='close'?'<p>所有应付、已确认款项、店家净消费、代收资金和订金均已对平。确认将保存结清记录。</p>':'')+(command==='reverse'?'<p class="field-help">仅冲销这笔账务记录，不会实际退钱；已关联后续款项时须先处理后续记录。原记录保留。</p>':'')+(command==='accept'?'<p class="field-help">请核对实际到账／店家支付情况及金额。内容不符时先选择暂不确认，再重新申报或登记。</p>':'')+`<label class="field">${['reject','reverse','reopen'].includes(command)?'处理原因':'备注（选填）'}<textarea name="reason" rows="2" maxlength="300"${['reject','reverse','reopen'].includes(command)?' required':''}></textarea></label>`;
    }
    showDialog('finance-form-dialog');
    try{await BoardDrafts.bind('finance-form-dialog',`finance:${ctx.event.id}:${command}:${id||'new'}`,
      ()=>({edit:{...edit,preview:null},revision:ctx.event.revision,fields:BoardDrafts.fields(form())}),data=>{
        edit={...data.edit,preview:null};
        for(const p of edit.custom)for(const field of ['payer_id','custodian_id','from_id','to_id','actual_party_id','funder_id'])if(form().elements[field])form().elements[field].add(new Option(p.label||p.name,p.id));
        BoardDrafts.fill(form(),data.fields);settings();BoardDrafts.fill(form(),data.fields);ctx.event={...ctx.event,revision:data.revision};invalidate();
        if(data.revision!==eRevision){$('#finance-reload').hidden=false;return '草稿基于旧版账本；请保留需要的文字并载入最新版后重新核对';}
      });}catch(problem){$('#finance-form .form-error').textContent=problem.message;}
  }
  function payload() {
    const f=form(),data={command:edit.command,base_revision:ctx.event.revision};
    if(['record','report'].includes(edit.command)) {
      const tx=Object.fromEntries(new FormData(f));delete tx.reason;tx.reason=(f.elements.reason.required?f.elements.reason.value:tx.actual_reason||'').trim();delete tx.actual_reason;
      tx.occurred_at=wallToISO(f.elements.occurred_at.value,ctx.event.timezone);tx.note=tx.note.trim();
      tx.custom_parties=edit.custom.filter(p=>['payer_id','custodian_id','from_id','to_id','actual_party_id','funder_id'].some(key=>tx[key]===p.id));
      data.id=edit.recordId;data.transaction=tx;
    } else {
      data.reason=f.elements.reason.value.trim();
      if(['accept','reject','withdraw'].includes(edit.command))data.report_id=edit.id;
      if(edit.command==='reverse')data.entry_id=edit.id;
    }
    return data;
  }
  form().addEventListener('input',invalidate);
  form().addEventListener('change',event=>{invalidate();if(['kind','funding'].includes(event.target.name))settings();});
  form().addEventListener('invalid',event=>{let el=event.target.parentElement;while(el&&el!==form()){if(el.tagName==='DETAILS')el.open=true;el=el.parentElement;}},true);
  form().addEventListener('submit',async event=>{
    event.preventDefault();if(!edit||!BoardDrafts.ready('finance-form-dialog'))return;const current=edit,at=generation;$('#finance-preview-button').disabled=true;
    try {
      if(await BoardClient.hasPending(ctx.event.id))throw new Error('先在消息的「待确认操作」查询上次结果，再核对最新账本');
      const data=payload(),result=await api(`/api/events/${ctx.event.id}/finance/preview`,'POST',data);
      if(edit!==current||at!==generation)return;
      edit.preview={...data,preview_token:result.preview_token};
      const p=result.command.transaction;
      $('#finance-preview').innerHTML='<h3>核对预览</h3>'+(p?transactionBody(p):'<p>'+esc($('#finance-form-title').textContent)+'</p>')+(result.command.reason?'<p>'+esc(result.command.reason)+'</p>':'')+(edit.command==='report'?'<p class="field-help">提交后等待发起者核对，暂不计入已收款或店家支出。</p>':`<p class="field-help">登记后：店家净消费 ¥${centsText(result.projection.cost_cents)} · 代收余额 ¥${centsText(result.projection.held_cents)} · 订金押金 ¥${centsText(result.projection.deposit_cents)}</p>`);
      $('#finance-preview').hidden=false;$('#finance-confirm').hidden=false;$('#finance-preview-button').hidden=true;$('#finance-confirm').textContent=edit.command==='report'?'确认提交申报':'确认登记';$('#finance-confirm').focus();
    }catch(problem){$('#finance-form .form-error').textContent=problem.message;$('#finance-reload').hidden=problem.status!==409;}
    finally{if(edit===current)$('#finance-preview-button').disabled=false;}
  });
  $('#finance-confirm').addEventListener('click',async()=>{
    if(!edit?.preview)return;const current=edit,eventId=ctx.event.id;form().inert=true;$('#finance-confirm').disabled=true;
    try {
      const updated=await api(`/api/events/${eventId}/finance`,'POST',edit.preview);
      if(edit===current){await BoardDrafts.clear('finance-form-dialog');$('#finance-form-dialog').close();edit=null;}renderDetail(updated);await refresh({detail:false});await open(updated);toast('款项记录已保存');
    }catch(problem){$('#finance-form .form-error').textContent=problem.message;$('#finance-reload').hidden=problem.status===409?false:true;}
    finally{form().inert=false;$('#finance-confirm').disabled=false;}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-finance]');if(!button||!ctx)return;const action=button.dataset.finance;
    if(['record','report','accept','reject','withdraw','reverse','close','reopen'].includes(action))return withProfile(()=>openEdit(action,button.dataset.id));
    if(action==='reload') {
      try{const current=edit,latest=await api('/api/events/'+ctx.event.id),view=await api('/api/events/'+ctx.event.id+'/finance');ctx={event:latest,view};render();await BoardDrafts.clear('finance-form-dialog');openEdit(current.command,current.id);}catch(problem){$('#finance-form .form-error').textContent=problem.message;}return;
    }
    if(action==='refresh')return open(ctx.event);
    if(action==='more-reports') {
      const current=ctx;button.disabled=true;try{const page=await api(`/api/events/${ctx.event.id}/finance?before_report=${ctx.view.next_report_before}`);if(ctx!==current)return;ctx.view.reports.push(...page.reports);ctx.view.next_report_before=page.next_report_before;render();}catch(problem){if(ctx===current)$('#finance-error').textContent=problem.message;}finally{button.disabled=false;}return;
    }
    if(action==='more') {
      const current=ctx;button.disabled=true;try{const earlier=await api(`/api/events/${ctx.event.id}/finance?before=${ctx.view.next_before}`);if(ctx!==current)return;ctx.view.entries.push(...earlier.entries);ctx.view.next_before=earlier.next_before;$('#finance-history').insertAdjacentHTML('beforeend',historyRows(earlier.entries));button.hidden=!earlier.next_before;}catch(problem){if(ctx===current)$('#finance-error').textContent=problem.message;}finally{button.disabled=false;}return;
    }
    if(action==='add-party'&&edit) {
      const input=$('#finance-custom-name'),value=input.value.trim();if(!value){toast('请填写称呼');return;}if(edit.custom.length>=2){toast('本笔最多增加两位人员');return;}
      const p={id:'custom:'+uid(),name:value,label:value+'（本次新增）'};edit.custom.push(p);invalidate();
      for(const field of ['payer_id','custodian_id','from_id','to_id','actual_party_id','funder_id']){const option=document.createElement('option');option.value=p.id;option.textContent=p.label;form().elements[field].append(option);}
      BoardDrafts.touch('finance-form-dialog');input.value='';toast('已加入，请在对应人员栏选择');
    }
  });
  return {open,section,cardLabel};
}
