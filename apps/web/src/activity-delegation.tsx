import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Field } from './kimi-ui';
import { z } from 'zod';
import { AcceptActivityManager, ActivityDelegation, ActivityScope, InviteActivityManager, RevokeActivityManager } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
const labels:Record<z.infer<typeof ActivityScope>,string>={schedule:uiText("活動安排"),roster:uiText("名單管理"),attendance:uiText("現場出席"),settlement:uiText("結算管理")};
const Pending=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('invite'),key:z.string().uuid(),input:InviteActivityManager}).strict(),
  z.object({kind:z.literal('revoke'),key:z.string().uuid(),target:z.enum(['invitations','roles']),itemId:z.string(),input:RevokeActivityManager}).strict(),
  z.object({kind:z.literal('accept'),key:z.string().uuid(),input:AcceptActivityManager}).strict(),
]);
const Draft=z.object({revision:z.number().int().min(0),action:z.enum(['cohost','settlement','transfer','revoke']),target:z.string(),attendeeId:z.string(),targetName:z.string(),permissions:z.array(ActivityScope),reason:z.string(),pending:Pending.optional()}).strict();
type DraftValue=z.infer<typeof Draft>;
const empty=(revision=0):DraftValue=>({revision,action:'cohost',target:'',attendeeId:'',targetName:'',permissions:[],reason:''});
function useDraft(viewer:Member,id:string,mode:string,revision=0){
  const storageKey='qgroup:rebuild:activity-draft:delegation:v1:'+viewer.scope+':'+id+':'+mode;
  const seed=():DraftValue=>empty(revision);
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed,parse:raw=>{
    const value=Draft.parse(JSON.parse(raw));if(value.pending&&((value.pending.kind==='accept')!==(mode!=='manage')))throw Error('operation target');
    return JSON.stringify({...value,revision})===JSON.stringify(empty(revision))?seed():value;
  },dirty:value=>JSON.stringify({...value,revision})!==JSON.stringify(empty(revision)),pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,active,busy,setBusy,locked,readError,persist,begin,unavailable}=record;
  const [message,setMessage]=useState(''),[confirm,setConfirm]=useState(false),[responsibility,setResponsibility]=useState(false);
  function reset(){setConfirm(false);setResponsibility(false);}
  useEffect(reset,[record.epoch]);
  function edit(patch:Partial<DraftValue>){record.change({...draft,...patch});reset();setMessage('');}
  const guard=<><DraftFeedback form={{...record,message:message||record.message}}/></>;
  return {active,draft,setDraft,busy,setBusy,message,setMessage,confirm,setConfirm,responsibility,setResponsibility,reset,locked,readError,persist,begin,unavailable,edit,guard};
}
function duties(permissions:z.infer<typeof ActivityScope>[]){return permissions.map(permission=>labels[permission]).join('、');}
export function ActivityDelegationPage(){
  const {id=''}=useParams();return <><PageIntro title="管理分工"/><div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)}>回到活動</Link><Link to="/me/activities/drafts">活動草稿</Link></div><MemberAccess>{viewer=><Loader key={viewer.scope+':'+id} viewer={viewer} id={id}/>}</MemberAccess></>;
}
function Loader({viewer,id}:{viewer:Member;id:string}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-delegation',id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/delegation', { params: { id: id } }),refetchOnWindowFocus:false});
  return query.isPending?<Notice>正在讀取管理分工…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<Editor viewer={viewer} initial={query.data}/>;
}
function Editor({viewer,initial}:{viewer:Member;initial:z.infer<typeof ActivityDelegation>}){
  const [data,setData]=useState(initial),s=useDraft(viewer,initial.id,'manage',initial.revision),client=useQueryClient(),stale=s.draft.revision!==data.revision;
  const latest=()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/delegation', { params: { id: data.id } });
  const selected=s.draft.target.startsWith('roles:')?data.roles.find(item=>'roles:'+item.id===s.draft.target):data.invitations.find(item=>'invitations:'+item.id===s.draft.target);
  const blocked=!data.isOwner||(s.draft.action==='revoke'?!selected:!!data.blocker);
  function update(fresh:typeof data){setData(fresh);client.setQueryData(['private',viewer.scope,'activity-delegation',data.id],fresh);}
  function choose(target:string){s.edit({action:'revoke',target,reason:''});}
  async function rebase(){if(s.locked||!s.begin())return;try{const fresh=await latest();if(!s.active.current)return;const next={...s.draft,revision:fresh.revision};if(!await s.persist(next))return;update(fresh);s.setDraft(next);s.reset();s.setMessage(uiText("已取得最新分工；原輸入保留，請重新確認。"));}catch(error){if(s.active.current)s.setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(s.active.current)s.setBusy(false);}}
  async function submit(){
    if(s.busy||s.unavailable)return;let operation=s.draft.pending;
    if(!operation){
      if(!s.confirm||stale||blocked)return;
      if(s.draft.action==='revoke'){
        const input=RevokeActivityManager.safeParse({revision:s.draft.revision,reason:s.draft.reason,confirm:true});if(!input.success){s.setMessage(uiText("請填寫撤銷原因，最多 200 字。"));return;}
        const [target,...parts]=s.draft.target.split(':');if(target!=='roles'&&target!=='invitations')return;operation={kind:'revoke',key:crypto.randomUUID(),target,itemId:parts.join(':'),input:input.data};
      }else{
        const input=InviteActivityManager.safeParse({revision:s.draft.revision,kind:s.draft.action==='transfer'?'transfer':'cohost',targetName:s.draft.targetName,attendeeId:s.draft.attendeeId||null,permissions:s.draft.action==='transfer'?[]:s.draft.action==='settlement'?['settlement']:s.draft.permissions,reason:s.draft.reason,confirm:true});
        if(!input.success){s.setMessage(uiText("請填寫受邀者稱呼、職責及原因；稱呼最多 24 字、原因 200 字。"));return;}operation={kind:'invite',key:crypto.randomUUID(),input:input.data};
      }
    }
    if(operation.kind==='accept')return;const pending={...s.draft,pending:operation};if(!s.begin())return;if(!await s.persist(pending)||!s.active.current){if(s.active.current)s.setBusy(false);return;}s.setDraft(pending);s.setMessage('');let accepted=false;
    try{if(operation.kind==='invite')await authHttp(viewer).requestContract('POST /api/v2/activities/:id/delegation/invitations', { params: { id: data.id }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });
      else if(operation.target==='invitations')await authHttp(viewer).requestContract('POST /api/v2/activities/:id/delegation/invitations/:itemId/revoke', { params: { id: data.id, itemId: operation.itemId }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });
      else await authHttp(viewer).requestContract('POST /api/v2/activities/:id/delegation/roles/:itemId/revoke', { params: { id: data.id, itemId: operation.itemId }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;const fresh=await latest();if(!s.active.current)return;const next=empty(fresh.revision);if(!await s.persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');s.setDraft(next);update(fresh);s.reset();s.setMessage(operation.kind==='invite'?uiText("管理邀請已建立。"):uiText("管理權限或邀請已撤銷。"));void client.invalidateQueries({queryKey:['private',viewer.scope,'activity',data.id]});}
    catch(error){if(!s.active.current)return;if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await s.persist(next))s.setDraft(next);s.reset();s.setMessage(errorText(error));}else s.setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認管理操作結果」安全重試。"));}finally{if(s.active.current)s.setBusy(false);}
  }
  return <><Surface className="detail"><Heading level={2}>{data.title}</Heading><Text>發起者：{data.ownerName}</Text><Heading level={2}>現有協辦</Heading>{!data.roles.length?<Notice>目前沒有協辦。</Notice>:<ul className="invitation-list">{data.roles.map(role=><li key={role.id}><Text>{role.name} · {duties(role.permissions)}</Text>{data.isOwner&&<Button variant="secondary" disabled={s.locked} onClick={()=>choose('roles:'+role.id)}>撤銷職責（{role.name}）</Button>}</li>)}</ul>}</Surface>
    <Surface className="detail activity-editor">{!data.isOwner&&<Notice>只有發起者可以邀請或撤銷管理者。</Notice>}{data.blocker&&<Notice>{data.blocker}</Notice>}
      {(data.isOwner||s.draft.pending)&&<form noValidate onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={s.locked}><legend>邀請與撤銷</legend><Field label="管理操作"><select id="delegation-action" value={s.draft.action} onChange={event=>s.edit({action:event.target.value as DraftValue['action'],target:''})}><option value="cohost">邀請協辦</option><option value="settlement">指定結算人</option><option value="transfer">交接發起者</option><option value="revoke">撤銷職責或邀請</option></select></Field>
      {s.draft.action==='revoke'?<Field label="撤銷對象"><select id="delegation-target" value={s.draft.target} onChange={event=>choose(event.target.value)}><option value="">請選擇</option>{data.roles.map(role=><option key={role.id} value={'roles:'+role.id}>協辦：{role.name} · {duties(role.permissions)}</option>)}{data.invitations.map(item=><option key={item.id} value={'invitations:'+item.id}>待接受：{item.targetName} · {item.kind==='transfer'?'發起者':duties(item.permissions)}</option>)}{s.draft.target&&!selected&&<option value={s.draft.target}>原對象目前不可撤銷</option>}</select></Field>:<><Field label="受邀帳號"><select id="delegation-account" value={s.draft.attendeeId} onChange={event=>s.edit({attendeeId:event.target.value,...(event.target.value?{targetName:data.targets.find(person=>person.id===event.target.value)?.name??''}:{})})}><option value="">使用專屬連結，不綁定帳號</option>{data.targets.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}{s.draft.attendeeId&&!data.targets.some(person=>person.id===s.draft.attendeeId)&&<option value={s.draft.attendeeId}>原報名帳號目前不可邀請</option>}</select></Field><label className="account-field">受邀者稱呼<input maxLength={48} value={s.draft.targetName} onChange={event=>s.edit({targetName:event.target.value})}/></label>{!s.draft.attendeeId&&<Notice>任何取得連結的會員都可接受，請只私下交給指定對象；稱呼不綁定帳號。連結七天內有效。</Notice>}
      {s.draft.action==='cohost'&&<fieldset><legend>協辦職責</legend>{ActivityScope.options.map(permission=><label className="consent" key={permission}><input type="checkbox" checked={s.draft.permissions.includes(permission)} onChange={event=>s.edit({permissions:event.target.checked?[...s.draft.permissions,permission]:s.draft.permissions.filter(value=>value!==permission)})}/><span>{labels[permission]}</span></label>)}</fieldset>}
      {s.draft.action==='transfer'?<Notice>接受後你將失去發起者權限，所有待接受管理邀請失效；保留原報名與帳務。管理交接不代表實際代收資金已移交。</Notice>:s.draft.action==='settlement'||s.draft.permissions.includes('settlement')?<Notice>接受後保留對方其他職責，並移除前任結算人的結算權限；其他職責保留。</Notice>:<Notice>接受後以所選職責取代對方原有協辦權限。</Notice>}</>}
      <Field label="操作原因"><textarea id="delegation-reason" rows={2} maxLength={400} value={s.draft.reason} onChange={event=>s.edit({reason:event.target.value})}/></Field>{stale&&<Notice>活動或分工已有更新，請先核對最新資料。</Notice>}<label className="consent"><input type="checkbox" checked={s.confirm} disabled={stale||blocked} onChange={event=>s.setConfirm(event.target.checked)}/><span>已核對對象、職責與原因，確認管理操作</span></label></fieldset><Button type="submit" loading={s.busy} disabled={s.unavailable||(!s.draft.pending&&(!s.confirm||stale||blocked))}>{s.draft.pending?'確認管理操作結果':s.draft.action==='revoke'?'撤銷管理權限或邀請':'建立管理邀請'}</Button></form>}{!s.draft.pending&&<Button variant="secondary" disabled={s.locked} onClick={()=>void rebase()}>核對最新分工，保留輸入</Button>}{s.guard}</Surface>
    {data.isOwner&&<Surface className="detail"><Heading level={2}>待接受的管理邀請</Heading>{!data.invitations.length?<Notice>目前沒有待接受的管理邀請。</Notice>:<ul className="invitation-list">{data.invitations.map(item=><li key={item.id}><Text>{item.targetName} · {item.kind==='transfer'?'發起者':duties(item.permissions)}</Text><Text>期限：{item.expiresAt.replace('T',' ')}</Text><Link to={'/activities/'+encodeURIComponent(data.id)+'/delegation/'+encodeURIComponent(item.token)}>管理邀請連結（{item.targetName}）</Link><Text className="invitation-url">{location.origin+'/activities/'+encodeURIComponent(data.id)+'/delegation/'+encodeURIComponent(item.token)}</Text><Button variant="secondary" disabled={s.locked} onClick={()=>choose('invitations:'+item.id)}>撤銷邀請（{item.targetName}）</Button></li>)}</ul>}</Surface>}
  </>;
}
export function AcceptActivityDelegationPage(){
  const {id='',token=''}=useParams();return <><PageIntro title="接受管理邀請"/><MemberAccess>{viewer=><Recipient key={viewer.scope+':'+id+':'+token} viewer={viewer} id={id} token={token}/>}</MemberAccess></>;
}
function Recipient({viewer,id,token}:{viewer:Member;id:string;token:string}){
  const s=useDraft(viewer,id,'accept:'+token),[done,setDone]=useState(false),client=useQueryClient();
  const query=useQuery({queryKey:['private',viewer.scope,'activity-delegation-preview',id,token],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/delegation/preview/:token', { params: { id, token } }),refetchOnWindowFocus:false,enabled:!done}),data=query.data;
  useEffect(()=>{s.reset();},[data?.revision]);
  async function submit(){
    if(s.busy||s.unavailable)return;let operation=s.draft.pending;
    if(!operation){if(!data||data.isOwner||!s.confirm||!s.responsibility)return;operation={kind:'accept',key:crypto.randomUUID(),input:{revision:data.revision,acceptResponsibility:true,confirm:true}};}
    if(operation.kind!=='accept')return;const pending={...s.draft,pending:operation};if(!s.begin())return;if(!await s.persist(pending)||!s.active.current){if(s.active.current)s.setBusy(false);return;}s.setDraft(pending);s.setMessage('');let accepted=false;
    try{await authHttp(viewer).requestContract('POST /api/v2/activities/:id/delegation/preview/:token/accept', { params: { id: id, token }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;if(!s.active.current)return;if(!await s.persist(empty(),false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');s.setDraft(empty());s.reset();setDone(true);s.setMessage(uiText("已接受管理邀請。"));void client.invalidateQueries({queryKey:['activities']});for(const key of ['activity','activity-drafts','activity-delegation','activity-arrangements','activity-lifecycle','activity-attendance','activity-registration','activity-roster'])void client.invalidateQueries({queryKey:['private',viewer.scope,key,...(key==='activity-drafts'?[]:[id])]});}
    catch(error){if(!s.active.current)return;if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await s.persist(next))s.setDraft(next);s.reset();s.setMessage(errorText(error));}else s.setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認管理操作結果」安全重試。"));}finally{if(s.active.current)s.setBusy(false);}
  }
  async function refresh(){if(s.locked)return;s.reset();await query.refetch();}
  return <Surface className="detail activity-editor">{!done&&query.isPending&&<Notice>正在讀取管理邀請…</Notice>}{!done&&query.error&&!s.draft.pending&&<Failure error={query.error} retry={()=>void refresh()}/>}{!done&&data&&<><Heading level={2}>{data.title}</Heading><dl><dt>目前發起者</dt><dd>{data.ownerName}</dd><dt>受邀稱呼</dt><dd>{data.targetName}</dd><dt>接受帳號</dt><dd>{viewer.nickname}</dd><dt>接受職責</dt><dd>{data.kind==='transfer'?'發起者':duties(data.permissions)}</dd><dt>期限</dt><dd>{data.expiresAt.replace('T',' ')}</dd></dl>{data.isOwner&&<Notice>發起者不能接受自己的交接邀請。</Notice>}{data.kind==='transfer'?<Notice>接受後接任發起者，原發起者所有待接受管理邀請失效；保留報名與帳務。實際代收資金須另行交接。</Notice>:data.permissions.includes('settlement')?<Notice>接受後保留你的其他職責，並移除前任結算人的結算權限。</Notice>:<Notice>接受後以這份邀請的職責取代你的原協辦權限。</Notice>}</>}
    {!done&&(data||s.draft.pending)&&<form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={s.locked||!!data?.isOwner}><legend className="sr-only">接受職責</legend><label className="consent"><input type="checkbox" checked={s.responsibility} onChange={event=>{s.setResponsibility(event.target.checked);s.setConfirm(false);}}/><span>我已核對受邀身分並願意承擔上述管理職責</span></label><label className="consent"><input type="checkbox" checked={s.confirm} disabled={!data||!s.responsibility} onChange={event=>s.setConfirm(event.target.checked)}/><span>確認以目前帳號接受管理邀請</span></label></fieldset><Button type="submit" loading={s.busy} disabled={s.unavailable||(!s.draft.pending&&(!s.confirm||!data||data.isOwner))}>{s.draft.pending?'確認管理操作結果':'接受管理邀請'}</Button></form>}{!done&&!s.draft.pending&&data&&<Button variant="secondary" disabled={s.locked} onClick={()=>void refresh()}>核對最新邀請與分工</Button>}{s.guard}{done&&<Link to={'/activities/'+encodeURIComponent(id)+'/delegation'}>查看管理分工</Link>}
  </Surface>;
}
