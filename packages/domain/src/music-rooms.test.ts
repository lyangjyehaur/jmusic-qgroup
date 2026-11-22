import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { musicRoomAnalysis, musicRoomSplit, type RoomMember, type RoomMode } from './music-rooms';
import type { MatchEntry } from './music-matching';
const entries: MatchEntry[] = Array.from({ length: 24 }, (_, i) => ({
  id: 'e' + i,
  name: ['同名', '𠀀', '🟢', 'かな'][i % 4]! + i,
  kind: i < 5 ? 'main' : 'sub',
  count: i % 9,
}));
const labels: Record<string, string> = {
  没有重合: '沒有重合',
  灵魂同款: '靈魂同款',
  很合拍: '很合拍',
  口味相近: '口味相近',
  冷门同好: '冷門同好',
  同圈可聊: '同圈可聊',
  只碰上一首: '只碰上一首',
};
function expected(
  members: RoomMember[],
  cases: { ids: string[]; mode?: RoomMode; sameGender?: boolean }[],
  seed = '0',
) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `import json,sys
from music_site import upstream as u
from fractions import Fraction
x=json.load(sys.stdin)
u.data={'entries':{e['id']:dict(id=e['id'],text=e['name'],kind=e['kind']) for e in x['entries']},'members':{m['id']:dict(qq=m['id'],name=m['name'],gender=m.get('gender',''),genderPublic=True,selection=[dict(id=p['entryId'],level=p['level']) for p in m['selections']]) for m in x['members']}}
counts={e['id']:e['count'] for e in x['entries']}
# The shared native matcher already specifies exact half-even raw scores.
# Retain the original room algorithm; canonicalize only proven float half ties.
original=u.match_stats
def canonical(aa,bb,counts=None):
    score,detail=original(aa,bb,counts)
    if not detail:return score,detail
    a={p['id']:p['level'] for p in aa};b={p['id']:p['level'] for p in bb}
    def part(kind):
        ids={i for i in a.keys()|b.keys() if ('main' if u.data['entries'].get(i,{}).get('kind')=='main' else 'sub')==kind}
        if not ids:return None
        w={1:3,2:5,3:8,4:10};den=sum(w[a[i]] for i in ids if i in a)+sum(w[b[i]] for i in ids if i in b)
        return Fraction(2*sum(min(w[a[i]],w[b[i]]) for i in ids if i in a and i in b),den)
    parts=[(r,w) for r,w in [(part('main'),Fraction(55,100)),(part('sub'),Fraction(45,100))] if r is not None]
    ratio=sum(r*w for r,w in parts)/sum(w for r,w in parts);correct=round(ratio*100)
    if score!=correct:assert abs(score-correct)==1 and (ratio*100).denominator==2
    return correct,dict(detail,score=correct)
u.match_stats=canonical
out=[]
for case in x['cases']:
    mode=case.get('mode')
    if not mode:out.append(u.room_analysis(case['ids'],counts));continue
    args={'sizes':mode['sizes']} if mode['mode']=='sizes' else {mode['mode']:mode['value']}
    out.append(u.room_split(case['ids'],counts=counts,same_gender=case.get('sameGender',False),**args))
print(json.dumps(out,ensure_ascii=False))`,
      ],
      {
        input: JSON.stringify({ entries, members, cases }),
        encoding: 'utf8',
        env: { ...process.env, PYTHONHASHSEED: seed },
      },
    ),
  );
}
function oldAnalysis(value: ReturnType<typeof musicRoomAnalysis>, identity = (id: string) => id) {
  const pair = (p: typeof value.worst) => p ? { ...p, a: identity(p.a), b: identity(p.b) } : null;
  return {
    ...value,
    members: value.members.map(({ id, ...member }) => ({ qq: identity(id), ...member })),
    pairs: value.pairs.map((p) => pair(p)!),
    worst: pair(value.worst),
    loner: value.loner ? { qq: identity(value.loner.id), name: value.loner.name, avg: value.loner.avg } : null,
  };
}
function translate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(translate);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'label' && typeof item === 'string' ? (labels[item] ?? item) : translate(item),
      ]),
    );
  return value;
}
function oldSplit(value: ReturnType<typeof musicRoomSplit>, identity = (id: string) => id) {
  return {
    ...value,
    rooms: value.rooms.map((room) => {
      const a = oldAnalysis(room, identity);
      return {
        qqs: room.ids.map(identity),
        members: a.members,
        memberMax: a.memberMax,
        memberMin: a.memberMin,
        avg: a.avg,
        min: a.min,
        worst: a.worst,
        common: a.common.slice(0, 5),
      };
    }),
  };
}
describe('native music room analysis and partition', () => {
  it('preserves original identity ties after profile/attendee remapping without returning internal ranks', () => {
    const original: RoomMember[] = Array.from({ length: 12 }, (_, i) => ({
      id: ['10020', '1003', '𠀀', '🟢', '名', 'native'][i % 6]! + i,
      name: '同名' + i % 3,
      gender: ['female', 'male', ''][i % 3],
      selections: entries.slice(0, i % 4 + 2).map((e) => ({ entryId: e.id, level: 2 })),
    }));
    const rank = new Map<string, number>();
    // Compute Python codepoint order, independently of migrated public IDs.
    const ordered = [...original].sort((a, b) => {
      const aa = Array.from(a.id), bb = Array.from(b.id);
      for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
        const delta = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!;
        if (delta) return delta;
      }
      return aa.length - bb.length;
    });
    ordered.forEach((m, i) => rank.set(m.id, i));
    for (const prefix of ['m_', 'attendee-']) {
      const mapped = original.map((m, i) => ({ ...m, id: prefix + (99 - i), tieBreakOrder: rank.get(m.id)! }));
      const identity = (id: string) => original[mapped.findIndex(m => m.id === id)]!.id;
      const cases = [
        ...original.slice(1).map((m) => ({ ids: [original[0]!.id, m.id] })),
        { ids: original.map(m => m.id) },
      ];
      const answers = expected(original, cases);
      for (const [i, c] of cases.entries()) {
        const ids = c.ids.map(id => mapped[original.findIndex(m => m.id === id)]!.id);
        const result = musicRoomAnalysis(ids, mapped, entries);
        expect(oldAnalysis(result, identity)).toEqual(translate(answers[i]));
        expect(JSON.stringify(result)).not.toContain('tieBreakOrder');
      }
      const splitCases = ([
        { mode: 'rooms', value: 3 }, { mode: 'capacity', value: 5 }, { mode: 'sizes', sizes: [2, 3, 7] },
      ] as RoomMode[]).flatMap(mode => [false, true].map(sameGender => ({ ids: original.map(m => m.id), mode, sameGender })));
      const splits = expected(original, splitCases);
      for (const [i, c] of splitCases.entries()) {
        const result = musicRoomSplit(mapped.map(m => m.id), mapped, entries, c.mode, c.sameGender);
        expect(oldSplit(result, identity)).toEqual(translate(splits[i]));
        for (const { ids, capacity, ...analysis } of result.rooms)
          expect(oldAnalysis(musicRoomAnalysis(ids, mapped, entries), identity)).toEqual(oldAnalysis(analysis, identity));
        expect(JSON.stringify(result)).not.toContain('tieBreakOrder');
      }
    }
  });
  it('matches original Python averages, calibrated and raw pair scores, ties, loner and common terms across empty/singleton/full rooms and Unicode identities', () => {
    let seed = 534;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const members: RoomMember[] = Array.from({ length: 45 }, (_, i) => ({
      id: ['𠀀', '🟢', '名', 'a'][i % 4] + String(i),
      name: '同名' + (i % 3),
      selections:
        i === 0
          ? []
          : entries
              .filter(() => random() < 0.27)
              .map((entry) => ({
                entryId: entry.id,
                level: 1 + Math.floor(random() * 4),
              })),
    }));
    const cases = Array.from({ length: 15 }, (_, i) => ({
      ids: members.slice(0, i === 14 ? 45 : i * 3).map((member) => member.id),
    }));
    cases.push({
      ids: [members[1]!.id, 'missing', members[1]!.id, members[2]!.id],
    });
    const before = structuredClone(members);
    for (const hashSeed of ['0', '7']) {
      const results = expected(members, cases, hashSeed);
      for (const [index, input] of cases.entries())
        expect(oldAnalysis(musicRoomAnalysis(input.ids, members, entries)), String(index)).toEqual(
          translate(results[index]),
        );
    }
    expect(members).toEqual(before);
  });
  it('matches original seed/greedy/local-move groups and scores across room count/capacity/custom sizes with optional public gender affinity', () => {
    let seed = 195;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const members: RoomMember[] = Array.from({ length: 40 }, (_, i) => ({
      id: 'm' + i,
      name: '同名' + (i % 4),
      gender: ['female', 'male', '', '自訂'][i % 4],
      selections: entries
        .filter(() => random() < 0.35)
        .map((entry) => ({
          entryId: entry.id,
          level: 1 + Math.floor(random() * 4),
        })),
    }));
    const modes: RoomMode[] = [
      { mode: 'rooms', value: 1 },
      { mode: 'rooms', value: 3 },
      { mode: 'rooms', value: 40 },
      { mode: 'capacity', value: 2 },
      { mode: 'capacity', value: 7 },
      { mode: 'capacity', value: 40 },
      { mode: 'sizes', sizes: [1, 4, 7, 28] },
      { mode: 'sizes', sizes: Array(40).fill(1) },
    ];
    const cases = modes.flatMap((mode) =>
        [false, true].map((sameGender) => ({
          ids: members.map((member) => member.id),
          mode,
          sameGender,
        })),
      ),
      before = structuredClone(members);
    const results = expected(members, cases);
    for (const [index, input] of cases.entries()) {
      const result = musicRoomSplit(input.ids, members, entries, input.mode, input.sameGender);
      expect(oldSplit(result), JSON.stringify(input.mode) + input.sameGender).toEqual(translate(results[index]));
      expect(result.rooms.flatMap((room) => room.ids).sort()).toEqual([...input.ids].sort());
      expect(result.rooms.every((room) => room.ids.length <= room.capacity)).toBe(true);
    }
    expect(members).toEqual(before);
  });
  it('preserves empty/singleton analysis semantics, no-data members, term thresholds and room capacity ownership after sorting', () => {
    const a: RoomMember = { id: 'a', name: 'A', selections: [] },
      b: RoomMember = { id: 'b', name: 'B', selections: [] };
    expect(musicRoomAnalysis([], [], entries)).toMatchObject({
      avg: 0,
      min: 0,
      memberMin: 0,
      memberMax: 0,
      worst: null,
      loner: null,
      need: 2,
    });
    expect(musicRoomAnalysis(['a'], [a], entries)).toMatchObject({
      avg: 0,
      min: 0,
      members: [{ avg: 100 }],
      memberMax: 100,
      memberMin: 100,
    });
    expect(musicRoomAnalysis(['a', 'b'], [a, b], entries)).toMatchObject({
      pairs: [{ score: 0, raw: 0, label: '', shared: 0 }],
      loner: { id: 'a', avg: 0 },
      common: [],
    });
    const members = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      name: String(i),
      selections: entries.slice(0, i ? 4 : 0).map((entry) => ({ entryId: entry.id, level: 3 })),
    }));
    const result = musicRoomSplit(
      members.map((m) => m.id),
      members,
      entries,
      { mode: 'sizes', sizes: [1, 4] },
    );
    expect(result.rooms.map((r) => r.capacity).sort()).toEqual([1, 4]);
    expect(result.rooms.every((r) => r.ids.length <= r.capacity)).toBe(true);
    expect(() => musicRoomSplit(['a'], [a], entries, { mode: 'rooms', value: 2 })).toThrow('至少');
    for (const mode of [
      { mode: 'sizes', sizes: [1] },
      { mode: 'sizes', sizes: [1, 1] },
      { mode: 'sizes', sizes: [0, 8] },
      { mode: 'capacity', value: 0 },
    ] as RoomMode[])
      expect(() =>
        musicRoomSplit(
          members.map((m) => m.id),
          members,
          entries,
          mode,
        ),
      ).toThrow();
  });
});
