import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { AccountHistory, DeviceLinkView, DeviceList, IssuedDeviceLink, Ok, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders, loginLink } from './auth';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';

const pendingLinkKey = 'qgroup:rebuild:device-link';
const validToken = (value: string | null) => !!value && /^[A-Za-z0-9_-]{32}$/.test(value);
function displayTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-TW', { hour12: false }) : '時間未記錄';
}
const actionLabels: Record<string, string> = {
  qq_login: 'QQ 登入', qq_bound: '綁定 QQ', name_registered: '建立帳號', account_switched: '切換帳號',
  device_link_issued: '產生裝置連結', device_link_accepted: '接受裝置授權', device_revoked: '撤銷裝置授權', device_links_revoked: '撤銷未使用連結',
};
export function Devices() {
  const session = useQuery(sessionQuery);
  return <><PageIntro title="裝置與帳號紀錄" /><Link className="back" to="/me/accounts">回到帳號</Link>{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : !session.data.authenticated ? <Link to={loginLink('/me/devices')}>登入後管理裝置</Link> : <DeviceManager key={session.data.scope} viewer={session.data} />}</>;
}
function DeviceManager({ viewer }: { viewer: Extract<Viewer, { authenticated: true }> }) {
  const queryClient = useQueryClient();
  const [authorize, setAuthorize] = useState(false);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const devices = useQuery({ queryKey: ['private', viewer.scope, 'devices'], queryFn: () => api('/me/devices', DeviceList, { headers: { 'X-Account-Scope': viewer.scope } }) });
  const history = useInfiniteQuery({ queryKey: ['private', viewer.scope, 'account-history'], initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api('/me/account-history' + (pageParam ? '?before=' + pageParam : ''), AccountHistory, { headers: { 'X-Account-Scope': viewer.scope } }),
    getNextPageParam: page => page.nextCursor ?? undefined });
  async function refresh() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'devices'] }), queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'account-history'] })]);
  }
  async function issue() {
    setBusy(true); setMessage(''); setIssued(null);
    try {
      const result = await api('/me/devices/link', IssuedDeviceLink, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ confirm: true, authorizeOwnDevice: authorize }) });
      setIssued(result); setAuthorize(false); await refresh();
    } catch (error) { setMessage(error instanceof ApiError && error.status < 500 ? error.message : '尚未確認產生結果。可先撤銷未使用連結，再重新產生。'); }
    finally { setBusy(false); }
  }
  async function revoke(deviceId?: string) {
    setBusy(true); setMessage('');
    try {
      await api(deviceId ? '/me/devices/revoke' : '/me/devices/revoke-link', Ok, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ confirm: true, ...(deviceId ? { deviceId } : {}) }) });
      setSelected(null); setIssued(null); setMessage(deviceId ? '已撤銷該裝置的此帳號授權；其他帳號保留。' : '已撤銷此帳號的未使用連結。');
      await refresh();
    } catch (error) { setMessage(error instanceof ApiError && error.status < 500 ? error.message : '尚未確認撤銷結果，請重新讀取裝置與紀錄再核對。'); }
    finally { setBusy(false); }
  }
  const link = issued ? location.origin + '/me/devices/accept#token=' + issued.token : '';
  return <>
    <Surface className="detail auth-panel"><Heading level={2}>連接自己的另一台裝置</Heading><Text>「{viewer.nickname}」的連結有效 10 分鐘、僅用一次。持有者可管理此帳號與帳務，只能傳給自己的裝置；產生新連結會撤銷舊連結。</Text>
      <label className="consent"><input type="checkbox" checked={authorize} disabled={busy} onChange={event => setAuthorize(event.target.checked)} />只授權自己的另一台裝置</label>
      <Button disabled={!authorize || busy} onClick={() => void issue()}>產生限時連結</Button>
      {issued && <><label className="device-link-field">裝置連結（可手動複製）<textarea readOnly rows={3} value={link} onFocus={event => event.target.select()} /></label><Text>有效至 {displayTime(issued.expiresAt)}</Text><Button variant="secondary" disabled={busy} onClick={() => { void navigator.clipboard?.writeText(link).then(() => setMessage('已複製裝置連結。'), () => setMessage('無法複製，請選取上方連結手動複製。')); if (!navigator.clipboard) setMessage('無法複製，請選取上方連結手動複製。'); }}>複製裝置連結</Button></>}
      <Button variant="secondary" disabled={busy} onClick={() => void revoke()}>撤銷未使用連結</Button>
    </Surface>
    <Surface className="detail auth-panel"><Heading level={2}>「{viewer.nickname}」已授權的裝置</Heading><Text>只撤銷此帳號；該裝置上的其他帳號保留。目前裝置請到帳號頁登出。</Text>
      {devices.isPending ? <Notice>正在讀取裝置…</Notice> : devices.error ? <Failure error={devices.error} retry={() => void devices.refetch()} /> : <ul className="device-list">{devices.data.devices.map((device, index) => <li key={device.id}>
        <Text>{device.current ? '目前裝置' : `其他裝置 ${index}`}</Text><Text>授權於 {displayTime(device.createdAt)}</Text>
        {!device.current && (selected === device.id ? <div className="device-confirm" role="group" aria-label="確認撤銷裝置"><Text>確認撤銷這台裝置的「{viewer.nickname}」授權？</Text><Button disabled={busy} onClick={() => void revoke(device.id)}>確認撤銷</Button><Button variant="secondary" disabled={busy} onClick={() => setSelected(null)}>保留授權</Button></div> : <Button variant="secondary" disabled={busy} onClick={() => { setSelected(device.id); setMessage(''); }}>撤銷其他裝置 {index}</Button>)}
      </li>)}</ul>}
      <Button variant="secondary" disabled={busy || devices.isFetching || history.isFetching} onClick={() => void refresh()}>重新讀取裝置與紀錄</Button>
    </Surface>
    {message && <Notice>{message}</Notice>}
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
  const session = useQuery(sessionQuery);
  const navigate = useNavigate();
  const [token, setToken] = useState(() => {
    const fragment = new URLSearchParams(location.hash.slice(1)).get('token');
    if (fragment !== null) return validToken(fragment) ? fragment! : '';
    try { const saved = sessionStorage.getItem(pendingLinkKey); return validToken(saved) ? saved! : ''; } catch { return ''; }
  });
  const [storageError, setStorageError] = useState('');
  useEffect(() => {
    const updated = () => {
      const fragment = new URLSearchParams(location.hash.slice(1)).get('token');
      if (fragment === null) return;
      setStorageError(''); setToken(validToken(fragment) ? fragment! : '');
    };
    window.addEventListener('hashchange', updated);
    return () => window.removeEventListener('hashchange', updated);
  }, []);
  useEffect(() => {
    if (!token) { try { sessionStorage.removeItem(pendingLinkKey); } catch { /* No valid token is sent. */ } return; }
    try { sessionStorage.setItem(pendingLinkKey, token); window.history.replaceState(window.history.state, '', location.pathname + location.search); }
    catch { setStorageError('無法暫存裝置連結，請允許本站儲存後重新開啟連結；尚未送出授權。'); }
  }, [token]);
  function cancel() {
    try { sessionStorage.removeItem(pendingLinkKey); } catch { /* No grant is sent on cancel. */ }
    navigate('/me/accounts', { replace: true });
  }
  return <><PageIntro title="接受裝置授權" />{!token ? <Notice>裝置連結不完整，請在原裝置重新產生。</Notice> : storageError ? <Notice>{storageError}</Notice> : session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : <AcceptContent key={session.data.scope + ':' + token} viewer={session.data} token={token} />}
    <Button variant="secondary" onClick={cancel}>取消並返回帳號</Button></>;
}
function AcceptContent({ viewer, token }: { viewer: Viewer; token: string }) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const [viewKey] = useState(() => crypto.randomUUID());
  const view = useQuery({ queryKey: ['private', viewer.scope, 'device-link', viewKey], staleTime: 0, gcTime: 0,
    queryFn: () => api('/device-links/view', DeviceLinkView, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ token }) }) });
  async function accept() {
    setBusy(true); setMessage('');
    try {
      await api('/device-links/accept', Ok, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ token, confirm: true, acceptAccess: accepted }) });
      announceAccountChange();
      await queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'accounts'] });
      await view.refetch();
    } catch (error) { const unknown = !(error instanceof ApiError) || error.status >= 500; setUncertain(unknown); setMessage(unknown ? '尚未確認授權結果，請先核對授權。' : error.message); }
    finally { setBusy(false); }
  }
  return view.isPending ? <Notice>正在讀取裝置連結…</Notice> : view.error ? <Failure error={view.error} retry={() => void view.refetch()} /> : <Surface className="detail auth-panel">
    <Heading level={2}>授權帳號：{view.data.nickname}</Heading><Text>有效至 {displayTime(view.data.expiresAt)}</Text>
    {view.data.status === 'accepted' ? <><Notice>已授權此裝置。原有帳號保持登入，請到帳號頁明確切換。</Notice><Link to="/me/accounts">前往帳號切換</Link></> : view.data.alreadyAuthorized ? <><Notice>此裝置已授權這個帳號，無需再次接受。</Notice><Link to="/me/accounts">前往帳號切換</Link></> : !viewer.authenticated ? <><Text>請先登入此裝置原有帳號，登入後會返回這裡。接受連結不會合併資料或自動切換。</Text><Link to={loginLink('/me/devices/accept')}>登入後確認授權</Link></> : <>
      <Text>目前登入「{viewer.nickname}」。原有帳號、活動與款項分開保留，接受後不會自動切換；持有授權可管理帳號與帳務。</Text>
      <label className="consent"><input type="checkbox" checked={accepted} disabled={busy || uncertain} onChange={event => setAccepted(event.target.checked)} />這是我的帳號，確認授權目前裝置</label>
      <Button disabled={!accepted || busy || uncertain} onClick={() => void accept()}>確認接受授權</Button>
    </>}
    {message && <Text role="alert">{message}</Text>}
    {uncertain && <Button variant="secondary" disabled={view.isFetching} onClick={() => void view.refetch()}>核對授權結果</Button>}
  </Surface>;
}
