
import { scopedHttp } from './http';
import type { Member } from './member-access';
import { decodeSettlement,settlementDraft,type SettlementSource } from './legacy-settlement';
import { openDraft,saveDraft,deviceDraftEpoch,type DraftHandle } from './draft-store';
import { legacyInventoryUsable,mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
export type SettlementPlan={source:SettlementSource;row:LegacySnapshot;rows:LegacySnapshot[];raw:string;key:string;path:string;handle:DraftHandle;previous:string|null;pending:boolean;zone:string};
async function freshInventory(scope:string,epoch:number){
 const inventory=await preserveLegacy(scope),deviceEpoch=await deviceDraftEpoch();
 if(!legacyInventoryUsable(inventory,epoch))throw Error('原紀錄已因登出清除，不能完成轉換。');
 return {...inventory,mappings:inventory.mappings.filter(m=>m.deviceEpoch===deviceEpoch)};
}
function relatedSources(inventory:LegacyInventory,row:LegacySnapshot,source:SettlementSource){
 const mapped=new Set(inventory.mappings.map(m=>m.id));
 return inventory.rows.filter(candidate=>{
  if(candidate.id===row.id)return true;
  if(mapped.has(candidate.id)||candidate.sourceKey!==row.sourceKey)return false;
  try{const old=decodeSettlement(candidate,row.scope);return old.eventId===source.eventId&&old.collectorId===source.collectorId;}
  catch{return false;}
 });
}
async function context(viewer:Member,source:SettlementSource){
 const current=await scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/settlement/context', { params: { id: source.eventId } });
 if(!current.can_manage)throw Error('目前沒有結算管理權限，原稿保留。');
 if(source.collectorId!==null&&source.collectorId!==current.collector.id)throw Error('原結算發布帳號已改變，請先核對收款人與款項；原稿保留。');
 return current;
}
export async function prepareSettlement(viewer:Member,inventory:LegacyInventory,row:LegacySnapshot,zone:string,duration:string):Promise<SettlementPlan>{
 const source=decodeSettlement(row,viewer.scope),current=await context(viewer,source),path='/activities/'+encodeURIComponent(source.eventId)+'/settlement/edit';
 const raw=settlementDraft(row,source,current,zone,duration),key='qgroup:rebuild:activity-draft:settlement:v1:'+viewer.scope+':'+source.eventId,saved=await openDraft(key,viewer.scope);
 let pending=false;try{pending=!!JSON.parse(saved.raw??'null')?.pending;}catch{/* Unreadable destination bytes require explicit preservation. */}
 return {source,row,rows:relatedSources(await freshInventory(viewer.scope,inventory.epoch),row,source),raw,key,path,handle:saved.handle,previous:saved.raw,pending,zone};
}
export async function adoptSettlement(plan:SettlementPlan,scope:string,epoch:number,preserve:boolean,validate:()=>Promise<Member>,active:()=>boolean){
 const check=async()=>{const viewer=await validate();if(viewer.scope!==scope)throw Error('帳號已變更，請重新讀取。');if(!active())throw Error('轉換頁面已關閉，原稿保留。');if(await deviceDraftEpoch()!==plan.handle.deviceEpoch)throw Error('本機原稿已因登出清除，不能完成轉換。');return viewer;};
 const viewer=await check();
 if(plan.pending)throw Error('目的表單有待確認操作，請先核對原操作結果；不能覆寫。');
 if(plan.previous!==null&&plan.previous!==plan.raw&&!preserve)throw Error('目的表單已有本機原稿，請明確保全後再採用。');
 await context(viewer,plan.source);await check();await saveDraft(plan.handle,plan.raw,preserve&&plan.previous!==plan.raw);
 await check();const target=await openDraft(plan.key,scope);
 if(target.handle.deviceEpoch!==plan.handle.deviceEpoch||target.raw!==plan.raw)throw Error('目的原稿已更新，轉換尚未確認；兩份原稿保留。');
 const rows=relatedSources(await freshInventory(scope,epoch),plan.row,plan.source);await check();
 await mapLegacySources(scope,epoch,rows,{sourceId:plan.row.id,key:plan.key,path:plan.path,deviceEpoch:plan.handle.deviceEpoch});
 await check();return plan.path;
}
