import { MusicTranslation } from './music-name-display';
import { uiText } from './language';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Heading, Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import type { z } from 'zod';
import type { MusicCatalogEntry } from '@qgroup/contracts';
import { rankMusic, musicRankLimit } from '@qgroup/domain';
import { musicBubbleLayout, musicBubbleTypography } from './music-bubble-layout';
import { categoryLabel } from './music-entries';
import { musicEntryPath } from './music-entry';
import { MusicTermButton } from './music-term-button';

const bubblePalette=['#ff8fab','#fca5c8','#c084fc','#a78bfa','#818cf8','#60a5fa','#38bdf8','#34d399','#a3e635','#fbbf24','#fb923c','#f87171','#f472b6','#e879f9','#2dd4bf','#93c5fd'];
function bubbleColor(id:string){let h=0;for(let i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return bubblePalette[h%bubblePalette.length];}
type Entry = z.infer<typeof MusicCatalogEntry>;
export function MusicRanking({ entries, kind, complete, params, update, showComplete, bubblesByDefault=false, selected }: {
  entries: Entry[]; kind: 'main' | 'sub'; complete: boolean; params: URLSearchParams;
  update: (key: string, value: string) => void; showComplete: () => void; bubblesByDefault?:boolean; selected: ReadonlyMap<string, number> | null;
}) {
  const name = kind === 'main' ? uiText('領域') : uiText('細分'), q=params.get('q');
  const sorted = useMemo(()=>q?entries:rankMusic(entries),[entries,q]);
  const expanded = params.get(kind + 'Expanded') === '1', bubbles = (params.get(kind + 'View') ?? (bubblesByDefault?'bubbles':'list')) === 'bubbles';
  const limit = musicRankLimit(kind, expanded, complete);
  return <section aria-label={name + '排行'} className="music-rank-group">
    <div className="music-rank-header"><Heading level={3}>{name} · {entries.length} 項</Heading>
    <div className="page-actions music-view-switch" aria-label={name + '顯示方式'}>
      <Button size="sm" variant="secondary" aria-pressed={!bubbles} onClick={() => update(kind + 'View', 'list')}>{name}清單</Button>
      <Button size="sm" variant="secondary" aria-pressed={bubbles} onClick={() => update(kind + 'View', 'bubbles')}>{name}氣泡</Button>
    </div>
    </div>
    {bubbles ? <MusicBubbles entries={sorted} selected={selected} kind={kind} name={name} search={params.toString()} /> : <>
      <ol className="music-ranking" role="list">
        {sorted.slice(0, limit).map((entry, index) => <li key={entry.id} className={selected?.has(entry.id) ? 'is-selected' : undefined}>
          <span className="music-rank-position" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div className="music-rank-copy">
          <Link to={'/music?' + new URLSearchParams({ ...Object.fromEntries(params), entry: entry.id })}>{entry.name}</Link><MusicTranslation entry={entry}/>
          <Text>{categoryLabel(entry.category)}{selected?.has(entry.id) ? ' · 已選' : ''}</Text>
          </div><Text className="music-rank-count">{entry.count} 人</Text>{selected&&<MusicTermButton entryId={entry.id}/>}
        </li>)}
      </ol>
      {!complete && sorted.length > 10 && <div className="page-actions">
        <Button variant="secondary" aria-expanded={expanded} onClick={() => update(kind + 'Expanded', expanded ? '' : '1')}>
          {expanded ? '收合' + name + '排行' : kind === 'main' ? '展開全部領域' : '展開細分前 20 名'}
        </Button>
        {kind === 'sub' && sorted.length > 20 && <Button variant="secondary" onClick={showComplete}>查看完整細分詞庫</Button>}
      </div>}
    </>}
  </section>;
}
function MusicBubbles({ entries, selected, kind, name, search }: {
  entries: Entry[]; selected: ReadonlyMap<string, number> | null; name: string; search: string; kind: 'main'|'sub';
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
  const layout = useMemo(()=>musicBubbleLayout(entries, width, kind),[entries,width,kind]);
  return <div ref={container} className="music-bubbles">
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" height={layout.height} role="group" aria-label={name + '氣泡圖'}>
      {layout.circles.map(({ entry, x, y, radius }) => {
        const chosen = selected?.has(entry.id), {lines,fontSize,lineHeight,countFontSize} = musicBubbleTypography(entry.name,radius);
        const blockHeight=lines.length*lineHeight+(countFontSize?countFontSize*1.5:0), firstY=y-blockHeight/2+fontSize;
        return <Link key={entry.id} to={musicEntryPath(entry.id, search)} aria-label={entry.name + '，' + entry.count + ' 人' + (chosen ? '，已選' : '')}
          className={chosen ? 'is-selected' : undefined} style={{'--bubble-pigment':bubbleColor(entry.id)} as CSSProperties}>
          <title>{entry.name + ' · ' + entry.count + ' 人' + (chosen ? ' · 已選' : '')}</title>
          <circle className="bubble-circle" cx={x} cy={y} r={radius} />
          <circle className="bubble-gloss" cx={x-radius*.3} cy={y-radius*.34} r={Math.max(2,radius*.42)} />
          <text x={x} y={firstY} textAnchor="middle" aria-hidden="true" style={{fontSize}}>
            {lines.map((line, i) => <tspan key={i} x={x} dy={i ? lineHeight : 0}>{line}</tspan>)}
            {countFontSize&&<tspan x={x} dy={lineHeight+countFontSize*.7} className="bubble-count" style={{fontSize:countFontSize}}>{entry.count} 人</tspan>}
          </text>
        </Link>;
      })}
    </svg>
  </div>;
}
