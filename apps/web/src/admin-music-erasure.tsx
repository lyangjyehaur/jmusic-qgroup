import { useEffect,useRef,useState } from 'react';
import { Link,useBlocker,useParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminMusicErasureInput,AdminMusicErasurePreview,AdminMusicErasureResult,type Viewer } from '@qgroup/contracts';
import { AdminGate,adminHeaders,type Access } from './admin';
import { api,ApiError } from './api';
import { Failure,Notice,PageIntro } from './shared';
import { announceAccountChange } from './account-session';

const Pending=z.object({path:z.string(),input:AdminMusicErasureInput}).strict();
export function AdminMusicErasurePage({reset=false}:{reset?:boolean}){
  const {id=''}=useParams(),path=reset?'/admin/music-reset':'/admin/music/'+encodeURIComponent(id)+'/erase';
  return <><PageIntro title={reset?'重置全部成分與詞庫':'刪除成分'}/><div className="page-actions"><Link to="/admin">管理後台</Link><Link to="/admin/music">成分關聯</Link></div><AdminGate>{(viewer,access)=><Manager key={viewer.scope+':'+access.scope+':'+path} viewer={viewer} access={access} path={path} reset={reset}/>}</AdminGate></>;
}
function Manager({viewer,access,path,reset}:{viewer:Viewer;access:Access;path:string;reset:boolean}){
  const client=useQueryClient(),storageKey='qgroup:rebuild:admin-music-erasure:v1:'+viewer.scope+':'+access.scope+':'+path;
  const [loaded]=useState(()=>{try{const raw=sessionStorage.getItem(storageKey),pending=raw?Pending.parse(JSON.parse(raw)):null;if(pending&&pending.path!==path)throw Error();return{pending,error:''};}catch{return{pending:null,error:'無法讀取刪除操作紀錄，請先保全原稿再繼續。'};}});
  const [pending,setPending]=useState(loaded.pending),[readError,setReadError]=useState(loaded.error),[busy,setBusy]=useState(false),[word,setWord]=useState(''),[consent,setConsent]=useState(false),[message,setMessage]=useState(''),[notFound,setNotFound]=useState(false),[done,setDone]=useState<z.infer<typeof AdminMusicErasureResult>|null>(null);
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const preview=useQuery({queryKey:['private',viewer.scope,'admin-music-erasure',access.scope,path],queryFn:({signal})=>api(path,AdminMusicErasurePreview,{signal,headers:{'X-Account-Scope':viewer.scope}}),enabled:!done,refetchOnMount:'always'});
  const dirty=!!pending||!!word||consent,blocker=useBlocker(({nextLocation,currentLocation})=>dirty&&nextLocation.pathname!==currentLocation.pathname);
  useEffect(()=>{if(!dirty)return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[dirty]);
  useEffect(()=>{if(preview.error instanceof ApiError&&[401,403].includes(preview.error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});setWord('');setConsent(false);},[preview.data?.revision,preview.error,client,viewer.scope]);
  function failed(error:unknown){
    if(!active.current)return;setMessage(error instanceof ApiError?error.message:'尚未確認刪除結果。操作編號已保留，請先查詢結果。');
    if(error instanceof ApiError&&[401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});
  }
  function completed(result:z.infer<typeof AdminMusicErasureResult>){
    if(!active.current)return;
    sessionStorage.removeItem(storageKey);setPending(null);setWord('');setConsent(false);setNotFound(false);setDone(result);setMessage('');
    for(const key of ['music-catalog','catalog','music-trend'])void client.invalidateQueries({queryKey:[key]});
    void client.invalidateQueries({queryKey:['private',viewer.scope]});announceAccountChange();
  }
  async function submit(replay=false){
    if(busy||readError||done||(!replay&&(pending||!preview.data||preview.error||!consent||word!==(reset?'RESET':'DELETE')))||replay&&(!pending||!notFound))return;
    const input=pending?.input??{revision:preview.data!.revision,requestId:crypto.randomUUID(),secret:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),confirm:reset?'RESET' as const:'DELETE' as const};
    const operation={path,input};try{sessionStorage.setItem(storageKey,JSON.stringify(operation));}catch{setMessage('無法保存刪除操作編號及回執憑證，尚未送出。');return;}
    setPending(operation);setBusy(true);setMessage('');setNotFound(false);
    try{completed(await api(path,AdminMusicErasureResult,{method:'POST',headers:adminHeaders(viewer,access),body:JSON.stringify(input)}));}
    catch(error){if(active.current&&error instanceof ApiError&&error.status<500&&error.status!==429){
      // A durable intent can only fail with 5xx. Definitive rejections never erase the draft silently.
      try{sessionStorage.removeItem(storageKey);setPending(null);}catch{/* Keep proof until browser storage is available. */}
      setWord('');setConsent(false);void preview.refetch();
    }failed(error);}finally{if(active.current)setBusy(false);}
  }
  async function check(){
    if(!pending||busy||readError)return;setBusy(true);setMessage('');setNotFound(false);
    try{completed(await api('/admin/music-erasure/receipt',AdminMusicErasureResult,{method:'POST',headers:adminHeaders(viewer,access),body:JSON.stringify({requestId:pending.input.requestId,secret:pending.input.secret})}));}
    catch(error){if(active.current&&error instanceof ApiError&&error.status===404){setNotFound(true);setMessage('尚未找到完成紀錄。可稍後再查，或以原操作編號重新提交；資料有變更時會拒絕刪除。');}else failed(error);}finally{if(active.current)setBusy(false);}
  }
  return <>
    {blocker.state==='blocked'&&<Surface role="alert"><Text>仍有刪除確認或待確認操作。離開後可用原操作紀錄查詢結果。</Text><Button onClick={()=>blocker.reset()}>留在此頁</Button><Button variant="secondary" onClick={()=>blocker.proceed()}>保留操作紀錄並離開</Button></Surface>}
    {readError&&<Surface role="alert"><Text>{readError}</Text><Button onClick={()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw!==null)sessionStorage.setItem(storageKey+':recovery:'+Date.now(),raw);sessionStorage.removeItem(storageKey);setReadError('');}catch{setMessage('仍無法保全操作紀錄，請檢查瀏覽器儲存設定。');}}}>保全操作紀錄後繼續</Button></Surface>}
    {done?<Surface className="detail" role="status"><Text>{done.command==='reset_music'?'成分與詞庫重置已完成。':'成分已刪除，建立的詞條已轉交管理員。'}</Text><Text>已刪除 {done.profiles} 份成分{done.command==='reset_music'?'、'+done.entries+' 個詞條':''}。</Text><Text>操作編號：{done.requestId}</Text><Link to="/admin/music">返回成分關聯</Link></Surface>:<>
      {pending&&<Surface className="detail" role="region" aria-label="待確認刪除操作"><Text>刪除結果尚未確認；請先查詢原操作，避免重複刪除。</Text><Text>操作編號：{pending.input.requestId}</Text><Button disabled={!!readError} loading={busy} onClick={()=>void check()}>查詢刪除結果</Button>{notFound&&<Button variant="secondary" disabled={!!readError||busy} onClick={()=>void submit(true)}>重新提交原刪除</Button>}</Surface>}
      {preview.isPending||!preview.isFetchedAfterMount?<Notice>正在核對刪除範圍…</Notice>:preview.error?<Failure error={preview.error} retry={()=>void preview.refetch()}/>:<Surface className="detail auth-panel" role="region" aria-label="刪除範圍核對">
        {preview.data.profile&&<><Heading level={2}>{preview.data.profile.name}</Heading><Text>成分 ID：{preview.data.profile.id}</Text><Text>關聯帳號：{preview.data.profile.ownerId??'未關聯'}</Text></>}
        <Text>{preview.data.profiles} 份成分 · {preview.data.selections} 項選擇 · {preview.data.shouts} 則找搭子</Text>
        <Text>{reset?preview.data.entries+' 個詞條將刪除。全部成分的稱呼、私人資料、選擇、找回授權及已關聯找搭子將移除。':'這份成分的私人資料、選擇、找回授權及找搭子將移除；'+preview.data.entries+' 個自建詞條轉交管理員，其他人的選擇保留。'}</Text>
        <Text>不會關閉會員帳號，也不刪除活動、報名、帳務或 bot 工作。{reset?'外觀設定與趨勢歷史保留。':''}刪除紀錄會在恢復備份時重播，無法直接復原。</Text>
        <label className="account-field">輸入 {reset?'RESET':'DELETE'} 確認<input value={word} autoComplete="off" spellCheck={false} disabled={busy||!!pending||!!readError} onChange={event=>{setWord(event.target.value);setConsent(false);}}/></label>
        <label className="consent"><input type="checkbox" checked={consent} disabled={busy||!!pending||!!readError} onChange={event=>setConsent(event.target.checked)}/><span>我已核對刪除範圍及不可復原的影響</span></label>
        <Button disabled={!!pending||!!readError||word!==(reset?'RESET':'DELETE')||!consent||(!preview.data.profiles&&!preview.data.entries)} loading={busy} onClick={()=>void submit()}>{reset?'重置成分與詞庫':'確認刪除成分'}</Button>
        <Button variant="secondary" disabled={busy||!!pending} onClick={()=>{setWord('');setConsent(false);void preview.refetch();}}>重新核對範圍</Button>
      </Surface>}
    </>}
    {message&&<Text role="status">{message}</Text>}
  </>;
}
