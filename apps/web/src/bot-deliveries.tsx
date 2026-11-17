import { useEffect,useRef,useState } from 'react';
import { Link,useParams,useSearchParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { z } from 'zod';
import { BOT_KINDS,BotDeliveries,BotDeliveryReceipt,BotDeliveryResult,BotDeliveryReview,type Viewer } from '@qgroup/contracts';
import { AdminGate,type Access } from './admin';
import { MemberAccess } from './member-access';
import { authHeaders } from './auth';
import { api,ApiError } from './api';
import { Failure,Notice,PageIntro } from './shared';
import { useDurableValue } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { PendingBotDelivery as Pending } from './bot-delivery-record';
const states={pending:'待送',sending:'投遞中／待核對',sent:'已送出',failed:'失敗',skipped:'已略過'};
const modes={inherit:'沿用部署設定',simulate:'模擬',live:'實際發送'};
type Context={entity:'activity'|'poll';id:string};
type DeliveryRecord=ReturnType<typeof useDurableValue<Pending|null>>;
const entityPath=(entity:'activity'|'poll',id:string)=>(entity==='activity'?'/activities/':'/time-polls/')+encodeURIComponent(id);
export function AdminBotDeliveriesPage(){return <><PageIntro title="bot 投遞紀錄"/><div className="page-actions"><Link to="/admin/bot">bot 設定</Link><Link to="/admin">管理後台</Link></div><AdminGate>{(viewer,access)=><DeliveryList key={viewer.scope+':'+access.scope} viewer={viewer} access={access}/>}</AdminGate></>;}
export function BotDeliveriesPage({entity}:{entity:'activity'|'poll'}){
  const {id=''}=useParams();return <><PageIntro title="群通知紀錄"/><Link to={entityPath(entity,id)}>回到{entity==='activity'?'活動':'投票'}</Link><MemberAccess>{viewer=><DurableDeliveries key={viewer.scope+':'+entity+':'+id} viewer={viewer} context={{entity,id}}/>}</MemberAccess></>;
}
function DurableDeliveries({viewer,context}:{viewer:Viewer;context:Context}){
  const record=useDurableValue<Pending|null>({
    key:'qgroup:rebuild:activity-draft:bot-delivery:v1:'+viewer.scope+':'+entityPath(context.entity,context.id)+'/bot-deliveries',
    scope:viewer.scope,seed:()=>null,parse:raw=>Pending.nullable().parse(JSON.parse(raw)),dirty:value=>!!value,pending:value=>!!value,
  });
  return <DeliveryList viewer={viewer} context={context} record={record}/>;
}
function DeliveryList({viewer,context,access,record}:{viewer:Viewer;context?:Context;access?:Access;record?:DeliveryRecord}){
  const [search,setSearch]=useSearchParams(),client=useQueryClient(),root=context?entityPath(context.entity,context.id)+'/bot-deliveries':'/admin/bot/deliveries',
    cache=['private',viewer.scope,context?'bot-deliveries':'admin-bot-deliveries',access?.scope??'',root];
  const pending=record?.value??null,busy=record?.busy??false;
  const [message,setMessage]=useState(''),[confirmed,setConfirmed]=useState(false),[canResend,setCanResend]=useState(false),[authorityLost,setAuthorityLost]=useState(false);
  const active=useRef(true),cancel=useRef(new AbortController());
  useEffect(()=>{active.current=true;cancel.current=new AbortController();return()=>{active.current=false;cancel.current.abort();};},[]);
  const before=search.get('before')??'',status=search.get('status')??'',kind=search.get('kind')??'',selected=pending?.id??search.get('delivery')??'';
  const filters=new URLSearchParams();if(before)filters.set('before',before);if(status)filters.set('status',status);if(kind)filters.set('kind',kind);
  const list=useQuery({queryKey:[...cache,before,status,kind],queryFn:({signal})=>api(root+(filters.size?'?'+filters:''),BotDeliveries,{headers:{'X-Account-Scope':viewer.scope},signal}),staleTime:0,refetchOnWindowFocus:'always'});
  const review=useQuery({queryKey:[...cache,'review',selected],enabled:!!selected,queryFn:({signal})=>api(root+'/'+encodeURIComponent(selected),BotDeliveryReview,{headers:{'X-Account-Scope':viewer.scope},signal}),staleTime:0,refetchOnWindowFocus:'always'});
  useEffect(()=>{setConfirmed(false);},[review.dataUpdatedAt,selected]);
  useEffect(()=>{setConfirmed(false);setCanResend(false);setMessage('');},[record?.epoch]);
  const denied=authorityLost||[list.error,review.error].some(error=>error instanceof ApiError&&([401,403].includes(error.status)||error.code==='ACCOUNT_CHANGED'));
  const loseAuthority=(error:unknown)=>{if(error instanceof ApiError&&([401,403].includes(error.status)||error.code==='ACCOUNT_CHANGED'))setAuthorityLost(true);};
  function change(patch:Record<string,string>){const next=new URLSearchParams(search);for(const [key,value] of Object.entries(patch)){if(value)next.set(key,value);else next.delete(key);}setSearch(next);setMessage('');setConfirmed(false);}
  async function completed(work:Pending,result:z.infer<typeof BotDeliveryResult>){
    if(!active.current||!record||!context)return;
    if(result.originalId!==work.id||result.entity!==context.entity||result.entityId!==context.id)
      throw Error('原重送回執的通知或活動不符，請保全紀錄後核對。');
    if(!await record.persist(null,false,'已建立待送工作，但無法保存本機確認狀態；請保留原操作並查回結果。')||!active.current)return;
    record.replace(null);
    setCanResend(false);setConfirmed(false);setMessage('已建立待送工作 #'+result.queuedId+'；原通知紀錄保留。');
    await client.invalidateQueries({queryKey:cache});
  }
  async function post(work:Pending){
    return api(root+'/'+work.id+'/retry',BotDeliveryResult,{method:'POST',headers:{...authHeaders(viewer),'Idempotency-Key':work.key},body:JSON.stringify(work.input),signal:cancel.current.signal});
  }
  async function rejected(error:ApiError){
    if(!record)return;
    if(await record.persist(null,false,'無法保存拒絕結果；原重送操作仍保留，請重新核對。')&&active.current)record.replace(null);
    setCanResend(false);setConfirmed(false);setMessage(error.message);void review.refetch();
  }
  async function submit(){
    if(denied||!record||!context||!review.data||review.isFetching||!confirmed||pending||!review.data.reviewToken||!record.begin())return;
    const work={id:selected,key:crypto.randomUUID(),input:{reviewToken:review.data.reviewToken,confirm:true as const}};
    setMessage('');let accepted=false;
    try{
      if(!await record.persist(work,false,'無法保存重送操作編號，請先修復瀏覽器儲存後再操作。')||!active.current)return;
      record.replace(work);const result=await post(work);accepted=true;await completed(work,result);
    }catch(error){if(active.current){loseAuthority(error);if(!accepted&&error instanceof ApiError&&[400,404,409,422].includes(error.status))await rejected(error);else setMessage('尚未確認重送結果；請先查回原操作，避免重複建立工作。');}}
    finally{if(active.current)record.setBusy(false);}
  }
  async function recover(resend=false){
    if(denied||!record||!pending||resend&&!canResend||!record.begin())return;setMessage('');setCanResend(false);let resubmitted=false,accepted=false;
    try{
      if(!await record.persist(pending)||!active.current)return;
      const receipt=await api('/bot-delivery-results/'+pending.key,BotDeliveryReceipt,{headers:{'X-Account-Scope':viewer.scope},signal:cancel.current.signal});
      if(!active.current)return;
      if(receipt.state==='completed')await completed(pending,receipt.result);
      else if(resend){resubmitted=true;const result=await post(pending);accepted=true;await completed(pending,result);}
      else{setCanResend(true);setMessage('尚未查到原操作，可使用原編號重送；伺服器會再次核對狀態與權限。');}
    }catch(error){if(active.current){loseAuthority(error);setMessage(error instanceof ApiError?error.message:error instanceof Error&&error.message==='原重送回執的通知或活動不符，請保全紀錄後核對。'?error.message:'仍無法確認原操作結果。');if(resubmitted&&!accepted&&error instanceof ApiError&&[400,404,409,422].includes(error.status))await rejected(error);}}
    finally{if(active.current)record.setBusy(false);}
  }
  const locked=record?.locked??false;
  if(denied)return <Notice>目前帳號或通知核對權限已變更。<Button onClick={()=>window.location.reload()}>重新確認權限</Button></Notice>;
  return <>
    {message&&<Notice>{message}</Notice>}
    {record&&<DraftFeedback form={record} navigation={false}/>}
    <Surface className="detail auth-panel"><div className="activity-fields"><label className="account-field">投遞狀態<select disabled={locked} value={status} onChange={event=>change({status:event.target.value,before:''})}><option value="">全部狀態</option>{Object.entries(states).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className="account-field">通知類型<select disabled={locked} value={kind} onChange={event=>change({kind:event.target.value,before:''})}><option value="">全部類型</option>{Object.entries(BOT_KINDS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div><Button variant="secondary" disabled={busy} onClick={()=>{void list.refetch();if(selected)void review.refetch();}}>更新投遞狀態</Button></Surface>
    {list.isPending?<Notice>正在讀取投遞紀錄…</Notice>:list.error?<Failure error={list.error} retry={()=>void list.refetch()}/>:<><Text>目前發送模式：{modes[list.data.mode]}</Text>{!list.data.entries.length?<Notice>沒有符合條件的群通知紀錄。</Notice>:<ul className="invitation-list">{list.data.entries.map(row=><li key={row.id}><Text>#{row.id} · {BOT_KINDS[row.kind as keyof typeof BOT_KINDS]??row.kind} · {row.simulatedAt?'模擬（未送出）':states[row.status]}</Text><Link to={entityPath(row.entity,row.entityId)}>{row.title||row.entityId}</Link><Text>建立：{row.createdAt} · 失敗次數：{row.attempts}</Text>{row.lastError&&<Text className="preserve-lines">{row.lastError}</Text>}<Button variant="secondary" disabled={locked} onClick={()=>change({delivery:row.id})}>核對通知 #{row.id}</Button></li>)}</ul>}<div className="pagination">{before&&<Button disabled={locked} onClick={()=>change({before:''})}>回到最新紀錄</Button>}{list.data.nextBefore&&<Button disabled={locked} onClick={()=>change({before:list.data.nextBefore!})}>較早紀錄</Button>}</div></>}
    {selected&&!denied&&(review.isPending?<Notice>正在核對通知…</Notice>:review.error?<Failure error={review.error} retry={()=>void review.refetch()}/>:review.data&&<Surface className="detail auth-panel" role="region" aria-label={'通知核對 #'+selected}>
      <Heading level={2}>通知 #{selected}</Heading><Text>{review.data.delivery.title} · {review.data.delivery.simulatedAt?'模擬（未送出）':states[review.data.delivery.status]}</Text>
      <dl><dt>原目標群</dt><dd>{review.data.delivery.target||'沿用部署群'}</dd><dt>本次目標群</dt><dd>{review.data.target||'尚未設定'}</dd><dt>本次發送模式</dt><dd>{modes[review.data.mode]}</dd><dt>預定發送</dt><dd>{review.data.delivery.dueAt??'立即排入待送'}</dd><dt>重試時間</dt><dd>{review.data.delivery.retryAt??'無'}</dd><dt>確認送出</dt><dd>{review.data.delivery.sentAt??'尚未確認'}</dd>{review.data.imageName&&<><dt>結算附圖</dt><dd>{review.data.imageName}</dd></>}</dl>
      {review.data.originalText&&<details><summary>原通知內容</summary><pre className="preserve-lines">{review.data.originalText}</pre></details>}
      {review.data.deliveredText&&<details><summary>{review.data.delivery.simulatedAt?'模擬內容':'上次投遞內容'}</summary><pre className="preserve-lines">{review.data.deliveredText}</pre></details>}
      {review.data.preparedText&&<><Heading level={3}>重送內容</Heading><pre className="preserve-lines">{review.data.preparedText}</pre></>}
      {review.data.blocker&&<Text role="alert">{review.data.blocker}</Text>}
      {!context?<Link to={entityPath(review.data.delivery.entity,review.data.delivery.entityId)+'/bot-deliveries?delivery='+selected}>前往授權核對入口</Link>:!pending&&review.data.reviewToken&&<><Text>建立新的待送工作，保留原紀錄，不重做報名、投票或帳務。投遞時會再次核對政策與安排；沿用部署模式時由 worker 決定模擬或實送。</Text><label className="consent"><input type="checkbox" checked={confirmed} disabled={locked||review.isFetching} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核對目標群、發送模式與重送內容</span></label><Button disabled={!confirmed||locked||review.isFetching} loading={busy} onClick={()=>void submit()}>建立重送工作</Button></>}
    </Surface>)}
    {pending&&!denied&&<Surface role="alert" className="detail auth-panel"><Text>通知 #{pending.id} 有待確認的重送操作。</Text><Button disabled={busy||record?.unavailable} onClick={()=>void recover()}>查回原重送結果</Button>{canResend&&<Button disabled={busy||record?.unavailable} onClick={()=>void recover(true)}>以原操作編號重送</Button>}</Surface>}
  </>;
}
