import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminSession, Ok, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders } from './auth';
import { announceAccountChange, clearDeviceDrafts } from './account-session';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
export type Access = z.infer<typeof AdminSession>;
export const adminHeaders = (viewer: Viewer, access: Access) => ({ ...authHeaders(viewer), 'X-Admin-CSRF': access.adminCsrf });
export function clearAdminDrafts() {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('qgroup:rebuild:admin-')) sessionStorage.removeItem(key); }
  catch { /* Revoked server authority remains enforced when local storage is unavailable. */ }
}
export function AdminGate({ children }: { children: (viewer: Viewer, access: Access) => ReactNode }) {
  const session = useQuery(sessionQuery);
  return session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : <AdminAuthority key={session.data.scope} viewer={session.data}>{children}</AdminAuthority>;
}
function AdminAuthority({ viewer, children }: { viewer: Viewer; children: (viewer: Viewer, access: Access) => ReactNode }) {
  const client = useQueryClient();
  const access = useQuery({ queryKey: ['private', viewer.scope, 'admin-session'], queryFn: () => api('/admin/session', AdminSession, { headers: { 'X-Account-Scope': viewer.scope } }), refetchOnWindowFocus: 'always', refetchInterval: 30000 });
  const denied = access.error instanceof ApiError && [401, 403].includes(access.error.status);
  useEffect(() => { if (denied) { clearAdminDrafts(); client.removeQueries({ queryKey: ['private', viewer.scope], predicate: query => String(query.queryKey[2]).startsWith('admin-') && query.queryKey[2] !== 'admin-session' }); } }, [denied, client, viewer.scope]);
  return access.isPending ? <Notice>正在確認管理權限…</Notice> : denied ? <RescueLogin viewer={viewer} reload={async () => { const result = await access.refetch(); return result.isSuccess || result.error instanceof ApiError && [401, 403].includes(result.error.status); }} /> : access.error ? <Failure error={access.error} retry={() => void access.refetch()} /> : <>{children(viewer, access.data)}</>;
}
function RescueLogin({ viewer, reload }: { viewer: Viewer; reload: () => Promise<boolean> }) {
  const [key, setKey] = useState(''); const [busy, setBusy] = useState(false); const [unknown, setUnknown] = useState(false); const [message, setMessage] = useState('');
  async function login() {
    setBusy(true); setMessage('');
    try { await api('/admin/login', Ok, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ key, confirm: true }) }); if (!await reload()) { setUnknown(true); setMessage('尚未確認登入結果，請先重新確認管理狀態。'); } announceAccountChange(); }
    catch (error) { setUnknown(!(error instanceof ApiError) || error.status >= 500); setMessage(error instanceof ApiError ? error.message : '尚未確認登入結果，請先重新確認管理狀態。'); }
    finally { setKey(''); setBusy(false); }
  }
  return <Surface className="detail auth-panel"><Text>目前帳號沒有管理權限。可登入已授權的會員帳號，或使用獨立管理救援憑證。</Text><Link to="/login?returnTo=%2Fadmin">會員登入</Link><form onSubmit={event => { event.preventDefault(); void login(); }}><label className="account-field">管理救援憑證<input type="password" autoComplete="off" value={key} disabled={busy || unknown} onChange={event => setKey(event.target.value)} /></label><Button type="submit" loading={busy} disabled={unknown || Array.from(key).length < 32 || Array.from(key).length > 256}>使用救援憑證登入</Button></form>{message && <Text role="alert">{message}</Text>}<Button variant="secondary" disabled={busy} onClick={() => { setBusy(true); void reload().then(known => { if (known) setUnknown(false); }).finally(() => setBusy(false)); }}>重新確認管理狀態</Button></Surface>;
}
export function AdminHome() {
  const [cleanup, setCleanup] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <><PageIntro title="管理後台" />{cleanup && <Notice>此裝置已登出，但本機原稿清除失敗。請重試清除。
    <Button loading={busy} onClick={() => { setBusy(true); void clearDeviceDrafts().then(() => { setCleanup(false); setError(''); }).catch(() => setError('仍無法清除本機原稿，請檢查瀏覽器儲存設定。')).finally(() => setBusy(false)); }}>重試清除本機原稿</Button>
    {error && <Text role="alert">{error}</Text>}
  </Notice>}<AdminGate>{(viewer, access) => <AdminMenu key={access.scope} viewer={viewer} access={access} onCleanupFailure={() => setCleanup(true)} />}</AdminGate></>;
}
function AdminMenu({ viewer, access, onCleanupFailure }: { viewer: Viewer; access: Access; onCleanupFailure: () => void }) {
  const client = useQueryClient(); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState(false); const [error, setError] = useState('');
  async function checkState() {
    setBusy(true);
    try {
      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      await client.resetQueries({ queryKey: ['private', viewer.scope, 'admin-session'], exact: true });
      setBlocked(false); setConfirmed(false); setError('');
    } catch { setError('仍無法確認管理狀態，請稍後重新確認。'); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    let accountLoggedOut = false;
    try {
      const result = await api('/admin/logout', z.object({ logoutAccount: z.boolean() }), { method: 'POST', headers: adminHeaders(viewer, access), body: JSON.stringify({ confirm: true }) });
      accountLoggedOut = result.logoutAccount;
      clearAdminDrafts(); try { if (result.logoutAccount) { try { await clearDeviceDrafts(); } catch (error) { onCleanupFailure(); throw error; } } } finally { announceAccountChange(result.logoutAccount); }
      await client.cancelQueries({ queryKey: ['private'] });
      const next = await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      client.removeQueries({ queryKey: ['private'], predicate: query => query.queryKey[1] !== next.scope || query.queryKey[2] !== 'admin-session' });
      if (next.scope === viewer.scope) await client.resetQueries({ queryKey: ['private', viewer.scope, 'admin-session'], exact: true });
    } catch (failure) { setBlocked(true); setError(accountLoggedOut ? '此裝置已登出，請重新確認管理狀態及本機原稿清除結果。' : failure instanceof ApiError && failure.status < 500 ? failure.message : '尚未確認登出結果，請重新確認管理狀態。'); }
    finally { setBusy(false); }
  }
  return <><Surface className="detail auth-panel"><Text>管理授權：{access.authMethod === 'account' ? '會員角色' : '救援憑證（1 小時）'}</Text><div className="page-actions"><Link to="/admin/backups">成分匯出與歷史備份</Link><Link to="/admin/appearance">壁紙管理</Link><Link to="/admin/bot">bot 設定</Link><Link to="/admin/bot/deliveries">bot 投遞紀錄</Link><Link to="/admin/users">使用者管理</Link><Link to="/admin/music">成分關聯</Link><Link to="/admin/music-entries">音樂詞庫管理</Link><Link to="/admin/shouts">找搭子管理</Link><Link to="/admin/music-reset">重置成分與詞庫</Link><Link to="/admin/registration">註冊設定</Link><Link to="/admin/privacy">刪除申請</Link></div></Surface><Surface className="detail auth-panel"><label className="consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || blocked} /><span>{access.authMethod === 'account' ? '確認登出此裝置的全部帳號與管理授權，其他裝置不受影響' : '確認登出救援管理，保留目前會員登入'}</span></label><Button variant="secondary" disabled={!confirmed || blocked} loading={busy} onClick={() => void logout()}>登出管理</Button>{error && <Text role="alert">{error}</Text>}{blocked && <Button variant="secondary" disabled={busy} onClick={() => void checkState()}>重新確認管理狀態</Button>}</Surface></>;
}
