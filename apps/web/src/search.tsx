import { MusicTranslation } from './music-name-display';
import { uiText } from './language';
import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading } from 'yahha-ui';
import { ActionLink } from './action-link';
import { SearchQuery } from '@qgroup/contracts';
import { Badge, Button, SearchInput } from './kimi-ui';
import { CalendarDays, ChevronLeft, ChevronRight, Music2, UserRound } from 'lucide-react';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { scopedHttp } from './http';
import { searchParameters } from './search-return';
import { activityDisplayDate } from './activity-summary';
import { categoryLabel } from './music-entries';
import { loginLink } from './auth';
import './search.css';

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
  return <div className="global-search-content"><PageIntro title="搜尋" />
    <form className="global-search-form" role="search" onSubmit={event => { event.preventDefault(); if (draft.trim()) setParams({ q: draft.trim() }, { state: location.state }); }}>
      <SearchInput label="搜尋活動、詞條或成分稱呼" placeholder="輸入關鍵字" value={draft} onChange={setDraft} autoFocus/>
      <Button type="submit" disabled={!draft.trim()}>搜尋</Button>
    </form>
    {session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : params.size > 0 && !query ? <Notice>搜尋條件無效，請重新輸入並搜尋。</Notice> : query && <>
      <nav className="search-filters" aria-label="搜尋分類">{Object.entries(labels).map(([group, label]) => <ActionLink variant="ghost" key={group} state={location.state} to={searchPath(query.q, group as keyof typeof labels)} aria-current={query.group === group ? 'page' : undefined}>{label}</ActionLink>)}</nav>
      {result.isPending || !result.isFetchedAfterMount ? <Notice>正在搜尋…</Notice> : result.error ? <Failure error={result.error} retry={() => void result.refetch()} /> : <>
        <div className="search-groups">
          {(query.group === 'all' || query.group === 'activities') && <section aria-label="活動搜尋結果">
            <header className="search-group-header"><Heading level={2}>活動 <span className="search-result-count">{result.data.activities.total}</span></Heading>
              {query.group === 'all' && result.data.activities.hasMore && <Link className="search-more" state={location.state} to={searchPath(query.q, 'activities')}>查看所有活動結果<ChevronRight size={14} aria-hidden="true"/></Link>}
            </header>
            {result.data.activities.items.length ? <ul>{result.data.activities.items.map(item => <li key={item.id}>
              <Link className="global-result" aria-label={item.title} to={target('/activities/' + encodeURIComponent(item.id) + (item.phase === 'draft' ? '/edit' : ''))}>
                <span className="search-result-icon" aria-hidden="true"><CalendarDays size={18}/></span>
                <span className="search-result-copy"><strong>{item.title}</strong><span className="search-result-meta"><span>{activityDisplayDate(item.startsAt, item.timezone)}</span>{item.location && <span>{item.location}</span>}</span></span>
                <ChevronRight className="search-result-arrow" size={16} aria-hidden="true"/>
              </Link>
            </li>)}</ul> : <p className="search-empty" role="status">沒有符合條件且可查看的活動。</p>}
          </section>}
          {(query.group === 'all' || query.group === 'music') && <section aria-label="音樂搜尋結果">
            <header className="search-group-header"><Heading level={2}>音樂詞條 <span className="search-result-count">{result.data.music.total}</span></Heading>
              {query.group === 'all' && result.data.music.hasMore && <Link className="search-more" state={location.state} to={searchPath(query.q, 'music')}>查看所有詞條結果<ChevronRight size={14} aria-hidden="true"/></Link>}
            </header>
            {result.data.music.items.length ? <ul>{result.data.music.items.map(item => <li key={item.id}>
              <Link className="global-result" aria-label={item.name} to={target('/music/entries/' + encodeURIComponent(item.id))}>
                <span className="search-result-icon" aria-hidden="true"><Music2 size={18}/></span>
                <span className="search-result-copy"><strong>{item.name}</strong><MusicTranslation entry={item}/><span className="search-result-meta">{categoryLabel(item.category)}</span></span>
                <span className="search-result-kind"><Badge>{item.kind === 'main' ? '領域' : '細分'}</Badge></span><ChevronRight className="search-result-arrow" size={16} aria-hidden="true"/>
              </Link>
            </li>)}</ul> : <p className="search-empty" role="status">沒有符合條件的詞條。</p>}
          </section>}
          {(query.group === 'all' || query.group === 'people') && <section aria-label="同好搜尋結果">
            <header className="search-group-header"><Heading level={2}>同好{result.data.people.access === 'ready' && <> <span className="search-result-count">{result.data.people.total}</span></>}</Heading>
              {query.group === 'all' && result.data.people.access === 'ready' && result.data.people.hasMore && <Link className="search-more" state={location.state} to={searchPath(query.q, 'people')}>查看所有同好結果<ChevronRight size={14} aria-hidden="true"/></Link>}
            </header>
            {result.data.people.access === 'login_required' ? <div className="search-access"><p className="search-empty" role="status">登入後可搜尋同好。</p><ActionLink variant="ghost" to={loginLink(back)}>登入</ActionLink></div> : result.data.people.access === 'music_required' ? <div className="search-access"><p className="search-empty" role="status">保存成分後可搜尋同好。</p><ActionLink variant="ghost" to={'/me/music?' + new URLSearchParams({ from: back })}>建立或找回成分</ActionLink></div> : result.data.people.items.length ? <ul>{result.data.people.items.map(item => <li key={item.id}>
              <Link className="global-result" aria-label={item.name} to={target('/people/' + encodeURIComponent(item.id))}>
                <span className="search-result-icon" aria-hidden="true"><UserRound size={18}/></span><span className="search-result-copy"><strong>{item.name}</strong></span><ChevronRight className="search-result-arrow" size={16} aria-hidden="true"/>
              </Link>
            </li>)}</ul> : <p className="search-empty" role="status">沒有符合條件的成分稱呼。</p>}
          </section>}
        </div>
        {query.group !== 'all' && (query.page > 1 || result.data[query.group].hasMore) && <nav className="search-pagination" aria-label="搜尋結果分頁">{query.page > 1 && <ActionLink state={location.state} to={searchPath(query.q, query.group, query.page - 1)} startIcon={<ChevronLeft size={16}/>}>上一頁</ActionLink>}{result.data[query.group].hasMore && <ActionLink state={location.state} to={searchPath(query.q, query.group, query.page + 1)}>下一頁<ChevronRight size={16} aria-hidden="true"/></ActionLink>}</nav>}
      </>}
    </>}
  </div>;
}
