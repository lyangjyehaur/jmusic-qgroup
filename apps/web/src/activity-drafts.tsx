import { activityCategories } from './activity-categories';
import { errorText, uiText } from './language';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { openDraft } from './draft-store';
import { requireLegacyAvailable } from './legacy-local-availability';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Surface, Text } from 'yahha-ui';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { z } from 'zod';
import { ActivityCopy, ActivityArrangementInput, ActivityDraft, ActivityDraftResult } from '@qgroup/contracts';
import { CreateIntentLookup } from './create-intents';
import { ActivityEditorForm as Form,ActivityEditorDraft as Draft } from './activity-draft-record';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { Button, Field, Modal, PageHeader, Select } from './kimi-ui';
import { ActionLink } from './action-link';
import { eventStartValue, isEarlyTime, schedulePreview, shiftCalendarDate, startCountdownText, wallDate, wallToISO } from './activity-schedule';

type Saved = z.infer<typeof ActivityDraft> & {assisted?:boolean};
type Values = z.infer<typeof ActivityArrangementInput>;
const categories=activityCategories;
type FormValue = z.infer<typeof Form>;
type DraftValue = z.infer<typeof Draft>;
const durations:Record<string,string>={'约K':'3','聚餐':'2','运动':'2','出游':'8','游戏':'3','其他':'3'};
const localTime=(value:string|null,zone:string|null)=>value?wallDate(value,zone):'';
const fromValues=(v:Values):FormValue=>{
  const startsAt=localTime(v.startsAt,v.timezone);
  return {...v,startsAt,eventDate:startsAt.slice(0,10),startTime:startsAt.slice(11),startDayOffset:'0',deadline:localTime(v.deadline,v.timezone),withdrawalDeadline:localTime(v.withdrawalDeadline,v.timezone),capacity:String(v.capacity),minimumParticipants:String(v.minimumParticipants),durationHours:String(v.durationHours),timezone:v.timezone??'',deadlineFollowsEnd:false};
};
const empty=():FormValue=>{
  const eventDate=shiftCalendarDate(wallDate(Date.now(),'Asia/Shanghai').slice(0,10),1),startsAt=eventDate+'T18:00';
  return {title:'',category:'约K',location:'',startsAt,deadline:eventDate+'T21:00:00',capacity:'0',description:'',durationHours:'3',withdrawalDeadline:'',visibility:'public',timezone:'Asia/Shanghai',minimumParticipants:'0',feePolicy:'',botEnabled:true,joinOwner:true,eventDate,startTime:'18:00',startDayOffset:'0',deadlineFollowsEnd:true};
};
const original=(saved:Saved|null):DraftValue=>({id:saved?.id??null,revision:saved?.revision??0,form:saved?fromValues(saved.values):empty(),reason:'',...(!saved?{clientIntent:crypto.randomUUID()}:{})});
function formStart(form:FormValue){return form.eventDate!==undefined&&form.startTime!==undefined?eventStartValue(form.eventDate,form.startTime,form.startDayOffset??'0'):form.startsAt;}
function formEnd(form:FormValue){return wallDate(Date.parse(wallToISO(formStart(form),form.timezone))+Number(form.durationHours)*3600000,form.timezone);}
function inputValues(form:FormValue){
  const integer=(value:string)=>/^\d+$/.test(value)?Number(value):NaN;
  const {eventDate,startTime,startDayOffset,deadlineFollowsEnd,...values}=form;
  return ActivityArrangementInput.parse({...values,startsAt:wallToISO(formStart(form),form.timezone),deadline:wallToISO(form.deadline,form.timezone),withdrawalDeadline:form.withdrawalDeadline?wallToISO(form.withdrawalDeadline,form.timezone):null,timezone:form.timezone.trim()||null,capacity:integer(form.capacity),minimumParticipants:integer(form.minimumParticipants),durationHours:integer(form.durationHours)});
}
export function ActivityDraftsPage(){return <><PageIntro title="活動草稿"/><div className="page-actions"><Link to="/activities">所有活動</Link><Link to="/activities/new">新增活動草稿</Link></div><MemberAccess>{viewer=><DraftList key={viewer.scope} viewer={viewer}/>}</MemberAccess></>;}
function DraftList({viewer}:{viewer:Member}){
  const [search,setSearch]=useSearchParams();const page=Math.max(1,Math.min(10000,Number(search.get('page'))||1));
  const query=useQuery({queryKey:['private',viewer.scope,'activity-drafts',page],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/me/activity-drafts', { query: {page} })});
  return query.isPending?<Notice>正在讀取活動草稿…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<>{query.data.drafts.length?<div className="event-grid">{query.data.drafts.map(draft=><Surface key={draft.id}><h2><Link to={'/activities/'+encodeURIComponent(draft.id)+'/edit'}>{draft.title}</Link></h2><Text>{draft.isOwner?'由我發起':'發起者：'+draft.ownerName}</Text><Link to={'/activities/'+encodeURIComponent(draft.id)+'/edit'}>{draft.canEdit?'編輯草稿':'查看草稿'}</Link></Surface>)}</div>:<Notice>沒有可存取的活動草稿。</Notice>}<div className="pagination">{page>1&&<Button variant="secondary" onClick={()=>setSearch({page:String(page-1)})}>上一頁</Button>}{query.data.hasMore&&<Button variant="secondary" onClick={()=>setSearch({page:String(page+1)})}>下一頁</Button>}</div></>;
}
export function ActivityDraftPage(){
  const {id}=useParams(),[search]=useSearchParams(),copyId=search.get('copyFrom');
  return <div className="kimi page form-page"><PageHeader title={id?'活動草稿':'新增活動'} back={<Link to="/activities" className="back-link"><ArrowLeft size={18}/><span>所有活動</span></Link>} actions={<ActionLink to="/me/activities/drafts">活動草稿</ActionLink>}/><MemberAccess>{viewer=>id?<Loader key={viewer.scope+':'+id} viewer={viewer} id={id}/>:copyId?<CopyLoader key={viewer.scope+':copy:'+copyId} viewer={viewer} id={copyId}/>:<Editor key={viewer.scope+':new'} viewer={viewer} initial={null}/>}</MemberAccess></div>;
}
function CopyLoader({viewer,id}:{viewer:Member;id:string}){
  const probe=useQuery({queryKey:['private',viewer.scope,'activity-copy-local',id],queryFn:async()=>{const saved=await openDraft('qgroup:rebuild:activity-draft:v1:'+viewer.scope+':copy:'+id,viewer.scope);return saved.raw!==null;},refetchOnWindowFocus:false});
  const restorable=probe.data===true;
  const query=useQuery({queryKey:['private',viewer.scope,'activity-copy',id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/copy-source', { params: { id } }),enabled:probe.isSuccess&&!probe.isFetching&&!restorable,refetchOnWindowFocus:false});
  if(probe.isPending||probe.isFetching)return <Notice>正在讀取本機原稿…</Notice>;
  if(probe.error)return <Failure error={probe.error} retry={()=>void probe.refetch()}/>;
  if(restorable)return <Editor viewer={viewer} initial={null} copyId={id}/>;
  return query.isPending?<Notice>正在讀取原活動安排…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<><Notice>已帶入原活動安排；請重新填寫日期與截止時間。名單、款項與圖片不會複製；群推送預設開啟。</Notice><Editor viewer={viewer} initial={null} copy={query.data}/></>;
}
export function ActivityArrangementPage(){
  const {id=''}=useParams();
  return <><PageIntro title="編輯活動安排"/><div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)}>回到活動</Link><Link to={'/activities/'+encodeURIComponent(id)+'/conditions'}>安排版本與確認</Link></div><MemberAccess>{viewer=><Loader key={viewer.scope+':'+id} viewer={viewer} id={id} published/>}</MemberAccess></>;
}
function Loader({viewer,id,published=false}:{viewer:Member;id:string;published?:boolean}){
  const query=useQuery({queryKey:['private',viewer.scope,published?'activity-arrangements':'activity-draft',id],queryFn:()=>(published?scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/arrangements', { params: { id: id } }):scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/draft', { params: { id: id } })),refetchOnWindowFocus:false});
  return query.isPending?<Notice>{published?'正在讀取活動安排…':'正在讀取活動草稿…'}</Notice>:query.error?<><Failure error={query.error} retry={()=>void query.refetch()}/><PendingResult viewer={viewer} id={id} published={published}/></>:<Editor viewer={viewer} initial={query.data} published={published}/>;
}
function PendingResult({viewer,id,published=false}:{viewer:Member;id:string;published?:boolean}){
  const navigate=useNavigate(),[message,setMessage]=useState(''),[completed,setCompleted]=useState(false);
  const storageKey='qgroup:rebuild:activity-draft:'+(published?'arrangements:v1:':'v1:')+viewer.scope+':'+id;
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed:()=>({...original(null),id}),parse:raw=>Draft.refine(v=>v.id===id).parse(JSON.parse(raw)),dirty:()=>false,pending:value=>!!value.pending,blocking:false});
  const {active,busy,setBusy}=record,pending=record.value.pending;
  if(record.loading||record.readError)return <DraftFeedback form={record}/>;
  if(!pending)return null;
  async function check(){
    if(!pending||!record.begin())return;
    try{const result=await scopedHttp(viewer.scope).requestContract(published?'GET /api/v2/activities/management-results/:requestId':'GET /api/v2/activities/draft-results/:requestId', { params: { requestId: pending.key } });
      if(!active.current)return;
      if(result.state==='completed'&&result.result.id===id&&result.result.removed){if(!await record.retire())return;void navigate('/me/activities/drafts',{replace:true});}
      else if(result.state==='completed'&&result.result.id===id&&pending.kind==='publish'){if(!await record.retire())return;void navigate('/activities/'+encodeURIComponent(id),{replace:true});}
      else {setCompleted(result.state==='completed'&&result.result.id===id);setMessage(result.state==='not_found'?uiText("尚無操作結果；原稿與操作編號已保留。請恢復活動存取後重試。"):uiText("原操作已保存；活動目前無法以草稿開啟，原稿已保留。"));}
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(active.current)setBusy(false);}
  }
  return <Surface><DraftFeedback form={record}/><Button loading={busy} onClick={()=>void check()}>{published?'確認安排操作結果':'確認草稿操作結果'}</Button>{message&&<Text role="status">{message}</Text>}{completed&&<Link to={'/activities/'+encodeURIComponent(id)}>開啟活動，原稿仍保留</Link>}</Surface>;
}
function Comparison({saved}:{saved:Saved}){
  const v=saved.values;
  return <Surface aria-label="目前已保存的活動安排"><h2>目前已保存的活動安排</h2><dl className="draft-comparison"><dt>活動名稱</dt><dd>{v.title}</dd><dt>活動類型</dt><dd>{categories.find(([key])=>key===v.category)?.[1]??v.category}</dd><dt>地點</dt><dd>{v.location}</dd><dt>開始時間</dt><dd>{localTime(v.startsAt,v.timezone)}</dd><dt>報名截止</dt><dd>{localTime(v.deadline,v.timezone)}</dd><dt>持續時間</dt><dd>{v.durationHours} 小時</dd><dt>人數上限／最低成團人數</dt><dd>{v.capacity||'不限'}／{v.minimumParticipants}</dd><dt>退出期限</dt><dd>{localTime(v.withdrawalDeadline,v.timezone)||'依報名截止時間'}</dd><dt>可見性</dt><dd>{v.visibility==='public'?'公開':'邀請可見'}</dd><dt>顯示時區</dt><dd>{v.timezone||'未指定'}</dd><dt>群同步</dt><dd>{v.botEnabled?'開啟':'關閉'}</dd><dt>費用規則</dt><dd>{v.feePolicy||'未填寫'}</dd><dt>活動說明</dt><dd>{v.description||'未填寫'}</dd></dl></Surface>;
}
function Editor({viewer,initial,published=false,copy,copyId}:{viewer:Member;initial:Saved|null;published?:boolean;copy?:z.infer<typeof ActivityCopy>;copyId?:string}){
  const client=useQueryClient(),navigate=useNavigate();
  const storageKey='qgroup:rebuild:activity-draft:'+(published?'arrangements:v1:':'v1:')+viewer.scope+':'+(initial?.id??(copyId||copy?'copy:'+(copyId??copy!.id):'new'));
  const seed=():DraftValue=>{if(!copy)return original(initial);const form={...empty(),...copy.values,durationHours:String(copy.values.durationHours),capacity:String(copy.values.capacity),minimumParticipants:String(copy.values.minimumParticipants),timezone:copy.values.timezone??'',botEnabled:copy.values.visibility==='public',startsAt:'',eventDate:'',startTime:'',startDayOffset:'',deadline:''};return {...original(null),form};};
  const [saved,setSaved]=useState(initial),[message,setMessage]=useState(''),[comparison,setComparison]=useState(false),[confirmRemove,setConfirmRemove]=useState(false),[confirmPublish,setConfirmPublish]=useState(false),[destination,setDestination]=useState(''),[completedId,setCompletedId]=useState('');
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed,parse:raw=>Draft.refine(value=>(!published||!value.pending||value.pending.kind==='save')&&value.id===(initial?.id??null)).parse(JSON.parse(raw)),
    dirty:value=>!!value.reason||JSON.stringify(value.form)!==JSON.stringify(original(saved).form),pending:value=>!!value.pending,blocking:!destination});
  const {value:draft,replace:setDraft,active,busy,setBusy,readError,persist,dirty,blocker}=record;
  const [lookedUp,setLookedUp]=useState<{scope:string;intent:string;id:string;epoch:number}|null>(null);
  const resolvedId=draft.legacySource?.resolvedId??(lookedUp&&lookedUp.scope===viewer.scope&&lookedUp.epoch===record.epoch&&lookedUp.intent===draft.clientIntent?lookedUp.id:undefined);
  const alreadyCreated=!saved&&!!resolvedId;
  const locked=record.locked||saved?.canEdit===false||alreadyCreated;
  useEffect(()=>{if(destination)void navigate(destination,{replace:!initial});},[destination,navigate,initial]);
  useEffect(()=>{setConfirmRemove(false);setConfirmPublish(false);},[record.epoch]);
  const [timeCheck,setTimeCheck]=useState(false),[now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
  function edit(patch:Partial<FormValue>){
    if(locked)return;
    const before=draft.form;
    if(patch.category&&before.durationHours===(durations[before.category]??'3'))patch.durationHours=durations[patch.category]??'3';
    if(patch.startTime!==undefined){
      if(isEarlyTime(patch.startTime)&&!isEarlyTime(before.startTime??before.startsAt.slice(11)))patch.startDayOffset='';
      if(!isEarlyTime(patch.startTime))patch.startDayOffset='0';
    }
    if(patch.deadline!==undefined&&patch.deadlineFollowsEnd===undefined)patch.deadlineFollowsEnd=false;
    const next={...before,...patch};
    if(['eventDate','startTime','startDayOffset','durationHours','timezone'].some(key=>key in patch)){
      try{next.startsAt=formStart(next);}catch{next.startsAt='';}
      let follow=before.deadlineFollowsEnd;
      if(follow===undefined){try{follow=!before.deadline||before.deadline===formEnd(before);}catch{follow=!before.deadline;}}
      if(follow){try{next.deadline=formEnd(next);}catch{next.deadline='';}next.deadlineFollowsEnd=true;}
    }
    if(published&&saved?.assisted&&next.deadline!==before.deadline&&before.withdrawalDeadline===before.deadline)next.withdrawalDeadline=next.deadline;
    record.change({...draft,form:next});setMessage('');setConfirmRemove(false);setConfirmPublish(false);setTimeCheck(false);
  }
  async function submit(kind:'save'|'remove'|'publish'='save',timeConfirmed=false){
    if(alreadyCreated||busy||record.unavailable||(!draft.pending&&saved?.canEdit===false))return;
    if(draft.legacySource?.reviewRequired){setMessage(uiText("請先核對目前安排與原稿，再保存或發布。"));return;}
    let operation=draft.pending;
    if(!operation){
      if(kind==='remove'){
        if(!saved?.canRemove||!confirmRemove)return;
        operation={kind:'remove',key:crypto.randomUUID(),input:{revision:draft.revision,confirm:true}};
      }else{
        try{
          const values=inputValues(draft.form);
          if(kind==='publish'){
            if(saved&&(!saved.isOwner||!confirmPublish||dirty))return;
            const preview=schedulePreview(new Date(values.startsAt),new Date(Date.parse(values.startsAt)+values.durationHours*3600000),values.timezone);
            if(preview.requiresConfirmation&&!timeConfirmed){setTimeCheck(true);return;}
          }
          operation=saved?(kind==='publish'?{kind:'publish',key:crypto.randomUUID(),input:{revision:draft.revision,confirm:true,acceptConditions:true}}:{kind:'save',key:crypto.randomUUID(),input:{revision:draft.revision,values,reason:draft.reason}}):{kind:'create',key:crypto.randomUUID(),input:{values,clientIntent:draft.clientIntent??crypto.randomUUID(),...(kind==='publish'?{publish:true,confirm:true,acceptConditions:true}:{})}};
        }catch(error){setAdvanced(true);setMessage(error instanceof z.ZodError?uiText("請檢查必填欄位、時間與人數範圍。"):error instanceof Error?errorText(error):uiText("請檢查必填欄位、時間與人數範圍。"));return;}
      }
    }
    setTimeCheck(false);
    const pending={...draft,...(operation.kind==='create'&&operation.input.clientIntent?{clientIntent:operation.input.clientIntent}:{}),pending:operation};if(!record.begin())return;
    if(!draft.pending){try{await requireLegacyAvailable(viewer.scope,saved?'/activities/'+encodeURIComponent(saved.id)+(published?'/arrangements':'/edit'):'/activities/new');}catch(error){if(active.current){setMessage(error instanceof Error?errorText(error):uiText("尚未送出，請先核對原紀錄。"));setBusy(false);}return;}}
    if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}setDraft(pending);setMessage('');let accepted=false;
    try{
      let result:z.infer<typeof ActivityDraftResult>;
      if(operation.kind==='create')result=await authHttp(viewer).requestContract('POST /api/v2/activities/drafts', { body: operation.input, requestId: operation.key, requestScope: viewer.scope });
      else if(operation.kind==='remove')result=await authHttp(viewer).requestContract('POST /api/v2/activities/:id/draft/remove', { params: { id: initial?.id??'' }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });
      else if(operation.kind==='publish')result=await authHttp(viewer).requestContract('POST /api/v2/activities/:id/draft/publish', { params: { id: initial?.id??'' }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });
      else result=await authHttp(viewer).requestContract(published?'PUT /api/v2/activities/:id/arrangements':'PUT /api/v2/activities/:id/draft', { params: { id: initial?.id??'' }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;
      if(!active.current)return;
      if(result.removed){if(!await record.retire())throw Error('storage');setDestination('/me/activities/drafts');}
      else if(operation.kind==='publish'||(operation.kind==='create'&&operation.input.publish)){if(!await record.retire())throw Error('storage');void client.invalidateQueries({queryKey:['activities']});setDestination('/activities/'+encodeURIComponent(result.id));}
      else{
        let latest:Saved;
        try{latest=await (published?scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/arrangements', { params: { id: result.id } }):scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/draft', { params: { id: result.id } }));}
        catch(error){
          if(!active.current)return;
          if(error instanceof ApiError&&[404,409].includes(error.status)){setCompletedId(result.id);setMessage(uiText("原操作已保存；活動目前無法以草稿開啟，原稿與操作編號已保留。"));return;}
          throw error;
        }
        if(!active.current)return;
        if(operation.kind==='create'){
          const targetKey='qgroup:rebuild:activity-draft:v1:'+viewer.scope+':'+result.id;if(!await record.retire({key:targetKey,value:original(latest)}))throw Error('storage');setDestination('/activities/'+encodeURIComponent(result.id)+'/edit');
        }else{
          const next=original(latest);if(!await persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');setDraft(next);setSaved(latest);setComparison(false);setConfirmRemove(false);setConfirmPublish(false);
          client.setQueryData(['private',viewer.scope,published?'activity-arrangements':'activity-draft',result.id],latest);
          setMessage(result.revision===latest.revision?(published?uiText("活動安排已保存。"):uiText("活動草稿已保存。")):(published?uiText("原操作已保存，安排已再次變更；請核對目前安排。"):uiText("原操作已保存，草稿已再次變更；請核對目前安排。")));
        }
      }
      void client.invalidateQueries({queryKey:['private',viewer.scope,'activity-drafts']});
      void client.invalidateQueries({queryKey:['private',viewer.scope,'activity',result.id]});
      if(published){void client.invalidateQueries({queryKey:['activities']});void client.invalidateQueries({queryKey:['private',viewer.scope,'activity-conditions',result.id]});void client.invalidateQueries({queryKey:['private',viewer.scope,'activity-roster',result.id]});}
    }catch(error){
      if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);if(published)setAdvanced(true);setMessage(errorText(error));}
      else setMessage(operation.kind==='create'&&operation.input.publish?uiText("尚未確認活動發布結果。原操作已保留，請按「確認發布結果」安全重試。"):published?uiText("尚未確認活動安排保存結果。原操作已保留，請按「確認安排操作結果」安全重試。"):uiText("尚未確認活動草稿操作結果。原操作已保留，請按「確認草稿操作結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  async function rebase(){
    if(!saved||draft.pending||readError||busy)return;setBusy(true);
    try{const latest=await (published?scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/arrangements', { params: { id: initial?.id??'' } }):scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/draft', { params: { id: initial?.id??'' } }));if(!active.current)return;const next={...draft,revision:latest.revision,...(draft.legacySource?{legacySource:{...draft.legacySource,reviewRequired:false}}:{})};if(!await persist(next))return;setDraft(next);setSaved(latest);setComparison(true);setConfirmRemove(false);setConfirmPublish(false);setMessage(uiText("已取得目前安排；輸入仍保留，請核對後再保存。"));}
    catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(active.current)setBusy(false);}
  }
  const f=draft.form;const owner=saved?.isOwner??true;
  const eventDate=f.eventDate??f.startsAt.slice(0,10),startTime=f.startTime??f.startsAt.slice(11),early=isEarlyTime(startTime);
  let preview:ReturnType<typeof schedulePreview>|null=null,countdown='';
  try{const start=new Date(wallToISO(formStart(f),f.timezone));preview=schedulePreview(start,new Date(+start+Number(f.durationHours)*3600000),f.timezone);countdown=startCountdownText(start,now);}catch{}
  const [advanced,setAdvanced]=useState(published);
  return <>{blocker.state==='blocked'&&<Surface role="alert"><Text>仍有活動草稿或待確認操作。</Text><Button onClick={()=>blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={()=>void record.leave()}>保留草稿並離開</Button></Surface>}
    {saved&&<div className="page-actions"><Link to={'/activities/'+encodeURIComponent(saved.id)+'/delegation'}>管理分工</Link></div>}
    {comparison&&saved&&<Comparison saved={saved}/>}
    {draft.legacySource&&<Notice>已帶入舊稿；原保存版本：{draft.legacySource.baseRevision??'未記錄'}。{draft.legacySource.reviewRequired?'請先核對目前安排，輸入仍保留。':''}{draft.legacySource.notes.map((note,i)=><Text key={i}>{note.field}：{note.original||'未填'}。{note.message}；請在對應欄位補齊。</Text>)}</Notice>}
    {published&&saved?.assisted&&<Notice>以管理員身分協助修改，必須填寫原因；不授予名單或帳務權限。原退出期限若連動報名截止，會一併連動。</Notice>}
    {published&&saved?.canEdit===false&&<Notice>目前不能修改活動安排；請核對活動狀態與管理權限。</Notice>}
    <div className="activity-editor"><form className="activity-form" noValidate onSubmit={event=>{event.preventDefault();void submit(saved?'save':'publish');}}>
      <fieldset className="activity-form-fields" disabled={locked}><legend className="sr-only">活動安排</legend>
      <section className="form-section"><div className="section-heading"><h2>基本資料</h2></div><div className="form-grid">
        <Field label="活動名稱" required className="span-2"><input value={f.title} maxLength={120} onChange={e=>edit({title:e.target.value})}/></Field>
        <Field label="活動類型"><Select value={f.category} onChange={e=>edit({category:e.target.value})}>{categories.map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></Field>
        <Field label="地點" required><input value={f.location} maxLength={240} onChange={e=>edit({location:e.target.value})}/></Field>
        <Field label="注意事項" className="span-2"><textarea id="activity-description" rows={4} value={f.description} maxLength={6000} onChange={e=>edit({description:e.target.value})}/></Field>
      </div></section>
      <section className="form-section"><div className="section-heading"><h2>時間安排</h2></div><div className="form-grid three-cols">
        <Field label="活動日期" required><input type="date" value={eventDate} onChange={e=>edit({eventDate:e.target.value,startTime})}/></Field>
        <Field label="開始時間" required><input type="time" step="1" value={startTime} onChange={e=>edit({startTime:e.target.value,eventDate})}/></Field>
        <Field label="持續時間" required><Select value={f.durationHours} onChange={e=>edit({durationHours:e.target.value})}>{Array.from({length:24},(_,i)=><option key={i+1} value={String(i+1)}>{i+1} 小時</option>)}</Select></Field>
        {early&&<Field label="凌晨屬於哪一晚" required className="span-2"><Select value={f.startDayOffset??'0'} onChange={e=>edit({startDayOffset:e.target.value,eventDate,startTime})}><option value="">請選擇</option><option value="0">當天凌晨（前一晚過後）</option><option value="1">次日凌晨（相約當晚過後）</option></Select></Field>}
      </div>
      <div className="activity-schedule-preview" aria-live="polite">{preview?<><p className="activity-schedule-lines">{preview.text}</p><p>{countdown}</p></>:<p>{early?uiText('請選擇凌晨屬於哪一晚，核對完整開始與結束日期。'):uiText('請填寫有效的活動日期、時間與時長。')}</p>}</div>
      </section>
      <section className="form-section"><div className="section-heading"><h2>報名設定</h2></div><div className="form-grid">
        <Field label="最低成團人數" hint="0 表示不設定門檻"><input type="number" min="0" max="500" step="1" value={f.minimumParticipants} onChange={e=>edit({minimumParticipants:e.target.value})}/></Field>
      </div>
      <label className="switch-row"><span><strong>{published?'同步到 QQ 群':'發布後同步到 QQ 群'}</strong>{f.visibility!=='public'&&<small>邀請可見活動不能同步到公開群。</small>}</span><input type="checkbox" aria-label={published?'同步到 QQ 群':'發布後同步到 QQ 群'} checked={f.botEnabled} disabled={!owner||f.visibility!=='public'||locked} onChange={e=>edit({botEnabled:e.target.checked})}/><i/></label>
      </section>
      <section className={'advanced-section'+(advanced?' open':'')}><button type="button" className="advanced-toggle" aria-expanded={advanced} onClick={()=>setAdvanced(value=>!value)}><span><ChevronDown size={17}/>進階設定</span></button><div hidden={!advanced} className="advanced-content form-grid">
        <Field label="人數上限" hint="0 表示不限"><input type="number" min="0" max="500" step="1" value={f.capacity} onChange={e=>edit({capacity:e.target.value})}/></Field>
        <Field label="可見性"><Select value={f.visibility} disabled={!owner||locked} onChange={e=>edit({visibility:e.target.value as FormValue['visibility'],botEnabled:e.target.value==='public'?f.botEnabled:false})}><option value="public">公開</option><option value="invitation">邀請可見</option></Select></Field>
        <Field label="報名截止" hint="預設與活動結束時間一致；可手動提前。"><input type="datetime-local" step="1" value={f.deadline} onChange={e=>edit({deadline:e.target.value})}/></Field>
        <Field label="退出期限" hint="留空依報名截止時間；僅發起者可修改。"><input type="datetime-local" step="1" value={f.withdrawalDeadline} disabled={!owner||locked} onChange={e=>edit({withdrawalDeadline:e.target.value})}/></Field>
        <Button variant="secondary" disabled={locked} onClick={()=>{try{edit({deadline:formEnd(f),deadlineFollowsEnd:true});}catch{setMessage(uiText('請先填寫有效的活動時間。'));}}}>截止跟隨活動結束</Button>
        <Field label="活動時區" hint="日期與時間依此時區輸入。"><input value={f.timezone} maxLength={100} placeholder="Asia/Shanghai" onChange={e=>edit({timezone:e.target.value})}/></Field>
        <Field label="費用規則" className="span-2"><textarea id="activity-fee" rows={3} value={f.feePolicy} maxLength={2000} disabled={!owner||locked} onChange={e=>edit({feePolicy:e.target.value})}/></Field>
        {saved&&<Field label={published?'修改原因（重要安排或管理員協助必填）':'修改原因（選填）'} className="span-2"><input value={draft.reason} maxLength={400} onChange={e=>record.change({...draft,reason:e.target.value})}/></Field>}
      </div></section>
      </fieldset>
      {!saved&&<p className="activity-publish-consent">發布即以本人報名，並接受以上安排與費用規則。</p>}
      <div className="draft-save-bar sticky-save-bar"><Text>{draft.pending?'操作結果待確認':dirty?'有未保存修改':saved?'目前安排已保存':'尚未發布'}</Text>
      {!saved&&!draft.pending&&<Button variant="secondary" disabled={locked||!!draft.legacySource?.reviewRequired} onClick={()=>void submit('save')}>建立活動草稿</Button>}
      <Button type="submit" loading={busy} disabled={alreadyCreated||record.unavailable||!!draft.legacySource?.reviewRequired||(!draft.pending&&saved?.canEdit===false)||(!dirty&&!!saved)}>{draft.pending?(draft.pending.kind==='create'&&draft.pending.input.publish?'確認發布結果':published?'確認安排操作結果':'確認草稿操作結果'):saved?(published?'保存活動安排':'保存活動草稿'):'發布活動'}</Button></div>
    </form>{saved&&saved.canEdit&&!draft.pending&&<Button variant="secondary" disabled={busy||!!readError} onClick={()=>void rebase()}>核對目前安排，保留輸入</Button>}
    {!published&&saved&&<><Notice>草稿尚未發布，尚未開放報名。</Notice>{saved.isOwner&&!draft.pending&&<div className="draft-publish"><label className="consent"><input type="checkbox" checked={confirmPublish} disabled={locked||dirty} onChange={e=>setConfirmPublish(e.target.checked)}/><span>已核對保存的安排與費用規則，同意以本人報名並發布活動</span></label>{dirty&&<Text>請先保存修改，再核對並發布。</Text>}<Button disabled={!!draft.legacySource?.reviewRequired||!confirmPublish||locked||dirty} onClick={()=>void submit('publish')}>發布活動</Button></div>}{saved.canRemove&&!draft.pending?<div className="draft-remove"><label className="consent"><input type="checkbox" checked={confirmRemove} disabled={busy||!!readError} onChange={e=>setConfirmRemove(e.target.checked)}/><span>確認刪除此活動草稿；保存的紀錄仍會保留</span></label><Button variant="secondary" disabled={!!draft.legacySource?.reviewRequired||!confirmRemove||busy||!!readError} onClick={()=>void submit('remove')}>刪除活動草稿</Button></div>:saved.isOwner&&saved.removalBlocker&&<Notice>{saved.removalBlocker}</Notice>}</>}
    {message&&<Text role="status">{message}</Text>}{completedId&&<Link to={'/activities/'+encodeURIComponent(completedId)}>開啟活動，原稿仍保留</Link>}
    {!saved&&draft.clientIntent&&!record.loading&&!readError&&<CreateIntentLookup key={viewer.scope+':'+draft.clientIntent+':'+record.epoch} viewer={viewer} kind="activity" intent={draft.clientIntent} disabled={busy} onExisting={id=>setLookedUp({id,scope:viewer.scope,intent:draft.clientIntent!,epoch:record.epoch})}/>}
    {timeCheck&&preview&&<Modal title="核對活動時間" onClose={()=>setTimeCheck(false)} footer={<><Button variant="secondary" onClick={()=>setTimeCheck(false)}>返回修改</Button><Button loading={busy} disabled={locked} onClick={()=>void submit('publish',true)}>日期無誤，發布活動</Button></>}><p className="activity-schedule-lines">{preview.text}</p><p>發布即以本人報名，並接受以上安排與費用規則。</p></Modal>}
    <DraftFeedback form={record} navigation={false}/>
    </div></>;
}
