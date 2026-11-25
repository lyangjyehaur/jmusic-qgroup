import { activityCategoryLabel } from './activity-categories';
import { errorText, uiText, displayLocale } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { LegacyRegistrationInspection,LegacyRegistrationResult,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyRegistrationRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyRegistrationInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/registration/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let outcome:z.infer<typeof LegacyRegistrationResult>;
   if(plan.state==='retryable')outcome=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/registration/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/registration/inspect', { body: request });if(current.state!==plan.state)throw Error('原請求結果已改變，請重新核對。');outcome=current;}
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
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看名冊</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原名冊請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<Text>原名冊操作已提交，只保存核對結果。</Text>:<RegistrationReview plan={plan} requestKey={request.requestKey}/>}
 <label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>{plan.state==='retryable'?'已核對名冊、安排與通知，使用原編號重試名冊操作':'保存已核對的操作結果'}</label><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='retryable'?'重試原名冊請求':'保存已核對結果'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}
const localTime=(value:string,zone:string|null)=>new Intl.DateTimeFormat(displayLocale(),{timeZone:zone??'UTC',dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(value));
const statuses:Record<string,string>={confirmed:uiText('正式報名'),waiting:uiText('候補'),tentative:uiText('待確認'),invited:uiText('受邀'),withdrawn:uiText('已退出'),accepted:uiText('已接受'),pending:uiText('待回覆'),declined:uiText('暫不同意')};
const actions={signup:uiText('新增報名'),edit:uiText('修改報名'),confirm:uiText('確認參加'),split:uiText('改為分開排隊'),withdraw:uiText('退出報名'),withdrawal_request:uiText('申請退出，等待審核'),approve:uiText('同意退出'),reject:uiText('拒絕退出'),accepted:uiText('接受目前安排'),declined:uiText('暫不同意目前安排'),noop:uiText('目前沒有本人報名，保存原退出操作結果')};
function RegistrationReview({plan,requestKey}:{plan:Extract<z.infer<typeof LegacyRegistrationInspection>,{state:'retryable'}>;requestKey:string}){
 const c=plan.command,a=plan.arrangement,p=plan.currentPerson;
 return <div aria-label="原名冊操作重試核對"><Text>{plan.title}</Text><Text>原操作編號 {requestKey}；目前版本 {plan.currentRevision}；原版本 {c.revision??'未記錄，須核對目前資料'}。</Text>
 <Text>操作：{actions[plan.effect]}</Text>
 {p&&<dl><dt>参加者</dt><dd>{p.name}</dd><dt>狀態</dt><dd>{statuses[p.status]??p.status}{p.withdrawalRequested?'；退出待審核':''}</dd><dt>付款</dt><dd>{p.payerName}{p.paymentLocked?'（認領前付款責任保留）':''}</dd><dt>安排回覆</dt><dd>{statuses[p.confirmation]??p.confirmation}；已同意版本 {p.acceptedVersion??'無'}</dd></dl>}
 {c.kind==='person'&&c.action==='edit'&&<dl><dt>稱呼</dt><dd>{p?.isGuest?c.name:p?.name??c.name}</dd><dt>備註</dt><dd>{c.note||'未填'}</dd><dt>付款歸屬</dt><dd>{c.payerKind==='self'?'本人':'代報者'}</dd></dl>}
 {'reason' in c&&c.reason&&<Text>原因：{c.reason}</Text>}
 {c.kind==='signup'&&<><Text>排隊：{c.queueMode==='together'?'整組':'分開'}；{c.intent==='tentative'?'先登記待確認':'報名參加'}；{c.acceptPartial?'接受部分候補':'未接受部分候補'}。</Text>
 <ul>{c.people.map((person,i)=><li key={i}>{plan.allocation[i]?.name} · {statuses[plan.allocation[i]?.status??'']??plan.allocation[i]?.status} · 付款：{person.payerKind==='self'?'本人':'代報者'}{person.note?' · 備註：'+person.note:''}</li>)}</ul>
 <Text>{c.originalPreviewRequired?'沿用原預覽碼；本次報名接受目前安排。':'沿用舊本人報名入口；本次报名前須核對目前安排。'}</Text></>}
 {(c.kind==='signup'||c.kind==='conditions')&&<><Text>目前安排版本 {plan.conditionsVersion}{c.conditionsVersion!==undefined?'；原版本 '+c.conditionsVersion:''}。</Text>
 <dl><dt>類型</dt><dd>{activityCategoryLabel(a.category)}</dd><dt>開始</dt><dd>{localTime(a.starts_at,a.timezone)}</dd><dt>持續</dt><dd>{a.duration_hours===null?'未設定':a.duration_hours+' 小時'}</dd><dt>地點</dt><dd>{a.location}</dd><dt>退出期限</dt><dd>{localTime(a.withdrawal_deadline,a.timezone)}</dd><dt>費用</dt><dd>{a.fee_policy||'未填'}</dd><dt>注意事項</dt><dd className="preserve-lines">{a.description||'未填'}</dd></dl></>}
 {(plan.effect==='declined'||plan.effect==='withdrawal_request')&&<Text>{plan.effect==='declined'?'原報名、原約定及付款責任保留；通知發起者協調。':'申請送交名冊管理者；審核前原報名保留。'}</Text>}
 {['withdraw','approve','reject','confirm','split','signup','edit'].includes(plan.effect)&&<Text>保存名冊與操作紀錄，依群政策產生通知；候補依原排隊順序處理。</Text>}
 </div>;
}
