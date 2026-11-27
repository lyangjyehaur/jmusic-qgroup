import { errorText, uiText } from './language';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, Tabs, Field, Disclosure, Checkbox } from './kimi-ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Surface, Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { z } from 'zod';
import { AdminSession, type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { createWebHttpClient } from './http';
import { authHeaders, authHttp } from './auth';
import { announceAccountChange, clearDeviceDrafts } from './account-session';
import { clearDurableAdminDrafts } from './draft-store';
import { Failure, Notice, sessionQuery } from './shared';
const AdminMemberDirectory=lazy(()=>import('./admin-users').then(module=>({default:module.Directory})));
export type Access = z.infer<typeof AdminSession>;
export const adminHeaders = (viewer: Viewer, access: Access) => ({ ...authHeaders(viewer), 'X-Admin-CSRF': access.adminCsrf });
export const adminReadHttp = (viewer: Viewer) => createWebHttpClient({ context: () => ({ scope: viewer.scope }) });
export const adminHttp = (viewer: Viewer, access: Access) => createWebHttpClient({ context: () => ({ scope: viewer.scope, csrf: viewer.csrf, adminCsrf: access.adminCsrf }) });
export async function clearAdminDrafts(scope: string) {
  let sessionFailed=false;
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('qgroup:rebuild:admin-') && !key.startsWith('qgroup:rebuild:admin-music-erasure:v1:') && key.includes(':' + scope + ':')) sessionStorage.removeItem(key); }
  catch { sessionFailed=true; }
  await clearDurableAdminDrafts(scope);
  if(sessionFailed)throw Error('無法清除分頁管理原稿');
}
export function AdminGate({ children }: { children: (viewer: Viewer, access: Access) => ReactNode }) {
  const session = useQuery(sessionQuery);
  return session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : <AdminAuthority key={session.data.scope} viewer={session.data}>{children}</AdminAuthority>;
}
function AdminAuthority({ viewer, children }: { viewer: Viewer; children: (viewer: Viewer, access: Access) => ReactNode }) {
  const client = useQueryClient();
  const access = useQuery({ queryKey: ['private', viewer.scope, 'admin-session'], queryFn: () => adminReadHttp(viewer).requestContract('GET /api/v2/admin/session', {}), refetchOnWindowFocus: 'always', refetchInterval: 30000 });
  const denied = access.error instanceof ApiError && [401, 403].includes(access.error.status);
  useEffect(() => { if (denied) { client.removeQueries({ queryKey: ['private', viewer.scope], predicate: query => String(query.queryKey[2]).startsWith('admin-') && query.queryKey[2] !== 'admin-session' }); } }, [denied, client, viewer.scope]);
  return access.isPending ? <Notice>正在確認管理權限…</Notice> : denied ? <RevokedAdmin viewer={viewer} reload={async () => { const result = await access.refetch(); return result.isSuccess || result.error instanceof ApiError && [401, 403].includes(result.error.status); }} /> : access.error ? <Failure error={access.error} retry={() => void access.refetch()} /> : <>{children(viewer, access.data)}</>;
}
function RevokedAdmin({ viewer, reload }: { viewer: Viewer; reload: () => Promise<boolean> }) {
  const [state,setState]=useState<'clearing'|'failed'|'ready'>('clearing');
  async function clear(){setState('clearing');try{await clearAdminDrafts(viewer.scope);setState('ready');}catch{setState('failed');}}
  useEffect(()=>{void clear();},[viewer.scope]);
  if(state==='clearing')return <Notice>正在清除失效的管理原稿…</Notice>;
  if(state==='failed')return <Notice>管理權限已失效，但本機管理原稿清除失敗。請重試清除。<Button onClick={()=>void clear()}>重試清除本機管理原稿</Button></Notice>;
  return <RescueLogin viewer={viewer} reload={reload}/>;
}
function RescueLogin({ viewer, reload }: { viewer: Viewer; reload: () => Promise<boolean> }) {
  const [key, setKey] = useState(''); const [busy, setBusy] = useState(false); const [unknown, setUnknown] = useState(false); const [message, setMessage] = useState('');
  async function login() {
    setBusy(true); setMessage('');
    try { await authHttp(viewer).requestContract('POST /api/v2/admin/login', { body: { key, confirm: true } }); if (!await reload()) { setUnknown(true); setMessage(uiText("尚未確認登入結果，請先重新確認管理狀態。")); } announceAccountChange(); }
    catch (error) { setUnknown(!(error instanceof ApiError) || error.status >= 500); setMessage(error instanceof ApiError ? errorText(error) : uiText("尚未確認登入結果，請先重新確認管理狀態。")); }
    finally { setKey(''); setBusy(false); }
  }
  return <Surface className="detail auth-panel"><Text>目前帳號沒有管理權限。可登入已授權的會員帳號，或使用獨立管理救援憑證。</Text><Link to="/login?returnTo=%2Fadmin">會員登入</Link><form onSubmit={event => { event.preventDefault(); void login(); }}><Field className="account-field" label={<>管理救援憑證</>}><input type="password" autoComplete="off" value={key} disabled={busy || unknown} onChange={event => setKey(event.target.value)} /></Field><Button type="submit" loading={busy} disabled={unknown || Array.from(key).length < 32 || Array.from(key).length > 256}>使用救援憑證登入</Button></form>{message && <Text role="alert">{message}</Text>}<Button variant="secondary" disabled={busy} onClick={() => { setBusy(true); void reload().then(known => { if (known) setUnknown(false); }).finally(() => setBusy(false)); }}>重新確認管理狀態</Button></Surface>;
}
export function AdminHome() {
  const [cleanup, setCleanup] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="kimi page admin-page"><PageHeader title="管理後台" />{cleanup && <Notice>此裝置已登出，但本機原稿清除失敗。請重試清除。
    <Button loading={busy} onClick={() => { setBusy(true); void clearDeviceDrafts().then(() => { setCleanup(false); setError(''); }).catch(() => setError(uiText("仍無法清除本機原稿，請檢查瀏覽器儲存設定。"))).finally(() => setBusy(false)); }}>重試清除本機原稿</Button>
    {error && <Text role="alert">{error}</Text>}
  </Notice>}<AdminGate>{(viewer, access) => <AdminMenu key={access.scope} viewer={viewer} access={access} onCleanupFailure={() => setCleanup(true)} />}</AdminGate></div>;
}
function AdminMenu({ viewer, access, onCleanupFailure }: { viewer: Viewer; access: Access; onCleanupFailure: () => void }) {
  const [params,setParams] = useSearchParams(),tab=params.get('tab')??'members';
  const client = useQueryClient(); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState(false); const [error, setError] = useState('');
  async function checkState() {
    setBusy(true);
    try {
      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      await client.resetQueries({ queryKey: ['private', viewer.scope, 'admin-session'], exact: true });
      setBlocked(false); setConfirmed(false); setError('');
    } catch { setError(uiText("仍無法確認管理狀態，請稍後重新確認。")); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    let accountLoggedOut = false;
    try {
      const result = await adminHttp(viewer, access).requestContract('POST /api/v2/admin/logout', { body: { confirm: true } });
      accountLoggedOut = result.logoutAccount;
      try { if (result.logoutAccount) { try { await clearDeviceDrafts(); } catch (error) { onCleanupFailure(); throw error; } } } finally { announceAccountChange(result.logoutAccount); }
      await client.cancelQueries({ queryKey: ['private'] });
      const next = await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      client.removeQueries({ queryKey: ['private'], predicate: query => query.queryKey[1] !== next.scope || query.queryKey[2] !== 'admin-session' });
      if (next.scope === viewer.scope) await client.resetQueries({ queryKey: ['private', viewer.scope, 'admin-session'], exact: true });
    } catch (failure) { setBlocked(true); setError(accountLoggedOut ? uiText("此裝置已登出，請重新確認管理狀態及本機原稿清除結果。") : failure instanceof ApiError && failure.status < 500 ? errorText(failure) : uiText("尚未確認登出結果，請重新確認管理狀態。")); }
    finally { setBusy(false); }
  }
  return <><Text>管理授權：{access.authMethod==='account'?'會員角色':'救援憑證（1 小時）'}</Text><Tabs label="管理功能" value={tab} onChange={value=>setParams(value==='members'?{}:{tab:value})} items={[{value:'members',label:uiText('成員／權限')},{value:'content',label:uiText('活動與內容')},{value:'privacy',label:uiText('隱私審核')},{value:'backups',label:uiText('備份紀錄')},{value:'bot',label:uiText('QQ bot')}]}/><section className="admin-workspace"><div className="admin-toolbar"><h2>{tab==='members'?'成員與權限':tab==='content'?'活動與內容':tab==='privacy'?'隱私審核':tab==='backups'?'備份與恢復紀錄':'QQ bot'}</h2></div><div className="admin-content-grid">{(tab==='members'?[[uiText('使用者管理'),'/admin/users'],[uiText('註冊設定'),'/admin/registration'],[uiText('成分關聯'),'/admin/music']]:tab==='content'?[[uiText('所有活動'),'/activities'],[uiText('管理投票'),'/time-polls'],[uiText('音樂詞庫管理'),'/admin/music-entries'],[uiText('找搭子管理'),'/admin/shouts'],[uiText('網站外觀'),'/admin/appearance']]:tab==='privacy'?[[uiText('刪除申請'),'/admin/privacy'],[uiText('重置成分與詞庫'),'/admin/music-reset']]:tab==='backups'?[[uiText('成分匯出與歷史備份'),'/admin/backups']]:[[uiText('bot 設定'),'/admin/bot'],[uiText('bot 投遞紀錄'),'/admin/bot/deliveries']]).map(([label,to])=><Link key={to} className="admin-content-row" to={to!}><span><strong>{label}</strong></span><span aria-hidden="true">↗</span></Link>)}</div>{tab==='members'&&<Suspense fallback={<Notice>正在讀取成員…</Notice>}><AdminMemberDirectory viewer={viewer} access={access}/></Suspense>}</section><Disclosure className="admin-all-tools"  title={<>所有管理入口</>}><div className="main-only-links"><Link to="/admin/backups">成分匯出與歷史備份</Link><Link to="/admin/appearance">網站外觀</Link><Link to="/admin/bot">bot 設定</Link><Link to="/admin/bot/deliveries">bot 投遞紀錄</Link><Link to="/admin/users">使用者管理</Link><Link to="/admin/music">成分關聯</Link><Link to="/admin/music-entries">音樂詞庫管理</Link><Link to="/admin/shouts">找搭子管理</Link><Link to="/admin/music-reset">重置成分與詞庫</Link><Link to="/admin/registration">註冊設定</Link><Link to="/admin/privacy">刪除申請</Link></div></Disclosure><Surface className="detail auth-panel"><Checkbox className="consent" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || blocked} label={<><span>{access.authMethod === 'account' ? '確認登出此裝置的全部帳號與管理授權，其他裝置不受影響' : '確認登出救援管理，保留目前會員登入'}</span></>} /><Button variant="secondary" disabled={!confirmed || blocked} loading={busy} onClick={() => void logout()}>登出管理</Button>{error && <Text role="alert">{error}</Text>}{blocked && <Button variant="secondary" disabled={busy} onClick={() => void checkState()}>重新確認管理狀態</Button>}</Surface></>;
}
