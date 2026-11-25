import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { createWebHttpClient } from './http';
import { authHttp, loginLink } from './auth';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';

import { useDeviceLink } from './device-link-local';
import { deviceSlot,deviceToken } from './device-link-record';
const pendingLinkKey = 'qgroup:rebuild:device-link';
function displayTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-TW', { hour12: false }) : uiText('時間未記錄');
}
const actionLabels: Record<string, string> = {
  qq_login: uiText("QQ 登入"), qq_bound: uiText("綁定 QQ"), name_registered: uiText("建立帳號"), nickname_changed: uiText("修改站內稱呼"), account_switched: uiText("切換帳號"), music_claimed: uiText("找回原成分"),
  device_link_issued: uiText("產生裝置連結"), device_link_accepted: uiText("接受裝置授權"), device_revoked: uiText("撤銷裝置授權"), device_links_revoked: uiText("撤銷未使用連結"),
};
export function Devices() {
  const session = useQuery(sessionQuery);
  return <><PageIntro title="裝置與帳號紀錄" /><Link className="back" to="/me/accounts">回到帳號</Link>{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : !session.data.authenticated ? <Link to={loginLink('/me/devices')}>登入後管理裝置</Link> : <DeviceManager key={session.data.scope} viewer={session.data} />}</>;
}
function DeviceManager({ viewer }: { viewer: Extract<Viewer, { authenticated: true }> }) {
  const queryClient = useQueryClient();
  const [authorize, setAuthorize] = useState(false);
  const record=useDeviceLink(deviceSlot(viewer.scope)),issued=record.value?.token?record.value:null;
  const active=record.active;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const devices = useQuery({ queryKey: ['private', viewer.scope, 'devices'], queryFn: () => createWebHttpClient({ context: () => ({ scope: viewer.scope }) }).requestContract('GET /api/v2/me/devices', {}) });
  const history = useInfiniteQuery({ queryKey: ['private', viewer.scope, 'account-history'], initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => createWebHttpClient({ context: () => ({ scope: viewer.scope }) }).requestContract('GET /api/v2/me/account-history', { query: { before: pageParam ? pageParam : undefined } }),
    getNextPageParam: page => page.nextCursor ?? undefined });
  async function refresh() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'devices'] }), queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'account-history'] })]);
  }
  async function current(){
    const fresh=await queryClient.fetchQuery({...sessionQuery,staleTime:0});
    if(!fresh.authenticated||fresh.scope!==viewer.scope)throw Error('帳號已變更，請重新讀取目前帳號。');
    await record.check();return fresh;
  }
  async function issue() {
    if(!authorize||record.value||!record.begin())return;
    setBusy(true);setMessage('');let sent=false;
    try {
      const capturedAt=Date.now();
      // Reserve issuance before HTTP: another tab cannot generate a competing link.
      await record.save({token:null,capturedAt,expiresAt:capturedAt+600000});
      const fresh=await current();if(!active.current)return;sent=true;
      const result=await authHttp(fresh).requestContract('POST /api/v2/me/devices/link',{body:{confirm:true,authorizeOwnDevice:true}});
      if(!active.current)return;
      await record.save({token:result.token,capturedAt,expiresAt:Math.min(Date.parse(result.expiresAt),capturedAt+600000)});
      setAuthorize(false);await refresh();
    } catch(error) {
      if(active.current)setMessage(sent?uiText("尚未確認產生結果。請先撤銷未使用連結，再重新產生。"):uiText("無法保存或核對裝置操作，尚未產生連結。")+(error instanceof Error?' '+errorText(error):''));
    } finally {record.end();if(active.current)setBusy(false);}
  }
  async function revoke(deviceId?:string) {
    if(!record.begin())return;setBusy(true);setMessage('');
    try {
      const fresh=await current();if(!active.current)return;
      if(deviceId)await authHttp(fresh).requestContract('POST /api/v2/me/devices/revoke',{body:{confirm:true,deviceId}});
      else await authHttp(fresh).requestContract('POST /api/v2/me/devices/revoke-link',{body:{confirm:true}});
      if(!active.current)return;
      await record.save(null);setSelected(null);setAuthorize(false);setMessage(deviceId?uiText("已撤銷該裝置的此帳號授權；其他帳號保留。"):uiText("已撤銷此帳號的未使用連結。"));await refresh();
    } catch(error) {if(active.current)setMessage(error instanceof ApiError&&error.status<500?errorText(error):uiText("尚未確認撤銷結果，請重新讀取裝置與紀錄再核對。"));}
    finally {record.end();if(active.current)setBusy(false);}
  }
  async function copy(){
    if(!issued||busy)return;
    try{await current();if(!active.current)return;if(!navigator.clipboard)throw Error();await navigator.clipboard.writeText(link);if(active.current)setMessage(uiText("已複製裝置連結。"));}
    catch{if(active.current)setMessage(uiText("無法複製，請重新核對有效連結；可選取上方連結手動複製。"));}
  }
  const link = issued ? location.origin + '/me/devices/accept#token=' + issued.token : '';
  return <>
    {record.error&&<Notice>{record.error}<Button variant="secondary" onClick={()=>void record.refresh()}>重新讀取裝置連結</Button>{record.damaged&&<Button variant="secondary" onClick={()=>void record.save(null).catch(()=>setMessage(uiText("無法清除本機連結，請重新讀取。")))}>清除損壞的本機連結</Button>}</Notice>}
    {record.value&&!issued&&<Notice>產生結果尚未確認，請先撤銷未使用連結，再重新產生。</Notice>}
    {record.expired&&<Notice>本機連結已到期，請重新產生。</Notice>}
    <Surface className="detail auth-panel"><Heading level={2}>連接自己的另一台裝置</Heading><Text>「{viewer.nickname}」的連結有效 10 分鐘、僅用一次。持有者可管理此帳號與帳務，只能傳給自己的裝置；產生新連結會撤銷舊連結。</Text>
      <label className="consent"><input type="checkbox" checked={authorize} disabled={busy} onChange={event => setAuthorize(event.target.checked)} />只授權自己的另一台裝置</label>
      <Button disabled={!record.ready||!!record.error||!!record.value||!authorize || busy} onClick={() => void issue()}>產生限時連結</Button>
      {issued && <><label className="device-link-field">裝置連結（可手動複製）<textarea readOnly rows={3} value={link} onFocus={event => event.target.select()} /></label><Text>有效至 {displayTime(new Date(issued.expiresAt).toISOString())}</Text><Button variant="secondary" disabled={busy} onClick={() => void copy()}>複製裝置連結</Button></>}
      <Button variant="secondary" disabled={!record.ready||!!record.error||busy} onClick={() => void revoke()}>撤銷未使用連結</Button>
    </Surface>
    <Surface className="detail auth-panel"><Heading level={2}>「{viewer.nickname}」已授權的裝置</Heading><Text>只撤銷此帳號；該裝置上的其他帳號保留。目前裝置請到帳號頁登出。</Text>
      {devices.isPending ? <Notice>正在讀取裝置…</Notice> : devices.error ? <Failure error={devices.error} retry={() => void devices.refetch()} /> : <ul className="device-list">{devices.data.devices.map((device, index) => <li key={device.id}>
        <Text>{device.current ? '目前裝置' : `${uiText("其他裝置 ")}${index}`}</Text><Text>授權於 {displayTime(device.createdAt)}</Text>
        {!device.current && (selected === device.id ? <div className="device-confirm" role="group" aria-label="確認撤銷裝置"><Text>確認撤銷這台裝置的「{viewer.nickname}」授權？</Text><Button disabled={busy} onClick={() => void revoke(device.id)}>確認撤銷</Button><Button variant="secondary" disabled={busy} onClick={() => setSelected(null)}>保留授權</Button></div> : <Button variant="secondary" disabled={busy} onClick={() => { setSelected(device.id); setMessage(''); }}>撤銷其他裝置 {index}</Button>)}
      </li>)}</ul>}
      <Button variant="secondary" disabled={busy || devices.isFetching || history.isFetching} onClick={() => void refresh()}>重新讀取裝置與紀錄</Button>
    </Surface>
    {message && <Notice><span>{message}</span><Button variant="secondary" disabled={busy} onClick={()=>void record.refresh()}>重新讀取本機連結</Button></Notice>}
    <Surface className="detail auth-panel"><Heading level={2}>帳號紀錄</Heading>{history.isPending ? <Notice>正在讀取紀錄…</Notice> : history.error ? <Failure error={history.error} retry={() => void history.refetch()} /> : <>
      {history.data.pages[0]!.history.length ? <ol className="device-list">{history.data.pages.flatMap(page => page.history).map(row => <li key={row.id}><Text>{actionLabels[row.action] ?? '帳號操作'}</Text><time dateTime={row.createdAt}>{displayTime(row.createdAt)}</time></li>)}</ol> : <Notice>尚無帳號操作紀錄。</Notice>}
      {history.hasNextPage && <Button variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>較早的紀錄</Button>}
    </>}</Surface>
  </>;
}
export function AcceptDevice() {
  const route = useLocation();
  return <DeviceAcceptance key={route.key} />;
}
function DeviceAcceptance() {
  const session=useQuery(sessionQuery),navigate=useNavigate(),record=useDeviceLink(deviceSlot());
  const [fragment,setFragment]=useState(()=>new URLSearchParams(location.hash.slice(1)).get('token'));
  const [legacy,setLegacy]=useState<string|null>(()=>{try{return sessionStorage.getItem(pendingLinkKey);}catch{return null;}});
  const [message,setMessage]=useState(''),[attempt,setAttempt]=useState(0);
  const incoming=fragment!==null?fragment:legacy;
  useEffect(()=>{const changed=()=>{const token=new URLSearchParams(location.hash.slice(1)).get('token');if(token!==null){setFragment(token);setMessage('');}};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  useEffect(()=>{
    if(!record.ready||record.error||incoming===null||record.busy)return;
    if(!deviceToken(incoming)){setMessage(uiText("裝置連結不完整，請在原裝置重新產生。"));return;}
    if(record.value){
      if(record.value.token===incoming){if(fragment!==null){window.history.replaceState(window.history.state,'',location.pathname+location.search);setFragment(null);}if(legacy!==null){try{sessionStorage.removeItem(pendingLinkKey);setLegacy(null);}catch{setMessage(uiText("無法清除舊分頁連結，請檢查儲存設定。"));}}}
      return;
    }
    if(!record.begin())return;const capturedAt=Date.now();
    void record.save({token:incoming,capturedAt,expiresAt:capturedAt+600000}).then(()=>{
      if(!record.active.current)return;
      if(fragment!==null){window.history.replaceState(window.history.state,'',location.pathname+location.search);setFragment(null);}
      if(legacy!==null){sessionStorage.removeItem(pendingLinkKey);setLegacy(null);}
    }).catch(()=>{if(record.active.current)setMessage(uiText("無法暫存裝置連結，請允許本站儲存後重新開啟連結；尚未送出授權。"));}).finally(record.end);
  },[record.ready,record.value,incoming,record.error,attempt]);
  async function cancel(){
    try{await record.save(null);sessionStorage.removeItem(pendingLinkKey);if(record.active.current)navigate('/me/accounts',{replace:true});}
    catch{setMessage(uiText("無法清除本機連結，請重新讀取後重試；尚未授權。"));}
  }
  async function replace(){
    if(!deviceToken(fragment)||!record.begin())return;
    try{const capturedAt=Date.now();await record.save({token:fragment,capturedAt,expiresAt:capturedAt+600000});if(record.active.current){window.history.replaceState(window.history.state,'',location.pathname+location.search);setFragment(null);setMessage('');}}
    catch{setMessage(uiText("無法替換本機連結；原連結仍保留。"));}finally{record.end();}
  }
  const collision=deviceToken(fragment)&&!!record.value&&fragment!==record.value.token;
  return <><PageIntro title="接受裝置授權"/>
    {record.error?<Notice>{record.error}<Button variant="secondary" onClick={()=>void record.refresh()}>重新讀取裝置連結</Button>{record.damaged&&<Button variant="secondary" onClick={()=>void record.save(null).catch(()=>setMessage(uiText("無法清除本機連結，請重試。")))}>清除損壞的本機連結</Button>}</Notice>:!record.ready?<Notice>正在讀取本機裝置連結…</Notice>:collision?<Notice>此裝置已有另一條未到期連結。請明確選擇目前開啟的連結；不會自動授權。<Button disabled={record.busy} onClick={()=>void replace()}>改用目前開啟的連結</Button></Notice>:record.value?.token&&!message?(session.isPending?<Notice>正在確認帳號…</Notice>:session.error?<Failure error={session.error} retry={()=>void session.refetch()}/>:<AcceptContent key={session.data.scope+':'+record.value.token} viewer={session.data} record={record}/>):!message?<Notice>{record.expired?'裝置連結已過期，請在原裝置重新產生。':'裝置連結不完整，請在原裝置重新產生。'}</Notice>:null}
    {message&&<Notice>{message}<Button variant="secondary" onClick={()=>{setMessage('');setAttempt(value=>value+1);void record.refresh();}}>重新讀取裝置連結</Button></Notice>}
    <Button variant="secondary" disabled={!record.ready||record.busy} onClick={()=>void cancel()}>取消並返回帳號</Button></>;
}
function AcceptContent({viewer,record}:{viewer:Viewer;record:ReturnType<typeof useDeviceLink>}) {
  const token=record.value!.token!,queryClient=useQueryClient(),active=useRef(false);
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[message,setMessage]=useState('');
  const [viewKey]=useState(()=>crypto.randomUUID());
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const view=useQuery({queryKey:['private',viewer.scope,'device-link',viewKey],staleTime:0,gcTime:0,
    queryFn:async({signal})=>{await record.check();return authHttp(viewer).requestContract('POST /api/v2/device-links/view',{signal,body:{token}});}});
  useEffect(()=>{if(view.error instanceof ApiError&&[401,403,409].includes(view.error.status))void queryClient.invalidateQueries({queryKey:['session']});},[view.error]);
  useEffect(()=>{
    if(!view.data||!record.value)return;const expiresAt=Math.min(Date.parse(view.data.expiresAt),record.value.expiresAt);
    if(expiresAt>=record.value.expiresAt)return;
    void record.save({...record.value,expiresAt}).catch(()=>{if(active.current)setMessage(uiText("無法保存原連結的期限，請重新讀取後核對；尚未授權。"));});
  },[view.data?.expiresAt]);
  async function accept(){
    if(!accepted||busy||uncertain||!record.begin())return;setBusy(true);setMessage('');let sent=false;
    try{
      await record.check();const current=await queryClient.fetchQuery({...sessionQuery,staleTime:0});
      if(!active.current)return;
      if(!current.authenticated||current.scope!==viewer.scope)throw Error('帳號已變更，請重新核對目前帳號及裝置授權。');
      await record.check();if(!active.current)return;sent=true;
      await authHttp(current).requestContract('POST /api/v2/device-links/accept',{body:{token,confirm:true,acceptAccess:true}});
      if(!active.current)return;announceAccountChange();await queryClient.invalidateQueries({queryKey:['private',viewer.scope,'accounts']});await view.refetch();
    }catch(error){if(active.current){const unknown=sent&&(!(error instanceof ApiError)||error.status>=500);setUncertain(unknown);setAccepted(false);setMessage(unknown?uiText("尚未確認授權結果，請先核對授權。"):error instanceof Error?errorText(error):uiText("無法確認授權，請重新讀取。"));}}
    finally{record.end();if(active.current)setBusy(false);}
  }
  return view.isPending?<Notice>正在讀取裝置連結…</Notice>:view.error?<Failure error={view.error} retry={()=>void view.refetch()}/>:<Surface className="detail auth-panel">
    <Heading level={2}>授權帳號：{view.data.nickname}</Heading><Text>有效至 {displayTime(view.data.expiresAt)}</Text>
    {view.data.status==='accepted'?<><Notice>已授權此裝置。原有帳號保持登入，請到帳號頁明確切換。</Notice><Link to="/me/accounts">前往帳號切換</Link></>:view.data.alreadyAuthorized?<><Notice>此裝置已授權這個帳號，無需再次接受。</Notice><Link to="/me/accounts">前往帳號切換</Link></>:!viewer.authenticated?<><Text>請先登入此裝置原有帳號，登入後會返回這裡。接受連結不會合併資料或自動切換。</Text><Link to={loginLink('/me/devices/accept')}>登入後確認授權</Link></>:<>
    <Text>目前登入「{viewer.nickname}」。原有帳號、活動與款項分開保留，接受後不會自動切換；持有授權可管理帳號與帳務。</Text>
    <label className="consent"><input type="checkbox" checked={accepted} disabled={busy||uncertain||!!message} onChange={event=>setAccepted(event.target.checked)}/>這是我的帳號，確認授權目前裝置</label>
    <Button disabled={!accepted||busy||uncertain||!!message} onClick={()=>void accept()}>確認接受授權</Button></>}
    {message&&<Text role="alert">{message}</Text>}
    {(uncertain||message)&&<Button variant="secondary" disabled={busy||view.isFetching} onClick={()=>{void view.refetch().then(result=>{if(result.isSuccess&&active.current){setMessage('');setUncertain(false);setAccepted(false);}});}}>核對授權結果</Button>}
  </Surface>;
}
