import { uiText } from './language';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heading, Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import type { z } from 'zod';
import type { MusicCatalogEntry } from '@qgroup/contracts';
import { rankMusic, musicRankLimit, musicBubbleLayout, musicBubbleLabel } from '@qgroup/domain';
import { categoryLabel } from './music-entries';
import { musicEntryPath } from './music-entry';
import { MusicTermButton } from './music-term-button';

type Entry = z.infer<typeof MusicCatalogEntry>;
export function MusicRanking({ entries, kind, complete, params, update, selected }: {
  entries: Entry[]; kind: 'main' | 'sub'; complete: boolean; params: URLSearchParams;
  update: (key: string, value: string) => void; selected: ReadonlyMap<string, number> | null;
}) {
  const name = kind === 'main' ? uiText('領域') : uiText('細分'), sorted = rankMusic(entries);
  const expanded = params.get(kind + 'Expanded') === '1', bubbles = params.get(kind + 'View') === 'bubbles';
  const limit = musicRankLimit(kind, expanded, complete);
  return <section aria-label={name + '排行'} className="music-rank-group">
    <div className="music-rank-header"><Heading level={3}>{name} · {entries.length} 項</Heading>
    <div className="page-actions music-view-switch" aria-label={name + '顯示方式'}>
      <Button size="sm" variant="secondary" aria-pressed={!bubbles} onClick={() => update(kind + 'View', '')}>{name}清單</Button>
      <Button size="sm" variant="secondary" aria-pressed={bubbles} onClick={() => update(kind + 'View', 'bubbles')}>{name}氣泡</Button>
    </div>
    </div>
    {bubbles ? <MusicBubbles entries={sorted} selected={selected} name={name} search={params.toString()} /> : <>
      <ol className="music-ranking" role="list">
        {sorted.slice(0, limit).map((entry, index) => <li key={entry.id} className={selected?.has(entry.id) ? 'is-selected' : undefined}>
          <span className="music-rank-position" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div className="music-rank-copy">
          <Link to={'/music?' + new URLSearchParams({ ...Object.fromEntries(params), entry: entry.id })}>{entry.name}</Link>
          <Text>{categoryLabel(entry.category)}{selected?.has(entry.id) ? ' · 已選' : ''}</Text>
          </div><Text className="music-rank-count">{entry.count} 人</Text>{selected&&<MusicTermButton entryId={entry.id}/>}
        </li>)}
      </ol>
      {!complete && sorted.length > 10 && <div className="page-actions">
        <Button variant="secondary" aria-expanded={expanded} onClick={() => update(kind + 'Expanded', expanded ? '' : '1')}>
          {expanded ? '收合' + name + '排行' : kind === 'main' ? '展開全部領域' : '展開細分前 20 名'}
        </Button>
        {kind === 'sub' && sorted.length > 20 && <Button variant="secondary" onClick={() => update('library', 'all')}>查看完整細分詞庫</Button>}
      </div>}
    </>}
  </section>;
}
function MusicBubbles({ entries, selected, name, search }: {
  entries: Entry[]; selected: ReadonlyMap<string, number> | null; name: string; search: string;
}) {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const resize = () => { if (node.clientWidth > 0) setWidth(node.clientWidth); };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const layout = musicBubbleLayout(entries, width);
  return <div ref={container} className="music-bubbles">
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" height={layout.height} role="group" aria-label={name + '氣泡圖'}>
      {layout.circles.map(({ entry, x, y, radius }) => {
        const chosen = selected?.has(entry.id), lines = musicBubbleLabel(entry.name, radius);
        return <Link key={entry.id} to={musicEntryPath(entry.id, search)} aria-label={entry.name + '，' + entry.count + ' 人' + (chosen ? '，已選' : '')}
          className={chosen ? 'is-selected' : undefined}>
          <title>{entry.name + ' · ' + entry.count + ' 人' + (chosen ? ' · 已選' : '')}</title>
          <circle cx={x} cy={y} r={radius} />
          <text x={x} y={y - (lines.length - 1) * 8 - 6} textAnchor="middle" aria-hidden="true">
            {lines.map((line, i) => <tspan key={i} x={x} dy={i ? 16 : 0}>{line}</tspan>)}
            <tspan x={x} dy={22} className="bubble-count">{entry.count} 人{chosen ? ' · 已選' : ''}</tspan>
          </text>
        </Link>;
      })}
    </svg>
  </div>;
}
