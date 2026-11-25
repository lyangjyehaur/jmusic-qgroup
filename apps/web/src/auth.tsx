import { errorText, uiText } from './language';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Surface, Text } from 'yahha-ui';
import { Avatar, Badge, Button } from './kimi-ui';
import { Check, Laptop } from 'lucide-react';
import { ActionLink } from './action-link';

import { type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { createWebHttpClient } from './http';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';
import { announceAccountChange, clearDeviceDrafts } from './account-session';
import { QQAvatar, stampQQReminder } from './qq-profile';

export const authHeaders = (viewer: Viewer) => ({ 'Content-Type': 'application/json', 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf });
export const authHttp = (viewer: Viewer) => createWebHttpClient({ context: () => ({ scope: viewer.scope, csrf: viewer.csrf }) });
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
  const [acceptedFor, setAcceptedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mode = params.get('mode') === 'bind' ? 'bind' : 'login';
  const consentTarget = session.data ? session.data.scope + ':' + session.data.privacyVersion + ':' + mode : '';
  const accepted = !!consentTarget && acceptedFor === consentTarget;
  const returnTo = localReturn(params.get('returnTo'));
  async function start() {
    if (!session.data) return;
    setBusy(true); setError('');
    try {
      if (session.data.authenticated && session.data.qq.needsReauth) stampQQReminder(session.data.scope);
      const result = await authHttp(session.data).requestContract('POST /api/v2/auth/qq/start', { body: { mode, confirm: true, returnTo, acceptPrivacy: accepted, privacyVersion: session.data.privacyVersion } });
      window.location.assign(result.authorizeUrl);
    } catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("無法開始授權")); setBusy(false); }
  }
  return <><PageIntro title={mode === 'bind' ? '綁定 QQ' : '登入'} />{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : <Surface className="detail auth-panel">
    {session.data.qqEnabled ? <>
      <Text>{mode === 'bind' ? `${uiText("綁定目前帳號「")}${session.data.authenticated ? session.data.nickname : ''}${uiText("」，不搬移報名或款項。")}` : 'QQ 授權後仍需確認帳號；首次登入會在確認後建立帳號。'}</Text>
      {(mode === 'login' || !session.data.privacyAccepted) && <label className="consent"><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAcceptedFor(event.target.checked ? consentTarget : null)} />我已閱讀並同意<Link to="/privacy" target="_blank" rel="noreferrer">隱私政策</Link></label>}
      <Button loading={busy} disabled={((mode === 'login' || !session.data.privacyAccepted) && !accepted) || (mode === 'bind' && !session.data.authenticated)} onClick={() => void start()}>{mode === 'bind' ? '前往 QQ 授權綁定' : '前往 QQ 登入'}</Button>
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
  const status = useQuery({ queryKey: ['private', viewer?.scope, 'qq-status'], enabled: !!viewer?.qqEnabled && !params.has('status'), queryFn: () => createWebHttpClient({ context: () => ({ scope: viewer!.scope }) }).requestContract('GET /api/v2/auth/qq/status', {}) });
  const result = status.data;
  async function finish() {
    if (!viewer || result?.status !== 'verified') return;
    setBusy(true); setError('');
    try {
      const done = await authHttp(viewer).requestContract('POST /api/v2/auth/qq/finish', { body: { confirm: true, attemptId: result.attemptId } });
      const message = result.mode === 'bind' && viewer.authenticated && viewer.qq.needsReauth ? done.qqUnionidBound ? uiText('QQ 資料已更新；bot 個人功能仍依實際開放狀態。') : uiText('尚未取得 UnionID；原帳號已保留，可在帳號頁重新授權。') : undefined;
      await changed(done.returnTo, false, message);
    } catch (failure) {
      const unknown = !(failure instanceof ApiError) || failure.status >= 500;
      setUncertain(unknown);
      setError(unknown ? uiText("尚未確認登入結果，請先核對目前帳號。") : errorText(failure));
      setBusy(false);
    }
  }
  async function cancel() {
    if (!viewer) return;
    setBusy(true); setError('');
    try {
      const done = await authHttp(viewer).requestContract('POST /api/v2/auth/qq/cancel', { body: { confirm: true } });
      await changed(done.returnTo);
    } catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("取消失敗")); setBusy(false); }
  }
  const statusText = { expired: uiText("授權已過期，請重新登入。"), pending: uiText("QQ 授權尚未完成。"), exchanging: uiText("正在確認 QQ 授權，請稍後重新讀取。"), failed: uiText("QQ 授權未完成或已取消，請重新登入。"), used: uiText("此授權已使用，請查看目前帳號。") };
  return <><PageIntro title="確認 QQ 授權" />{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : params.has('status') ? <Notice>授權已失效或瀏覽器帳號已變更，請重新登入。</Notice> : !viewer?.qqEnabled ? <Notice>QQ 登入尚未配置。</Notice> : status.isPending ? <Notice>正在讀取授權結果…</Notice> : status.error ? <Failure error={status.error} retry={() => void status.refetch()} /> : !result ? <Notice>正在讀取授權結果…</Notice> : <Surface className="detail auth-panel">
    {result.status === 'verified' ? <>
      <dl><dt>QQ 暱稱</dt><dd>{result.qqNickname}</dd><dt>操作</dt><dd>{result.mode === 'bind' ? `${uiText("綁定目前帳號「")}${result.currentNickname}${uiText("」")}` : result.existingAccount ? `${uiText("登入既有帳號「")}${result.targetNickname}${uiText("」")}` : '建立帳號並登入'}</dd></dl>
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
  const client = useQueryClient();
  const [cleanup, setCleanup] = useState(false);
  const viewer = session.data;
  const changed = useAccountChange();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const accounts = useQuery({ queryKey: ['private', viewer?.scope, 'accounts'], enabled: !!viewer?.authenticated, queryFn: () => createWebHttpClient({ context: () => ({ scope: viewer!.scope }) }).requestContract('GET /api/v2/me/accounts', {}) });
  async function switchTo(scope: string) {
    if (!viewer) return; setBusy(true); setError('');
    try { await authHttp(viewer).requestContract('POST /api/v2/me/accounts/switch', { body: { scope, confirm: true } }); await changed('/me/accounts'); }
    catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("切換失敗")); } finally { setBusy(false); }
  }
  async function logout() {
    if (!viewer) return; setBusy(true); setError('');
    let committed = false, cleaned = false;
    try {
      await authHttp(viewer).requestContract('POST /api/v2/auth/logout', { body: { confirm: true } });
      committed = true;
      try { await clearDeviceDrafts(); cleaned = true; } finally { announceAccountChange(true); }
      await changed('/me', true);
    } catch (failure) {
      if (committed) { setCleanup(!cleaned); setError(cleaned ? uiText("此裝置已登出，但無法讀取目前帳號。請重新載入頁面。") : uiText("此裝置已登出，但本機原稿清除失敗。請重試清除。")); void client.invalidateQueries({ queryKey: ['session'] }); }
      else setError(failure instanceof Error ? errorText(failure) : uiText("登出失敗"));
    } finally { setBusy(false); }
  }
  return <><PageIntro title="帳號" />{params.has('returnTo') && <Link className="back" to={localReturn(params.get('returnTo'))}>回到原任務</Link>}{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : !viewer?.authenticated ? <Link to={loginLink(localReturn(params.get('returnTo')) === '/' ? '/me/accounts' : localReturn(params.get('returnTo')))}>登入</Link> : <>
    <div className="settings-grid account-settings"><section className="form-section"><div className="section-heading"><span>帳號</span><div><h2>站內資料與 QQ 綁定</h2></div></div><div className="binding-row"><div><strong>{viewer.nickname}</strong></div><ActionLink size="sm" to="/me/profile">修改站內稱呼</ActionLink></div>
      <div className="binding-row">{viewer.qq.bound&&<QQAvatar url={viewer.qq.avatarUrl} nickname={viewer.qq.nickname}/>}<div><strong>QQ 綁定</strong><span>{viewer.qq.bound ? `${uiText("已綁定 QQ：")}${viewer.qq.nickname}` : '尚未綁定 QQ'}</span></div>{viewer.qqEnabled&&<ActionLink size="sm" to="/login?mode=bind&returnTo=%2Fme%2Faccounts">{viewer.qq.needsReauth?'重新授權原 QQ':viewer.qq.bound?'核對 QQ 綁定':'綁定 QQ'}</ActionLink>}</div>
      {viewer.qq.needsReauth&&<p className="settings-help">尚未取得 UnionID，可重新授權原 QQ；這不代表已綁定 bot 個人功能。</p>}
      <div className="binding-row"><div><strong>收款碼</strong></div><ActionLink size="sm" to="/me/payment-codes">我的收款碼</ActionLink></div>
      <div className="settings-navigation"><Link to="/me/privacy">隱私與資料刪除</Link><Link to="/me/privacy/consent">{viewer.privacyAccepted?'查看政策同意紀錄':'確認統一隱私政策'}</Link>{viewer.administrator&&<Link to="/admin/registration">註冊設定</Link>}</div>
    </section><section className="form-section"><div className="section-heading"><span>切換</span><div><h2>此裝置已授權的帳號</h2></div></div><p className="settings-help">切換帳號會保留各自資料。</p>{accounts.isPending?<Notice>正在讀取授權…</Notice>:accounts.error?<Failure error={accounts.error} retry={()=>void accounts.refetch()}/>:<div className="account-switch-list">{accounts.data.accounts.map(account=><button type="button" key={account.scope} className={account.current?'active':''} disabled={busy||account.current} aria-label={account.current?account.nickname+'（目前帳號）':'切換至 '+account.nickname} onClick={()=>void switchTo(account.scope)}><Avatar user={{name:account.nickname,avatar:account.nickname.slice(0,1),color:'var(--moss)'}}/><span><strong>{account.nickname}</strong><small>{account.current?'目前帳號':'已授權'}</small></span>{account.current?<Check size={17}/>:<span>切換</span>}</button>)}</div>}</section>
    <AccountDevices viewer={viewer}/><section className="form-section span-full"><p className="settings-help">登出會撤銷此裝置的所有帳號授權並清除本機原稿；其他裝置不受影響。</p><Button variant="secondary" disabled={busy||cleanup} onClick={()=>void logout()}>登出此裝置</Button></section></div>
  </>}
    {cleanup && <Button loading={busy} onClick={() => {
      setBusy(true); void clearDeviceDrafts().then(async () => { setCleanup(false); await changed('/me', true); }).catch(() => setError(uiText("仍無法清除本機原稿，請檢查瀏覽器儲存設定。"))).finally(() => setBusy(false));
    }}>重試清除本機原稿</Button>}
    {error && <Text role="alert">{error}</Text>}
  </>;
}

function AccountDevices({viewer}:{viewer:Extract<Viewer,{authenticated:true}>}){
 const devices=useQuery({queryKey:['private',viewer.scope,'devices'],queryFn:()=>createWebHttpClient({context:()=>({scope:viewer.scope})}).requestContract('GET /api/v2/me/devices',{})});
 return <section className="form-section span-full"><div className="section-title-row"><div className="section-heading"><span>裝置</span><div><h2>登入裝置</h2></div></div><Link className="text-link" to="/me/devices">裝置與帳號紀錄</Link></div>{devices.isPending?<Notice>正在讀取裝置…</Notice>:devices.error?<Failure error={devices.error} retry={()=>void devices.refetch()}/>:<div className="device-list">{devices.data.devices.map((device,index)=><div key={device.id}><Laptop size={20}/><span><strong>{device.current?'目前裝置':'其他裝置 '+index}</strong><small>授權於 {new Date(device.createdAt).toLocaleString('zh-TW')}</small></span>{device.current?<Badge tone="green">目前</Badge>:<ActionLink size="sm" to="/me/devices">管理</ActionLink>}</div>)}</div>}</section>;
}
