import { activityCategoryLabel } from './activity-categories';
import { errorText, uiText, displayLocale } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { LegacyInvitationInspection,LegacyInvitationResult,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyInvitationRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyInvitationInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/invitations/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let outcome:z.infer<typeof LegacyInvitationResult>;
   if(plan.state==='retryable')outcome=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/invitations/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/invitations/inspect', { body: request });if(current.state!==plan.state)throw Error('原請求結果已改變，請重新核對。');outcome=current;}
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
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看操作結果</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原邀請請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<Text>原邀請操作已提交，只保存核對結果。</Text>:<InvitationReview plan={plan} requestKey={request.requestKey}/>}
 <label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>{plan.state==='retryable'?'已核對邀請、管理責任與通知，使用原編號重試邀請操作':'保存已核對的操作結果'}</label><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='retryable'?'重試原邀請請求':'保存已核對結果'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}

const scopes:Record<string,string>={schedule:uiText('安排'),roster:uiText('名冊'),attendance:uiText('到場'),settlement:uiText('結算')};
const actions:Record<string,string>={'roster-issue':uiText('建立補報名邀請'),'roster-accept':uiText('接受补报名邀請'),'manager-issue':uiText('建立管理邀請'),'manager-accept':uiText('接受管理責任'),'invitation-revoke':uiText('撤銷管理邀請'),'role-revoke':uiText('撤銷協辦權限')};
function InvitationReview({plan,requestKey}:{plan:Extract<z.infer<typeof LegacyInvitationInspection>,{state:'retryable'}>;requestKey:string}){
 const c=plan.command,a=plan.arrangement;
 return <div aria-label="原邀請操作重試核對"><Text>{plan.title}</Text><Text>原操作編號 {requestKey}；目前版本 {plan.currentRevision}；原版本 {c.revision}。</Text><Text>操作：{actions[c.kind]}</Text>
 {plan.targetName&&<Text>對象：{plan.targetName}</Text>}
 {'reason' in c&&<Text>原因：{c.reason}</Text>}
 {c.kind==='roster-issue'&&<><ul>{c.people.map((p,i)=><li key={i}>{p.name}{p.note?' · 備註：'+p.note:''} · 付款：受邀者本人</li>)}</ul><Text>受邀者接受時確認安排；建立邀請不佔正式名額。</Text></>}
 {c.kind==='roster-accept'&&<><Text>本次接受：{plan.status==='confirmed'?'正式報名':'候補'}；原請求{c.acceptWaiting?'已':'未'}接受候補。</Text><Text>目前安排版本 {plan.conditionsVersion}；原版本 {c.conditionsVersion??'未記錄'}。</Text><dl><dt>類型</dt><dd>{activityCategoryLabel(a.category)}</dd><dt>開始</dt><dd>{new Date(a.starts_at).toLocaleString(displayLocale(),{timeZone:a.timezone??'UTC'})}</dd><dt>地點</dt><dd>{a.location}</dd><dt>費用</dt><dd>{a.fee_policy||'未填'}</dd><dt>注意事項</dt><dd className="preserve-lines">{a.description||'未填'}</dd></dl><Text>以目前帳號接受邀請及安排，沿用原邀請編號與備註。</Text></>}
 {(c.kind==='manager-issue'||c.kind==='manager-accept')&&<><Text>發起者：{plan.ownerName}</Text><Text>責任：{c.kind==='manager-issue'?c.role==='transfer'?'接任發起者':plan.permissions.map(p=>scopes[p]).join('、'):plan.permissions.length?plan.permissions.map(p=>scopes[p]).join('、'):'接任發起者'}</Text>{plan.expiresAt?<Text>邀請到期：{new Date(plan.expiresAt).toLocaleString(displayLocale())}</Text>:<Text>新邀請有效期 7 天。</Text>}
 {plan.priorRoles.length>0&&<ul>{plan.priorRoles.map((r,i)=><li key={i}>{r.name} · {r.permissions.map(p=>scopes[p]).join('、')}</li>)}</ul>}
 {(c.kind==='manager-issue'&&c.role==='transfer'||c.kind==='manager-accept'&&!plan.permissions.length)&&<Text>交接完成後，新發起者承接管理；原發起者的待接受邀請全部失效。</Text>}
 {plan.permissions.includes('settlement')&&<Text>結算人僅一位；接受後撤銷原結算人此項權限，保留其他職責。</Text>}
 {c.kind==='manager-accept'&&<Text>原請求已明確接受管理責任；按原請求接受本次交接。</Text>}</>}
 {(c.kind==='role-revoke'||c.kind==='invitation-revoke')&&<Text>{c.kind==='role-revoke'?'撤銷全部協辦職責；本人報名與活動查看權限保留。':'撤銷此份待接受邀請；之後無法以原連結接受。'}</Text>}
 <Text>保存操作紀錄，依群政策產生通知。</Text></div>;
}
