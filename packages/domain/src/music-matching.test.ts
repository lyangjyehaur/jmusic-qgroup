import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { musicMatchStats, musicComparison, musicMatches, musicRound, musicMatchPercent, type MatchEntry, type MatchMember } from './music-matching';
const labelMap: Record<string, string> = { '没有重合': '沒有重合', '灵魂同款': '靈魂同款', '很合拍': '很合拍', '口味相近': '口味相近', '冷门同好': '冷門同好', '同圈可聊': '同圈可聊', '只碰上一首': '只碰上一首' };
let seed = 12345;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const entries: MatchEntry[] = Array.from({ length: 22 }, (_, i) => ({ id: 'e' + i, name: ['𠀀', '🟢', 'Aimer', '米津玄師'][i % 4] + String(i), kind: i < 6 ? 'main' : 'sub', count: i % 7 }));
const picks = () => entries.filter(() => random() < .38).map(entry => ({ entryId: entry.id, level: 1 + Math.floor(random() * 4) }));
function python(input: object, command: string, hashSeed?: string) {
  return JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site import upstream as u
from fractions import Fraction
x=json.load(sys.stdin)
u.data={'entries':{e['id']:dict(id=e['id'],text=e['name'],kind=e['kind']) for e in x['entries']},'members':{}}
counts={e['id']:e['count'] for e in x['entries']}
def selection(p):return [dict(id=i['entryId'],level=i['level']) for i in p]
${command}`], { input: JSON.stringify(input), encoding: 'utf8', ...(hashSeed ? { env: { ...process.env, PYTHONHASHSEED: hashSeed } } : {}) }));
}
describe('native same-taste scoring and ranking', () => {
  it('matches the actual Python 55/45 weighted formula, metrics, caps and labels across random familiarity combinations', () => {
    const pairs = Array.from({ length: 500 }, () => ({ mine: picks(), theirs: picks() }));
    const expected = python({ entries, pairs }, `out=[]
for p in x['pairs']:
    original=u.match_stats(selection(p['mine']),selection(p['theirs']),counts)[1]
    a={v['entryId']:v['level'] for v in p['mine']};b={v['entryId']:v['level'] for v in p['theirs']}
    def part(kind):
        ids={e['id'] for e in x['entries'] if e['kind']==kind and (e['id'] in a or e['id'] in b)}
        if not ids:return None
        weights={1:3,2:5,3:8,4:10}
        den=sum(weights[a[i]] for i in ids if i in a)+sum(weights[b[i]] for i in ids if i in b)
        return Fraction(2*sum(min(weights[a[i]],weights[b[i]]) for i in ids if i in a and i in b),den)
    domain=part('main');sub=part('sub')
    parts=[(r,w) for r,w in [(domain,Fraction(55,100)),(sub,Fraction(45,100))] if r is not None]
    ratio=sum(r*w for r,w in parts)/sum(w for r,w in parts)
    canonical=dict(original,score=round(ratio*100),ratio=round(ratio*100),domainRatio=round(domain*100) if domain is not None else None,subRatio=round(sub*100) if sub is not None else None,label=u.overlap_label(original['sharedCount'],float(ratio),original['nicheShared']),matchPercent=u.match_percent(float(ratio),original['sharedCount']))
    for key,r in [('score',ratio),('ratio',ratio),('domainRatio',domain),('subRatio',sub)]:
        if original[key]!=canonical[key]:assert abs(original[key]-canonical[key])==1 and (r*100).denominator==2
    out.append(canonical)
print(json.dumps(out))`);
    for (const [i, pair] of pairs.entries()) {
      const source = expected[i];
      expect(musicMatchStats(pair.mine, pair.theirs, entries), 'pair ' + i).toMatchObject({ ...source, label: labelMap[source.label] });
    }
  });
  it('matches both original sort orders and sparse partition, including the source sparse rarity tie direction', () => {
    const members: MatchMember[] = Array.from({ length: 75 }, (_, i) => ({ id: 'p' + i, name: ['同名', 'Aimer', '𠀀', '🟢', '米津'][i % 5]!, selections: i % 3 === 0 ? picks().slice(0, 3) : picks() }));
    const me = { id: 'me', name: '我', selections: entries.slice(0, 15).map((entry, i) => ({ entryId: entry.id, level: i % 4 + 1 })) };
    // The score test above checks the unmodified function against Fraction. Sorting
    // must use that same canonical half-even score, since Python set iteration can
    // move an exact 22.5 to either side and change both calibration and rank.
    for (const hashSeed of ['0', '1', '7', '42']) {
      const expected = python({ entries, members, me }, `
original_stats=u.match_stats
def canonical_stats(aa,bb,counts=None):
    original,detail=original_stats(aa,bb,counts)
    if not detail:return original,detail
    a={v['id']:v['level'] for v in aa};b={v['id']:v['level'] for v in bb}
    def part(kind):
        ids={e['id'] for e in x['entries'] if e['kind']==kind and (e['id'] in a or e['id'] in b)}
        if not ids:return None
        weights={1:3,2:5,3:8,4:10}
        den=sum(weights[a[i]] for i in ids if i in a)+sum(weights[b[i]] for i in ids if i in b)
        return Fraction(2*sum(min(weights[a[i]],weights[b[i]]) for i in ids if i in a and i in b),den)
    parts=[(r,w) for r,w in [(part('main'),Fraction(55,100)),(part('sub'),Fraction(45,100))] if r is not None]
    ratio=sum(r*w for r,w in parts)/sum(w for r,w in parts)
    score=round(ratio*100)
    if score!=original:assert abs(score-original)==1 and (ratio*100).denominator==2
    return score,dict(detail,score=score,ratio=score)
u.match_stats=canonical_stats
for m in [x['me']]+x['members']:u.data['members'][m['id']]=dict(qq=m['id'],name=m['name'],selection=selection(m['selections']))
u.entry_counts=lambda:counts
h=object.__new__(u.Handler)
print(json.dumps({sort:h.compute_matches('me',sort) for sort in ['rare','familiar']}))`, hashSeed);
      for (const sort of ['rare', 'familiar'] as const) {
        const result = musicMatches(me, [me, ...members], entries, sort);
        for (const key of ['matches', 'sparseMatches'] as const) {
          expect(result[key].map(row => row.member.id), sort + ':' + key).toEqual(expected[sort][key].map((row: any) => row.qq));
          for (const row of result[key]) {
            const source = expected[sort][key].find((other: any) => other.qq === row.member.id);
            expect(row.stats).toMatchObject({ score: source.similarity, sharedCount: source.sharedCount, evidenceScore: source.evidenceScore, famScore: source.famScore, myTopShared: source.myTopShared, label: labelMap[source.label], matchPercent: source.matchPercent });
          }
        }
      }
    }
  });
  it('retains each side familiarity, coverage, rare counts and common favourites without exposing a main level as a combined sub level', () => {
    const result = musicComparison([{ entryId: 'e0', level: 1 }, { entryId: 'e6', level: 4 }], [{ entryId: 'e0', level: 4 }, { entryId: 'e6', level: 4 }, { entryId: 'e7', level: 2 }], entries);
    expect(result.shared).toMatchObject([{ id: 'e0', level: 0, myLevel: 1, theirLevel: 4 }, { id: 'e6', level: 4, myLevel: 4, theirLevel: 4 }]);
    expect(result.stats).toMatchObject({ mineCovered: true, theirsCovered: false, bothTop: 1, sharedDomain: 1, sharedSub: 1 });
    expect(result.onlyMine).toEqual([]); expect(result.onlyTheirs.map(pick => pick.id)).toEqual(['e7']);
    expect(musicMatchStats([], [], entries)).toMatchObject({ score: 0, matchPercent: 0, sharedCount: 0, mineCovered: false, theirsCovered: false });
  });
  it('uses Python ties-to-even, calibrated caps and independent missing-domain normalization', () => {
    expect([.5, 1.5, 2.5, 3.5, 36.5].map(musicRound)).toEqual([0, 2, 2, 4, 36]);
    expect([0, 1, 2, 3, 4].map(n => musicMatchPercent(1, n))).toEqual([0, 36, 49, 64, 100]);
    expect(musicMatchStats([{ entryId: 'e6', level: 4 }], [{ entryId: 'e6', level: 4 }], entries)).toMatchObject({ score: 100, domainRatio: null, subRatio: 100 });
  });
});
