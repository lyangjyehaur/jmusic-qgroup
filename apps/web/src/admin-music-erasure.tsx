import { DraftLeaveConfirmation } from './draft-navigation';
import { errorText, uiText } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link,useBlocker,useParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Field, Checkbox } from './kimi-ui';
import { z } from 'zod';
import { AdminMusicErasureInput, AdminMusicErasureResult, type Viewer } from '@qgroup/contracts';
import { AdminGate,adminHttp,adminReadHttp,type Access } from './admin';
import { ApiError } from './api';
import { Failure,Notice,PageIntro,sessionQuery } from './shared';
import { announceAccountChange } from './account-session';

import { AdminErasure,type AdminErasureValue } from './erasure-record';
import { ErasureStorageFeedback,useErasureLocal } from './erasure-local';
const Pending=z.object({path:z.string(),input:AdminMusicErasureInput}).strict();
export function AdminMusicErasurePage({reset=false}:{reset?:boolean}){
  const {id=''}=useParams(),path=reset?'/admin/music-reset':'/admin/music/'+encodeURIComponent(id)+'/erase';
  return <><PageIntro title={reset?'重置全部成分與詞庫':'刪除成分'}/><div className="page-actions"><Link to="/admin">管理後台</Link><Link to="/admin/music">成分關聯</Link></div><AdminGate>{(viewer,access)=><Manager key={viewer.scope+':'+access.scope+':'+path} viewer={viewer} access={access} path={path} id={id} reset={reset}/>}</AdminGate></>;
}
function Manager({viewer,access,path,id,reset}:{viewer:Viewer;access:Access;path:string;id:string;reset:boolean}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:admin-music-erasure:v1:'+viewer.scope+':'+access.scope+':'+path;
  const [legacyKey]=useState(()=>{try{return Object.keys(sessionStorage).find(key=>key.startsWith('qgroup:rebuild:admin-music-erasure:v1:'+viewer.scope+':')&&key.endsWith(':'+path))??storageKey;}catch{return storageKey;}});
  const record=useErasureLocal<AdminErasureValue>('admin:'+viewer.scope+':'+path,legacyKey,raw=>AdminErasure.parse({...Pending.parse(JSON.parse(raw)),kind:'admin',scope:viewer.scope,authority:legacyKey.split(':')[5],result:null}));
  const pending=record.value,busy=record.busy,readError=record.error,done=record.value?.result;
  const [word,setWord]=useState(''),[consent,setConsent]=useState(false),[message,setMessage]=useState(''),[notFound,setNotFound]=useState(false);
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const preview=useQuery({queryKey:['private',viewer.scope,'admin-music-erasure',access.scope,path],queryFn:({signal})=>reset
    ?adminReadHttp(viewer).requestContract('GET /api/v2/admin/music-reset',{signal})
    :adminReadHttp(viewer).requestContract('GET /api/v2/admin/music/:id/erase',{signal,params:{id}}),enabled:!done,refetchOnMount:'always'});
  const dirty=!!pending&&!done||!!word||consent,blocker=useBlocker(({nextLocation,currentLocation})=>dirty&&nextLocation.pathname!==currentLocation.pathname);
  useEffect(()=>{if(!dirty)return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[dirty]);
  useEffect(()=>{if(preview.error instanceof ApiError&&[401,403].includes(preview.error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});setWord('');setConsent(false);},[preview.data?.revision,preview.error,client,viewer.scope]);
  function failed(error:unknown){
    if(!active.current)return;setMessage(error instanceof ApiError?errorText(error):uiText("尚未確認刪除結果。操作編號已保留，請先查詢結果。"));
    if(error instanceof ApiError&&[401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});
  }
  async function completed(result:z.infer<typeof AdminMusicErasureResult>,original:AdminErasureValue){
    if(!active.current)return;
    // Validate the original UUID, command and target before acknowledging any result.
    const next=AdminErasure.parse({...original,result});
    await record.save(next);
    if(!active.current)return;
    setWord('');setConsent(false);setNotFound(false);setMessage('');
    for(const key of ['music-catalog','catalog','music-trend'])void client.invalidateQueries({queryKey:[key]});
    void client.invalidateQueries({queryKey:['private',viewer.scope]});announceAccountChange();
  }
  async function authority(original:AdminErasureValue,replay:boolean){
    const current=await client.fetchQuery({...sessionQuery,staleTime:0});
    if(current.scope!==original.scope)throw Error('請登入原帳號，不會使用目前帳號提交原刪除。');
    const admin=await adminReadHttp(current).requestContract('GET /api/v2/admin/session',{});
    if(replay&&admin.scope!==original.authority)throw Error('原管理授權已變更，只能查詢原回執；不會重新提交刪除。');
    await record.assertCurrent();
    return adminHttp(current,admin);
  }
  async function submit(replay=false){
    if(!record.ready||done||(!replay&&(pending||!preview.data||preview.error||!consent||word!==(reset?'RESET':'DELETE')))||replay&&(!pending||!notFound)||!record.begin())return;
    const input=pending?.input??{revision:preview.data!.revision,requestId:crypto.randomUUID(),secret:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),confirm:reset?'RESET' as const:'DELETE' as const};
    const operation=AdminErasure.parse({kind:'admin',scope:viewer.scope,authority:access.scope,path,input,result:null,...replay?pending:{}});
    setMessage('');setNotFound(false);let sent=false;
    try{
      await record.save(operation);
      const http=await authority(operation,true);if(!active.current)return;
      sent=true;
      const result=reset
        ?await http.requestContract('POST /api/v2/admin/music-reset',{body:operation.input})
        :await http.requestContract('POST /api/v2/admin/music/:id/erase',{params:{id},body:operation.input});
      await completed(result,operation);
    }catch(error){
      if(active.current&&sent&&error instanceof ApiError&&error.status<500&&![401,403,429].includes(error.status)){
        try{await record.save(null);}catch{/* Preserve original proof on transaction failure. */}
        setWord('');setConsent(false);void preview.refetch();
      }
      if(!sent&&active.current)setMessage(uiText("無法保存或核對刪除操作編號及回執憑證，尚未送出。")+(error instanceof Error?' '+errorText(error):''));else failed(error);
    }finally{record.end();}
  }
  async function check(){
    if(!pending||!record.begin())return;setMessage('');setNotFound(false);
    try{
      const http=await authority(pending,false);if(!active.current)return;
      await completed(await http.requestContract('POST /api/v2/admin/music-erasure/receipt',{body:{requestId:pending.input.requestId,secret:pending.input.secret}}),pending);
    }catch(error){if(active.current&&error instanceof ApiError&&error.status===404){setNotFound(true);setMessage(uiText("尚未找到完成紀錄。可稍後再查，或以原操作編號重新提交；資料有變更時會拒絕刪除。"));}else if(active.current){failed(error);if(error instanceof z.ZodError)setMessage(uiText("刪除回執不符原操作；原紀錄仍保留，請重新查詢。"));else if(error instanceof Error&&!(error instanceof ApiError))setMessage(errorText(error));}}finally{record.end();}
  }
  async function dismiss(){
    if(!record.begin())return;
    try{await record.save(null);setWord('');setConsent(false);setMessage('');void preview.refetch();}
    catch{setMessage(uiText("無法清除操作紀錄，原回執仍保留。"));}finally{record.end();}
  }
  return <>
    <DraftLeaveConfirmation form={{blocker,busy,loading:!record.ready,hasPending:!!pending&&!done,canDiscard:!pending||!!done,leave:async()=>{blocker.proceed?.();},discardAndLeave:async()=>{setWord('');setConsent(false);blocker.proceed?.();}}}/>
    <ErasureStorageFeedback record={record}/>
    {!record.ready&&<Notice>正在讀取刪除紀錄…</Notice>}
    {done?<Surface className="detail" role="status"><Text>{done.command==='reset_music'?'成分與詞庫重置已完成。':'成分已刪除，自建詞條保留並移除原建立者資訊。'}</Text><Text>{done.command==='reset_music'&&!done.profiles&&!done.entries?'找搭子與趨勢歷史已清空。':<>已刪除 {done.profiles} 份成分{done.command==='reset_music'?'、'+done.entries+' 個詞條':''}。</>}</Text><Text>操作編號：{done.requestId}</Text><Button variant="secondary" loading={busy} onClick={()=>void dismiss()}>完成</Button><Link to="/admin/music">返回成分關聯</Link></Surface>:<>
      {pending&&<Surface className="detail" role="region" aria-label="待確認刪除操作"><Text>刪除結果尚未確認；請先查詢原操作，避免重複刪除。</Text><Text>操作編號：{pending.input.requestId}</Text><Button disabled={!!readError} loading={busy} onClick={()=>void check()}>查詢刪除結果</Button>{notFound&&<Button variant="secondary" disabled={!!readError||busy} onClick={()=>void submit(true)}>重新提交原刪除</Button>}</Surface>}
      {preview.isPending||!preview.isFetchedAfterMount?<Notice>正在核對刪除範圍…</Notice>:preview.error?<Failure error={preview.error} retry={()=>void preview.refetch()}/>:<Surface className="detail auth-panel" role="region" aria-label="刪除範圍核對">
        {preview.data.profile&&<><Heading level={2}>{preview.data.profile.name}</Heading><Text>成分 ID：{preview.data.profile.id}</Text><Text>關聯帳號：{preview.data.profile.ownerId??'未關聯'}</Text></>}
        <Text>{preview.data.profiles} 份成分 · {preview.data.selections} 項選擇 · {preview.data.shouts} 則找搭子</Text>
        {reset&&preview.data.historyRecords>0&&<Text>留言與趨勢相關紀錄：{preview.data.historyRecords} 筆</Text>}
        <Text>{reset?preview.data.entries+' 個詞條將刪除。全部成分的稱呼、私人資料、選擇、找回授權及已關聯找搭子將移除。':'這份成分的私人資料、選擇、找回授權及找搭子將移除；'+preview.data.entries+' 個自建詞條保留並移除原建立者資訊，其他人的選擇保留。'}</Text>
        <Text>不會關閉會員帳號，也不刪除活動、報名、帳務或 bot 工作。{reset?'找搭子與趨勢歷史同時清空，外觀設定保留。':''}刪除紀錄會在恢復備份時重播，無法直接復原。</Text>
        <Field className="account-field" label={<>輸入 {reset?'RESET':'DELETE'} 確認</>}><input value={word} autoComplete="off" spellCheck={false} disabled={!record.ready||busy||!!pending||!!readError} onChange={event=>{setWord(event.target.value);setConsent(false);}}/></Field>
        <Checkbox className="consent" checked={consent} disabled={!record.ready||busy||!!pending||!!readError} onChange={event=>setConsent(event.target.checked)} label={<><span>我已核對刪除範圍及不可復原的影響</span></>} />
        {reset&&!preview.data.profiles&&!preview.data.entries&&!preview.data.shouts&&!preview.data.historyRecords&&<Notice>目前沒有可重置的成分、詞條、找搭子或歷史紀錄。</Notice>}
        <Button disabled={!record.ready||!!pending||!!readError||word!==(reset?'RESET':'DELETE')||!consent||(!preview.data.profiles&&!preview.data.entries&&!preview.data.shouts&&!preview.data.historyRecords)} loading={busy} onClick={()=>void submit()}>{reset?'重置成分與詞庫':'確認刪除成分'}</Button>
        <Button variant="secondary" disabled={busy||!!pending} onClick={()=>{setWord('');setConsent(false);void preview.refetch();}}>重新核對範圍</Button>
      </Surface>}
    </>}
    {message&&<><Text role="status">{message}</Text><Button variant="secondary" disabled={busy} onClick={()=>void record.refresh()}>重新讀取原操作</Button></>}
  </>;
}
