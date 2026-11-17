import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import type { z } from 'zod';
import { MusicMatches, MusicComparison } from '@qgroup/contracts';
import { peopleReturn } from './music-return';
import { api } from './api';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { ContactValue } from './music-contact-value';
import { CopyMusicValue } from './music-copy';
import { ComparedPicks, MatchStats } from './music-match-view';
export function MusicRecommendations({ viewer }: { viewer: Member }) {
  const [params, setParams] = useSearchParams(), sort = params.get('sort') === 'familiar' ? 'familiar' : 'rare';
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-matches', viewer.musicEpoch, sort],
    queryFn: ({ signal }) => api('/music/matches?sort=' + sort, MusicMatches, { signal, headers: { 'X-Account-Scope': viewer.scope } }), refetchOnMount: 'always', refetchInterval: 10000 });
  return <section aria-label="同好推薦" className="music-recommendations"><Heading level={2}>同好推薦</Heading>
    <label className="match-sort">排序<select aria-label="排序" value={sort} onChange={event => setParams(old => { const next = new URLSearchParams(old); next.set('sort', event.target.value); return next; }, { replace: true })}>
      <option value="rare">共同項／冷門優先</option><option value="familiar">我的熟悉度優先</option>
    </select></label>
    <details><summary>匹配度與排序規則</summary><Text>嚴格重合按領域 55%、細分 45% 及雙方較低熟悉度計算；四檔權重為 0.3／0.5／0.8／1，只有一種類型時使用該類完整比重。匹配度為 100 × √嚴格重合率；共同 1／2／3 項上限為 36／49／64%。</Text>
      <Text>共同項／冷門排序依共同項數、證據折算分及冷門項數；熟悉度排序先看你的共同本命與熟悉度。對方選擇不超過 3 項時另列，按共同項數、嚴格重合及冷門項數由少至多排序；熟悉度排序不使用證據折算分。冷門詞條為不超過 2 人選用。</Text></details>
    {query.isPending || !query.isFetchedAfterMount ? <Notice>正在尋找同好…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <>
      {!query.data.mine.length ? <Notice>尚未選擇詞條，請先<Link to="/me/music">保存成分選擇</Link>。</Notice>
        : !query.data.matches.length && !query.data.sparseMatches.length ? <Notice>目前沒有選擇相同詞條的同好。</Notice> : null}
      {query.data.matches.length > 0 && <section aria-label="推薦名單"><Heading level={3}>推薦名單 · {query.data.matches.length} 人</Heading>
        <ol className="music-matches">{query.data.matches.slice(0, 3).map(row => <li key={row.member.id}><MatchCard row={row} /></li>)}</ol>
        {query.data.matches.length > 3 && <details><summary>其餘同好 · {query.data.matches.length - 3} 人</summary>
          <ol start={4} className="music-matches">{query.data.matches.slice(3).map(row => <li key={row.member.id}><MatchCard row={row} /></li>)}</ol></details>}
      </section>}
      {query.data.sparseMatches.length > 0 && <details aria-label="資料較少的同好"><summary>資料較少的同好 · {query.data.sparseMatches.length} 人</summary>
        <ol className="music-matches">{query.data.sparseMatches.map(row => <li key={row.member.id}><MatchCard row={row} /></li>)}</ol></details>}
    </>}
  </section>;
}
function MatchCard({ row }: { row: z.infer<typeof MusicMatches>['matches'][number] }) {
  const [params] = useSearchParams(), from = '/people' + (params.size ? '?' + params : '');
  const member = row.member;
  return <Surface className="match-card"><Heading level={3}><Link to={'/people/' + member.id + '?' + new URLSearchParams({ from })}>{member.name}</Link></Heading>
    {member.gender && <Text>性別：{({ female: '女', male: '男' } as Record<string, string>)[member.gender] ?? member.gender}</Text>}
    <MatchStats stats={row.stats} />
    <ComparedPicks title="共同喜歡" picks={row.shared} shared />
    <ComparedPicks title="對方獨有" picks={row.onlyTheirs} fold />
    {member.note && <Text className="match-note">對方的留言：{member.note}</Text>}
    <ContactValue key={member.contactQQ} number={member.contactQQ} source={member.contactSource} />
    <div className="page-actions"><CopyMusicValue value={member.name} label="名稱" /><CopyMusicValue value={member.id} label="成分 ID" />
      <Link to={'/people/' + member.id + '/compare?' + new URLSearchParams({ from })}>比較成分</Link></div>
  </Surface>;
}
export function MusicComparisonPage() {
  const { id = '' } = useParams(), [params] = useSearchParams(), back = peopleReturn(params.get('from')) ?? '/people';
  return <><PageIntro title="成分比較" /><div className="page-actions"><Link to={back}>回到同好推薦</Link><Link to={'/people/' + encodeURIComponent(id) + '?' + new URLSearchParams({ from: back })}>查看同好成分</Link></div>
    <MusicMemberAccess>{viewer => <Comparison key={viewer.scope + ':' + viewer.musicEpoch + ':' + id} viewer={viewer} id={id} />}</MusicMemberAccess></>;
}
function Comparison({ viewer, id }: { viewer: Member; id: string }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-comparison', viewer.musicEpoch, id],
    queryFn: ({ signal }) => api('/music/profiles/' + encodeURIComponent(id) + '/comparison', MusicComparison, { signal, headers: { 'X-Account-Scope': viewer.scope } }), refetchOnMount: 'always', refetchInterval: 10000 });
  if (query.isPending || !query.isFetchedAfterMount) return <Notice>正在比較成分…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  const result = query.data;
  return <Surface className="music-comparison"><Heading level={2}>{result.me.name}／{result.other.name}</Heading>
    <MatchStats stats={result.stats} />
    {result.other.note && <Text className="match-note">對方的留言：{result.other.note}</Text>}
    <ComparedPicks title="共同喜歡" picks={result.shared} shared />
    <ComparedPicks title="只有你選擇" picks={result.onlyMine} side="mine" fold />
    <ComparedPicks title="只有對方選擇" picks={result.onlyTheirs} fold />
    <details><summary>雙方完整成分</summary><ComparedPicks title="你的完整成分" picks={result.mine} side="mine" /><ComparedPicks title="對方完整成分" picks={result.theirs} /></details>
  </Surface>;
}
