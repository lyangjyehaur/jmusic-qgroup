'use strict';
const PaymentCodeKinds={wechat:"微信",alipay:"支付寶",other:'其他'};
function settlementCodeCards(bill,esc,showActions=true) {
  const codes=bill.payment_codes||[];
  if(!codes.length)return '';
  return `<div class="settlement-codes" data-count="${codes.length}">${codes.map(code=>`<div class="settlement-code"><p class="code-label"><strong>${PaymentCodeKinds[code.kind]||PaymentCodeKinds.other}</strong>${code.name?' · '+esc(code.name):''}</p><a class="payment-code-link" href="${esc(code.url)}" target="_blank" rel="noopener"><img src="${esc(code.url)}" alt="${PaymentCodeKinds[code.kind]||PaymentCodeKinds.other}收款碼"></a>${showActions?`<p class="payment-code-hint">長按識別<br><a href="${esc(code.url)}" target="_blank" rel="noopener">查看原圖</a> · <a href="${esc(code.url)}" download="${PaymentCodeKinds[code.kind]||PaymentCodeKinds.other}收款碼.png">保存原圖</a></p>`:''}</div>`).join('')}</div>`;
}
function createPaymentCodePicker({api,$,esc,prepareCode,askConfirm,onChange,startBusy,onError}) {
  const container=$('#invoice-code-picker');
  let event=null,library=[],selected=[],epoch=0;
  const copy=value=>JSON.parse(JSON.stringify(value));
  function descriptor(choice) {
    if(choice.code_id)return library.find(code=>code.id===choice.code_id)||{name:'',url:''};
    if(choice.image)return {name:choice.name||'',url:'data:image/png;base64,'+choice.image};
    const current=(event.settlement?.payment_codes||[]).find(code=>code.kind===choice.kind);
    return {name:current?.name||'',url:choice.version===event.settlement?.version&&current?current.url:`/api/events/${event.id}/settlement/history/${choice.version}/payment-codes/${choice.kind}`};
  }
  function render() {
    const opened=!!container.querySelector('[data-code-options][open]');
    const controls=Object.entries(PaymentCodeKinds).map(([kind,label])=>{
      const choice=selected.find(code=>code.kind===kind);
      const options=library.filter(code=>code.kind===kind);
      const current=(event.settlement?.payment_codes||[]).find(code=>code.kind===kind);
      const chosen=choice?.code_id|| (choice?'current':'');
      return `<section class="code-kind"><h4>${label}</h4><label class="field">${label}收款碼<select data-code-select="${kind}"><option value="">不提供</option>${current||choice&&!choice.code_id?`<option value="current"${chosen==='current'?' selected':''}>${choice?.image?"本次上傳的收款碼":"保留本版收款碼"}</option>`:''}${choice?.code_id&&!options.some(code=>code.id===choice.code_id)?`<option value="${choice.code_id}" selected>原選擇已移除，請重新選擇</option>`:''}${options.map((code,index)=>`<option value="${code.id}"${chosen===code.id?' selected':''}>${esc(code.name||("未命名 "+(index+1)+' · '+new Intl.DateTimeFormat(BoardI18n.locale,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(code.created_at))))}</option>`).join('')}</select></label>${choice?.code_id?`<button type="button" class="text-button danger" data-code-archive="${choice.code_id}">從我的收款碼移除</button>`:choice?`<button type="button" class="text-button" data-code-import="${kind}">保存到個人資料</button>`:''}<details class="extra-settings"><summary>上傳新碼</summary><label class="field">名稱（選填）<input maxlength="40" data-code-name="${kind}" autocomplete="off"></label><label class="field">${label}收款碼圖片<input type="file" accept="image/png,image/jpeg,image/webp" data-code-upload="${kind}"></label><p class="field-help">上傳後可選保存到個人資料，或僅用於本次結算。</p></details></section>`;
    }).join('');
    container.innerHTML=(settlementCodeCards({payment_codes:cards()},esc,false)||"<p class=\"field-help\">未提供收款碼</p>")+`<details class="extra-settings code-options" data-code-options${opened?' open':''}><summary>選擇／上傳收款碼</summary>${controls}</details>`;
  }
  function changed(){render();onChange();}
  function open(activity,codes) {
    epoch++;event=activity;library=copy(codes);selected=(activity.settlement?.payment_codes||[]).map(code=>({kind:code.kind,version:activity.settlement.version}));
    // Old bills have a single unclassified code and use the legacy image route.
    container.innerHTML='';render();
  }
  function restore(value,legacy) {
    if(Array.isArray(value))selected=copy(value);
    else if(legacy!==undefined)selected=legacy?[{kind:'other',image:legacy}]:[];
    render();
  }
  function value(){return copy(selected).sort((a,b)=>Object.keys(PaymentCodeKinds).indexOf(a.kind)-Object.keys(PaymentCodeKinds).indexOf(b.kind));}
  function cards(){return selected.map(choice=>({kind:choice.kind,...descriptor(choice)})).filter(code=>code.url);}
  container.addEventListener('change',async change=>{
    const el=change.target,kind=el.dataset.codeSelect;
    if(kind){
      const prior=selected.find(code=>code.kind===kind),keep=prior&&!prior.code_id?prior:{kind,version:event.settlement?.version};
      selected=selected.filter(code=>code.kind!==kind).concat(el.value==='current'?[keep]:el.value?[{kind,code_id:el.value}]:[]);changed();return;
    }
    const uploadKind=el.dataset.codeUpload,file=el.files?.[0];
    if(!uploadKind||!file)return;
    const at=epoch,finish=startBusy(),name=container.querySelector(`[data-code-name="${uploadKind}"]`).value.trim();container.inert=true;
    try {
      const image=(await prepareCode(file)).split(',')[1];if(at!==epoch)return;
      const choice={kind:uploadKind,name,image};
      selected=selected.filter(old=>old.kind!==uploadKind).concat(choice);changed();
      askConfirm("保存到個人資料？","收款碼已加入本次結算。保存後下次可直接選用，也可以僅用於本次結算。",()=>saveChoice(choice,at),{confirm:"保存到資料",cancel:"僅本次使用"});
    }catch(problem){if(at===epoch){el.value='';onError(problem);}}
    finally{if(at===epoch)container.inert=false;finish();}
  });
  async function saveChoice(choice,at) {
    if(at!==epoch||!selected.includes(choice))return;
    const finish=startBusy();container.inert=true;
    try {
      const {kind}=choice;
      const data=choice.image?{kind,name:choice.name||'',image:choice.image}:{kind,name:descriptor(choice).name,source:{event_id:event.id,version:choice.version,kind}};
      const code=await api('/api/payment-codes','POST',data);if(at!==epoch)return;
      library=[code,...library.filter(old=>old.id!==code.id)];selected=selected.filter(old=>old.kind!==kind).concat({kind,code_id:code.id});changed();
    }catch(problem){if(at===epoch)onError(problem);}
    finally{if(at===epoch)container.inert=false;finish();}
  }
  container.addEventListener('click',async click=>{
    const archive=click.target.closest('[data-code-archive]'),save=click.target.closest('[data-code-import]');
    if(!archive&&!save)return;
    const at=epoch;
    if(save)return saveChoice(selected.find(code=>code.kind===save.dataset.codeImport),at);
    async function act(){
      if(at!==epoch)return;
      const finish=startBusy();container.inert=true;
      try {
        if(archive){
          await api('/api/payment-codes/'+archive.dataset.codeArchive,'DELETE',{});if(at!==epoch)return;
          library=library.filter(code=>code.id!==archive.dataset.codeArchive);
          // Only the unsaved selection clears; published versions keep their own reference.
          selected=selected.filter(code=>code.code_id!==archive.dataset.codeArchive);changed();
        }
      }catch(problem){if(at===epoch)onError(problem);}
      finally{if(at===epoch)container.inert=false;finish();}
    }
    askConfirm("從我的收款碼移除？","已發佈的結算和歷史圖片會保留。當前未發佈的選擇將清空。",act);
  });
  return {open,restore,value,cards};
}

function createPaymentCodeLibraryUI({api,$,esc,prepareCode,askConfirm,toast}) {
  const dialog=$('#profile-dialog'),form=$('#payment-library-form'),list=$('#payment-library-list'),error=$('#payment-library-error');
  let codes=[],epoch=0;
  const report=problem=>{error.textContent=problem.message;};
  function render() {
    $('#payment-library-count').textContent=String(codes.length);
    list.innerHTML=codes.map(code=>`<div class="library-code"><a href="${esc(code.url)}" target="_blank" rel="noopener"><img src="${esc(code.url)}" alt="${PaymentCodeKinds[code.kind]||PaymentCodeKinds.other}收款碼" loading="lazy"></a><div><strong>${PaymentCodeKinds[code.kind]||PaymentCodeKinds.other}</strong><p>${esc(code.name||"未命名")}</p></div><button type="button" class="text-button danger" data-library-remove="${code.id}" aria-label="移除${PaymentCodeKinds[code.kind]||PaymentCodeKinds.other}收款碼${code.name?' '+esc(code.name):''}">移除</button></div>`).join('')||"<p class=\"field-help\">還沒有收款碼，可在下方上傳。</p>";
  }
  async function open() {
    const at=++epoch;codes=[];form.reset();form.inert=true;$('#payment-library-save').disabled=true;error.textContent='';$('#payment-library-count').textContent='';list.textContent="加載中…";
    try{const result=await api('/api/payment-codes');if(at!==epoch)return;codes=result.codes;render();}catch(problem){if(at===epoch){list.innerHTML="<button type=\"button\" class=\"text-button\" data-library-retry>重新加載收款碼</button>";report(problem);}}
    finally{if(at===epoch){form.inert=false;$('#payment-library-save').disabled=false;}}
  }
  dialog.addEventListener('close',()=>{epoch++;});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(form.inert)return;
    const at=epoch,file=form.elements.image.files[0],kind=form.elements.kind.value,name=form.elements.code_name.value.trim();
    if(!file)return;form.inert=true;$('#payment-library-save').disabled=true;error.textContent='';
    try {
      const image=(await prepareCode(file)).split(',')[1];if(at!==epoch)return;
      const code=await api('/api/payment-codes','POST',{kind,name,image});if(at!==epoch)return;
      codes=[code,...codes.filter(old=>old.id!==code.id)];form.reset();render();toast("收款碼已保存到個人資料");
    }catch(problem){if(at===epoch)report(problem);}
    finally{if(at===epoch){form.inert=false;$('#payment-library-save').disabled=false;}}
  });
  list.addEventListener('click',event=>{
    if(event.target.closest('[data-library-retry]'))return open();
    const remove=event.target.closest('[data-library-remove]');if(!remove)return;
    const at=epoch;
    askConfirm("移除這張收款碼？","個人資料中將不再列出這張碼，已發佈的結算及歷史圖片保留。",async()=>{
      if(at!==epoch)return;remove.disabled=true;error.textContent='';
      try{await api('/api/payment-codes/'+remove.dataset.libraryRemove,'DELETE',{});if(at!==epoch)return;codes=codes.filter(code=>code.id!==remove.dataset.libraryRemove);render();toast("已從個人資料移除");}
      catch(problem){if(at===epoch){remove.disabled=false;report(problem);}}
    });
  });
  return {open};
}
