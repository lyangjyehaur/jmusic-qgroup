import { errorText, uiText } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { LegacyActivityCreationInspection,LegacyActivityCreationResult,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyActivityCreationRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyActivityCreationInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/activity-create/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let outcome:z.infer<typeof LegacyActivityCreationResult>;
   if(plan.state==='retryable')outcome=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/activity-create/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/activity-create/inspect', { body: request });if(current.state!==plan.state)throw Error('原請求結果已改變，請重新核對。');outcome=current;}
   const target=outcome.state==='committed'?outcome.receipt.target:outcome.target;if(!target||target.kind!=='activity')throw Error('原請求結果已改變，請重新核對。');
   if(plan.state!=='retryable'){const prior=plan.state==='committed'?plan.receipt.target:plan.target;if(prior?.id!==target.id)throw Error('原請求目的已改變，請重新核對。');}
   const path='/activities/'+encodeURIComponent(target.id)+(outcome.route==='draft'?'/edit':outcome.route==='arrangements'?'/arrangements':''),kind=outcome.state==='committed'?'request' as const:'request-existing' as const;
   await guard();const current=await preserveLegacy(viewer.scope);if(current.disabled||current.epoch!==inventory.epoch)throw Error('原紀錄已因登出清除，不能確認恢復。');
   const resolved=new Set(current.mappings.filter(m=>m.deviceEpoch===deviceEpoch).map(m=>m.id)),rows=current.rows.filter(candidate=>candidate.sourceKey===row.sourceKey&&!resolved.has(candidate.id)&&JSON.stringify(describeLegacy(candidate.source,viewer.scope).request)===JSON.stringify(request));
   if(!rows.some(candidate=>candidate.id===row.id))throw Error('原請求已有不同核對結果，請重新讀取。');
   await guard();await mapLegacySources(viewer.scope,inventory.epoch,rows,{sourceId:row.id,key:'qgroup:rebuild:original-request:v1:'+viewer.scope+':'+request.requestKey,path,deviceEpoch,kind});
   await guard();if(active.current){setMessage(outcome.state==='committed'?uiText("原請求已完成，恢復紀錄已保存。"):uiText("同一草稿的既有活動已核對，原請求未重送。"));await refresh();}
  }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求結果或本機紀錄尚未確認；請重新核對原結果，原編號保留。"));}finally{if(active.current)setBusy(false);}
 }
 if(mapped?.kind==='request-existing')return <Notice>同一草稿的既有活動已核對；此紀錄不證明原請求已提交。<Link to={mapped.path}>查看活動</Link></Notice>;
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看活動</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原建立活動請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<Text>原建立請求已提交，只保存核對結果。</Text>:plan.state==='existing'?<Text>同一草稿已有活動；此紀錄不證明原請求已提交。核對後可保存既有活動位置。</Text>:<ActivityReview plan={plan} requestKey={request.requestKey}/>}
 <label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>{plan.state==='retryable'?'已核對安排、報名與群通知，使用原編號建立活動':'保存已核對的建立結果'}</label><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='retryable'?'重試原建立活動請求':'保存已核對結果'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}
const localTime=(value:string,zone:string|null)=>new Intl.DateTimeFormat('zh-TW',{timeZone:zone??'UTC',dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(value));
function ActivityReview({plan,requestKey}:{plan:Extract<z.infer<typeof LegacyActivityCreationInspection>,{state:'retryable'}>;requestKey:string}) {
 const {lifecycle,values:c}=plan.command;
 return <div aria-label="原建立活動重試核對"><Text>{c.title}</Text><Text>原操作編號 {requestKey}；發起者 {plan.owner_name}。</Text>
 <dl><dt>建立方式</dt><dd>{lifecycle==='draft'?'保存草稿':'直接發布'}</dd><dt>可見性</dt><dd>{c.visibility==='public'?'公開':'邀請可見'}</dd><dt>類型</dt><dd>{c.category}</dd><dt>地點</dt><dd>{c.location}</dd><dt>時區</dt><dd>{c.timezone??'未設定（以 UTC 顯示）'}</dd><dt>開始</dt><dd>{localTime(c.startsAt,c.timezone)}</dd><dt>報名截止</dt><dd>{localTime(c.deadline,c.timezone)}</dd><dt>退出期限</dt><dd>{localTime(c.withdrawalDeadline??c.deadline,c.timezone)}{c.withdrawalDeadline===null?'（沿用報名截止）':''}</dd><dt>持續時間</dt><dd>{c.durationHours} 小時</dd><dt>人數</dt><dd>上限 {c.capacity||'不限'} · 最低 {c.minimumParticipants}</dd><dt>費用</dt><dd>{c.feePolicy||'未填'}</dd></dl>
 {c.description&&<Text className="preserve-lines">{c.description}</Text>}
 <Notice>{lifecycle==='draft'?'只保存草稿，不發布安排、報名或群通知。':c.joinOwner?'直接發布安排；發起者將自動報名並接受本次安排。':'直接發布安排；發起者不自動報名。'}{c.visibility==='public'?'公開活動請勿填寫私人資訊。':'邀請可見活動不會同步到公開群。'}</Notice>
 {lifecycle==='draft'&&<Text>發布草稿時發起者自動報名：{c.joinOwner?'是':'否'}。</Text>}
 <Text>群同步：{c.botEnabled?'開啟，依管理員群政策':'關閉'}</Text>
 {plan.group_target!==null?<><Text>目標群：{plan.group_target||'由 bot 設定決定'}；通知仍需由 bot 投遞。</Text>{plan.group_preview?<><Text>本次群通知內容預覽；連結於建立後產生</Text><pre className="preserve-lines">{plan.group_preview}</pre></>:<Text>通知內容無法預覽，建立時可能無法加入待送工作；可於建立後核對通知紀錄。</Text>}</>:<Text>目前未安排建立活動群通知。</Text>}
 {plan.reminders&&<Text>截止與預估結束提醒依群政策和提醒時間安排，建立後請核對待送紀錄。</Text>}
 </div>;
}
