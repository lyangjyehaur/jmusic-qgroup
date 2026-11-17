import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { musicTrendPoints, musicTrendSeries } from './music-trend';
describe('native source trend calculations', () => {
  it('matches the actual old chart series, top grouping, stable ties and positive-only gain across randomized histories', () => {
    const source = readFileSync('music_site/public/app.js', 'utf8');
    const start = source.indexOf('    const ids = new Set();', source.indexOf('  function drawTrend()'));
    const end = source.indexOf('    let maxV = 1;', start);
    let seed = 911; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let trial = 0; trial < 150; trial++) {
      const entries = Array.from({ length: trial % 14 }, (_, i) => ({ id: 'e' + i, name: '詞條' + i, kind: (i % 3 ? 'sub' : 'main') as 'main' | 'sub' }));
      const points = Array.from({ length: trial % 47 + 2 }, (_, i) => ({ t: i * 1800, counts: Object.fromEntries([...entries.map(e => e.id), 'removed'].filter(() => random() > .1).map(id => [id, Math.floor(random() * 12)])) }));
      const expected = runInNewContext(source.slice(start, end) + '({rows:top.map(id=>({id,values:series[id],gain:gain(id),count:finalCounts[id]}))})', {
        points, texts: Object.fromEntries(entries.map(e => [e.id, e.name])), state: { entries }, entryKind: (entry: { kind: string }) => entry.kind,
      });
      const actual = musicTrendSeries(points, entries);
      expect(actual.series.map(({ id, values, gain, count }) => ({ id, values, gain, count }))).toEqual(expected.rows);
      expect(actual.max).toBe(Math.max(1, ...actual.series.flatMap(row => row.values)));
    }
  });
  it('counts recovery after a fall as new additions and never mistakes it for net growth', () => {
    const points = [4, 2, 4, 4, 0, 1].map((n, i) => ({ t: 1800 * i, counts: { a: n } }));
    const result = musicTrendSeries(points, [{ id: 'a', name: '詞', kind: 'main' }]);
    expect(result.series[0]).toMatchObject({ gain: 3, count: 1, values: [0, 0, 2, 0, 0, 1] });
    expect(musicTrendSeries([], []).series).toEqual([]);
    expect(musicTrendSeries([{ t: 0, counts: {} }], []).max).toBe(1);
  });
  it('appends a live reading only when counts differ, compares dictionaries without order and retains the final 48 without mutating history', () => {
    const points = Array.from({ length: 60 }, (_, i) => ({ t: i * 1800, counts: { a: i, b: 1 } })), before = structuredClone(points);
    expect(musicTrendPoints(points, { b: 1, a: 59 }, 999999)).toEqual(points.slice(-48));
    const changed = musicTrendPoints(points, {}, 999999.9);
    expect(changed).toHaveLength(48); expect(changed.at(-1)).toEqual({ t: 999999, counts: {} }); expect(points).toEqual(before);
    expect(musicTrendPoints([], {}, 12.9)).toEqual([{ t: 12, counts: {} }]);
  });
});
