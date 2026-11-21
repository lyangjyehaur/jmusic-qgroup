import { FinanceOriginResult,FinanceView,RoomPlanView } from '@qgroup/contracts';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import type { Member } from './member-access';
import { decodeMoney,moneyDraft,type MoneySource } from './legacy-money';
import { openDraft,saveDraft,deviceDraftEpoch,type DraftHandle } from './draft-store';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
export type MoneyPlan={source:MoneySource;row:LegacySnapshot;rows:LegacySnapshot[];raw:string;key:string;path:string;handle:DraftHandle;previous:string|null;pending:boolean;zone:string;originState:string|null};
async function freshInventory(scope:string,epoch:number){
 const inventory=await preserveLegacy(scope),deviceEpoch=await deviceDraftEpoch();
 if(inventory.disabled||inventory.epoch!==epoch)throw Error('原紀錄已因登出清除，不能完成轉換。');
 return {...inventory,mappings:inventory.mappings.filter(m=>m.deviceEpoch===deviceEpoch)};
}
function relatedSources(inventory:LegacyInventory,row:LegacySnapshot,source:MoneySource){
 const mapped=new Set(inventory.mappings.map(m=>m.id));
 return inventory.rows.filter(candidate=>{
   if(candidate.id===row.id)return true;
   if(mapped.has(candidate.id)||candidate.sourceKey!==row.sourceKey)return false;
   try{const old=decodeMoney(candidate,row.scope);return old.kind===source.kind&&(source.kind==='rooms'||old.kind==='finance'&&old.command===source.command&&old.targetId===source.targetId&&(!['record','report'].includes(source.command)||old.value.recordId===source.value.recordId));}
   catch{return false;}
 });
}
async function lookup(viewer:Member,source:MoneySource){
 if(source.kind!=='finance'||source.command!=='record'&&source.command!=='report')return null;
 return authHttp(viewer).request('POST /api/v2/activities/:id/finance/origin', { params: { id: source.eventId }, body: {kind:source.command,id:source.value.recordId} }, FinanceOriginResult);
}
export async function prepareMoney(viewer:Member,inventory:LegacyInventory,row:LegacySnapshot,zone:string):Promise<MoneyPlan>{
 const source=decodeMoney(row,viewer.scope),path='/activities/'+encodeURIComponent(source.eventId)+'/'+source.kind;
 if(source.kind==='rooms'){const current=await scopedHttp(viewer.scope).request('GET /api/v2/activities/:id/rooms', { params: { id: source.eventId } }, RoomPlanView);if(!current.can_manage)throw Error('目前不能修改預分包間；原稿保留。');}
 else {const current=await scopedHttp(viewer.scope).request('GET /api/v2/activities/:id/finance', { params: { id: source.eventId } }, FinanceView);if(!current.summary.can_manage&&!['report','withdraw'].includes(source.command))throw Error('目前沒有此款項操作的管理權限；原稿保留。');}
 const origin=await lookup(viewer,source),originState=origin?.state==='existing'?origin.status:origin?.state??null;
 const raw=moneyDraft(row,source,zone,origin?.state==='existing'),key='qgroup:rebuild:activity-draft:'+source.kind+':v1:'+viewer.scope+':'+source.eventId,saved=await openDraft(key,viewer.scope);
 let pending=false;try{pending=!!JSON.parse(saved.raw??'null')?.pending;}catch{/* Existing unreadable bytes require explicit preservation. */}
 return {source,row,rows:relatedSources(await freshInventory(viewer.scope,inventory.epoch),row,source),raw,key,path,handle:saved.handle,previous:saved.raw,pending,zone,originState};
}
export async function adoptMoney(plan:MoneyPlan,scope:string,epoch:number,preserve:boolean,validate:()=>Promise<Member>,active:()=>boolean){
 const check=async()=>{const viewer=await validate();if(!active())throw Error('轉換頁面已關閉，原稿保留。');if(await deviceDraftEpoch()!==plan.handle.deviceEpoch)throw Error('本機原稿已因登出清除，不能完成轉換。');return viewer;};
 const viewer=await check();
 if(plan.pending)throw Error('目的表單有待確認操作，請先核對原操作結果；不能覆寫。');
 if(plan.previous!==null&&plan.previous!==plan.raw&&!preserve)throw Error('目的表單已有本機原稿，請明確保全後再採用。');
 const origin=await lookup(viewer,plan.source),state=origin?.state==='existing'?origin.status:origin?.state??null;
 if(state!==plan.originState)throw Error('原款項結果已更新；請重新檢查轉換，不能另建。');
 await check();await saveDraft(plan.handle,plan.raw,preserve&&plan.previous!==plan.raw);
 await check();const target=await openDraft(plan.key,scope);
 if(target.handle.deviceEpoch!==plan.handle.deviceEpoch||target.raw!==plan.raw)throw Error('目的原稿已更新，轉換尚未確認；兩份原稿保留。');
 const rows=relatedSources(await freshInventory(scope,epoch),plan.row,plan.source);await check();
 await mapLegacySources(scope,epoch,rows,{sourceId:plan.row.id,key:plan.key,path:plan.path,deviceEpoch:plan.handle.deviceEpoch});
 await check();return plan.path;
}
