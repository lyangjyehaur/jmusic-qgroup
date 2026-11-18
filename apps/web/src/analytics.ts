import { ANALYTICS_HOST, ANALYTICS_ORIGIN, ANALYTICS_WEBSITE } from '@qgroup/contracts';
import { analyticsManifest } from './analytics-manifest';
type EventName = 'ui_click'|'ui_submit'|'ui_input'|'ui_change'|'ui_invalid'|'ui_expand'|'ui_collapse'|'dialog_open'|'dialog_close'|'dialog_cancel'|'api_result';
type Data = Record<string,string|number|boolean>;
type Entry = {url:string;title:string;referrer:string;name?:EventName;data?:Data};
type TrackerWindow = Window & Pick<typeof globalThis,'Element'|'MutationObserver'> & { umami?: {track:(render:(base:unknown)=>Record<string,unknown>)=>unknown} };
const knownControls = new Set<string>(analyticsManifest.controls);
const matchers = (paths:readonly string[]) => [...paths].sort((a,b)=>(a.match(/:[^/]+/g)?.length??0)-(b.match(/:[^/]+/g)?.length??0)||b.length-a.length).map(path=>({path,pattern:new RegExp('^'+path.split('/').map(part=>part.startsWith(':')?'[^/]+':part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/')+'$')}));
const routeMatchers=matchers(analyticsManifest.routes), operationMatchers=matchers(analyticsManifest.operations);
export function analyticsRoute(pathname:string) { return routeMatchers.find(item=>item.pattern.test(pathname))?.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g,':id')??'/unknown'; }
export function analyticsOperation(path:string) { return operationMatchers.find(item=>item.pattern.test(path.split(/[?#]/)[0]!))?.path??'unknown'; }
export function safeAnalyticsPayload(entry:Entry,screen:{width:number;height:number},language:string) {
  const dimension=(value:number)=>Number.isInteger(value)&&value>0&&value<100000?value:0;
  const url=analyticsRoute(entry.url),locale=language==='zh-Hans'?'zh-Hans':'zh-Hant',data:Data={page:url,language:locale};
  const control=(value:unknown):value is string=>typeof value==='string'&&(knownControls.has(value)||['a','button','form','details','dialog','summary','control','keyboard','field:text','field:number','field:checkbox','field:radio','field:file','field:email','field:search','field:date','field:datetime-local','field:textarea','field:select'].includes(value)||(value.startsWith('field:')&&knownControls.has(value.slice(6))));
  for(const [key,value] of Object.entries(entry.data??{})) {
    if(['control','submitter'].includes(key)&&control(value))data[key]=value;
    if(key==='context'&&typeof value==='string'&&(knownControls.has(value)||['dialog','form','header','footer','main','page'].includes(value)))data[key]=value;
    if(key==='checked'&&typeof value==='boolean')data[key]=value;
    if(key==='operation'&&typeof value==='string'&&(value==='unknown'||analyticsManifest.operations.some(path=>path===value)))data[key]=value;
    if(key==='method'&&typeof value==='string'&&['POST','PUT','PATCH','DELETE'].includes(value))data[key]=value;
    if(key==='status'&&typeof value==='number'&&Number.isInteger(value)&&(value===0||value>=100&&value<=599))data[key]=value;
    if(key==='outcome'&&typeof value==='string'&&['success','rejected','network_error','parse_error'].includes(value))data[key]=value;
  }
  const name=entry.name&&['ui_click','ui_submit','ui_input','ui_change','ui_invalid','ui_expand','ui_collapse','dialog_open','dialog_close','dialog_cancel','api_result'].includes(entry.name)?entry.name:undefined;
  return {website:ANALYTICS_WEBSITE,hostname:new URL(ANALYTICS_ORIGIN).hostname,screen:dimension(screen.width)+'x'+dimension(screen.height),language:locale,url,title:'Qgroup '+url,referrer:entry.referrer?analyticsRoute(entry.referrer):'',...(name?{name,data}: {})};
}
let current: {page:(pathname:string)=>void;request:(path:string,method:string,status:number,outcome:string)=>void;stop:()=>void}|undefined;
export function analyticsPage(pathname:string) { try { current?.page(pathname); } catch { /* Statistics cannot block navigation. */ } }
export function analyticsRequest(path:string,method:string,status:number,outcome:'success'|'rejected'|'network_error'|'parse_error') { try { current?.request(path,method,status,outcome); } catch { /* Preserve the original request result. */ } }

export function startAnalytics(win:TrackerWindow=window,doc:Document=document) {
  if(win.location.origin!==ANALYTICS_ORIGIN) return ()=>{};
  current?.stop();
  let stopped=false,previous='',key='',retry:ReturnType<typeof setTimeout>|undefined,retries=0,dialogs=0;
  let observer:MutationObserver|undefined;
  const pending:Entry[]=[],timers=new Map<EventTarget,ReturnType<typeof setTimeout>>(),listeners:Array<()=>void>=[];
  function listen(target:EventTarget,name:string,fn:EventListener) { target.addEventListener(name,fn,true);listeners.push(()=>target.removeEventListener(name,fn,true)); }
  function flush() {
    if(stopped||typeof win.umami?.track!=='function')return;
    clearTimeout(retry);retry=undefined;
    for(const entry of pending.splice(0)) {
      try { Promise.resolve(win.umami.track(()=>safeAnalyticsPayload(entry,win.screen,doc.documentElement.lang))).catch(()=>{}); } catch { /* A blocked tracker is optional. */ }
    }
  }
  function schedule() { if(!stopped&&pending.length&&!retry&&retries<30)retry=setTimeout(()=>{retry=undefined;retries++;flush();schedule();},1000); }
  function enqueue(entry:Entry) { if(stopped)return;if(pending.length>=100)pending.shift();pending.push(entry);flush();schedule(); }
  function page(pathname:string) {
    if(key===pathname)return;
    const url=analyticsRoute(pathname);enqueue({url,title:'Qgroup '+url,referrer:previous});key=pathname;previous=url;
  }
  function track(name:EventName,data:Data={}) { const url=analyticsRoute(win.location.pathname);enqueue({url,title:'Qgroup '+url,referrer:previous,name,data:{...data,page:url,language:doc.documentElement.lang==='zh-Hans'?'zh-Hans':'zh-Hant'}}); }
  function context(element:Element) { const parent=element.closest('dialog,[role="dialog"],form,header,footer,main');return parent?(knownControls.has(parent.id)?parent.id:parent.getAttribute('role')==='dialog'?'dialog':parent.tagName.toLowerCase()):'page'; }
  function control(element:Element) {
    if(knownControls.has(element.id))return element.id;
    const name=element.getAttribute('name');if(name&&knownControls.has(name))return 'field:'+name;
    const tag=element.tagName.toLowerCase(),type=element.getAttribute('type')??'text';
    if(['input','textarea','select'].includes(tag))return 'field:'+(['text','number','checkbox','radio','file','email','search','date','datetime-local'].includes(type)?type:tag);
    return ['a','button','form','details','dialog','summary'].includes(tag)?tag:'control';
  }
  const details=(element:Element)=>({control:control(element),context:context(element)});
  const usable=(element:Element|null):element is Element=>!!element&&!element.closest('[inert]')&&!element.matches(':disabled');
  const field=(target:EventTarget|null)=>target instanceof win.Element&&target.matches('input,select,textarea')&&!['password','hidden'].includes(target.getAttribute('type')??'')&&usable(target)?target:null;
  const state={page,request(path:string,method:string,status:number,outcome:string){const verb=method.toUpperCase();if(!['POST','PUT','PATCH','DELETE'].includes(verb))return;track('api_result',{operation:analyticsOperation(path),method:verb,status:Number.isInteger(status)&&status>=100&&status<=599?status:0,outcome:['success','rejected','network_error','parse_error'].includes(outcome)?outcome:'network_error'});},stop(){if(stopped)return;stopped=true;clearTimeout(retry);for(const timer of timers.values())clearTimeout(timer);timers.clear();pending.length=0;for(const remove of listeners)remove();observer?.disconnect();if(current===state)current=undefined;}};
  try {
  listen(doc,'click',event=>{const element=event.target instanceof win.Element?event.target.closest('button,a,input[type="button"],input[type="submit"],[role="button"]'):null;if(usable(element))track('ui_click',details(element));});
  listen(doc,'submit',event=>{if(event.target instanceof win.Element){const submitter=(event as SubmitEvent).submitter;track('ui_submit',{...details(event.target),submitter:submitter?control(submitter):'keyboard'});}});
  listen(doc,'input',event=>{
    const element=field(event.target);if(!element||['checkbox','radio','file'].includes(element.getAttribute('type')??''))return;
    clearTimeout(timers.get(element));const data=details(element);timers.set(element,setTimeout(()=>{timers.delete(element);track('ui_input',data);},1000));
  });
  listen(doc,'change',event=>{const element=field(event.target);if(!element)return;clearTimeout(timers.get(element));timers.delete(element);const type=element.getAttribute('type');track('ui_change',{...details(element),...(['checkbox','radio'].includes(type??'')?{checked:(element as HTMLInputElement).checked}:{})});});
  listen(doc,'invalid',event=>{const element=field(event.target);if(element)track('ui_invalid',details(element));});
  listen(doc,'toggle',event=>{if(event.target instanceof win.Element&&event.target.tagName==='DETAILS')track((event.target as HTMLDetailsElement).open?'ui_expand':'ui_collapse',details(event.target));});
  listen(doc,'cancel',event=>{if(event.target instanceof win.Element&&event.target.tagName==='DIALOG')track('dialog_cancel',details(event.target));});
  function observeDialogs() { const n=doc.querySelectorAll('dialog[open],[role="dialog"]').length;if(n!==dialogs){track(n>dialogs?'dialog_open':'dialog_close',{control:'dialog',context:'page'});dialogs=n;} }
  observer=new win.MutationObserver(observeDialogs);observer.observe(doc.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['open','role']});
  listen(doc,'load',()=>flush());

  current=state;
  if(!doc.getElementById('qgroup-analytics')) {
    const script=doc.createElement('script');script.id='qgroup-analytics';script.async=true;script.src=ANALYTICS_HOST+'/script.js';script.dataset.websiteId=ANALYTICS_WEBSITE;script.dataset.domains=new URL(ANALYTICS_ORIGIN).hostname;script.dataset.autoTrack='false';script.dataset.autoPageview='false';script.dataset.performance='false';script.dataset.fetchCredentials='omit';script.dataset.excludeSearch='true';script.dataset.excludeHash='true';doc.head.append(script);
  }
  return state.stop;
  } catch { state.stop(); return ()=>{}; }
}
