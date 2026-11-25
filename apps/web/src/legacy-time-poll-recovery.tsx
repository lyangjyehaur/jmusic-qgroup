import { errorText, uiText } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { LegacyTimePollInspection,LegacyRequestReceipt,legacyTimePollId,type LegacyRequestCheck } from '@qgroup/contracts';
import type { z } from 'zod';
import { authHttp } from './auth';
import { Notice } from './shared';
import type { Member } from './member-access';
import { deviceDraftEpoch } from './draft-store';
import { describeLegacy } from './legacy-local-record';
import { mapLegacySources,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
type Request=z.infer<typeof LegacyRequestCheck>;
export function LegacyTimePollRecovery({viewer,inventory,row,request,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;request:Request;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const preparedEpoch=useRef<number|null>(null),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[plan,setPlan]=useState<z.infer<typeof LegacyTimePollInspection>|null>(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 let decoded:ReturnType<typeof legacyTimePollId>;try{decoded=legacyTimePollId(request);}catch{return <Notice>原時間投票方法或路徑尚未完成對應；請保全並核對原結果，不能重試。</Notice>;}
 const path='/time-polls/'+encodeURIComponent(decoded.id)+(decoded.vote?'':'/manage'),mapped=inventory.mappings.find(m=>m.id===row.id);
 async function original(){const fresh=await validate(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method+' '+request.path+' '+JSON.stringify(request.data))),fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(row.sourceKey!=='request:'+viewer.scope+':'+fingerprint)throw Error('原請求的本機內容識別不一致，請保留並核對，不能重試。');return fresh;}
 async function check(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);preparedEpoch.current=null;try{const epoch=await deviceDraftEpoch(),fresh=await original();if(!active.current)return;const result=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/time-poll/inspect', { body: request });await original();if(await deviceDraftEpoch()!==epoch)throw Error('本機紀錄已變更，請重新檢查原請求。');if(active.current){preparedEpoch.current=epoch;setPlan(result);}}catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求尚未確認，請保留紀錄。"));}finally{if(active.current)setBusy(false);}}
 async function finish(){if(busy||!plan||!confirm)return;setBusy(true);setMessage('');
  let deviceEpoch:number|null=null;const guard=async()=>{const fresh=await original();if(!active.current||fresh.scope!==viewer.scope||deviceEpoch===null||await deviceDraftEpoch()!==deviceEpoch)throw Error('帳號、頁面或本機紀錄已變更，不能確認原請求恢復。');return fresh;};
  try{
   deviceEpoch=preparedEpoch.current;if(deviceEpoch===null)throw Error('請重新檢查原請求。');const fresh=await guard();let receipt:z.infer<typeof LegacyRequestReceipt>;
   if(plan.state==='retryable')receipt=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/time-poll/retry', { body: {...request,confirm:true,recovery_token:plan.recovery_token} });
   else {const current=await authHttp(fresh).requestContract('POST /api/v2/me/legacy-requests/time-poll/inspect', { body: request });if(current.state!=='committed')throw Error('原請求結果已改變，請重新核對。');receipt=current.receipt;}
   if(!receipt.committed)throw Error('原請求結果已改變，請重新核對。');
   await guard();const current=await preserveLegacy(viewer.scope);if(current.disabled||current.epoch!==inventory.epoch)throw Error('原紀錄已因登出清除，不能確認恢復。');
   const resolved=new Set(current.mappings.filter(m=>m.deviceEpoch===deviceEpoch).map(m=>m.id)),rows=current.rows.filter(candidate=>candidate.sourceKey===row.sourceKey&&!resolved.has(candidate.id)&&JSON.stringify(describeLegacy(candidate.source,viewer.scope).request)===JSON.stringify(request));
   if(!rows.some(candidate=>candidate.id===row.id))throw Error('原請求已有不同核對結果，請重新讀取。');
   await guard();await mapLegacySources(viewer.scope,inventory.epoch,rows,{sourceId:row.id,key:'qgroup:rebuild:original-request:v1:'+viewer.scope+':'+request.requestKey,path,deviceEpoch,kind:'request'});
   await guard();if(active.current){setMessage(uiText("原請求已完成，恢復紀錄已保存。"));await refresh();}
  }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("原請求結果或本機紀錄尚未確認；請重新核對原結果，原編號保留。"));}finally{if(active.current)setBusy(false);}
 }
 if(mapped?.kind==='request')return <Notice>原請求已完成，恢復紀錄已保存。<Link to={mapped.path}>查看時間投票</Link></Notice>;
 if(mapped)return <Notice>此原請求已有其他核對目的，請先查看原紀錄。</Notice>;
 return <div className="legacy-conversion"><Button variant="secondary" disabled={busy} onClick={()=>void check()}>檢查原時間投票請求的恢復</Button>{plan&&<Notice>{plan.state==='committed'?<Text>原操作已提交，只保存已核對結果；不重新投票、建立活動或通知。</Text>:<PollReview plan={plan} requestKey={request.requestKey}/>}
 <label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>{plan.state==='committed'?'保存原請求已完成的核對結果':'已核對原選擇、操作、安排及通知，使用原編號重試原時間投票操作'}</label><Button disabled={busy||!confirm} onClick={()=>void finish()}>{plan.state==='committed'?'保存已核對結果':'重試原時間投票操作'}</Button></Notice>}{message&&<Notice>{message}</Notice>}</div>;
}
const choices={yes:'可以',maybe:'勉強可以',no:'不行'};
const localTime=(value:string,zone:string)=>new Intl.DateTimeFormat('zh-TW',{timeZone:zone,dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(value));
const actions={close:'提前截止',extend:'調整截止並開放',cancel:'取消投票',remove:'移除投票',bot_sync:'設定群同步',bot_retry:'重送群通知',finalize:'定案並建立活動'};
function PollReview({plan,requestKey}:{plan:Extract<z.infer<typeof LegacyTimePollInspection>,{state:'retryable'}>;requestKey:string}) {
 const p=plan.current,c=plan.command,f=plan.finalization;
 return <div aria-label="原時間投票重試核對"><Text>{p.title}</Text><Text>原安排版本 {c.revision}；目前票數版本 {p.vote_revision}；原操作編號 {requestKey}。</Text>
 {'choices' in c ? <><Text>提交填答；不占正式報名名額。</Text>{p.options.map(o=>{const submitted=c.choices.find(v=>v.option_id===o.id)?.choice;return <Text key={o.id}>{o.date}{o.starts_at?' · '+localTime(o.starts_at,p.timezone):''}：原選擇 {submitted?choices[submitted]:'未提交'}；目前 {p.my_choices[o.id]?choices[p.my_choices[o.id]!]:'未填'}{o.expired?'；已過期，維持目前選擇':''}</Text>;})}</> : <>
 <Text>操作：{actions[c.action]}</Text>{c.reason&&<Text>原因：{c.reason}</Text>}
 {c.action==='extend'&&<Text>投票截止：{localTime(c.deadline,p.timezone)}</Text>}
 {c.action==='bot_sync'&&<Text>群同步：{c.bot_enabled?'開啟（依管理員群政策）':'關閉；停止未送通知'}</Text>}
 {c.action==='bot_retry'&&<Text>原群通知 #{c.outbox_id}；本次會新增一筆待送工作，原紀錄保留。</Text>}
 {c.action==='close'&&<Text>提前截止並停止未送投票通知；已有填答保留。</Text>}
 {c.action==='cancel'&&<Text>取消投票並停止未送投票通知。</Text>}
 {c.action==='remove'&&<Text>原投票連結失效；停止未送通知。已建立的活動與已發送群訊息保留。</Text>}
 {f&&c.action==='finalize'&&<><Text>原票數版本 {c.base_vote_revision}；{f.respondent_count} 人填答。</Text>
 {p.options.map(o=><Text key={o.id}>{o.id===c.option_id?'定案候選：':''}{o.date}{o.starts_at?' · '+localTime(o.starts_at,p.timezone):''}；可以 {f.counts[o.id]!.yes} · 勉強可以 {f.counts[o.id]!.maybe} · 不行 {f.counts[o.id]!.no}{o.expired?'；已過期':''}</Text>)}
 <dl><dt>開始</dt><dd>{localTime(f.starts_at,p.timezone)}</dd><dt>時區</dt><dd>{p.timezone}</dd><dt>持續</dt><dd>{f.duration_hours} 小時</dd><dt>正式報名截止</dt><dd>{localTime(f.registration_deadline,p.timezone)}</dd><dt>地點</dt><dd>{p.location}</dd><dt>人數</dt><dd>上限 {p.capacity||'不限'} · 最低 {p.minimum_participants}</dd><dt>費用</dt><dd>{p.fee_policy||'未填'}</dd></dl>
 {p.description&&<Text className="preserve-lines">{p.description}</Text>}
 <Notice>將建立公開活動，發起者 {p.owner_name} 自動接受初始安排並報名；其他填答者只收到定案通知，須另外報名。活動群通知仍依群政策。</Notice>
 </>}
 </>}
 {plan.group_preview&&<><Text>本次群通知內容</Text><pre className="preserve-lines">{plan.group_preview}</pre></>}
 </div>;
}
