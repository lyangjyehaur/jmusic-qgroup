import { errorText, uiText } from './language';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { z } from 'zod';
import { ActivityLifecycle, ActivityLifecycleAction, ChangeActivityLifecycle } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';

type State=z.infer<typeof ActivityLifecycle>;
type Action=z.infer<typeof ActivityLifecycleAction>;
const labels:Record<Action,string>={pause:uiText("暫停報名"),resume:uiText("恢復報名"),formation:uiText("確認成團"),start:uiText("標記實際開始"),finish:uiText("標記實際結束"),cancel:uiText("取消活動"),archive:uiText("歸檔活動"),unarchive:uiText("取消歸檔"),remove:uiText("移除活動")};
const phases:Record<string,string>={draft:uiText("草稿"),scheduled:uiText("已排定"),ongoing:uiText("實際進行中"),ended:uiText("實際已結束"),cancelled:uiText("已取消")};
const hints:Record<Action,string>={pause:uiText("保留原名單與候補；暫停接收報名。"),resume:uiText("依原候補順序分配可用名額。"),formation:uiText("通知參加者與協辦；不改動報名或費用。"),start:uiText("記錄現在為實際開始時間，關閉報名並通知參加者與協辦。"),finish:uiText("記錄現在為實際結束時間，關閉報名並通知參加者核對結算。"),cancel:uiText("原名單與帳務保留，通知參加者與協辦；費用以公布的結算為準。"),archive:uiText("將活動放入往期與歸檔，保留名單與帳務。"),unarchive:uiText("恢復活動的管理入口，不會重新開放報名。"),remove:uiText("移除後無法從活動列表開啟；取消尚未送出的通知，保留操作記錄。")};
const Pending=z.object({key:z.string().uuid(),input:ChangeActivityLifecycle}).strict();
const Draft=z.object({revision:z.number().int().min(0),action:ActivityLifecycleAction.or(z.literal('')),reason:z.string(),pending:Pending.optional()}).strict();
type DraftValue=z.infer<typeof Draft>;
const empty=(data:State):DraftValue=>({revision:data.revision,action:'',reason:''});
export function ActivityLifecycleLink({eventId,viewer}:{eventId:string;viewer:Member}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-lifecycle',eventId],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/lifecycle', { params: { id: eventId } })});
  return query.error?<Button variant="ghost" onClick={()=>void query.refetch()}>重試讀取活動狀態權限</Button>:query.data?.actions.length?<Link to={'/activities/'+encodeURIComponent(eventId)+'/lifecycle'}>管理活動狀態</Link>:null;
}
export function ActivityLifecyclePage(){
  const {id=''}=useParams();
  return <><PageIntro title="管理活動狀態"/><div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)}>回到活動</Link><Link to="/activities">所有活動</Link></div><MemberAccess>{viewer=><Loader key={viewer.scope+':'+id} viewer={viewer} id={id}/>}</MemberAccess></>;
}
function Loader({viewer,id}:{viewer:Member;id:string}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-lifecycle',id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/lifecycle', { params: { id: id } }),refetchOnWindowFocus:false});
  return query.isPending?<Notice>正在讀取活動狀態…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<Editor viewer={viewer} initial={query.data}/>;
}
function time(value:string|null){return value?new Intl.DateTimeFormat('zh-TW',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Taipei'}).format(new Date(value))+'（台北）':uiText('尚未記錄');}
function Editor({viewer,initial}:{viewer:Member;initial:State}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:activity-draft:lifecycle:v1:'+viewer.scope+':'+initial.id;
  const [data,setData]=useState(initial),[message,setMessage]=useState(''),[confirm,setConfirm]=useState(false);
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed:()=>empty(data),parse:raw=>{
    const value=Draft.parse(JSON.parse(raw));return value.pending?{...value,revision:value.pending.input.revision,action:value.pending.input.action,reason:value.pending.input.reason}:!value.action&&!value.reason?empty(data):value;
  },dirty:value=>!!value.action||!!value.reason,pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,active,busy,setBusy,readError,persist}=record;
  const locked=record.locked,stale=draft.revision!==data.revision;
  const choice=data.actions.find(item=>item.action===draft.action),available=!!choice&&!choice.blockedReason&&!data.removed;
  useEffect(()=>{setConfirm(false);},[record.epoch]);
  function edit(patch:Partial<DraftValue>){record.change({...draft,...patch});setConfirm(false);setMessage('');}
  async function latest(){return scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/lifecycle', { params: { id: data.id } });}
  function update(fresh:State){setData(fresh);client.setQueryData(['private',viewer.scope,'activity-lifecycle',data.id],fresh);}
  async function rebase(){
    if(locked||!record.begin())return;
    try{const fresh=await latest();if(!active.current)return;const next={...draft,revision:fresh.revision};if(!await persist(next))return;update(fresh);setDraft(next);setConfirm(false);setMessage(uiText("已取得最新狀態；操作與原因仍保留，請重新核對後確認。"));}
    catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(active.current)setBusy(false);}
  }
  async function submit(){
    if(busy||record.unavailable)return;let operation=draft.pending;
    if(!operation){
      if(!confirm||!available||stale)return;
      const parsed=ChangeActivityLifecycle.safeParse({revision:draft.revision,action:draft.action,reason:draft.reason,confirm:true});
      if(!parsed.success){setMessage(uiText("請選擇操作，原因最多 200 字。"));return;}
      if(choice?.requiresReason&&!parsed.data.reason){setMessage(uiText("此操作必須填寫原因。"));return;}
      operation={key:crypto.randomUUID(),input:parsed.data};
    }
    const pending={...draft,pending:operation};if(!record.begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}setDraft(pending);setMessage('');let accepted=false;
    try{
      const result=await authHttp(viewer).requestContract('POST /api/v2/activities/:id/lifecycle', { params: { id: data.id }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;
      const fresh=await latest();if(!active.current)return;const next=empty(fresh);if(!await persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');setDraft(next);update(fresh);setConfirm(false);setMessage(result.removed?uiText("活動已移除。"):uiText("活動狀態已保存。"));
      void client.invalidateQueries({queryKey:['activities']});for(const key of ['activity','activity-roster','activity-arrangements','activity-conditions'])void client.invalidateQueries({queryKey:['private',viewer.scope,key,data.id]});
    }catch(error){
      if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirm(false);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認狀態操作結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  return <Surface className="detail activity-editor"><Heading level={2}>{data.title}</Heading>
    <dl><dt>目前狀態</dt><dd>{data.removed?'已移除':phases[data.lifecycle]??data.lifecycle}{data.archivedAt?' · 已歸檔':''}</dd><dt>報名開關</dt><dd>{data.registrationOpen?'開啟（仍受截止時間限制）':'關閉'}</dd><dt>成團</dt><dd>{data.formationState==='confirmed'?'已確認':'尚未確認'}</dd><dt>實際開始</dt><dd>{time(data.actualStartedAt)}</dd><dt>實際結束</dt><dd>{time(data.actualEndedAt)}</dd>{data.cancellationReason&&<><dt>取消原因</dt><dd className="preserve-lines">{data.cancellationReason}</dd></>}</dl>
    {data.removed&&<Notice>活動已移除，記錄仍保留。<Link to="/activities">回到活動列表</Link></Notice>}
    {!data.actions.length&&<Notice>目前帳號沒有活動狀態管理權限。</Notice>}
    {stale&&!draft.pending&&<Notice>活動或名單已有更新，請先核對最新狀態。</Notice>}
    {(data.actions.length>0||draft.pending)&&<form noValidate onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={locked||data.removed}><legend className="sr-only">變更活動狀態</legend>
      <div className="account-field"><label htmlFor="lifecycle-action">操作</label><select id="lifecycle-action" value={draft.action} onChange={event=>edit({action:event.target.value as DraftValue['action']})}><option value="">請選擇</option>{data.actions.map(item=><option key={item.action} value={item.action}>{labels[item.action]}</option>)}{draft.action&&!choice&&<option value={draft.action}>{labels[draft.action]}（目前不可操作）</option>}</select></div>
      {draft.action&&<Text>{hints[draft.action]}</Text>}{choice?.blockedReason&&<Notice>{choice.blockedReason}</Notice>}
      <div className="account-field"><label htmlFor="lifecycle-reason">原因{choice?.requiresReason?'（必填）':'（選填）'}</label><textarea id="lifecycle-reason" rows={3} maxLength={400} value={draft.reason} onChange={event=>edit({reason:event.target.value})}/></div>
      <label className="consent"><input type="checkbox" disabled={!available||stale} checked={confirm} onChange={event=>setConfirm(event.target.checked)}/><span>已核對目前狀態，確認{draft.action?labels[draft.action]:'此操作'}</span></label>
    </fieldset><Button type="submit" loading={busy} disabled={!!readError||(!draft.pending&&(!confirm||!available||stale))}>{draft.pending?'確認狀態操作結果':'提交狀態變更'}</Button></form>}
    {!draft.pending&&!data.removed&&<Button variant="secondary" disabled={locked} onClick={()=>void rebase()}>核對最新狀態，保留輸入</Button>}
    {message&&<Text role="status">{message}</Text>}<DraftFeedback form={record}/>
  </Surface>;
}
