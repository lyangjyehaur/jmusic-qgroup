import { useEffect, useState } from 'react';
import { Link, useBlocker, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text, TextField } from 'yahha-ui';
import { z } from 'zod';
import { Profile, SaveProfile, Selection, Session, type MusicEntry, type MusicProfile, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { PageIntro } from './shared';
const Draft = z.object({ profileId: z.string().nullable().default(null), musicEpoch: z.number().int().min(0).default(0), revision: z.number().int().min(0), selections: z.array(Selection).max(20), requestKey: z.string().uuid().optional() }).strict();
type DraftValue = z.infer<typeof Draft>;
export function ProfileEditor({ viewer, initial, entries }: { viewer: Extract<Viewer, { authenticated: true }>; initial: MusicProfile; entries: MusicEntry[] }) {
  const storageKey = 'qgroup:rebuild:music:v1:' + viewer.scope;
  const [storageError, setStorageError] = useState('');
  const [loaded] = useState((): { draft: DraftValue; error: string } => {
    const fallback = { profileId: initial?.id ?? null, musicEpoch: viewer.musicEpoch, revision: initial?.revision ?? 0, selections: initial?.selections ?? [] };
    try { const saved = sessionStorage.getItem(storageKey); return { draft: saved ? Draft.parse(JSON.parse(saved)) : fallback, error: '' }; }
    catch { return { draft: fallback, error: '此分頁的原草稿無法讀取，已保留原始內容。請先保全原稿再繼續。' }; }
  });
  const [draft, setDraft] = useState(loaded.draft);
  const [readError, setReadError] = useState(loaded.error);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState('');
  const [saved, setSaved] = useState(initial);
  const [params] = useSearchParams();
  const from = params.get('from');
  const returnTo = from && /^\/activities\/[^/?#]+$/.test(from) ? from : null;
  const queryClient = useQueryClient();
  const dirty = !!draft.requestKey || draft.revision !== (saved?.revision ?? 0) || JSON.stringify(draft.selections) !== JSON.stringify(saved?.selections ?? []);
  const blocker = useBlocker(dirty);
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
  function toggle(entry: MusicEntry) {
    if (draft.requestKey || sending) return;
    setMessage('');
    if (selected.has(entry.id)) setDraft({ ...draft, selections: draft.selections.filter(s => s.entryId !== entry.id) });
    else if ((entry.kind === 'main' && mainCount >= 5) || (entry.kind === 'sub' && subCount >= 15) || selected.size >= 20) setMessage('大類最多 5 項、細項最多 15 項，合計最多 20 項。');
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
      setSaved(result); setDraft({ profileId: result.id, musicEpoch: draft.musicEpoch, revision: result.revision, selections: result.selections });
      queryClient.setQueryData(['private', viewer.scope, 'music', draft.musicEpoch], result);
      setMessage('已保存。');
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
        setDraft({ ...draft, requestKey: undefined });
        setMessage(error.message);
      } else setMessage('尚未確認保存結果。選擇與操作編號已保留，請按「確認保存結果」安全重試。');
    } finally { setSending(false); }
  }
  async function rebase() {
    try {
      const latest = await api('/me/music', Profile, { headers: { 'X-Account-Scope': viewer.scope } });
      const session = await api('/session', Session);
      if (!session.authenticated || session.scope !== viewer.scope) throw new Error('目前帳號已變更，請重新整理');
      setSaved(latest); setDraft({ profileId: latest?.id ?? null, musicEpoch: session.musicEpoch, revision: latest?.revision ?? 0, selections: draft.selections });
      setMessage('已取得最新版本；你的選擇仍保留，請核對後再保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '讀取失敗'); }
  }
  return <><PageIntro title="我的成分">{viewer.nickname} 的音樂成分</PageIntro>{returnTo && <Link className="back" to={returnTo}>← 回到剛才的活動</Link>}
    {blocker.state === 'blocked' && <Surface className="leave-prompt" role="alert"><Heading level={2}>還有未保存的選擇</Heading><Text>這個分頁已保留草稿，回來後可繼續編輯。</Text><Button onClick={() => blocker.reset()}>繼續編輯</Button><Button variant="secondary" onClick={() => blocker.proceed()}>保留草稿並離開</Button></Surface>}
    {storageError && <p role="alert" className="notice">{storageError}</p>}
    {readError && <div role="alert" className="notice"><Text>{readError}</Text><Button variant="secondary" onClick={() => {
      try { const raw = sessionStorage.getItem(storageKey); if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw); setReadError(''); }
      catch { setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。'); }
    }}>保全原稿，從已保存版本開始</Button></div>}
    <div className="content-columns music-editor"><section><TextField label="尋找喜歡的音樂" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋風格、歌手、樂團…" />
      {(['main', 'sub'] as const).map(kind => <Surface className="selection-group" key={kind}><Heading level={2}>{kind === 'main' ? '音樂大類' : '歌手與細項'} <small>{kind === 'main' ? `${mainCount} / 5` : `${subCount} / 15`}</small></Heading><div className="choice-list">{entries.filter(e => e.kind === kind && e.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(entry => <Button key={entry.id} variant={selected.has(entry.id) ? 'primary' : 'secondary'} aria-pressed={selected.has(entry.id)} disabled={!!draft.requestKey || sending} onClick={() => toggle(entry)}>{entry.name}</Button>)}</div>{!entries.some(e => e.kind === kind && e.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <Text tone="muted">{search ? '沒有符合的詞條。' : '詞庫尚未匯入。'}</Text>}</Surface>)}
    </section><aside><Surface variant="note" className="aside-note"><Heading level={2}>我的選擇 <small>{selected.size} / 20</small></Heading>{draft.selections.length ? <ul className="selected-list">{draft.selections.map(s => <li key={s.entryId}><label><span>{entries.find(e => e.id === s.entryId)?.name ?? '已移除的詞條'}</span>{entries.find(e => e.id === s.entryId)?.kind === 'sub' && <select aria-label={(entries.find(e => e.id === s.entryId)?.name ?? s.entryId) + '喜歡程度'} value={s.level} disabled={!!draft.requestKey || sending} onChange={e => setDraft({ ...draft, selections: draft.selections.map(v => v.entryId === s.entryId ? { ...v, level: Number(e.target.value) } : v) })}>{[[4, '本命'], [3, '常聽'], [2, '聽過一些'], [1, '只聽過幾首']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</label><Button variant="ghost" size="sm" aria-label={'移除' + (entries.find(e => e.id === s.entryId)?.name ?? s.entryId)} disabled={!!draft.requestKey || sending} onClick={() => setDraft({ ...draft, selections: draft.selections.filter(v => v.entryId !== s.entryId) })}>移除</Button></li>)}</ul> : <Text tone="muted">請選擇詞條。</Text>}
      <div className="editor-actions"><span className="mobile-summary" role="status">已選 {selected.size} / 20<small>{message ? dirty ? '請核對保存提示' : '已保存' : dirty ? '有未保存的選擇' : '尚未選擇詞條'}</small></span><Button className="save" loading={sending} disabled={!!storageError || !!readError || !dirty} onClick={() => void save()}>{draft.requestKey ? '確認保存結果' : '保存我的成分'}</Button></div>
      {message && <p role="status" className="save-message">{message}</p>}
      {!draft.requestKey && draft.revision !== (initial?.revision ?? 0) && <Text size="sm">正在編輯版本 {draft.revision}</Text>}
      {!draft.requestKey && dirty && <Button variant="ghost" disabled={sending} onClick={() => void rebase()}>核對最新版本，保留我的選擇</Button>}
      <Text size="sm" tone="muted">{dirty ? '尚有未保存的修改' : saved ? '所有選擇已保存' : '選擇後即可建立成分'} · 草稿只留在此分頁</Text>
    </Surface></aside></div></>;
}
