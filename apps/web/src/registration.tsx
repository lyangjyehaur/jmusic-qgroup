import { errorText, uiText } from './language';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Surface, Text } from 'yahha-ui';
import { RegisterName, RegistrationSettings, type Viewer } from '@qgroup/contracts';
import { z } from 'zod';
import { ApiError } from './api';
import { createWebHttpClient } from './http';
import { authHttp, localReturn, loginLink, useAccountChange } from './auth';
import { AdminGate, type Access } from './admin';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';

export function Registration() {
  const session = useQuery(sessionQuery);
  const [params] = useSearchParams();
  const returnTo = localReturn(params.get('returnTo'));
  return <><PageIntro title="名稱註冊" />{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : session.data.authenticated ? <Surface className="detail auth-panel"><Text>目前已登入「{session.data.nickname}」。</Text><Link to={returnTo}>回到原任務</Link><Link to="/me/accounts">查看帳號</Link></Surface> : !session.data.nameRegistrationEnabled ? <Surface className="detail auth-panel"><Notice>名稱註冊尚未開放。</Notice><Link to={loginLink(returnTo)}>使用 QQ 登入</Link><Link to={returnTo}>返回原頁面</Link></Surface> : <NameForm key={session.data.scope} viewer={session.data} returnTo={returnTo} />}</>;
}
function NameForm({ viewer, returnTo }: { viewer: Viewer; returnTo: string }) {
  const changed = useAccountChange();
  const [nickname, setNickname] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const input = { nickname, confirm: confirmed, acceptPrivacy: accepted, privacyVersion: viewer.privacyVersion, returnTo };
  async function register() {
    const parsed = RegisterName.safeParse(input);
    if (!parsed.success || busy || uncertain) return;
    setBusy(true); setError('');
    try {
      const done = await authHttp(viewer).requestContract('POST /api/v2/auth/register-name', { body: parsed.data });
      await changed(done.returnTo);
    } catch (failure) {
      const unknown = !(failure instanceof ApiError) || failure.status >= 500;
      setUncertain(unknown); setBusy(false);
      setError(unknown ? uiText("尚未確認註冊結果，請先核對目前帳號，避免重複建立。") : errorText(failure));
    }
  }
  return <Surface className="detail auth-panel"><form onSubmit={event => { event.preventDefault(); void register(); }}>
    <label className="account-field">站內稱呼<input autoComplete="nickname" value={nickname} disabled={busy || uncertain} onChange={event => setNickname(event.target.value)} aria-describedby="nickname-limit" /></label>
    <Text id="nickname-limit">1–24 字；稱呼不作登入憑證。</Text>
    <Notice>尚未綁定 QQ 時，遺失此裝置授權可能無法找回帳號。註冊後可綁定 QQ 或授權自己的另一台裝置。</Notice>
    <label className="consent"><input type="checkbox" checked={accepted} disabled={busy || uncertain} onChange={event => setAccepted(event.target.checked)} /><span>我已閱讀並同意<Link to="/privacy" target="_blank" rel="noreferrer">隱私政策</Link></span></label>
    <label className="consent"><input type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={event => setConfirmed(event.target.checked)} /><span>確認建立新的獨立帳號，不找回或合併舊資料</span></label>
    <Button type="submit" loading={busy} disabled={uncertain || !RegisterName.safeParse(input).success}>建立帳號</Button>
    {error && <Text role="alert">{error}</Text>}
    {uncertain && <a href={'/me/accounts?returnTo=' + encodeURIComponent(returnTo)}>核對目前帳號</a>}
  </form><Link className="back" to={loginLink(returnTo)}>使用 QQ 登入</Link><Link className="back" to={returnTo}>返回原頁面</Link></Surface>;
}

export function RegistrationAdmin() {
  return <><PageIntro title="註冊設定" /><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer, access) => <SettingsLoader key={access.scope} viewer={viewer} access={access} />}</AdminGate></>;
}
function SettingsLoader({ viewer, access }: { viewer: Viewer; access: Access }) {
  const settings = useQuery({ queryKey: ['private', viewer.scope, 'admin-registration-settings', access.scope], queryFn: () => createWebHttpClient({ context: () => ({ scope: viewer.scope }) }).requestContract('GET /api/v2/admin/registration', {}), refetchOnWindowFocus: false });
  const [readVersion, setReadVersion] = useState(0);
  const reload = async () => { const result = await settings.refetch(); if (result.isSuccess) setReadVersion(value => value + 1); };
  return settings.isPending ? <Notice>正在讀取設定…</Notice> : settings.error ? <Failure error={settings.error} retry={() => void reload()} /> : <SettingsForm key={settings.data.revision + ':' + settings.data.adminCsrf + ':' + readVersion} viewer={viewer} initial={settings.data} reload={reload} />;
}
function SettingsForm({ viewer, initial, reload }: { viewer: Viewer; initial: z.infer<typeof RegistrationSettings>; reload: () => Promise<void> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!confirmed || busy || blocked) return;
    setBusy(true); setError('');
    try {
      await createWebHttpClient({ context: () => ({ scope: viewer.scope, csrf: viewer.csrf, adminCsrf: initial.adminCsrf }) }).requestContract('POST /api/v2/admin/registration', { body: { enabled: !initial.enabled, revision: initial.revision, confirm: true } });
      await reload();
    } catch (failure) {
      setBlocked(true);
      setError(failure instanceof ApiError && failure.status < 500 ? errorText(failure) : uiText("尚未確認修改結果，請重新讀取目前設定後核對。"));
    } finally { setBusy(false); }
  }
  return <Surface className="detail auth-panel"><Text role="status">名稱註冊：{initial.enabled ? '已開放' : '已關閉'}</Text>
    <Text>關閉後不影響既有帳號登入或 QQ 登入。</Text>
    <label className="consent"><input type="checkbox" checked={confirmed} disabled={busy || blocked} onChange={event => setConfirmed(event.target.checked)} /><span>確認{initial.enabled ? '關閉' : '開放'}名稱註冊{!initial.enabled && '，允許訪客不經 QQ 建立帳號'}</span></label>
    <Button loading={busy} disabled={!confirmed || blocked} onClick={() => void save()}>{initial.enabled ? '關閉名稱註冊' : '開放名稱註冊'}</Button>
    <Button variant="secondary" disabled={busy} onClick={() => void reload()}>重新讀取設定</Button>
    {error && <Text role="alert">{error}</Text>}
  </Surface>;
}
