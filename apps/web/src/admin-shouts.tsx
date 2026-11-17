import { useEffect,useRef,useState } from 'react';
import { Link,useBlocker,useSearchParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminMusicShout,AdminMusicShouts,DeleteMusicShout,Ok,type Viewer } from '@qgroup/contracts';
import { AdminGate,adminHeaders,type Access } from './admin';
import { Failure,Notice,PageIntro } from './shared';
import { api,ApiError } from './api';
import { announceAccountChange } from './account-session';
import { shoutDate } from './music-shouts';
const Draft=z.object({id:z.string(),pending:z.object({key:z.string().uuid(),input:DeleteMusicShout}).strict().optional()}).strict();
export function AdminShoutsPage(){return <><PageIntro title="找搭子管理"/><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer,access)=><Shouts key={access.scope} viewer={viewer} access={access}/>}</AdminGate></>;}
function Shouts({viewer,access}:{viewer:Viewer;access:Access}){
  const client=useQueryClient(),[params,setParams]=useSearchParams(),period=params.get('period')==='history'?'history':'active',raw=params.get('offset'),offset=raw&&/^\d+$/.test(raw)&&Number(raw)<=1000000?Number(raw):0;
  const storageKey='qgroup:rebuild:admin-shouts:v1:'+viewer.scope+':'+access.scope;
  const [loaded]=useState(()=>{try{const raw=sessionStorage.getItem(storageKey);return{draft:raw?Draft.parse(JSON.parse(raw)):{id:''},error:''};}catch{return{draft:{id:''},error:'無法讀取找搭子管理操作紀錄，原始內容已保留。'};}});
  const [draft,setDraft]=useState<z.infer<typeof Draft>>(loaded.draft),[readError,setReadError]=useState(loaded.error),[storageError,setStorageError]=useState(''),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[message,setMessage]=useState('');
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const list=useQuery({queryKey:['private',viewer.scope,'admin-shouts',access.scope,period,offset],queryFn:({signal})=>api('/admin/shouts?'+new URLSearchParams({period,offset:String(offset),limit:'10'}),AdminMusicShouts,{signal,headers:{'X-Account-Scope':viewer.scope}}),refetchOnMount:'always',refetchInterval:30000});
  const target=useQuery({queryKey:['private',viewer.scope,'admin-shout',access.scope,draft.id],queryFn:({signal})=>api('/admin/shouts/'+encodeURIComponent(draft.id),AdminMusicShout,{signal,headers:{'X-Account-Scope':viewer.scope}}),enabled:!!draft.id,refetchOnMount:'always'});
  const blocker=useBlocker(!!draft.pending);
  useEffect(()=>{if(readError)return;try{sessionStorage.setItem(storageKey,JSON.stringify(draft));setStorageError('');}catch{setStorageError('無法保存刪除操作紀錄，尚未送出。');}},[draft,storageKey,readError]);
  useEffect(()=>{if(!draft.pending)return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[draft.pending]);
  useEffect(()=>{if([list.error,target.error].some(error=>error instanceof ApiError&&[401,403].includes(error.status)))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});},[list.error,target.error,client,viewer.scope]);
  async function remove(){
    if(busy||readError||storageError||!draft.id||!draft.pending&&(!confirmed||!target.data||target.error))return;
    const operation=draft.pending??{key:crypto.randomUUID(),input:DeleteMusicShout.parse({revision:target.data!.revision,confirm:true})},pending={...draft,pending:operation};
    try{sessionStorage.setItem(storageKey,JSON.stringify(pending));}catch{setStorageError('無法保存操作編號，尚未刪除。');return;}
    setDraft(pending);setBusy(true);setMessage('');
    try{
      await api('/admin/shouts/'+encodeURIComponent(draft.id)+'/delete',Ok,{method:'POST',headers:{...adminHeaders(viewer,access),'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});
      if(!active.current)return;const clear={id:''};sessionStorage.setItem(storageKey,JSON.stringify(clear));setDraft(clear);setConfirmed(false);setMessage('已刪除找搭子內容。');
      void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-shouts']});void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shouts']});void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shout']});announceAccountChange();
    }catch(error){if(!active.current)return;
      if(error instanceof ApiError&&error.status<500&&error.status!==429){setDraft({...draft,pending:undefined});setConfirmed(false);setMessage(error.message);void target.refetch();if([401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});}
      else setMessage('尚未確認刪除結果。操作編號已保留，請按「確認刪除結果」安全重試。');
    }finally{if(active.current)setBusy(false);}
  }
  return <>{blocker.state==='blocked'&&<Surface role="alert"><Text>仍有待確認的刪除操作。</Text><Button onClick={()=>blocker.reset()}>留在此頁</Button><Button variant="secondary" onClick={()=>blocker.proceed()}>保留紀錄並離開</Button></Surface>}
    <div className="account-field"><label htmlFor="shout-period">找搭子範圍</label><select id="shout-period" value={period} disabled={busy||!!draft.pending} onChange={event=>setParams({period:event.target.value})}><option value="active">有效內容</option><option value="history">歷史內容</option></select></div>
    {message&&<Notice>{message}</Notice>}{storageError&&<Text role="alert">{storageError}</Text>}{readError&&<Surface role="alert"><Text>{readError}</Text><Button onClick={()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw!==null)sessionStorage.setItem(storageKey+':recovery:'+Date.now(),raw);setReadError('');}catch{setStorageError('仍無法保全操作紀錄，請檢查瀏覽器儲存設定。');}}}>保全原稿後繼續</Button></Surface>}
    {draft.id&&<Surface className="shout-card" role="region" aria-label="刪除找搭子確認"><Heading level={2}>確認移除</Heading>
      {target.isPending?<Notice>正在核對內容…</Notice>:target.error?<Failure error={target.error} retry={()=>void target.refetch()}/>:<><Text className="shout-body">{target.data.text}</Text><Text>{target.data.name} · {shoutDate(target.data.createdAt)} · {target.data.archivedAt===null?'有效':'已歸檔'}</Text></>}
      <label className="consent"><input type="checkbox" checked={confirmed} disabled={busy||!!draft.pending||!!target.error} onChange={event=>setConfirmed(event.target.checked)}/><span>確認永久移除這則內容，發布者資料不會保留在刪除紀錄中</span></label>
      <div className="page-actions"><Button loading={busy} disabled={!!readError||!!storageError||!draft.pending&&(!confirmed||!target.data||!!target.error)} onClick={()=>void remove()}>{draft.pending?'確認刪除結果':'確認刪除找搭子'}</Button><Button variant="secondary" disabled={busy||!!draft.pending} onClick={()=>{setDraft({id:''});setConfirmed(false);}}>取消刪除</Button></div>
    </Surface>}
    {list.isPending||!list.isFetchedAfterMount?<Notice>正在讀取找搭子…</Notice>:list.error?<Failure error={list.error} retry={()=>void list.refetch()}/>:<section aria-label="管理找搭子名單"><Heading level={2}>{period==='history'?'歷史':'有效'} · {list.data.total} 則</Heading>
      {!list.data.items.length?<Notice>這一頁沒有找搭子內容。</Notice>:<ul className="shout-list">{list.data.items.map(item=><li key={item.id}><Surface className="shout-card"><Text className="shout-body">{item.text}</Text><Text>{item.name} · {shoutDate(item.createdAt)}</Text><Button variant="secondary" disabled={busy||!!draft.pending||!!readError||!!storageError} onClick={()=>{setDraft({id:item.id});setConfirmed(false);setMessage('');}}>移除這則內容</Button></Surface></li>)}</ul>}
      <div className="page-actions"><Button variant="secondary" disabled={offset<=0||busy||!!draft.pending} onClick={()=>setParams({period,offset:String(Math.max(0,offset-10))})}>上一頁</Button><Button variant="secondary" disabled={offset+10>=list.data.total||busy||!!draft.pending} onClick={()=>setParams({period,offset:String(offset+10)})}>下一頁</Button></div>
    </section>}
  </>;
}
