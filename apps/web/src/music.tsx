import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface } from 'yahha-ui';
import { MusicCatalog } from '@qgroup/contracts';
import { createWebHttpClient } from './http';
import { Failure, Notice, PageIntro } from './shared';
import { MusicRanking } from './music-ranking';
import { MusicSearch, useMusicSearch } from './music-search';
import { useMusicWorkspace } from './music-selection';
import { SelectionPanel } from './music-editor';
import { MusicEntryDetails } from './music-entry';
export function Music() {
  const http=createWebHttpClient();
  const query = useQuery({ queryKey: ['music-catalog'], queryFn: ({ signal }) => http.request('GET /api/v2/music/catalog', { signal }, MusicCatalog), refetchInterval: 10000 });
  const filters = useMusicSearch(query.data?.entries ?? []);
  const { params, search, category, kind, update } = filters;
  const entries = filters.filtered;
  const filtering = !!(search || category || kind);
  const complete = params.get('library') === 'all' || filtering;
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
        <Link to={'/music/trends' + (params.size ? '?' + params : '')}>音樂趨勢</Link>
      </div>
      {workspace.state === 'error' && !query.error && <Failure error={workspace.error} retry={workspace.retry} />}
      {query.data && <dl className="music-stats" aria-label="音樂統計">
        <div><dt>成分</dt><dd>{query.data.stats.members}</dd></div>
        <div><dt>詞條</dt><dd>{query.data.stats.entries}</dd></div>
        <div><dt>24 小時新增成分</dt><dd>{query.data.stats.recentMembers24h}</dd></div>
        <div><dt>24 小時新增詞條</dt><dd>{query.data.stats.recentEntries24h}</dd></div>
      </dl>}
      <div className={selection ? 'content-columns music-editor' : undefined}><section>
      <MusicSearch filters={filters} categories={query.data?.categories ?? []} />
      {query.isPending ? (
        <Notice>正在讀取詞條…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {selected && <MusicEntryDetails key={selected.id} entry={selected} close={() => update('entry', '')} />}
          {params.get('entry') && !selected && <Notice>這個詞條不存在或已刪除。</Notice>}
          <Surface className="library">
            <Heading level={2}>{filtering ? '搜尋結果' : complete ? '音樂詞庫' : '熱門排行'}</Heading>
            {!filtering && <div className="page-actions" aria-label="詞庫範圍">
              <Button variant="secondary" aria-pressed={params.get('library') !== 'all'} onClick={() => update('library', '')}>熱門排行</Button>
              <Button variant="secondary" aria-pressed={params.get('library') === 'all'} onClick={() => update('library', 'all')}>完整詞庫</Button>
            </div>}
            {!entries.length ? (
              <Notice>
                {search || kind || category ? '沒有符合目前搜尋與篩選的詞條。' : '詞庫尚無詞條。'}
              </Notice>
            ) : (
              (['main', 'sub'] as const).map(group => {
                const subset = entries.filter(entry => entry.kind === group);
                return subset.length > 0 && <MusicRanking key={group} entries={subset} kind={group} complete={complete}
                  params={params} update={update} selected={selection?.selected ?? null} />;
              })
            )}
          </Surface>
        </>
      )}
      </section>{selection && <SelectionPanel selection={selection} />}</div>
    </>
  );
}
