import { useEffect, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { MusicContact, SaveMusicContact } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { announceAccountChange } from './account-session';
import { ContactValue } from './people';
type Value = z.infer<typeof MusicContact>;
const Draft = SaveMusicContact.extend({ contactQQ: z.string().max(24), requestKey: z.string().uuid().optional() });
export function MusicContactPage() {
  return <><PageIntro title="聯絡 QQ" /><Link className="back" to="/me/music">回到我的成分</Link><MemberAccess>{viewer => <Loader key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} />}</MemberAccess></>;
}
function Loader({ viewer }: { viewer: Member }) {
  const contact = useQuery({ queryKey: ['private', viewer.scope, 'music-contact', viewer.musicEpoch], queryFn: () => api('/me/music/contact', MusicContact, { headers: { 'X-Account-Scope': viewer.scope } }) });
  return contact.isPending ? <Notice>正在讀取聯絡 QQ…</Notice> : contact.error ? <Failure error={contact.error} retry={() => void contact.refetch()} /> : <Editor viewer={viewer} initial={contact.data} />;
}
function Editor({ viewer, initial }: { viewer: Member; initial: Value }) {
  const client = useQueryClient(); const storageKey = `qgroup:rebuild:music:contact:v1:${viewer.scope}:${viewer.musicEpoch}:${initial.profileId}`;
  const fallback = { profileId: initial.profileId, musicEpoch: viewer.musicEpoch, revision: initial.revision, contactQQ: initial.contactQQ };
  const [loaded] = useState(() => {
    try { const raw = sessionStorage.getItem(storageKey); return { value: raw ? Draft.parse(JSON.parse(raw)) : fallback, error: '' }; }
    catch { return { value: fallback, error: '無法讀取聯絡 QQ 草稿，原始內容已保留。請先保全原稿。' }; }
  });
  const [draft, setDraft] = useState<z.infer<typeof Draft>>(loaded.value); const [saved, setSaved] = useState(initial);
  const [readError, setReadError] = useState(loaded.error); const [storageError, setStorageError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const dirty = !!draft.requestKey || draft.contactQQ !== saved.contactQQ || draft.revision !== saved.revision;
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (readError) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); setStorageError(''); }
    catch { setStorageError('無法保存聯絡 QQ 草稿，尚未送出修改。'); }
  }, [draft, readError, storageKey]);
  useEffect(() => {
    if (!dirty) return; const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  async function save() {
    if (busy || readError || saved.source === 'legacy') return;
    const input = SaveMusicContact.safeParse({ profileId: draft.profileId, musicEpoch: draft.musicEpoch, revision: draft.revision, contactQQ: draft.contactQQ });
    if (!input.success) { setMessage('QQ 號須為 4–12 位數字，或留空清除。'); return; }
    const pending = { ...input.data, requestKey: draft.requestKey ?? crypto.randomUUID() };
    try { sessionStorage.setItem(storageKey, JSON.stringify(pending)); setStorageError(''); }
    catch { setStorageError('無法保存操作編號，尚未送出修改。'); return; }
    setDraft(pending); setBusy(true); setMessage('');
    try {
      const result = await api('/me/music/contact', MusicContact, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': pending.requestKey }, body: JSON.stringify(input.data) });
      const latest = await api('/me/music/contact', MusicContact, { headers: { 'X-Account-Scope': viewer.scope } });
      const next = { ...latest, musicEpoch: viewer.musicEpoch }; const nextDraft = SaveMusicContact.parse({ profileId: next.profileId, musicEpoch: next.musicEpoch, revision: next.revision, contactQQ: next.contactQQ });
      sessionStorage.setItem(storageKey, JSON.stringify(nextDraft)); setDraft(nextDraft); setSaved(latest);
      client.setQueryData(['private', viewer.scope, 'music-contact', viewer.musicEpoch], latest);
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'member-music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-entry-members'] }); announceAccountChange();
      setMessage(latest.revision === result.revision ? '已保存聯絡 QQ。' : '原操作已保存，聯絡 QQ 已再次變更；請核對目前資料。');
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) { setDraft({ ...pending, requestKey: undefined }); setMessage(error.message); }
      else setMessage('尚未確認保存結果。操作編號已保留，請按「確認聯絡 QQ 結果」安全重試。');
    } finally { setBusy(false); }
  }
  async function rebase() {
    setBusy(true);
    try {
      const latest = await api('/me/music/contact', MusicContact, { headers: { 'X-Account-Scope': viewer.scope } });
      const next = { ...draft, revision: latest.revision }; sessionStorage.setItem(storageKey, JSON.stringify(next)); setStorageError(''); setSaved(latest); setDraft(next);
      setMessage('已取得目前聯絡 QQ；輸入仍保留，請核對後再保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '讀取失敗'); } finally { setBusy(false); }
  }
  return <>{blocker.state === 'blocked' && <Surface role="alert"><Text>仍有聯絡 QQ 草稿或待確認操作。</Text><Button onClick={() => blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={() => blocker.proceed()}>保留草稿並離開</Button></Surface>}
    <Surface className="detail auth-panel"><Heading level={2}>目前聯絡 QQ</Heading><ContactValue key={saved.contactQQ} number={saved.contactQQ} source={saved.contactQQ ? saved.source : ''} />
      <Text>固定成分 ID：<Link to={'/people/' + saved.profileId}>{saved.profileId}</Link></Text>
      {saved.source === 'legacy' ? <Text>舊成分的 QQ 是原資料查詢標識，更正請聯絡管理員。</Text> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="account-field">聯絡 QQ<input inputMode="numeric" autoComplete="off" value={draft.contactQQ} maxLength={24} disabled={busy || !!draft.requestKey || !!readError} onChange={event => { setDraft({ ...draft, contactQQ: event.target.value }); setMessage(''); }} aria-describedby="music-contact-help" /></label>
        <Text id="music-contact-help">4–12 位數字，可清空。成分會員可查詢與複製；號碼不代表 QQ 認證，也不改變成分所有權。</Text>
        <Button type="submit" loading={busy} disabled={!dirty || !!readError}>{draft.requestKey ? '確認聯絡 QQ 結果' : '保存聯絡 QQ'}</Button>
      </form>}
      {dirty && !draft.requestKey && saved.source !== 'legacy' && <Button variant="secondary" disabled={busy || !!readError} onClick={() => void rebase()}>核對目前聯絡 QQ，保留輸入</Button>}
      {message && <Text role="status">{message}</Text>}{storageError && <Text role="alert">{storageError}</Text>}
      {readError && <div role="alert"><Text>{readError}</Text><Button onClick={() => { try { const raw = sessionStorage.getItem(storageKey); if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw); setReadError(''); } catch { setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。'); } }}>保全原稿後繼續</Button></div>}
    </Surface></>;
}
