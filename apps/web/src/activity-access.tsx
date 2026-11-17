import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Button, Surface, Text } from 'yahha-ui';
import { AcceptActivityAccess, ActivityAccessPreview, ActivityAccessResult, ActivityShare, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro, useSession } from './shared';
const base=(id:string)=>'/activities/'+encodeURIComponent(id);
export function ActivityAccessPage(){
  const {id='',token=''}=useParams();
  return <><PageIntro title="接受活動可見邀請"/><MemberAccess>{viewer=><Access key={viewer.scope+':'+id+':'+token} viewer={viewer} id={id} token={token}/>}</MemberAccess></>;
}
const Pending=z.object({key:z.string().uuid(),input:AcceptActivityAccess}).strict();
function Access({viewer,id,token}:{viewer:Member;id:string;token:string}){
  const path=base(id)+'/access/'+encodeURIComponent(token),key='qgroup:rebuild:activity-draft:access:v1:'+viewer.scope+':'+id+':'+token,client=useQueryClient();
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const [loaded]=useState(()=>{try{const raw=sessionStorage.getItem(key);return {pending:raw?Pending.parse(JSON.parse(raw)):null,error:''};}catch{return {pending:null,error:'無法讀取邀請操作原稿，請先保全原稿。'};}});
  const [readError,setReadError]=useState(loaded.error),[pending,setPending]=useState(loaded.pending),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[done,setDone]=useState(false),[message,setMessage]=useState('');
  const view=useQuery({queryKey:['private',viewer.scope,'activity-access',id,token],queryFn:()=>api(path,ActivityAccessPreview,{headers:{'X-Account-Scope':viewer.scope}}),gcTime:0,refetchOnWindowFocus:false});
  async function accept(){
    if(busy||readError||(!pending&&(!confirmed||!view.data)))return;setBusy(true);setMessage('');
    let persisted=false;
    const operation=pending??{key:crypto.randomUUID(),input:{revision:view.data!.revision,confirm:true as const}};
    try{
      sessionStorage.setItem(key,JSON.stringify(operation));persisted=true;setPending(operation);
      await api(path+'/accept',ActivityAccessResult,{method:'POST',headers:{...authHeaders(viewer),'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});
      if(!active.current)return;sessionStorage.removeItem(key);setPending(null);setDone(true);void client.invalidateQueries({queryKey:['private',viewer.scope,'activity',id]});
    }catch(error){
      if(!active.current)return;
      if(error instanceof ApiError&&error.status<500){try{sessionStorage.removeItem(key);setPending(null);}catch{/* Preserve the original operation if storage is unavailable. */}setConfirmed(false);}
      setMessage(!persisted?'無法保存邀請操作編號，尚未送出授權。':error instanceof Error?error.message:'尚未確認邀請結果，請用原操作核對。');
    }finally{if(active.current)setBusy(false);}
  }
  return <Surface className="detail">{readError?<Notice>{readError}<Button disabled={busy} onClick={()=>{try{const raw=sessionStorage.getItem(key);if(raw!==null)sessionStorage.setItem(key+':recovery:'+Date.now(),raw);sessionStorage.removeItem(key);setReadError('');}catch{setMessage('仍無法保全原稿，請檢查瀏覽器儲存設定。');}}}>保全原稿後繼續</Button></Notice>:done?<><Notice>已取得活動查看權限。</Notice><Link to={base(id)}>查看活動</Link></>:<>
    {view.isPending?<Notice>正在核對邀請…</Notice>:view.error?<Failure error={view.error} retry={()=>void view.refetch()}/>:<><h2>{view.data.title}</h2><Text>以「{viewer.nickname}」接受後可查看活動；報名仍需另行提交，不會取得管理權限。</Text></>}
    {!pending&&view.data&&<label className="consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>確認接受活動查看邀請</label>}
    <Button loading={busy} disabled={!pending&&(!confirmed||!view.data)} onClick={()=>void accept()}>{pending?'確認原邀請操作結果':'接受查看邀請'}</Button>
    {!pending&&<Button variant="secondary" disabled={busy} onClick={()=>{setConfirmed(false);void view.refetch();}}>重新核對邀請</Button>}
  </>}{message&&<Text role="status">{message}</Text>}</Surface>;
}
export function ActivitySharePage(){const {id=''}=useParams(),session=useSession();return <><PageIntro title="分享活動"/>{session.error?<Failure error={session.error} retry={()=>void session.refetch()}/>:session.data?<Share key={session.data.scope+':'+id} viewer={session.data} id={id}/>:<Notice>正在確認帳號…</Notice>}</>;}
function Share({viewer,id}:{viewer:Viewer;id:string}){
  const [message,setMessage]=useState(''),view=useQuery({queryKey:['private',viewer.scope,'activity-share',id],queryFn:()=>api(base(id)+'/share',ActivityShare,{headers:{'X-Account-Scope':viewer.scope}}),gcTime:0});
  const link=view.data?location.origin+view.data.path:'';
  return <><Link to={base(id)}>回到活動</Link>{view.isPending?<Notice>正在讀取分享連結…</Notice>:view.error?<Failure error={view.error} retry={()=>void view.refetch()}/>:<Surface className="detail">{view.data.invitation&&<Notice>持有者登入並確認後可查看活動，請只傳給預期參加者。</Notice>}<div className="device-link-field"><label htmlFor="activity-share-link">活動連結</label><textarea id="activity-share-link" readOnly value={link} rows={3} onFocus={event=>event.target.select()}/></div><Button onClick={()=>{if(!navigator.clipboard){setMessage('請選取連結手動複製。');return;}void navigator.clipboard.writeText(link).then(()=>setMessage('已複製活動連結。'),()=>setMessage('請選取連結手動複製。'));}}>複製活動連結</Button>{message&&<Text role="status">{message}</Text>}</Surface>}</>;
}
