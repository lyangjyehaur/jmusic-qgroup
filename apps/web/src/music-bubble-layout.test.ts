import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { rankMusic, type RankedMusic } from '@qgroup/domain';
import { musicBubbleLayout, musicBubbleLabel, musicBubbleTypography } from './music-bubble-layout';
const sample = (n: number): RankedMusic[] => Array.from({ length: n }, (_, i) => ({ id: String(i), name: ['米津玄師', 'YOASOBI', 'ヨルシカ', 'Aimer', '同名', '𠀀', '🟢'][i % 7]!, count: i % 3, kind: i % 2 ? 'main' : 'sub' }));
describe('music display rankings and bubble readability', () => {
  it('places every term within the chart without overlap at mobile/desktop widths and long/zero-count catalogs', () => {
    for (const width of [328, 716, 1024]) for (const n of [0, 1, 15, 140]) {
      const entries = sample(n), layout = musicBubbleLayout(entries, width);
      expect(layout).toEqual(musicBubbleLayout(entries, width));
      expect(layout.circles.map(c => c.entry.id)).toEqual(entries.map(e => e.id));
      for (let i = 0; i < layout.circles.length; i++) {
        const a = layout.circles[i]!;
        expect(a.x - a.radius).toBeGreaterThanOrEqual(0);
        expect(a.x + a.radius).toBeLessThanOrEqual(layout.width + 1e-8);
        expect(a.y - a.radius).toBeGreaterThanOrEqual(0);
        expect(a.y + a.radius).toBeLessThanOrEqual(layout.height + 1e-8);
        for (const b of layout.circles.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y) + 1e-8).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
    }
    expect(musicBubbleLayout([{ id: 'zero', name: '', count: 0, kind: 'sub' }], 232).circles[0]!.radius).toBeGreaterThanOrEqual(12);
  });
  it('matches the original seeded chart geometry for both kinds and screen widths',()=>{
    const source=readFileSync('music_site/public/app.js','utf8'),helpers=source.slice(source.indexOf('  function hashId'),source.indexOf('  function updateStats'))+source.slice(source.indexOf('  function layout'),source.indexOf('  function charW'));
    for(const kind of ['main','sub'] as const)for(const width of [328,716]){
      const entries=rankMusic(sample(kind==='main'?13:60).map(e=>({...e,kind}))),actual=musicBubbleLayout(entries,width,kind);
      const expected=vm.runInNewContext(helpers+`const items=entries.map(e=>({id:e.id,count:e.count,baseR:kind==='main'?26+26*Math.sqrt(e.count/max):12+30*Math.sqrt(e.count/max)}));layout(items,W,H);items`,{entries,kind,max:Math.max(1,...entries.map(e=>e.count)),W:actual.width,H:actual.height});
      for(let i=0;i<entries.length;i++){expect(actual.circles[i]!.x).toBeCloseTo(expected[i].x,8);expect(actual.circles[i]!.y).toBeCloseTo(expected[i].y,8);expect(actual.circles[i]!.radius).toBeCloseTo(expected[i].r,8);}
    }
  });
  it('scales and truncates labels to the source two-line layout without splitting emoji or combining characters',()=>{
    for(const cluster of ['👩🏽‍🎤','e\u0301','𠀀','🇹🇼'])for(const radius of [9,26,42,52]){
      const lines=musicBubbleLabel(cluster.repeat(100),radius);expect(lines.length).toBeLessThanOrEqual(2);
      for(const line of lines)expect(line.replace(/…$/u,'').split(cluster).join('')).toBe('');
    }
    expect(musicBubbleTypography('YOASOBI',42).lines).toEqual(['YOASOBI']);
    expect(musicBubbleTypography('小詞條',12).countFontSize).toBeNull();
    expect(musicBubbleTypography('領域',52).countFontSize).toBeGreaterThan(0);
  });
});
