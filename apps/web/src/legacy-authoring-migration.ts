
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import type { Member } from './member-access';
import { authoringDraft,decodeAuthoring,type AuthoringSource } from './legacy-authoring';
import { openDraft,saveDraft,deviceDraftEpoch,type DraftHandle } from './draft-store';
import { legacyInventoryUsable,mapLegacySources,preserveLegacy,type LegacyInventory,type LegacyMapping,type LegacySnapshot } from './legacy-local-store';
import { describeLegacy } from './legacy-local-record';
export type AuthoringPlan={source:AuthoringSource;row:LegacySnapshot;rows:LegacySnapshot[];raw:string;key:string;path:string;handle:DraftHandle;previous:string|null;pending:boolean};
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
async function intentKey(kind:'activity'|'poll',intent:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode((kind==='activity'?'create ':'create time-poll ')+intent));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
async function relatedSources(inventory:LegacyInventory,row:LegacySnapshot,source:AuthoringSource,requestsOnly=false){
  const rows:LegacySnapshot[]=requestsOnly?[]:[row],alreadyMapped=new Set(inventory.mappings.map(m=>m.id));
  const createKey=source.intent?await intentKey(source.kind,source.intent):null;
  for(const candidate of inventory.rows){
    if(candidate.id===row.id||alreadyMapped.has(candidate.id))continue;
    if(candidate.sourceKey===row.sourceKey&&!requestsOnly){
      try{
        const old=decodeAuthoring(candidate,row.scope);
        const sameCreation=old.kind===source.kind&&source.creation&&old.creation&&old.intent===source.intent;
        const sameResult=old.kind==='poll'||source.kind==='poll'||!old.value.id||old.value.id===source.value.id;
        const sameEdit=old.kind==='activity'&&source.kind==='activity'&&!source.creation&&!old.creation&&old.value.id===source.value.id;
        if(sameCreation&&sameResult||sameEdit)rows.push(candidate);
      }catch{/* Unknown competing versions stay unmapped blockers. */}
    }else{
      const request=describeLegacy(candidate.source,row.scope).request,data=object(request?.data);
      if(createKey&&candidate.sourceKey==='request:'+row.scope+':'+createKey&&request?.method==='POST'&&request.path===(source.kind==='activity'?'/api/events':'/api/time-polls')&&request.requestKey===createKey&&data?.client_intent===source.intent)rows.push(candidate);
    }
  }return rows;
}
async function freshInventory(scope:string,epoch:number){
  const inventory=await preserveLegacy(scope),deviceEpoch=await deviceDraftEpoch();
  if(!legacyInventoryUsable(inventory,epoch))throw Error('原紀錄已因登出清除，不能完成轉換。');
  return {...inventory,mappings:inventory.mappings.filter(m=>m.deviceEpoch===deviceEpoch)};
}
export async function prepareAuthoring(viewer:Member,inventory:LegacyInventory,row:LegacySnapshot,zone:string):Promise<AuthoringPlan>{
  const source=decodeAuthoring(row,viewer.scope);
  let target:{id:string;route:'draft'|'arrangements'|'poll'}|null=null;
  if(source.creation){
    const result=await authHttp(viewer).requestContract('POST /api/v2/me/create-intents/view', { body: {kind:source.kind,intent:source.intent!} });
    if(result.state==='existing'){if(source.kind==='activity'&&source.value.id&&source.value.id!==result.id)throw Error('原稿編號與建立結果不同，請保留並核對。');target={id:result.id,route:result.route};}
    else if(source.kind==='activity'&&source.value.id)throw Error('原稿標示活動已建立，但原回執缺失；不能當成新活動。');
  }else{
    const id=source.value.id;
    try{await scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/draft', { params: { id } });target={id,route:'draft'};}
    catch(error){if(!(error instanceof ApiError)||error.code!=='NOT_A_DRAFT')throw error;target={id,route:'arrangements'};}
  }
  if(target){
    if(source.kind==='activity'){const current=await (target.route==='draft'?scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/draft', { params: { id: target.id } }):scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/arrangements', { params: { id: target.id } }));if(!current.canEdit)throw Error('目前不能編輯原活動；原稿保留，不能另建。');}
    else {const poll=await scopedHttp(viewer.scope).requestContract('GET /api/v2/time-polls/:id/manage', { params: { id: target.id } });if(!poll.is_owner)throw Error('目前不能管理原投票，原稿保留。');}
  }
  const converted=authoringDraft(row,source,target,zone),suffix=row.sourceKey.slice(('draft:'+viewer.scope+':').length);
  const key=source.kind==='poll'?'qgroup:rebuild:activity-draft:poll-create:v1:'+viewer.scope+':new':'qgroup:rebuild:activity-draft:'+(target?.route==='arrangements'?'arrangements:v1:':'v1:')+viewer.scope+':'+(target?.id??(suffix.startsWith('copy:')?suffix:'new'));
  const path=source.kind==='poll'?'/time-polls/new':target?'/activities/'+encodeURIComponent(target.id)+(target.route==='draft'?'/edit':'/arrangements'):suffix.startsWith('copy:')?'/activities/new?copyFrom='+encodeURIComponent(suffix.slice(5)):'/activities/new';
  const saved=await openDraft(key,viewer.scope),rows=await relatedSources(await freshInventory(viewer.scope,inventory.epoch),row,source);
  let pending=false;try{pending=!!object(JSON.parse(saved.raw??'null'))?.pending;}catch{/* An unreadable target is archived only after explicit confirmation. */}
  return {source,row,rows,raw:converted.raw,key,path,handle:saved.handle,previous:saved.raw,pending};
}
export async function adoptAuthoring(plan:AuthoringPlan,scope:string,epoch:number,preserve:boolean,validate:()=>Promise<void>,active:()=>boolean){
  const check=async()=>{await validate();if(!active())throw Error('轉換頁面已關閉，原稿保留。');if(await deviceDraftEpoch()!==plan.handle.deviceEpoch)throw Error('本機原稿已因登出清除，不能完成轉換。');};
  await check();
  if(plan.pending)throw Error('目的表單有待確認操作，請先核對原操作結果；不能覆寫。');
  if(plan.previous!==null&&plan.previous!==plan.raw&&!preserve)throw Error('目的表單已有本機原稿，請明確保全後再採用。');
  await saveDraft(plan.handle,plan.raw,preserve&&plan.previous!==plan.raw);
  await check();const target=await openDraft(plan.key,scope);if(target.handle.deviceEpoch!==plan.handle.deviceEpoch||target.raw!==plan.raw)throw Error('目的原稿已更新，轉換尚未確認；兩份原稿保留。');
  // Re-read after destination commit: old tabs can finish a request while conversion is running.
  const rows=await relatedSources(await freshInventory(scope,epoch),plan.row,plan.source);
  await check();
  await mapLegacySources(scope,epoch,rows,{sourceId:plan.row.id,key:plan.key,path:plan.path,deviceEpoch:plan.handle.deviceEpoch});
  await check();return plan.path;
}
/** A late pending→done snapshot is acknowledged explicitly without replacing the adopted draft. */
export async function reconcileAuthoringRequests(row:LegacySnapshot,mapping:LegacyMapping,epoch:number,validate:()=>Promise<void>,active:()=>boolean){
  const check=async()=>{await validate();if(!active()||await deviceDraftEpoch()!==mapping.deviceEpoch)throw Error('帳號或頁面已變更，原紀錄保留。');};
  await check();
  const inventory=await freshInventory(row.scope,epoch),current=inventory.mappings.find(m=>m.id===row.id);
  if(current?.sourceId!==row.id||current.targetKey!==mapping.targetKey)throw Error('轉換目的已變更，請重新讀取。');
  const rows=await relatedSources(inventory,row,decodeAuthoring(row,row.scope),true);
  await check();
  if(rows.length)await mapLegacySources(row.scope,epoch,rows,{sourceId:row.id,key:mapping.targetKey,path:mapping.path,deviceEpoch:mapping.deviceEpoch});
  await check();return rows.length;
}
