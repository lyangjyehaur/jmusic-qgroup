import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { MusicComparison, MusicMatches } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { musicMatchingFixture, matchId } from '../testsupport/music-matching-fixture';
import { createApp, hash } from './app';
import { musicMatchData } from './music-match-data';
const origin = 'https://rebuild.example';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); musicMatchingFixture(db);
  const app = createApp({ db, origin }); await app.ready(); cleanup.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  const matches = (sort = 'rare', h = headers) => app.inject({ url: '/api/v2/music/matches?sort=' + sort, headers: h });
  const compare = (query = matchId(2), h = headers, extra = {}) => app.inject({ method: 'POST', url: '/api/v2/music/compare', headers: h, payload: { query, ...extra } });
  const direct = (id = matchId(2), h = headers) => app.inject({ url: '/api/v2/music/profiles/' + id + '/comparison', headers: h });
  const member = (id: string, h = headers) => app.inject({ url: '/api/v2/music/profiles/' + id, headers: h });
  return { db, app, viewer, headers, matches, compare, direct, member };
}
describe('private native music matching API', () => {
  it('preserves both source rankings, complete picks and comparison familiarity without exposing internal fields', async () => {
    const { db, matches, compare, direct } = await setup();
    const source = musicMatchData(db);
    const expected = JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site import upstream as u
x=json.load(sys.stdin)
u.data={'entries':{e['id']:dict(id=e['id'],text=e['name'],kind=e['kind']) for e in x['entries']},'members':{}}
for m in x['members']:u.data['members'][m['id']]=dict(qq=m['id'],name=m['name'],note=m['note'],selection=[dict(id=p['entryId'],level=p['level']) for p in m['selections']])
h=object.__new__(u.Handler)
me=x['members'][0]['id'];other=x['members'][1]['id']
h.path='/api/compare?me='+me+'&qq='+other
result={sort:h.compute_matches(me,sort) for sort in ['rare','familiar']}
h.send_json=lambda payload,*args:result.update(comparison=payload)
h.do_GET()
print(json.dumps(result))`], { input: JSON.stringify(source), encoding: 'utf8' }));
    for (const sort of ['rare', 'familiar']) {
      const response = await matches(sort); expect(response.statusCode).toBe(200);
      const body = MusicMatches.parse(response.json()); expect(body.sort).toBe(sort);
      for (const key of ['matches', 'sparseMatches'] as const) {
        expect(body[key].map(row => row.member.id)).toEqual(expected[sort][key].map((row: any) => row.qq));
        for (const row of body[key]) {
          const old = expected[sort][key].find((m: any) => m.qq === row.member.id);
          expect(row.member.note).toBe(old.note);
          expect(row.stats).toMatchObject({ score: old.similarity, evidenceScore: old.evidenceScore, myTopShared: old.myTopShared, famScore: old.famScore, sharedCount: old.sharedCount, bothTop: old.bothTop });
          expect(row.shared.map(p => ({ ...p, text: p.name, name: undefined }))).toEqual(old.shared.map((p: any) => ({ ...p, name: undefined })));
          expect(row.onlyTheirs.map(p => p.id)).toEqual(old.otherOnly.map((p: any) => p.id));
        }
      }
      expect(body.matches).toHaveLength(6); expect(body.matches.filter(row => row.member.name === '同名').map(row => row.member.id)).toEqual([matchId(5), matchId(6)]);
    }
    const response = await compare(), result = MusicComparison.parse(response.json()); expect(response.statusCode).toBe(200);
    expect(result.stats.score).toBe(expected.comparison.score); expect(result.other.note).toBe(expected.comparison.otherNote);
    for (const key of ['mine', 'theirs', 'shared', 'onlyMine', 'onlyTheirs'] as const) expect(result[key].map(p => p.id)).toEqual(expected.comparison[key].map((p: any) => p.id));
    expect((await direct()).json()).toEqual(result);
    expect(response.body).not.toMatch(/synthetic-private-pin|legacy_key|user_id|token|csrf|noteAt|sourceFields|genderPublic/);
    expect(result.other.gender).toBe('自訂性別');
    expect(Object.keys(result.other).sort()).toEqual(['contactQQ', 'contactSource', 'gender', 'id', 'name', 'note']);
  });
  it('limits notes to the chosen main first, with default-rare authorization for member cards and comparisons', async () => {
    const { db, matches, compare, member } = await setup();
    const rare = (await matches()).json(), familiar = (await matches('familiar')).json();
    expect(rare.me).toMatchObject({ gender: '不可外洩性別', note: '留言 我的成分' });
    expect(rare.matches[0].member).toMatchObject({ id: matchId(2), note: '留言 共同最多', gender: '自訂性別' });
    expect(familiar.matches[0].member).toMatchObject({ id: matchId(3), note: '留言 共同本命', gender: '' });
    for (const list of [rare, familiar]) {
      expect(list.matches.slice(1).every((row: any) => row.member.note === '')).toBe(true);
      expect(list.sparseMatches.every((row: any) => row.member.note === '')).toBe(true);
    }
    expect((await compare(matchId(3))).json().other.note).toBe(''); expect((await member(matchId(3))).json().note).toBe('');
    expect((await member(matchId(2))).json().note).toBe('留言 共同最多');
    expect((await member(matchId(1))).json()).toMatchObject({ note: '留言 我的成分', gender: '不可外洩性別' });
    expect((await compare(matchId(8))).json().other.note).toBe('');
    db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(matchId(2));
    expect((await member(matchId(2))).json().note).toBe(''); expect((await compare(matchId(2))).json().other.note).toBe('');
    expect((await matches()).json().matches[0].member.id).toBe(matchId(4));
    db.prepare('DELETE FROM music_profile_fields WHERE profile_id=?').run(matchId(3));
    db.prepare('UPDATE music_legacy_profiles SET fields_json=? WHERE profile_id=?').run('{"note":"舊留言","gender":"hidden","genderPublic":false}', matchId(3));
    expect((await matches('familiar')).json().matches[0].member).toMatchObject({ note: '舊留言', gender: '' });
  });
  it('resolves canonical IDs, legacy aliases and current contacts without trusting submitted viewer identities', async () => {
    const { app, headers, compare, direct } = await setup();
    const native = (await compare(matchId(3))).json();
    for (const query of ['20003', '345678', ' 345678 ']) expect((await compare(query)).json()).toEqual(native);
    expect((await compare('234567')).json().other.id).toBe(matchId(2));
    for (const query of [matchId(1), 'does-not-exist']) expect((await compare(query)).json().code).toBe(query === matchId(1) ? 'COMPARE_SELF' : 'NOT_FOUND');
    expect((await direct(matchId(1))).json().code).toBe('COMPARE_SELF');
    expect((await direct('234567')).statusCode).toBe(400);
    for (const extra of [{ me: matchId(2) }, { viewer: matchId(2) }, { userId: 'bob' }]) expect((await compare(matchId(3), headers, extra)).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/v2/music/matches?me=bob', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v2/music/compare', headers, payload: { query: '' } })).statusCode).toBe(400);
  });
  it('requires scoped current sessions and saved profiles and validates origin, CSRF, query and rate limits', async () => {
    const { db, app, headers, matches, compare, direct } = await setup();
    for (const [override, status] of [[{ cookie: '' }, 401], [{ 'x-account-scope': '' }, 409], [{ 'x-account-scope': 'wrong' }, 409]] as const) {
      const h = { ...headers, ...override }; expect((await matches('rare', h)).statusCode).toBe(status); expect((await compare(matchId(2), h)).statusCode).toBe(status); expect((await direct(matchId(2), h)).statusCode).toBe(status);
    }
    for (const override of [{ origin: 'https://evil.example' }, { 'x-csrf-token': '' }, { 'x-csrf-token': 'a'.repeat(64) }]) expect((await compare(matchId(2), { ...headers, ...override })).statusCode).toBe(403);
    expect((await matches('other')).statusCode).toBe(400);
    db.prepare("UPDATE music_profiles SET user_id=NULL WHERE user_id='alice'").run();
    for (const response of [await matches(), await compare(), await direct()]) expect(response.json().code).toBe('MUSIC_PROFILE_REQUIRED');
    db.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run('alice', matchId(10));
    expect((await matches()).json()).toMatchObject({ matches: [], sparseMatches: [], mine: [] });
    expect((await compare()).json().stats).toMatchObject({ score: 0, mineCount: 0, theirsCount: 5, sharedCount: 0 });
    db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(hash('fixture-alice'));
    expect((await matches()).statusCode).toBe(401); expect((await compare()).statusCode).toBe(401);
    // Distinct synthetic IP for quota checks; runtime limits stay enabled.
    for (let i = 0; i < 31; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/v2/music/compare', remoteAddress: '192.0.2.23', headers, payload: { query: matchId(2) } });
      expect(response.statusCode).toBe(i < 30 ? 401 : 429);
    }
  });
  it('returns explicit zero metrics for disjoint or empty selections without disclosing unrelated notes', async () => {
    const { compare, matches } = await setup();
    const disjoint = (await compare(matchId(9))).json(), empty = (await compare(matchId(10))).json();
    expect(disjoint).toMatchObject({ other: { note: '' }, stats: { score: 0, sharedCount: 0, mineCovered: false, theirsCovered: false }, shared: [] });
    expect(disjoint.onlyMine).toHaveLength(6); expect(disjoint.onlyTheirs).toHaveLength(2);
    expect(empty.stats).toMatchObject({ score: 0, theirsCount: 0, matchPercent: 0, lowData: true });
    const all = (await matches()).json(); expect([...all.matches, ...all.sparseMatches].some((row: any) => [matchId(9), matchId(10)].includes(row.member.id))).toBe(false);
  });
  it('revokes erased targets, uses fresh owner assignments and never resurrects data after re-creation', async () => {
    const { app, db, viewer, headers, matches, direct, compare } = await setup();
    const cookie = 'kanban_session=fixture-bob', bob = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    const profile = (await app.inject({ url: '/api/v2/me/music', headers: { cookie, 'x-account-scope': bob.scope } })).json();
    const erased = await app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: { cookie, origin, 'x-account-scope': bob.scope, 'x-csrf-token': bob.csrf }, payload: { target: 'music', profileId: profile.id, profileRevision: profile.revision, requestId: randomUUID(), secret: 'a'.repeat(64), confirm: true } });
    expect(erased.statusCode).toBe(200); expect((await direct()).statusCode).toBe(404); expect((await compare('234567')).statusCode).toBe(404);
    expect((await matches()).json().matches.some((row: any) => row.member.id === profile.id)).toBe(false);
    db.prepare("UPDATE music_profiles SET user_id=NULL WHERE user_id='alice'").run(); db.prepare("UPDATE music_profiles SET user_id='alice' WHERE id=?").run(matchId(3));
    expect((await matches()).json().me.id).toBe(matchId(3)); expect((await compare(matchId(3))).json().code).toBe('COMPARE_SELF');
    expect((await compare(matchId(1))).json().me.id).toBe(matchId(3));
    expect(viewer.scope).toBe(headers['x-account-scope']);
  });
  it('keeps GET and comparison POST completely read-only with private cache headers and no bot, roster or finance changes', async () => {
    const { db, matches, compare, direct, member } = await setup();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const snapshot = () => tables.map(table => db.prepare('SELECT * FROM "' + table + '"').all());
    const before = snapshot(), changes = db.prepare('SELECT total_changes() n').get();
    for (const response of [await matches(), await matches('familiar'), await compare(), await direct(), await member(matchId(2))]) {
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers.vary).toContain('Cookie'); 
    }
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes); expect(snapshot()).toEqual(before);
  });
});
