import { errorText, uiText, displayLocale } from './language';
import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { z } from 'zod';
import { MusicClaimStatus, StartMusicClaim, type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { authHttp } from './auth';
import { scopedHttp } from './http';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { MusicRecoveryRecord as Draft } from './music-recovery-record';
import { useDurableValue } from './durable-record';
import { DraftFeedback } from './draft-feedback';
export function MusicRecovery() {
  const session = useSession();
  return <><PageIntro title="找回舊成分" /><Link className="back" to="/me/music">回到我的成分</Link>{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : <Recovery key={session.data.scope} viewer={session.data} />}</>;
}
function Recovery({ viewer }: { viewer: Viewer }) {
  const client = useQueryClient(); const key = 'qgroup:rebuild:music:claim:v1:' + viewer.scope;
  const [legacyInvalid]=useState<string|null>(()=>{try{const raw=sessionStorage.getItem(key);return raw!==null&&!Draft.nullable().safeParse(JSON.parse(raw)).success?raw:null;}catch{try{return sessionStorage.getItem(key);}catch{return null;}}});
  const record=useDurableValue<z.infer<typeof Draft>|null>({key,scope:viewer.scope,seed:()=>null,parse:raw=>Draft.nullable().parse(JSON.parse(raw)),dirty:value=>!!value,pending:value=>!!value});
  const {value:pending,replace:setPending,busy,setBusy,active,persist,begin}=record;
  const [downloaded,setDownloaded]=useState(false),damaged=legacyInvalid??record.damagedRaw;
  const readError=record.readError||legacyInvalid!==null?uiText('無法讀取找回操作紀錄。'):'',blocked=record.unavailable||legacyInvalid!==null;
  const [legacyQQ,setQQ]=useState(''),[pin,setPin]=useState(''),[consent,setConsent]=useState(false),[privacy,setPrivacy]=useState(false),[confirm,setConfirm]=useState(false);
  const [uncertain,setUncertain]=useState(false),[message,setMessage]=useState(''),[denied,setDenied]=useState(false);
  const cancel=useRef(new AbortController());useEffect(()=>{cancel.current=new AbortController();return()=>cancel.current.abort();},[]);
  useEffect(()=>{setQQ(pending?.legacyQQ??'');setPin('');setConsent(false);setPrivacy(false);setConfirm(false);setUncertain(!!pending);setMessage('');},[record.epoch]);
  useEffect(()=>{setDownloaded(false);},[damaged]);
  useEffect(()=>{if(record.expired){setPin('');setConsent(false);setConfirm(false);}},[record.expired]);
  const queryKey=['private',viewer.scope,'music-claim',pending?.requestId??'current'];
  const claim=useQuery({queryKey,enabled:!blocked,queryFn:async({signal})=>{const result=await scopedHttp(viewer.scope).requestContract('GET /api/v2/music/claim',{query:{requestId:pending?.requestId},signal});if(pending)check(result,pending);return result;},refetchOnWindowFocus:'always'});
  const status=claim.data;
  useEffect(()=>{if(status&&status.status!=='none'&&!pending?.action)setUncertain(false);},[claim.dataUpdatedAt]);
  function check(result:z.infer<typeof MusicClaimStatus>,operation:z.infer<typeof Draft>){if(result.status!=='none'&&(result.claimId!==operation.requestId||result.legacyQQ&&result.legacyQQ!==operation.legacyQQ))throw Error('找回回執與原操作不符，請保留紀錄後核對。');}
  function failed(error:unknown){if(error instanceof ApiError&&(error.status===401||error.code==='ACCOUNT_CHANGED')){setDenied(true);void client.invalidateQueries({queryKey:['session']});}}
  function update(result:z.infer<typeof MusicClaimStatus>,id?:string){client.setQueryData(['private',viewer.scope,'music-claim',id??'current'],result);}
  async function complete(result:z.infer<typeof MusicClaimStatus>){
    if(!active.current||!await persist(null,false,uiText("結果已確認，但無法保存本機確認狀態；原找回操作仍保留。"))||!active.current)return false;
    update(result);setPending(null);setConfirm(false);setUncertain(false);setPin('');
    if(result.status==='completed'){announceAccountChange();void client.invalidateQueries({queryKey:['session']});void client.invalidateQueries({queryKey:['private',viewer.scope,'music']});}
    return true;
  }
  async function refresh(){
    if(blocked||denied||!begin())return;setPin('');setConfirm(false);setMessage('');
    try{
      if(!await persist(pending)||!active.current)return;
      const result=await scopedHttp(viewer.scope).requestContract('GET /api/v2/music/claim',{query:{requestId:pending?.requestId},signal:cancel.current.signal});
      if(!active.current)return;if(pending)check(result,pending);update(result,pending?.requestId);
      if(pending&&(result.status==='completed'||pending.action==='cancel'&&result.status==='none')){if(await complete(result))setMessage(result.status==='completed'?uiText("已關聯原成分。"):uiText("已取消找回，原成分與目前帳號均保留。"));}
      else{setUncertain(false);setMessage(uiText("已重新核對找回狀態；尚未建立關聯時可輸入原口令安全重試。"));}
    }catch(error){if(active.current){failed(error);setUncertain(true);setMessage(error instanceof Error?errorText(error):uiText("無法確認結果"));}}finally{if(active.current)setBusy(false);}
  }
  async function start(){
    if(blocked||denied||uncertain||pending?.action||status?.status!=='none')return;
    const operation=pending??{requestId:crypto.randomUUID(),legacyQQ:legacyQQ.trim()};
    const parsed=StartMusicClaim.safeParse({...operation,legacyQQ:operation.legacyQQ,pin,consent});
    if(!parsed.success){setMessage(uiText("請輸入舊 QQ 與原來的 4–6 位數字口令，並確認資料用途。"));return;}
    if(!begin())return;setMessage('');let accepted=false;
    try{
      if(!await persist(operation,false,uiText("無法保存找回操作編號，尚未送出口令。"))||!active.current)return;
      setPending(operation);
      const result=await authHttp(viewer).requestContract('POST /api/v2/music/claim/start',{body:parsed.data,signal:cancel.current.signal});accepted=true;
      if(!active.current)return;check(result,operation);if(result.status==='none')throw Error('missing claim');update(result,operation.requestId);setPin('');setConsent(false);setUncertain(false);
    }catch(error){if(!active.current)return;setPin('');setConsent(false);failed(error);
      if(!accepted&&error instanceof ApiError&&error.status<500&&![401,429].includes(error.status)&&error.code!=='ACCOUNT_CHANGED'){
        if(await persist(null,false,uiText("無法保存拒絕結果；原找回操作仍保留，請重新核對。"))&&active.current)setPending(null);setMessage(errorText(error));
      }else{setUncertain(true);setMessage(uiText("尚未確認口令驗證結果。口令未保存，請先核對找回狀態。"));}
    }finally{if(active.current)setBusy(false);}
  }
  async function authorize(){
    if(blocked||denied||uncertain||pending?.action||!status||status.status!=='pending'||!begin())return;setMessage('');
    const operation={requestId:status.claimId,legacyQQ:status.legacyQQ};
    try{
      if(pending)check(status,pending);
      if(!await persist(operation)||!active.current)return;setPending(operation);
      const result=await authHttp(viewer).requestContract('POST /api/v2/auth/qq/start',{body:{mode:viewer.authenticated?'bind':'login',confirm:true,musicClaimId:operation.requestId,returnTo:'/me/music/recover',acceptPrivacy:privacy,privacyVersion:viewer.privacyVersion},signal:cancel.current.signal});
      if(active.current)window.location.assign(result.authorizeUrl);
    }catch(error){if(active.current){failed(error);setMessage(error instanceof Error?errorText(error):uiText("無法開始 QQ 授權"));}}finally{if(active.current)setBusy(false);}
  }
  async function act(action:'finish'|'cancel'){
    if(blocked||denied||uncertain||!status||status.status==='none'||pending?.action&&pending.action!==action||!begin())return;setMessage('');
    const operation=pending?.action?pending:{requestId:status.claimId,legacyQQ:status.legacyQQ,action};
    try{
      if(pending)check(status,pending);
      if(!await persist(operation)||!active.current)return;setPending(operation);setConfirm(false);
      const result=await authHttp(viewer).requestContract(action==='finish'?'POST /api/v2/music/claim/finish':'POST /api/v2/music/claim/cancel',{body:{claimId:operation.requestId,confirm:true},signal:cancel.current.signal});
      if(!active.current)return;check(result,operation);
      if(action==='finish'&&result.status!=='completed'||action==='cancel'&&result.status!=='none'&&result.status!=='completed')throw Error('unexpected claim result');
      if(await complete(result))setMessage(result.status==='completed'?uiText("已關聯原成分。"):uiText("已取消找回，原成分與目前帳號均保留。"));
    }catch(error){if(active.current){failed(error);setUncertain(true);setMessage(error instanceof ApiError&&error.status<500&&error.status!==429?errorText(error):uiText("尚未確認操作結果，請先核對找回狀態。"));}}finally{if(active.current)setBusy(false);}
  }
  if(denied)return <Notice>目前帳號已變更。<Button onClick={()=>window.location.reload()}>重新確認帳號</Button></Notice>;
  return <><DraftFeedback form={damaged!==null&&!record.conflict&&!record.expired?{...record,readError:''}:record} navigation={false}/>{damaged!==null&&<Surface role="alert"><Text>找回操作紀錄格式無法辨識。請先下載保全檔，再清除紀錄；原文不會複製到保全版本。</Text><Button disabled={busy||record.loading||record.expired} onClick={()=>{const url=URL.createObjectURL(new Blob([damaged],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='qgroup-claim-operation-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setDownloaded(true);}}>下載舊操作紀錄</Button><Button disabled={!downloaded||busy||record.loading||record.conflict||record.expired} onClick={()=>void(async()=>{if(busy||record.loading||record.conflict||record.expired)return;setBusy(true);try{if(legacyInvalid!==null){if(sessionStorage.getItem(key)!==legacyInvalid)throw Error('原紀錄已有變更，請重新載入核對。');sessionStorage.removeItem(key);}else if(!await persist(null))return;window.location.reload();}catch(error){setMessage(error instanceof Error?errorText(error):uiText("無法清除紀錄"));}finally{if(active.current)setBusy(false);}})()}>清除已下載的舊紀錄</Button></Surface>}{blocked?null:claim.isPending ? <Notice>正在讀取找回狀態…</Notice> : claim.error ? <Failure error={claim.error} retry={() => void refresh()} /> : <Surface className="detail auth-panel">
    {status?.status === 'none' && pending?.action ? <Notice>原找回請求已不存在，請先核對我的成分。<Button disabled={busy||uncertain} onClick={()=>void(async()=>{if(!begin())return;try{if(await complete({status:'none'}))setMessage(uiText("已結束原操作核對；可重新找回。"));}finally{if(active.current)setBusy(false);}})()}>結束失效的原操作</Button></Notice> : status?.status === 'none' ? <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <Text>PIN 只用於找回舊成分；關聯須完成本次 QQ 授權，不會覆蓋目前帳號已有的成分。</Text>
      <label className="account-field">舊 QQ<input inputMode="numeric" autoComplete="off" value={legacyQQ} maxLength={12} disabled={busy || uncertain || !!readError || !!pending} onChange={event => setQQ(event.target.value)} /></label>
      <label className="account-field">原口令<input type="password" inputMode="numeric" autoComplete="off" value={pin} maxLength={6} disabled={busy || uncertain || !!readError || !!pending?.action} onChange={event => setPin(event.target.value)} /></label>
      <Text>4–6 位數字。口令不保存在瀏覽器；忘記口令請聯絡管理員。</Text>
      <label className="consent"><input type="checkbox" checked={consent} disabled={busy || uncertain || !!readError || !!pending?.action} onChange={event => setConsent(event.target.checked)} /><span>確認以舊資料驗證取回權利，並將原成分關聯至完成 QQ 授權的帳號</span></label>
      <Button type="submit" loading={busy} disabled={busy || !consent || uncertain || !!readError || !!pending?.action || !/^[0-9]{4,12}$/.test(legacyQQ.trim()) || !/^[0-9]{4,6}$/.test(pin.trim())}>驗證原口令</Button>
    </form> : status && <>
      <Heading level={2}>{status.name || '原成分'}</Heading><Text>舊 QQ：{status.legacyQQ}</Text><Text>固定成分 ID：{status.profileId}</Text>
      {status.status === 'completed' ? <><Notice>已關聯原成分。</Notice><Link to="/me/music">編輯原成分</Link></> : status.status === 'unavailable' ? <Notice>找回已過期、成分已變更或已有關聯。取消後可重新找回；如有衝突請聯絡管理員。</Notice> : <>
        <Text>有效至 {new Date(status.expiresAt).toLocaleString(displayLocale())}。</Text>
        {status.status === 'pending' ? <>
          <Text>{viewer.authenticated ? `${uiText("接著授權目前帳號「")}${viewer.nickname}${uiText("」的 QQ，不切換或合併帳號。")}` : '接著授權 QQ，確認登入帳號後再核對成分關聯。'}</Text>
          {!viewer.privacyAccepted && <label className="consent"><input type="checkbox" checked={privacy} onChange={event => setPrivacy(event.target.checked)} /><span>我已閱讀並同意<Link to="/privacy" target="_blank" rel="noreferrer">隱私政策</Link></span></label>}
          <Button loading={busy} disabled={busy || !!pending?.action || !viewer.qqEnabled || (!viewer.privacyAccepted && !privacy) || uncertain || !!readError} onClick={() => void authorize()}>前往 QQ 授權找回</Button>{!viewer.qqEnabled && <Notice>QQ 登入尚未配置，請聯絡管理員。</Notice>}
        </> : <>
          <Text>將原成分關聯至帳號「{status.targetNickname}」。原選擇、稱呼及聯絡資料會保留；報名與款項不合併。</Text>
          <label className="consent"><input type="checkbox" checked={confirm} disabled={busy || uncertain || !!readError || !!pending?.action} onChange={event => setConfirm(event.target.checked)} /><span>確認這是我的原成分，關聯至目前帳號</span></label>
          <Button loading={busy} disabled={busy || !confirm || uncertain || !!readError || !!pending?.action} onClick={() => void act('finish')}>確認關聯原成分</Button>
        </>}
      </>}
      {status.status !== 'completed' && !pending?.action && <Button variant="secondary" disabled={busy || uncertain || !!readError || !!pending?.action} onClick={() => void act('cancel')}>取消找回</Button>}
    </>}
    {pending?.action&&!uncertain&&status?.status!=='none'&&<Button disabled={busy||blocked} onClick={()=>void act(pending.action!)}>確認原{pending.action==='finish'?'關聯':'取消'}操作結果</Button>}
    <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>核對找回狀態</Button>

  </Surface>}{message && <Text role="status">{message}</Text>}</>;
}
