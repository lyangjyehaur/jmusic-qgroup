import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminMusicPinHistory, AdminMusicProfile, MusicPinResult, Ok, ResetMusicPin, type Viewer } from '@qgroup/contracts';
import { adminHeaders, type Access } from './admin';
import { api, ApiError } from './api';
import { Failure, Notice } from './shared';

const Pending = z.object({ requestId: z.string().uuid() }).strict();
type Profile = z.infer<typeof AdminMusicProfile>;
export function AdminMusicPin({ profile, viewer, access, disabled, onDirty, onCurrent }: {
  profile: Profile; viewer: Viewer; access: Access; disabled: boolean;
  onDirty: (dirty: boolean) => void; onCurrent: (profile: Profile) => void;
}) {
  const client = useQueryClient(); const path = '/admin/music/' + profile.id;
  const storageKey = 'qgroup:rebuild:admin-music-pin:v1:' + viewer.scope + ':' + access.scope + ':' + profile.id;
  const [loaded] = useState(() => { try { const raw = sessionStorage.getItem(storageKey); return { pending: raw ? Pending.parse(JSON.parse(raw)) : null, error: '' }; } catch { return { pending: null, error: '無法讀取口令操作編號，原始內容已保留。' }; } });
  const [pending, setPending] = useState(loaded.pending); const [readError, setReadError] = useState(loaded.error);
  const [expanded, setExpanded] = useState(!!loaded.pending || !!loaded.error);
  const [pin, setPin] = useState(''); const [reason, setReason] = useState(''); const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false); const [notFound, setNotFound] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => { onDirty(!!pending || !!pin || !!reason || !!readError || busy); }, [pending, pin, reason, readError, busy, onDirty]);
  const history = useInfiniteQuery({ queryKey: ['private', viewer.scope, 'admin-music-pin-history', access.scope, profile.id], initialPageParam: Number.MAX_SAFE_INTEGER, enabled: expanded,
    queryFn: ({ pageParam }) => api(path + '/pin-history?before=' + pageParam, AdminMusicPinHistory, { headers: { 'X-Account-Scope': viewer.scope } }), getNextPageParam: page => page.nextCursor ?? undefined });
  async function refreshProfile() {
    const latest = await api(path, AdminMusicProfile, { headers: { 'X-Account-Scope': viewer.scope } });
    onCurrent(latest); client.setQueryData(['private', viewer.scope, 'admin-music-profile', access.scope, profile.id], latest);
    void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music'] });
    void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music-pin-history'] });
  }
  async function completed() {
    await refreshProfile(); sessionStorage.removeItem(storageKey); setPending(null); setNotFound(false); setReason(''); setConfirm(false);
    setMessage('口令重設已完成，該成分的舊找回授權已失效。');
  }
  async function save() {
    if (busy || disabled || pending || readError) return;
    const parsed = ResetMusicPin.safeParse({ pin, revision: profile.revision, reason, confirm }); if (!parsed.success) return;
    const operation = { requestId: crypto.randomUUID() };
    try { sessionStorage.setItem(storageKey, JSON.stringify(operation)); } catch { setMessage('無法保存口令操作編號，尚未送出口令。'); return; }
    setPending(operation); setBusy(true); setMessage(''); setPin(''); setConfirm(false);
    let accepted = false;
    try {
      await api(path + '/pin', Ok, { method: 'POST', headers: { ...adminHeaders(viewer, access), 'Idempotency-Key': operation.requestId }, body: JSON.stringify(parsed.data) });
      accepted = true;
      await completed();
    } catch (error) {
      if (!accepted && error instanceof ApiError && error.status < 500 && error.status !== 429) {
        try { sessionStorage.removeItem(storageKey); setPending(null); } catch { /* Retain the operation ID until storage works. */ }
        setMessage(error.message);
      } else setMessage('尚未確認口令重設結果。口令未保存，請先查詢操作結果。');
    } finally { setBusy(false); }
  }
  async function check() {
    if (!pending || busy || disabled || readError) return;
    setBusy(true); setMessage(''); setNotFound(false);
    try {
      const result = await api(path + '/pin-result', MusicPinResult, { method: 'POST', headers: adminHeaders(viewer, access), body: JSON.stringify(pending) });
      if (result.status === 'completed') await completed();
      else { setNotFound(true); setMessage('尚未查到完成紀錄。可稍後再查，或核對目前版本後重新輸入口令。'); }
    } catch (error) { setMessage(error instanceof Error ? error.message : '仍無法確認口令重設結果，請稍後再查。'); }
    finally { setBusy(false); }
  }
  async function restart() {
    if (busy || !notFound || disabled) return;
    setBusy(true);
    try { await refreshProfile(); sessionStorage.removeItem(storageKey); setPending(null); setNotFound(false); setConfirm(false); setMessage('請重新輸入口令並確認；若原操作稍後完成，版本檢查會阻止覆蓋。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '無法核對目前版本，請稍後再查。'); }
    finally { setBusy(false); }
  }
  return <Surface className="detail auth-panel"><details className="admin-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>重設找回口令</summary>
    <Text>4–6 位數字，只供舊成分找回，仍須本次 QQ 授權。重設不解除帳號關聯，已關聯成分不能靠口令取回。</Text>
    <Text>重設後，這份成分尚未完成的找回授權將失效。口令不保存在瀏覽器。</Text>
    {disabled && <Text>請先完成或清除關聯草稿，再重設口令。</Text>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="account-field">新找回口令<input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} disabled={busy || disabled || !!pending || !!readError} onChange={event => { setPin(event.target.value); setConfirm(false); }} /></label>
      <div className="account-field"><label htmlFor={'music-pin-reason-' + profile.id}>重設原因</label><textarea id={'music-pin-reason-' + profile.id} rows={2} maxLength={500} value={reason} disabled={busy || disabled || !!pending || !!readError} onChange={event => { setReason(event.target.value); setConfirm(false); }} /></div>
      <label className="consent"><input type="checkbox" checked={confirm} disabled={busy || disabled || !!pending || !!readError} onChange={event => setConfirm(event.target.checked)} /><span>確認已核對成分及申請人，重設找回口令</span></label>
      <Button type="submit" loading={busy} disabled={disabled || !!pending || !!readError || !confirm || !reason.trim() || !/^[0-9]{4,6}$/.test(pin.trim())}>重設口令</Button>
    </form>
    {!pending && (pin || reason) && <Button variant="secondary" disabled={busy || disabled} onClick={() => { setPin(''); setReason(''); setConfirm(false); }}>清除未送出口令</Button>}
    {pending && <Button variant="secondary" loading={busy} disabled={disabled || !!readError} onClick={() => void check()}>查詢口令重設結果</Button>}
    {notFound && <Button variant="secondary" disabled={busy || disabled} onClick={() => void restart()}>核對版本並重新輸入</Button>}
    {!pending && <Button variant="secondary" disabled={busy || disabled} onClick={() => { setBusy(true); void refreshProfile().then(() => { setConfirm(false); setMessage('已核對目前版本，請重新確認。'); }).catch(error => setMessage(error instanceof Error ? error.message : '無法核對版本')).finally(() => setBusy(false)); }}>核對目前成分版本</Button>}
    {message && <Text role="status">{message}</Text>}
    {readError && <div role="alert"><Text>{readError}</Text><Button disabled={busy || disabled} onClick={() => { try { const raw = sessionStorage.getItem(storageKey); if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw); sessionStorage.removeItem(storageKey); setReadError(''); } catch { setMessage('仍無法保全原稿，請檢查瀏覽器儲存設定。'); } }}>保全操作編號後繼續</Button></div>}
    <Heading level={3}>口令重設紀錄</Heading>{history.isPending ? <Notice>正在讀取紀錄…</Notice> : history.error ? <Failure error={history.error} retry={() => void history.refetch()} /> : <>
      {history.data.pages.flatMap(page => page.history).map(row => <div key={row.id}><Text>{row.createdAt} · {row.actor}</Text><Text className="preserve-lines">{row.reason}</Text></div>)}
      {!history.data.pages[0]?.history.length && <Notice>目前沒有口令重設紀錄。</Notice>}{history.hasNextPage && <Button variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>載入更多口令紀錄</Button>}
    </>}
  </details></Surface>;
}
