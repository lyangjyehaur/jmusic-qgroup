import { errorText, uiText } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text, Heading } from 'yahha-ui';
import { Button } from './kimi-ui';
import { LegacyRoomsInspection,LegacyRequestReceipt,decodeLegacyRooms,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyRoomsRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyRoomsInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 let decoded:ReturnType<typeof decodeLegacyRooms>;try{decoded=decodeLegacyRooms(request);}catch{return <Notice>原包間請求欄位尚未完成對應；請保全並核對原結果，不能重試。</Notice>;}
 const path='/activities/'+encodeURIComponent(decoded.eventId)+'/rooms',mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/rooms/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let receipt:z.infer<typeof LegacyRequestReceipt>;
   if(plan.state==='retryable')receipt=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/rooms/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/rooms/inspect', { body: request });if(current.state!=='committed')throw Error('原請求結果已改變，請重新核對。');receipt=current.receipt;}
   if(!receipt.committed)throw Error('原請求結果已改變，請重新核對。');
   await guard();const current=await preserveLegacy(viewer.scope);if(current.disabled||current.epoch!==inventory.epoch)throw Error('原紀錄已因登出清除，不能確認恢復。');
   const resolved=new Set(current.mappings.filter(m=>m.deviceEpoch===deviceEpoch).map(m=>m.id)),rows=current.rows.filter(candidate=>candidate.sourceKey===row.sourceKey&&!resolved.has(candidate.id)&&JSON.stringify(describeLegacy(candidate.source,viewer.scope).request)===JSON.stringify(request));
   if(!rows.some(candidate=>candidate.id===row.id))throw Error('原請求已有不同核對結果，請重新讀取。');
   await guard();await mapLegacySources(viewer.scope,inventory.epoch,rows,{sourceId:row.id,key:'qgroup:rebuild:original-request:v1:'+viewer.scope+':'+request.requestKey,path,deviceEpoch,kind:'request'});
   await guard();if(active.current){setMessage(uiText("原請求已完成，恢復紀錄已保存。"));await refresh();}
  }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求結果或本機紀錄尚未確認；請重新核對原結果，原編號保留。"));}finally{if(active.current)setBusy(false);}
 }
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看包間安排</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 function arrangements(rooms:Extract<z.infer<typeof LegacyRoomsInspection>,{state:'retryable'}>['rooms']){
  if(!plan||plan.state!=='retryable')return null;
  const people=new Map(plan.current.people.map(p=>[p.id,p])),assigned=new Set(rooms.flatMap(r=>r.person_ids));
  return <>{rooms.length?rooms.map(room=><div key={room.id}><Text>{room.name} · {room.id}</Text><Text>付款人：{room.payer_label} · {room.payer_id}</Text>{room.person_ids.length?<ul>{room.person_ids.map(id=><li key={id}>{people.get(id)?.label||id} · {id}</li>)}</ul>:<Text>尚未分配人員</Text>}</div>):<Text>沒有包間安排</Text>}{plan.current.people.some(p=>!assigned.has(p.id))&&<><Text>未分配人員</Text><ul>{plan.current.people.filter(p=>!assigned.has(p.id)).map(p=><li key={p.id}>{p.label} · {p.id}</li>)}</ul></>}</>;
 }
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原包間請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<Text>原操作已提交，只保存已核對結果；不重新分配包間。</Text>:<div aria-label="原包間重試核對"><Text>{plan.current.title}</Text><Text>原名冊版本 {decoded.input.revision}；原操作編號 {request.requestKey}。</Text><Heading level={4}>目前包間安排</Heading>{arrangements(plan.current.rooms)}<Heading level={4}>原請求保存後的安排</Heading>{arrangements(plan.rooms)}{decoded.input.reason&&<Text>原因：{decoded.input.reason}</Text>}{!plan.changed&&<Text>安排與目前相同，僅保存原請求回執。</Text>}</div>}
 <label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>{plan.state==='committed'?'保存原請求已完成的核對結果':'已核對原包間、人員及付款人，使用原編號重試原包間操作'}</label><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='committed'?'保存已核對結果':'重試原包間操作'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}
