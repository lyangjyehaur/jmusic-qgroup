'use strict';
const FinanceText={
  kinds:{collection:"收款",refund:"退還參加者",reimbursement:"償還墊付",expense:"支付店家",merchant_refund:"店家退差價",deposit:"支付訂金／押金",deposit_return:"店家退訂金／押金",deposit_apply:"訂金抵消費／押金轉損失",credit_transfer:"更正款項歸屬",cash_transfer:"移交代收資金",reversal:"沖銷記錄",close:"確認結清",reopen:"重新核對"},
  methods:{wechat:"微信",alipay:"支付寶",qq:'QQ',cash:"現金",other:'其他'},
  states:{closed:"已結清",collecting:"收退款中",unpublished:"尚未發佈逐人結算"},
  reports:{pending:"待發起者核對",accepted:"已確認",rejected:"未確認",withdrawn:"已撤回"}
};
function financeBalanceLabel(balance,centsText) {
  return balance==null?"結算前預收／墊付":balance>0?"待補 ¥"+centsText(balance):balance<0?"應退／待償還 ¥"+centsText(-balance):"已對平";
}
function createFinanceUI({api,$,esc,showDialog,toast,renderDetail,refresh,centsText,wallDate,wallToISO,shortDate,withProfile}) {
  let ctx=null,edit=null,generation=0,loadGeneration=0;
  const form=()=>$('#finance-form');
  const uid=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>v.toString(16).padStart(2,'0')).join('');
  const name=(p,key)=>p.parties?.find(v=>v.id===key)?.label||ctx?.view.parties.find(v=>v.id===key)?.label||"款項人員";
  function flow(p) {
    const kind=p.kind;
    const actual=p.actual_party_id||p.payer_id,attribution=actual!==p.payer_id?" · 計入 "+name(p,p.payer_id)+" 的款項":'';
    if(kind==='collection')return name(p,actual)+' → '+name(p,p.custodian_id)+"（代收）"+attribution;
    if(['refund','reimbursement'].includes(kind))return (p.funding==='payer'?name(p,p.funder_id)+"（個人先墊）":name(p,p.custodian_id)+"（代收資金）")+' → '+name(p,actual)+attribution;
    if(['credit_transfer','cash_transfer'].includes(kind))return name(p,p.from_id)+' → '+name(p,p.to_id)+(kind==='credit_transfer'?"（僅更正歸屬）":"（代收資金）");
    if(kind==='deposit_apply')return p.merchant+" · 已付訂金轉計實際消費／損失";
    const person=p.funding==='payer'?name(p,p.payer_id):name(p,p.custodian_id)+"（代收資金）";
    return ['merchant_refund','deposit_return'].includes(kind)?p.merchant+' → '+person:person+' → '+p.merchant;
  }
  function transactionBody(p) {
    return `${p.room_name?`<p class="activity-alert">包間：${esc(p.room_name)}</p>`:''}<p class="finance-value">${esc(FinanceText.kinds[p.kind])}<strong>¥${centsText(p.amount_cents)}</strong></p><p>${esc(flow(p))}</p><p class="field-help">${['credit_transfer','deposit_apply'].includes(p.kind)?"記帳時間":esc(FinanceText.methods[p.method])} · ${shortDate(p.occurred_at,ctx.event.timezone)}</p>${p.note?`<p class="settlement-note">${esc(p.note)}</p>`:''}${p.reason?`<p class="field-help">依據：${esc(p.reason)}</p>`:''}${p.reference_id?`<p class="field-help">關聯記錄 ${esc(p.reference_id)}</p>`:''}`;
  }
  function section(e) {
    const f=e.finance;if(!f||e.lifecycle==='draft'||(!f.can_manage&&!f.can_report&&!f.has_records&&!f.detailed))return '';
    const mine=f.my_outstanding_cents!=null?`<p class="my-obligation">${f.my_outstanding_cents?"我的待補 ¥"+centsText(f.my_outstanding_cents):"我的待補 ¥0.00"}${f.my_refund_due_cents?" · 應退／待償還 ¥"+centsText(f.my_refund_due_cents):''}</p>`:'';
    return `<section class="settlement-section"${!f.has_records&&!f.pending_count?' data-advanced-only':''} aria-label="收付款"><div class="settlement-heading"><h3>收付款</h3><button class="text-button" data-detail-action="finance">查看帳本</button></div><p class="field-help">${FinanceText.states[f.state]}${f.pending_count?' · '+f.pending_count+" 筆申報待核對":''}</p>${mine}${f.can_report?"<button class=\"text-button\" data-detail-action=\"finance-report\">已轉帳／墊付？申報款項</button>":''}</section>`;
  }
  function cardLabel(e) {
    const f=e.finance;if(!f?.detailed)return null;
    if(f.state==='closed')return "已結清";
    if(f.my_outstanding_cents>0)return "待補 ¥"+centsText(f.my_outstanding_cents);
    if(f.my_refund_due_cents>0)return "應退／待償還 ¥"+centsText(f.my_refund_due_cents);
    if(f.my_balance_cents===0)return "我已對平";
    return e.is_owner?"收退款中":null;
  }
  function entryBody(e) {
    if(FinanceText.kinds[e.kind]&&e.payload.amount_cents)return transactionBody(e.payload);
    return `<p>${esc(FinanceText.kinds[e.kind]||e.kind)}${e.kind==='close'?" · 結算第 "+e.payload.bill_version+" 版":''}</p>${e.payload.reason?`<p class="settlement-note">${esc(e.payload.reason)}</p>`:''}${e.reversal_of?`<p class="field-help">原款項 ${esc(e.reversal_of)}；原記錄仍保留。</p>`:''}`;
  }
  function historyRows(entries) {
    return entries.map(e=>`<details class="finance-entry"><summary><span>${esc(FinanceText.kinds[e.kind]||e.kind)}${e.reversed?" · 已沖銷":''}</span><span>${e.payload.amount_cents?'¥'+centsText(e.payload.amount_cents):''}</span></summary><p class="field-help">${shortDate(e.created_at,ctx.event.timezone)} · ${esc(e.actor_name)} 確認 · ${esc(e.id)}</p>${entryBody(e)}${e.source_report_id?"<p class=\"field-help\">來自已確認申報；申報不會重複入帳。</p>":''}${ctx.view.summary.can_manage&&!e.reversed&&e.payload.amount_cents?`<button class="text-button danger" data-finance="reverse" data-id="${e.id}">沖銷此筆記錄</button>`:''}</details>`).join('');
  }
  function render() {
    const v=ctx.view,s=v.summary,owner=s.can_manage;
    $('#finance-content').innerHTML=`<p class="finance-state">${FinanceText.states[s.state]}</p>${s.my_outstanding_cents!=null?`<p class="my-obligation">我的待補 ¥${centsText(s.my_outstanding_cents)}${s.my_refund_due_cents?" · 應退／待償還 ¥"+centsText(s.my_refund_due_cents):''}</p>`:''}<div class="finance-totals"><p><span>結算費用</span><strong>${s.total_due_cents==null?"待核對":'¥'+centsText(s.total_due_cents)}</strong></p><p><span>已付店家淨消費</span><span>¥${centsText(s.cost_cents)}</span></p><p><span>活動代收資金餘額</span><span>¥${centsText(s.held_cents)}</span></p>${s.deposit_cents?`<p><span>待退／待抵訂金押金</span><span>¥${centsText(s.deposit_cents)}</span></p>`:''}</div>${s.state==='closed'?"<details class=\"extra-settings\"><summary>補錄或更正款項</summary>":''}<div class="finance-actions">${owner?"<button class=\"button primary full\" data-finance=\"record\">登記款項</button>":''}${s.can_report?"<button class=\"button secondary full\" data-finance=\"report\">申報我已轉帳／墊付</button>":''}</div>${s.state==='closed'?'</details>':''}${s.room_balances?.length?`<details class="invoice-breakdown" open><summary>各包間當前轉款明細</summary>${roomTransfersBody(s.room_balances,esc,centsText)}<p class="field-help">各包間分別對帳，不跨包間抵銷待補與應退。</p></details>`:''}<details class="invoice-breakdown"${s.room_balances?.length?' hidden':''}><summary>逐付款人對帳${s.outstanding_cents!=null?" · 待補 ¥"+centsText(s.outstanding_cents)+(s.refund_due_cents?" · 應退 ¥"+centsText(s.refund_due_cents):''):''}</summary>${s.balances.map(b=>`<div class="finance-balance"><strong>${esc(b.label)}</strong><p>${financeBalanceLabel(b.balance_cents,centsText)}</p><p class="field-help">${b.due_cents==null?"尚未確定應付":"應付 ¥"+centsText(b.due_cents)+' · '}已確認淨投入 ¥${centsText(b.contributed_cents)}</p></div>`).join('')||"<p class=\"field-help\">暫無應付或已確認款項。</p>"}<p class="field-help">淨投入含預收與個人先付店家的款項，扣除已退還及已償還墊付。改帳不會移動原款項。</p></details><details class="invoice-breakdown"><summary>代收資金與訂金</summary>${s.custodians.map(p=>`<p class="invoice-line"><span>${esc(p.label)}</span><span>代收餘額 ¥${centsText(p.held_cents)}</span></p>`).join('')||"<p class=\"field-help\">暫無代收資金。</p>"}${v.references.filter(r=>r.kind==='deposit').map(r=>`<p class="field-help">${esc(r.payload.merchant)}：訂金／押金剩餘 ¥${centsText(r.remaining_cents)} · ${esc(r.id)}</p>`).join('')}<p class="field-help">個人墊付和活動代收資金分開記錄。已含在最終帳單的訂金先抵扣，僅登記剩餘店家支出；可退押金不計消費。</p></details><h3 class="invoice-section-title">款項申報</h3>${v.reports.map(r=>`<details class="finance-entry"${r.status==='pending'?' open':''}><summary><span>${esc(r.reporter_name)} · ${FinanceText.reports[r.status]}${r.entry_reversed?" · 入帳已沖銷":''}</span><span>¥${centsText(r.payload.amount_cents)}</span></summary>${transactionBody(r.payload)}${r.reason?`<p class="field-help">${esc(r.decision_by)}：${esc(r.reason)}</p>`:''}${r.status==='pending'&&owner?`<div class="finance-actions"><button class="button secondary" data-finance="accept" data-id="${r.id}">核對並確認</button><button class="text-button" data-finance="reject" data-id="${r.id}">暫不確認</button></div>`:''}${r.can_withdraw?`<button class="text-button" data-finance="withdraw" data-id="${r.id}">撤回申報</button>`:''}${r.entry_id?`<p class="field-help">入帳記錄 ${esc(r.entry_id)}</p>`:''}</details>`).join('')||"<p class=\"field-help\">暫無可查看的申報。</p>"}<button type="button" class="text-button full" data-finance="more-reports"${v.next_report_before?'':' hidden'}>更早申報</button><h3 class="invoice-section-title">已確認記錄</h3><div id="finance-history">${historyRows(v.entries)||"<p class=\"field-help\">暫無已確認款項。</p>"}</div><button type="button" class="text-button full" id="finance-more" data-finance="more"${v.next_before?'':' hidden'}>更早記錄</button>${owner?`<details class="invoice-breakdown"><summary>帳務結清</summary>${s.state==='closed'?"<p class=\"field-help\">當前版本已結清。更正款項或結算會重新進入待處理。</p><button class=\"text-button\" data-finance=\"reopen\">重新打開核對</button>":`${v.close_blockers.map(message=>`<p class="field-help">${esc(message)}</p>`).join('')}<button class="button secondary full" data-finance="close"${v.close_blockers.length?' disabled':''}>確認帳務結清</button>`}</details>`:''}`;
  }
  async function open(e,report=false) {
    const loading=++loadGeneration;$('#finance-content').textContent="加載帳本…";$('#finance-error').textContent='';showDialog('finance-dialog');
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
    const references=ctx.view.references.filter(r=>!f.elements.room_id||r.payload.room_id===f.elements.room_id.value).filter(r=>k==='merchant_refund'?r.kind==='expense'||r.kind==='deposit_apply':r.kind==='deposit');
    const reference=f.elements.reference_id,old=reference.value;
    reference.innerHTML=references.map(r=>`<option value="${r.id}">${esc(r.payload.merchant)} · 剩 ¥${centsText(r.remaining_cents)} · ${esc(r.id)}</option>`).join('');
    if(references.some(r=>r.id===old))reference.value=old;
    f.elements.reason.required=['deposit_apply','cash_transfer','credit_transfer'].includes(k);
    f.elements.reason.closest('.field').hidden=!f.elements.reason.required;
    const actual=f.elements.actual_party_id;
    actual.closest('details').hidden=!['collection','refund','reimbursement'].includes(k);actual.disabled=actual.closest('details').hidden;
    f.elements.actual_reason.disabled=actual.disabled;
    f.elements.method.disabled=['credit_transfer','deposit_apply'].includes(k);f.elements.method.closest('.field').hidden=f.elements.method.disabled;
    $('#finance-kind-help').textContent=k==='credit_transfer'?"只更正已有淨投入歸屬，不代表實際轉帳；原記錄仍可回查。":k==='deposit_apply'?"這筆不產生新轉帳。請同時核對結算費用；已經包含的訂金不要再記一次店家支出。":k==='refund'||k==='reimbursement'?"只登記實際已退還／已償還的款項，不會發起真實轉帳。":funded?"活動代收資金是已收款餘額；個人直接先付店家時選個人墊付。可退押金不計消費。":"只登記實際款項；申報鬚髮起者核對後才計入已收。";
  }
  async function openEdit(command,id=null) {
    try{await BoardDrafts.detach('finance-form-dialog');}catch(problem){toast(problem.message);return;}
    const eRevision=ctx.event.revision;generation++;const report=ctx.view.reports.find(r=>r.id===id),entry=ctx.view.entries.find(r=>r.id===id);
    edit={command,id,custom:[],recordId:uid(),preview:null};form().reset();$('#finance-form .form-error').textContent='';$('#finance-reload').hidden=true;
    $('#finance-preview').hidden=true;$('#finance-confirm').hidden=true;$('#finance-preview-button').hidden=false;$('#finance-preview-button').disabled=false;
    const titles={record:"登記實際款項",report:"申報我的款項",accept:"確認收到／已墊付",reject:"暫不確認申報",withdraw:"撤回申報",reverse:"沖銷款項記錄",close:"確認帳務結清",reopen:"重新打開核對"};
    $('#finance-form-title').textContent=titles[command];
    if(command==='record'||command==='report') {
      const reporting=command==='report',kinds=reporting?['collection','expense','deposit']:Object.keys(FinanceText.kinds).filter(k=>!['reversal','close','reopen'].includes(k));
      $('#finance-fields').innerHTML=`${ctx.view.rooms.length?`<label class="field">款項所屬包間<select name="room_id" required>${ctx.view.rooms.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label>`:''}<label class="field">款項類型<select name="kind">${kinds.map(k=>`<option value="${k}">${k==='expense'&&reporting?"個人先付店家":FinanceText.kinds[k]}</option>`).join('')}</select></label><p class="field-help" id="finance-kind-help"></p><label class="field">金額（元）<input name="amount" inputmode="decimal" required placeholder="0.00"></label><label class="field">資金來源／去向<select name="funding"><option value="payer">個人墊付／個人收回</option><option value="pool">活動代收資金</option></select></label><label class="field">付款歸屬人員<select name="payer_id">${partyOptions(reporting?ctx.view.reportable_ids:null)}</select></label><label class="field">代收資金持有人<select name="custodian_id">${partyOptions()}</select></label><label class="field">個人墊退／償還的出資人<select name="funder_id">${partyOptions()}</select></label><label class="field">轉出人員<select name="from_id">${partyOptions()}</select></label><label class="field">轉入人員<select name="to_id">${partyOptions()}</select></label><label class="field">店家／項目<input name="merchant" maxlength="80"></label><label class="field">關聯原記錄<select name="reference_id"></select></label><label class="field">依據／更正原因<textarea name="reason" rows="2" maxlength="300"></textarea></label><details class="extra-settings"><summary>代付／代收說明</summary><label class="field">實際轉款／收款人<select name="actual_party_id"><option value="">與款項歸屬人員相同</option>${partyOptions()}</select></label><label class="field">代付依據<textarea name="actual_reason" rows="2" maxlength="300"></textarea></label></details><details class="extra-settings"><summary>付款方式、時間與備註</summary><label class="field">付款方式<select name="method">${Object.entries(FinanceText.methods).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label class="field">實際款項時間（活動時區）<input name="occurred_at" type="datetime-local" required></label><label class="field">備註（選填）<textarea name="note" rows="2" maxlength="1000"></textarea></label></details>${reporting?'':`<details class="extra-settings"><summary>添加未報名的款項人員</summary><label class="field">稱呼<input id="finance-custom-name" maxlength="24"></label><button class="text-button" type="button" data-finance="add-party">加入人員選項</button></details>`}`;
      const f=form();f.elements.custodian_id.value=ctx.view.default_custodian_id;
      f.elements.payer_id.value=reporting?ctx.view.reportable_ids[0]:(ctx.view.summary.balances.find(p=>p.balance_cents>0)?.id||ctx.view.default_custodian_id);
      if(f.elements.room_id){
        const target=ctx.view.summary.room_balances?.find(r=>r.balances.some(b=>b.balance_cents>0&&ctx.view.reportable_ids.includes(b.id)));
        f.elements.room_id.value=target?.id||ctx.view.rooms[0].id;
        f.elements.custodian_id.value=ctx.view.rooms.find(r=>r.id===f.elements.room_id.value).payer_id;
      }
      f.elements.occurred_at.value=wallDate(new Date().toISOString(),ctx.event.timezone);
      f.elements.from_id.value=ctx.view.default_custodian_id;
      f.elements.to_id.value=ctx.view.parties.find(p=>p.id!==f.elements.from_id.value)?.id||'';
      f.elements.funding.value=reporting?'payer':ctx.view.summary.held_cents>0?'pool':'payer';settings();
    } else {
      const p=report?.payload||entry?.payload;
      $('#finance-fields').innerHTML=(p?.amount_cents?transactionBody(p):'')+(command==='close'?"<p>所有應付、已確認款項、店家淨消費、代收資金和訂金均已對平。確認將保存結清記錄。</p>":'')+(command==='reverse'?"<p class=\"field-help\">僅沖銷這筆帳務記錄，不會實際退錢；已關聯後續款項時須先處理後續記錄。原記錄保留。</p>":'')+(command==='accept'?"<p class=\"field-help\">請核對實際到帳／店家支付情況及金額。內容不符時先選擇暫不確認，再重新申報或登記。</p>":'')+`<label class="field">${['reject','reverse','reopen'].includes(command)?"處理原因":"備註（選填）"}<textarea name="reason" rows="2" maxlength="300"${['reject','reverse','reopen'].includes(command)?' required':''}></textarea></label>`;
    }
    showDialog('finance-form-dialog');
    try{await BoardDrafts.bind('finance-form-dialog',`finance:${ctx.event.id}:${command}:${id||'new'}`,
      ()=>({edit:{...edit,preview:null},revision:ctx.event.revision,fields:BoardDrafts.fields(form())}),data=>{
        edit={...data.edit,preview:null};
        for(const p of edit.custom)for(const field of ['payer_id','custodian_id','from_id','to_id','actual_party_id','funder_id'])if(form().elements[field])form().elements[field].add(new Option(p.label||p.name,p.id));
        BoardDrafts.fill(form(),data.fields);settings();BoardDrafts.fill(form(),data.fields);ctx.event={...ctx.event,revision:data.revision};invalidate();
        if(data.revision!==eRevision){$('#finance-reload').hidden=false;return "草稿基於舊版帳本；請保留需要的文字並載入最新版後重新核對";}
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
  form().addEventListener('change',event=>{invalidate();if(event.target.name==='room_id'){const room=ctx.view.rooms.find(r=>r.id===event.target.value);if(room&&form().elements.custodian_id)form().elements.custodian_id.value=room.payer_id;}if(['kind','funding','room_id'].includes(event.target.name))settings();});
  form().addEventListener('invalid',event=>{let el=event.target.parentElement;while(el&&el!==form()){if(el.tagName==='DETAILS')el.open=true;el=el.parentElement;}},true);
  form().addEventListener('submit',async event=>{
    event.preventDefault();if(!edit||!BoardDrafts.ready('finance-form-dialog'))return;const current=edit,at=generation;$('#finance-preview-button').disabled=true;
    try {
      if(await BoardClient.hasPending(ctx.event.id))throw new Error("先在消息的「待確認操作」查詢上次結果，再核對最新帳本");
      const data=payload(),result=await api(`/api/events/${ctx.event.id}/finance/preview`,'POST',data);
      if(edit!==current||at!==generation)return;
      edit.preview={...data,preview_token:result.preview_token};
      const p=result.command.transaction;
      $('#finance-preview').innerHTML="<h3>核對預覽</h3>"+(p?transactionBody(p):'<p>'+esc($('#finance-form-title').textContent)+'</p>')+(result.command.reason?'<p>'+esc(result.command.reason)+'</p>':'')+(edit.command==='report'?"<p class=\"field-help\">提交後等待發起者核對，暫不計入已收款或店家支出。</p>":`<p class="field-help">登記後：店家淨消費 ¥${centsText(result.projection.cost_cents)} · 代收餘額 ¥${centsText(result.projection.held_cents)} · 訂金押金 ¥${centsText(result.projection.deposit_cents)}</p>`);
      $('#finance-preview').hidden=false;$('#finance-confirm').hidden=false;$('#finance-preview-button').hidden=true;$('#finance-confirm').textContent=edit.command==='report'?"確認提交申報":"確認登記";$('#finance-confirm').focus();
    }catch(problem){$('#finance-form .form-error').textContent=problem.message;$('#finance-reload').hidden=problem.status!==409;}
    finally{if(edit===current)$('#finance-preview-button').disabled=false;}
  });
  $('#finance-confirm').addEventListener('click',async()=>{
    if(!edit?.preview)return;const current=edit,eventId=ctx.event.id;form().inert=true;$('#finance-confirm').disabled=true;
    try {
      const updated=await api(`/api/events/${eventId}/finance`,'POST',edit.preview);
      if(edit===current){await BoardDrafts.clear('finance-form-dialog');$('#finance-form-dialog').close();edit=null;}renderDetail(updated);await refresh({detail:false});await open(updated);toast("款項記錄已保存");
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
      const input=$('#finance-custom-name'),value=input.value.trim();if(!value){toast("請填寫稱呼");return;}if(edit.custom.length>=2){toast("本筆最多增加兩位人員");return;}
      const p={id:'custom:'+uid(),name:value,label:value+"（本次新增）"};edit.custom.push(p);invalidate();
      for(const field of ['payer_id','custodian_id','from_id','to_id','actual_party_id','funder_id']){const option=document.createElement('option');option.value=p.id;option.textContent=p.label;form().elements[field].append(option);}
      BoardDrafts.touch('finance-form-dialog');input.value='';toast("已加入，請在對應人員欄選擇");
    }
  });
  return {open,section,cardLabel};
}
