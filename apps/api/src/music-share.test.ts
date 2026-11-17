import { afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '@qgroup/database';
import { MusicShareContext } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { musicMatchingFixture, matchId } from '../testsupport/music-matching-fixture';
import { createApp, hash } from './app';
const origin = 'https://rebuild.example', cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); musicMatchingFixture(db);
  const app = createApp({ db, origin }); await app.ready(); cleanup.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, 'x-account-scope': viewer.scope, origin, 'x-csrf-token': viewer.csrf };
  const read = (sort = 'rare', h = headers) => app.inject({ url: '/api/v2/me/music/share?sort=' + sort, headers: h });
  return { db, app, viewer, headers, read };
}
describe('minimal private music share context', () => {
  it('exposes only owner export identity and the chosen saved main first, never notes, gender or credentials', async () => {
    const { db, read } = await setup();
    db.prepare("INSERT INTO music_profile_contacts VALUES(?,'123456','self_reported',0,'before')").run(matchId(1));
    const rare = await read(), body = MusicShareContext.parse(rare.json()); expect(rare.statusCode).toBe(200);
    expect(body).toEqual({ profileId: matchId(1), musicEpoch: 0, name: '我的成分', contactQQ: '123456', contactSource: 'self_reported', sort: 'rare', topMatch: { id: matchId(2), name: '共同最多', contactQQ: '234567', contactSource: 'self_reported', matchPercent: 84, sharedCount: 4 } });
    const familiar = await read('familiar'); expect(familiar.json().topMatch).toMatchObject({ id: matchId(3), name: '共同本命', contactQQ: '345678', matchPercent: 49, sharedCount: 2 });
    for (const response of [rare, familiar]) {
      expect(response.body).not.toMatch(/留言|note|gender|性別|ownerGender|token|csrf|legacy_key|private-pin|boardUser|user_id|sourceFields|selection/);
      expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers.vary).toBe('Cookie');
      const csp = String(response.headers['content-security-policy']); expect(csp).toMatch(/img-src[^;]*blob:/); expect(csp).not.toMatch(/(?:script-src|connect-src|object-src)[^;]*blob:/);
    }
  });
  it('supports a member drafting their first profile and only returns their own canonical identity', async () => {
    const { db, read } = await setup();
    db.prepare("UPDATE music_profiles SET user_id=NULL WHERE user_id='alice'").run();
    expect((await read()).json()).toEqual({ profileId: null, musicEpoch: 0, name: '小青', contactQQ: '', contactSource: '', sort: 'rare', topMatch: null });
    db.prepare("UPDATE music_profiles SET user_id='alice' WHERE id=?").run(matchId(3));
    expect((await read()).json()).toMatchObject({ profileId: matchId(3), name: '共同本命', contactQQ: '345678' });
  });
  it('requires current scoped membership and ignores no submitted target or viewer overrides', async () => {
    const { db, app, headers, read } = await setup();
    expect((await read('rare', { ...headers, cookie: '' })).statusCode).toBe(401);
    expect((await read('rare', { ...headers, 'x-account-scope': 'wrong' })).statusCode).toBe(409);
    expect((await read('invalid')).statusCode).toBe(400);
    for (const query of ['me=bob', 'profileId=' + matchId(2), 'sort=rare&userId=bob']) expect((await app.inject({ url: '/api/v2/me/music/share?' + query, headers })).statusCode).toBe(400);
    db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(hash('fixture-alice')); expect((await read()).statusCode).toBe(401);
  });
  it('removes erased targets and contacts, observes native and legacy field priority, and follows the owner epoch after erasure', async () => {
    const { db, app, headers, read } = await setup();
    db.prepare("UPDATE music_profile_contacts SET contact_qq='' WHERE profile_id=?").run(matchId(2)); expect((await read()).json().topMatch).toMatchObject({ contactQQ: '', contactSource: '' });
    db.prepare("UPDATE music_profiles SET erased_at='erased',user_id=NULL WHERE id=?").run(matchId(2)); expect((await read()).json().topMatch.id).toBe(matchId(4));
    db.prepare('DELETE FROM music_profile_fields WHERE profile_id=?').run(matchId(3)); expect((await read('familiar')).json().topMatch.name).toBe('舊名稱');
    const profile = (await app.inject({ url: '/api/v2/me/music', headers })).json();
    expect((await app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers, payload: { target: 'music', profileId: profile.id, profileRevision: profile.revision, requestId: randomUUID(), secret: 'a'.repeat(64), confirm: true } })).statusCode).toBe(200);
    expect((await read()).json()).toMatchObject({ profileId: null, musicEpoch: 1, name: '小青', contactQQ: '', topMatch: null });
  });
  it('does not recommend sparse-only or unrelated profiles and never writes any profile, bot, finance or roster table', async () => {
    const { db, read } = await setup();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const snapshot = () => tables.map(table => db.prepare('SELECT * FROM "' + table + '"').all());
    const before = snapshot(), changes = db.prepare('SELECT total_changes() n').get();
    await read(); await read('familiar'); expect(snapshot()).toEqual(before); expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes);
    db.prepare('DELETE FROM music_selections WHERE profile_id IN (?,?,?,?,?,?)').run(...[2,3,4,5,6,7].map(matchId));
    expect((await read()).json().topMatch).toBeNull();
  });
});
