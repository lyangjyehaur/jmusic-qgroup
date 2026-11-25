import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { z } from 'zod';
import { AttendeeClaimContext, DecideAttendeeClaim, IssueAttendeeClaim, RequestAttendeeClaim } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
const Pending=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('issue'),key:z.string().uuid(),input:IssueAttendeeClaim}).strict(),
  z.object({kind:z.literal('decide'),key:z.string().uuid(),claimId:z.string(),input:DecideAttendeeClaim}).strict(),
  z.object({kind:z.literal('request'),key:z.string().uuid(),input:RequestAttendeeClaim}).strict(),
]);
const Draft=z.object({revision:z.number().int().min(0),target:z.string(),decision:z.enum(['approve','reject','revoke']),reason:z.string(),pending:Pending.optional()}).strict();
type DraftValue=z.infer<typeof Draft>;
const empty=(revision=0):DraftValue=>({revision,target:'',decision:'approve',reason:''});
const statuses:Record<string,string>={invited:uiText("待本人申請"),requested:uiText("待管理人核對"),approved:uiText("已通過"),rejected:uiText("已拒絕"),revoked:uiText("已撤銷"),expired:uiText("已過期")};
const rosterStatuses:Record<string,string>={confirmed:uiText("正式"),waiting:uiText("候補"),tentative:uiText("待確認")};
function useClaimDraft(viewer:Member,id:string,mode:string,revision=0,presetTarget=''){
  const storageKey='qgroup:rebuild:activity-draft:claims:v1:'+viewer.scope+':'+id+':'+mode;
  const seed=():DraftValue=>({...empty(revision),target:presetTarget,decision:presetTarget?'revoke':'approve'});
  const record=useDurableRecord({key:storageKey,scope:viewer.scope,seed,parse:raw=>{
    const value=Draft.parse(JSON.parse(raw));if(value.pending&&((value.pending.kind==='request')!==(mode!=='manage')))throw Error('operation target');
    return JSON.stringify({...value,revision})===JSON.stringify(empty(revision))?seed():value;
  },needsRestore:raw=>JSON.stringify({...Draft.parse(JSON.parse(raw)),revision})!==JSON.stringify(empty(revision)),dirty:value=>JSON.stringify({...value,revision})!==JSON.stringify(empty(revision)),pending:value=>!!value.pending});
  const {value:draft,replace:setDraft,active,busy,setBusy,locked,readError,persist,begin,unavailable}=record;
  const [message,setMessage]=useState(''),[confirm,setConfirm]=useState(false),[identity,setIdentity]=useState(false);
  function resetConfirm(){setConfirm(false);setIdentity(false);}
  useEffect(resetConfirm,[record.epoch]);
  function edit(patch:Partial<DraftValue>){record.change({...draft,...patch});resetConfirm();setMessage('');}
  const guard=<>{message&&<Text role="status">{message}</Text>}<DraftFeedback form={record}/></>;
  return {active,draft,setDraft,busy,setBusy,message,setMessage,confirm,setConfirm,identity,setIdentity,resetConfirm,locked,readError,persist,begin,unavailable,epoch:record.epoch,edit,guard};
}
export function ActivityClaimsPage(){
  const {id=''}=useParams();return <><PageIntro title="代報認領"/><div className="page-actions"><Link to={'/activities/'+encodeURIComponent(id)}>回到活動</Link><Link to={'/activities/'+encodeURIComponent(id)+'/registration'}>管理報名</Link></div><MemberAccess>{viewer=><ClaimLoader key={viewer.scope+':'+id} viewer={viewer} id={id}/>}</MemberAccess></>;
}
function ClaimLoader({viewer,id}:{viewer:Member;id:string}){
  const query=useQuery({queryKey:['private',viewer.scope,'activity-claims',id],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/claims', { params: { id: id } }),refetchOnWindowFocus:false});
  return query.isPending?<Notice>正在讀取認領資料…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<ClaimManager viewer={viewer} initial={query.data}/>;
}
function ClaimManager({viewer,initial}:{viewer:Member;initial:z.infer<typeof AttendeeClaimContext>}){
  const [search]=useSearchParams(),preset=initial.people.find(person=>person.id===search.get('person'));
  const [data,setData]=useState(initial),s=useClaimDraft(viewer,initial.id,'manage',initial.revision,preset?'person:'+preset.id:''),client=useQueryClient(),stale=s.draft.revision!==data.revision;
  const person=data.people.find(person=>'person:'+person.id===s.draft.target),claim=data.claims.find(claim=>'claim:'+claim.id===s.draft.target),choices=claim?[...(claim.canDecide?['approve' as const,'reject' as const]:[]),...(claim.canRevoke?['revoke' as const]:[])]:[],available=person?!person.blocker:choices.includes(s.draft.decision),reasonLabel=uiText('認領原因');
  function choose(target:string){const next=data.claims.find(claim=>'claim:'+claim.id===target);s.edit({target,decision:next?.canDecide?'approve':'revoke',reason:''});}
  const latest=()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/claims', { params: { id: data.id } });
  function update(fresh:typeof data){setData(fresh);client.setQueryData(['private',viewer.scope,'activity-claims',data.id],fresh);}
  async function rebase(){if(s.locked||!s.begin())return;try{const fresh=await latest();if(!s.active.current)return;const next={...s.draft,revision:fresh.revision};if(!await s.persist(next))return;update(fresh);s.setDraft(next);s.resetConfirm();s.setMessage(uiText("已取得最新名單與認領狀態；原輸入保留，請重新核對。"));}catch(error){if(s.active.current)s.setMessage(error instanceof Error?errorText(error):uiText("讀取失敗"));}finally{if(s.active.current)s.setBusy(false);}}
  async function submit(){
    if(s.busy||s.unavailable)return;let operation=s.draft.pending;
    if(!operation){
      if(!s.confirm||!available||stale)return;
      if(person){const input=IssueAttendeeClaim.safeParse({revision:s.draft.revision,attendeeId:person.id,reason:s.draft.reason,confirm:true});if(!input.success){s.setMessage(uiText("請填寫 1–200 字的認領原因。"));return;}operation={kind:'issue',key:crypto.randomUUID(),input:input.data};}
      else if(claim){const input=DecideAttendeeClaim.safeParse({revision:s.draft.revision,decision:s.draft.decision,reason:s.draft.reason,confirmPerson:s.identity,confirm:true});if(!input.success){s.setMessage(uiText("請填寫 1–200 字的認領原因；通過前須核對申請人身分。"));return;}operation={kind:'decide',key:crypto.randomUUID(),claimId:claim.id,input:input.data};}else return;
    }
    if(operation.kind==='request')return;const pending={...s.draft,pending:operation};if(!s.begin())return;if(!await s.persist(pending)||!s.active.current){if(s.active.current)s.setBusy(false);return;}s.setDraft(pending);s.setMessage('');let accepted=false;
    try{if(operation.kind==='issue')await authHttp(viewer).requestContract('POST /api/v2/activities/:id/claims', { params: { id: data.id }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });
      else await authHttp(viewer).requestContract('POST /api/v2/activities/:id/claims/:claimId', { params: { id: data.id, claimId: operation.claimId }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;const fresh=await latest();if(!s.active.current)return;const next=empty(fresh.revision);if(!await s.persist(next,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');s.setDraft(next);update(fresh);s.resetConfirm();s.setMessage(operation.kind==='issue'?uiText("認領邀請已建立。"):uiText("認領處理已保存。"));for(const key of ['activity','activity-roster','activity-registration'])void client.invalidateQueries({queryKey:['private',viewer.scope,key,data.id]});}
    catch(error){if(!s.active.current)return;if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await s.persist(next))s.setDraft(next);s.resetConfirm();s.setMessage(errorText(error));}else s.setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認認領操作結果」安全重試。"));}finally{if(s.active.current)s.setBusy(false);}
  }
  return <><Surface className="detail activity-editor"><Heading level={2}>{data.title}</Heading>{!data.people.length&&!data.claims.some(claim=>claim.canDecide||claim.canRevoke)&&!s.draft.pending&&<Notice>目前沒有可由此帳號邀請或處理的代報認領。</Notice>}
    {(data.people.length>0||data.claims.some(claim=>claim.canDecide||claim.canRevoke)||s.draft.target||s.draft.pending)&&<form noValidate onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={s.locked}><legend className="sr-only">邀請或核對代報認領</legend><div className="account-field"><label htmlFor="claim-target">處理對象</label><select id="claim-target" value={s.draft.target} onChange={event=>choose(event.target.value)}><option value="">請選擇</option>{data.people.map(person=><option key={'person:'+person.id} value={'person:'+person.id}>邀請認領：{person.name} · {rosterStatuses[person.status]??person.status}</option>)}{data.claims.filter(claim=>claim.canDecide||claim.canRevoke).map(claim=><option key={'claim:'+claim.id} value={'claim:'+claim.id}>處理認領：{claim.name} · {statuses[claim.status]}</option>)}{s.draft.target&&!person&&!claim&&<option value={s.draft.target}>原認領目前不可操作</option>}</select></div>
      {person&&<><Text>付款歸屬：{person.payerName}</Text>{person.blocker&&<Notice>{person.blocker}</Notice>}<Notice>連結有效 7 天；本人申請後仍須管理人核對。重新邀請會撤銷此人的舊認領邀請與待審申請。</Notice></>}
      {claim&&<><Text>報名者：{claim.name} · 申請帳號：{claim.requesterName||'尚未申請'}</Text><div className="account-field"><label htmlFor="claim-decision">認領操作</label><select id="claim-decision" value={s.draft.decision} onChange={event=>s.edit({decision:event.target.value as DraftValue['decision']})}>{choices.map(decision=><option key={decision} value={decision}>{decision==='approve'?'通過認領':decision==='reject'?'拒絕認領':'撤銷認領邀請'}</option>)}{!choices.includes(s.draft.decision)&&<option value={s.draft.decision}>原操作目前不可執行</option>}</select></div>{s.draft.decision==='approve'&&<label className="consent"><input type="checkbox" checked={s.identity} onChange={event=>{s.setIdentity(event.target.checked);s.setConfirm(false);}}/><span>已核對申請人就是這位參加者</span></label>}</>}
      {s.draft.target&&<><Notice>認領只移轉身分與管理權，保留原隊位、同意與付款責任；不合併重複報名或款項。</Notice><div className="account-field"><label htmlFor="claim-reason">{reasonLabel}</label><textarea id="claim-reason" rows={2} maxLength={400} value={s.draft.reason} onChange={event=>s.edit({reason:event.target.value})}/></div>{stale&&<Notice>活動或認領狀態已有更新，請先核對最新資料。</Notice>}<label className="consent"><input type="checkbox" disabled={!available||stale||(!person&&s.draft.decision==='approve'&&!s.identity)} checked={s.confirm} onChange={event=>s.setConfirm(event.target.checked)}/><span>已核對對象、原因與付款責任，確認{person?'建立認領邀請':'提交認領處理'}</span></label></>}
    </fieldset>{(s.draft.target||s.draft.pending)&&<Button type="submit" loading={s.busy} disabled={s.unavailable||(!s.draft.pending&&(!s.confirm||!available||stale))}>{s.draft.pending?'確認認領操作結果':person?'建立認領邀請':'提交認領處理'}</Button>}</form>}{!s.draft.pending&&<Button variant="secondary" disabled={s.locked} onClick={()=>void rebase()}>核對最新資料，保留輸入</Button>}{s.guard}</Surface>
    <Surface className="detail"><Heading level={2}>認領紀錄</Heading>{!data.claims.length?<Notice>目前沒有此帳號可查看的認領紀錄。</Notice>:<ul className="invitation-list">{data.claims.map(claim=><li key={claim.id}><Text>{claim.name} · {statuses[claim.status]??claim.status}{claim.requesterName?' · 申請帳號：'+claim.requesterName:''}</Text><Text>期限：{claim.expiresAt.replace('T',' ')}</Text>{claim.token&&<><Link to={'/activities/'+encodeURIComponent(data.id)+'/claims/'+encodeURIComponent(claim.token)}>本人認領連結（{claim.name}）</Link><Text className="invitation-url">{location.origin+'/activities/'+encodeURIComponent(data.id)+'/claims/'+encodeURIComponent(claim.token)}</Text></>}{(claim.canDecide||claim.canRevoke)&&<Button variant="secondary" disabled={s.locked} onClick={()=>choose('claim:'+claim.id)}>核對或撤銷（{claim.name}）</Button>}</li>)}</ul>}</Surface></>;
}
export function RequestAttendeeClaimPage(){const {id='',token=''}=useParams();return <><PageIntro title="認領代報名"/><MemberAccess>{viewer=><ClaimRequester key={viewer.scope+':'+id+':'+token} viewer={viewer} id={id} token={token}/>}</MemberAccess></>;}
function ClaimRequester({viewer,id,token}:{viewer:Member;id:string;token:string}){
  const s=useClaimDraft(viewer,id,'request:'+token),[payment,setPayment]=useState(false),client=useQueryClient(),query=useQuery({queryKey:['private',viewer.scope,'activity-claim-preview',id,token],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/claims/preview/:token', { params: { id, token } }),refetchOnWindowFocus:false}),data=query.data,available=data?.state==='open'&&data.claimStatus==='invited'&&!data.duplicate&&!data.isManager;
  useEffect(()=>{s.resetConfirm();setPayment(false);},[data?.state,data?.state==='open'?data.revision:undefined,s.epoch]);
  async function refresh(){if(s.locked)return;s.resetConfirm();setPayment(false);await query.refetch();}
  async function submit(){
    if(s.busy||s.unavailable)return;let operation=s.draft.pending;
    if(!operation){if(!s.confirm||!s.identity||!payment||!available||data?.state!=='open')return;operation={kind:'request',key:crypto.randomUUID(),input:{revision:data.revision,confirmIdentity:true,keepPayment:true,confirm:true}};}
    if(operation.kind!=='request')return;const pending={...s.draft,pending:operation};if(!s.begin())return;if(!await s.persist(pending)||!s.active.current){if(s.active.current)s.setBusy(false);return;}s.setDraft(pending);s.setMessage('');let accepted=false;
    try{await authHttp(viewer).requestContract('POST /api/v2/activities/:id/claims/preview/:token/request', { params: { id: id, token }, body: operation.input, requestId: operation.key, requestScope: viewer.scope });accepted=true;if(!s.active.current)return;if(!await s.persist(empty(),false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))throw Error('storage');s.setDraft(empty());s.resetConfirm();setPayment(false);s.setMessage(uiText("認領申請已提交，請等待管理人核對。"));await query.refetch();void client.invalidateQueries({queryKey:['private',viewer.scope,'activity-claims',id]});}
    catch(error){if(!s.active.current)return;if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await s.persist(next))s.setDraft(next);s.resetConfirm();setPayment(false);s.setMessage(errorText(error));}else s.setMessage(uiText("尚未確認操作結果。原操作已保留，請按「確認認領操作結果」安全重試。"));}finally{if(s.active.current)s.setBusy(false);}
  }
  return <Surface className="detail activity-editor">{query.isPending&&<Notice>正在讀取認領資料…</Notice>}{query.error&&!s.draft.pending&&<Failure error={query.error} retry={()=>void refresh()}/>}{data&&<><Heading level={2}>{data.title}</Heading>{data.state==='claimed'?<><Text>已認領為 {data.name}，原隊位與付款責任保留。</Text><Link to={'/activities/'+encodeURIComponent(id)}>查看活動與報名</Link></>:<><dl><dt>原報名者</dt><dd>{data.name} · {rosterStatuses[data.status]??data.status}</dd><dt>申請帳號</dt><dd>{viewer.nickname}</dd><dt>原付款歸屬</dt><dd>{data.payerName}（{data.payerKind==='manager'?'原代報管理人':'參加者本人'}）</dd><dt>認領期限</dt><dd>{data.expiresAt.replace('T',' ')}</dd></dl>{data.duplicate&&<Notice>你已有本人報名，請先與管理人核對重複項；名額與款項不會自動合併。</Notice>}{data.isManager&&<Notice>請由被代報者自己的帳號申請認領。</Notice>}{data.claimStatus==='requested'&&<Notice>{data.requestedByMe?'你的申請正在等待管理人核對。':'此連結已有認領申請，請聯絡管理人核對。'}</Notice>}<Notice>申請認領不授予私人活動、名單或帳務存取，須待管理人通過。</Notice></>}</>}
    {(available||s.draft.pending)&&<form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={s.locked}><legend className="sr-only">本人與付款確認</legend><label className="consent"><input type="checkbox" checked={s.identity} onChange={event=>{s.setIdentity(event.target.checked);s.setConfirm(false);}}/><span>我就是這位被代報的參加者</span></label><label className="consent"><input type="checkbox" checked={payment} onChange={event=>{setPayment(event.target.checked);s.setConfirm(false);}}/><span>保留原付款責任、隊位與同意紀錄，不移轉或合併款項</span></label><label className="consent"><input type="checkbox" disabled={!s.identity||!payment} checked={s.confirm} onChange={event=>s.setConfirm(event.target.checked)}/><span>確認以目前帳號提交本人認領申請</span></label></fieldset><Button type="submit" loading={s.busy} disabled={s.unavailable||(!s.draft.pending&&(!s.confirm||!available))}>{s.draft.pending?'確認認領操作結果':'提交認領申請'}</Button></form>}{!s.draft.pending&&data&&<Button variant="secondary" disabled={s.locked} onClick={()=>void refresh()}>核對最新認領狀態</Button>}{s.guard}
  </Surface>;
}
