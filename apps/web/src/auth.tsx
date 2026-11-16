import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AccountList, AuthResult, Ok, QQStartResult, QQStatus, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { announceAccountChange, clearDeviceDrafts } from './account-session';
import { QQAvatar, stampQQReminder } from './qq-profile';

export const authHeaders = (viewer: Viewer) => ({ 'Content-Type': 'application/json', 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf });
export const loginLink = (returnTo: string) => '/login?returnTo=' + encodeURIComponent(returnTo);
export function localReturn(value: string | null) { return value?.startsWith('/') && !value.startsWith('//') && !/[\\\x00-\x20]/.test(value) ? value : '/'; }
export function useAccountChange() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (returnTo: string, logout = false, message?: string) => {
    announceAccountChange(logout);
    const next = await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    queryClient.removeQueries({ queryKey: ['private'], predicate: query => query.queryKey[1] !== next.scope });
    navigate(localReturn(returnTo), { replace: true, state: message ? { accountMessage: message } : null });
  };
}
export function Login() {
  const session = useQuery(sessionQuery);
  const [params] = useSearchParams();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mode = params.get('mode') === 'bind' ? 'bind' : 'login';
  const returnTo = localReturn(params.get('returnTo'));
  async function start() {
    if (!session.data) return;
    setBusy(true); setError('');
    try {
      if (session.data.authenticated && session.data.qq.needsReauth) stampQQReminder(session.data.scope);
      const result = await api('/auth/qq/start', QQStartResult, { method: 'POST', headers: authHeaders(session.data), body: JSON.stringify({ mode, confirm: true, returnTo, acceptPrivacy: accepted, privacyVersion: session.data.privacyVersion }) });
      window.location.assign(result.authorizeUrl);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '無法開始授權'); setBusy(false); }
  }
  return <><PageIntro title={mode === 'bind' ? '綁定 QQ' : '登入'} />{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : <Surface className="detail auth-panel">
    {session.data.qqEnabled ? <>
      <Text>{mode === 'bind' ? `綁定目前帳號「${session.data.authenticated ? session.data.nickname : ''}」，不搬移報名或款項。` : 'QQ 授權後仍需確認帳號；首次登入會在確認後建立帳號。'}</Text>
      {!session.data.privacyAccepted && <label className="consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />我已閱讀並同意<Link to="/privacy" target="_blank" rel="noreferrer">隱私政策</Link></label>}
      <Button loading={busy} disabled={(!session.data.privacyAccepted && !accepted) || (mode === 'bind' && !session.data.authenticated)} onClick={() => void start()}>{mode === 'bind' ? '前往 QQ 授權綁定' : '前往 QQ 登入'}</Button>
      {mode === 'bind' && !session.data.authenticated && <Notice>請先登入後再綁定 QQ。</Notice>}
    </> : <Notice>QQ 登入尚未配置。</Notice>}
    {mode === 'login' && !session.data.authenticated && session.data.nameRegistrationEnabled && <Link className="back" to={'/register?returnTo=' + encodeURIComponent(returnTo)}>使用名稱註冊</Link>}
    {error && <Text role="alert">{error}</Text>}<Link className="back" to={returnTo}>返回原頁面</Link>
  </Surface>}</>;
}
export function AuthConfirm() {
  const session = useQuery(sessionQuery);
  const viewer = session.data;
  const [params] = useSearchParams();
  const changed = useAccountChange();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const status = useQuery({ queryKey: ['private', viewer?.scope, 'qq-status'], enabled: !!viewer?.qqEnabled && !params.has('status'), queryFn: () => api('/auth/qq/status', QQStatus, { headers: { 'X-Account-Scope': viewer!.scope } }) });
  const result = status.data;
  async function finish() {
    if (!viewer || result?.status !== 'verified') return;
    setBusy(true); setError('');
    try {
      const done = await api('/auth/qq/finish', AuthResult, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ confirm: true, attemptId: result.attemptId }) });
      const message = result.mode === 'bind' && viewer.authenticated && viewer.qq.needsReauth ? done.qqUnionidBound ? 'QQ 資料已更新；bot 個人功能仍依實際開放狀態。' : '尚未取得 UnionID；原帳號已保留，可在帳號頁重新授權。' : undefined;
      await changed(done.returnTo, false, message);
    } catch (failure) {
      const unknown = !(failure instanceof ApiError) || failure.status >= 500;
      setUncertain(unknown);
      setError(unknown ? '尚未確認登入結果，請先核對目前帳號。' : failure.message);
      setBusy(false);
    }
  }
  async function cancel() {
    if (!viewer) return;
    setBusy(true); setError('');
    try {
      const done = await api('/auth/qq/cancel', z.object({ returnTo: z.string() }), { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ confirm: true }) });
      await changed(done.returnTo);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '取消失敗'); setBusy(false); }
  }
  const statusText = { expired: '授權已過期，請重新登入。', pending: 'QQ 授權尚未完成。', exchanging: '正在確認 QQ 授權，請稍後重新讀取。', failed: 'QQ 授權未完成或已取消，請重新登入。', used: '此授權已使用，請查看目前帳號。' };
  return <><PageIntro title="確認 QQ 授權" />{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : params.has('status') ? <Notice>授權已失效或瀏覽器帳號已變更，請重新登入。</Notice> : !viewer?.qqEnabled ? <Notice>QQ 登入尚未配置。</Notice> : status.isPending ? <Notice>正在讀取授權結果…</Notice> : status.error ? <Failure error={status.error} retry={() => void status.refetch()} /> : !result ? <Notice>正在讀取授權結果…</Notice> : <Surface className="detail auth-panel">
    {result.status === 'verified' ? <>
      <dl><dt>QQ 暱稱</dt><dd>{result.qqNickname}</dd><dt>操作</dt><dd>{result.mode === 'bind' ? `綁定目前帳號「${result.currentNickname}」` : result.existingAccount ? `登入既有帳號「${result.targetNickname}」` : '建立帳號並登入'}</dd></dl>
      {result.mode === 'login' && result.currentNickname && <Text>目前帳號「{result.currentNickname}」的授權會保留，報名與款項分開。</Text>}
      {result.conflict ? <Notice>目前帳號已綁定另一個 QQ，或此 QQ 已綁定其他帳號；不能直接替換或合併。</Notice> : <Button loading={busy} disabled={uncertain} onClick={() => void finish()}>{result.mode === 'bind' ? '確認綁定' : '確認登入'}</Button>}
      {result.conflict && (result.returnTo === '/me/music/recover' ? <Link to={result.returnTo}>返回找回流程</Link> : <Link to={loginLink(result.returnTo)}>改用 QQ 登入</Link>)}
    </> : <Notice>{statusText[result.status]}</Notice>}
    <Button variant="secondary" disabled={busy || uncertain} onClick={() => void cancel()}>取消並返回</Button>
    {result.status !== 'verified' && (result.returnTo === '/me/music/recover' ? <Link to={result.returnTo}>返回找回流程</Link> : <Link to={loginLink(result.returnTo)}>重新登入</Link>)}
    {error && <Text role="alert">{error}</Text>}
    {uncertain && <a href={result.returnTo === '/me/music/recover' ? result.returnTo : '/me/accounts?returnTo=' + encodeURIComponent(result.returnTo)}>{result.returnTo === '/me/music/recover' ? '核對找回狀態' : '核對目前帳號'}</a>}
  </Surface>}{params.has('status') && <Link to="/login">重新登入</Link>}</>;
}
export function Accounts() {
  const session = useQuery(sessionQuery);
  const viewer = session.data;
  const changed = useAccountChange();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const accounts = useQuery({ queryKey: ['private', viewer?.scope, 'accounts'], enabled: !!viewer?.authenticated, queryFn: () => api('/me/accounts', AccountList, { headers: { 'X-Account-Scope': viewer!.scope } }) });
  async function switchTo(scope: string) {
    if (!viewer) return; setBusy(true); setError('');
    try { await api('/me/accounts/switch', Ok, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ scope, confirm: true }) }); await changed('/me/accounts'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '切換失敗'); } finally { setBusy(false); }
  }
  async function logout() {
    if (!viewer) return; setBusy(true); setError('');
    try {
      await api('/auth/logout', Ok, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ confirm: true }) });
      clearDeviceDrafts();
      await changed('/me', true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '登出失敗'); } finally { setBusy(false); }
  }
  return <><PageIntro title="帳號" />{params.has('returnTo') && <Link className="back" to={localReturn(params.get('returnTo'))}>回到原任務</Link>}{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : !viewer?.authenticated ? <Link to={loginLink(localReturn(params.get('returnTo')) === '/' ? '/me/accounts' : localReturn(params.get('returnTo')))}>登入</Link> : <>
    <Surface className="detail auth-panel"><Heading level={2}>{viewer.nickname}</Heading><Link to="/me/profile">修改站內稱呼</Link>{viewer.qq.bound && <QQAvatar url={viewer.qq.avatarUrl} nickname={viewer.qq.nickname} />}<Text>{viewer.qq.bound ? `已綁定 QQ：${viewer.qq.nickname}` : '尚未綁定 QQ'}</Text>
      {viewer.qqEnabled && <Link to="/login?mode=bind&returnTo=%2Fme%2Faccounts">{viewer.qq.needsReauth ? '重新授權原 QQ' : viewer.qq.bound ? '核對 QQ 綁定' : '綁定 QQ'}</Link>}
      {viewer.qq.needsReauth && <Text>尚未取得 UnionID，可重新授權原 QQ；這不代表已綁定 bot 個人功能。</Text>}
    </Surface>
    <Surface className="detail auth-panel"><Heading level={2}>此裝置已授權的帳號</Heading><Text>切換帳號會保留各自資料。</Text>{accounts.isPending ? <Notice>正在讀取授權…</Notice> : accounts.error ? <Failure error={accounts.error} retry={() => void accounts.refetch()} /> : <ul className="account-list">{accounts.data.accounts.map(account => <li key={account.scope}><span>{account.nickname}{account.current ? '（目前帳號）' : ''}</span>{!account.current && <Button variant="secondary" disabled={busy} onClick={() => void switchTo(account.scope)}>切換至 {account.nickname}</Button>}</li>)}</ul>}</Surface>
    <Link className="back" to="/me/devices">裝置與帳號紀錄</Link>
    <Link className="back" to="/me/privacy">隱私與資料刪除</Link>
    {viewer.administrator && <Link className="back" to="/admin/registration">註冊設定</Link>}
    <Surface className="detail auth-panel"><Text>登出會撤銷此裝置的所有帳號授權並清除成分分頁草稿；其他裝置不受影響。</Text><Button variant="secondary" disabled={busy} onClick={() => void logout()}>登出此裝置</Button></Surface>
    {error && <Text role="alert">{error}</Text>}
  </>}</>;
}
