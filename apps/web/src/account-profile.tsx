import { useEffect, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AccountProfile, SaveNickname, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { authHeaders, loginLink } from './auth';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro, sessionQuery } from './shared';

const Draft = z.object({ nickname: z.string().max(200), revision: z.number().int().min(0), requestKey: z.string().uuid().optional() }).strict();
type Value = z.infer<typeof AccountProfile>;
export function AccountProfilePage() {
  const session = useQuery(sessionQuery);
  return <><PageIntro title="站內稱呼" /><Link className="back" to="/me/accounts">回到帳號</Link>{session.isPending ? <Notice>正在確認帳號…</Notice> : session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : !session.data.authenticated ? <Link to={loginLink('/me/profile')}>登入</Link> : <ProfileLoader key={session.data.scope} viewer={session.data} />}</>;
}
function ProfileLoader({ viewer }: { viewer: Viewer }) {
  const profile = useQuery({ queryKey: ['private', viewer.scope, 'account-profile'], queryFn: () => api('/me/profile', AccountProfile, { headers: { 'X-Account-Scope': viewer.scope } }) });
  return profile.isPending ? <Notice>正在讀取稱呼…</Notice> : profile.error ? <Failure error={profile.error} retry={() => void profile.refetch()} /> : <NicknameEditor viewer={viewer} initial={profile.data} />;
}
function NicknameEditor({ viewer, initial }: { viewer: Viewer; initial: Value }) {
  const queryClient = useQueryClient();
  const storageKey = 'qgroup:rebuild:account-profile:v1:' + viewer.scope;
  const [loaded] = useState(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return { value: raw ? Draft.parse(JSON.parse(raw)) : initial as z.infer<typeof Draft>, error: '' };
    } catch { return { value: initial as z.infer<typeof Draft>, error: '此分頁的稱呼草稿無法讀取，原始內容已保留。請先保全原稿。' }; }
  });
  const [draft, setDraft] = useState(loaded.value);
  const [readError, setReadError] = useState(loaded.error);
  const [storageError, setStorageError] = useState('');
  const [saved, setSaved] = useState(initial);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const dirty = !!draft.requestKey || draft.nickname !== saved.nickname || draft.revision !== saved.revision;
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (readError) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); setStorageError(''); }
    catch { setStorageError('瀏覽器無法保存稱呼草稿，尚未送出修改。請允許本站儲存後重試。'); }
  }, [draft, readError, storageKey]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  async function save() {
    if (sending || readError) return;
    const parsed = SaveNickname.safeParse({ nickname: draft.nickname, revision: draft.revision });
    if (!parsed.success) { setMessage('稱呼須為 1–24 字，不能包含控制字元。'); return; }
    const pending = { ...parsed.data, requestKey: draft.requestKey ?? crypto.randomUUID() };
    try { sessionStorage.setItem(storageKey, JSON.stringify(pending)); setStorageError(''); }
    catch { setStorageError('無法保存操作編號，尚未送出修改。'); return; }
    setDraft(pending); setSending(true); setMessage('');
    try {
      const result = await api('/me/profile', AccountProfile, { method: 'PUT', headers: { ...authHeaders(viewer), 'Idempotency-Key': pending.requestKey }, body: JSON.stringify(parsed.data) });
      const latest = await api('/me/profile', AccountProfile, { headers: { 'X-Account-Scope': viewer.scope } });
      sessionStorage.setItem(storageKey, JSON.stringify(latest));
      setSaved(latest); setDraft(latest);
      queryClient.setQueryData(['private', viewer.scope, 'account-profile'], latest);
      announceAccountChange();
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-trend-members'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'accounts'] });
      setMessage(latest.revision === result.revision ? '已保存稱呼。' : '原操作已保存，目前稱呼已再次變更；請核對目前資料。');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500 && failure.status !== 429) {
        setDraft({ nickname: pending.nickname, revision: pending.revision });
        setMessage(failure.message);
      } else setMessage('尚未確認修改結果。操作編號已保留，請按「確認修改結果」安全重試。');
    } finally { setSending(false); }
  }
  async function rebase() {
    setSending(true);
    try {
      const latest = await api('/me/profile', AccountProfile, { headers: { 'X-Account-Scope': viewer.scope } });
      const next = { nickname: draft.nickname, revision: latest.revision };
      sessionStorage.setItem(storageKey, JSON.stringify(next)); setStorageError('');
      setSaved(latest); setDraft(next); setMessage('已取得目前稱呼；你的輸入仍保留，請核對後再保存。');
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : '讀取失敗'); }
    finally { setSending(false); }
  }
  return <>
    {blocker.state === 'blocked' && <Surface className="leave-prompt" role="alert"><Heading level={2}>還有未保存的稱呼</Heading><Text>草稿與待確認操作只保留在此分頁。</Text><Button onClick={() => blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={() => blocker.proceed()}>保留草稿並離開</Button></Surface>}
    <Surface className="detail auth-panel"><form onSubmit={event => { event.preventDefault(); void save(); }}>
      <Text>目前稱呼：{saved.nickname}</Text><label className="account-field">站內稱呼<input value={draft.nickname} maxLength={48} autoComplete="nickname" disabled={sending || !!draft.requestKey || !!readError} onChange={event => { setDraft({ ...draft, nickname: event.target.value }); setMessage(''); }} aria-describedby="nickname-help" /></label>
      <Text id="nickname-help">1–24 字。修改會更新名冊顯示，不更換帳號，也不修改 QQ 暱稱、付款歸屬或既有帳單。</Text>
      <Button type="submit" loading={sending} disabled={!dirty || !!readError || !SaveNickname.safeParse({ nickname: draft.nickname, revision: draft.revision }).success}>{draft.requestKey ? '確認修改結果' : '保存稱呼'}</Button>
      {message && <Text role="status">{message}</Text>}
      {storageError && <Text role="alert">{storageError}</Text>}
    </form>{dirty && !draft.requestKey && <Button variant="secondary" disabled={sending || !!readError} onClick={() => void rebase()}>核對目前稱呼，保留輸入</Button>}
    {readError && <div role="alert"><Text>{readError}</Text><Button variant="secondary" onClick={() => {
      try { const raw = sessionStorage.getItem(storageKey); if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw); setReadError(''); }
      catch { setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。'); }
    }}>保全原稿，從目前稱呼開始</Button></div>}</Surface>
  </>;
}
