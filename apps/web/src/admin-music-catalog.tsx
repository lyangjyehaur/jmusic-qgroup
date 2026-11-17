import { useEffect,useRef,useState } from 'react';
import { Link,useBlocker } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminMusicCatalog,AdminMusicEntryCommand,AdminMusicEntryResult,type Viewer } from '@qgroup/contracts';
import { musicText } from '@qgroup/domain';
import { AdminGate,adminHeaders,type Access } from './admin';
import { api,ApiError } from './api';
import { Failure,Notice,PageIntro } from './shared';
import { Field } from './settlement-controls';
import { MusicSearch,useMusicSearch } from './music-search';
import { categoryLabel } from './music-entries';
import { announceAccountChange } from './account-session';

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
  const [loaded]=useState(()=>{try{const raw=sessionStorage.getItem(storageKey);return{draft:raw?Draft.parse(JSON.parse(raw)):blank(),error:''};}catch{return{draft:blank(),error:'無法讀取詞庫管理原稿，請先保全原稿再繼續。'};}});
  const [draft,setDraft]=useState(loaded.draft),[readError,setReadError]=useState(loaded.error),[storageError,setStorageError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[confirmed,setConfirmed]=useState(false);
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const catalog=useQuery({queryKey:['private',viewer.scope,'admin-catalog',access.scope],queryFn:({signal})=>api('/admin/music-entries',AdminMusicCatalog,{signal,headers:{'X-Account-Scope':viewer.scope}}),refetchOnMount:'always'});
  const filters=useMusicSearch(catalog.data?.entries??[]),dirty=draft.dirty||!!draft.pending,locked=busy||!!readError||!!draft.pending;
  const pageParam=filters.params.get('page')??'1',page=/^[1-9]\d{0,5}$/.test(pageParam)?Number(pageParam):1;
  const visible=filters.filtered.slice((page-1)*20,page*20),searchFilters={...filters,update:(key:string,value:string)=>{filters.update('page','');filters.update(key,value);}};
  const blocker=useBlocker(({nextLocation,currentLocation})=>dirty&&nextLocation.pathname!==currentLocation.pathname);
  useEffect(()=>{if(readError)return;try{sessionStorage.setItem(storageKey,JSON.stringify(draft));setStorageError('');}catch{setStorageError('無法保存詞庫原稿及操作編號，尚未送出。');}},[draft,readError,storageKey]);
  useEffect(()=>{if(!dirty)return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[dirty]);
  useEffect(()=>{if(catalog.error instanceof ApiError&&[401,403].includes(catalog.error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});},[catalog.error,client,viewer.scope]);
  function edit(patch:Partial<Value>){if(locked)return;setDraft({...draft,value:{...draft.value,...patch},dirty:true});setConfirmed(false);setMessage('');}
  function begin(command:Value['command'],entry?:Catalog['entries'][number]){
    if(locked||storageError||dirty)return;
    setDraft({value:{command,id:entry?.id??'',toId:'',revision:catalog.data!.revision,name:entry?.name??'',kind:entry?.kind??'sub',category:entry?.category??'歌手'},dirty:command!=='none'});setConfirmed(false);setMessage('');
  }
  async function rebase(){
    if(locked)return;setBusy(true);
    try{const fresh=await catalog.refetch();if(fresh.error)throw fresh.error;if(!active.current||!fresh.data)return;
      setDraft({...draft,value:{...draft.value,revision:fresh.data.revision},dirty:true});setConfirmed(false);setMessage('已讀取目前影響範圍，原輸入保留；請重新確認。');
    }catch(error){if(active.current)setMessage(error instanceof Error?error.message:'無法讀取最新詞庫');}
    finally{if(active.current)setBusy(false);}
  }
  async function send(){
    if(busy||readError||storageError||!draft.pending&&(!confirmed||!catalog.data||catalog.error||draft.value.revision!==catalog.data.revision))return;
    let operation=draft.pending;
    try{operation??={key:crypto.randomUUID(),input:input(draft.value)};}catch{setMessage('請核對名稱、來源與目標詞條。');return;}
    const pending={...draft,pending:operation};try{sessionStorage.setItem(storageKey,JSON.stringify(pending));}catch{setStorageError('無法保存詞庫原稿及操作編號，尚未送出。');return;}
    setDraft(pending);setBusy(true);setMessage('');
    try{
      const result=await api('/admin/music-entries',AdminMusicEntryResult,{method:'POST',headers:{...adminHeaders(viewer,access),'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});
      if(!active.current)return;const clean=blank();sessionStorage.setItem(storageKey,JSON.stringify(clean));setDraft(clean);setConfirmed(false);
      setMessage((result.command==='merge'?'已合併詞條':result.command==='delete'?'已刪除詞條':result.command==='create'?'已建立詞條':'已保存詞條')+(result.affectedProfiles?'，更新 '+result.affectedProfiles+' 份成分。':'。'));
      void client.invalidateQueries({queryKey:['music-catalog']});void client.invalidateQueries({queryKey:['catalog']});void client.invalidateQueries({queryKey:['music-trend']});void client.invalidateQueries({queryKey:['private',viewer.scope]});announceAccountChange();
    }catch(error){if(!active.current)return;
      if(error instanceof ApiError&&error.status<500&&error.status!==429){setDraft({...draft,pending:undefined});setConfirmed(false);setMessage(error.message);void catalog.refetch();if([401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});}
      else setMessage('尚未確認詞庫操作結果。原稿與操作編號已保留，請確認原操作結果。');
    }finally{if(active.current)setBusy(false);}
  }
  const value=draft.value,source=catalog.data?.entries.find(e=>e.id===value.id),target=catalog.data?.entries.find(e=>e.id===value.toId),stale=!!catalog.data&&value.revision!==catalog.data.revision;
  return <>{blocker.state==='blocked'&&<Surface role="alert"><Text>仍有詞庫管理原稿或待確認操作。</Text><Button onClick={()=>blocker.reset()}>繼續核對</Button><Button variant="secondary" onClick={()=>blocker.proceed()}>保留原稿並離開</Button></Surface>}
    {message&&<Notice>{message}</Notice>}{storageError&&<Text role="alert">{storageError}</Text>}{readError&&<Surface role="alert"><Text>{readError}</Text><Button onClick={()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw!==null)sessionStorage.setItem(storageKey+':recovery:'+Date.now(),raw);setReadError('');}catch{setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。');}}}>保全原稿後繼續</Button></Surface>}
    {value.command!=='none'&&<Surface className="detail" role="region" aria-label="詞條操作核對"><Heading level={2}>{({create:'建立詞條',update:'編輯詞條',delete:'刪除詞條',merge:'合併詞條'} as const)[value.command]}</Heading>
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
      <div className="page-actions"><Button loading={busy} disabled={!!readError||!!storageError||!draft.pending&&(!confirmed||stale||!!catalog.error||value.command==='merge'&&!target||value.command!=='create'&&!source)} onClick={()=>void send()}>{draft.pending?'確認原操作結果':'確認詞條變更'}</Button>
      <Button variant="secondary" disabled={locked} onClick={()=>void rebase()}>核對最新版，保留輸入</Button>
      <Button variant="secondary" disabled={locked} onClick={()=>{setDraft(blank());setConfirmed(false);setMessage('');}}>放棄原稿</Button></div>
    </Surface>}
    {catalog.isPending||!catalog.isFetchedAfterMount?<Notice>正在讀取管理詞庫…</Notice>:catalog.error?<Failure error={catalog.error} retry={()=>void catalog.refetch()}/>:<>
      <Button disabled={locked||dirty||!!storageError} onClick={()=>begin('create')}>建立詞條</Button><MusicSearch filters={searchFilters} categories={catalog.data.categories} label="搜尋管理詞條"/>
      <section aria-label="管理詞庫清單"><Heading level={2}>詞條 · {filters.filtered.length}</Heading>
        {!visible.length?<Notice>{page>1?'這一頁沒有詞條，請返回上一頁。':'沒有符合的詞條。'}</Notice>:<ul className="account-list">{visible.map(entry=><li key={entry.id}><div><Heading level={3}>{entry.name}</Heading><Text>{entry.kind==='main'?'領域':'細分'} · {categoryLabel(entry.category)} · {entry.count} 人選用 · {entry.creationCount} 份建立紀錄</Text>{!!entry.aliases.length&&<Text>別名：{entry.aliases.join('、')}</Text>}<Text size="sm">{entry.id}{entry.creatorName?' · 建立者：'+entry.creatorName:''}</Text></div><div className="page-actions">{(['update','delete','merge'] as const).map(command=>{const action=command==='update'?'編輯':command==='delete'?'刪除':'合併';return <Button key={command} aria-label={action+' '+entry.name} variant="secondary" disabled={locked||dirty||!!storageError} onClick={()=>begin(command,entry)}>{action}</Button>;})}</div></li>)}</ul>}
        {(filters.filtered.length>20||page>1)&&<nav className="page-actions" aria-label="管理詞庫分頁"><Button variant="secondary" disabled={page<=1} onClick={()=>filters.update('page',String(page-1))}>上一頁</Button><Text>第 {page} 頁 · 共 {Math.max(1,Math.ceil(filters.filtered.length/20))} 頁</Text><Button variant="secondary" disabled={page*20>=filters.filtered.length} onClick={()=>filters.update('page',String(page+1))}>下一頁</Button></nav>}
      </section>
    </>}
  </>;
}
