import { errorText, uiText } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button, Checkbox } from './kimi-ui';
import { LegacyDetailedSettlementInspection,LegacyRequestReceipt,decodeLegacyDetailedSettlement,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import { SettlementSnapshotView, PreviewAssets } from './activity-settlement';
import { money } from './settlement-controls';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyDetailedSettlementRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyDetailedSettlementInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 let decoded:ReturnType<typeof decodeLegacyDetailedSettlement>;try{decoded=decodeLegacyDetailedSettlement(request);}catch{return <Notice>原逐人結算請求欄位尚未完成對應；請保全並核對原結果，不能重試。</Notice>;}
 const path='/activities/'+encodeURIComponent(decoded.eventId)+'/settlement',mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/settlement/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let receipt:z.infer<typeof LegacyRequestReceipt>;
   if(plan.state==='retryable')receipt=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/settlement/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/settlement/inspect', { body: request });if(current.state!=='committed')throw Error('原請求結果已改變，請重新核對。');receipt=current.receipt;}
   if(!receipt.committed)throw Error('原請求結果已改變，請重新核對。');
   await guard();const current=await preserveLegacy(viewer.scope);if(current.disabled||current.epoch!==inventory.epoch)throw Error('原紀錄已因登出清除，不能確認恢復。');
   const resolved=new Set(current.mappings.filter(m=>m.deviceEpoch===deviceEpoch).map(m=>m.id)),rows=current.rows.filter(candidate=>candidate.sourceKey===row.sourceKey&&!resolved.has(candidate.id)&&JSON.stringify(describeLegacy(candidate.source,viewer.scope).request)===JSON.stringify(request));
   if(!rows.some(candidate=>candidate.id===row.id))throw Error('原請求已有不同核對結果，請重新讀取。');
   await guard();await mapLegacySources(viewer.scope,inventory.epoch,rows,{sourceId:row.id,key:'qgroup:rebuild:original-request:v1:'+viewer.scope+':'+request.requestKey,path,deviceEpoch,kind:'request'});
   await guard();if(active.current){setMessage(uiText("原請求已完成，恢復紀錄已保存。"));await refresh();}
  }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求結果或本機紀錄尚未確認；請重新核對原結果，原編號保留。"));}finally{if(active.current)setBusy(false);}
 }
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看逐人結算</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原結算請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<Text>原操作已提交，只保存已核對結果；不重新發布結算。</Text>:<div aria-label="原結算重試核對"><Text>{plan.title}</Text><Text>原名冊版本 {plan.preview.base_revision}；原結算版本 {plan.preview.base_version}；原操作編號 {request.requestKey}。</Text>
 <SettlementSnapshotView snapshot={plan.preview.snapshot} eventId={decoded.eventId}/>
 <PreviewAssets viewer={viewer} id={decoded.eventId} value={plan.assets}/>
 {[...(plan.preview.snapshot.merchant_payments??[]),...(plan.preview.snapshot.merchant_payment?[plan.preview.snapshot.merchant_payment]:[])].map((tx,i)=><Text key={i}>隨單登記店家付款：{money(tx.amount_cents!)} · {tx.parties?.find(p=>p.id===tx.payer_id)?.name||tx.payer_id} · {tx.merchant} · {tx.occurred_at} · {tx.method}</Text>)}
 {plan.preview.group_preview&&<><Notice>重試會通知群聊，公開逐人金額與本版附圖。</Notice><pre className="preserve-lines">{plan.preview.group_preview}</pre></>}
 </div>}
 <Checkbox className="consent" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)} label={<>{plan.state==='committed'?'保存原請求已完成的核對結果':'已核對原逐人金額、付款歸屬、附圖及通知，使用原編號重試原結算操作'}</>} /><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='committed'?'保存已核對結果':'重試原結算操作'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}
