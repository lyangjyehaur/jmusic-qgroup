import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { ActivityArrangementInput, ActivityDraft, ActivityDraftList, ActivityDraftResult, ActivityDraftOperationResult, CreateActivityDraft, SaveActivityDraft, RemoveActivityDraft } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';

type Saved = z.infer<typeof ActivityDraft>;
type Values = z.infer<typeof ActivityArrangementInput>;
const categories=[['约K','約 K'],['聚餐','聚餐'],['运动','運動'],['出游','出遊'],['游戏','遊戲'],['其他','其他']];
const Form = z.object({title:z.string(),category:z.string(),location:z.string(),startsAt:z.string(),deadline:z.string(),capacity:z.string(),description:z.string(),durationHours:z.string(),withdrawalDeadline:z.string(),visibility:z.enum(['public','invitation']),timezone:z.string(),minimumParticipants:z.string(),feePolicy:z.string(),botEnabled:z.boolean(),joinOwner:z.boolean()}).strict();
type FormValue = z.infer<typeof Form>;
const Pending = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('create'),key:z.string().uuid(),input:CreateActivityDraft}).strict(),
  z.object({kind:z.literal('save'),key:z.string().uuid(),input:SaveActivityDraft}).strict(),
  z.object({kind:z.literal('remove'),key:z.string().uuid(),input:RemoveActivityDraft}).strict(),
]);
const Draft = z.object({id:z.string().nullable(),revision:z.number().int().min(0),form:Form,reason:z.string().default(''),pending:Pending.optional()}).strict();
type DraftValue = z.infer<typeof Draft>;
// Editing uses an explicit fixed offset, independent of the browser / event display zone.
const localTime=(value:string|null)=>value?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19):'';
const fromValues=(v:Values):FormValue=>({...v,startsAt:localTime(v.startsAt),deadline:localTime(v.deadline),withdrawalDeadline:localTime(v.withdrawalDeadline),capacity:String(v.capacity),minimumParticipants:String(v.minimumParticipants),durationHours:String(v.durationHours),timezone:v.timezone??''});
const empty=():FormValue=>({title:'',category:'约K',location:'',startsAt:'',deadline:'',capacity:'0',description:'',durationHours:'3',withdrawalDeadline:'',visibility:'public',timezone:'Asia/Taipei',minimumParticipants:'0',feePolicy:'',botEnabled:false,joinOwner:true});
const original=(saved:Saved|null):DraftValue=>({id:saved?.id??null,revision:saved?.revision??0,form:saved?fromValues(saved.values):empty(),reason:''});
function inputValues(form:FormValue){
  const integer=(value:string)=>/^\d+$/.test(value)?Number(value):NaN;
  return ActivityArrangementInput.parse({...form,startsAt:form.startsAt+'+08:00',deadline:form.deadline+'+08:00',withdrawalDeadline:form.withdrawalDeadline?form.withdrawalDeadline+'+08:00':null,timezone:form.timezone.trim()||null,capacity:integer(form.capacity),minimumParticipants:integer(form.minimumParticipants),durationHours:integer(form.durationHours)});
}
export function ActivityDraftsPage(){return <><PageIntro title="活動草稿"/><div className="page-actions"><Link to="/activities">所有活動</Link><Link to="/activities/new">新增活動草稿</Link></div><MemberAccess>{viewer=><DraftList key={viewer.scope} viewer={viewer}/>}</MemberAccess></>;}
function DraftList({viewer}:{viewer:Member}){
  const [search,setSearch]=useSearchParams();const page=Math.max(1,Math.min(10000,Number(search.get('page'))||1));
  const query=useQuery({queryKey:['private',viewer.scope,'activity-drafts',page],queryFn:()=>api('/me/activity-drafts?page='+page,ActivityDraftList,{headers:{'X-Account-Scope':viewer.scope}})});
  return query.isPending?<Notice>正在讀取活動草稿…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<>{query.data.drafts.length?<div className="event-grid">{query.data.drafts.map(draft=><Surface key={draft.id}><h2><Link to={'/activities/'+encodeURIComponent(draft.id)+'/edit'}>{draft.title}</Link></h2><Text>{draft.isOwner?'由我發起':'發起者：'+draft.ownerName}</Text><Link to={'/activities/'+encodeURIComponent(draft.id)+'/edit'}>{draft.canEdit?'編輯草稿':'查看草稿'}</Link></Surface>)}</div>:<Notice>沒有可存取的活動草稿。</Notice>}<div className="pagination">{page>1&&<Button variant="secondary" onClick={()=>setSearch({page:String(page-1)})}>上一頁</Button>}{query.data.hasMore&&<Button variant="secondary" onClick={()=>setSearch({page:String(page+1)})}>下一頁</Button>}</div></>;
}
export function ActivityDraftPage(){
  const {id}=useParams();
  return <><PageIntro title={id?'活動草稿':'新增活動草稿'}/><div className="page-actions"><Link to="/me/activities/drafts">活動草稿</Link><Link to="/activities">所有活動</Link></div><MemberAccess>{viewer=>id?<Loader key={viewer.scope+':'+id} viewer={viewer} id={id}/>:<Editor key={viewer.scope+':new'} viewer={viewer} initial={null}/>}</MemberAccess></>;
}
function Loader({viewer,id}:{viewer:Member;id:string}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-draft',id],queryFn:()=>api('/activities/'+encodeURIComponent(id)+'/draft',ActivityDraft,{headers:{'X-Account-Scope':viewer.scope}}),refetchOnWindowFocus:false});
  return query.isPending?<Notice>正在讀取活動草稿…</Notice>:query.error?<><Failure error={query.error} retry={()=>void query.refetch()}/><PendingResult viewer={viewer} id={id}/></>:<Editor viewer={viewer} initial={query.data}/>;
}
function PendingResult({viewer,id}:{viewer:Member;id:string}){
  const navigate=useNavigate();const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
  const storageKey='qgroup:rebuild:activity-draft:v1:'+viewer.scope+':'+id;
  const [pending]=useState(()=>{try{const value=Draft.parse(JSON.parse(sessionStorage.getItem(storageKey)??'null'));return value.id===id?value.pending:undefined;}catch{return undefined;}});
  if(!pending)return null;
  async function check(){
    if(!pending||busy)return;setBusy(true);
    try{const result=await api('/activities/draft-results/'+pending.key,ActivityDraftOperationResult,{headers:{'X-Account-Scope':viewer.scope}});
      if(result.state==='completed'&&result.result.id===id&&result.result.removed){sessionStorage.removeItem(storageKey);void navigate('/me/activities/drafts',{replace:true});}
      else setMessage(result.state==='not_found'?'尚無操作結果；原稿與操作編號已保留。請恢復活動存取後重試。':'原操作已保存；活動目前無法以草稿開啟，原稿已保留。');
    }catch(error){setMessage(error instanceof Error?error.message:'讀取失敗');}finally{setBusy(false);}
  }
  return <Surface><Button loading={busy} onClick={()=>void check()}>確認草稿操作結果</Button>{message&&<Text role="status">{message}</Text>}</Surface>;
}
function Comparison({saved}:{saved:Saved}){
  const v=saved.values;
  return <Surface aria-label="目前已保存的活動安排"><h2>目前已保存的活動安排</h2><dl className="draft-comparison"><dt>活動名稱</dt><dd>{v.title}</dd><dt>活動類型</dt><dd>{categories.find(([key])=>key===v.category)?.[1]??v.category}</dd><dt>地點</dt><dd>{v.location}</dd><dt>開始時間（台北）</dt><dd>{localTime(v.startsAt)}</dd><dt>報名截止（台北）</dt><dd>{localTime(v.deadline)}</dd><dt>持續時間</dt><dd>{v.durationHours} 小時</dd><dt>人數上限／最低成團人數</dt><dd>{v.capacity||'不限'}／{v.minimumParticipants}</dd><dt>退出期限（台北）</dt><dd>{localTime(v.withdrawalDeadline)||'依報名截止時間'}</dd><dt>可見性</dt><dd>{v.visibility==='public'?'公開':'邀請可見'}</dd><dt>顯示時區</dt><dd>{v.timezone||'未指定'}</dd><dt>群同步</dt><dd>{v.botEnabled?'開啟':'關閉'}</dd><dt>費用規則</dt><dd>{v.feePolicy||'未填寫'}</dd><dt>活動說明</dt><dd>{v.description||'未填寫'}</dd></dl></Surface>;
}
function Editor({viewer,initial}:{viewer:Member;initial:Saved|null}){
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const client=useQueryClient();const navigate=useNavigate();const path=initial?'/activities/'+encodeURIComponent(initial.id)+'/draft':'/activities/drafts';
  const storageKey='qgroup:rebuild:activity-draft:v1:'+viewer.scope+':'+(initial?.id??'new');
  const [loaded]=useState(()=>{try{const raw=sessionStorage.getItem(storageKey);const value=raw?Draft.parse(JSON.parse(raw)):original(initial);if(value.id!==(initial?.id??null))throw Error('draft target');return {value,error:''};}catch{return {value:original(initial),error:'無法讀取活動草稿，原始內容已保留。請先保全原稿。'};}});
  const [draft,setDraft]=useState(loaded.value);const [saved,setSaved]=useState(initial);const [readError,setReadError]=useState(loaded.error);
  const [storageError,setStorageError]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
  const [comparison,setComparison]=useState(false);const [confirmRemove,setConfirmRemove]=useState(false);const [destination,setDestination]=useState('');
  const dirty=!!draft.pending||!!draft.reason||JSON.stringify(draft.form)!==JSON.stringify(original(saved).form);
  const blocker=useBlocker(dirty&&!destination);
  useEffect(()=>{if(destination){void navigate(destination,{replace:!initial});return;}if(readError)return;try{sessionStorage.setItem(storageKey,JSON.stringify(draft));setStorageError('');}catch{setStorageError('無法保存活動草稿，尚未送出修改。');}},[draft,readError,storageKey,destination,navigate,initial]);
  useEffect(()=>{if(!dirty||destination)return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[dirty,destination]);
  const locked=busy||!!draft.pending||!!readError||saved?.canEdit===false;
  function edit(patch:Partial<FormValue>){setDraft({...draft,form:{...draft.form,...patch}});setMessage('');setConfirmRemove(false);}
  function persist(value:DraftValue){try{sessionStorage.setItem(storageKey,JSON.stringify(value));setStorageError('');return true;}catch{setStorageError('無法保存操作編號，尚未送出修改。');return false;}}
  async function submit(kind:'save'|'remove'='save'){
    if(busy||readError||saved?.canEdit===false)return;
    let operation=draft.pending;
    if(!operation){
      if(kind==='remove'){
        if(!saved?.canRemove||!confirmRemove)return;
        operation={kind:'remove',key:crypto.randomUUID(),input:{revision:draft.revision,confirm:true}};
      }else{
        try{const values=inputValues(draft.form);operation=saved?{kind:'save',key:crypto.randomUUID(),input:{revision:draft.revision,values,reason:draft.reason}}:{kind:'create',key:crypto.randomUUID(),input:{values}};}
        catch{setMessage('請檢查必填欄位、時間與人數範圍。');return;}
      }
    }
    const pending={...draft,pending:operation};if(!persist(pending))return;setDraft(pending);setBusy(true);setMessage('');let accepted=false;
    try{
      const result=await api(operation.kind==='remove'?path+'/remove':path,ActivityDraftResult,{method:operation.kind==='save'?'PUT':'POST',headers:{'Content-Type':'application/json','X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});accepted=true;
      if(!active.current)return;
      if(result.removed){sessionStorage.removeItem(storageKey);setDestination('/me/activities/drafts');}
      else{
        const latest=await api('/activities/'+encodeURIComponent(result.id)+'/draft',ActivityDraft,{headers:{'X-Account-Scope':viewer.scope}});
        if(!active.current)return;
        if(operation.kind==='create'){
          const targetKey='qgroup:rebuild:activity-draft:v1:'+viewer.scope+':'+result.id;sessionStorage.setItem(targetKey,JSON.stringify(original(latest)));sessionStorage.removeItem(storageKey);setDestination('/activities/'+encodeURIComponent(result.id)+'/edit');
        }else{
          const next=original(latest);if(!persist(next))throw Error('storage');setDraft(next);setSaved(latest);setComparison(false);setConfirmRemove(false);
          client.setQueryData(['private',viewer.scope,'activity-draft',result.id],latest);
          setMessage(result.revision===latest.revision?'活動草稿已保存。':'原操作已保存，草稿已再次變更；請核對目前安排。');
        }
      }
      void client.invalidateQueries({queryKey:['private',viewer.scope,'activity-drafts']});
      void client.invalidateQueries({queryKey:['private',viewer.scope,'activity',result.id]});
    }catch(error){
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){setDraft({...pending,pending:undefined});setMessage(error.message);}
      else setMessage('尚未確認活動草稿操作結果。原操作已保留，請按「確認草稿操作結果」安全重試。');
    }finally{setBusy(false);}
  }
  async function rebase(){
    if(!saved||draft.pending||readError||busy)return;setBusy(true);
    try{const latest=await api(path,ActivityDraft,{headers:{'X-Account-Scope':viewer.scope}});if(!active.current)return;const next={...draft,revision:latest.revision};if(!persist(next))return;setDraft(next);setSaved(latest);setComparison(true);setConfirmRemove(false);setMessage('已取得目前安排；輸入仍保留，請核對後再保存。');}
    catch(error){setMessage(error instanceof Error?error.message:'讀取失敗');}finally{setBusy(false);}
  }
  const f=draft.form;const owner=saved?.isOwner??true;
  return <>{blocker.state==='blocked'&&<Surface role="alert"><Text>仍有活動草稿或待確認操作。</Text><Button onClick={()=>blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={()=>blocker.proceed()}>保留草稿並離開</Button></Surface>}
    {comparison&&saved&&<Comparison saved={saved}/>}
    <Surface className="detail activity-editor"><form noValidate onSubmit={event=>{event.preventDefault();void submit();}}>
      <fieldset disabled={locked}><legend className="sr-only">活動安排</legend>
        <label className="account-field">活動名稱<input required value={f.title} maxLength={120} onChange={e=>edit({title:e.target.value})}/></label>
        <div className="account-field"><label htmlFor="activity-category">活動類型</label><select id="activity-category" value={f.category} onChange={e=>edit({category:e.target.value})}>{categories.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
        <label className="account-field">地點<input required value={f.location} maxLength={240} onChange={e=>edit({location:e.target.value})}/></label>
        <div className="activity-fields"><label className="account-field">開始時間（台北）<input type="datetime-local" step="1" required value={f.startsAt} onChange={e=>edit({startsAt:e.target.value})}/></label><label className="account-field">報名截止（台北）<input type="datetime-local" step="1" required value={f.deadline} onChange={e=>edit({deadline:e.target.value})}/></label></div>
        <div className="activity-fields"><label className="account-field">持續時間（小時）<input type="number" min="1" max="24" step="1" required value={f.durationHours} onChange={e=>edit({durationHours:e.target.value})}/></label><label className="account-field">人數上限<input type="number" min="0" max="500" step="1" required value={f.capacity} onChange={e=>edit({capacity:e.target.value})} aria-describedby="capacity-help"/></label><label className="account-field">最低成團人數<input type="number" min="0" max="500" step="1" required value={f.minimumParticipants} onChange={e=>edit({minimumParticipants:e.target.value})}/></label></div><Text id="capacity-help">上限 0 表示不限；最低人數 0 表示不設定成團門檻。</Text>
        <label className="account-field">活動顯示時區<input value={f.timezone} maxLength={100} placeholder="Asia/Taipei" onChange={e=>edit({timezone:e.target.value})} aria-describedby="timezone-help"/></label><Text id="timezone-help">填寫 IANA 時區或留空。此表單的時間均以台北時間（UTC+08:00）輸入。</Text>
        <label className="account-field">退出期限（台北）<input type="datetime-local" step="1" value={f.withdrawalDeadline} disabled={!owner||locked} onChange={e=>edit({withdrawalDeadline:e.target.value})} aria-describedby="withdrawal-help"/></label><Text id="withdrawal-help">留空時依報名截止時間；僅發起者可修改。</Text>
        <div className="account-field"><label htmlFor="activity-visibility">可見性</label><select id="activity-visibility" value={f.visibility} disabled={!owner||locked} onChange={e=>edit({visibility:e.target.value as FormValue['visibility'],botEnabled:e.target.value==='public'?f.botEnabled:false})}><option value="public">公開</option><option value="invitation">邀請可見</option></select></div>
        <label className="consent"><input type="checkbox" checked={f.botEnabled} disabled={!owner||f.visibility!=='public'||locked} onChange={e=>edit({botEnabled:e.target.checked})}/><span>發布後同步到 QQ 群</span></label><Text>草稿不會發送群通知；邀請可見活動不能同步到公開群。</Text>
        <div className="account-field"><label htmlFor="activity-fee">費用規則</label><textarea id="activity-fee" rows={3} value={f.feePolicy} maxLength={2000} disabled={!owner||locked} onChange={e=>edit({feePolicy:e.target.value})}/></div>
        <div className="account-field"><label htmlFor="activity-description">活動說明</label><textarea id="activity-description" rows={5} value={f.description} maxLength={6000} onChange={e=>edit({description:e.target.value})}/></div>
        {saved&&<label className="account-field">修改原因（選填）<input value={draft.reason} maxLength={400} onChange={e=>setDraft({...draft,reason:e.target.value})}/></label>}
      </fieldset>
      <Button type="submit" loading={busy} disabled={!!readError||saved?.canEdit===false||(!dirty&&!!saved)}>{draft.pending?'確認草稿操作結果':saved?'保存活動草稿':'建立活動草稿'}</Button>
    </form>{saved&&saved.canEdit&&!draft.pending&&<Button variant="secondary" disabled={busy||!!readError} onClick={()=>void rebase()}>核對目前安排，保留輸入</Button>}
    {saved&&<><Notice>草稿尚未發布，尚未開放報名。</Notice>{saved.canRemove&&!draft.pending?<div className="draft-remove"><label className="consent"><input type="checkbox" checked={confirmRemove} disabled={busy||!!readError} onChange={e=>setConfirmRemove(e.target.checked)}/><span>確認刪除此活動草稿；保存的紀錄仍會保留</span></label><Button variant="secondary" disabled={!confirmRemove||busy||!!readError} onClick={()=>void submit('remove')}>刪除活動草稿</Button></div>:saved.isOwner&&saved.removalBlocker&&<Notice>{saved.removalBlocker}</Notice>}</>}
    {message&&<Text role="status">{message}</Text>}{storageError&&<Text role="alert">{storageError}</Text>}
    {readError&&<div role="alert"><Text>{readError}</Text><Button onClick={()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw!==null)sessionStorage.setItem(storageKey+':recovery:'+Date.now(),raw);setReadError('');}catch{setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。');}}}>保全原稿後繼續</Button></div>}
    </Surface></>;
}
