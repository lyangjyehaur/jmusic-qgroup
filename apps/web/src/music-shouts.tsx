import { errorText, uiText, displayLocale } from './language';
import { useContext,useEffect,useRef,useState } from 'react';
import { Link,useLocation,useParams,useSearchParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Avatar, Button, Field } from './kimi-ui';
import { ActionLink } from './action-link';
import { History } from 'lucide-react';
import { z } from 'zod';
import { MusicShout, PublishMusicShout } from '@qgroup/contracts';
import { musicText } from '@qgroup/domain';
import { ApiError } from './api';
import { authHttp } from './auth';
import { scopedHttp } from './http';
import { MusicMemberAccess,type Member } from './member-access';
import { EmbeddedPageContext,Failure,Notice,PageIntro } from './shared';
import { announceAccountChange } from './account-session';
import { ContactValue } from './music-contact-value';
import { CopyMusicValue } from './music-copy';
import { musicShoutReturn } from './music-return';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { parseMusicShoutDraft,type MusicShoutDraft as Draft } from './music-shout-record';
export type Shout=z.infer<typeof MusicShout>;
export function shoutDate(value:number){const date=new Date(value*1000);return Number.isNaN(date.getTime())?uiText('時間未記錄'):date.toLocaleString(displayLocale(),{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});}
function shoutTimestamp(value:number){const date=new Date(value*1000);return Number.isNaN(date.getTime())?undefined:date.toISOString();}
export function MusicShoutsPage({history=false}:{history?:boolean}){
  const embedded=useContext(EmbeddedPageContext);
  return <>{!embedded&&<><PageIntro title={history?'找搭子歷史':'找搭子'}/><Link className="back" to="/people">回到同好</Link></>}
    <div className="partner-navigation"><ActionLink variant="ghost" to={history?'/people/shouts':'/people/shouts/history'} startIcon={<History size={16}/>}>{history?'目前找搭子':'找搭子歷史'}</ActionLink></div>
    <MusicMemberAccess purpose={uiText("使用找搭子")}>{viewer=><Shouts key={viewer.scope+':'+viewer.musicEpoch} viewer={viewer} history={history}/>}</MusicMemberAccess></>;
}
function Shouts({viewer,history}:{viewer:Member;history:boolean}){
  const location=useLocation(),[params,setParams]=useSearchParams(),raw=params.get('offset'),[denied,setDenied]=useState(false);
  const offset=raw&&/^\d+$/.test(raw)&&Number(raw)<=1000000?Number(raw):0;
  const query=useQuery({queryKey:['private',viewer.scope,'music-shouts',viewer.musicEpoch,history,offset],queryFn:({signal})=>scopedHttp(viewer.scope).requestContract(history?'GET /api/v2/music/shouts/history':'GET /api/v2/music/shouts',{signal,query:{offset,limit:10}}),refetchOnMount:'always',refetchInterval:30000});
  const profile=useQuery({queryKey:['private',viewer.scope,'music',viewer.musicEpoch],queryFn:()=>scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music',{})});
  if(denied)return <Notice>目前帳號或成分權限已變更。<Button onClick={()=>window.location.reload()}>重新確認權限</Button></Notice>;
  return <>{query.isPending||!query.isFetchedAfterMount?<Notice>正在讀取找搭子…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<>
    <div className={history?'partner-history':'partner-layout'}>
    <section className="partner-feed" aria-label={history?'歷史找搭子名單':'目前找搭子名單'}><div className="partner-feed-heading"><Heading level={2}>{history?'歷史':'目前'} · {query.data.total} 則</Heading>{!history&&profile.data&&<Button className="partner-compose-jump" aria-label="前往發布找搭子" variant="secondary" onClick={()=>{const panel=document.getElementById('shout-compose');panel?.scrollIntoView({behavior:'smooth',block:'start'});panel?.focus({preventScroll:true});}}>發布找搭子</Button>}</div>
      {history&&<Text size="sm">過期或由新發布取代的內容；最多保留最近 500 則。</Text>}
      {!query.data.items.length?<Notice>{offset?'這一頁已沒有內容，請返回上一頁。':history?'尚無歷史找搭子內容。':'目前沒有有效的找搭子內容。'}</Notice>:<ul className="shout-list">{query.data.items.map(item=><li key={item.id}><Surface className="shout-card partner-post">
        <header className="partner-author"><span aria-hidden="true"><Avatar user={{name:item.name,avatar:item.name.slice(0,1),color:'var(--app-accent)'}} size="sm"/></span><div><strong>{item.mine?'我 · ':''}{item.name}</strong><time dateTime={shoutTimestamp(item.createdAt)}>{shoutDate(item.createdAt)}</time></div></header>
        <Heading level={3}><Link to={'/people/shouts/'+encodeURIComponent(item.id)+'?'+new URLSearchParams({from:location.pathname+location.search})}>{item.text}</Link></Heading>
        <Text size="sm" className="partner-expiry">{item.archivedAt===null?'有效至 '+shoutDate(item.expiresAt):'已歸檔 · '+shoutDate(item.archivedAt)}</Text>
      </Surface></li>)}</ul>}
      {(query.data.total>10||offset>0)&&<div className="page-actions partner-pagination"><Button variant="secondary" disabled={offset<=0} onClick={()=>setParams({offset:String(Math.max(0,offset-10))})}>上一頁</Button><span>第 {Math.floor(offset/10)+1} 頁</span><Button variant="secondary" disabled={offset+10>=query.data.total} onClick={()=>setParams({offset:String(offset+10)})}>下一頁</Button></div>}
    </section>
    {!history&&profile.data&&<aside className="partner-compose"><Compose key={profile.data.id} viewer={viewer} profileId={profile.data.id} nextAllowedAt={query.data.nextAllowedAt} serverTime={query.data.now} onDenied={()=>setDenied(true)}/></aside>}
    {!history&&profile.error&&<Failure error={profile.error} retry={()=>void profile.refetch()}/>}
    </div>
  </>}</>;
}
function Compose({viewer,profileId,nextAllowedAt,serverTime,onDenied}:{viewer:Member;profileId:string;nextAllowedAt:number;serverTime:number;onDenied:()=>void}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:music:shout:v1:'+viewer.scope+':'+viewer.musicEpoch+':'+profileId;
  const record=useDurableRecord<Draft>({key:storageKey,scope:viewer.scope,seed:()=>({text:''}),parse:raw=>parseMusicShoutDraft(raw,{profileId,musicEpoch:viewer.musicEpoch}),dirty:value=>!!value.text,pending:value=>!!value.pending});
  const {value:draft,busy,locked,unavailable,begin,persist,replace,setBusy,active}=record;
  const [message,setMessage]=useState(''),[elapsed,setElapsed]=useState(0),[denied,setDenied]=useState(false);
  const cancel=useRef(new AbortController());useEffect(()=>{cancel.current=new AbortController();return()=>cancel.current.abort();},[]);
  useEffect(()=>setMessage(''),[record.epoch]);
  useEffect(()=>{const start=Date.now();setElapsed(0);const timer=setInterval(()=>setElapsed(Math.max(0,Math.floor((Date.now()-start)/1000))),1000);return()=>clearInterval(timer);},[serverTime]);
  const cooling=serverTime+elapsed<nextAllowedAt,normalized=musicText(draft.text),count=Array.from(normalized).length;
  async function publish(){
    if(denied||!draft.pending&&(cooling||!normalized||count>140))return;
    const input=PublishMusicShout.safeParse({profileId,musicEpoch:viewer.musicEpoch,text:draft.text,confirm:true});
    if(!draft.pending&&!input.success){setMessage(uiText("請檢查找搭子內容。"));return;}
    if(!begin())return;setMessage('');let accepted=false;
    const operation=draft.pending??{key:crypto.randomUUID(),input:input.data!},pending={...draft,pending:operation};
    try{
      if(!await persist(pending,false,uiText("無法保存原稿及操作編號，尚未發布。"))||!active.current)return;
      replace(pending);
      await authHttp(viewer).requestContract('POST /api/v2/me/music/shouts',{body:operation.input,requestId:operation.key,requestScope:viewer.scope,signal:cancel.current.signal});accepted=true;
      if(!active.current||!await persist({text:''},false,uiText("已發布，但無法保存本機確認狀態；請保留原操作並核對結果。"))||!active.current)return;
      replace({text:''});setMessage(uiText("已發布。"));
      void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shouts']});announceAccountChange();
    }catch(error){if(!active.current)return;
      if(error instanceof ApiError&&([401,403].includes(error.status)||['ACCOUNT_CHANGED','PROFILE_ERASED','MUSIC_PROFILE_REQUIRED'].includes(error.code))){
        setDenied(true);onDenied();void client.invalidateQueries({queryKey:['session']});void client.invalidateQueries({queryKey:['private',viewer.scope,'music']});return;
      }
      if(!accepted&&error instanceof ApiError&&error.status<500&&(error.status!==429||error.code==='SHOUT_COOLDOWN')){
        if(await persist({text:pending.text},false,uiText("無法保存拒絕結果；原發布操作仍保留，請重新核對。"))&&active.current)replace({text:pending.text});
        setMessage(errorText(error));void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shouts']});
      }else setMessage(uiText("尚未確認發布結果。內容與操作編號已保留，請按「確認發布結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  if(denied)return <Notice>目前帳號或成分權限已變更。<Button onClick={()=>window.location.reload()}>重新確認權限</Button></Notice>;
  return <><DraftFeedback form={{...record,message:message||record.message}}/>
    <Surface id="shout-compose" tabIndex={-1} className="shout-compose form-section"><Heading level={2}>發布找搭子</Heading><Text id="shout-publish-help" size="sm">內容、成分稱呼與聯絡 QQ 會提供給成分會員。每 24 小時一則，30 天後歸檔；新發布會取代本人上一則。</Text>
      <form onSubmit={event=>{event.preventDefault();void publish();}}><Field label="找搭子內容"><textarea id="shout-content" rows={4} value={draft.text} maxLength={4096} disabled={locked} aria-describedby="shout-publish-help shout-count" onChange={event=>{record.change({...draft,text:event.target.value});setMessage('');}}/></Field>
        <Text id="shout-count" size="sm">{count} / 140 字</Text>{cooling&&<Text role="status">下次可發布：{shoutDate(nextAllowedAt)}</Text>}
        <Button type="submit" loading={busy} disabled={draft.pending?busy||unavailable:locked||cooling||!normalized||count>140}>{draft.pending?'確認發布結果':'發布找搭子'}</Button>
      </form>
    </Surface>
  </>;
}
export function MusicShoutPage(){
  const {id=''}=useParams(),[params]=useSearchParams(),back=musicShoutReturn(params.get('from'))??'/people/shouts';
  return <><PageIntro title="找搭子詳情"/><Link className="back" to={back}>{back.startsWith('/people/shouts/history')?'回到找搭子歷史':'回到找搭子'}</Link><MusicMemberAccess purpose={uiText("查看找搭子")}>{viewer=><ShoutDetail key={viewer.scope+':'+viewer.musicEpoch+':'+id} viewer={viewer} id={id}/>}</MusicMemberAccess></>;
}
function ShoutDetail({viewer,id}:{viewer:Member;id:string}){
  const location=useLocation(),query=useQuery({queryKey:['private',viewer.scope,'music-shout',viewer.musicEpoch,id],queryFn:({signal})=>scopedHttp(viewer.scope).requestContract('GET /api/v2/music/shouts/:id',{signal,params:{id}}),refetchOnMount:'always',refetchInterval:30000});
  return query.isPending||!query.isFetchedAfterMount?<Notice>正在讀取找搭子…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<Surface className="shout-card" role="region" aria-label="找搭子內容">
    <Text className="shout-body">{query.data.text}</Text><Text>{query.data.name} · {shoutDate(query.data.createdAt)}</Text><Text>{query.data.archivedAt===null?'有效至 '+shoutDate(query.data.expiresAt):'已歸檔 · '+shoutDate(query.data.archivedAt)}</Text>
    <CopyMusicValue value={query.data.text} label="找搭子內容"/>{query.data.author?<><Link className="back" to={'/people/'+query.data.author.id+'?'+new URLSearchParams({from:location.pathname+location.search})}>查看發布者成分</Link><ContactValue number={query.data.author.contactQQ} source={query.data.author.contactSource}/><Text size="sm">固定成分 ID：{query.data.author.id}</Text><CopyMusicValue value={query.data.author.id} label="成分 ID"/></>:<Text>發布者成分已不存在，無法提供目前聯絡資料。</Text>}
  </Surface>;
}
