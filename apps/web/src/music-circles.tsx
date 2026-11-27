import { uiText } from './language';
import { useContext } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading, Text } from 'yahha-ui';
import { UsersRound } from 'lucide-react';
import { Avatar, Select, Disclosure } from './kimi-ui';
import { MusicCircles } from '@qgroup/contracts';
import type { z } from 'zod';
import { MusicMemberAccess, type Member } from './member-access';
import { scopedHttp } from './http';
import { EmbeddedPageContext, Failure, Notice, PageIntro } from './shared';
import { musicEntryPath } from './music-entry';
type Circle = z.infer<typeof MusicCircles>['clusters'][number];
export function MusicCirclesPage() {
  const embedded=useContext(EmbeddedPageContext);
  return <>{!embedded&&<><PageIntro title="同好圈子" /><Link className="back" to="/people">回到同好</Link></>}
    <MusicMemberAccess purpose={uiText("查看同好圈子")}>{viewer => <Circles key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} />}</MusicMemberAccess></>;
}
function Circles({ viewer }: { viewer: Member }) {
  const [params, setParams] = useSearchParams(), raw = params.get('minLink');
  const minLink = raw !== null && /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 100 ? Number(raw) : 40;
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-circles', viewer.musicEpoch, minLink],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/music/circles', { signal, query: { minLink } }),
    refetchOnMount: 'always', refetchInterval: 30000 });
  return <section className="people-circles"><div className="circle-toolbar"><Heading level={2}>圈子名單</Heading><Select label="圈子連結門檻" aria-label="圈子連結門檻" value={minLink} onChange={event => setParams(old => { const next = new URLSearchParams(old); next.set('minLink', event.target.value); return next; }, { replace: true })}>
    {[...new Set([20, 40, 60, 80, 100, minLink])].sort((a, b) => a - b).map(value => <option key={value} value={value}>嚴格重合 {value}%</option>)}
  </Select></div>
    <Disclosure className="circle-rules" title={<>圈子如何計算</>}><Text size="sm">依已保存成分計算。與圈內任一人嚴格重合達門檻就連入同圈，不代表每兩人都達門檻；嚴格重合不同於推薦頁的校準匹配度。</Text></Disclosure>
    {query.isPending || !query.isFetchedAfterMount ? <Notice>正在分析同好圈子…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <>
      <dl className="people-summary" aria-label="圈子統計"><div><dt>已選成分</dt><dd>{query.data.membersWithSelection} 人</dd></div><div><dt>圈子</dt><dd>{query.data.clusters.length} 個</dd></div><div><dt>未連入圈子</dt><dd>{query.data.singles} 人</dd></div></dl>
      {!query.data.membersWithSelection ? <Notice>尚無已選詞條的成分。請<Link to="/me/music">保存成分選擇</Link>後再查看。</Notice> : <>
        {query.data.clusters.length ? <section aria-label="圈子名單">
          <Text id="music-circle-tags-help" size="sm">常見詞條按圈內選用次數排列；同名詞條合計，不代表所有人共同選擇。</Text>
          <div className="circle-grid">{query.data.clusters.slice(0, 8).map((circle, index) => <CircleCard key={circle.members.map(m => m.id).join(':')} circle={circle} index={index} />)}</div>
          {query.data.clusters.length > 8 && <Disclosure className="more-matches" title={<>其餘圈子 · {query.data.clusters.length - 8} 個</>}><div className="circle-grid">{query.data.clusters.slice(8).map((circle, index) => <CircleCard key={circle.members.map(m => m.id).join(':')} circle={circle} index={index + 8} />)}</div></Disclosure>}
        </section> : <Notice>目前門檻下沒有兩人以上的圈子，可調整連結門檻。</Notice>}
        {query.data.singleMembers.length > 0 && <section aria-label="未連入圈子名單"><Heading level={2}>未連入圈子 · {query.data.singles} 人</Heading><ul className="music-circle-singles">{query.data.singleMembers.map(member => <SingleMember key={member.id} member={member} />)}</ul></section>}
      </>}
    </>}
  </section>;
}
function CircleCard({ circle, index }: { circle: Circle; index: number }) {
  const location = useLocation(), from = location.pathname + location.search;
  const members=(items:Circle['members'])=><ul className="music-circle-members">{items.map(member=><li key={member.id}><Link to={'/people/'+encodeURIComponent(member.id)+'?'+new URLSearchParams({from})}><span aria-hidden="true"><Avatar user={{name:member.name,avatar:member.name.slice(0,1),color:'var(--app-accent)'}} size="sm"/></span><span>{member.name}</span></Link></li>)}</ul>;
  return <article className="music-circle" aria-label={'圈子 ' + (index + 1)}><header className="circle-card-heading"><UsersRound size={20}/><Heading level={3}>圈子 {index + 1} · {circle.size} 人</Heading></header>
    {members(circle.members.slice(0,8))}
    {circle.members.length>8&&<Disclosure className="circle-more-members" title={<>其餘成員 · {circle.members.length-8} 人</>}>{members(circle.members.slice(8))}</Disclosure>}
    <Heading level={4} aria-describedby="music-circle-tags-help">常見詞條</Heading>
    {circle.tags.length ? <ul className="music-circle-tags">{circle.tags.map(tag => <li key={tag.name}>
      {tag.entries.length === 1 ? <Link to={musicEntryPath(tag.entries[0]!.id, new URLSearchParams({ from }).toString())}>{tag.name}</Link> : <>{tag.name}<ul>{tag.entries.map(entry => <li key={entry.id}><Link to={musicEntryPath(entry.id, new URLSearchParams({ from }).toString())}>{entry.kind === 'main' ? '領域' : '細分'} · {entry.id}</Link></li>)}</ul></>} · {tag.count} 次
    </li>)}</ul> : <Notice>目前詞庫沒有可顯示的共同項目。</Notice>}
  </article>;
}
function SingleMember({ member }: { member: z.infer<typeof MusicCircles>['singleMembers'][number] }) {
  const location = useLocation(), from = location.pathname + location.search;
  return <li><Link to={'/people/' + encodeURIComponent(member.id) + '?' + new URLSearchParams({ from })}>{member.name}</Link><Text size="sm">{member.pickCount} 個詞條{member.pickCount > 8 ? '，列出前 8 個' : ''}</Text>
    {member.picks.length ? <ul>{member.picks.map(entry => <li key={entry.id}><Link to={musicEntryPath(entry.id, new URLSearchParams({ from }).toString())}>{entry.name}</Link></li>)}</ul> : <Text>選擇的詞條已不在目前詞庫。</Text>}
  </li>;
}
