import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Surface, Text } from 'yahha-ui';
import { Button, Checkbox, Select } from './kimi-ui';
import { type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { useDurableValue } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { PendingActivityAccess as Pending } from './activity-access-record';
import { activityShareURL, activitySummary } from './activity-summary';
import { CopyActivityText } from './activity-sharing';
const base=(id:string)=>'/activities/'+encodeURIComponent(id);
export function ActivityAccessPage(){
  const {id='',token=''}=useParams();
  return <><PageIntro title="接受活動可見邀請"/><MemberAccess>{viewer=><Access key={viewer.scope+':'+id+':'+token} viewer={viewer} id={id} token={token}/>}</MemberAccess></>;
}
function Access({viewer,id,token}:{viewer:Member;id:string;token:string}){
  const key='qgroup:rebuild:activity-draft:access:v1:'+viewer.scope+':'+id+':'+token,client=useQueryClient();
  const record=useDurableValue<Pending|null>({key,scope:viewer.scope,seed:()=>null,parse:raw=>Pending.nullable().parse(JSON.parse(raw)),dirty:value=>!!value,pending:value=>!!value});
  const {value:pending,busy,locked,unavailable,begin,persist,replace,setBusy}=record;
  const active=useRef(true),cancel=useRef(new AbortController());
  useEffect(()=>{active.current=true;cancel.current=new AbortController();return()=>{active.current=false;cancel.current.abort();};},[]);
  const [confirmed,setConfirmed]=useState(false),[done,setDone]=useState(false),[message,setMessage]=useState(''),[authorityLost,setAuthorityLost]=useState(false);
  const view=useQuery({queryKey:['private',viewer.scope,'activity-access',id,token],queryFn:({signal})=>scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/access/:token', { params: { id, token }, signal }),gcTime:0,refetchOnWindowFocus:false});
  useEffect(()=>{setConfirmed(false);},[view.dataUpdatedAt]);
  useEffect(()=>{setConfirmed(false);setDone(false);setMessage('');},[record.epoch]);
  const denied=authorityLost||view.error instanceof ApiError&&([401,403].includes(view.error.status)||view.error.code==='ACCOUNT_CHANGED');
  async function accept(){
    if(denied||done||(!pending&&(!confirmed||!view.data||view.error||view.isFetching))||!begin())return;
    setMessage('');let accepted=false;
    const operation=pending??{key:crypto.randomUUID(),input:{revision:view.data!.revision,confirm:true as const}};
    try{
      if(!await persist(operation,false,uiText("無法保存邀請操作編號，尚未送出授權。"))||!active.current)return;
      replace(operation);
      const result=await authHttp(viewer).requestContract('POST /api/v2/activities/:id/access/:token/accept', { params: { id: id, token }, body: operation.input, requestId: operation.key, requestScope: viewer.scope, signal: cancel.current.signal });accepted=true;
      if(!active.current)return;
      if(result.id!==id)throw Error('原邀請回執的活動不符，請保全紀錄後核對。');
      if(!await persist(null,false,uiText("已取得查看權限，但無法保存本機確認狀態；請保留原操作並核對結果。"))||!active.current)return;
      replace(null);setConfirmed(false);setDone(true);void client.invalidateQueries({queryKey:['private',viewer.scope,'activity',id]});
    }catch(error){
      if(!active.current)return;
      if(error instanceof ApiError&&([401,403].includes(error.status)||error.code==='ACCOUNT_CHANGED')){setAuthorityLost(true);return;}
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){
        if(await persist(null,false,uiText("無法保存拒絕結果；原邀請操作仍保留，請重新核對。"))&&active.current)replace(null);
        setConfirmed(false);setMessage(errorText(error));void view.refetch();
      }else setMessage(error instanceof Error&&error.message==='原邀請回執的活動不符，請保全紀錄後核對。'?errorText(error):uiText("尚未確認邀請結果，原操作已保留，請確認原邀請操作結果。"));
    }finally{if(active.current)setBusy(false);}
  }
  if(denied)return <Notice>目前帳號或邀請權限已變更。<Button onClick={()=>window.location.reload()}>重新確認權限</Button></Notice>;
  return <Surface className="detail"><DraftFeedback form={{...record,message:message||record.message}} navigation={false}/>{done?<><Notice>已取得活動查看權限。</Notice><Link to={base(id)}>查看活動</Link></>:<>
    {view.isPending?<Notice>正在核對邀請…</Notice>:view.error?<Failure error={view.error} retry={()=>void view.refetch()}/>:<><h2>{view.data.title}</h2><Text>以「{viewer.nickname}」接受後可查看活動；報名仍需另行提交，不會取得管理權限。</Text></>}
    {!pending&&view.data&&!view.error&&<Checkbox className="consent" checked={confirmed} disabled={locked||view.isFetching} onChange={event=>setConfirmed(event.target.checked)} label={<>確認接受活動查看邀請</>} />}
    <Button loading={busy} disabled={pending?busy||unavailable:locked||!confirmed||!view.data||!!view.error||view.isFetching} onClick={()=>void accept()}>{pending?'確認原邀請操作結果':'接受查看邀請'}</Button>
    {!pending&&<Button variant="secondary" disabled={locked||view.isFetching} onClick={()=>{setConfirmed(false);void view.refetch();}}>重新核對邀請</Button>}
  </>}</Surface>;
}
export function ActivitySharePage(){const {id=''}=useParams(),session=useSession();return <><PageIntro title="分享活動"/>{session.error?<Failure error={session.error} retry={()=>void session.refetch()}/>:session.data?<Share key={session.data.scope+':'+id} viewer={session.data} id={id}/>:<Notice>正在確認帳號…</Notice>}</>;}
function Share({viewer,id}:{viewer:Viewer;id:string}){
  const [search,setSearch]=useSearchParams(),kind=search.get('kind')==='conditions'?'conditions':'activity';
  const view=useQuery({queryKey:['private',viewer.scope,'activity-share',id],queryFn:async({signal})=>{
    const share=await scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/share', { params: { id }, signal });
    const event=await scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id', { params: { id }, signal }),link=activityShareURL(location.origin,id,share);
    if(event.id!==id)throw Error('活動摘要不符，請重新讀取。');
    return {...share,event,link};
  },gcTime:0});
  return <><Link to={base(id)}>回到活動</Link>{view.isPending?<Notice>正在讀取分享連結…</Notice>:view.error?<Failure error={view.error} retry={()=>void view.refetch()}/>:<Surface className="detail">{view.data.invitation&&<Notice>持有者登入並確認後可查看活動，請只傳給預期參加者。</Notice>}<CopyActivityText rows={3} text={view.data.link} label="活動連結" button={uiText("複製活動連結")}/><div className="activity-summary-kind"><Select label="摘要內容" id="activity-summary-kind" value={kind} onChange={event=>setSearch(event.target.value==='conditions'?{kind:'conditions'}:{})}><option value="activity">活動資訊</option><option value="conditions">目前安排</option></Select></div><CopyActivityText key={kind} text={activitySummary(view.data.event,view.data.link,kind)} label={kind==='conditions'?'安排摘要':'活動摘要'} button={kind==='conditions'?uiText('複製安排摘要'):uiText('複製活動摘要')}/></Surface>}</>;
}
