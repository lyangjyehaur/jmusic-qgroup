import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { rankMusic, musicRankLimit, musicBubbleLayout, musicBubbleLabel, type RankedMusic } from './music-rankings';
const sample = (n: number): RankedMusic[] => Array.from({ length: n }, (_, i) => ({ id: String(i), name: ['米津玄師', 'YOASOBI', 'ヨルシカ', 'Aimer', '同名', '𠀀', '🟢'][i % 7]!, count: i % 3, kind: i % 2 ? 'main' : 'sub' }));
describe('music display rankings and bubble readability', () => {
  it('matches the frozen display controller for tied Chinese, Latin, kana, supplementary names and IDs', () => {
    const source = readFileSync('music_site/public/app.js', 'utf8');
    const sort = source.slice(source.indexOf('function renderRankFor(kind)')).match(/list\.sort\([^\n]+;/)![0];
    const entries = sample(75), before = structuredClone(entries);
    const expected = vm.runInNewContext('let list = entries; ' + sort + ' list.map(e => e.id)', { entries: entries.map(e => ({ ...e, text: e.name })) });
    expect(rankMusic(entries).map(e => e.id)).toEqual(expected);
    expect(entries).toEqual(before);
  });
  it('keeps separate source limits while complete results and search can bypass both caps', () => {
    expect(musicRankLimit('main', false, false)).toBe(10);
    expect(musicRankLimit('sub', false, false)).toBe(10);
    expect(musicRankLimit('main', true, false)).toBe(Infinity);
    expect(musicRankLimit('sub', true, false)).toBe(20);
    for (const kind of ['main', 'sub'] as const) for (const expanded of [false, true]) expect(musicRankLimit(kind, expanded, true)).toBe(Infinity);
  });
  it('places every term within the chart without overlap at mobile/desktop widths and long/zero-count catalogs', () => {
    for (const width of [80, 180, 232, 360, 640, 1024]) for (const n of [0, 1, 15, 200]) {
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
    expect(musicBubbleLayout([{ id: 'zero', name: '', count: 0, kind: 'sub' }], 232).circles[0]!.radius).toBeGreaterThanOrEqual(42);
  });
  it('truncates visible long labels without splitting emoji sequences or combining characters', () => {
    for (const cluster of ['👩🏽‍🎤', 'e\u0301', '𠀀', '🇹🇼']) {
      const lines = musicBubbleLabel(cluster.repeat(100), 42);
      expect(lines).toHaveLength(3);
      const fit = cluster === 'e\u0301' ? 8 : 4;
      expect(lines[0]).toBe(cluster.repeat(fit));
      expect(lines[2]).toBe(cluster.repeat(cluster === 'e\u0301' ? 6 : 3) + '…');
    }
    expect(musicBubbleLabel('YOASOBI', 42)).toEqual(['YOASOBI']);
    expect(musicBubbleLabel('BUMP OF CHICKEN', 42)).toEqual(['BUMP OF', 'CHICKEN']);
  });
});
