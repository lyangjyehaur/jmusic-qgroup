import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Field } from './kimi-ui';
import { z } from 'zod';
import { AcceptActivityInvitation, ActivityInvitations, IssueActivityInvitations, RegistrationPerson } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
const guest=()=>({isSelf:false,name:'',note:'',payerKind:'self' as const});
const Pending=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('issue'),key:z.string().uuid(),input:IssueActivityInvitations}).strict(),
  z.object({kind:z.literal('accept'),key:z.string().uuid(),input:AcceptActivityInvitation}).strict(),
]);
const Draft=z.object({revision:z.number().int().min(0),people:z.array(RegistrationPerson).min(1).max(20),reason:z.string(),pending:Pending.optional()}).strict();
type DraftValue=z.infer<typeof Draft>;
const empty=(revision=0):DraftValue=>({revision,people:[guest()],reason:''});
function useDraft(viewer:Member,id:string,mode:string,revision=0){
  const storageKey='qgroup:rebuild:activity-draft:invitations:v1:'+viewer.scope+':'+id+':'+mode;
  const seed=():DraftValue=>empty(revision);
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed,parse:raw=>{
    const value=Draft.parse(JSON.parse(raw));if(value.pending&&(value.pending.kind!==(mode==='issue'?'issue':'accept')))throw Error('operation target');
    return JSON.stringify({...value,revision})===JSON.stringify(empty(revision))?seed():value;
  },dirty:value=>JSON.stringify({...value,revision})!==JSON.stringify(empty(revision)),pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,active,busy,setBusy,locked,readError,persist,begin,unavailable}=record;
  const [message,setMessage]=useState(''),[confirm,setConfirm]=useState(false);
  function reset(){setConfirm(false);}
  useEffect(reset,[record.epoch]);
  function edit(patch:Partial<DraftValue>){record.change({...draft,...patch});reset();setMessage('');}
  const guard=<><DraftFeedback form={{...record,message:message||record.message}}/></>;
  return {active,draft,setDraft,busy,setBusy,message,setMessage,confirm,setConfirm,locked,readError,persist,begin,unavailable,epoch:record.epoch,edit,guard};
}
export function ActivityInvitationsPage(){
  const {id=''}=useParams();return <><PageIntro title="補報名邀請"/><div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)}>回到活動</Link><Link to={'/activities/'+encodeURIComponent(id)+'/registration'}>管理報名與撤銷邀請</Link></div><MemberAccess>{viewer=><InvitationLoader key={viewer.scope+':'+id} viewer={viewer} id={id}/>}</MemberAccess></>;
}
function InvitationLoader({viewer,id}:{viewer:Member;id:string}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-invitations',id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/invitations', { params: { id: id } }),refetchOnWindowFocus:false});
  return query.isPending?<Notice>正在讀取邀請…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<InvitationEditor viewer={viewer} initial={query.data}/>;
}
function InvitationEditor({viewer,initial}:{viewer:Member;initial:z.infer<typeof ActivityInvitations>}){
  const [data,setData]=useState(initial),s=useDraft(viewer,initial.id,'issue',initial.revision),client=useQueryClient(),stale=s.draft.revision!==data.revision;
  const latest=()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/invitations', { params: { id: data.id } });
  function update(fresh:typeof data){setData(fresh);client.setQueryData(['private',viewer.scope,'activity-invitations',data.id],fresh);}
  async function rebase(){if(s.locked||!s.begin())return;try{const fresh=await latest();if(!s.active.current)return;const next={...s.draft,revision:fresh.revision};if(!await s.persist(next))return;update(fresh);s.setDraft(next);s.setConfirm(false);s.setMessage(uiText("已取得最新資料；原輸入保留，請重新確認。"));}catch(error){if(s.active.current)s.setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(s.active.current)s.setBusy(false);}}
  async function submit(){
    if(s.busy||s.unavailable)return;let operation=s.draft.pending;
    if(!operation){if(!s.confirm||stale||data.blocker||!data.canIssue)return;const parsed=IssueActivityInvitations.safeParse({revision:s.draft.revision,people:s.draft.people,reason:s.draft.reason,confirm:true});
      if(!parsed.success){s.setMessage(uiText("請填寫 1–20 位受邀者稱呼、備註及邀請原因；稱呼最多 24 字、備註 100 字、原因 200 字。"));return;}operation={kind:'issue',key:crypto.randomUUID(),input:parsed.data};
    }
    if(operation.kind!=='issue')return;const pending={...s.draft,pending:operation};if(!s.begin())return;if(!await s.persist(pending)||!s.active.current){if(s.active.current)s.setBusy(false);return;}s.setDraft(pending);s.setMessage('');let accepted=false;
    try{await authHttp(viewer).requestContract('POST /api/v2/activities/:id/invitations', { params: { id: data.id }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;const fresh=await latest();if(!s.active.current)return;const next=empty(fresh.revision);if(!await s.persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');s.setDraft(next);update(fresh);s.setConfirm(false);s.setMessage(uiText("邀請已建立。"));void client.invalidateQueries({queryKey:['private',viewer.scope,'activity-registration',data.id]});}
    catch(error){if(!s.active.current)return;if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await s.persist(next))s.setDraft(next);s.setConfirm(false);s.setMessage(errorText(error));}else s.setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認邀請操作結果」安全重試。"));}finally{if(s.active.current)s.setBusy(false);}
  }
  return <><Surface className="detail activity-editor"><Heading level={2}>{data.title}</Heading>{data.blocker&&<Notice>{data.blocker}</Notice>}{!data.canIssue&&<Notice>只有名單管理者可以建立補報名邀請。</Notice>}
    {(data.canIssue||s.draft.pending)&&<form noValidate onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={s.locked}><legend>受邀者</legend>{s.draft.people.map((person,index)=><fieldset key={index} className="registration-person"><legend>受邀者 {index+1}</legend><Field label="稱呼"><input id={'invite-name-'+index} maxLength={48} value={person.name} onChange={event=>s.edit({people:s.draft.people.map((p,i)=>i===index?{...p,name:event.target.value}:p)})}/></Field><Field label="公開備註"><textarea id={'invite-note-'+index} rows={2} maxLength={200} value={person.note} onChange={event=>s.edit({people:s.draft.people.map((p,i)=>i===index?{...p,note:event.target.value}:p)})}/></Field>{s.draft.people.length>1&&<Button variant="ghost" onClick={()=>s.edit({people:s.draft.people.filter((_,i)=>i!==index)})}>移除受邀者 {index+1}</Button>}</fieldset>)}<Button variant="secondary" disabled={s.draft.people.length>=20} onClick={()=>s.edit({people:[...s.draft.people,guest()]})}>新增受邀者</Button><Field label="邀請原因"><textarea id="invite-reason" rows={2} maxLength={400} value={s.draft.reason} onChange={event=>s.edit({reason:event.target.value})}/></Field><Notice>邀請不占名額；對方須登入後接受目前安排。每份連結只可使用一次。</Notice>{stale&&<Notice>活動或名單已有更新，請先核對最新資料。</Notice>}<label className="consent"><input type="checkbox" checked={s.confirm} disabled={stale||!!data.blocker||!data.canIssue} onChange={event=>s.setConfirm(event.target.checked)}/><span>已核對受邀者與原因，確認建立邀請</span></label></fieldset><Button type="submit" loading={s.busy} disabled={s.unavailable||(!s.draft.pending&&(!s.confirm||stale||!!data.blocker||!data.canIssue))}>{s.draft.pending?'確認邀請操作結果':'建立邀請'}</Button></form>}{!s.draft.pending&&<Button variant="secondary" disabled={s.locked} onClick={()=>void rebase()}>核對最新資料，保留輸入</Button>}{s.guard}</Surface>
    <Surface className="detail"><Heading level={2}>未接受的邀請</Heading>{!data.people.length?<Notice>目前沒有可由此帳號管理的待接受邀請。</Notice>:<ul className="invitation-list">{data.people.map(person=><li key={person.id}><Text>{person.name}{person.note?' · '+person.note:''}</Text><Link to={'/activities/'+encodeURIComponent(data.id)+'/invitations/'+encodeURIComponent(person.token)}>受邀者連結（{person.name}）</Link><Text className="invitation-url">{location.origin+'/activities/'+encodeURIComponent(data.id)+'/invitations/'+encodeURIComponent(person.token)}</Text><Link to={'/activities/'+encodeURIComponent(data.id)+'/registration?person='+encodeURIComponent(person.id)}>撤銷此邀請（{person.name}）</Link></li>)}</ul>}</Surface></>;
}
export function AcceptActivityInvitationPage(){
  const {id='',token=''}=useParams();return <><PageIntro title="接受補報名邀請"/><MemberAccess>{viewer=><InvitationRecipient key={viewer.scope+':'+id+':'+token} viewer={viewer} id={id} token={token}/>}</MemberAccess></>;
}
function InvitationRecipient({viewer,id,token}:{viewer:Member;id:string;token:string}){
  const s=useDraft(viewer,id,'accept:'+token),[waiting,setWaiting]=useState(false),[done,setDone]=useState(false),client=useQueryClient();
  const query=useQuery({queryKey:['private',viewer.scope,'activity-invitation',id,token],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/invitations/:token', { params: { id, token } }),refetchOnWindowFocus:false,enabled:!done}),data=query.data;
  useEffect(()=>{s.setConfirm(false);setWaiting(false);},[data?.revision,data?.conditionsVersion,data?.status,s.epoch]);
  async function submit(){
    if(s.busy||s.unavailable)return;let operation=s.draft.pending;
    if(!operation){if(!data||!s.confirm||data.blocker||(data.status==='waiting'&&!waiting))return;operation={kind:'accept',key:crypto.randomUUID(),input:{revision:data.revision,conditionsVersion:data.conditionsVersion,acceptConditions:true,acceptWaiting:waiting,confirm:true}};}
    if(operation.kind!=='accept')return;const pending={...s.draft,pending:operation};if(!s.begin())return;if(!await s.persist(pending)||!s.active.current){if(s.active.current)s.setBusy(false);return;}s.setDraft(pending);s.setMessage('');let accepted=false;
    try{await authHttp(viewer).requestContract('POST /api/v2/activities/:id/invitations/:token/accept', { params: { id: id, token }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;if(!s.active.current)return;if(!await s.persist(empty(),false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');s.setDraft(empty());s.setConfirm(false);setDone(true);s.setMessage(uiText("已接受邀請並保存報名。"));void client.invalidateQueries({queryKey:['activities']});for(const key of ['activity','activity-roster','activity-invitations','activity-registration'])void client.invalidateQueries({queryKey:['private',viewer.scope,key,id]});}
    catch(error){if(!s.active.current)return;if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await s.persist(next))s.setDraft(next);s.setConfirm(false);setWaiting(false);s.setMessage(errorText(error));}else s.setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認邀請操作結果」安全重試。"));}finally{if(s.active.current)s.setBusy(false);}
  }
  async function refresh(){if(s.locked)return;s.setConfirm(false);setWaiting(false);await query.refetch();}
  return <Surface className="detail activity-editor">{!done&&query.isPending&&<Notice>正在讀取受邀安排…</Notice>}{!done&&query.error&&!s.draft.pending&&<Failure error={query.error} retry={()=>void refresh()}/>}{!done&&data&&<><Heading level={2}>{data.title}</Heading><dl><dt>受邀稱呼</dt><dd>{data.name}</dd><dt>接受帳號</dt><dd>{viewer.nickname}</dd><dt>目前安排</dt><dd>第 {data.conditionsVersion} 版</dd><dt>時間</dt><dd>{data.arrangement.starts_at.replace('T',' ')}（{data.arrangement.timezone||'未指定時區'}）</dd><dt>持續時間</dt><dd>{data.arrangement.duration_hours===null?'未設定':data.arrangement.duration_hours+' 小時'}</dd><dt>地點</dt><dd>{data.arrangement.location}</dd><dt>退出期限</dt><dd>{data.arrangement.withdrawal_deadline.replace('T',' ')}</dd>{data.arrangement.fee_policy&&<><dt>費用規則</dt><dd className="preserve-lines">{data.arrangement.fee_policy}</dd></>}{data.arrangement.description&&<><dt>注意事項</dt><dd className="preserve-lines">{data.arrangement.description}</dd></>}<dt>目前分配</dt><dd>{data.status==='confirmed'?'正式':'候補'}</dd></dl>{data.blocker&&<Notice>{data.blocker}</Notice>}</>}
    {!done&&(data||s.draft.pending)&&<form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={s.locked||!!data?.blocker}><legend className="sr-only">本人接受邀請</legend><Notice>請確認這份邀請屬於本人。接受後以目前帳號建立本人報名，付款歸屬為參加者本人。</Notice>{data?.status==='waiting'&&<label className="consent"><input type="checkbox" checked={waiting} onChange={event=>{setWaiting(event.target.checked);s.setConfirm(false);}}/><span>目前需要候補，我接受候補</span></label>}<label className="consent"><input type="checkbox" checked={s.confirm} disabled={!data||(data.status==='waiting'&&!waiting)} onChange={event=>s.setConfirm(event.target.checked)}/><span>已核對本人身分與第 {data?.conditionsVersion??'原'} 版安排、費用，確認接受邀請</span></label></fieldset><Button type="submit" loading={s.busy} disabled={s.unavailable||(!s.draft.pending&&(!s.confirm||!data||!!data.blocker))}>{s.draft.pending?'確認邀請操作結果':'接受邀請'}</Button></form>}
    {!done&&!s.draft.pending&&data&&<Button variant="secondary" disabled={s.locked} onClick={()=>void refresh()}>核對最新安排與名額</Button>}{s.guard}{done&&<Link to={'/activities/'+encodeURIComponent(id)}>查看活動與報名</Link>}
  </Surface>;
}
