import { errorText, uiText } from './language';
import { useEffect,useState } from 'react';
import { Link,useSearchParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Field, Select, Checkbox } from './kimi-ui';
import { z } from 'zod';
import { DeleteMusicShout, type Viewer } from '@qgroup/contracts';
import { AdminGate,adminHttp,adminReadHttp,type Access } from './admin';
import { Failure,Notice,PageIntro } from './shared';
import { ApiError } from './api';
import { announceAccountChange } from './account-session';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { shoutDate } from './music-shouts';
const Draft=z.object({id:z.string(),pending:z.object({key:z.string().uuid(),input:DeleteMusicShout}).strict().optional()}).strict().refine(value=>!value.pending||!!value.id);
export function AdminShoutsPage(){return <><PageIntro title="找搭子管理"/><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer,access)=><Shouts key={access.scope} viewer={viewer} access={access}/>}</AdminGate></>;}
function Shouts({viewer,access}:{viewer:Viewer;access:Access}){
  const client=useQueryClient(),[params,setParams]=useSearchParams(),period=params.get('period')==='history'?'history':'active',raw=params.get('offset'),offset=raw&&/^\d+$/.test(raw)&&Number(raw)<=1000000?Number(raw):0;
  const storageKey='qgroup:rebuild:admin-shouts:v1:'+viewer.scope+':'+access.scope;
  const [confirmed,setConfirmed]=useState(false),[message,setMessage]=useState('');
  const record=useDurableRecord<z.infer<typeof Draft>>({key:storageKey,scope:viewer.scope,seed:()=>({id:''}),parse:raw=>Draft.parse(JSON.parse(raw)),
    dirty:value=>!!value.id,pending:value=>!!value.pending,blocking:({currentLocation,nextLocation})=>currentLocation.pathname!==nextLocation.pathname});
  const {value:draft,replace:setDraft,busy,setBusy,active,dirty,locked,unavailable,begin:start,persist}=record;
  useEffect(()=>setConfirmed(false),[record.epoch]);
  const list=useQuery({queryKey:['private',viewer.scope,'admin-shouts',access.scope,period,offset],queryFn:({signal})=>adminReadHttp(viewer).requestContract('GET /api/v2/admin/shouts',{signal,query:{period,offset,limit:10}}),refetchOnMount:'always',refetchInterval:30000});
  const target=useQuery({queryKey:['private',viewer.scope,'admin-shout',access.scope,draft.id],queryFn:({signal})=>adminReadHttp(viewer).requestContract('GET /api/v2/admin/shouts/:id',{signal,params:{id:draft.id}}),enabled:!!draft.id,refetchOnMount:'always'});
  useEffect(()=>{if([list.error,target.error].some(error=>error instanceof ApiError&&[401,403].includes(error.status)))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});},[list.error,target.error,client,viewer.scope]);
  useEffect(()=>setConfirmed(false),[target.data?.revision]);
  async function remove(){
    if(busy||unavailable||!draft.id||!draft.pending&&(!confirmed||!target.data||target.error))return;
    const operation=draft.pending??{key:crypto.randomUUID(),input:DeleteMusicShout.parse({revision:target.data!.revision,confirm:true})},pending={...draft,pending:operation};
    if(!start())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try{
      await adminHttp(viewer,access).requestContract('POST /api/v2/admin/shouts/:id/delete',{params:{id:draft.id},body:operation.input,requestId:operation.key,requestScope:viewer.scope});accepted=true;
      if(!active.current)return;const clear={id:''};if(!await persist(clear,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))return;setDraft(clear);setConfirmed(false);setMessage(uiText("已刪除找搭子內容。"));
      void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-shouts']});void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shouts']});void client.invalidateQueries({queryKey:['private',viewer.scope,'music-shout']});announceAccountChange();
    }catch(error){if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirmed(false);setMessage(errorText(error));void target.refetch();if([401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});}
      else setMessage(uiText("尚未確認刪除結果。操作編號已保留，請按「確認刪除結果」安全重試。"));
    }finally{if(active.current)setBusy(false);}
  }
  return <>
    <Field label="找搭子範圍"><Select id="shout-period" value={period} disabled={busy||!!draft.pending} onChange={event=>setParams({period:event.target.value})}><option value="active">有效內容</option><option value="history">歷史內容</option></Select></Field>
    <DraftFeedback form={{...record,message:message||record.message}}/>
    {draft.id&&<Surface className="shout-card" role="region" aria-label="刪除找搭子確認"><Heading level={2}>確認移除</Heading>
      {target.isPending?<Notice>正在核對內容…</Notice>:target.error?<Failure error={target.error} retry={()=>void target.refetch()}/>:<><Text className="shout-body">{target.data.text}</Text><Text>{target.data.name} · {shoutDate(target.data.createdAt)} · {target.data.archivedAt===null?'有效':'已歸檔'}</Text></>}
      <Checkbox className="consent" checked={confirmed} disabled={locked||!!target.error||!target.data} onChange={event=>setConfirmed(event.target.checked)} label={<><span>確認永久移除這則內容，發布者資料不會保留在刪除紀錄中</span></>} />
      <div className="page-actions"><Button loading={busy} disabled={busy||unavailable||!draft.pending&&(!confirmed||!target.data||!!target.error)} onClick={()=>void remove()}>{draft.pending?'確認刪除結果':'確認刪除找搭子'}</Button><Button variant="secondary" disabled={locked} onClick={()=>{record.change({id:''});setConfirmed(false);}}>取消刪除</Button></div>
    </Surface>}
    {list.isPending||!list.isFetchedAfterMount?<Notice>正在讀取找搭子…</Notice>:list.error?<Failure error={list.error} retry={()=>void list.refetch()}/>:<section aria-label="管理找搭子名單"><Heading level={2}>{period==='history'?'歷史':'有效'} · {list.data.total} 則</Heading>
      {!list.data.items.length?<Notice>這一頁沒有找搭子內容。</Notice>:<ul className="shout-list">{list.data.items.map(item=><li key={item.id}><Surface className="shout-card"><Text className="shout-body">{item.text}</Text><Text>{item.name} · {shoutDate(item.createdAt)}</Text><Button variant="secondary" disabled={locked||dirty} onClick={()=>{record.change({id:item.id});setConfirmed(false);setMessage('');}}>移除這則內容</Button></Surface></li>)}</ul>}
      <div className="page-actions"><Button variant="secondary" disabled={offset<=0||busy||!!draft.pending} onClick={()=>setParams({period,offset:String(Math.max(0,offset-10))})}>上一頁</Button><Button variant="secondary" disabled={offset+10>=list.data.total||busy||!!draft.pending} onClick={()=>setParams({period,offset:String(offset+10)})}>下一頁</Button></div>
    </section>}
  </>;
}
