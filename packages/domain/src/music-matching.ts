export type MusicPick = { entryId: string; level: number };
export type MatchEntry = { id: string; name: string; kind: 'main' | 'sub'; count: number };
export type MatchMember = { id: string; name: string; selections: readonly MusicPick[] };
/** Python strings compare Unicode code points, independently of locale or UTF-16. */
export function musicCodepointOrder(a: string, b: string) {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const difference = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return x.length - y.length;
}
export function musicRound(value: number) {
  const low = Math.floor(value), fraction = value - low;
  return fraction === .5 ? low % 2 === 0 ? low : low + 1 : Math.round(value);
}
export function musicOverlapLabel(shared: number, ratio: number, niche = 0) {
  if (!shared) return '沒有重合';
  if (shared >= 4) return '靈魂同款';
  if (shared === 3) return ratio >= .25 ? '很合拍' : '口味相近';
  if (shared === 2) return ratio >= .2 ? niche >= 1 ? '冷門同好' : '口味相近' : '同圈可聊';
  return '只碰上一首';
}
export function musicMatchPercent(ratio: number, shared: number) {
  return shared <= 0 ? 0 : Math.min(musicRound(100 * Math.sqrt(Math.max(0, Math.min(1, ratio)))), [0, 36, 49, 64][shared] ?? 100);
}
const weights = [0, 3, 5, 8, 10];
const roundRatio = (num: number, den: number) => {
  const low = Math.floor(num / den), remainder = num % den;
  return remainder * 2 === den ? low % 2 === 0 ? low : low + 1 : remainder * 2 > den ? low + 1 : low;
};
export function musicMatchStats(mine: readonly MusicPick[], theirs: readonly MusicPick[], entries: readonly MatchEntry[]) {
  return prepareMusicMatchStats(entries)(mine, theirs);
}
/** Reuse the catalog index when comparing many pairs against the same snapshot. */
export function prepareMusicMatchStats(entries: readonly MatchEntry[]) {
  const map = new Map(entries.map(entry => [entry.id, entry]));
  return (mine: readonly MusicPick[], theirs: readonly MusicPick[]) => matchStats(mine, theirs, map);
}
function matchStats(mine: readonly MusicPick[], theirs: readonly MusicPick[], map: ReadonlyMap<string, MatchEntry>) {
  const a = new Map(mine.map(pick => [pick.entryId, pick.level])), b = new Map(theirs.map(pick => [pick.entryId, pick.level]));
  const shared = [...a.keys()].filter(id => b.has(id));
  const part = (kind: 'main' | 'sub') => {
    const ids = [...new Set([...a.keys(), ...b.keys()])].filter(id => (map.get(id)?.kind ?? 'sub') === kind);
    if (!ids.length) return null;
    const sum = (source: Map<string, number>) => ids.reduce((total, id) => total + (source.has(id) ? weights[source.get(id)!]! : 0), 0);
    const den = sum(a) + sum(b);
    const num = ids.reduce((total, id) => total + (a.has(id) && b.has(id) ? Math.min(weights[a.get(id)!]!, weights[b.get(id)!]!) : 0), 0);
    return { num: 2 * num, den: den || 1 };
  };
  const domain = part('main'), sub = part('sub');
  const numerator = !mine.length || !theirs.length ? 0 : domain && sub ? 55 * domain.num * sub.den + 45 * sub.num * domain.den : (domain ?? sub)?.num ?? 0;
  const denominator = domain && sub ? 100 * domain.den * sub.den : (domain ?? sub)?.den ?? 1;
  const ratio = numerator / denominator;
  const score = roundRatio(100 * numerator, denominator), sharedDomain = shared.filter(id => map.get(id)?.kind === 'main').length;
  const nicheShared = shared.filter(id => (map.get(id)?.count ?? 0) <= 2).length;
  return {
    score, ratio: score, sharedCount: shared.length, sharedDomain, sharedSub: shared.length - sharedDomain, nicheShared,
    lowData: Math.min(mine.length, theirs.length) <= 3,
    mineCovered: !!shared.length && shared.length === a.size, theirsCovered: !!shared.length && shared.length === b.size,
    mineCount: mine.length, theirsCount: theirs.length,
    domainRatio: domain === null ? null : roundRatio(domain.num * 100, domain.den), subRatio: sub === null ? null : roundRatio(sub.num * 100, sub.den),
    bothTop: shared.filter(id => map.get(id)?.kind === 'sub' && a.get(id)! >= 4 && b.get(id)! >= 4).length,
    label: musicOverlapLabel(shared.length, ratio, nicheShared), matchPercent: musicMatchPercent(ratio, shared.length),
  };
}
export function musicComparison(mine: readonly MusicPick[], theirs: readonly MusicPick[], entries: readonly MatchEntry[]) {
  const map = new Map(entries.map(entry => [entry.id, entry]));
  const picks = (source: readonly MusicPick[]) => source.flatMap(pick => {
    const entry = map.get(pick.entryId); return entry ? [{ ...entry, level: pick.level }] : [];
  }).sort((a, b) => Number(a.kind === 'sub') - Number(b.kind === 'sub') || b.count - a.count || musicCodepointOrder(a.name, b.name));
  const a = picks(mine), b = picks(theirs), aMap = new Map(a.map(pick => [pick.id, pick])), bMap = new Map(b.map(pick => [pick.id, pick]));
  return { stats: musicMatchStats(mine, theirs, entries), mine: a, theirs: b,
    shared: a.filter(pick => bMap.has(pick.id)).map(pick => ({ ...pick, myLevel: pick.level, theirLevel: bMap.get(pick.id)!.level,
      level: pick.kind === 'main' ? 0 : Math.min(pick.level, bMap.get(pick.id)!.level) })),
    onlyMine: a.filter(pick => !bMap.has(pick.id)), onlyTheirs: b.filter(pick => !aMap.has(pick.id)),
  };
}
export function musicMatches<T extends MatchMember>(me: MatchMember, members: readonly T[], entries: readonly MatchEntry[], sort: 'rare' | 'familiar' = 'rare') {
  const mine = new Map(me.selections.map(pick => [pick.entryId, pick.level]));
  const rows = members.filter(member => member.id !== me.id).flatMap(member => {
    const comparison = musicComparison(me.selections, member.selections, entries), stats = comparison.stats;
    if (!stats.sharedCount) return [];
    const myTopShared = comparison.shared.filter(pick => mine.get(pick.id)! >= 4).length;
    const famScore = musicRound(comparison.shared.reduce((total, pick) => total + ({ 4: 1, 3: .6, 2: .2, 1: .05 }[mine.get(pick.id)!] ?? 0), 0) * 100) / 100;
    return [{ member, ...comparison, stats: { ...stats, evidenceScore: musicRound(stats.score * stats.sharedCount / (stats.sharedCount + 3)),
      // Recommendations calibrate the rounded similarity; direct comparison uses the original ratio.
      label: musicOverlapLabel(stats.sharedCount, stats.score / 100, stats.nicheShared), matchPercent: musicMatchPercent(stats.score / 100, stats.sharedCount), famScore, myTopShared } }];
  });
  const main = rows.filter(row => row.stats.theirsCount > 3), sparse = rows.filter(row => row.stats.theirsCount <= 3);
  const order = (isSparse: boolean) => (a: typeof rows[number], b: typeof rows[number]) => {
    const x = a.stats, y = b.stats;
    return (sort === 'familiar' ? y.myTopShared - x.myTopShared || y.famScore - x.famScore || y.sharedCount - x.sharedCount || (!isSparse ? y.evidenceScore - x.evidenceScore : 0)
      : y.sharedCount - x.sharedCount || (isSparse ? y.score - x.score || x.nicheShared - y.nicheShared : y.evidenceScore - x.evidenceScore || y.nicheShared - x.nicheShared))
      || musicCodepointOrder(a.member.name, b.member.name);
  };
  return { matches: main.sort(order(false)), sparseMatches: sparse.sort(order(true)) };
}
