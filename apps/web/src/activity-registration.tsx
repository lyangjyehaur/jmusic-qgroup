import { errorText, uiText } from './language';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { ActivityDraftResult, ChangeRegistration, RegistrationAction, RegistrationContext, RegistrationPreview, RegistrationValues, SubmitRegistration } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
type Context=z.infer<typeof RegistrationContext>;
type Person=Context['people'][number];
type Action=z.infer<typeof RegistrationAction>;
const statusLabels:Record<string,string>={confirmed:uiText("正式"),waiting:uiText("候補"),tentative:uiText("待確認"),invited:uiText("受邀待接受"),withdrawn:uiText("已退出")};
const labels:Record<Action,string>={edit:uiText("修改報名資料"),confirm:uiText("確認參加"),split:uiText("改為分開排隊"),withdraw:uiText("退出報名"),approve:uiText("同意退出申請"),reject:uiText("拒絕退出申請")};
const Pending=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('signup'),key:z.string().uuid(),input:SubmitRegistration}).strict(),
  z.object({kind:z.literal('person'),key:z.string().uuid(),personId:z.string().min(1),input:ChangeRegistration}).strict(),
]);
// Local drafts may be incomplete. Server contracts validate only at preview / submit.
const Draft=z.object({revision:z.number().int().min(0),values:z.object({people:z.array(z.object({isSelf:z.boolean(),name:z.string(),note:z.string(),payerKind:z.enum(['self','manager'])})).min(1).max(20),queueMode:z.enum(['individual','together']),intent:z.enum(['registered','tentative'])}),personId:z.string(),action:RegistrationAction,name:z.string(),note:z.string(),payerKind:z.enum(['self','manager']),reason:z.string(),pending:Pending.optional()}).strict();
type DraftValue=z.infer<typeof Draft>;
const companion=()=>({isSelf:false,name:'',note:'',payerKind:'manager' as const});
const empty=(data:Context):DraftValue=>({revision:data.revision,values:{people:data.selfRegistered?[companion()]:[{isSelf:true,name:'',note:'',payerKind:'self'}],queueMode:'individual',intent:'registered'},personId:'',action:'edit',name:'',note:'',payerKind:'self',reason:''});
function actions(person:Person|undefined):Action[]{return person?[...(person.canChange?['edit' as const,...(person.status==='tentative'?['confirm' as const]:[]),...(person.status==='waiting'&&person.queueMode==='together'?['split' as const]:[])]:[]),...(person.canWithdraw?['withdraw' as const]:[]),...(person.canDecide?['approve' as const,'reject' as const]:[])]:[];}
export function ActivityRegistrationPage({manage=false}:{manage?:boolean}){
  const {id=''}=useParams();
  return <><PageIntro title={manage?'管理報名':'新增報名'}/><div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)}>回到活動</Link><Link to={'/activities/'+encodeURIComponent(id)+(manage?'/signup':'/registration')}>{manage?'新增本人／同行報名':'管理現有報名'}</Link><Link to={'/activities/'+encodeURIComponent(id)+'/invitations'}>補報名邀請</Link><Link to={'/activities/'+encodeURIComponent(id)+'/claims'}>代報認領</Link></div><MemberAccess>{viewer=><Loader key={viewer.scope+':'+id+':'+manage} viewer={viewer} id={id} manage={manage}/>}</MemberAccess></>;
}
function Loader({viewer,id,manage}:{viewer:Member;id:string;manage:boolean}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-registration',id],queryFn:()=>scopedHttp(viewer.scope).request('GET /api/v2/activities/:id/registration', { params: { id: id } }, RegistrationContext),refetchOnWindowFocus:false});
  return query.isPending?<Notice>正在讀取報名資料…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<Editor viewer={viewer} initial={query.data} manage={manage}/>;
}
function when(value:string,timezone:string|null){
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!timezone)return value.replace('T',' ');
  try{return new Intl.DateTimeFormat('zh-TW',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(value));}catch{return value;}
}
function Editor({viewer,initial,manage}:{viewer:Member;initial:Context;manage:boolean}){
  const [search]=useSearchParams(),client=useQueryClient(),storageKey='qgroup:rebuild:activity-draft:registration:v1:'+viewer.scope+':'+initial.id+':'+(manage?'manage':'signup');
  const [data,setData]=useState(initial),[message,setMessage]=useState(''),[confirm,setConfirm]=useState(false),[partial,setPartial]=useState(false),[preview,setPreview]=useState<z.infer<typeof RegistrationPreview>|null>(null);
  const seed=():DraftValue=>{
    const next=empty(data);
    if(!manage){if(search.get('preset')==='party')next.values.people=[companion()];if(search.get('preset')==='tentative')next.values.intent='tentative';}
    else {const person=data.people.find(item=>item.id===search.get('person'));if(person)Object.assign(next,{personId:person.id,name:person.name,note:person.note,payerKind:person.payerKind,action:search.get('preset')==='withdraw'&&person.canWithdraw?'withdraw':actions(person)[0]??'edit'});}
    return next;
  };
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed,parse:raw=>{
    const saved=Draft.parse(JSON.parse(raw));if(saved.pending&&((saved.pending.kind==='person')!==manage))throw Error('operation target');
    return JSON.stringify({...saved,revision:data.revision})===JSON.stringify(empty(data))?seed():saved;
  },needsRestore:raw=>JSON.stringify({...Draft.parse(JSON.parse(raw)),revision:data.revision})!==JSON.stringify(empty(data)),dirty:value=>JSON.stringify(value)!==JSON.stringify(empty(data)),pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,active,busy,setBusy,readError,persist}=record;
  const locked=record.locked,stale=draft.revision!==data.revision;
  const selected=data.people.find(person=>person.id===draft.personId),availableActions=actions(selected),available=manage?availableActions.includes(draft.action):!data.signupBlocker;
  const reasonRequired=!!selected&&(selected.requiresReason||(draft.action==='withdraw'&&selected.needsWithdrawalRequest)||['approve','reject'].includes(draft.action));
  const mixed=!!preview?.allocation.some(person=>person.status==='confirmed')&&preview.allocation.some(person=>person.status==='waiting');
  useEffect(()=>{setConfirm(false);setPartial(false);setPreview(null);},[record.epoch]);
  function edit(patch:Partial<DraftValue>){record.change({...draft,...patch});setConfirm(false);setPartial(false);setPreview(null);setMessage('');}
  function choose(personId:string){const person=data.people.find(item=>item.id===personId);edit({personId,name:person?.name??'',note:person?.note??'',payerKind:person?.payerKind??'self',action:search.get('preset')==='withdraw'&&person?.canWithdraw?'withdraw':actions(person)[0]??'edit',reason:''});}
  async function latest(){return scopedHttp(viewer.scope).request('GET /api/v2/activities/:id/registration', { params: { id: data.id } }, RegistrationContext);}
  function update(fresh:Context){setData(fresh);client.setQueryData(['private',viewer.scope,'activity-registration',data.id],fresh);}
  async function rebase(){
    if(locked||!record.begin())return;
    try{const fresh=await latest();if(!active.current)return;const next={...draft,revision:fresh.revision};if(!await persist(next))return;update(fresh);setDraft(next);setConfirm(false);setPartial(false);setPreview(null);setMessage(uiText("已取得最新名單與安排；輸入仍保留，請重新預覽或核對後確認。"));}
    catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(active.current)setBusy(false);}
  }
  async function makePreview(){
    if(locked||stale)return;const values=RegistrationValues.safeParse(draft.values);if(!values.success){setMessage(uiText("請填寫 1–20 位參加者；稱呼最多 24 字、備註最多 100 字，本人只能一位。"));return;}
    if(!record.begin())return;if(!await persist(draft)||!active.current){if(active.current)setBusy(false);return;}setConfirm(false);setPartial(false);setPreview(null);setMessage('');
    try{const result=await authHttp(viewer).request('POST /api/v2/activities/:id/registration/preview', { params: { id: data.id }, body: {...values.data,revision:draft.revision} }, RegistrationPreview);if(active.current)setPreview(result);}
    catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("預覽失敗"));}finally{if(active.current)setBusy(false);}
  }
  async function submit(){
    if(busy||record.unavailable)return;let operation=draft.pending;
    if(!operation){
      if(!confirm||!available||stale)return;
      if(manage){
        if(!selected)return;
        const input=ChangeRegistration.safeParse({revision:draft.revision,action:draft.action,name:draft.name,note:draft.note,payerKind:draft.payerKind,reason:draft.reason,confirm:true});
        if(!input.success){setMessage(uiText("請檢查稱呼、備註與原因的長度。"));return;}
        if(reasonRequired&&!input.data.reason){setMessage(uiText("此操作必須填寫原因。"));return;}
        operation={kind:'person',key:crypto.randomUUID(),personId:selected.id,input:input.data};
      }else{
        if(!preview||(mixed&&!partial))return;
        const input=SubmitRegistration.safeParse({...draft.values,revision:draft.revision,previewToken:preview.token,conditionsVersion:preview.conditionsVersion,acceptConditions:true,acceptPartial:partial,confirm:true});
        if(!input.success){setMessage(uiText("報名資料不完整，請重新預覽。"));return;}
        operation={kind:'signup',key:crypto.randomUUID(),input:input.data};
      }
    }
    const pending={...draft,pending:operation};if(!record.begin())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}setDraft(pending);setMessage('');let accepted=false;
    try{
      if(operation.kind==='signup')await authHttp(viewer).request('POST /api/v2/activities/:id/registration', { params: { id: data.id }, body: operation.input, requestId: operation.key, requestScope: viewer.scope }, ActivityDraftResult);
      else await authHttp(viewer).request('POST /api/v2/activities/:id/attendees/:personId/registration', { params: { id: data.id, personId: operation.personId }, body: operation.input, requestId: operation.key, requestScope: viewer.scope }, ActivityDraftResult);accepted=true;
      const fresh=await latest();if(!active.current)return;const next=empty(fresh);if(!await persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');setDraft(next);update(fresh);setConfirm(false);setPartial(false);setPreview(null);setMessage(operation.kind==='signup'?uiText("報名已保存。"):uiText("報名操作已保存。"));
      void client.invalidateQueries({queryKey:['activities']});for(const key of ['activity','activity-roster','activity-lifecycle','activity-conditions'])void client.invalidateQueries({queryKey:['private',viewer.scope,key,data.id]});
    }catch(error){
      if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirm(false);setPartial(false);setPreview(null);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認報名操作結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  const consent=manage?uiText('已核對此人的報名，確認')+labels[draft.action]:uiText('已核對第 ')+data.conditionsVersion+uiText(' 版安排、費用與逐人分配，代表本人及代報者接受安排');
  return <><Surface className="detail"><Heading level={2}>{data.title}</Heading><dl><dt>目前安排</dt><dd>第 {data.conditionsVersion} 版</dd><dt>時間</dt><dd>{when(data.arrangement.starts_at,data.arrangement.timezone)}（{data.arrangement.timezone||'未指定時區'}）</dd><dt>持續時間</dt><dd>{data.arrangement.duration_hours===null?'未設定':data.arrangement.duration_hours+' 小時'}</dd><dt>地點</dt><dd>{data.arrangement.location}</dd><dt>退出期限</dt><dd>{when(data.arrangement.withdrawal_deadline,data.arrangement.timezone)}</dd>{data.arrangement.fee_policy&&<><dt>費用規則</dt><dd className="preserve-lines">{data.arrangement.fee_policy}</dd></>}{data.arrangement.description&&<><dt>注意事項</dt><dd className="preserve-lines">{data.arrangement.description}</dd></>}</dl><Link to={'/activities/'+encodeURIComponent(data.id)+'/conditions'}>查看完整安排與版本</Link></Surface>
    <Surface className="detail activity-editor"><Heading level={2}>{manage?'現有報名':'本人與同行'}</Heading>
      {stale&&!draft.pending&&<Notice>活動或名單已有更新，請先核對最新資料。</Notice>}
      {manage&&<><ul>{data.people.map(person=><li key={person.id}>{person.name} · {statusLabels[person.status]??person.status}{person.withdrawalRequested?' · 退出申請中':''} · 付款：{person.payerName}</li>)}</ul>{!data.people.length&&<Notice>目前沒有可由此帳號管理的有效報名。</Notice>}</>}
      {!manage&&data.signupBlocker&&<Notice>{data.signupBlocker}</Notice>}
      {(!manage||data.people.length>0||draft.pending||draft.personId)&&<form noValidate onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={locked}><legend className="sr-only">{manage?'管理逐人報名':'新增逐人報名'}</legend>
        {manage?<>
          <div className="account-field"><label htmlFor="registration-person">報名者</label><select id="registration-person" value={draft.personId} onChange={event=>choose(event.target.value)}><option value="">請選擇</option>{data.people.map((person,index)=><option key={person.id} value={person.id}>{index+1}. {person.name}</option>)}{draft.personId&&!selected&&<option value={draft.personId}>原報名目前不可操作</option>}</select></div>
          {draft.personId&&<><div className="account-field"><label htmlFor="registration-action">報名操作</label><select id="registration-action" value={draft.action} onChange={event=>edit({action:event.target.value as Action})}>{availableActions.map(action=><option key={action} value={action}>{labels[action]}</option>)}{!availableActions.includes(draft.action)&&<option value={draft.action}>{labels[draft.action]}（目前不可操作）</option>}</select></div>
          {selected?.withdrawalReason&&<Text>退出原因／處理結果：{selected.withdrawalReason}</Text>}
          {draft.action==='edit'&&<><div className="account-field"><label htmlFor="registration-name">同行稱呼</label><input id="registration-name" disabled={!selected?.isGuest} maxLength={48} value={draft.name} onChange={event=>edit({name:event.target.value})}/></div><div className="account-field"><label htmlFor="registration-note">公開備註</label><textarea id="registration-note" rows={2} maxLength={200} value={draft.note} onChange={event=>edit({note:event.target.value})}/></div><div className="account-field"><label htmlFor="registration-payer">付款歸屬</label><select id="registration-payer" disabled={!!selected?.paymentLocked||!selected?.isGuest} value={draft.payerKind} onChange={event=>edit({payerKind:event.target.value as 'self'|'manager'})}><option value="self">參加者本人</option><option value="manager">代報管理人</option></select></div>{selected?.paymentLocked&&<Notice>已保留認領前的付款責任；更正請從結算核對並留版本。</Notice>}</>}
          {draft.action==='confirm'&&<Notice>{selected?.queueMode==='together'?'同組待確認人員一起確認，取得新的隊序。':'確認後取得新的隊序。'}待確認期間不占名額。</Notice>}
          {draft.action==='split'&&<Notice>保留這組的原隊序，改為逐人分配；較早整組仍可能阻擋遞補。</Notice>}
          {draft.action==='withdraw'&&<Notice>{selected?.needsWithdrawalRequest?'已過退出期限，正式名額保留至名單管理者同意退出。':'退出後保留原報名紀錄；重新報名需重新排隊。'}</Notice>}
          {['approve','reject'].includes(draft.action)&&<Notice>處理退出申請會通知原管理人；費用與退款仍依公布結算。</Notice>}
          <div className="account-field"><label htmlFor="registration-reason">原因{reasonRequired?'（必填）':'（選填）'}</label><textarea id="registration-reason" rows={2} maxLength={400} value={draft.reason} onChange={event=>edit({reason:event.target.value})}/></div></>}
        </>:<>
          {data.selfRegistered&&<Notice>你已有本人報名；可在此新增同行，或前往管理現有報名。</Notice>}
          {draft.values.people.map((person,index)=><fieldset key={index} className="registration-person"><legend>參加者 {index+1}</legend>
            <div className="account-field"><label htmlFor={'signup-person-'+index}>身分</label><select id={'signup-person-'+index} value={person.isSelf?'self':'guest'} onChange={event=>edit({values:{...draft.values,people:draft.values.people.map((p,i)=>i===index?{...p,isSelf:event.target.value==='self',payerKind:event.target.value==='self'?'self':'manager'}:p)}})}><option value="guest">同行／代報</option><option value="self" disabled={data.selfRegistered||draft.values.people.some((p,i)=>i!==index&&p.isSelf)}>本人（{data.nickname}）</option></select></div>
            <div className="account-field"><label htmlFor={'signup-name-'+index}>稱呼</label><input id={'signup-name-'+index} disabled={person.isSelf} maxLength={48} value={person.isSelf?data.nickname:person.name} onChange={event=>edit({values:{...draft.values,people:draft.values.people.map((p,i)=>i===index?{...p,name:event.target.value}:p)}})}/></div>
            <div className="account-field"><label htmlFor={'signup-note-'+index}>公開備註</label><textarea id={'signup-note-'+index} rows={2} maxLength={200} value={person.note} onChange={event=>edit({values:{...draft.values,people:draft.values.people.map((p,i)=>i===index?{...p,note:event.target.value}:p)}})}/></div>
            <div className="account-field"><label htmlFor={'signup-payer-'+index}>付款歸屬</label><select id={'signup-payer-'+index} disabled={person.isSelf} value={person.payerKind} onChange={event=>edit({values:{...draft.values,people:draft.values.people.map((p,i)=>i===index?{...p,payerKind:event.target.value as 'self'|'manager'}:p)}})}><option value="self">參加者本人</option><option value="manager">代報管理人</option></select></div>
            {draft.values.people.length>1&&<Button variant="ghost" onClick={()=>edit({values:{...draft.values,people:draft.values.people.filter((_,i)=>i!==index)}})}>移除參加者 {index+1}</Button>}
          </fieldset>)}
          <Button variant="secondary" disabled={draft.values.people.length>=20} onClick={()=>edit({values:{...draft.values,people:[...draft.values.people,companion()]}})}>新增同行</Button>
          <div className="account-field"><label htmlFor="signup-mode">排隊方式</label><select id="signup-mode" value={draft.values.queueMode} onChange={event=>edit({values:{...draft.values,queueMode:event.target.value as 'individual'|'together'}})}><option value="individual">逐人分配名額</option><option value="together">整組一起參加</option></select></div>
          <Text>整組名額不足時全組候補，並阻擋後方候補；分開排隊可能部分正式、部分候補。</Text>
          <div className="account-field"><label htmlFor="signup-intent">參加意願</label><select id="signup-intent" value={draft.values.intent} onChange={event=>edit({values:{...draft.values,intent:event.target.value as 'registered'|'tentative'}})}><option value="registered">確認參加</option><option value="tentative">待確認（不占名額）</option></select></div>
          <Button variant="secondary" disabled={!!data.signupBlocker||stale} onClick={()=>void makePreview()}>預覽逐人分配</Button>
          {preview&&<section aria-label="報名預覽"><Heading level={3}>逐人分配</Heading><ol>{preview.allocation.map((person,index)=><li key={index}>{person.name} · {statusLabels[person.status]}</li>)}</ol>{mixed&&<label className="consent"><input type="checkbox" checked={partial} onChange={event=>{setPartial(event.target.checked);setConfirm(false);}}/><span>接受部分正式、部分候補的分配</span></label>}</section>}
        </>}
        {(!manage||draft.personId)&&<label className="consent"><input type="checkbox" disabled={!available||stale||(!manage&&(!preview||(mixed&&!partial)))} checked={confirm} onChange={event=>setConfirm(event.target.checked)}/><span>{consent}</span></label>}
      </fieldset>{(!manage||draft.personId||draft.pending)&&<Button type="submit" loading={busy} disabled={!!readError||(!draft.pending&&(!confirm||!available||stale))}>{draft.pending?'確認報名操作結果':manage?'提交報名操作':'提交報名'}</Button>}</form>}
      {!draft.pending&&<Button variant="secondary" disabled={locked} onClick={()=>void rebase()}>核對最新資料，保留輸入</Button>}
      {message&&<Text role="status">{message}</Text>}<DraftFeedback form={record}/>
    </Surface></>;
}
