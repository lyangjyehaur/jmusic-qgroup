import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { MusicCatalog } from '@qgroup/contracts';
import { musicEntryKey } from '@qgroup/domain';
import { api } from './api';
import { Failure, Notice, PageIntro } from './shared';
import { categoryLabel } from './music-entries';
import { Field } from './settlement-controls';
export function Music() {
  const [params, setParams] = useSearchParams(),
    search = params.get('q') ?? '',
    category = params.get('category') ?? '',
    kind = params.get('kind') ?? '',
    input = useRef<HTMLInputElement>(null);
  const query = useQuery({ queryKey: ['music-catalog'], queryFn: () => api('/music/catalog', MusicCatalog) });
  const update = (key: string, value: string) =>
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key === '/' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !target?.closest('input,textarea,select,[contenteditable=true]')
      ) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', focus);
    return () => document.removeEventListener('keydown', focus);
  }, []);
  const key = musicEntryKey(search),
    entries =
      query.data?.entries.filter(
        (e) =>
          (!category || e.category === category) &&
          (!kind || e.kind === kind) &&
          [e.name, ...e.aliases].some((value) => musicEntryKey(value).includes(key)),
      ) ?? [],
    selected = query.data?.entries.find((e) => e.id === params.get('entry'));
  return (
    <>
      <PageIntro title="音樂" />
      <div className="page-actions">
        <Link to="/me/music">編輯我的成分</Link>
        <Link to="/me/music/entries">我的詞條</Link>
        <Link to="/me/music/entries/new">建立詞條</Link>
      </div>
      <section aria-label="音樂詞庫搜尋">
        <Field label="搜尋音樂詞條">
          <input
            ref={input}
            type="search"
            value={search}
            onChange={(event) => update('q', event.target.value)}
            placeholder="名稱或別名"
          />
        </Field>
        {search && (
          <Button variant="secondary" onClick={() => update('q', '')}>
            清除搜尋
          </Button>
        )}
        <div className="page-actions">
          <Field label="詞庫類型">
            <select value={kind} onChange={(event) => update('kind', event.target.value)}>
              <option value="">全部類型</option>
              <option value="main">領域</option>
              <option value="sub">細分</option>
            </select>
          </Field>
          <Field label="詞庫分類">
            <select value={category} onChange={(event) => update('category', event.target.value)}>
              <option value="">全部分類</option>
              {query.data?.categories.map((value) => (
                <option key={value} value={value}>
                  {categoryLabel(value)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>
      {query.isPending ? (
        <Notice>正在讀取詞條…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {selected && (
            <Surface className="detail" role="region" aria-label="詞條資料">
              <Heading level={2}>{selected.name}</Heading>
              <Text>
                {selected.kind === 'main' ? '領域' : '細分'} · {categoryLabel(selected.category)} ·{' '}
                {selected.count} 人選用
              </Text>
              {selected.aliases.length > 0 && <Text>別名：{selected.aliases.join('、')}</Text>}
              {selected.creatorName && <Text>建立者：{selected.creatorName}</Text>}
              <Link to="/me/music">編輯我的選擇</Link>
              <Button variant="ghost" onClick={() => update('entry', '')}>
                關閉詞條資料
              </Button>
            </Surface>
          )}
          {params.get('entry') && !selected && <Notice>這個詞條不存在或已刪除。</Notice>}
          <Surface className="library">
            <Heading level={2}>音樂詞庫</Heading>
            {!entries.length ? (
              <Notice>
                {search || kind || category ? '沒有符合目前搜尋與篩選的詞條。' : '詞庫尚無詞條。'}
              </Notice>
            ) : (
              ['main', 'sub'].map((group) => {
                const subset = entries.filter((e) => e.kind === group);
                return (
                  subset.length > 0 && (
                    <section key={group} aria-label={group === 'main' ? '領域排行' : '細分排行'}>
                      <Heading level={3}>
                        {group === 'main' ? '領域' : '細分'} · {subset.length} 項
                      </Heading>
                      <ol className="music-ranking">
                        {subset.map((e) => (
                          <li key={e.id}>
                            <Link
                              to={
                                '/music?' +
                                new URLSearchParams({ ...Object.fromEntries(params), entry: e.id }).toString()
                              }
                            >
                              {e.name}
                            </Link>
                            <Text>
                              {e.count} 人 · {categoryLabel(e.category)}
                            </Text>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )
                );
              })
            )}
          </Surface>
        </>
      )}
    </>
  );
}
