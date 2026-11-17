export type TrendPoint = { t: number; counts: Record<string, number> };
type Entry = { id: string; name: string; kind: 'main' | 'sub' };
/** Source chart counts positive adjacent changes, including recovery after a decrease. */
export function musicTrendSeries(points: readonly TrendPoint[], entries: readonly Entry[]) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const ids = new Set(points.flatMap(point => Object.keys(point.counts)));
  const series = [...ids].flatMap(id => {
    const entry = byId.get(id); if (!entry?.name) return [];
    const values = points.map((point, i) => i === 0 ? 0 : Math.max(0, (point.counts[id] ?? 0) - (points[i - 1]!.counts[id] ?? 0)));
    return [{ ...entry, values, gain: values.reduce((sum, n) => sum + n, 0), count: points.at(-1)?.counts[id] ?? 0 }];
  });
  const sorted = [...series].sort((a, b) => b.gain - a.gain);
  const top = [...sorted.filter(row => row.kind === 'main').slice(0, 2), ...sorted.filter(row => row.kind === 'sub').slice(0, 3)];
  for (const row of sorted) if (top.length < 5 && !top.includes(row)) top.push(row);
  return { series: top, gains: [...top].filter(row => row.gain > 0).sort((a, b) => b.gain - a.gain), max: Math.max(1, ...top.flatMap(row => row.values)) };
}
/** A changed live reading is returned, never persisted by a GET. */
export function musicTrendPoints(history: readonly TrendPoint[], counts: Record<string, number>, now: number) {
  const last = history.at(-1), keys = Object.keys(counts);
  const same = last && keys.length === Object.keys(last.counts).length && keys.every(key => counts[key] === last.counts[key]);
  return (same ? [...history] : [...history, { t: Math.trunc(now), counts }]).slice(-48);
}
