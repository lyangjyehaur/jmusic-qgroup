import { uiText } from './language';
import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Surface } from 'yahha-ui';
import { Button, Select } from './kimi-ui';
import { createMusicSearchRank, type MusicNames } from '@qgroup/domain';
import { categoryLabel } from './music-entries';
import { Field } from './settlement-controls';

export function useMusicSearchShortcut(selector: string) {
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"]')) return;
      const input = document.querySelector<HTMLInputElement>(selector);
      if (!input || input.closest('[inert],[aria-hidden="true"]') || !input.getClientRects().length) return;
      event.preventDefault();
      input.focus();
    };
    document.addEventListener('keydown', focus);
    return () => document.removeEventListener('keydown', focus);
  }, [selector]);
}
export function useMusicSearch<T extends { id: string; name: string; aliases?: readonly string[]; names?:MusicNames; kind: string; category: string }>(entries: readonly T[]) {
  const [params, setParams] = useSearchParams();
  // React Router's functional search setter is not a queued React state update.
  // Retain event-time edits until navigation commits so a rapid search cannot
  // overwrite an expansion/view/range change using the previous render's URL.
  const latest = useRef({ rendered: params, pending: params });
  if (latest.current.rendered !== params) latest.current = { rendered: params, pending: params };
  const search = params.get('q') ?? '', category = params.get('category') ?? '', kind = params.get('kind') ?? '';
  const match = useMemo(() => createMusicSearchRank(entries), [entries]);
  const filtered = entries.filter(entry => (!kind || entry.kind === kind) && (!category || entry.category === category) && Number.isFinite(match(entry.id, search))).sort((a,b)=>match(a.id,search)-match(b.id,search));
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(latest.current.pending);
    if (value) next.set(key, value); else next.delete(key);
    latest.current.pending = next;
    setParams(next, { replace: true });
  };
  return { search, category, kind, filtered, params, update };
}
export function MusicSearch({ filters, categories, label = uiText('搜尋音樂詞條') }: {
  filters: ReturnType<typeof useMusicSearch>; categories: readonly string[]; label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing &&
        !target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) {
        event.preventDefault(); input.current?.focus();
      }
    };
    document.addEventListener('keydown', focus);
    return () => document.removeEventListener('keydown', focus);
  }, []);
  return <Surface role="region" aria-label="音樂詞庫搜尋" className="music-search">
    <div className="music-search-input">
    <Field label={label}><input ref={input} type="search" value={filters.search}
      placeholder="原名、譯名、別名、讀音或羅馬字" onChange={event => filters.update('q', event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && filters.search) {
        event.preventDefault(); filters.update('q', '');
      } }} /></Field>
    {filters.search && <Button variant="secondary" onClick={() => { filters.update('q', ''); input.current?.focus(); }}>清除搜尋</Button>}
    </div>
    <div className="music-search-filters">
      <Field label="詞庫類型"><Select value={filters.kind} onChange={event => filters.update('kind', event.target.value)}>
        <option value="">全部類型</option><option value="main">領域</option><option value="sub">細分</option>
        {filters.kind && !['main', 'sub'].includes(filters.kind) && <option value={filters.kind}>未支援的類型</option>}
      </Select></Field>
      <Field label="詞庫分類"><Select value={filters.category} onChange={event => filters.update('category', event.target.value)}>
        <option value="">全部分類</option>{categories.map(category => <option key={category} value={category}>{categoryLabel(category)}</option>)}
        {filters.category && !categories.includes(filters.category) && <option value={filters.category}>{categoryLabel(filters.category)}（目前無詞條）</option>}
      </Select></Field>
    </div>
  </Surface>;
}
