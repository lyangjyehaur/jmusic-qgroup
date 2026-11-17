import { useEffect, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { MusicFields, SaveMusicFields } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { announceAccountChange } from './account-session';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
type Fields = z.infer<typeof MusicFields>;
const GenderChoice = z.enum(['', 'female', 'male', 'custom']);
const Draft = z.object({ profileId: z.string(), musicEpoch: z.number().int().min(0), revision: z.number().int().min(0), name: z.string(), note: z.string(), genderChoice: GenderChoice, genderCustom: z.string(), genderPublic: z.boolean(), pending: z.object({ key: z.string().uuid(), input: SaveMusicFields }).strict().optional() }).strict();
type DraftValue = z.infer<typeof Draft>;
function draftFor(fields: Fields, epoch: number): DraftValue {
  const builtIn = ['', 'female', 'male'].includes(fields.gender);
  return { profileId: fields.profileId, musicEpoch: epoch, revision: fields.revision, name: fields.name, note: fields.note, genderChoice: builtIn ? GenderChoice.parse(fields.gender) : 'custom', genderCustom: builtIn ? '' : fields.gender, genderPublic: fields.genderPublic };
}
const valueOf = (draft: DraftValue) => ({ profileId: draft.profileId, musicEpoch: draft.musicEpoch, revision: draft.revision, name: draft.name, note: draft.note, gender: draft.genderChoice === 'custom' ? draft.genderCustom : draft.genderChoice, genderPublic: draft.genderPublic });
export function MusicFieldsPage() {
  return <><PageIntro title="成分資料" /><div className="page-actions"><Link to="/me/music">回到我的成分</Link><Link to="/me/music/contact">聯絡 QQ</Link></div><MusicMemberAccess purpose="編輯成分資料">{viewer => <Loader key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} />}</MusicMemberAccess></>;
}
function Loader({ viewer }: { viewer: Member }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-fields', viewer.musicEpoch], queryFn: () => api('/me/music/fields', MusicFields, { headers: { 'X-Account-Scope': viewer.scope } }), refetchOnWindowFocus: false });
  return query.isPending ? <Notice>正在讀取成分資料…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <Editor viewer={viewer} initial={query.data} />;
}
function Editor({ viewer, initial }: { viewer: Member; initial: Fields }) {
  const client = useQueryClient(); const storageKey = 'qgroup:rebuild:music:fields:v1:' + viewer.scope + ':' + viewer.musicEpoch + ':' + initial.profileId;
  const [loaded] = useState(() => { try { const raw = sessionStorage.getItem(storageKey); return { value: raw ? Draft.parse(JSON.parse(raw)) : draftFor(initial, viewer.musicEpoch), error: '' }; } catch { return { value: draftFor(initial, viewer.musicEpoch), error: '無法讀取成分資料草稿，原始內容已保留。請先保全原稿。' }; } });
  const [draft, setDraft] = useState(loaded.value); const [saved, setSaved] = useState(initial); const [readError, setReadError] = useState(loaded.error);
  const [storageError, setStorageError] = useState(''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const [comparison, setComparison] = useState(false);
  const dirty = !!draft.pending || JSON.stringify(valueOf(draft)) !== JSON.stringify(valueOf(draftFor(saved, viewer.musicEpoch)));
  const blocker = useBlocker(dirty);
  useEffect(() => { if (readError) return; try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); setStorageError(''); } catch { setStorageError('無法保存成分資料草稿，尚未送出修改。'); } }, [draft, readError, storageKey]);
  useEffect(() => { if (!dirty) return; const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave); }, [dirty]);
  function edit(patch: Partial<DraftValue>) { setDraft({ ...draft, ...patch }); setMessage(''); }
  async function save() {
    if (busy || readError) return;
    const input = SaveMusicFields.safeParse(valueOf(draft)); if (!input.success) { setMessage('請檢查欄位內容。'); return; }
    if (!draft.pending && draft.genderChoice === 'custom' && !draft.genderCustom.trim()) { setMessage('請輸入自訂性別，或選擇不填。'); return; }
    const operation = draft.pending ?? { key: crypto.randomUUID(), input: input.data }; const pending = { ...draft, pending: operation };
    try { sessionStorage.setItem(storageKey, JSON.stringify(pending)); setStorageError(''); } catch { setStorageError('無法保存操作編號，尚未送出修改。'); return; }
    setDraft(pending); setBusy(true); setMessage(''); let accepted = false;
    try {
      const result = await api('/me/music/fields', MusicFields, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Idempotency-Key': operation.key }, body: JSON.stringify(operation.input) }); accepted = true;
      const latest = await api('/me/music/fields', MusicFields, { headers: { 'X-Account-Scope': viewer.scope } });
      const next = draftFor(latest, viewer.musicEpoch); sessionStorage.setItem(storageKey, JSON.stringify(next)); setDraft(next); setSaved(latest); setComparison(false);
      client.setQueryData(['private', viewer.scope, 'music-fields', viewer.musicEpoch], latest);
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'member-music'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-entry-members'] });
      void client.invalidateQueries({ queryKey: ['music-catalog'] }); announceAccountChange();
      setMessage(result.revision === latest.revision ? '成分資料已保存。' : '原操作已保存，資料已再次變更；請核對目前內容。');
    } catch (error) {
      if (!accepted && error instanceof ApiError && error.status < 500 && error.status !== 429) { setDraft({ ...pending, pending: undefined }); setMessage(error.message); }
      else setMessage('尚未確認成分資料保存結果。原操作已保留，請按「確認成分資料結果」安全重試。');
    } finally { setBusy(false); }
  }
  async function rebase() {
    setBusy(true);
    try {
      const latest = await api('/me/music/fields', MusicFields, { headers: { 'X-Account-Scope': viewer.scope } });
      if (latest.profileId !== draft.profileId) throw new Error('目前成分已改變，請保留原稿後重新開啟目前成分。');
      const next = { ...draft, revision: latest.revision }; sessionStorage.setItem(storageKey, JSON.stringify(next)); setDraft(next); setSaved(latest); setComparison(true); setStorageError(''); setMessage('已取得目前資料；輸入仍保留，請核對後再保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '讀取失敗'); } finally { setBusy(false); }
  }
  const locked = busy || !!draft.pending || !!readError;
  return <>{blocker.state === 'blocked' && <Surface role="alert"><Text>仍有成分資料草稿或待確認操作。</Text><Button onClick={() => blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={() => blocker.proceed()}>保留草稿並離開</Button></Surface>}
    {comparison && <Surface aria-label="目前已保存的成分資料"><h2>目前已保存的成分資料</h2><dl><dt>成分稱呼</dt><dd>{saved.name}</dd><dt>性別</dt><dd>{saved.gender === 'female' ? '女' : saved.gender === 'male' ? '男' : saved.gender || '不填'} · {saved.genderPublic ? '公開' : '不公開'}</dd><dt>私人留言</dt><dd>{saved.note || '未填寫'}</dd></dl></Surface>}
    <Surface className="detail auth-panel"><form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="account-field">成分稱呼<input value={draft.name} maxLength={Math.max(32, initial.name.length)} disabled={locked} onChange={event => edit({ name: event.target.value })} aria-describedby="music-name-help" /></label><Text id="music-name-help">1–16 字。可與帳號稱呼不同；修改不影響活動名冊或帳務。</Text>
      <div className="account-field"><label htmlFor="music-gender">性別</label><select id="music-gender" value={draft.genderChoice} disabled={locked} onChange={event => { const choice = GenderChoice.parse(event.target.value); edit({ genderChoice: choice, genderPublic: choice ? draft.genderPublic : false }); }}><option value="">不填</option><option value="female">女</option><option value="male">男</option><option value="custom">自訂</option></select></div>
      {draft.genderChoice === 'custom' && <label className="account-field">自訂性別<input value={draft.genderCustom} maxLength={Math.max(24, initial.gender.length)} disabled={locked} onChange={event => edit({ genderCustom: event.target.value })} /></label>}
      <label className="consent"><input type="checkbox" checked={draft.genderPublic} disabled={locked || !draft.genderChoice} onChange={event => edit({ genderPublic: event.target.checked })} /><span>在成分卡公開性別</span></label><Text>未公開的性別不會提供給其他成分會員。</Text>
      <div className="account-field"><label htmlFor="music-private-note">私人留言</label><textarea id="music-private-note" rows={3} maxLength={Math.max(280, initial.note.length)} value={draft.note} disabled={locked} onChange={event => edit({ note: event.target.value })} aria-describedby="music-note-help" /></div><Text id="music-note-help">最多 140 字，可清空。私人留言不會公開展示。</Text>
      <Button type="submit" loading={busy} disabled={!dirty || !!readError}>{draft.pending ? '確認成分資料結果' : '保存成分資料'}</Button>
    </form>{dirty && !draft.pending && <Button variant="secondary" disabled={busy || !!readError} onClick={() => void rebase()}>核對目前成分資料，保留輸入</Button>}
      {message && <Text role="status">{message}</Text>}{storageError && <Text role="alert">{storageError}</Text>}
      {readError && <div role="alert"><Text>{readError}</Text><Button onClick={() => { try { const raw = sessionStorage.getItem(storageKey); if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw); setReadError(''); } catch { setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。'); } }}>保全原稿後繼續</Button></div>}
    </Surface></>;
}
