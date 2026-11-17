import {
  musicCodepointOrder,
  musicRound,
  prepareMusicMatchStats,
  type MatchEntry,
  type MatchMember,
} from './music-matching';
export const MUSIC_ROOM_LIMIT = 40;
export type RoomMember = MatchMember & { gender?: string };
export type RoomMode = { mode: 'rooms' | 'capacity'; value: number } | { mode: 'sizes'; sizes: number[] };
const fail = (message: string): never => {
  throw new Error(message);
};
function selected(ids: readonly string[], members: readonly RoomMember[]) {
  const byId = new Map(members.map((member) => [member.id, member]));
  return [...new Set(ids)]
    .filter((id) => byId.has(id))
    .slice(0, MUSIC_ROOM_LIMIT)
    .map((id) => byId.get(id)!);
}
function matrix(members: readonly RoomMember[], entries: readonly MatchEntry[]) {
  const stats = prepareMusicMatchStats(entries),
    pairs = new Map<string, Map<string, ReturnType<typeof stats>>>();
  for (const [index, a] of members.entries())
    for (const b of members.slice(index + 1)) {
      const result = stats(a.selections, b.selections);
      for (const [left, right] of [
        [a, b],
        [b, a],
      ] as const) {
        const row = pairs.get(left.id) ?? new Map();
        row.set(right.id, result);
        pairs.set(left.id, row);
      }
    }
  return (a: string, b: string) => pairs.get(a)?.get(b);
}
/** Analyze one room using calibrated pair scores and Python half-even rounding. */
export function musicRoomAnalysis(ids: readonly string[], all: readonly RoomMember[], entries: readonly MatchEntry[]) {
  const members = selected(ids, all),
    stats = matrix(members, entries);
  return analyze(members, entries, stats);
}
function analyze(members: readonly RoomMember[], entries: readonly MatchEntry[], stats: ReturnType<typeof matrix>) {
  const pairs: {
    a: string;
    b: string;
    aName: string;
    bName: string;
    score: number;
    raw: number;
    label: string;
    shared: number;
  }[] = [];
  const per = new Map<string, number[]>();
  for (const [index, a] of members.entries())
    for (const b of members.slice(index + 1)) {
      const result = stats(a.id, b.id)!,
        populated = !!a.selections.length && !!b.selections.length;
      const score = populated ? result.matchPercent : 0;
      pairs.push({
        a: a.id,
        b: b.id,
        aName: a.name,
        bName: b.name,
        score,
        raw: populated ? result.score : 0,
        label: populated ? result.label : '',
        shared: populated ? result.sharedCount : 0,
      });
      for (const id of [a.id, b.id]) {
        const values = per.get(id) ?? [];
        values.push(score);
        per.set(id, values);
      }
    }
  const average = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const scores = pairs.map((pair) => pair.score),
    worst = pairs.reduce<(typeof pairs)[number] | null>(
      (best, pair) => (best === null || pair.score < best.score ? pair : best),
      null,
    );
  const lonerMember = [...per].sort(([a, aa], [b, bb]) => average(aa) - average(bb) || musicCodepointOrder(a, b))[0];
  const need = Math.max(2, Math.floor((members.length * 3 + 4) / 5)),
    tally = new Map<string, number>(),
    catalog = new Map(entries.map((entry) => [entry.id, entry]));
  for (const member of members)
    for (const pick of member.selections) tally.set(pick.entryId, (tally.get(pick.entryId) ?? 0) + 1);
  const common = [...tally]
    .flatMap(([id, n]) => {
      const entry = catalog.get(id);
      return entry && n >= need ? [{ id, text: entry.name, kind: entry.kind, n, count: entry.count }] : [];
    })
    .sort((a, b) => b.n - a.n || a.count - b.count || musicCodepointOrder(a.text, b.text))
    .slice(0, 8);
  const output = members.map((member) => ({
    id: member.id,
    name: member.name,
    count: member.selections.length,
    avg: per.has(member.id) ? musicRound(average(per.get(member.id)!)) : members.length === 1 ? 100 : 0,
  }));
  return {
    members: output,
    memberMax: Math.max(0, ...output.map((member) => member.avg)),
    memberMin: output.length ? Math.min(...output.map((member) => member.avg)) : 0,
    pairs: pairs.sort((a, b) => a.score - b.score),
    avg: musicRound(average(scores)),
    min: scores.length ? Math.min(...scores) : 0,
    worst,
    loner: lonerMember
      ? {
          id: lonerMember[0],
          name: members.find((member) => member.id === lonerMember[0])!.name,
          avg: musicRound(average(lonerMember[1])),
        }
      : null,
    common,
    need,
  };
}
export function musicRoomSplit(
  ids: readonly string[],
  all: readonly RoomMember[],
  entries: readonly MatchEntry[],
  input: RoomMode,
  sameGender = false,
) {
  const members = selected(ids, all),
    n = members.length;
  if (n < 2) fail('至少需要 2 位成員');
  let capacity: number,
    roomCount: number,
    sizes: number[] | null = null;
  if (input.mode === 'sizes') {
    if (
      input.sizes.length < 2 ||
      input.sizes.length > 40 ||
      input.sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 40)
    )
      fail('自訂人數須為 2–40 間，每間 1–40 人');
    sizes = [...input.sizes];
    if (sizes.reduce((sum, size) => sum + size, 0) < n) fail('自訂人數總和小於參與人數');
    capacity = Math.max(2, ...sizes);
    roomCount = Math.min(sizes.length, n);
  } else {
    if (!Number.isSafeInteger(input.value) || input.value < 1 || input.value > 40) fail('房數或容量須為 1–40');
    if (input.mode === 'capacity') {
      capacity = Math.max(2, input.value);
      roomCount = Math.min(n, Math.max(2, Math.ceil(n / capacity)));
    } else {
      roomCount = Math.max(2, Math.min(input.value, n));
      capacity = Math.max(2, Math.ceil(n / roomCount));
    }
  }
  const stats = matrix(members, entries),
    score = (a: RoomMember, b: RoomMember) => stats(a.id, b.id)?.matchPercent ?? 0;
  const totals = new Map(
    members.map((member) => [
      member.id,
      members.filter((other) => other.id !== member.id).reduce((sum, other) => sum + score(member, other), 0),
    ]),
  );
  const order = [...members].sort((a, b) => totals.get(b.id)! - totals.get(a.id)! || musicCodepointOrder(a.id, b.id));
  const groups: RoomMember[][] = Array.from({ length: roomCount }, () => []),
    seedGenders = new Set<string>();
  const gender = (member: RoomMember) =>
    sameGender && ['female', 'male'].includes(member.gender ?? '') ? member.gender! : '';
  const limit = (index: number) => sizes?.[index] ?? capacity;
  for (let i = 0; i < roomCount; i++) {
    if (sameGender && i > 0)
      order.sort(
        (a, b) =>
          Number(seedGenders.has(gender(a))) - Number(seedGenders.has(gender(b))) ||
          totals.get(b.id)! - totals.get(a.id)! ||
          musicCodepointOrder(a.id, b.id),
      );
    const member = order.shift()!;
    groups[i]!.push(member);
    if (gender(member)) seedGenders.add(gender(member));
  }
  const affinity = (member: RoomMember, group: readonly RoomMember[]) =>
    group.reduce((sum, other) => sum + score(member, other), 0) / Math.max(1, group.length) +
    (gender(member) && group.every((other) => gender(other) === gender(member)) ? 200 : 0);
  for (const member of order) {
    let best = -1,
      bestAverage = -Infinity;
    for (const [index, group] of groups.entries()) {
      if (group.length >= limit(index)) continue;
      const avg = affinity(member, group);
      if (best === -1 || avg > bestAverage || (avg === bestAverage && group.length < groups[best]!.length)) {
        best = index;
        bestAverage = avg;
      }
    }
    if (best < 0) fail('容量不足，無法保留全部成員');
    groups[best]!.push(member);
  }
  for (let iteration = 0; iteration < 8; iteration++) {
    let improved = false;
    search: for (const [gi, group] of groups.entries())
      for (const member of [...group]) {
        if (group.length <= 1) continue;
        const base = affinity(
          member,
          group.filter((other) => other.id !== member.id),
        );
        for (const [gj, target] of groups.entries()) {
          if (gi === gj || !target.length || target.length >= limit(gj)) continue;
          if (affinity(member, target) > base + 1) {
            group.splice(group.indexOf(member), 1);
            target.push(member);
            improved = true;
            break search;
          }
        }
      }
    if (!improved) break;
  }
  const rooms = groups
    .map((group, index) => ({
      ids: group.map((member) => member.id),
      capacity: limit(index),
      ...analyze(group, entries, stats),
    }))
    .sort((a, b) => b.avg - a.avg || b.min - a.min);
  return { rooms, capacity, roomCount, sizes };
}
