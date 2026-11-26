import { legacyParticipantPath } from '@qgroup/contracts';
import { errorText, uiText, displayLocale } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button, Checkbox } from './kimi-ui';
import { LegacyParticipantInspection,LegacyParticipantResult,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyParticipantRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyParticipantInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 const originalPath=legacyParticipantPath(request);
 const destination=(path:string)=>originalPath.kind==='claim-request'?'/activities/'+encodeURIComponent(originalPath.id)+'/claims/'+encodeURIComponent(originalPath.token!):path;
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/participants/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let outcome:z.infer<typeof LegacyParticipantResult>;
   if(plan.state==='retryable')outcome=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/participants/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/participants/inspect', { body: request });if(current.state!==plan.state)throw Error('原請求結果已改變，請重新核對。');outcome=current;}
   const target=outcome.receipt.target;if(!target||target.kind!=='activity')throw Error('原請求結果已改變，請重新核對。');
   if(plan.state!=='retryable'){const prior=plan.receipt.target;if(prior?.id!==target.id)throw Error('原請求目的已改變，請重新核對。');}
   const path='/activities/'+encodeURIComponent(target.id)+('/'+outcome.route),kind='request' as const;
   await guard();const current=await preserveLegacy(viewer.scope);if(current.disabled||current.epoch!==inventory.epoch)throw Error('原紀錄已因登出清除，不能確認恢復。');
   const resolved=new Set(current.mappings.filter(m=>m.deviceEpoch===deviceEpoch).map(m=>m.id)),rows=current.rows.filter(candidate=>candidate.sourceKey===row.sourceKey&&!resolved.has(candidate.id)&&JSON.stringify(describeLegacy(candidate.source,viewer.scope).request)===JSON.stringify(request));
   if(!rows.some(candidate=>candidate.id===row.id))throw Error('原請求已有不同核對結果，請重新讀取。');
   await guard();await mapLegacySources(viewer.scope,inventory.epoch,rows,{sourceId:row.id,key:'qgroup:rebuild:original-request:v1:'+viewer.scope+':'+request.requestKey,path,deviceEpoch,kind});
   await guard();if(active.current){setMessage(uiText("原請求已完成，恢復紀錄已保存。"));await refresh();}
  }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求結果或本機紀錄尚未確認；請重新核對原結果，原編號保留。"));}finally{if(active.current)setBusy(false);}
 }
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={destination(mapped.path)}>查看目前認領／出席</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原認領／出席請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<><Text>原認領／出席操作已提交，只保存核對結果。</Text>{plan.requestStatus&&<Text>認領申請：{claimStatuses[plan.requestStatus]??plan.requestStatus}。</Text>}</>:<ParticipantReview plan={plan} requestKey={request.requestKey}/>}
 <Checkbox className="consent" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)} label={<>{plan.state==='retryable'?'已核對認領、出席、付款責任與通知，使用原編號重試認領／出席操作':'保存已核對的操作結果'}</>} /><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='retryable'?'重試原認領／出席請求':'保存已核對結果'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}


const attendanceLabels:Record<string,string>={unknown:uiText('未核對'),present:uiText('到場'),absent:uiText('缺席'),late:uiText('遲到'),left:uiText('已離場')};
const claimStatuses:Record<string,string>={invited:uiText('待本人申請'),requested:uiText('待管理人核對'),approved:uiText('已通過'),rejected:uiText('已拒絕'),revoked:uiText('已撤銷'),expired:uiText('已過期')};
const rosterStatuses:Record<string,string>={confirmed:uiText('正式報名'),waiting:uiText('候補'),tentative:uiText('待確認'),withdrawn:uiText('已退出')};
const actions:Record<string,string>={'claim-issue':uiText('建立本人認領邀請'),'claim-request':uiText('申請本人認領'),'claim-decision':uiText('處理認領申請'),attendance:uiText('核對出席'),onsite:uiText('現場補錄')};
function ParticipantReview({plan,requestKey}:{plan:Extract<z.infer<typeof LegacyParticipantInspection>,{state:'retryable'}>;requestKey:string}){
 const c=plan.command,p=plan.currentPerson,a=plan.arrangement;
 return <div aria-label="原認領／出席操作重試核對"><Text>{plan.title}</Text><Text>原操作編號 {requestKey}；目前版本 {plan.currentRevision}；原版本 {c.revision}。</Text><Text>操作：{actions[c.kind]}</Text>
 {p&&<dl><dt>參加者</dt><dd>{p.name}</dd><dt>名額</dt><dd>{rosterStatuses[p.status]??p.status}</dd><dt>付款</dt><dd>{p.payerName}{p.paymentLocked?'（原付款責任已保全）':''}</dd></dl>}
 {'reason' in c&&c.reason&&<Text>原因：{c.reason}</Text>}
 {plan.claim&&<><Text>認領：{claimStatuses[plan.claim.status]??plan.claim.status}；到期 {new Date(plan.claim.expiresAt).toLocaleString(displayLocale())}。</Text>{plan.claim.requesterName&&<Text>申請帳號：{plan.claim.requesterName}</Text>}</>}
 {c.kind==='claim-issue'&&<Text>邀請有效期 7 天。重新邀請會撤銷此人原有的待接受／待審申請。</Text>}
 {c.kind==='claim-request'&&<Text>原請求已確認本人身份與保留原付款責任；提交只建立待審申請，管理人核對通過後才移轉報名。</Text>}
 {c.kind==='claim-decision'&&<><Text>結果：{c.decision==='approve'?'通過':c.decision==='reject'?'拒絕':'撤銷'}</Text><Text>{c.decision==='approve'?'原請求已明確確認申請人就是此參加者；移轉名額管理，保留原付款人、同意、帳務和憑證。':'結束本次認領；原報名、付款責任及帳務保留。'}</Text></>}
 {c.kind==='attendance'&&<><Text>目前出席：{p?attendanceLabels[p.attendance]:''}{p?.note?'；備註：'+p.note:''}。</Text><dl><dt>保存出席</dt><dd>{attendanceLabels[c.attendance]}</dd><dt>備註</dt><dd>{c.note||'未填'}</dd><dt>到場</dt><dd>{c.arrivedAt?new Date(c.arrivedAt).toLocaleString(displayLocale()):'未填'}</dd><dt>離場</dt><dd>{c.leftAt?new Date(c.leftAt).toLocaleString(displayLocale()):'未填'}</dd></dl><Text>出席紀錄不會自動更動名額或帳務。</Text></>}
 {c.kind==='onsite'&&<><Text>正式 {plan.confirmed} 人／上限 {plan.capacity||'不限'}；候補 {plan.waiting} 人。</Text><ul>{c.people.map((v,i)=><li key={i}>{plan.onsiteNames[i]} · 付款：{v.payerKind==='self'?'本人':'代報者'}{v.note?' · 備註：'+v.note:''}</li>)}</ul><Text>超額：{c.allowOverCapacity?'原請求已確認':'未確認'}；跳過候補排隊：{c.overrideWaitlist?'原請求已確認':'未確認'}。</Text><Text>安排版本 {plan.conditionsVersion}；原版本 {c.conditionsVersion}。</Text><dl><dt>開始</dt><dd>{new Date(a.starts_at).toLocaleString(displayLocale(),{timeZone:a.timezone??'UTC'})}</dd><dt>地點</dt><dd>{a.location}</dd><dt>費用</dt><dd>{a.fee_policy||'未填'}</dd><dt>注意事項</dt><dd className="preserve-lines">{a.description||'未填'}</dd></dl><Text>原請求已確認現場人員接受目前安排；補錄為正式到場，不提升原候補。</Text></>}
 <Text>保存操作紀錄，依群政策產生通知。</Text></div>;
}
