import { errorText, uiText, displayLocale } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { LegacyActivityPatchInspection,LegacyActivityPatchResult,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyActivityPatchRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyActivityPatchInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/activity/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let outcome:z.infer<typeof LegacyActivityPatchResult>;
   if(plan.state==='retryable')outcome=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/activity/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/activity/inspect', { body: request });if(current.state!==plan.state)throw Error('原請求結果已改變，請重新核對。');outcome=current;}
   const target=outcome.receipt.target;if(!target||target.kind!=='activity')throw Error('原請求結果已改變，請重新核對。');
   if(plan.state!=='retryable'){const prior=plan.receipt.target;if(prior?.id!==target.id)throw Error('原請求目的已改變，請重新核對。');}
   const path='/activities/'+encodeURIComponent(target.id)+(outcome.route==='draft'?'/edit':outcome.route==='view'?'':'/'+outcome.route),kind='request' as const;
   await guard();const current=await preserveLegacy(viewer.scope);if(current.disabled||current.epoch!==inventory.epoch)throw Error('原紀錄已因登出清除，不能確認恢復。');
   const resolved=new Set(current.mappings.filter(m=>m.deviceEpoch===deviceEpoch).map(m=>m.id)),rows=current.rows.filter(candidate=>candidate.sourceKey===row.sourceKey&&!resolved.has(candidate.id)&&JSON.stringify(describeLegacy(candidate.source,viewer.scope).request)===JSON.stringify(request));
   if(!rows.some(candidate=>candidate.id===row.id))throw Error('原請求已有不同核對結果，請重新讀取。');
   await guard();await mapLegacySources(viewer.scope,inventory.epoch,rows,{sourceId:row.id,key:'qgroup:rebuild:original-request:v1:'+viewer.scope+':'+request.requestKey,path,deviceEpoch,kind});
   await guard();if(active.current){setMessage(uiText("原請求已完成，恢復紀錄已保存。"));await refresh();}
  }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求結果或本機紀錄尚未確認；請重新核對原結果，原編號保留。"));}finally{if(active.current)setBusy(false);}
 }
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看活動</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原活動請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<Text>原活動操作已提交，只保存核對結果。</Text>:<ActivityReview plan={plan} requestKey={request.requestKey}/>}
 <label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>{plan.state==='retryable'?'已核對安排、報名與群通知，使用原編號重試活動操作':'保存已核對的操作結果'}</label><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='retryable'?'重試原活動請求':'保存已核對結果'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}
const localTime=(value:string,zone:string|null)=>new Intl.DateTimeFormat(displayLocale(),{timeZone:zone??'UTC',dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(value));
const phases:Record<string,string>={draft:uiText('草稿'),scheduled:uiText('已排定'),ongoing:uiText('進行中'),ended:uiText('已結束'),cancelled:uiText('已取消')};
const actions={pause:uiText('暫停報名'),resume:uiText('恢復報名'),formation:uiText('確認成團'),start:uiText('開始活動'),finish:uiText('結束活動'),cancel:uiText('取消活動'),archive:uiText('歸檔'),unarchive:uiText('取消歸檔'),remove:uiText('移除活動')};
function ActivityReview({plan,requestKey}:{plan:Extract<z.infer<typeof LegacyActivityPatchInspection>,{state:'retryable'}>;requestKey:string}){
 const c=plan.command,v=c.kind==='edit'?c.values:plan.current;
 return <div aria-label="原活動操作重試核對"><Text>{plan.title}</Text><Text>原操作編號 {requestKey}；目前版本 {plan.currentRevision}；原版本 {c.revision??'未記錄，須核對目前資料'}。</Text>
 <Text>目前狀態：{phases[plan.lifecycle]??plan.lifecycle}{plan.archived?'；已歸檔':''}；報名{plan.registrationOpen?'開啟（仍受截止時間限制）':'關閉'}。</Text>
 <Text>操作：{c.kind==='edit'?'修改安排':c.kind==='publish'?'發布草稿':c.kind==='lifecycle'?actions[c.action]:c.kind==='bot_sync'?'設定群同步':'重送原群通知'}</Text>
 {c.reason&&<Text>原因：{c.reason}</Text>}
 {(c.kind==='edit'||c.kind==='publish')&&<dl><dt>名稱</dt><dd>{v.title}</dd><dt>類型</dt><dd>{v.category}</dd><dt>地點</dt><dd>{v.location}</dd><dt>開始</dt><dd>{localTime(v.startsAt,v.timezone)}</dd><dt>報名截止</dt><dd>{localTime(v.deadline,v.timezone)}</dd><dt>退出期限</dt><dd>{localTime(v.withdrawalDeadline??v.deadline,v.timezone)}</dd><dt>時區</dt><dd>{v.timezone??'UTC（未設定）'}</dd><dt>持續</dt><dd>{v.durationHours} 小時</dd><dt>人數</dt><dd>上限 {v.capacity||'不限'}；最低 {v.minimumParticipants}</dd><dt>可見性</dt><dd>{v.visibility==='public'?'公開':'邀請可見'}</dd><dt>費用</dt><dd>{v.feePolicy||'未填'}</dd><dt>注意事項</dt><dd className="preserve-lines">{v.description||'未填'}</dd><dt>群同步</dt><dd>{v.botEnabled?'開啟':'關閉'}</dd></dl>}
 {c.kind==='edit'&&<Text>重要安排變更後，已發布活動的有效參加者須重新確認；原報名和原同意紀錄保留。</Text>}
 {plan.requiresOwnerSignup&&<Text>將發布目前草稿；發起者 {plan.ownerName} 自動報名並接受目前安排。</Text>}
 {c.kind==='bot_sync'&&<Text>群同步：{c.botEnabled?'開啟，依管理員群政策':'關閉；停止未送群通知'}。</Text>}
 {c.kind==='bot_retry'&&<Text>原群通知 #{c.outboxId}；複製原目標、內容與排程，新增一筆待送工作，原紀錄保留。</Text>}
 {c.kind==='lifecycle'&&c.action==='remove'&&<Text>原活動連結失效；停止未送群及個人通知。</Text>}
 {plan.noticeTarget!==null&&<Text>通知目標群：{plan.noticeTarget||'由 bot 設定決定'}；保存後請核對待送紀錄。</Text>}
 {plan.noticeText&&<pre className="preserve-lines">{plan.noticeText}</pre>}
 </div>;
}
