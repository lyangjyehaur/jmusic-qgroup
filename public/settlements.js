'use strict';
function settlementItemsPayload(items,people,durationHours) {
  return items.map(item=>{
    const copy=JSON.parse(JSON.stringify(item));delete copy.receipt_digest;
    const targets=item.scope==='common'?people:people.filter(p=>item.allocations.some(a=>a.person_id===p.id));
    if(item.scope==='common'&&['shares','equal'].includes(item.mode))copy.allocations=[];
    else copy.allocations=targets.map(p=>{
      const a=item.allocations.find(v=>v.person_id===p.id)||{};
      return {person_id:p.id,...(item.mode==='fixed'?{amount:a.amount||'0.00'}:item.mode==='duration'?{minutes:a.minutes??(durationHours||0)*60}:item.mode==='weights'?{weight:a.weight||'1'}:{})};
    });
    return copy;
  });
}
function createSettlementUI({api,$,esc,showDialog,toast,renderDetail,refresh,prepareCode,centsText,askConfirm}) {
  let ctx=null,serial=0;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const form=()=>$('#invoice-form');
  const id=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>v.toString(16).padStart(2,'0')).join('');
  const names={confirmed:'正式',waiting:'候补',tentative:'待确认',withdrawn:'已退出'};
  const attendance={unknown:'未核对出席',present:'到场',absent:'缺席',late:'迟到',left:'早退'};
  const modes={shares:'共同 AA 份数',equal:'所选人员均分（含免 A 者）',weights:'本项比例',fixed:'固定金额',duration:'参与分钟'};
  const kinds={expense:'消费',refund:'店家退款',discount:'减免'};
  const receiptUrl=(eventId,version,itemId)=>`/api/events/${eventId}/settlement/history/${version}/receipts/${itemId}`;
  function invalidate() {
    if(!ctx)return;
    serial++;ctx.preview=null;$('#invoice-preview').hidden=true;$('#publish-invoice').hidden=true;
    $('#preview-invoice').hidden=false;$('#invoice-form .form-error').textContent='';
  }
  const codePicker=createPaymentCodePicker({api,$,esc,prepareCode,askConfirm,
    onChange:()=>{invalidate();BoardDrafts.touch('invoice-dialog');},
    onError:problem=>{$('#invoice-form .form-error').textContent=problem.message;},
    startBusy:()=>{const current=ctx;current.busy++;$('#preview-invoice').disabled=true;$('#publish-invoice').disabled=true;
      return ()=>{current.busy--;if(ctx===current){$('#preview-invoice').disabled=!!ctx.busy;$('#publish-invoice').disabled=!!ctx.busy;BoardDrafts.touch('invoice-dialog');}};}
  });
  const roomEditor=createRoomEditor({container:$('#invoice-rooms'),getRooms:()=>ctx.rooms,getPeople:()=>ctx.roster.people.filter(p=>ctx.people.some(q=>q.id===p.id&&q.include)),getPayers:()=>[...ctx.roster.payers,...ctx.custom],esc,final:true,canArrange:()=>ctx.event.is_owner,hasRecords:uid=>(ctx.roster.room_record_ids||[]).includes(uid),onChange:()=>{invalidate();merchantFields();BoardDrafts.touch('invoice-dialog');}});
  function roomMode() {
    const enabled=form().elements.room_mode.checked;$('#invoice-rooms').hidden=!enabled;$('#invoice-rooms').disabled=!enabled;$('#invoice-ordinary-items').hidden=enabled;$('#invoice-ordinary-items').disabled=enabled;
    $('#invoice-collector').textContent=enabled?'按各包间指定付款人收款；本版不附统一收款码，请核对收款人后通过实际渠道转账。':'本版收款人：'+ctx.roster.collector.name+'（当前发布账号）；请选择并核对本人的收款码。';
    document.querySelector('#invoice-form .invoice-codes').hidden=enabled;merchantFields();if(enabled)roomEditor.render();
  }
  function payerOptions(value) {return [...ctx.roster.payers,...ctx.custom].map(p=>`<option value="${p.id}"${p.id===value?' selected':''}>${esc(p.label||p.name)}</option>`).join('');}
  function paymentRow(person,payment,index) {
    return `<div class="invoice-payment"><label class="field">付款人<select data-person="${person.id}" data-payment="${index}" data-prop="payer_id">${payerOptions(payment.payer_id)}</select></label><label class="field">${person.payment_mode==='fixed'?'金额（元）':'比例'}<input data-person="${person.id}" data-payment="${index}" data-prop="${person.payment_mode==='fixed'?'amount':'share'}" inputmode="decimal" value="${esc(person.payment_mode==='fixed'?(payment.amount||'0.00'):(payment.share||'1'))}"></label><button type="button" class="text-button danger" data-invoice="remove-payment" data-person="${person.id}" data-index="${index}" aria-label="移除付款人">×</button></div>`;
  }
  function renderRosterSummary() {
    const included=ctx.people.filter(p=>p.include),exceptional=ctx.people.some(p=>p.include&&(p.share!=='1'||p.payments.length!==1||p.payments[0]?.payer_id!==ctx.roster.people.find(v=>v.id===p.id)?.payer_id||p.payment_mode==='fixed'))||ctx.items.length!==1||ctx.items.some(i=>i.kind!=='expense'||i.mode!=='shares'||i.scope!=='common')||ctx.custom.length;
    const needsReview=ctx.roster.people.filter(p=>included.some(q=>q.id===p.id)&&(p.status!=='confirmed'||p.attendance==='absent'||p.confirmation_state!=='accepted'||p.withdrawal_requested)).length;
    $('#invoice-roster-summary').innerHTML=`<p>${included.length} 人分摊${exceptional?' · 已设置特殊分摊／付款归属':''}</p><p class="field-help">${included.map(p=>esc(ctx.roster.people.find(v=>v.id===p.id)?.label||ctx.roster.people.find(v=>v.id===p.id)?.name)).join('、')||'暂无结算人员'}</p>${needsReview?`<p class="withdrawal-label">${needsReview} 位有缺席、退出或约定差异，请在高级选项核对原因。</p>`:''}`;
  }
  function renderPeople() {
    renderRosterSummary();const opened=new Set([...document.querySelectorAll('[data-invoice-person][open]')].map(el=>el.dataset.invoicePerson));
    const paymentsOpened=new Set([...document.querySelectorAll('[data-invoice-person]>.extra-settings[open]')].map(el=>el.parentElement.dataset.invoicePerson));
    $('#invoice-people').innerHTML=ctx.people.map(p=>{
      const info=ctx.roster.people.find(v=>v.id===p.id),payer=ctx.roster.payers.concat(ctx.custom).find(v=>v.id===p.payments[0]?.payer_id);
      return `<details class="invoice-person" data-invoice-person="${p.id}"${opened.has(p.id)?' open':''}><summary><span>${esc(info.label||info.name)}</span><span>${p.include?(p.share==='0'?'免共同 AA':esc(p.share)+' 份'):'不列入'} · ${p.payments.length>1?'多人合付':esc(payer?.label||payer?.name||'请选择付款人')}</span></summary>${info.status!=='confirmed'?`<label class="check-option"><input type="checkbox" data-person="${p.id}" data-prop="include"${p.include?' checked':''}>列入结算名单</label>`:''}<p class="field-help">${names[info.status]} · ${attendance[info.attendance]}${info.withdrawal_requested?' · 已申请退出':''} · ${esc(info.manager_name)} 管理</p><details class="event-policy"><summary>这位参加者接受的费用约定 · 第 ${info.accepted_conditions_version||'—'} 版${info.confirmation_state!=='accepted'?'（当前变更未接受）':''}</summary><p>${esc(info.accepted_arrangement?.fee_policy||'原记录未填写费用规则，请核对原约定。')}</p></details><label class="field">共同 AA 份数<input data-person="${p.id}" data-prop="share" inputmode="decimal" value="${esc(p.share)}"></label><p class="field-help">1 正常、0.5 半 A、0 免共同费用；指定个人消费可另外计费。</p><label class="field">核对原因 <span class="optional">特殊情况必填</span><textarea rows="2" maxlength="300" data-person="${p.id}" data-prop="reason">${esc(p.reason)}</textarea></label><details class="extra-settings"${paymentsOpened.has(p.id)?' open':''}><summary>付款归属与多人合付</summary><label class="field">归属方式<select data-person="${p.id}" data-prop="payment_mode"><option value="shares"${p.payment_mode==='shares'?' selected':''}>按比例分配应付</option><option value="fixed"${p.payment_mode==='fixed'?' selected':''}>指定各付款人金额</option></select></label><div>${p.payments.map((v,i)=>paymentRow(p,v,i)).join('')}</div><button class="text-button" type="button" data-invoice="add-payment" data-person="${p.id}">增加合付人</button></details></details>`;
    }).join('')||'<p class="muted">没有报名人员，可发布零元结算；有费用需先补录实际人员。</p>';
  }
  function renderItems() {
    renderRosterSummary();const opened=new Set([...document.querySelectorAll('[data-invoice-item]>.extra-settings[open]')].map(el=>el.parentElement.dataset.invoiceItem));
    $('#invoice-items').innerHTML=ctx.items.map((item,index)=>{
      const selected=ctx.people.filter(p=>p.include),alloc=new Map(item.allocations.map(a=>[a.person_id,a]));
      const needsValues=['weights','fixed','duration'].includes(item.mode),needsReason=item.kind!=='expense'||item.scope==='selected'||item.mode!=='shares';
      return `<section class="invoice-item" data-invoice-item="${item.id}"><div class="invoice-item-heading">${ctx.items.length>1?`<strong>费用 ${index+1}</strong>`:item.name!==BoardI18n.defaultItemName?`<strong>${esc(item.name)}</strong>`:''}${ctx.items.length>1?`<button type="button" class="text-button danger" data-invoice="remove-item" data-item="${item.id}">移除</button>`:''}</div><label class="field"${ctx.items.length===1?' data-advanced-only':''}>项目名称<input maxlength="80" required data-item="${item.id}" data-prop="name" value="${esc(item.name)}"></label><label class="field">${ctx.items.length===1?'总金额（元）':'金额（元）'}<input inputmode="decimal" required data-item="${item.id}" data-prop="amount" value="${esc(item.amount)}" placeholder="0.00"></label><details class="extra-settings" data-advanced-only${opened.has(item.id)||item.scope!=='common'||item.mode!=='shares'||item.kind!=='expense'?' open':''}><summary>分摊设置与消费凭证</summary><label class="field">类型<select data-item="${item.id}" data-prop="kind">${Object.entries(kinds).map(([k,v])=>`<option value="${k}"${k===item.kind?' selected':''}>${v}</option>`).join('')}</select></label><label class="field">分摊范围<select data-item="${item.id}" data-prop="scope"><option value="common"${item.scope==='common'?' selected':''}>本版所有结算人员</option><option value="selected"${item.scope==='selected'?' selected':''}>指定人员</option></select></label><label class="field">方式<select data-item="${item.id}" data-prop="mode">${Object.entries(modes).map(([k,v])=>`<option value="${k}"${k===item.mode?' selected':''}>${v}</option>`).join('')}</select></label>${item.scope==='selected'||needsValues?`<div class="invoice-allocations">${selected.map(p=>{const info=ctx.roster.people.find(v=>v.id===p.id),a=alloc.get(p.id);return `<div class="invoice-allocation"><label class="check-option"><input type="checkbox" data-item="${item.id}" data-allocation="${p.id}" data-prop="selected"${item.scope==='common'||a?' checked':''}${item.scope==='common'?' disabled':''}>${esc(info.label||info.name)}</label>${needsValues?`<label class="field"><span class="sr-only">${esc(info.name)}${item.mode==='fixed'?'金额':item.mode==='duration'?'分钟':'比例'}</span><input inputmode="decimal"${item.scope==='selected'&&!a?' disabled':''} data-item="${item.id}" data-allocation="${p.id}" data-prop="${item.mode==='fixed'?'amount':item.mode==='duration'?'minutes':'weight'}" value="${esc(item.mode==='fixed'?(a?.amount||'0.00'):item.mode==='duration'?(a?.minutes??ctx.event.duration_hours*60??0):(a?.weight||'1'))}"></label>`:''}</div>`;}).join('')}</div>`:''}<label class="field">分摊依据${needsReason?'':'（选填）'}<textarea rows="2" maxlength="300" data-item="${item.id}" data-prop="reason"${needsReason?' required':''}>${esc(item.reason)}</textarea></label><p class="field-help">退款／减免填正金额，由系统扣减消费；不代表已实际退款。按时长分摊使用本项分钟数，不从出席状态推算。</p><p class="field-help">凭证与活动同样可见，每版最多三张。</p><label class="field">消费凭证（选填）<input type="file" accept="image/png,image/jpeg,image/webp" data-invoice-image="${item.id}"></label>${item.receipt?`<div class="invoice-image"><a href="${typeof item.receipt==='string'?'data:image/png;base64,'+item.receipt:receiptUrl(ctx.event.id,item.receipt.version,item.receipt.item_id)}" target="_blank" rel="noopener"><img alt="消费凭证预览" src="${typeof item.receipt==='string'?'data:image/png;base64,'+item.receipt:receiptUrl(ctx.event.id,item.receipt.version,item.receipt.item_id)}"></a><button class="text-button danger" type="button" data-invoice="remove-receipt" data-item="${item.id}">移除凭证</button></div>`:''}</details></section>`;
    }).join('');
  }
  function updatePersonSummary(person) {
    renderRosterSummary();
    const summary=$(`[data-invoice-person="${person.id}"]>summary>span:last-child`);if(!summary)return;
    const payer=ctx.roster.payers.concat(ctx.custom).find(p=>p.id===person.payments[0]?.payer_id);
    summary.textContent=(person.include?(person.share==='0'?'免共同 AA':person.share+' 份'):'不列入')+' · '+(person.payments.length>1?'多人合付':payer?.label||payer?.name||'请选择付款人');
  }
  function newItem() {return {id:id(),name:BoardI18n.defaultItemName,amount:'',kind:'expense',scope:'common',mode:'shares',reason:'',allocations:[],receipt:null};}
  async function open(e) {
    try{await BoardDrafts.detach('invoice-dialog');}catch(problem){toast(problem.message);return;}
    BoardAdvanced.set($('#invoice-dialog'));const opening=++serial;ctx=null;form().reset();$('#invoice-people').textContent='加载名单…';$('#invoice-items').innerHTML='';$('#invoice-preview').hidden=true;$('#publish-invoice').hidden=true;$('#preview-invoice').hidden=false;$('#preview-invoice').disabled=true;$('#invoice-reload').hidden=true;$('#invoice-form .form-error').textContent='';showDialog('invoice-dialog');
    try {
      const [roster,savedCodes]=await Promise.all([api(`/api/events/${e.id}/settlement/roster`),api('/api/payment-codes')]);if(opening!==serial)return;
      const bill=e.settlement,detailed=bill?.mode==='detailed',input=detailed?bill.detail.input:null;
      ctx={event:e,roster,rooms:clone(input?.rooms||roster.rooms||[]).map(r=>({...r,merchant_mode:roster.room_record_ids.includes(r.id)?'recorded':'unpaid',paid_amount:''})),custom:clone(input?.custom_payers||[]),busy:0,preview:null,imageSequence:{},people:roster.people.map(p=>{
        const old=input?.people.find(v=>v.id===p.id);
        return old?{...clone(old),include:true}:{id:p.id,share:'1',reason:'',include:!detailed&&p.status==='confirmed',payment_mode:'shares',payments:[{payer_id:p.payer_id,share:'1'}]};
      }),items:input?clone(input.items).map(v=>({...v,receipt:v.receipt_digest?{version:bill.version,item_id:v.id}:null})):[newItem()]};
      $('#invoice-legacy').hidden=!bill||detailed;$('#invoice-convert').hidden=!bill||detailed;
      $('#invoice-legacy').textContent=bill&&!detailed?`原人均结算 ¥${bill.total_amount} ÷ ${bill.headcount} 人，转换会新增版本，原账单不变。`:'';
      $('#invoice-reason-field').hidden=!bill;form().elements.reason.required=!!bill;
      form().elements.note.value=bill?.note||'';
      const ownCodes=bill?.publisher_key===roster.collector.id;
      codePicker.open(ownCodes?e:{...e,settlement:null},savedCodes.codes);
      $('#invoice-collector').textContent='本版收款人：'+roster.collector.name+'（当前发布账号）；请选择并核对本人的收款码。';
      $('#invoice-appoint').hidden=!e.is_owner||!!e.archived_at;
      form().elements.merchant_mode.value=roster.has_merchant_records?'recorded':'';
      form().elements.merchant_payer.innerHTML=payerOptions(roster.collector.id);
      form().elements.merchant_name.value=e.location;
      const local=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
      form().elements.merchant_time.value=local;
      form().elements.group_notice.checked=!!e.bot_enabled;
      form().elements.group_notice.disabled=!e.bot_enabled||e.visibility!=='public';
      $('#invoice-group-hint').textContent=e.bot_enabled?'发布预览中可核对群通知；实际发送结果请查看群同步记录。':'活动未开启公开群同步，本次不会发送群通知。';
      form().elements.room_mode.checked=detailed?!!bill.detail.rooms?.length:!!ctx.rooms.length;form().elements.room_mode.disabled=!e.is_owner&&!!ctx.rooms.length;roomMode();
      renderPeople();renderItems();$('#preview-invoice').disabled=false;
      await BoardDrafts.bind('invoice-dialog','invoice:'+e.id,
        ()=>({event:ctx.event,roster:ctx.roster,people:ctx.people,items:ctx.items,rooms:ctx.rooms,custom:ctx.custom,paymentCodes:codePicker.value(),fields:BoardDrafts.fields(form())}),data=>{
          if(data.roster.collector?.id!==ctx.roster.collector.id)return '草稿的发布账号已改变，请重新核对收款人与款项后填写';
          ctx={...ctx,event:data.event,roster:data.roster,people:data.people,items:data.items,rooms:data.rooms||[],custom:data.custom,preview:null,imageSequence:{},busy:0};
          BoardDrafts.fill(form(),data.fields);form().elements.reviewed_roster.checked=false;
          codePicker.restore(data.paymentCodes,data.qr);
          renderPeople();renderItems();roomMode();invalidate();
          if(data.event.revision!==e.revision){$('#invoice-reload').hidden=false;return '草稿基于旧版名单或账单；请保留需要的文字并载入最新版后重新核对';}
        },()=>!!ctx?.busy);
    }catch(problem){$('#invoice-form .form-error').textContent=problem.message;}
  }
  function merchantFields() {
    if(!ctx)return;
    const roomMode=form().elements.room_mode.checked,paid=roomMode?ctx.rooms.some(r=>r.merchant_mode==='paid'):form().elements.merchant_mode.value==='paid';
    const mode=form().elements.merchant_mode;mode.disabled=roomMode;mode.required=!roomMode;mode.closest('.field').hidden=roomMode;
    $('#invoice-merchant-fields').hidden=!paid;
    for(const key of ['merchant_payer','merchant_amount','merchant_name','merchant_time','merchant_method']){
      const visible=paid&&(!roomMode||['merchant_time','merchant_method'].includes(key)),field=form().elements[key];
      field.disabled=!visible;field.required=visible;field.closest('.field').hidden=!visible;
    }
  }
  form().elements.room_mode.addEventListener('change',()=>{roomMode();invalidate();});
  $('#invoice-appoint').addEventListener('click',async()=>{
    if(!ctx||ctx.busy)return;
    try{await BoardDrafts.detach('invoice-dialog');$('#invoice-dialog').close();document.querySelector('[data-activity="appoint_settlement"]')?.click();}
    catch(problem){$('#invoice-form .form-error').textContent=problem.message;}
  });
  form().elements.merchant_mode.addEventListener('change',merchantFields);
  function payload() {
    const people=ctx.people.filter(p=>p.include).map(p=>{const {include,...rest}=p;return clone(rest);});
    const items=settlementItemsPayload(ctx.items,people,ctx.event.duration_hours);
    const data={people,items,custom_payers:ctx.custom,note:form().elements.note.value.trim(),reason:form().elements.reason.value.trim(),base_revision:ctx.event.revision,base_version:ctx.event.settlement?.version||0,reviewed_roster:form().elements.reviewed_roster.checked,convert_legacy:form().elements.convert_legacy.checked};
    data.rooms=form().elements.room_mode.checked?clone(ctx.rooms):[];
    if(form().elements.room_mode.checked&&!data.rooms.length)throw new Error('请至少建立一个实际包间');
    data.payment_codes=data.rooms.length?[]:codePicker.value();
    data.group_notice=form().elements.group_notice.checked&&!form().elements.group_notice.disabled;
    if(data.rooms.length){
      if(ctx.rooms.some(r=>r.merchant_mode==='paid'))data.room_payment_details={occurred_at:new Date(form().elements.merchant_time.value).toISOString(),method:form().elements.merchant_method.value};
      return data;
    }
    data.merchant_payment={mode:form().elements.merchant_mode.value};
    if(data.merchant_payment.mode==='paid')Object.assign(data.merchant_payment,{payer_id:form().elements.merchant_payer.value,amount:form().elements.merchant_amount.value.trim(),merchant:form().elements.merchant_name.value.trim(),occurred_at:new Date(form().elements.merchant_time.value).toISOString(),method:form().elements.merchant_method.value});
    return data;
  }
  function body(bill,eventId,imageUrl) {
    const d=bill.detail,personName=uid=>d.people.find(p=>p.id===uid)?.name||'参加者';
    const balances=!d.rooms&&d.balances?`<div class="invoice-breakdown invoice-balances"><h3>本版发布时待补／应退</h3>${d.balances.map(p=>`<p><span>${esc(p.label||p.name)} · AA ¥${centsText(p.due_cents)} · 已投入 ¥${centsText(p.contributed_cents)}</span><strong>${p.balance_cents>0?'待补 ¥'+centsText(p.balance_cents):p.balance_cents<0?'应退／待偿还 ¥'+centsText(-p.balance_cents):'无需补款'}</strong></p>`).join('')}<p class="field-help">后续收退款以收付款账本为准。</p></div>`:'';
    const roomBody=d.room_balances?'<div class="invoice-breakdown"><h3>按包间转款明细</h3>'+roomTransfersBody(d.room_balances,esc,centsText)+'<p class="field-help">以上为发布时快照；实际收付后以收付款账本的包间明细为准。</p></div>':'';
    return `${roomBody}${d.collector?`<p class="activity-alert">本版收款人：${esc(d.collector.name)}</p>`:''}${balances}<p class="settlement-amount">总费用<strong>¥${centsText(d.total_cents)}</strong></p><p class="settlement-details">${d.people.length} 位结算人员 · ${bill.version?'第 '+bill.version+' 版':'待发布'}</p><details class="invoice-breakdown invoice-payers"><summary>付款明细</summary>${d.payers.map(p=>`<p><span>${esc(p.label||p.name)}</span><strong>¥${centsText(p.amount_cents)}</strong></p>`).join('')||'<p>无需付款</p>'}</details><details class="invoice-breakdown"><summary>逐人应付与分摊明细</summary>${d.people.map(p=>`<details class="invoice-person"><summary><span>${esc(p.label||p.name)}${p.share==='0'?' · 免共同 AA':''}</span><strong>¥${centsText(p.due_cents)}</strong></summary><p class="field-help">${names[p.status]} · ${attendance[p.attendance]} · 已接受约定第 ${p.accepted_conditions_version||'—'} 版</p><details class="event-policy"><summary>已接受的费用约定</summary><p>${esc(p.accepted_arrangement?.fee_policy||'原记录未填写费用规则')}</p></details><p class="field-help">共同 AA ${esc(p.share)} 份${p.reason?' · '+esc(p.reason):''}</p>${p.allocations.map(a=>`<p class="invoice-line"><span>${esc(d.items.find(i=>i.id===a.item_id)?.name)}</span><span>¥${centsText(a.amount_cents)}</span></p>`).join('')}<p class="field-help">${p.payments.map(v=>esc(v.label||v.name)+' ¥'+centsText(v.amount_cents)).join('、')}</p></details>`).join('')}</details><details class="invoice-breakdown"><summary>费用项目与消费凭证</summary>${d.items.map(item=>`<details class="invoice-person"><summary><span>${esc(item.name)} · ${kinds[item.kind]}</span><strong>¥${centsText(item.amount_cents)}</strong></summary><p class="field-help">${modes[item.mode]}${item.reason?' · '+esc(item.reason):''}</p>${item.breakdown.map(a=>`<p class="invoice-line"><span>${esc(personName(a.person_id))}${item.mode==='duration'?' · '+a.minutes+' 分钟':item.mode==='weights'?' · '+esc(a.weight)+' 份':''}</span><span>¥${centsText(a.amount_cents)}</span></p>`).join('')}${item.has_receipt&&bill.version?`<a class="invoice-image" href="${receiptUrl(eventId,bill.version,item.id)}" target="_blank" rel="noopener"><img src="${receiptUrl(eventId,bill.version,item.id)}" loading="lazy" alt="${esc(item.name)}消费凭证"></a>`:''}</details>`).join('')}<p class="field-help">${esc(d.rounding_rule)}</p></details>${d.note?`<p class="settlement-note">${esc(d.note)}</p>`:''}${d.reason?`<p class="field-help">本版原因：${esc(d.reason)}</p>`:''}${d.changes?.length?`<details class="invoice-breakdown"><summary>本版更改</summary>${d.changes.map(change=>`<p class="field-help">${esc(change)}</p>`).join('')}</details>`:''}${settlementCodeCards(bill,esc)}`;
  }
  form().addEventListener('input',event=>{
    if(!ctx||event.target.matches('[data-advanced-toggle]'))return;invalidate();const el=event.target,uid=el.dataset.person,itemId=el.dataset.item,prop=el.dataset.prop;
    if(uid){const p=ctx.people.find(p=>p.id===uid);if(el.dataset.payment!==undefined)p.payments[Number(el.dataset.payment)][prop]=el.value;else if(prop)p[prop]=el.type==='checkbox'?el.checked:el.value;updatePersonSummary(p);}
    if(itemId){const item=ctx.items.find(v=>v.id===itemId);if(el.dataset.allocation){const person_id=el.dataset.allocation;let a=item.allocations.find(v=>v.person_id===person_id);if(!a){a={person_id};item.allocations.push(a);}if(prop==='selected'&&!el.checked)item.allocations=item.allocations.filter(v=>v.person_id!==person_id);else if(prop!=='selected')a[prop]=prop==='minutes'?Number(el.value):el.value;}else if(prop)item[prop]=el.value;}
  });
  form().addEventListener('input',()=>{if(ctx)renderRosterSummary();});
  form().addEventListener('change',async event=>{
    if(!ctx)return;const el=event.target,uid=el.dataset.person,itemId=el.dataset.item,prop=el.dataset.prop;
    if(el.dataset.invoiceImage!==undefined){
      const imageKey=el.dataset.invoiceImage,current=ctx,generation=(ctx.imageSequence[imageKey]||0)+1;ctx.imageSequence[imageKey]=generation;ctx.busy++;$('#preview-invoice').disabled=true;$('#publish-invoice').disabled=true;
      try{const file=el.files[0];if(!file)return;const prepared=(await prepareCode(file)).split(',')[1];if(ctx!==current||ctx.imageSequence[imageKey]!==generation)return;
        {const target=ctx.items.find(v=>v.id===imageKey);if(!target)return;target.receipt=prepared;renderItems();}invalidate();
      }catch(problem){if(ctx===current){el.value='';$('#invoice-form .form-error').textContent=problem.message;}}
      finally{BoardDrafts.touch('invoice-dialog');current.busy--;if(ctx===current){$('#preview-invoice').disabled=!!ctx.busy;$('#publish-invoice').disabled=!!ctx.busy;}}
      return;
    }
    if(itemId&&el.dataset.allocation&&prop==='selected')renderItems();
    if(uid&&prop==='include'){renderPeople();renderItems();if(form().elements.room_mode.checked)roomEditor.render();}
    if(uid&&prop==='payment_mode')renderPeople();
    if(itemId&&['scope','mode','kind'].includes(prop)){
      const item=ctx.items.find(v=>v.id===itemId);
      if(prop==='scope'&&item.scope==='selected'&&!item.allocations.length)item.allocations=ctx.people.filter(p=>p.include).map(p=>({person_id:p.id}));
      renderItems();
    }
  });
  form().addEventListener('invalid',event=>{let parent=event.target.parentElement;while(parent&&parent!==form()){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}},true);
  form().addEventListener('submit',async event=>{
    event.preventDefault();if(!ctx||ctx.busy||!BoardDrafts.ready('invoice-dialog'))return;const current=ctx,at=serial;$('#preview-invoice').disabled=true;
    try {
      if(await BoardClient.hasPending(ctx.event.id))throw new Error('先在消息的「待确认操作」查询上次结果，再核对最新账本');
      const data=payload(),preview=await api(`/api/events/${ctx.event.id}/settlement/preview`,'POST',data);
      if(ctx!==current||at!==serial)return;
      ctx.preview={data:{...data,preview_token:preview.preview_token},snapshot:preview.snapshot};
      $('#invoice-preview').innerHTML='<h3>发布预览</h3>'+body({detail:preview.snapshot,payment_codes:codePicker.cards(),has_qr:false},ctx.event.id,'')+(preview.snapshot.group_notice?'<h3>QQ 群通知预览</h3><p class="settlement-note">'+esc(preview.group_preview||'')+'</p><p class="field-help">上述所选收款码将逐张发送到群；未提供则只发送文字。</p>':'')+'<p class="field-help">发布将登记本次明确确认的店家垫付；其他收退款请在收付款账本登记。</p>';
      $('#invoice-preview').hidden=false;$('#publish-invoice').hidden=false;$('#preview-invoice').hidden=true;$('#publish-invoice').focus();
    }catch(problem){$('#invoice-form .form-error').textContent=problem.message;$('#invoice-reload').hidden=problem.status!==409;}
    finally{if(ctx===current)$('#preview-invoice').disabled=false;}
  });
  $('#publish-invoice').addEventListener('click',async()=>{
    if(!ctx?.preview||ctx.busy)return;const current=ctx;$('#publish-invoice').disabled=true;form().inert=true;
    try {
      const updated=await api(`/api/events/${ctx.event.id}/settlement/detailed`,'PUT',ctx.preview.data);
      if(ctx===current){await BoardDrafts.clear('invoice-dialog');$('#invoice-dialog').close();}renderDetail(updated);await refresh({detail:false});toast('逐人结算已发布');
    }catch(problem){$('#invoice-form .form-error').textContent=problem.message;$('#invoice-reload').hidden=problem.status!==409;}
    finally{form().inert=false;if(ctx===current)$('#publish-invoice').disabled=false;}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-invoice]');if(!button||!ctx)return;
    const action=button.dataset.invoice;
    if(action==='reload'){
      try{const latest=await api('/api/events/'+ctx.event.id);await BoardDrafts.clear('invoice-dialog');await open(latest);}catch(problem){$('#invoice-form .form-error').textContent=problem.message;}return;
    }
    invalidate();
    if(action==='add-item'){if(ctx.items.length>=50){toast('最多 50 项费用');return;}ctx.items.push(newItem());renderItems();}
    if(action==='remove-item'){ctx.items=ctx.items.filter(v=>v.id!==button.dataset.item);renderItems();}
    if(action==='remove-receipt'){ctx.imageSequence[button.dataset.item]=(ctx.imageSequence[button.dataset.item]||0)+1;ctx.items.find(v=>v.id===button.dataset.item).receipt=null;renderItems();}
    if(action==='add-payment'){const p=ctx.people.find(v=>v.id===button.dataset.person);p.payments.push({payer_id:ctx.roster.payers.find(v=>!p.payments.some(a=>a.payer_id===v.id))?.id||'',share:'1',amount:'0.00'});renderPeople();}
    if(action==='remove-payment'){const p=ctx.people.find(v=>v.id===button.dataset.person);if(p.payments.length>1){p.payments.splice(Number(button.dataset.index),1);renderPeople();}}
    BoardDrafts.touch('invoice-dialog');
    if(action==='add-custom'){
      const name=$('#invoice-custom-name').value.trim();if(!name){toast('请填写付款人称呼');return;}
      ctx.custom.push({id:'custom:'+id(),name});if(form().elements.room_mode.checked)roomEditor.render();form().elements.merchant_payer.innerHTML=payerOptions(form().elements.merchant_payer.value);$('#invoice-custom-name').value='';renderPeople();toast('付款人已加入，可在人员付款归属中选择');
    }
  });
  return {open,body};
}
