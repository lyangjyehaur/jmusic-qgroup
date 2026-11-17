import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from 'yahha-ui';
import { createMusicSearch } from '@qgroup/domain';
import { categoryLabel } from './music-entries';
import { Field } from './settlement-controls';
export function useMusicSearch<T extends { id: string; name: string; aliases?: readonly string[]; kind: string; category: string }>(entries: readonly T[]) {
  const [params, setParams] = useSearchParams();
  // React Router's functional search setter is not a queued React state update.
  // Retain event-time edits until navigation commits so a rapid search cannot
  // overwrite an expansion/view/range change using the previous render's URL.
  const latest = useRef({ rendered: params, pending: params });
  if (latest.current.rendered !== params) latest.current = { rendered: params, pending: params };
  const search = params.get('q') ?? '', category = params.get('category') ?? '', kind = params.get('kind') ?? '';
  const match = useMemo(() => createMusicSearch(entries), [entries]);
  const filtered = entries.filter(entry => (!kind || entry.kind === kind) && (!category || entry.category === category) && match(entry.id, search));
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(latest.current.pending);
    if (value) next.set(key, value); else next.delete(key);
    latest.current.pending = next;
    setParams(next, { replace: true });
  };
  return { search, category, kind, filtered, params, update };
}
export function MusicSearch({ filters, categories, label = '搜尋音樂詞條' }: {
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
  return <section aria-label="音樂詞庫搜尋">
    <Field label={label}><input ref={input} type="search" value={filters.search}
      placeholder="名稱、別名、拼音或首字母" onChange={event => filters.update('q', event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && filters.search) {
        event.preventDefault(); filters.update('q', '');
      } }} /></Field>
    {filters.search && <Button variant="secondary" onClick={() => { filters.update('q', ''); input.current?.focus(); }}>清除搜尋</Button>}
    <div className="page-actions">
      <Field label="詞庫類型"><select value={filters.kind} onChange={event => filters.update('kind', event.target.value)}>
        <option value="">全部類型</option><option value="main">領域</option><option value="sub">細分</option>
        {filters.kind && !['main', 'sub'].includes(filters.kind) && <option value={filters.kind}>未支援的類型</option>}
      </select></Field>
      <Field label="詞庫分類"><select value={filters.category} onChange={event => filters.update('category', event.target.value)}>
        <option value="">全部分類</option>{categories.map(category => <option key={category} value={category}>{categoryLabel(category)}</option>)}
        {filters.category && !categories.includes(filters.category) && <option value={filters.category}>{categoryLabel(filters.category)}（目前無詞條）</option>}
      </select></Field>
    </div>
  </section>;
}
