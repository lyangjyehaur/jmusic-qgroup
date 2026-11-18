import { uiText } from './language';
import { Link, useLocation } from 'react-router-dom';
import { Heading, Text } from 'yahha-ui';
import type { z } from 'zod';
import type { MusicMatchStats, MusicComparePick, MusicSharedPick } from '@qgroup/contracts';
import { musicEntryPath } from './music-entry';
const levelName = (level: number) => ({ 1: uiText("只聽過幾首"), 2: uiText("聽過一些"), 3: uiText("常聽"), 4: uiText("本命") }[level] ?? '');
export function MatchStats({ stats }: { stats: z.infer<typeof MusicMatchStats> }) {
  return <div className="match-stats">
    <Text><strong>{stats.label} · 匹配度 {stats.matchPercent}%</strong></Text>
    <dl><div><dt>嚴格重合</dt><dd>{stats.score}%</dd></div><div><dt>共同詞條</dt><dd>{stats.sharedCount}（領域 {stats.sharedDomain}／細分 {stats.sharedSub}）</dd></div>
      <div><dt>領域重合</dt><dd>{stats.domainRatio === null ? '未選領域' : stats.domainRatio + '%'}</dd></div>
      <div><dt>細分重合</dt><dd>{stats.subRatio === null ? '未選細分' : stats.subRatio + '%'}</dd></div>
      <div><dt>雙方成分</dt><dd>你 {stats.mineCount}／對方 {stats.theirsCount} 項</dd></div>
      <div><dt>共同本命</dt><dd>{stats.bothTop}</dd></div><div><dt>共同冷門詞條</dt><dd>{stats.nicheShared}</dd></div>
    </dl>
    {stats.lowData && <Text>資料較少：你 {stats.mineCount} 項，對方 {stats.theirsCount} 項。</Text>}
    {stats.mineCovered && stats.theirsCovered ? <Text>雙方選擇的詞條相同。</Text> : stats.mineCovered ? <Text>對方包含你選擇的全部詞條。</Text> : stats.theirsCovered ? <Text>你包含對方選擇的全部詞條。</Text> : null}
  </div>;
}
export function ComparedPicks({ title, picks, shared = false, side = 'theirs', fold = false }: {
  title: string; picks: (z.infer<typeof MusicComparePick> | z.infer<typeof MusicSharedPick>)[]; shared?: boolean; side?: 'mine' | 'theirs'; fold?: boolean;
}) {
  const location = useLocation();
  const contents = <>{!picks.length ? <Text>沒有詞條。</Text> : (['main', 'sub'] as const).map(kind => {
    const group = picks.filter(pick => pick.kind === kind);
    return group.length > 0 && <section key={kind} aria-label={title + (kind === 'main' ? '領域' : '細分')}>
      <Heading level={4}>{kind === 'main' ? '領域' : '細分'}</Heading>
      <ul className="match-picks">{group.map(pick => <li key={pick.id}>
        <Link to={musicEntryPath(pick.id, new URLSearchParams({ from: location.pathname + location.search }).toString())}>{pick.name}</Link>
        <span>{shared && 'myLevel' in pick ? '你：' + levelName(pick.myLevel) + '／對方：' + levelName(pick.theirLevel) : (side === 'mine' ? '你：' : '對方：') + levelName(pick.level)}</span>
        <span>{pick.count} 人選用</span>
      </li>)}</ul>
    </section>;
  })}</>;
  return fold && picks.length ? <details className="match-pick-group"><summary>{title} · {picks.length} 項</summary>{contents}</details>
    : <section className="match-pick-group" aria-label={title}><Heading level={3}>{title} · {picks.length} 項</Heading>{contents}</section>;
}
