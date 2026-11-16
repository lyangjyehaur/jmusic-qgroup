import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { MusicClaimStatus, QQStartResult, StartMusicClaim, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders } from './auth';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro, useSession } from './shared';
const Draft = z.object({ requestId: z.string().uuid(), legacyQQ: z.string().max(12) }).strict();
export function MusicRecovery() {
  const session = useSession();
  return <><PageIntro title="找回舊成分" /><Link className="back" to="/me/music">回到我的成分</Link>{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : <Recovery key={session.data.scope} viewer={session.data} />}</>;
}
function Recovery({ viewer }: { viewer: Viewer }) {
  const client = useQueryClient(); const key = 'qgroup:rebuild:music:claim:v1:' + viewer.scope;
  const [loaded] = useState(() => { try { const raw = sessionStorage.getItem(key); return { value: raw ? Draft.parse(JSON.parse(raw)) : null, error: '' }; } catch { return { value: null, error: '無法讀取找回操作編號，原始內容已保留。請先保全原稿。' }; } });
  const [pending, setPending] = useState(loaded.value); const [readError, setReadError] = useState(loaded.error); const [storageError, setStorageError] = useState('');
  const [legacyQQ, setQQ] = useState(loaded.value?.legacyQQ ?? ''); const [pin, setPin] = useState(''); const [consent, setConsent] = useState(false); const [privacy, setPrivacy] = useState(false); const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false); const [message, setMessage] = useState('');
  const queryKey = ['private', viewer.scope, 'music-claim'];
  const claim = useQuery({ queryKey, queryFn: () => api('/music/claim', MusicClaimStatus, { headers: { 'X-Account-Scope': viewer.scope } }), refetchOnWindowFocus: 'always' });
  const status = claim.data;
  async function refresh() {
    setBusy(true);
    try { await claim.refetch({ throwOnError: true }); setUncertain(false); setMessage('已重新核對找回狀態；尚未建立關聯時可輸入原口令安全重試。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '無法確認結果'); } finally { setBusy(false); }
  }
  async function start() {
    if (busy || readError || uncertain) return;
    const operation = pending ?? { requestId: crypto.randomUUID(), legacyQQ: legacyQQ.trim() };
    const parsed = StartMusicClaim.safeParse({ ...operation, legacyQQ, pin, consent });
    if (!parsed.success) { setMessage('請輸入舊 QQ 與原來的 4–6 位數字口令，並確認資料用途。'); return; }
    const next = { requestId: operation.requestId, legacyQQ: parsed.data.legacyQQ };
    // Store only the operation ID and lookup key. Never persist the PIN or its digest.
    try { sessionStorage.setItem(key, JSON.stringify(next)); setStorageError(''); } catch { setStorageError('無法保存找回操作編號，尚未送出口令。'); return; }
    setPending(next); setBusy(true); setMessage('');
    try {
      const result = await api('/music/claim/start', MusicClaimStatus, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify(parsed.data) });
      client.setQueryData(queryKey, result); setPin('');
    } catch (error) {
      setPin('');
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
        try { sessionStorage.removeItem(key); setPending(null); } catch { setStorageError('無法清除舊操作編號，請允許本站儲存後重新核對。'); }
        setMessage(error.message);
      } else { setUncertain(true); setMessage('尚未確認口令驗證結果。口令未保存，請先核對找回狀態。'); }
    } finally { setBusy(false); }
  }
  async function authorize() {
    if (!status || status.status === 'none' || status.status === 'unavailable' || status.status === 'completed' || busy || readError) return;
    setBusy(true); setMessage('');
    try {
      const result = await api('/auth/qq/start', QQStartResult, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ mode: viewer.authenticated ? 'bind' : 'login', confirm: true, musicClaimId: status.claimId, returnTo: '/me/music/recover', acceptPrivacy: privacy, privacyVersion: viewer.privacyVersion }) });
      window.location.assign(result.authorizeUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : '無法開始 QQ 授權'); setBusy(false); }
  }
  async function act(action: 'finish' | 'cancel') {
    if (!status || status.status === 'none' || busy || readError) return;
    setBusy(true); setMessage('');
    try {
      const result = await api('/music/claim/' + action, MusicClaimStatus, { method: 'POST', headers: authHeaders(viewer), body: JSON.stringify({ claimId: status.claimId, confirm: true }) });
      client.setQueryData(queryKey, result); sessionStorage.removeItem(key); setPending(null); setConfirm(false);
      if (result.status === 'completed') { announceAccountChange(); void client.invalidateQueries({ queryKey: ['session'] }); void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] }); }
      setMessage(action === 'cancel' ? '已取消找回，原成分與目前帳號均保留。' : '已關聯原成分。');
    } catch (error) {
      const unknown = !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
      setUncertain(unknown); setMessage(unknown ? '尚未確認操作結果，請先核對找回狀態。' : error.message);
    } finally { setBusy(false); }
  }
  return <>{claim.isPending ? <Notice>正在讀取找回狀態…</Notice> : claim.error ? <Failure error={claim.error} retry={() => void refresh()} /> : <Surface className="detail auth-panel">
    {status?.status === 'none' ? <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <Text>PIN 只用於找回舊成分；關聯須完成本次 QQ 授權，不會覆蓋目前帳號已有的成分。</Text>
      <label className="account-field">舊 QQ<input inputMode="numeric" autoComplete="off" value={legacyQQ} maxLength={12} disabled={busy || uncertain || !!readError} onChange={event => setQQ(event.target.value)} /></label>
      <label className="account-field">原口令<input type="password" inputMode="numeric" autoComplete="off" value={pin} maxLength={6} disabled={busy || uncertain || !!readError} onChange={event => setPin(event.target.value)} /></label>
      <Text>4–6 位數字。口令不保存在瀏覽器；忘記口令請聯絡管理員。</Text>
      <label className="consent"><input type="checkbox" checked={consent} disabled={busy || uncertain || !!readError} onChange={event => setConsent(event.target.checked)} /><span>確認以舊資料驗證取回權利，並將原成分關聯至完成 QQ 授權的帳號</span></label>
      <Button type="submit" loading={busy} disabled={!consent || uncertain || !!readError || !/^[0-9]{4,12}$/.test(legacyQQ.trim()) || !/^[0-9]{4,6}$/.test(pin.trim())}>驗證原口令</Button>
    </form> : status && <>
      <Heading level={2}>{status.name || '原成分'}</Heading><Text>舊 QQ：{status.legacyQQ}</Text><Text>固定成分 ID：{status.profileId}</Text>
      {status.status === 'completed' ? <><Notice>已關聯原成分。</Notice><Link to="/me/music">編輯原成分</Link></> : status.status === 'unavailable' ? <Notice>找回已過期、成分已變更或已有關聯。取消後可重新找回；如有衝突請聯絡管理員。</Notice> : <>
        <Text>有效至 {new Date(status.expiresAt).toLocaleString('zh-TW')}。</Text>
        {status.status === 'pending' ? <>
          <Text>{viewer.authenticated ? `接著授權目前帳號「${viewer.nickname}」的 QQ，不切換或合併帳號。` : '接著授權 QQ，確認登入帳號後再核對成分關聯。'}</Text>
          {!viewer.privacyAccepted && <label className="consent"><input type="checkbox" checked={privacy} onChange={event => setPrivacy(event.target.checked)} /><span>我已閱讀並同意<Link to="/privacy" target="_blank" rel="noreferrer">隱私政策</Link></span></label>}
          <Button loading={busy} disabled={!viewer.qqEnabled || (!viewer.privacyAccepted && !privacy) || uncertain || !!readError} onClick={() => void authorize()}>前往 QQ 授權找回</Button>{!viewer.qqEnabled && <Notice>QQ 登入尚未配置，請聯絡管理員。</Notice>}
        </> : <>
          <Text>將原成分關聯至帳號「{status.targetNickname}」。原選擇、稱呼及聯絡資料會保留；報名與款項不合併。</Text>
          <label className="consent"><input type="checkbox" checked={confirm} disabled={busy || uncertain || !!readError} onChange={event => setConfirm(event.target.checked)} /><span>確認這是我的原成分，關聯至目前帳號</span></label>
          <Button loading={busy} disabled={!confirm || uncertain || !!readError} onClick={() => void act('finish')}>確認關聯原成分</Button>
        </>}
      </>}
      {status.status !== 'completed' && <Button variant="secondary" disabled={busy || uncertain || !!readError} onClick={() => void act('cancel')}>取消找回</Button>}
    </>}
    {message && <Text role="status">{message}</Text>}{storageError && <Text role="alert">{storageError}</Text>}
    <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>核對找回狀態</Button>
    {readError && <div role="alert"><Text>{readError}</Text><Button onClick={() => { try { const raw = sessionStorage.getItem(key); if (raw !== null) sessionStorage.setItem(key + ':recovery:' + Date.now(), raw); setReadError(''); } catch { setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。'); } }}>保全原稿後繼續</Button></div>}
  </Surface>}</>;
}
