import { errorText, uiText } from './language';
import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminMusicCatalog, AdminMusicEntryCommand, type Viewer } from '@qgroup/contracts';
import { musicText } from '@qgroup/domain';
import { AdminGate,adminHttp,adminReadHttp,type Access } from './admin';
import { ApiError } from './api';
import { Failure,Notice,PageIntro } from './shared';
import { Field } from './settlement-controls';
import { MusicSearch,useMusicSearch } from './music-search';
import { categoryLabel } from './music-entries';
import { announceAccountChange } from './account-session';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';

const Value=z.object({command:z.enum(['none','create','update','delete','merge']),id:z.string(),toId:z.string(),revision:z.string(),name:z.string(),kind:z.enum(['main','sub']),category:z.string()}).strict();
type Value=z.infer<typeof Value>;
function input(value:Value){
  const common={command:value.command,revision:value.revision,confirm:true};
  return AdminMusicEntryCommand.parse(value.command==='create'?{...common,name:value.name,kind:value.kind,category:value.category}:value.command==='update'?{...common,id:value.id,name:value.name,kind:value.kind,category:value.category}:value.command==='merge'?{...common,id:value.id,toId:value.toId}:{...common,id:value.id});
}
const Draft=z.object({value:Value,dirty:z.boolean(),pending:z.object({key:z.string().uuid(),input:AdminMusicEntryCommand}).strict().optional()}).strict().refine(draft=>{
  if(!draft.pending)return true;try{return JSON.stringify(input(draft.value))===JSON.stringify(draft.pending.input);}catch{return false;}
});
const blank=():z.infer<typeof Draft>=>({value:{command:'none',id:'',toId:'',revision:'',name:'',kind:'sub',category:'歌手'},dirty:false});
type Catalog=z.infer<typeof AdminMusicCatalog>;
export function AdminMusicCatalogPage(){return <><PageIntro title="音樂詞庫管理"/><div className="page-actions"><Link to="/admin">管理後台</Link><Link to="/music">音樂詞庫</Link></div><AdminGate>{(viewer,access)=><CatalogManager key={viewer.scope+':'+access.scope} viewer={viewer} access={access}/>}</AdminGate></>;}
function CatalogManager({viewer,access}:{viewer:Viewer;access:Access}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:admin-catalog:v1:'+viewer.scope+':'+access.scope;
  const [confirmed,setConfirmed]=useState(false),[message,setMessage]=useState('');
  const record=useDurableRecord<z.infer<typeof Draft>>({key:storageKey,scope:viewer.scope,seed:blank,parse:raw=>Draft.parse(JSON.parse(raw)),
    dirty:value=>value.dirty,pending:value=>!!value.pending,blocking:({currentLocation,nextLocation})=>currentLocation.pathname!==nextLocation.pathname});
  const {value:draft,replace:setDraft,busy,setBusy,active,dirty,locked,unavailable,begin:start,persist}=record;
  useEffect(()=>setConfirmed(false),[record.epoch]);
  const catalog=useQuery({queryKey:['private',viewer.scope,'admin-catalog',access.scope],queryFn:({signal})=>adminReadHttp(viewer).requestContract('GET /api/v2/admin/music-entries',{signal}),refetchOnMount:'always'});
  const filters=useMusicSearch(catalog.data?.entries??[]);
  const pageParam=filters.params.get('page')??'1',page=/^[1-9]\d{0,5}$/.test(pageParam)?Number(pageParam):1;
  const visible=filters.filtered.slice((page-1)*20,page*20),searchFilters={...filters,update:(key:string,value:string)=>{filters.update('page','');filters.update(key,value);}};
  useEffect(()=>{if(catalog.error instanceof ApiError&&[401,403].includes(catalog.error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});},[catalog.error,client,viewer.scope]);
  function edit(patch:Partial<Value>){if(locked)return;record.change({...draft,value:{...draft.value,...patch},dirty:true});setConfirmed(false);setMessage('');}
  function begin(command:Value['command'],entry?:Catalog['entries'][number]){
    if(locked||dirty||!catalog.data||catalog.error)return;
    record.change({value:{command,id:entry?.id??'',toId:'',revision:catalog.data!.revision,name:entry?.name??'',kind:entry?.kind??'sub',category:entry?.category??'歌手'},dirty:command!=='none'});setConfirmed(false);setMessage('');
  }
  async function rebase(){
    if(locked||!start())return;
    try{const fresh=await catalog.refetch();if(fresh.error)throw fresh.error;if(!active.current||!fresh.data)return;
      const next={...draft,value:{...draft.value,revision:fresh.data.revision},dirty:true};if(!await persist(next))return;setDraft(next);setConfirmed(false);setMessage(uiText("已讀取目前影響範圍，原輸入保留；請重新確認。"));
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("無法讀取最新詞庫"));}
    finally{if(active.current)setBusy(false);}
  }
  async function send(){
    if(busy||unavailable||!draft.pending&&(!confirmed||!catalog.data||catalog.error||draft.value.revision!==catalog.data.revision))return;
    let operation=draft.pending;
    try{operation??={key:crypto.randomUUID(),input:input(draft.value)};}catch{setMessage(uiText("請核對名稱、來源與目標詞條。"));return;}
    const pending={...draft,pending:operation};if(!start())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try{
      const result=await adminHttp(viewer,access).requestContract('POST /api/v2/admin/music-entries',{body:operation.input,requestId:operation.key,requestScope:viewer.scope});accepted=true;
      if(!active.current)return;const clean=blank();if(!await persist(clean,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))return;
      setDraft(clean);setConfirmed(false);setMessage((result.command==='merge'?uiText("已合併詞條"):result.command==='delete'?uiText("已刪除詞條"):result.command==='create'?uiText("已建立詞條"):uiText("已保存詞條"))+(result.affectedProfiles?uiText("，更新 ")+result.affectedProfiles+uiText(" 份成分。"):'。'));
      void client.invalidateQueries({queryKey:['music-catalog']});void client.invalidateQueries({queryKey:['catalog']});void client.invalidateQueries({queryKey:['music-trend']});void client.invalidateQueries({queryKey:['private',viewer.scope]});announceAccountChange();
    }catch(error){if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirmed(false);setMessage(errorText(error));void catalog.refetch();if([401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});}
      else setMessage(uiText("尚未確認詞庫操作結果。原稿與操作編號已保留，請確認原操作結果。"));
    }finally{if(active.current)setBusy(false);}
  }
  const value=draft.value,source=catalog.data?.entries.find(e=>e.id===value.id),target=catalog.data?.entries.find(e=>e.id===value.toId),stale=!!catalog.data&&value.revision!==catalog.data.revision;
  return <>
    {message&&<Notice>{message}</Notice>}<DraftFeedback form={record}/>
    {value.command!=='none'&&<Surface className="detail" role="region" aria-label="詞條操作核對"><Heading level={2}>{({create:uiText('建立詞條'),update:uiText('編輯詞條'),delete:uiText('刪除詞條'),merge:uiText('合併詞條')} as const)[value.command]}</Heading>
      {source&&<Text>來源：{source.name} · {source.id} · {source.count} 人選用 · {source.creationCount} 份建立紀錄</Text>}
      {value.command!=='create'&&!source&&<Text role="alert">來源詞條已不存在；待確認操作仍可查回原結果。</Text>}
      {['create','update'].includes(value.command)&&<>
        <Field label="詞條名稱"><input value={value.name} disabled={locked} onChange={event=>edit({name:event.target.value})}/></Field><Text size="sm">{Array.from(musicText(value.name)).length} / 24 字</Text>
        <Field label="詞條類型"><select value={value.kind} disabled={locked} onChange={event=>edit({kind:event.target.value as 'main'|'sub'})}><option value="main">領域</option><option value="sub">細分</option></select></Field>
        <Field label="詞條分類"><select value={value.category} disabled={locked} onChange={event=>edit({category:event.target.value})}>{[...new Set([value.category,...catalog.data?.categories??[]])].map(category=><option key={category} value={category}>{categoryLabel(category)}</option>)}</select></Field>
        {source&&!!source.aliases.length&&<Text>保留別名：{source.aliases.join('、')}</Text>}
      </>}
      {value.command==='delete'&&<Text>此操作會移除詞條、所有人的相關選擇及建立紀錄，無法復原。</Text>}
      {value.command==='merge'&&<><Field label="合併目標"><select value={value.toId} disabled={locked} onChange={event=>edit({toId:event.target.value})}><option value="">選擇目標詞條</option>{catalog.data?.entries.filter(e=>e.id!==value.id).map(e=><option key={e.id} value={e.id}>{e.name} · {e.id}</option>)}</select></Field>
        {target&&<Text>目標：{target.name} · {target.count} 人選用 · {target.creationCount} 份建立紀錄</Text>}
        <Text>來源詞條將移除，名稱與別名加入目標。選擇與建立紀錄轉移並去重；重複選擇保留先出現的熟悉度及順序。目標的編輯權不變。</Text></>}
      {stale&&!draft.pending&&<Text role="alert">詞庫或會員資料已更新，請重新核對影響範圍。</Text>}
      <label className="consent"><input type="checkbox" checked={confirmed} disabled={locked||stale||!!catalog.error} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核對詞條及影響範圍</span></label>
      <div className="page-actions"><Button loading={busy} disabled={busy||unavailable||!draft.pending&&(!confirmed||stale||!!catalog.error||value.command==='merge'&&!target||value.command!=='create'&&!source)} onClick={()=>void send()}>{draft.pending?'確認原操作結果':'確認詞條變更'}</Button>
      <Button variant="secondary" disabled={locked} onClick={()=>void rebase()}>核對最新版，保留輸入</Button>
      <Button variant="secondary" disabled={locked} onClick={()=>{record.change(blank());setConfirmed(false);setMessage('');}}>放棄原稿</Button></div>
    </Surface>}
    {catalog.isPending||!catalog.isFetchedAfterMount?<Notice>正在讀取管理詞庫…</Notice>:catalog.error?<Failure error={catalog.error} retry={()=>void catalog.refetch()}/>:<>
      <Button disabled={locked||dirty} onClick={()=>begin('create')}>建立詞條</Button><MusicSearch filters={searchFilters} categories={catalog.data.categories} label="搜尋管理詞條"/>
      <section aria-label="管理詞庫清單"><Heading level={2}>詞條 · {filters.filtered.length}</Heading>
        {!visible.length?<Notice>{page>1?'這一頁沒有詞條，請返回上一頁。':'沒有符合的詞條。'}</Notice>:<ul className="account-list">{visible.map(entry=><li key={entry.id}><div><Heading level={3}>{entry.name}</Heading><Text>{entry.kind==='main'?'領域':'細分'} · {categoryLabel(entry.category)} · {entry.count} 人選用 · {entry.creationCount} 份建立紀錄</Text>{!!entry.aliases.length&&<Text>別名：{entry.aliases.join('、')}</Text>}<Text size="sm">{entry.id}{entry.creatorName?' · 建立者：'+entry.creatorName:''}</Text></div><div className="page-actions">{(['update','delete','merge'] as const).map(command=>{const action=command==='update'?uiText('編輯'):command==='delete'?uiText('刪除'):uiText('合併');return <Button key={command} aria-label={action+' '+entry.name} variant="secondary" disabled={locked||dirty} onClick={()=>begin(command,entry)}>{action}</Button>;})}</div></li>)}</ul>}
        {(filters.filtered.length>20||page>1)&&<nav className="page-actions" aria-label="管理詞庫分頁"><Button variant="secondary" disabled={page<=1} onClick={()=>filters.update('page',String(page-1))}>上一頁</Button><Text>第 {page} 頁 · 共 {Math.max(1,Math.ceil(filters.filtered.length/20))} 頁</Text><Button variant="secondary" disabled={page*20>=filters.filtered.length} onClick={()=>filters.update('page',String(page+1))}>下一頁</Button></nav>}
      </section>
    </>}
  </>;
}
