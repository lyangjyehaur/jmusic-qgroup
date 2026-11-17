import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { musicCircles } from './music-circles';
import { musicMatchStats, type MatchEntry, type MatchMember } from './music-matching';
const entries: MatchEntry[] = Array.from({ length: 24 }, (_, i) => ({ id: 'e' + i, name: ['同名', '𠀀', '🟢', 'かな'][i % 4]! + i, kind: i < 6 ? 'main' : 'sub', count: 0 }));
function python(members: MatchMember[], minLink: number, hashSeed: string) {
  return JSON.parse(execFileSync('python3', ['-c', `import json,sys,inspect,textwrap
from fractions import Fraction
from music_site import upstream as u
x=json.load(sys.stdin)
u.data={'entries':{e['id']:dict(id=e['id'],text=e['name'],kind=e['kind']) for e in x['entries']},'members':{m['id']:dict(qq=m['id'],name=m['name'],selection=[dict(id=p['entryId'],level=p['level']) for p in m['selections']]) for m in x['members']}}
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
    return correct,detail
u.match_stats=canonical
h=object.__new__(u.Handler)
source=inspect.getsource(u.Handler.compute_clusters)
namespace={};exec(textwrap.dedent(source).replace('out[:8]','out'),u.__dict__,namespace)
print(json.dumps({'source':h.compute_clusters(x['minLink']),'complete':namespace['compute_clusters'](h,x['minLink'])},ensure_ascii=False))`], { input: JSON.stringify({ entries, members, minLink }), encoding: 'utf8', env: { ...process.env, PYTHONHASHSEED: hashSeed } }));
}
function oldShape(value: ReturnType<typeof musicCircles>) {
  return { ...value, clusters: value.clusters.map(circle => ({ ...circle, members: circle.members.map(({ id, name }) => ({ qq: id, name })), tags: circle.tags.map(({ name, count }) => ({ text: name, count })) })),
    singleMembers: value.singleMembers.map(({ id, name, picks, pickCount }) => ({ qq: id, name, picks: picks.map(entry => entry.name), pickCount })) };
}
describe('native source music circles', () => {
  it('matches actual Python seed/admission order, transitive groups, sorted members, top tags and all single members across thresholds and hash seeds', () => {
    let seed = 991; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (const threshold of [20, 40, 60, 80, 100]) {
      const members = Array.from({ length: 45 }, (_, i) => ({ id: 'm' + i, name: ['同名', '𠀀', '🟢', 'Aimer'][i % 4]!, selections: entries.filter(() => random() < .21).map(entry => ({ entryId: entry.id, level: 1 + Math.floor(random() * 4) })) }));
      const before = structuredClone(members), actual = oldShape(musicCircles(members, entries, threshold));
      for (const hashSeed of ['0', '7']) { const expected = python(members, threshold, hashSeed); expect(actual).toEqual(expected.complete); expect({ ...actual, clusters: actual.clusters.slice(0, 8) }).toEqual(expected.source); }
      expect(members).toEqual(before);
    }
  }, 20000);
  it('connects a chain instead of requiring every pair to match and rescans earlier members after admitting a bridge', () => {
    const e: MatchEntry[] = ['a','b','c','d'].map(id => ({ id, name: id, kind: 'sub', count: 0 }));
    const m = (id: string, ids: string[]) => ({ id, name: id, selections: ids.map(entryId => ({ entryId, level: 3 })) });
    const a = m('a', ['a','b']), c = m('c', ['c','d']), b = m('b', ['b','c']);
    expect(musicMatchStats(a.selections,c.selections,e).score).toBe(0);
    const result = musicCircles([a,c,b],e); expect(result.clusters).toHaveLength(1); expect(result.clusters[0]!.size).toBe(3);
    expect(result.clusters[0]!.tags.map(tag=>tag.name)).toEqual(['b','c','a','d']);
    expect(musicCircles([a,c,b],e,60).singleMembers.map(m=>m.id)).toEqual(['a','c','b']);
  });
  it('groups using strict overlap rather than calibrated one-term caps, aggregates same names and preserves original single picks and limits', () => {
    const e = Array.from({length:16},(_,i)=>({id:'e'+i,name:i<2?'同名':'詞'+i,kind:'sub' as const,count:0}));
    const m=(id:string,ids:string[])=>({id,name:id,selections:ids.map(entryId=>({entryId,level:3}))});
    const result=musicCircles([m('one',['e0','e1']),m('two',['e0','e1']),m('single',e.slice(2,14).map(e=>e.id)),m('empty',[])],e,100);
    expect(result.membersWithSelection).toBe(3);expect(result.clusters[0]!.tags).toEqual([{name:'同名',count:4,entries:[{id:'e0',kind:'sub'},{id:'e1',kind:'sub'}]}]);
    expect(result.singleMembers[0]).toMatchObject({pickCount:12});expect(result.singleMembers[0]!.picks).toHaveLength(8);
    const one=musicMatchStats([{entryId:'e0',level:3}],[{entryId:'e0',level:3}],e);expect(one.score).toBe(100);expect(one.matchPercent).toBe(36);
    expect(musicCircles([],e)).toEqual({minLink:40,clusters:[],singles:0,singleMembers:[],membersWithSelection:0});
  });
  it('retains every circle beyond the old eight-item API cap and does not use names as identities', () => {
    const e=Array.from({length:11},(_,i)=>({id:'e'+i,name:'詞'+i,kind:'sub' as const,count:0}));
    const members=e.flatMap(entry=>[0,1].map(i=>({id:entry.id+i,name:'同名',selections:[{entryId:entry.id,level:3}]})));
    const result=musicCircles(members,e);expect(result.clusters).toHaveLength(11);expect(result.clusters.every(c=>c.size===2)).toBe(true);
  });
});
