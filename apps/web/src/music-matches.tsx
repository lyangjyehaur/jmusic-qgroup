import { MusicQQPrompt } from './music-qq-prompt';
import { CircleHelp, GitCompareArrows } from 'lucide-react';
import { Avatar, Badge, Select, Disclosure } from './kimi-ui';
import { ActionLink } from './action-link';
import { musicEntryPath } from './music-entry';
import { uiText } from './language';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import type { z } from 'zod';
import { MusicMatches } from '@qgroup/contracts';
import { peopleReturn, musicTrendReturn, musicCircleReturn, musicShoutReturn } from './music-return';
import { useMusicMatchSort } from './music-match-sort';
import { scopedHttp } from './http';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { ContactValue } from './music-contact-value';
import { CopyMusicValue } from './music-copy';
import { ComparedPicks, MatchStats } from './music-match-view';
import { MusicTermButton } from './music-term-button';
export function MusicRecommendations({ viewer }: { viewer: Member }) {
  const { sort, change } = useMusicMatchSort();
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-matches', viewer.musicEpoch, sort],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/music/matches', { signal, query: { sort } }), refetchOnMount: 'always', refetchInterval: 10000 });
  return <section aria-label="同好推薦" className="music-recommendations"><MusicQQPrompt viewer={viewer}/><div className="recommend-toolbar"><div><Heading level={2}>推薦名單</Heading>{query.data&&<p>依已保存成分計算，共 {query.data.matches.length} 位有共同喜好</p>}</div>
    <Select aria-label="排序" value={sort} onChange={event => change(event.target.value === 'familiar' ? 'familiar' : 'rare')}>
      <option value="rare">共同項／冷門優先</option><option value="familiar">我的熟悉度優先</option>
    </Select></div>
    <Disclosure className="match-rules sort-rules"  title={<><CircleHelp size={15}/>匹配度與排序規則</>}><Text>嚴格重合按領域 55%、細分 45% 及雙方較低熟悉度計算；四檔權重為 0.3／0.5／0.8／1，只有一種類型時使用該類完整比重。匹配度為 100 × √嚴格重合率；共同 1／2／3 項上限為 36／49／64%。</Text>
      <Text>共同項／冷門排序依共同項數、證據折算分及冷門項數；熟悉度排序先看你的共同本命與熟悉度。對方選擇不超過 3 項時另列，按共同項數、嚴格重合及冷門項數由少至多排序；熟悉度排序不使用證據折算分。冷門詞條為不超過 2 人選用。</Text></Disclosure>
    {query.isPending || !query.isFetchedAfterMount ? <Notice>正在尋找同好…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <>
      {!query.data.mine.length ? <Notice>尚未選擇詞條，請先<Link to="/me/music">保存成分選擇</Link>。</Notice>
        : !query.data.matches.length && !query.data.sparseMatches.length ? <Notice>目前沒有選擇相同詞條的同好。</Notice> : null}
      {query.data.matches.length > 0 && <section aria-label="推薦名單" className="recommendations-list"><Heading level={3} className="sr-only">推薦名單 · {query.data.matches.length} 人</Heading>
        <ol className="people-grid" role="list">{query.data.matches.slice(0, 3).map((row,index) => <li key={row.member.id}><MatchCard row={row} rank={index+1}/></li>)}</ol>
        {query.data.matches.length > 3 && <Disclosure className="more-matches"  title={<>其餘同好 · {query.data.matches.length - 3} 人</>}>
          <ol start={4} className="people-grid" role="list">{query.data.matches.slice(3).map(row => <li key={row.member.id}><MatchCard row={row} /></li>)}</ol></Disclosure>}
      </section>}
      {query.data.sparseMatches.length > 0 && <section className="sparse-section"><div className="section-title-row"><div><Heading level={2}>資料較少的同好</Heading><p>選擇不超過 3 項，匹配結果僅供參考</p></div><Badge>{query.data.sparseMatches.length} 位</Badge></div>
        <ol className="people-grid sparse-people-grid" role="list">{query.data.sparseMatches.slice(0,6).map(row=><li key={row.member.id}><MatchCard row={row} compact/></li>)}</ol>
        {query.data.sparseMatches.length>6&&<Disclosure className="more-matches" title={<>其餘資料較少的同好 · {query.data.sparseMatches.length-6} 人</>}><ol start={7} className="people-grid sparse-people-grid" role="list">{query.data.sparseMatches.slice(6).map(row=><li key={row.member.id}><MatchCard row={row} compact/></li>)}</ol></Disclosure>}
      </section>}
    </>}
  </section>;
}
function MatchCard({ row, rank, compact=false }: { row: z.infer<typeof MusicMatches>['matches'][number]; rank?: number; compact?:boolean }) {
  const [params] = useSearchParams(), from='/people'+(params.size?'?'+params:''), member=row.member;
  const level=(value:number)=>({1:uiText('只聽過幾首'),2:uiText('聽過一些'),3:uiText('常聽'),4:uiText('本命')}[value]);
  return <article className={'person-card match-card'+(compact?' match-card-compact':'')}><header><div className="person-identity">{rank&&<span className="recommend-rank">{String(rank).padStart(2,'0')}</span>}<Link className="person-name-link" aria-label={member.name} to={'/people/'+member.id+'?'+new URLSearchParams({from})}><span aria-hidden="true"><Avatar user={{name:member.name,avatar:member.name.slice(0,1),avatarUrl:member.avatarUrl,color:'var(--app-accent)'}} size="sm"/></span><span className="person-heading"><strong>{member.name}</strong><small>{member.contactQQ?'QQ '+member.contactQQ:row.stats.theirsCount+' 項成分'}</small></span></Link></div><div className="match-score"><strong>{row.stats.matchPercent}<small>%</small></strong><span>匹配度</span></div></header>
    <div className="common-summary"><span>共同喜好 <strong>{row.stats.sharedCount}</strong></span><Badge>嚴格重合 {row.stats.score}%</Badge>{row.stats.bothTop>0&&<Badge tone="green">共同本命 {row.stats.bothTop}</Badge>}</div>
    {!compact&&<div className="common-terms">{row.shared.slice(0,4).map(pick=><div key={pick.id}><Link to={musicEntryPath(pick.id,new URLSearchParams({from}).toString())}>{pick.name}</Link><MusicTermButton entryId={pick.id}/>{pick.kind==='sub'&&<span><em className={pick.myLevel===4?'favorite':''}>我・{level(pick.myLevel)}</em><i/><em className={pick.theirLevel===4?'favorite':''}>對方・{level(pick.theirLevel)}</em></span>}</div>)}</div>}

    <footer><div><ActionLink to={'/people/'+member.id+'?'+new URLSearchParams({from})} size="sm">成分卡</ActionLink><ActionLink variant="ghost" size="sm" to={'/people/'+member.id+'/compare?'+new URLSearchParams({from})} startIcon={<GitCompareArrows size={14}/>}>比較成分</ActionLink></div></footer>
    <Disclosure className="profile-extras" title={<>更多成分資料</>}><MatchStats stats={row.stats}/><ComparedPicks title="共同喜歡" picks={row.shared} shared allowSelection/><ComparedPicks title="對方獨有" picks={row.onlyTheirs} fold allowSelection/>
    {member.note&&<Text className="match-note">對方的留言：{member.note}</Text>}{member.gender&&<Text>性別：{member.gender}</Text>}<ContactValue number={member.contactQQ} source={member.contactSource}/>
    <Disclosure className="copy-profile"  title={<>複製資料</>}><CopyMusicValue value={member.name} label="名稱"/></Disclosure></Disclosure>
  </article>;
}
export function MusicComparisonPage() {
  const { id = '' } = useParams(), [params] = useSearchParams(), back = peopleReturn(params.get('from')) ?? musicTrendReturn(params.get('from')) ?? musicCircleReturn(params.get('from')) ?? musicShoutReturn(params.get('from')) ?? '/people';
  return <><PageIntro title="成分比較" /><div className="page-actions"><Link to={back}>{back.startsWith('/music/trends') ? '回到音樂趨勢' : back.startsWith('/people/shouts') ? '回到找搭子' : back.startsWith('/people/circles') ? '回到同好圈子' : new URL(back,'https://local.invalid').searchParams.get('tab')==='search'?'回到查詢／比較':'回到同好推薦'}</Link><Link to={'/people/' + encodeURIComponent(id) + '?' + new URLSearchParams({ from: back })}>查看同好成分</Link></div>
    <MusicMemberAccess>{viewer => <Comparison key={viewer.scope + ':' + viewer.musicEpoch + ':' + id} viewer={viewer} id={id} />}</MusicMemberAccess></>;
}
function Comparison({ viewer, id }: { viewer: Member; id: string }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-comparison', viewer.musicEpoch, id],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/music/profiles/:id/comparison', { signal, params: { id } }), refetchOnMount: 'always', refetchInterval: 10000 });
  if (query.isPending || !query.isFetchedAfterMount) return <Notice>正在比較成分…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  const result = query.data;
  return <Surface className="music-comparison"><Heading level={2}>{result.me.name}／{result.other.name}</Heading>
    <MatchStats stats={result.stats} />
    {result.other.note && <Text className="match-note">對方的留言：{result.other.note}</Text>}
    <ComparedPicks title="共同喜歡" picks={result.shared} shared />
    <ComparedPicks title="只有你選擇" picks={result.onlyMine} side="mine" fold />
    <ComparedPicks title="只有對方選擇" picks={result.onlyTheirs} fold />
    <Disclosure   title={<>雙方完整成分</>}><ComparedPicks title="你的完整成分" picks={result.mine} side="mine" /><ComparedPicks title="對方完整成分" picks={result.theirs} /></Disclosure>
  </Surface>;
}
