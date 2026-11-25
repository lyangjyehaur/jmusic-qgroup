import { PaymentAssetImage } from './payment-image';
import { errorText, uiText } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { LegacyPersonalInspection,LegacyPersonalResult,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyPersonalRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyPersonalInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/personal/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let outcome:z.infer<typeof LegacyPersonalResult>;
   if(plan.state==='retryable')outcome=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/personal/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/personal/inspect', { body: request });if(current.state!==plan.state)throw Error('原請求結果已改變，請重新核對。');outcome=current;}
   if(plan.route!==outcome.route)throw Error('原請求目的已改變，請重新核對。');
   const path=outcome.route,kind='request' as const;
   await guard();const current=await preserveLegacy(viewer.scope);if(current.disabled||current.epoch!==inventory.epoch)throw Error('原紀錄已因登出清除，不能確認恢復。');
   const resolved=new Set(current.mappings.filter(m=>m.deviceEpoch===deviceEpoch).map(m=>m.id)),rows=current.rows.filter(candidate=>candidate.sourceKey===row.sourceKey&&!resolved.has(candidate.id)&&JSON.stringify(describeLegacy(candidate.source,viewer.scope).request)===JSON.stringify(request));
   if(!rows.some(candidate=>candidate.id===row.id))throw Error('原請求已有不同核對結果，請重新讀取。');
   await guard();await mapLegacySources(viewer.scope,inventory.epoch,rows,{sourceId:row.id,key:'qgroup:rebuild:original-request:v1:'+viewer.scope+':'+request.requestKey,path,deviceEpoch,kind});
   await guard();if(active.current){setMessage(uiText("原請求已完成，恢復紀錄已保存。"));await refresh();}
  }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求結果或本機紀錄尚未確認；請重新核對原結果，原編號保留。"));}finally{if(active.current)setBusy(false);}
 }
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看目前個人資料</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原個人請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<><Text>原個人操作已提交，只保存核對結果。</Text></>:<PersonalReview plan={plan} requestKey={request.requestKey} request={request} scope={viewer.scope}/>}
 <label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>{plan.state==='retryable'?'已核對目前資料，使用原編號重試個人操作':'保存已核對的操作結果'}</label><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='retryable'?'重試原個人請求':'保存已核對結果'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}


const actions:Record<string,string>={profile:'修改站內稱呼',notifications:'標記消息已讀','code-create':'保存收款碼','code-archive':'移除收款碼'};
function PersonalReview({plan,requestKey,request,scope}:{plan:Extract<z.infer<typeof LegacyPersonalInspection>,{state:'retryable'}>;requestKey:string;request:Request;scope:string}){
 return <div aria-label="原個人操作重試核對"><Text>原操作編號 {requestKey}</Text><Text>操作：{actions[plan.kind]}</Text>
 {plan.kind==='profile'&&<><dl><dt>目前稱呼</dt><dd>{plan.currentNickname}</dd><dt>原請求稱呼</dt><dd>{plan.nickname}</dd></dl><Text>更新 {plan.affectedActivities} 場有效報名的稱呼及操作紀錄；名額與付款責任保留。</Text></>}
 {plan.kind==='notifications'&&<><Text>原消息編號：{plan.notificationIds.join('、')||'空清單'}</Text><Text>目前帳號 {plan.ownedNotifications} 則，其中未讀 {plan.unreadNotifications} 則。只標記自己的消息；原已讀時間保留。</Text></>}
 {plan.code&&<><dl><dt>方式</dt><dd>{plan.code.kind==='wechat'?'微信':plan.code.kind==='alipay'?'支付寶':'其他'}</dd><dt>名稱</dt><dd>{plan.code.name||'未填'}</dd></dl>{plan.kind==='code-create'&&(typeof request.data.image==='string'?<img className="payment-asset-thumb" src={'data:image/png;base64,'+request.data.image} alt="原請求收款碼"/>:plan.code.source?<PaymentAssetImage url={'/api/v2/activities/'+encodeURIComponent(plan.code.source.eventId)+'/settlement/history/'+plan.code.source.version+'/payment-codes/'+plan.code.source.kind} scope={scope} label="原版收款碼"/>:null)}{plan.code.source&&<Text>原結算版本 {plan.code.source.version}；僅保存目前帳號自己發布的收款碼。</Text>}<Text>{plan.kind==='code-create'?'使用原請求圖片；相同方式、名稱與圖片不重複保存。':'移除個人庫的收款碼；已發布結算的原圖保留。'}</Text></>}
 </div>;
}
