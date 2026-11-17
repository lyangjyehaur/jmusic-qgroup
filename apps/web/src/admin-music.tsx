import { useEffect, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { AdminMusicHistory, AdminMusicLinkPreview, AdminMusicProfile, AdminMusicProfiles, Ok, SaveMusicLink, type Viewer } from '@qgroup/contracts';
import { AdminGate, adminHeaders, type Access } from './admin';
import { api, ApiError } from './api';
import { announceAccountChange } from './account-session';
import { Failure, Notice, PageIntro } from './shared';
import { AdminMusicPin } from './admin-music-pin';
type Profile = z.infer<typeof AdminMusicProfile>;
const statusLabels = { oauth: 'QQ 授權關聯', prelinked: '預先關聯', unlinked: '未關聯', account: '帳號成分' };
const ownerLabel = (owner: Profile['owner']) => owner ? `${owner.nickname}（${owner.id}）` : '未關聯';
export function AdminMusicDirectory() {
  return <><PageIntro title="成分關聯" /><Link className="back" to="/admin">管理後台</Link><AdminGate>{(viewer, access) => <Directory key={access.scope} viewer={viewer} access={access} />}</AdminGate></>;
}
function Directory({ viewer, access }: { viewer: Viewer; access: Access }) {
  const [input, setInput] = useState(''); const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState({ search: '', status: 'all', offset: 0 });
  const query = useQuery({ queryKey: ['private', viewer.scope, 'admin-music', access.scope, search], queryFn: () => api('/admin/music/search', AdminMusicProfiles, { method: 'POST', headers: adminHeaders(viewer, access), body: JSON.stringify(search) }) });
  return <><Surface className="detail"><form className="directory-search" onSubmit={event => { event.preventDefault(); setSearch({ search: input, status: filter, offset: 0 }); }}>
    <label className="account-field">搜尋成分<input type="search" value={input} maxLength={100} onChange={event => setInput(event.target.value)} /></label>
    <label className="account-field">成分關聯狀態<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><Button type="submit">搜尋</Button>
  </form></Surface>{query.isPending ? <Notice>正在讀取成分…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <>
    <Text role="status">共 {query.data.total} 份成分</Text>{query.data.profiles.map(profile => <Surface className="detail auth-panel" key={profile.id}><Heading level={2}><Link to={'/admin/music/' + profile.id}>{profile.name}</Link></Heading><Text>成分 ID：{profile.id}</Text>{profile.legacyKey && <Text>舊成分查詢標識：{profile.legacyKey}</Text>}<Text>{profile.owner ? statusLabels[profile.status] + ' · ' + ownerLabel(profile.owner) : statusLabels[profile.status]}</Text><Text>原口令：{profile.hasPin ? '已設定' : '未設定'}</Text></Surface>)}
    {!query.data.total && <Notice>沒有符合條件的成分。</Notice>}<div className="page-actions"><Button variant="secondary" disabled={search.offset <= 0} onClick={() => setSearch({ ...search, offset: Math.max(0, search.offset - 20) })}>上一頁</Button><Button variant="secondary" disabled={search.offset + 20 >= query.data.total} onClick={() => setSearch({ ...search, offset: search.offset + 20 })}>下一頁</Button></div>
  </>}</>;
}
export function AdminMusicPage() {
  const { id = '' } = useParams();
  return <><PageIntro title="核對成分關聯" /><Link className="back" to="/admin/music">回到成分關聯</Link><AdminGate>{(viewer, access) => <Loader key={access.scope + ':' + id} id={id} viewer={viewer} access={access} />}</AdminGate></>;
}
function Loader({ id, viewer, access }: { id: string; viewer: Viewer; access: Access }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'admin-music-profile', access.scope, id], queryFn: () => api('/admin/music/' + encodeURIComponent(id), AdminMusicProfile, { headers: { 'X-Account-Scope': viewer.scope } }), refetchOnWindowFocus: false });
  return query.isPending ? <Notice>正在讀取成分…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <Editor initial={query.data} viewer={viewer} access={access} />;
}
const Draft = z.object({ target: z.string(), reason: z.string(), pending: z.object({ key: z.string().uuid(), input: SaveMusicLink }).strict().optional() }).strict();
function Editor({ initial, viewer, access }: { initial: Profile; viewer: Viewer; access: Access }) {
  const client = useQueryClient(); const path = '/admin/music/' + initial.id;
  const storageKey = 'qgroup:rebuild:admin-music:v1:' + viewer.scope + ':' + access.scope + ':' + initial.id;
  const fallback = { target: initial.owner?.id ?? '', reason: '' };
  const [loaded] = useState(() => { try { const raw = sessionStorage.getItem(storageKey); return { value: raw ? Draft.parse(JSON.parse(raw)) : fallback, error: '' }; } catch { return { value: fallback, error: '無法讀取關聯草稿，原始內容已保留。' }; } });
  const [draft, setDraft] = useState<z.infer<typeof Draft>>(loaded.value); const [readError, setReadError] = useState(loaded.error); const [storageError, setStorageError] = useState('');
  const [current, setCurrent] = useState(initial); const [preview, setPreview] = useState<z.infer<typeof AdminMusicLinkPreview> | null>(null);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const [pinDirty, setPinDirty] = useState(false);
  const ownershipDirty = !!draft.pending || draft.target !== (current.owner?.id ?? '') || !!draft.reason;
  const dirty = ownershipDirty || pinDirty;
  const blocker = useBlocker(dirty);
  useEffect(() => { if (readError) return; try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); setStorageError(''); } catch { setStorageError('無法保存關聯草稿，尚未提交修改。'); } }, [draft, storageKey, readError]);
  useEffect(() => { if (!dirty) return; const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave); }, [dirty]);
  async function loadPreview() {
    if (busy || pinDirty || draft.pending || readError) return;
    setBusy(true); setPreview(null); setConfirmed(false); setMessage('');
    try { const result = await api(path + '/link-preview', AdminMusicLinkPreview, { method: 'POST', headers: adminHeaders(viewer, access), body: JSON.stringify({ targetUserId: draft.target.trim() || null }) }); setCurrent(result.profile); setPreview(result); }
    catch (error) { setMessage(error instanceof Error ? error.message : '無法取得預覽'); } finally { setBusy(false); }
  }
  async function save() {
    if (busy || pinDirty || readError || storageError) return;
    const parsed = SaveMusicLink.safeParse({ targetUserId: preview?.target?.id ?? null, revision: preview?.revision, reason: draft.reason, confirm: confirmed });
    if (!draft.pending && (!preview || !parsed.success)) return;
    const operation = draft.pending ?? { key: crypto.randomUUID(), input: parsed.data! }; const pending = { ...draft, pending: operation };
    try { sessionStorage.setItem(storageKey, JSON.stringify(pending)); } catch { setStorageError('無法保存操作編號，尚未提交修改。'); return; }
    setDraft(pending); setBusy(true); setMessage('');
    try {
      await api(path + '/link', Ok, { method: 'POST', headers: { ...adminHeaders(viewer, access), 'Idempotency-Key': operation.key }, body: JSON.stringify(operation.input) });
      const latest = await api(path, AdminMusicProfile, { headers: { 'X-Account-Scope': viewer.scope } });
      const next = { target: latest.owner?.id ?? '', reason: '' }; sessionStorage.setItem(storageKey, JSON.stringify(next)); setDraft(next); setCurrent(latest); setPreview(null); setConfirmed(false);
      client.setQueryData(['private', viewer.scope, 'admin-music-profile', access.scope, initial.id], latest);
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music'] }); void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music-history'] });
      void client.invalidateQueries({ queryKey: ['session'] }); void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'music'] }); announceAccountChange();
      setMessage('關聯操作已完成，請核對目前成分與帳號。');
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) { setDraft({ ...draft, pending: undefined }); setPreview(null); setConfirmed(false); setMessage(error.message); }
      else setMessage('尚未確認關聯結果。原操作已保留，請按「確認關聯結果」安全重試。');
    } finally { setBusy(false); }
  }
  function edit(patch: Partial<z.infer<typeof Draft>>) { setDraft({ ...draft, ...patch }); setPreview(null); setConfirmed(false); }
  return <>{blocker.state === 'blocked' && <Surface role="alert"><Text>{pinDirty ? '仍有未送出的口令或待確認操作；離開後口令不會保存。' : '仍有未保存的關聯草稿或待確認操作。'}</Text><Button onClick={() => blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={() => blocker.proceed()}>{pinDirty ? '保留操作編號並離開' : '保留草稿並離開'}</Button></Surface>}
    <Surface className="detail auth-panel"><Heading level={2}>{current.name}</Heading><Text>成分 ID：{current.id}</Text>{current.legacyKey && <Text>舊成分查詢標識：{current.legacyKey}</Text>}<Text>目前關聯：{ownerLabel(current.owner)}</Text>{current.owner && <Text>關聯狀態：{statusLabels[current.status]}</Text>}<Text>原口令：{current.hasPin ? '已設定' : '未設定'}</Text>
      <ul>{current.selections.map(selection => <li key={selection.entryId}>{selection.name}{selection.kind === 'sub' ? ` · 程度 ${selection.level}` : ''}</li>)}</ul>
      <Link to={path+'/erase'}>刪除此成分</Link>
      <Link to="/admin/users" target="_blank" rel="noreferrer">查找目標帳號 ID</Link>
      <label className="account-field">目標帳號 ID<input value={draft.target} maxLength={128} disabled={busy || pinDirty || !!draft.pending || !!readError} onChange={event => edit({ target: event.target.value })} /></label><Text>留空表示解除關聯。只修改這份成分的管理權，不合併帳號、報名或款項；已有成分的目標帳號不能覆蓋。</Text>
      <div className="account-field"><label htmlFor="music-link-reason">核對原因</label><textarea id="music-link-reason" rows={3} value={draft.reason} maxLength={500} disabled={busy || pinDirty || !!draft.pending || !!readError} onChange={event => edit({ reason: event.target.value })} /></div>
      <Button variant="secondary" loading={busy} disabled={pinDirty || !!draft.pending || !!readError || !!storageError} onClick={() => void loadPreview()}>預覽關聯變更</Button>
      {preview && <><Text>原帳號：{ownerLabel(preview.profile.owner)}</Text><Text>目標帳號：{ownerLabel(preview.target)}</Text><Text>原選擇、稱呼與聯絡資料保留。舊帳號的保存重試與找回授權將失效。</Text><label className="consent"><input type="checkbox" checked={confirmed} disabled={busy || pinDirty} onChange={event => setConfirmed(event.target.checked)} /><span>確認已核對成分與目標帳號，執行此關聯變更</span></label><Button loading={busy} disabled={pinDirty || !confirmed || !draft.reason.trim() || !!storageError} onClick={() => void save()}>保存關聯變更</Button></>}
      {draft.pending && <Button loading={busy} disabled={pinDirty || !!readError || !!storageError} onClick={() => void save()}>確認關聯結果</Button>}
      {message && <Text role="status">{message}</Text>}{storageError && <Text role="alert">{storageError}</Text>}
      {readError && <div role="alert"><Text>{readError}</Text><Button onClick={() => { try { const raw = sessionStorage.getItem(storageKey); if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw); setReadError(''); } catch { setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。'); } }}>保全原稿後繼續</Button></div>}
    </Surface>{/^[0-9]{4,12}$/.test(current.legacyKey) && <AdminMusicPin profile={current} viewer={viewer} access={access} disabled={ownershipDirty || busy || !!readError} onDirty={setPinDirty} onCurrent={profile => { setCurrent(profile); setPreview(null); setConfirmed(false); }} />}<History id={initial.id} viewer={viewer} access={access} />
  </>;
}
function History({ id, viewer, access }: { id: string; viewer: Viewer; access: Access }) {
  const history = useInfiniteQuery({ queryKey: ['private', viewer.scope, 'admin-music-history', access.scope, id], initialPageParam: Number.MAX_SAFE_INTEGER,
    queryFn: ({ pageParam }) => api('/admin/music/' + id + '/history?before=' + pageParam, AdminMusicHistory, { headers: { 'X-Account-Scope': viewer.scope } }), getNextPageParam: page => page.nextCursor ?? undefined });
  return <Surface className="detail auth-panel"><Heading level={2}>關聯變更紀錄</Heading>{history.isPending ? <Notice>正在讀取紀錄…</Notice> : history.error ? <Failure error={history.error} retry={() => void history.refetch()} /> : <>
    {history.data.pages.flatMap(page => page.history).map(row => <div key={row.id}><Text>{row.createdAt} · {row.actor}</Text><Text>{row.beforeUserId ?? '未關聯'} → {row.afterUserId ?? '未關聯'}</Text><Text>{row.source === 'legacy' ? `原關聯紀錄 #${row.legacyId}` : `成分版本 ${row.revision}`}</Text>{row.reason && <Text className="preserve-lines">{row.reason}</Text>}</div>)}
    {!history.data.pages[0]?.history.length && <Notice>目前沒有關聯變更紀錄。</Notice>}{history.hasNextPage && <Button variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>載入更多紀錄</Button>}
  </>}</Surface>;
}
