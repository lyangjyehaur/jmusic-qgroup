import { errorText, uiText } from './language';
import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { z } from 'zod';
import { Appearance,AppearanceCommand,AppearanceResult,type Viewer } from '@qgroup/contracts';
import { AdminGate,adminHeaders,type Access } from './admin';
import { api,ApiError } from './api';
import { Failure,Notice,PageIntro } from './shared';
import { Field } from './settlement-controls';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
const Value=z.object({command:z.enum(['none','upload','config','toggle','move','delete']),revision:z.string(),id:z.string(),name:z.string(),mime:z.enum(['image/png','image/jpeg','image/webp']),data:z.string().max(2800000),rotateSeconds:z.string(),enabled:z.boolean(),direction:z.union([z.literal(-1),z.literal(1)])}).strict();
type Value=z.infer<typeof Value>;
function input(value:Value){
  const common={command:value.command,revision:value.revision,confirm:true};
  return AppearanceCommand.parse(value.command==='upload'?{...common,name:value.name,mime:value.mime,data:value.data}:value.command==='config'?{...common,rotateSeconds:Number(value.rotateSeconds)}:value.command==='toggle'?{...common,id:value.id,enabled:value.enabled}:value.command==='move'?{...common,id:value.id,direction:value.direction}:{...common,id:value.id});
}
const Draft=z.object({value:Value,dirty:z.boolean(),pending:z.object({key:z.string().uuid(),input:AppearanceCommand}).strict().optional()}).strict().transform(draft=>draft.pending?.input.command==='upload'&&!draft.value.data?{...draft,value:{...draft.value,data:draft.pending.input.data}}:draft).refine(draft=>{if(!draft.pending)return true;try{return JSON.stringify(input(draft.value))===JSON.stringify(draft.pending.input);}catch{return false;}});
type Draft=z.infer<typeof Draft>;
const blank=():Draft=>({value:{command:'none',revision:'',id:'',name:'',mime:'image/png',data:'',rotateSeconds:'24',enabled:true,direction:1},dirty:false});
// Keep one base64 copy, including an uncertain upload.
const serialize=(draft:Draft)=>JSON.stringify(draft.pending?.input.command==='upload'?{...draft,value:{...draft.value,data:''}}:draft);
function WallpaperPreview({url,name}:{url:string;name:string}){const [failed,setFailed]=useState(false);return failed?<Text role="alert">原圖無法顯示，請重新上傳；原始檔仍保留。</Text>:<img className="wallpaper-preview" src={url} alt={'壁紙預覽 '+name} loading="lazy" onError={()=>setFailed(true)}/>;}
export function AdminAppearancePage(){return <><PageIntro title="壁紙管理"/><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer,access)=><Manager key={viewer.scope+':'+access.scope} viewer={viewer} access={access}/>}</AdminGate></>;}
function Manager({viewer,access}:{viewer:Viewer;access:Access}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:admin-appearance:v1:'+viewer.scope+':'+access.scope;
  const [confirmed,setConfirmed]=useState(false),[message,setMessage]=useState('');
  const record=useDurableRecord<Draft>({key:storageKey,scope:viewer.scope,seed:blank,parse:raw=>Draft.parse(JSON.parse(raw)),
    serialize,dirty:value=>value.dirty,pending:value=>!!value.pending,blocking:({currentLocation,nextLocation})=>currentLocation.pathname!==nextLocation.pathname});
  const {value:draft,replace:setDraft,busy,setBusy,active,dirty,locked,unavailable,begin:start,persist}=record;
  useEffect(()=>setConfirmed(false),[record.epoch]);
  const catalog=useQuery({queryKey:['private',viewer.scope,'admin-appearance',access.scope],queryFn:({signal})=>api('/admin/appearance',Appearance,{signal,headers:{'X-Account-Scope':viewer.scope}}),refetchOnMount:'always',refetchOnWindowFocus:'always'});
  const stale=!!catalog.data&&catalog.data.revision!==draft.value.revision;
  useEffect(()=>{if(catalog.error instanceof ApiError&&[401,403].includes(catalog.error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});},[catalog.error,client,viewer.scope]);
  function edit(patch:Partial<Value>){if(locked)return;record.change({...draft,value:{...draft.value,...patch},dirty:true});setConfirmed(false);setMessage('');}
  function begin(command:Value['command'],patch:Partial<Value>={}){if(locked||dirty||!catalog.data||catalog.error)return;record.change({value:{...blank().value,command,revision:catalog.data.revision,rotateSeconds:String(catalog.data.rotateSeconds),...patch},dirty:true});setConfirmed(false);setMessage('');}
  async function choose(file:File){
    if(locked||!start())return;setMessage('');
    try{
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)||!file.size||file.size>2*1024*1024)throw Error('只支援 PNG、JPG、WebP，單張最多 2 MiB。');
      const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      if(active.current){const next={...draft,value:{...draft.value,data:btoa(binary),mime:file.type as Value['mime']},dirty:true};setDraft(next);setConfirmed(false);await persist(next);}
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("無法讀取圖片"));}finally{if(active.current)setBusy(false);}
  }
  async function rebase(){
    if(locked||!start())return;
    try{const fresh=await catalog.refetch();if(fresh.error)throw fresh.error;if(!active.current||!fresh.data)return;
      const next={...draft,value:{...draft.value,revision:fresh.data.revision}};if(!await persist(next))return;setDraft(next);setConfirmed(false);setMessage(uiText("已讀取最新設定，原輸入保留；請重新確認。"));
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("無法讀取設定"));}finally{if(active.current)setBusy(false);}
  }
  async function send(){
    if(busy||unavailable||!draft.pending&&(!confirmed||stale||!catalog.data||catalog.error))return;
    let operation=draft.pending;try{operation??={key:crypto.randomUUID(),input:input(draft.value)};}catch{setMessage(uiText("請選擇圖片並核對設定；輪播間隔必須是 8–600 秒的整數。"));return;}
    const pending={...draft,pending:operation};if(!start())return;if(!await persist(pending)||!active.current){if(active.current)setBusy(false);return;}
    setDraft(pending);setMessage('');let accepted=false;
    try{
      await api('/admin/appearance',AppearanceResult,{method:'POST',headers:{...adminHeaders(viewer,access),'Idempotency-Key':operation.key},body:JSON.stringify(operation.input)});accepted=true;
      if(!active.current)return;const clean=blank();if(!await persist(clean,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))return;
      setDraft(clean);setConfirmed(false);setMessage(uiText("壁紙設定已保存。"));void catalog.refetch();void client.invalidateQueries({queryKey:['appearance']});
      try{const channel=new BroadcastChannel('qgroup:appearance');channel.postMessage('refresh');channel.close();}catch{/* Focus refetch remains available. */}
    }catch(error){if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,pending:undefined};if(await persist(next))setDraft(next);setConfirmed(false);setMessage(errorText(error));void catalog.refetch();if([401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});}
      else setMessage(uiText("尚未確認壁紙操作結果。原圖與操作編號已保留，請確認原操作結果。"));
    }finally{if(active.current)setBusy(false);}
  }
  const value=draft.value,item=catalog.data?.items.find(x=>x.id===value.id),labels={upload:uiText("上傳壁紙"),config:uiText("設定輪播間隔"),toggle:value.enabled?uiText('啟用壁紙'):uiText('停用壁紙'),move:value.direction===-1?uiText('上移壁紙'):uiText('下移壁紙'),delete:uiText("刪除壁紙")};
  return <>
    {message&&<Notice>{message}</Notice>}<DraftFeedback form={record}/>
    {!!record.storageError&&<Button disabled={busy||unavailable} onClick={()=>void persist(draft)}>重試保存原稿</Button>}
    {value.command!=='none'&&<Surface className="detail appearance-form" role="region" aria-label="壁紙操作核對"><Heading level={2}>{labels[value.command]}</Heading>
      <fieldset disabled={locked}>{value.command==='upload'&&<><Field label="壁紙名稱（選填）"><input value={value.name} onChange={event=>edit({name:event.target.value})}/></Field><Field label="壁紙圖片"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void choose(file);}}/></Field><Text>PNG、JPG、WebP，單張最多 2 MiB、4000 萬像素。原圖會公開顯示。</Text>{value.data&&<img className="wallpaper-preview" src={'data:'+value.mime+';base64,'+value.data} alt="待上傳壁紙"/>}</>}
      {value.command==='config'&&<Field label="輪播間隔（秒）"><input type="number" min="8" max="600" step="1" value={value.rotateSeconds} onChange={event=>edit({rotateSeconds:event.target.value})}/></Field>}
      </fieldset>
      {!['upload','config'].includes(value.command)&&<Text>{item?.name??'原壁紙已不存在'}{value.command==='delete'?'；圖片及公開連結會移除，無法復原。':''}</Text>}
      {stale&&!draft.pending&&<Text role="alert">設定已有更新，請核對最新版後重新確認。</Text>}
      <label className="consent"><input type="checkbox" checked={confirmed} disabled={locked||stale||!!catalog.error} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核對壁紙及設定變更</span></label>
      <div className="page-actions"><Button loading={busy} disabled={busy||unavailable||!draft.pending&&(!confirmed||stale||!!catalog.error||value.command==='upload'&&!value.data)} onClick={()=>void send()}>{draft.pending?'確認原操作結果':'確認壁紙變更'}</Button><Button variant="secondary" disabled={locked} onClick={()=>void rebase()}>核對最新版，保留輸入</Button><Button variant="secondary" disabled={locked} onClick={()=>{record.change(blank());setConfirmed(false);setMessage('');}}>放棄原稿</Button></div>
    </Surface>}
    {catalog.isPending||!catalog.isFetchedAfterMount?<Notice>正在讀取壁紙…</Notice>:catalog.error?<Failure error={catalog.error} retry={()=>void catalog.refetch()}/>:<Surface className="detail appearance-form"><Text>輪播間隔：{catalog.data.rotateSeconds} 秒 · {catalog.data.items.filter(x=>x.enabled&&!x.missing).length} 張啟用</Text><div className="page-actions"><Button disabled={locked||dirty} onClick={()=>begin('upload')}>上傳壁紙</Button><Button variant="secondary" disabled={locked||dirty} onClick={()=>begin('config')}>設定輪播間隔</Button></div>
      {!catalog.data.items.length?<Text>尚未上傳壁紙。</Text>:<ul className="wallpaper-list">{catalog.data.items.map((wall,index)=><li key={wall.id}><Heading level={2}>{wall.name}</Heading>{wall.missing?<Text role="alert">原圖遺失，請重新上傳；原清單紀錄仍保留。</Text>:<WallpaperPreview key={wall.id+catalog.data.revision} url={wall.url} name={wall.name}/>}<Text>{wall.enabled?'啟用':'停用'} · {(wall.size/1024).toFixed(1)} KiB</Text><div className="page-actions"><Button variant="secondary" disabled={locked||dirty} onClick={()=>begin('toggle',{id:wall.id,enabled:!wall.enabled})}>{wall.enabled?'停用':'啟用'} {wall.name}</Button><Button variant="secondary" disabled={locked||dirty||index===0} onClick={()=>begin('move',{id:wall.id,direction:-1})}>上移 {wall.name}</Button><Button variant="secondary" disabled={locked||dirty||index===catalog.data.items.length-1} onClick={()=>begin('move',{id:wall.id,direction:1})}>下移 {wall.name}</Button><Button variant="secondary" disabled={locked||dirty} onClick={()=>begin('delete',{id:wall.id})}>刪除 {wall.name}</Button></div></li>)}</ul>}
    </Surface>}
  </>;
}
