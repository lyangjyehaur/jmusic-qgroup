import { activityCategoryLabel } from './activity-categories';
import { errorText, uiText, displayLocale } from './language';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Field, Disclosure, Select, Checkbox } from './kimi-ui';
import { z } from 'zod';
import { ActivityConditions, RespondActivityConditions, type ConditionVersion, type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { type Member } from './member-access';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { ActivityLocation } from './activity-sharing';
type Conditions=z.infer<typeof ActivityConditions>;
const choices={accepted:uiText("接受"),declined:uiText("暫不同意"),pending:uiText("待確認")};
const Pending=z.object({key:z.string().uuid(),personId:z.string().min(1),input:RespondActivityConditions}).strict();
const Draft=z.object({revision:z.number().int().min(0),conditionsVersion:z.number().int().min(1),personId:z.string(),decision:z.enum(['accepted','declined']),reason:z.string(),pending:Pending.optional()}).strict();
type DraftValue=z.infer<typeof Draft>;
const original=(data:Conditions):DraftValue=>({revision:data.revision,conditionsVersion:data.current.version,personId:'',decision:'accepted',reason:''});
function dateLabel(value:string,zone:string|null){
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!zone)return value.replace('T',' ');
  try{return new Intl.DateTimeFormat(displayLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(value));}catch{return value;}
}
function Version({value,heading}:{value:z.infer<typeof ConditionVersion>;heading:string}){
  const a=value.arrangement;
  return <Surface role="region" aria-label={heading} className="detail"><Heading level={2}>{heading} · 第 {value.version} 版</Heading><Text>{value.summary}</Text>{value.actorName&&<Text tone="muted">{value.actorName} · {dateLabel(value.createdAt,'Asia/Taipei')}（台北）</Text>}<dl><dt>類型</dt><dd>{activityCategoryLabel(a.category)}</dd><dt>時間</dt><dd>{dateLabel(a.starts_at,a.timezone)}（{a.timezone||'未指定時區'}）</dd><dt>持續時間</dt><dd>{a.duration_hours===null?'未設定':a.duration_hours+' 小時'}</dd><dt>地點</dt><dd><ActivityLocation value={a.location}/></dd><dt>退出期限</dt><dd>{dateLabel(a.withdrawal_deadline,a.timezone)}</dd>{a.fee_policy&&<><dt>費用規則</dt><dd className="preserve-lines">{a.fee_policy}</dd></>}{a.description&&<><dt>注意事項</dt><dd className="preserve-lines">{a.description}</dd></>}</dl></Surface>;
}
export function ActivityManagementLink({eventId,viewer}:{eventId:string;viewer:Member}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-arrangements',eventId],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/arrangements', { params: { id: eventId } })});
  return query.error?<Button variant="ghost" onClick={()=>void query.refetch()}>重試讀取活動管理權限</Button>:query.data?.canEdit?<Link to={'/activities/'+encodeURIComponent(eventId)+'/arrangements'}>編輯活動安排</Link>:null;
}
export function ActivityConditionsPage(){
  const {id=''}=useParams(),session=useSession();
  return <><PageIntro title="安排版本與確認"/><div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)}>回到活動</Link><Link to={'/activities/'+encodeURIComponent(id)+'/share?kind=conditions'}>分享目前安排</Link></div>{session.error?<Failure error={session.error} retry={()=>void session.refetch()}/>:!session.data?<Notice>正在確認帳號…</Notice>:<ConditionsContent key={session.data.scope+':'+id} viewer={session.data} id={id}/>}</>;
}
function ConditionsContent({viewer,id}:{viewer:Viewer;id:string}){
  const client=useQueryClient();
  const [search,setSearch]=useSearchParams(),page=Math.max(1,Math.min(10000,Number(search.get('page'))||1));
  const query=useQuery({queryKey:['private',viewer.scope,'activity-conditions',id,page],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/conditions', { params: { id: id }, query: { page } }),refetchOnWindowFocus:false});
  if(query.isPending)return <Notice>正在讀取活動安排…</Notice>;
  if(query.error)return <Failure error={query.error} retry={()=>void query.refetch()}/>;
  const data=query.data;
  const preferred=search.get('person')??'';
  return <><Version value={data.current} heading={uiText("目前安排")}/>{viewer.authenticated&&<ConsentEditor key={viewer.scope+':'+id} viewer={viewer} initial={data} preferred={preferred} update={fresh=>{client.setQueryData<Conditions>(['private',viewer.scope,'activity-conditions',id,page],prior=>prior?{...prior,...(page===fresh.page?fresh:{}),current:fresh.current,revision:fresh.revision,people:fresh.people,canRespond:fresh.canRespond}:prior);}}/>}
    <section aria-label="安排歷史"><Heading level={2}>安排歷史</Heading>{data.history.map(value=><Disclosure key={value.version}  title={<>第 {value.version} 版 · {value.summary}</>}><Version value={value} heading={uiText("保存的安排")}/></Disclosure>)}{!data.history.length&&<Notice>尚未發布安排版本。</Notice>}<div className="pagination">{page>1&&<Button variant="secondary" onClick={()=>setSearch({page:String(page-1)})}>上一頁</Button>}{data.hasMore&&<Button variant="secondary" onClick={()=>setSearch({page:String(page+1)})}>下一頁</Button>}</div></section></>;
}
function ConsentEditor({viewer,initial,preferred,update}:{viewer:Member;initial:Conditions;preferred:string;update:(data:Conditions)=>void}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:activity-draft:consent:v1:'+viewer.scope+':'+initial.id;
  const [data,setData]=useState(initial),[message,setMessage]=useState(''),[confirm,setConfirm]=useState(false);
  const seed=():DraftValue=>({...original(data),personId:data.people.some(person=>person.id===preferred)?preferred:''});
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed,parse:raw=>{
    const value=Draft.parse(JSON.parse(raw));return !value.personId&&!value.reason&&!value.pending&&value.decision==='accepted'?seed():value;
  },needsRestore:raw=>{const value=Draft.parse(JSON.parse(raw));return !!value.personId||!!value.reason||value.decision!=='accepted';},dirty:value=>!!value.personId||!!value.reason||value.decision!=='accepted',pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,active,busy,setBusy,readError,persist}=record;
  const locked=record.locked,stale=draft.revision!==data.revision||draft.conditionsVersion!==data.current.version;
  useEffect(()=>{setConfirm(false);},[record.epoch]);
  function edit(patch:Partial<DraftValue>){record.change({...draft,...patch});setConfirm(false);setMessage('');}
  async function latest(){return scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/conditions', { params: { id: data.id } });}
  async function rebase(){
    if(locked||!record.begin())return;
    try{const fresh=await latest();if(!active.current)return;const next={...draft,revision:fresh.revision,conditionsVersion:fresh.current.version};if(!await persist(next))return;setData(fresh);setDraft(next);setConfirm(false);update(fresh);setMessage(uiText("已取得最新安排；選擇與原因仍保留，請重新核對後確認。"));}
    catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(active.current)setBusy(false);}
  }
  async function submit(){
    if(busy||record.unavailable)return;let operation=draft.pending;
    if(!operation){
      if(!confirm||!data.canRespond||!data.people.some(person=>person.id===draft.personId))return;
      const parsed=RespondActivityConditions.safeParse({revision:draft.revision,conditionsVersion:draft.conditionsVersion,decision:draft.decision,reason:draft.reason});
      if(!parsed.success){setMessage(uiText("暫不同意新安排時請填寫原因（最多 200 字）。"));return;}
      operation={key:crypto.randomUUID(),personId:draft.personId,input:parsed.data};
    }
    const pending={...draft,pending:operation};if(!record.begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}setDraft(pending);setMessage('');let accepted=false;
    try{
      await authHttp(viewer).requestContract('POST /api/v2/activities/:id/attendees/:personId/conditions', { params: { id: data.id, personId: operation.personId }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;
      const fresh=await latest();if(!active.current)return;const next=original(fresh);if(!await persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');setDraft(next);setData(fresh);setConfirm(false);update(fresh);setMessage(uiText("安排確認已保存。"));
      void client.invalidateQueries({queryKey:['private',viewer.scope,'activity-roster',data.id]});void client.invalidateQueries({queryKey:['private',viewer.scope,'activity',data.id]});
    }catch(error){
      if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirm(false);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認安排回覆結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  return <Surface className="detail activity-editor"><Heading level={2}>我的安排確認</Heading>
    {data.people.length?<ul>{data.people.map(person=><li key={person.id}>{person.name} · {choices[person.confirmationState as keyof typeof choices]??person.confirmationState} · 已接受版本 {person.acceptedVersion??'無'}</li>)}</ul>:<Notice>目前沒有由此帳號管理的有效報名。</Notice>}
    {!data.canRespond&&<Notice>活動已結束、取消或歸檔，不能回覆新安排。</Notice>}
    {stale&&!draft.pending&&<Notice>原稿對應的安排或名單已有更新，請先核對最新安排。</Notice>}
    <form noValidate onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={locked||!data.canRespond}><legend className="sr-only">逐人確認安排</legend>
      <Field label="報名者"><Select id="condition-person" value={draft.personId} onChange={event=>edit({personId:event.target.value})}><option value="">請選擇</option>{data.people.map((person,index)=><option key={person.id} value={person.id}>{index+1}. {person.name}</option>)}{draft.personId&&!data.people.some(person=>person.id===draft.personId)&&<option value={draft.personId}>原報名目前不可操作</option>}</Select></Field>
      <Field label="決定"><Select id="condition-decision" value={draft.decision} onChange={event=>edit({decision:event.target.value as DraftValue['decision']})}><option value="accepted">接受新安排</option><option value="declined">暫不同意新安排</option></Select></Field>
      <Field label="原因（暫不同意時必填）"><textarea id="condition-reason" rows={3} maxLength={400} value={draft.reason} onChange={event=>edit({reason:event.target.value})}/></Field>
      <Text>暫不同意會保留原報名與原接受版本，通知發起者協調；不自動退出或增加費用責任。</Text>
      <Checkbox className="consent" disabled={stale} checked={confirm} onChange={event=>setConfirm(event.target.checked)} label={<><span>已核對第 {draft.conditionsVersion} 版安排，確認提交此人的決定</span></>} />
    </fieldset><Button type="submit" loading={busy} disabled={!!readError||(!draft.pending&&(!confirm||!data.canRespond||!draft.personId))}>{draft.pending?'確認安排回覆結果':'提交安排確認'}</Button></form>
    {!draft.pending&&<Button variant="secondary" disabled={locked} onClick={()=>void rebase()}>核對最新安排，保留輸入</Button>}
    <DraftFeedback form={{...record,message:message||record.message}}/>
  </Surface>;
}
