import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { MusicCatalog } from '@qgroup/contracts';
import { api } from './api';
import { Failure, Notice, PageIntro } from './shared';
import { categoryLabel } from './music-entries';
import { MusicSearch, useMusicSearch } from './music-search';
import { useMusicWorkspace } from './music-selection';
import { SelectionPanel } from './music-editor';
export function Music() {
  const query = useQuery({ queryKey: ['music-catalog'], queryFn: () => api('/music/catalog', MusicCatalog) });
  const filters = useMusicSearch(query.data?.entries ?? []);
  const { params, search, category, kind, update } = filters;
  const entries = filters.filtered;
  const selected = query.data?.entries.find(entry => entry.id === params.get('entry'));
  const workspace = useMusicWorkspace();
  const selection = workspace.state === 'ready' ? workspace.selection : null;
  return (
    <>
      <PageIntro title="音樂" />
      <div className="page-actions">
        {!selection && <Link to="/me/music">編輯我的成分</Link>}
        <Link to="/me/music/entries">我的詞條</Link>
        <Link to="/me/music/entries/new">建立詞條</Link>
      </div>
      {workspace.state === 'error' && !query.error && <Failure error={workspace.error} retry={workspace.retry} />}
      <div className={selection ? 'content-columns music-editor' : undefined}><section>
      <MusicSearch filters={filters} categories={query.data?.categories ?? []} />
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
              {selection ? <Button aria-pressed={selection.selected.has(selected.id)} disabled={selection.locked}
                onClick={() => selection.toggle(selected)}>{selection.selected.has(selected.id) ? '取消選取' : '選取此詞條'}</Button>
                : <Link to="/me/music">編輯我的選擇</Link>}
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
      </section>{selection && <SelectionPanel selection={selection} />}</div>
    </>
  );
}
