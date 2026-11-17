import { useEffect,useRef,useState } from 'react';
import { Link,useBlocker,useLocation,useParams,useSearchParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { z } from 'zod';
import { MusicShouts,MusicShout,Profile,PublishMusicShout,PublishedMusicShout } from '@qgroup/contracts';
import { musicText } from '@qgroup/domain';
import { api,ApiError } from './api';
import { authHeaders } from './auth';
import { MusicMemberAccess,type Member } from './member-access';
import { Failure,Notice,PageIntro } from './shared';
import { announceAccountChange } from './account-session';
import { ContactValue } from './music-contact-value';
import { CopyMusicValue } from './music-copy';
import { musicShoutReturn } from './music-return';
export type Shout=z.infer<typeof MusicShout>;
export function shoutDate(value:number){const date=new Date(value*1000);return Number.isNaN(date.getTime())?'時間未記錄':date.toLocaleString('zh-TW',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
export function MusicShoutsPage({history=false}:{history?:boolean}){
  return <><PageIntro title={history?'找搭子歷史':'找搭子'}/><div className="page-actions"><Link to="/people">回到同好</Link><Link to={history?'/people/shouts':'/people/shouts/history'}>{history?'目前找搭子':'找搭子歷史'}</Link></div>
    <MusicMemberAccess purpose="使用找搭子">{viewer=><Shouts key={viewer.scope+':'+viewer.musicEpoch} viewer={viewer} history={history}/>}</MusicMemberAccess></>;
}
function Shouts({viewer,history}:{viewer:Member;history:boolean}){
  const location=useLocation(),[params,setParams]=useSearchParams(),raw=params.get('offset');
  const offset=raw&&/^\d+$/.test(raw)&&Number(raw)<=1000000?Number(raw):0;
  const query=useQuery({queryKey:['private',viewer.scope,'music-shouts',viewer.musicEpoch,history,offset],queryFn:({signal})=>api('/music/shouts'+(history?'/history':'')+'?offset='+offset+'&limit=10',MusicShouts,{signal,headers:{'X-Account-Scope':viewer.scope}}),refetchOnMount:'always',refetchInterval:30000});
  const profile=useQuery({queryKey:['private',viewer.scope,'music',viewer.musicEpoch],queryFn:()=>api('/me/music',Profile,{headers:{'X-Account-Scope':viewer.scope}})});
  return <>{query.isPending||!query.isFetchedAfterMount?<Notice>正在讀取找搭子…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<>
    {!history&&profile.data&&<Compose key={profile.data.id} viewer={viewer} profileId={profile.data.id} nextAllowedAt={query.data.nextAllowedAt} serverTime={query.data.now}/>}
    <section aria-label={history?'歷史找搭子名單':'目前找搭子名單'}><Heading level={2}>{history?'歷史':'目前'} · {query.data.total} 則</Heading>
      {history&&<Text size="sm">過期或由新發布取代的內容；最多保留最近 500 則。</Text>}
      {!query.data.items.length?<Notice>{offset?'這一頁已沒有內容，請返回上一頁。':history?'尚無歷史找搭子內容。':'目前沒有有效的找搭子內容。'}</Notice>:<ul className="shout-list">{query.data.items.map(item=><li key={item.id}><Surface className="shout-card">
        <Heading level={3}><Link to={'/people/shouts/'+encodeURIComponent(item.id)+'?'+new URLSearchParams({from:location.pathname+location.search})}>{item.text}</Link></Heading>
        <Text>{item.mine?'我 · ':''}{item.name} · {shoutDate(item.createdAt)}</Text><Text size="sm">{item.archivedAt===null?'有效至 '+shoutDate(item.expiresAt):'已歸檔 · '+shoutDate(item.archivedAt)}</Text>
      </Surface></li>)}</ul>}
      <div className="page-actions"><Button variant="secondary" disabled={offset<=0} onClick={()=>setParams({offset:String(Math.max(0,offset-10))})}>上一頁</Button><Button variant="secondary" disabled={offset+10>=query.data.total} onClick={()=>setParams({offset:String(offset+10)})}>下一頁</Button></div>
    </section>
  </>}</>;
}
const Draft=z.object({text:z.string(),pending:z.object({key:z.string().uuid(),input:PublishMusicShout}).strict().optional()}).strict();
function Compose({viewer,profileId,nextAllowedAt,serverTime}:{viewer:Member;profileId:string;nextAllowedAt:number;serverTime:number}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:music:shout:v1:'+viewer.scope+':'+viewer.musicEpoch+':'+profileId;
  const [loaded]=useState(()=>{try{const raw=sessionStorage.getItem(storageKey);return{draft:raw?Draft.parse(JSON.parse(raw)):{text:''},error:''};}catch{return{draft:{text:''},error:'無法讀取找搭子草稿，原始內容已保留。請先保全原稿。'};}});
  const [draft,setDraft]=useState<z.infer<typeof Draft>>(loaded.draft),[readError,setReadError]=useState(loaded.error),[storageError,setStorageError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[elapsed,setElapsed]=useState(0);
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{const start=Date.now();setElapsed(0);const timer=setInterval(()=>setElapsed(Math.max(0,Math.floor((Date.now()-start)/1000))),1000);return()=>clearInterval(timer);},[serverTime]);
  const cooling=serverTime+elapsed<nextAllowedAt,dirty=!!draft.text||!!draft.pending,blocker=useBlocker(dirty);
  useEffect(()=>{if(readError)return;try{sessionStorage.setItem(storageKey,JSON.stringify(draft));setStorageError('');}catch{setStorageError('無法保存找搭子草稿，尚未送出。');}},[draft,storageKey,readError]);
  useEffect(()=>{if(!dirty)return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[dirty]);
  async function publish(){
    if(busy||readError||storageError)return;
    const operation=draft.pending??{key:crypto.randomUUID(),input:PublishMusicShout.parse({profileId,musicEpoch:viewer.musicEpoch,text:draft.text,confirm:true})};
    const pending={...draft,pending:operation};try{sessionStorage.setItem(storageKey,JSON.stringify(pending));}catch{setStorageError('無法保存操作編號，尚未發布。');return;}
    setDraft(pending);setBusy(true);setMessage('');
    try{
      await api('/me/music/shouts',PublishedMusicShout,{method:'POST',headers:{...authHeaders(viewer),'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});
      if(!active.current)return;const clean={text:''};sessionStorage.setItem(storageKey,JSON.stringify(clean));setDraft(clean);setMessage('已發布。');
      void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shouts']});announceAccountChange();
    }catch(error){if(!active.current)return;
      if(error instanceof ApiError&&error.status<500&&(error.status!==429||error.code==='SHOUT_COOLDOWN')){setDraft({...draft,pending:undefined});setMessage(error.message);void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shouts']});}
      else setMessage('尚未確認發布結果。內容與操作編號已保留，請按「確認發布結果」安全重試。');
    }finally{if(active.current)setBusy(false);}
  }
  const locked=busy||!!draft.pending||!!readError,normalized=musicText(draft.text),count=Array.from(normalized).length;
  return <>{blocker.state==='blocked'&&<Surface role="alert"><Text>仍有找搭子草稿或待確認發布。</Text><Button onClick={()=>blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={()=>blocker.proceed()}>保留草稿並離開</Button></Surface>}
    <Surface className="shout-compose"><Heading level={2}>發布找搭子</Heading><Text id="shout-publish-help" size="sm">內容、成分稱呼與聯絡 QQ 會提供給成分會員。每 24 小時一則，30 天後歸檔；新發布會取代本人上一則。</Text>
      <form onSubmit={event=>{event.preventDefault();void publish();}}><div className="account-field"><label htmlFor="shout-content">找搭子內容</label><textarea id="shout-content" rows={4} value={draft.text} maxLength={4096} disabled={locked} aria-describedby="shout-publish-help shout-count" onChange={event=>{setDraft({...draft,text:event.target.value});setMessage('');}}/></div>
        <Text id="shout-count" size="sm">{count} / 140 字</Text>{cooling&&<Text role="status">下次可發布：{shoutDate(nextAllowedAt)}</Text>}
        <Button type="submit" loading={busy} disabled={!!readError||!!storageError||!draft.pending&&(cooling||!normalized||count>140)}>{draft.pending?'確認發布結果':'發布找搭子'}</Button>
      </form>{message&&<Text role="status">{message}</Text>}{storageError&&<Text role="alert">{storageError}</Text>}
      {readError&&<div role="alert"><Text>{readError}</Text><Button onClick={()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw!==null)sessionStorage.setItem(storageKey+':recovery:'+Date.now(),raw);setReadError('');}catch{setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。');}}}>保全原稿後繼續</Button></div>}
    </Surface>
  </>;
}
export function MusicShoutPage(){
  const {id=''}=useParams(),[params]=useSearchParams(),back=musicShoutReturn(params.get('from'))??'/people/shouts';
  return <><PageIntro title="找搭子詳情"/><Link className="back" to={back}>{back.startsWith('/people/shouts/history')?'回到找搭子歷史':'回到找搭子'}</Link><MusicMemberAccess purpose="查看找搭子">{viewer=><ShoutDetail key={viewer.scope+':'+viewer.musicEpoch+':'+id} viewer={viewer} id={id}/>}</MusicMemberAccess></>;
}
function ShoutDetail({viewer,id}:{viewer:Member;id:string}){
  const location=useLocation(),query=useQuery({queryKey:['private',viewer.scope,'music-shout',viewer.musicEpoch,id],queryFn:({signal})=>api('/music/shouts/'+encodeURIComponent(id),MusicShout,{signal,headers:{'X-Account-Scope':viewer.scope}}),refetchOnMount:'always',refetchInterval:30000});
  return query.isPending||!query.isFetchedAfterMount?<Notice>正在讀取找搭子…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<Surface className="shout-card" role="region" aria-label="找搭子內容">
    <Text className="shout-body">{query.data.text}</Text><Text>{query.data.name} · {shoutDate(query.data.createdAt)}</Text><Text>{query.data.archivedAt===null?'有效至 '+shoutDate(query.data.expiresAt):'已歸檔 · '+shoutDate(query.data.archivedAt)}</Text>
    <CopyMusicValue value={query.data.text} label="找搭子內容"/>{query.data.author?<><Link className="back" to={'/people/'+query.data.author.id+'?'+new URLSearchParams({from:location.pathname+location.search})}>查看發布者成分</Link><ContactValue number={query.data.author.contactQQ} source={query.data.author.contactSource}/><Text size="sm">固定成分 ID：{query.data.author.id}</Text><CopyMusicValue value={query.data.author.id} label="成分 ID"/></>:<Text>發布者成分已不存在，無法提供目前聯絡資料。</Text>}
  </Surface>;
}
