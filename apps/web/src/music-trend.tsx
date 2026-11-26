import { uiText, displayLocale } from './language';
import { Link, useLocation } from 'react-router-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { MusicTrend } from '@qgroup/contracts';
import { musicTrendSeries } from '@qgroup/domain';
import type { z } from 'zod';
import { createWebHttpClient, scopedHttp } from './http';
import { Failure, Notice } from './shared';
import { MusicMemberAccess, type Member } from './member-access';
import { useMusicWorkspace } from './music-selection';
import { KimiSelectionSummary } from './kimi-music-editor';
import { musicEntryPath } from './music-entry';
import { categoryLabel } from './music-entries';
import { ListMusic } from 'lucide-react';
import { ActionLink } from './action-link';
import { Badge, PageHeader, Disclosure } from './kimi-ui';
import { MusicBrowseTabs } from './music-browse-tabs';
type Trend = z.infer<typeof MusicTrend>;
const colors = [1,2,3,4,5].map(index=>'var(--app-chart-'+index+')');
const validDate = (t: number) => Number.isFinite(new Date(t * 1000).getTime());
const date = (t: number) => validDate(t) ? new Intl.DateTimeFormat(displayLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(t * 1000) : uiText('時間無法顯示');
function Created({ time }: { time: number | null }) {
  return time && validDate(time) ? <time dateTime={new Date(time * 1000).toISOString()}>{date(time)}</time> : <>時間未記錄</>;
}
export function MusicTrendPage() {
  const query = useQuery({ queryKey: ['music-trend'], queryFn: ({ signal }) => createWebHttpClient().requestContract('GET /api/v2/music/trend', { signal }), refetchInterval: 30000, refetchOnMount: 'always' });
  const workspace = useMusicWorkspace(), selection = workspace.state === 'ready' ? workspace.selection : null, location = useLocation();
  const back = '/music' + location.search, from = new URLSearchParams(location.search); from.set('from', '/music/trends' + location.search);
  const entryPath = (id: string) => musicEntryPath(id, from.toString());
  return <div className="kimi page music-page music-trend-page"><PageHeader title="音樂趨勢" actions={<ActionLink variant="primary" to={'/me/music'+location.search} startIcon={<ListMusic size={17}/>}>我的成分{selection&&<Badge tone="green">{selection.selected.size}</Badge>}</ActionLink>}/>
    <MusicBrowseTabs value="trends"/><Link className="back" to={back}>回到音樂詞庫</Link>
    <div className={selection?.dirty ? 'content-columns music-trend-layout' : undefined}><section>
      {query.isPending ? <Notice>正在讀取趨勢…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <>
        <dl className="music-stats" aria-label="趨勢統計">{([[uiText('24 小時新增'), query.data.recent24h], [uiText('7 天新增'), query.data.new7d], [uiText('總計'), query.data.totals]] as const).map(([label, counts]) => <div key={label}><dt>{label}</dt><dd>{counts.entries} 詞條 · {counts.members} 成分</dd></div>)}</dl>
        <Disclosure className="trend-history"  title={<>詞條選用變化</>}><TrendChart trend={query.data} entryPath={entryPath}/></Disclosure>
        <section className="music-trend-recent"><Heading level={2}>最近新增詞條</Heading>
          {query.data.recentEntries.length ? <ul className="trend-entry-list">{query.data.recentEntries.map((entry,index) => <li key={entry.id}><span className="trend-rank">{String(index+1).padStart(2,'0')}</span><Link to={entryPath(entry.id)}>{entry.name}</Link>
            <Text size="sm">{entry.kind === 'main' ? '領域' : '細分'} · {categoryLabel(entry.category)} · {entry.count} 人選用 · <Created time={entry.createdAt} /></Text></li>)}</ul> : <Notice>詞庫尚無詞條。</Notice>}
        </section>
      </>}
      <section className="music-trend-recent" aria-label="最近新增同好"><Heading level={2}>最近新增同好</Heading>
        <MusicMemberAccess purpose={uiText("查看新增同好")}>{viewer => <RecentMembers key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} />}</MusicMemberAccess>
      </section>
    </section>{selection?.dirty && <KimiSelectionSummary selection={selection}/> }</div>
  </div>;
}
function RecentMembers({ viewer }: { viewer: Member }) {
  const location = useLocation();
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-trend-members', viewer.musicEpoch],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/music/trend/members', { signal }), refetchOnMount: 'always', refetchInterval: 30000 });
  if (query.isPending || !query.isFetchedAfterMount) return <Notice>正在讀取新增同好…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  return query.data.members.length ? <ul className="trend-member-list">{query.data.members.map(member => <li key={member.id}>
    <Link to={'/people/' + encodeURIComponent(member.id) + '?' + new URLSearchParams({ from: location.pathname + location.search })}>{member.name}</Link>
    <Text size="sm">成分 ID：{member.id} · <Created time={member.createdAt} /></Text>
  </li>)}</ul> : <Notice>尚無同好成分。</Notice>;
}
function TrendChart({ trend, entryPath }: { trend: Trend; entryPath: (id: string) => string }) {
  const plot = useRef<HTMLDivElement>(null), [width, setWidth] = useState(300);
  useLayoutEffect(() => {
    const element = plot.current; if (!element) return;
    const resize = () => setWidth(Math.max(180, Math.floor(element.getBoundingClientRect().width)));
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { points } = trend, { series, gains, max } = musicTrendSeries(points, trend.entries);
  const height = width < 560 ? 240 : 320, left = 32, right = 8, top = 18, bottom = 34;
  const t0 = points[0]?.t ?? 0, tn = points.at(-1)?.t ?? t0;
  const x = (i: number) => left + (width - left - right) * Math.max(0, Math.min(1, (points[i]!.t - t0) / Math.max(1, tn - t0)));
  const y = (v: number) => top + height - top - bottom - (height - top - bottom) * v / max;
  return <Surface className="detail music-trend-chart"><Heading level={2}>選用人數趨勢</Heading>
    <Text size="sm">每 30 分鐘取樣，最多保留 48 點；離線期間不補點。折線是相鄰快照的新增人數，減少記為 0；漲幅累計新增，不代表淨增。</Text>
    <div ref={plot}>
    {points.length < 2 ? <Notice>尚不足兩個快照，取樣後可查看變化。</Notice> : !series.length ? <Notice>目前快照沒有可顯示的詞條。</Notice> : <>
      <Text size="sm">{points.length} 個快照 · {date(t0)} → {date(tn)}（本機時間）</Text>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="詞條每段新增人數折線圖" className="music-trend-svg">
        <title>詞條每段新增人數</title><desc>完整時間與人數可展開下方快照資料表。</desc>
        {[0, 1, 2, 3].map(step => { const value = max * step / 3; return <g key={step}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".2" strokeDasharray="3 4" /><text x={left - 8} y={y(value) + 4} textAnchor="end" fontSize="12" fill="currentColor">{Number(value.toFixed(1))}</text></g>; })}
        {series.map((row, i) => <g key={row.id}><polyline points={points.map((_, p) => `${x(p)},${y(row.values[p]!)}`).join(' ')} fill="none" stroke={colors[i]} strokeWidth="3" strokeLinejoin="round" strokeDasharray={i % 2 ? '8 3' : undefined} /><circle cx={x(points.length - 1)} cy={y(row.values.at(-1)!)} r="4" fill={colors[i]} /></g>)}
        <text x={left} y={height - 8} fontSize="12" fill="currentColor">{date(t0).split(' ').at(-1)}</text><text x={width - right} y={height - 8} textAnchor="end" fontSize="12" fill="currentColor">{date(tn).split(' ').at(-1)}</text>
      </svg>
      <ul className="music-trend-legend" aria-label="趨勢圖例">{series.map((row, i) => <li key={row.id}><span aria-hidden="true" style={{ background: colors[i] }} /><Link to={entryPath(row.id)}>{row.name}</Link> · 新增 {row.gain} 人</li>)}</ul>
      <Heading level={3}>排行漲幅</Heading>{gains.length ? <ol aria-label="排行漲幅">{gains.map(row => <li key={row.id}><Link to={entryPath(row.id)}>{row.name}</Link> · 目前 {row.count} 人 · +{row.gain} 人</li>)}</ol> : <Notice>這段時間沒有新增選用人數。</Notice>}
      <Disclosure   title={<>快照資料表</>}><div className="music-trend-table" tabIndex={0} role="region" aria-label="快照資料表，可橫向捲動"><table><caption>每段新增人數；欄位對應折線圖例</caption>
        <thead><tr><th scope="col">時間（本機）</th>{series.map(row => <th scope="col" key={row.id}>{row.name}</th>)}</tr></thead>
        <tbody>{points.map((point, p) => <tr key={p}><th scope="row">{date(point.t)}</th>{series.map(row => <td key={row.id}>{row.values[p]}</td>)}</tr>)}</tbody>
      </table></div></Disclosure>
    </>}</div>
  </Surface>;
}
