'use strict';
// Track system controls, never labels, field values, record IDs or credentials.
window.BoardAnalytics=(()=>{
  const pending=[],inputTimers=new WeakMap();
  const knownIds=new Set([...document.querySelectorAll('[id]')].map(el=>el.id));
  const knownNames=new Set([...document.querySelectorAll('[name]')].map(el=>el.name));
  for(const id of ['join-form','load-more-history','finance-custom-name','finance-more','accept-device','authorize-device','claim-payment','claim-person','device-link','qq-confirm','privacy-consent','register-nickname'])knownIds.add(id);
  for(const name of ['accept_partial','guest_name','guest_note','guest_payer','actual_party_id','actual_reason','custodian_id','from_id','funder_id','funding','merchant','method','occurred_at','payer_id','reference_id','to_id'])knownNames.add(name);
  const actions={
    action:'create browse',
    'detail-action':'share copy summary select-share edit settle settlement-history finance finance-report finish toggle cancel-registration cancel-event remove',
    'roster-action':'add tentative invite manage history more-history copy-invitation',
    activity:'attendance cancel conditions copy_role formation management onsite revoke_invite revoke_role start edit publish',
    finance:'accept add-party close more more-reports record reject reopen report reverse withdraw refresh reload',
    invoice:'add-custom add-item reload add-payment remove-item remove-payment remove-receipt',
    identity:'accept-device account copy-device existing-signup issue-device qq-bind qq-finish qq-login request-claim close-account logout name-register',
    draft:'discard restore',
    'claim-decision':'approve reject revoke',
    filter:'mine past upcoming',
    prop:'amount include kind mode name payer_id payment_mode reason scope selected share minutes weight',
  };
  const markers=['event','todo-event','notification-event','operation-retry','operation','remove-guest','account-scope','revoke-device','claim-copy','code-archive','code-import','code-name','code-select','code-upload','library-remove','invoice-image','advanced-toggle','privacy-request'];
  const classes=new Set('guide-section guide-topic extra-settings event-policy invoice-breakdown invoice-payers invoice-person note-options payment-code-link invoice-image image-retry'.split(' '));
  const routeWords=new Set('api events profile account qq start finish switch link accept revoke notifications read access roster preview parties invitations management roles attendees conditions withdrawal attendance onsite registration settlement detailed finance claims request payment-codes auth register close logout admin login session settings privacy-review'.split(' '));
  let previousPage='',routeKey='',retryTimer=null,retries=0;
  function route() {
    const url=new URL(location.href);
    const pages={'/guide.html':'guide','/privacy':'privacy','/contact':'contact','/admin':'admin','/auth/qq/callback':'qq-callback'};
    const page=pages[url.pathname]||(url.searchParams.has('event')?'event':'board');
    return {page,url:page==='event'?'/event':page==='board'?'/':url.pathname,title:'Kanban '+page,key:page+':'+(page==='event'?url.searchParams.get('event'):'')};
  }
  function flush() {
    if(typeof window.umami?.track!=='function')return;
    clearTimeout(retryTimer);retryTimer=null;
    for(const entry of pending.splice(0)) {
      try {
        Promise.resolve(window.umami.track(payload=>({...payload,url:entry.url,title:entry.title,referrer:entry.referrer,
          ...(entry.name?{name:entry.name,data:entry.data}:{})}))).catch(()=>{});
      }catch{} // Analytics must never interrupt a user action.
    }
  }
  function enqueue(entry) {
    if(pending.length>=100)pending.shift();
    pending.push(entry);flush();
    if(pending.length)enqueueRetry();
  }
  function enqueueRetry() {
    if(!retryTimer&&retries<30)retryTimer=setTimeout(()=>{retryTimer=null;retries++;flush();if(pending.length)enqueueRetry();},1000);
  }
  function track(name,data={}) {
    const current=route();
    enqueue({...current,referrer:previousPage,name,data:{page:current.page,language:document.documentElement.lang,...data}});
  }
  function pageview() {
    const current=route();
    if(current.key===routeKey)return;
    enqueue({...current,referrer:previousPage});
    routeKey=current.key;previousPage=current.url;
  }
  function context(el) {
    const parent=el.closest('dialog,form,.guide-section,header,footer');
    return parent?(knownIds.has(parent.id)?parent.id:parent.tagName.toLowerCase()):'page';
  }
  function control(el) {
    for(const [attribute,values] of Object.entries(actions)) {
      const value=el.getAttribute('data-'+attribute);
      if(value&&values.split(' ').includes(value))return attribute+':'+value;
    }
    if(el.hasAttribute('data-close'))return 'close:'+(knownIds.has(el.dataset.close)?el.dataset.close:'dialog');
    for(const marker of markers)if(el.hasAttribute('data-'+marker))return marker;
    if(knownIds.has(el.id))return el.id;
    if(knownNames.has(el.name))return 'field:'+el.name;
    for(const name of el.classList)if(classes.has(name))return name;
    if(el.tagName==='A') {
      if(el.closest('.payment-code-link'))return 'payment-code';
      if(el.closest('.invoice-image'))return 'receipt';
      // Only classify destinations; do not send hrefs or link text.
      const href=el.getAttribute('href')||'';
      return {'/guide.html':'guide-link','/':'board-link','/privacy':'privacy-link','/contact':'contact-link','/admin':'admin-link'}[href]||'link';
    }
    return el.tagName.toLowerCase()+(el.type?':'+el.type:'');
  }
  function details(el) {
    return {control:control(el),context:context(el)};
  }
  document.addEventListener('click',event=>{
    const el=event.target.closest?.('button,a,input[type=button],input[type=submit],[role=button]');
    if(!el||el.disabled||el.closest('[inert]'))return;
    track('ui_click',details(el));
  },true);
  document.addEventListener('submit',event=>{
    track('ui_submit',{...details(event.target),submitter:event.submitter?control(event.submitter):'keyboard'});
  },true);
  document.addEventListener('change',event=>{
    const el=event.target;
    if(!el.matches('input,select,textarea')||['hidden','password'].includes(el.type))return;
    // A committed change replaces the pending input event for the same edit.
    clearTimeout(inputTimers.get(el));
    track('ui_change',{...details(el),...(el.type==='checkbox'||el.type==='radio'?{checked:el.checked}:{})});
  },true);
  document.addEventListener('input',event=>{
    const el=event.target;
    if(!el.matches('input,textarea')||['hidden','password','checkbox','radio','file'].includes(el.type))return;
    clearTimeout(inputTimers.get(el));
    const data=details(el);
    inputTimers.set(el,setTimeout(()=>track('ui_input',data),1000));
  },true);
  document.addEventListener('invalid',event=>{if(event.target.type!=='password')track('ui_invalid',details(event.target));},true);
  // Details and dialogs may be created later or opened without a button click.
  document.addEventListener('toggle',event=>{
    if(event.target.tagName==='DETAILS')track(event.target.open?'ui_expand':'ui_collapse',details(event.target));
  },true);
  document.addEventListener('cancel',event=>{
    if(event.target.tagName==='DIALOG')track('dialog_cancel',details(event.target));
  },true);
  new MutationObserver(records=>{
    for(const record of records)if(record.type==='attributes'&&record.target.tagName==='DIALOG'&&record.target.hasAttribute('open')!==(record.oldValue!==null)) {
      track(record.target.open?'dialog_open':'dialog_close',details(record.target));
    }
  }).observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:['open'],attributeOldValue:true});
  for(const method of ['pushState','replaceState']) {
    const original=history[method];
    history[method]=function(...args){const result=original.apply(this,args);pageview();return result;};
  }
  window.addEventListener('popstate',pageview);
  window.addEventListener('pageshow',event=>{if(event.persisted){routeKey='';pageview();}});
  document.addEventListener('load',event=>{if(event.target.tagName==='SCRIPT')flush();},true);
  function request(path,method,status,outcome) {
    if(method==='GET')return; // Do not count background refreshes as interactions.
    const pathname=path.split('?')[0];
    const operation=pathname.startsWith('/api/')?pathname.split('/').map(part=>!part||routeWords.has(part)?part:':id').join('/'):'unknown';
    track('api_result',{operation,method,status,outcome});
  }
  pageview();
  return {request};
})();
