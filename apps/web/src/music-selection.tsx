import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Outlet, useBlocker, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import { MusicCatalog, Profile, SaveProfile, Selection, Session, type MusicProfile } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { Failure, Notice, useSession } from './shared';
import { musicPeopleReturn, musicTrendReturn } from './music-return';
import { announceAccountChange } from './account-session';
import type { Member } from './member-access';
type CatalogEntry = z.infer<typeof MusicCatalog>['entries'][number];
const isWorkspace = (pathname: string) => pathname === '/music' || pathname === '/music/trends' || pathname === '/me/music' || pathname === '/me/music/share' || /^\/music\/entries\/[^/]+$/.test(pathname);
const Draft = z.object({ profileId: z.string().nullable().default(null), musicEpoch: z.number().int().min(0).default(0), revision: z.number().int().min(0), selections: z.array(Selection).max(20), requestKey: z.string().uuid().optional() }).strict();
type DraftValue = z.infer<typeof Draft>;
function useMusicSelection({ viewer, initial, entries }: { viewer: Member; initial: MusicProfile; entries: CatalogEntry[] }) {
  const storageKey = 'qgroup:rebuild:music:v1:' + viewer.scope;
  const [storageError, setStorageError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [loaded] = useState((): { draft: DraftValue; error: string } => {
    const fallback = { profileId: initial?.id ?? null, musicEpoch: viewer.musicEpoch, revision: initial?.revision ?? 0, selections: initial?.selections ?? [] };
    try {
      const raw = sessionStorage.getItem(storageKey); const saved: DraftValue = raw ? Draft.parse(JSON.parse(raw)) : fallback;
      const sameSavedChoices = !saved.requestKey && saved.profileId === fallback.profileId && saved.musicEpoch === fallback.musicEpoch && JSON.stringify(saved.selections) === JSON.stringify(fallback.selections);
      const untouchedBlank = !saved.requestKey && saved.profileId === null && saved.revision === 0 && saved.selections.length === 0;
      return { draft: sameSavedChoices || untouchedBlank ? fallback : saved, error: '' };
    }
    catch { return { draft: fallback, error: '此分頁的原草稿無法讀取，已保留原始內容。請先保全原稿再繼續。' }; }
  });
  const [draft, setDraft] = useState(loaded.draft);
  const [readError, setReadError] = useState(loaded.error);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(initial);
  const [params] = useSearchParams();
  const from = params.get('from');
  const validReturn = from && /^\/activities\/[^/?#]+(?:#participants)?$/.test(from) ? from : musicPeopleReturn(from) ?? musicTrendReturn(from);
  const [returnTo, setReturnTo] = useState(validReturn);
  useEffect(() => { if (validReturn) setReturnTo(validReturn); }, [validReturn]);
  const queryClient = useQueryClient();
  const dirty = !!draft.requestKey || draft.profileId !== (saved?.id ?? null) || draft.musicEpoch !== viewer.musicEpoch || draft.revision !== (saved?.revision ?? 0) || JSON.stringify(draft.selections) !== JSON.stringify(saved?.selections ?? []);
  // Cached empty profiles can refresh after a term explicitly creates a blank profile.
  // Adopt a refreshed baseline only while pristine; drafts and pending requests keep their original revision.
  useEffect(() => {
    if (dirty || readError || JSON.stringify(initial) === JSON.stringify(saved)) return;
    setSaved(initial);
    setDraft({ profileId: initial?.id ?? null, musicEpoch: viewer.musicEpoch,
      revision: initial?.revision ?? 0, selections: initial?.selections ?? [] });
  }, [initial, saved, dirty, readError, viewer.musicEpoch]);
  const blocker = useBlocker(({ nextLocation }) => dirty && !isWorkspace(nextLocation.pathname));
  useEffect(() => {
    if (!dirty) return;
    const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  useEffect(() => {
    if (readError) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); setStorageError(''); }
    catch { setStorageError('瀏覽器無法保存草稿，請先允許本站儲存；目前不會送出修改。'); }
  }, [draft, storageKey, readError]);
  const selected = new Map(draft.selections.map(s => [s.entryId, s.level]));
  const mainCount = entries.filter(e => e.kind === 'main' && selected.has(e.id)).length;
  const subCount = entries.filter(e => e.kind === 'sub' && selected.has(e.id)).length;
  function toggle(entry: CatalogEntry) {
    if (draft.requestKey || sending || readError) return;
    setMessage('');
    if (selected.has(entry.id)) setDraft({ ...draft, selections: draft.selections.filter(s => s.entryId !== entry.id) });
    else if ((entry.kind === 'main' && mainCount >= 5) || (entry.kind === 'sub' && subCount >= 15) || selected.size >= 20) setMessage('領域最多 5 項、細分最多 15 項，合計最多 20 項。');
    else setDraft({ ...draft, selections: [...draft.selections, { entryId: entry.id, level: 3 }] });
  }
  async function save() {
    if (readError || storageError || sending) return;
    const parsed = SaveProfile.safeParse({ profileId: draft.profileId, musicEpoch: draft.musicEpoch, revision: draft.revision, selections: draft.selections });
    if (!parsed.success) { setMessage('請至少選擇一個詞條，再保存。'); return; }
    const pending = { ...draft, requestKey: draft.requestKey ?? crypto.randomUUID() };
    // Persist intent and key before sending. Lost responses retry the exact original operation.
    try { sessionStorage.setItem(storageKey, JSON.stringify(pending)); } catch { setStorageError('無法保存操作草稿，尚未送出。'); return; }
    setDraft(pending); setSending(true); setMessage('');
    try {
      const result = await api('/me/music', Profile.unwrap(), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': viewer.csrf, 'X-Account-Scope': viewer.scope, 'Idempotency-Key': pending.requestKey }, body: JSON.stringify(parsed.data) });
      await queryClient.cancelQueries({ queryKey: ['private', viewer.scope, 'music', draft.musicEpoch] });
      if (!mounted.current) return;
      setSaved(result); setDraft({ profileId: result.id, musicEpoch: draft.musicEpoch, revision: result.revision, selections: result.selections });
      queryClient.setQueryData(['private', viewer.scope, 'music', draft.musicEpoch], result);
      void queryClient.invalidateQueries({ queryKey: ['music-catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['music-trend'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-trend-members'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-entries'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-entry-members'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'member-music'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-matches'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-circles'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-comparison'] });
      void queryClient.invalidateQueries({ queryKey: ['private', viewer.scope, 'music-share'] });
      announceAccountChange();
      setMessage('已保存。');
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
        setDraft({ ...draft, requestKey: undefined });
        setMessage(error.message);
      } else setMessage('尚未確認保存結果。選擇與操作編號已保留，請按「確認保存結果」安全重試。');
    } finally { if (mounted.current) setSending(false); }
  }
  async function rebase() {
    if (sending || draft.requestKey || readError) return;
    setSending(true);
    try {
      const latest = await api('/me/music', Profile, { headers: { 'X-Account-Scope': viewer.scope } });
      const session = await api('/session', Session);
      if (!mounted.current) return;
      if (!session.authenticated || session.scope !== viewer.scope) throw new Error('目前帳號已變更，請重新整理');
      queryClient.setQueryData(['private', viewer.scope, 'music', session.musicEpoch], latest);
      setSaved(latest); setDraft({ profileId: latest?.id ?? null, musicEpoch: session.musicEpoch, revision: latest?.revision ?? 0, selections: draft.selections });
      setMessage('已取得最新版本；你的選擇仍保留，請核對後再保存。');
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : '讀取失敗'); }
    finally { if (mounted.current) setSending(false); }
  }
  function preserve() {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw);
      setReadError('');
    } catch { setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。'); }
  }
  function level(entryId: string, value: number) {
    if (draft.requestKey || sending || readError) return;
    setMessage('');
    setDraft({ ...draft, selections: draft.selections.map(s => s.entryId === entryId ? { ...s, level: value } : s) });
  }
  function remove(entryId: string) {
    if (draft.requestKey || sending || readError) return;
    setMessage('');
    setDraft({ ...draft, selections: draft.selections.filter(s => s.entryId !== entryId) });
  }
  return { viewer, initial, entries, draft, saved, dirty, selected, mainCount, subCount, returnTo,
    storageError, readError, message, sending, blocker, save, rebase, toggle, level, remove, preserve,
    locked: !!draft.requestKey || sending || !!readError };
}
export type MusicSelection = ReturnType<typeof useMusicSelection>;
type Workspace = { state: 'ready'; selection: MusicSelection } | { state: 'pending' | 'guest' } | { state: 'error'; error: Error; retry: () => void };
const Context = createContext<Workspace>({ state: 'pending' });
export const useMusicWorkspace = () => useContext(Context);
export function MusicWorkspace() {
  const session = useSession(), viewer = session.data?.authenticated ? session.data : null;
  const profile = useQuery({ queryKey: ['private', viewer?.scope, 'music', viewer?.musicEpoch],
    queryFn: () => api('/me/music', Profile, { headers: { 'X-Account-Scope': viewer!.scope } }), enabled: !!viewer, refetchOnMount: 'always' });
  const catalog = useQuery({ queryKey: ['music-catalog'], queryFn: () => api('/music/catalog', MusicCatalog) });
  // A failed public background refresh must not unmount the draft/save controller.
  // Child pages show its read error and retry; private/session failures still gate access.
  const error = session.error ?? profile.error ?? (catalog.data ? null : catalog.error);
  if (viewer && profile.isFetchedAfterMount && profile.data !== undefined && catalog.data && !error) return <ReadyWorkspace
    key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} initial={profile.data} entries={catalog.data.entries} />;
  // The ready controller adds selection hooks and a blocker. Mount the interactive
  // outlet only after initialization so it cannot be replaced during the first input.
  if (error) return <Failure error={error} retry={() => {
    void session.refetch(); if (viewer) void profile.refetch(); void catalog.refetch();
  }} />;
  if (session.isPending || viewer) return <Notice>正在確認成分…</Notice>;
  return <Context.Provider value={{ state: 'guest' }}><Outlet /></Context.Provider>;
}
function ReadyWorkspace(props: { viewer: Member; initial: MusicProfile; entries: CatalogEntry[] }) {
  const selection = useMusicSelection(props);
  return <Context.Provider value={{ state: 'ready', selection }}>
    {selection.blocker.state === 'blocked' && <Surface className="leave-prompt" role="alert">
      <Heading level={2}>還有未保存的選擇</Heading><Text>這個分頁已保留草稿，回來後可繼續編輯。</Text>
      <Button onClick={() => selection.blocker.reset?.()}>繼續編輯</Button>
      <Button variant="secondary" onClick={() => selection.blocker.proceed?.()}>保留草稿並離開</Button>
    </Surface>}
    <Outlet />
  </Context.Provider>;
}
