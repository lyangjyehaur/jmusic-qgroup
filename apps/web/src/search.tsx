import { uiText } from './language';
import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading } from 'yahha-ui';
import { Button } from './kimi-ui';
import { SearchQuery } from '@qgroup/contracts';
import { Badge, SearchInput } from './kimi-ui';
import { ArrowUpRight } from 'lucide-react';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { scopedHttp } from './http';
import { searchParameters } from './search-return';
import { activityDisplayDate } from './activity-summary';
import { categoryLabel } from './music-entries';
import { loginLink } from './auth';

const labels = { all: uiText('全部'), activities: uiText('活動'), music: uiText('音樂詞條'), people: uiText('同好') } as const;
function searchPath(q: string, group: keyof typeof labels = 'all', page = 1) {
  const params = new URLSearchParams({ q });
  if (group !== 'all') params.set('group', group);
  if (page !== 1) params.set('page', String(page));
  return '/search?' + params;
}
export function SearchPage() {
  const [params] = useSearchParams();
  return <SearchContent key={params.toString()} />;
}
function SearchContent() {
  const location = useLocation();
  const [params, setParams] = useSearchParams(), parsed = SearchQuery.safeParse(searchParameters(params));
  const session = useSession(), viewer = session.data;
  const [draft, setDraft] = useState(params.get('q') ?? '');
  // The keyed route child restores the submitted URL value on browser Back.
  const query = parsed.success ? parsed.data : null;
  const result = useQuery({ queryKey: ['private', viewer?.scope, 'search', viewer?.authenticated ? viewer.musicEpoch : null, query?.q, query?.group, query?.page],
    queryFn: ({ signal }) => scopedHttp(viewer!.scope).requestContract('GET /api/v2/search', { signal, query: query! }),
    enabled: !!viewer && !!query, staleTime: 0, refetchOnMount: 'always' });
  const back = query ? searchPath(query.q, query.group, query.page) : '/search';
  const target = (path: string) => path + '?' + new URLSearchParams({ from: back });
  return <><PageIntro title="搜尋" />
    <form className="global-search-form" role="search" onSubmit={event => { event.preventDefault(); if (draft.trim()) setParams({ q: draft.trim() }, { state: location.state }); }}>
      <SearchInput label="搜尋活動、詞條或成分稱呼" placeholder="輸入關鍵字" value={draft} onChange={setDraft} autoFocus/>
      <Button type="submit" disabled={!draft.trim()}>搜尋</Button>
    </form>
    {session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : params.size > 0 && !query ? <Notice>搜尋條件無效，請重新輸入並搜尋。</Notice> : query && <>
      <div className="page-actions search-filters" aria-label="搜尋分類">{Object.entries(labels).map(([group, label]) => <Link key={group} state={location.state} to={searchPath(query.q, group as keyof typeof labels)} aria-current={query.group === group ? 'page' : undefined}>{label}</Link>)}</div>
      {result.isPending || !result.isFetchedAfterMount ? <Notice>正在搜尋…</Notice> : result.error ? <Failure error={result.error} retry={() => void result.refetch()} /> : <>
        <div className="search-groups">
          {(query.group === 'all' || query.group === 'activities') && <section aria-label="活動搜尋結果"><Heading level={2}>活動（{result.data.activities.total}）</Heading>
            {result.data.activities.items.length ? <ul>{result.data.activities.items.map(item => <li key={item.id}><Link className="global-result" aria-label={item.title} to={target('/activities/' + encodeURIComponent(item.id) + (item.phase === 'draft' ? '/edit' : ''))}><Badge>活動</Badge><span><strong>{item.title}</strong><small>{activityDisplayDate(item.startsAt, item.timezone)} · {item.location}</small></span><ArrowUpRight size={16}/></Link></li>)}</ul> : <Notice>沒有符合條件且可查看的活動。</Notice>}
            {query.group === 'all' && result.data.activities.hasMore && <Link state={location.state} to={searchPath(query.q, 'activities')}>查看所有活動結果</Link>}
          </section>}
          {(query.group === 'all' || query.group === 'music') && <section aria-label="音樂搜尋結果"><Heading level={2}>音樂詞條（{result.data.music.total}）</Heading>
            {result.data.music.items.length ? <ul>{result.data.music.items.map(item => <li key={item.id}><Link className="global-result" aria-label={item.name} to={target('/music/entries/' + encodeURIComponent(item.id))}><Badge>詞條</Badge><span><strong>{item.name}</strong><small>{item.kind === 'main' ? '領域' : '細分'} · {categoryLabel(item.category)}</small></span><ArrowUpRight size={16}/></Link></li>)}</ul> : <Notice>沒有符合條件的詞條。</Notice>}
            {query.group === 'all' && result.data.music.hasMore && <Link state={location.state} to={searchPath(query.q, 'music')}>查看所有詞條結果</Link>}
          </section>}
          {(query.group === 'all' || query.group === 'people') && <section aria-label="同好搜尋結果"><Heading level={2}>{result.data.people.access === 'ready' ? '同好（' + result.data.people.total + '）' : '同好'}</Heading>
            {result.data.people.access === 'login_required' ? <><Notice>登入後可搜尋同好。</Notice><Link to={loginLink(back)}>登入</Link></> : result.data.people.access === 'music_required' ? <><Notice>保存成分後可搜尋同好。</Notice><Link to={'/me/music?' + new URLSearchParams({ from: back })}>建立或找回成分</Link></> : result.data.people.items.length ? <ul>{result.data.people.items.map(item => <li key={item.id}><Link className="global-result" aria-label={item.name} to={target('/people/' + encodeURIComponent(item.id))}><Badge>同好</Badge><span><strong>{item.name}</strong></span><ArrowUpRight size={16}/></Link></li>)}</ul> : <Notice>沒有符合條件的成分稱呼。</Notice>}
          </section>}
        </div>
        {query.group !== 'all' && <div className="pagination">{query.page > 1 && <Link state={location.state} to={searchPath(query.q, query.group, query.page - 1)}>上一頁</Link>}{result.data[query.group].hasMore && <Link state={location.state} to={searchPath(query.q, query.group, query.page + 1)}>下一頁</Link>}</div>}
        {query.group === 'all' && result.data.people.access === 'ready' && result.data.people.hasMore && <Link state={location.state} to={searchPath(query.q, 'people')}>查看所有同好結果</Link>}
      </>}
    </>}
  </>;
}
