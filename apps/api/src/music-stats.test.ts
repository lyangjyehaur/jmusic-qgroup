import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { MusicCatalog } from '@qgroup/contracts';
import { createApp } from './app';
import { musicTimestamp } from './music-stats';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
const stamp = '2026-11-17T08:00:00.125Z', now = Date.parse(stamp) / 1000;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); nicknameFixture(db);
  let clock = stamp;
  const app = createApp({ db, origin: 'https://rebuild.example', now: () => new Date(clock) }); await app.ready();
  cleanup.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, origin: 'https://rebuild.example', 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  const read = async () => MusicCatalog.parse((await app.inject({ url: '/api/v2/music/catalog' })).json());
  const save = async (profileId: string | null, revision = 0, musicEpoch = 0) => app.inject({
    method: 'PUT', url: '/api/v2/me/music', headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { profileId, revision, musicEpoch, selections: [{ entryId: 'sub-0', level: 3 }] },
  });
  const legacy = (value: unknown, index: number) => {
    const id = 'legacy-' + index;
    db.prepare('INSERT INTO music_profiles VALUES(?,NULL,0,?,NULL)').run(id, stamp);
    db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(id, String(10001 + index), '舊成分', 1, 'PRIVATE_PIN', String(10001 + index), JSON.stringify({ createdAt: value, note: 'PRIVATE_NOTE' }), '[]', 'unlinked');
    db.prepare('INSERT INTO music_entries VALUES(?,?,?)').run('entry-' + index, '詞條' + index, 'sub');
    db.prepare('INSERT INTO music_entry_details VALUES(?,?,?,?,?,?)').run('entry-' + index, '其他', '[]', '', JSON.stringify(value ?? 0), 'null');
  };
  return { db, app, read, save, legacy, headers, clock: (value: string) => { clock = value; } };
}
describe('music counts and original creation times', () => {
  it('matches Python state statistics at the strict 24h boundary, including string and future timestamps', async () => {
    const s = await setup(), values = [0, null, '', false, true, now - 86400, String(now - 86400), now - 86400 + .001, now, now + 86400, String(now), '1_795_000_000', '１９００００００００'];
    values.forEach(s.legacy);
    const expected = JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site import upstream as u
values=json.load(sys.stdin);u.time.time=lambda:${now}
u.data={'entries':{str(i):dict(id=str(i),text=str(i),createdAt=v) for i,v in enumerate(values)},'members':{str(i):dict(qq=str(i),name=str(i),createdAt=v) for i,v in enumerate(values)}}
u.entries_payload=lambda:[] # Isolate statistics from unrelated int display-time serialization.
r=u.state_payload();print(json.dumps({k:r[k] for k in ['memberCount','recentMembers24h','recentEntries24h']}))`], { input: JSON.stringify(values), encoding: 'utf8' }));
    const result = await s.read();
    expect(result.stats).toEqual({ members: expected.memberCount, entries: 22 + values.length, recentMembers24h: expected.recentMembers24h, recentEntries24h: expected.recentEntries24h, asOf: now });
    expect(s.db.prepare('SELECT * FROM music_profile_creation').all()).toEqual([]);
  });
  it('uses Python float syntax instead of JS coercion for malformed imported entry times', () => {
    const values: unknown[] = [[], [1900000000], {}, '0xFFFFFFFF', '0b111', '\ufeff1900000000', '\u001c1900000000', '1__900000000', '1_900_000_000', '\u00851900000000\u0085', '+1.9e9', '.190E10', '-Infinity', '+inf', 'NaN', '１９００００００００', '١٩٠٠٠٠٠٠٠٠', '𝟙𝟡𝟘𝟘𝟘𝟘𝟘𝟘𝟘𝟘', null, false];
    const expected = JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site import upstream as u
u.time.time=lambda:${now}
print(json.dumps([u._recent_count([{'createdAt':v}]) for v in json.load(sys.stdin)]))`], { input: JSON.stringify(values), encoding: 'utf8' }));
    expect(values.map(value => Number(musicTimestamp(value) > now - 86400))).toEqual(expected);
  });
  it('keeps native creation fixed through later saves, ownership detachment and field edits', async () => {
    const s = await setup(); s.clock('2020-01-01T00:00:00.000Z');
    const saved = await s.save(null); expect(saved.statusCode).toBe(200); const id = saved.json().id;
    s.clock(stamp); expect((await s.save(id, 1)).statusCode).toBe(200);
    s.db.prepare("UPDATE music_profile_fields SET name='改名',updated_at=? WHERE profile_id=?").run(stamp, id);
    s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(id);
    expect((await s.read()).stats).toMatchObject({ members: 1, recentMembers24h: 0 });
    expect(s.db.prepare('SELECT created_at FROM music_profile_creation WHERE profile_id=?').get(id)).toEqual({ created_at: '2020-01-01T00:00:00.000Z' });
  });
  it('counts a new explicit blank profile only once and does not confuse all board accounts with music members', async () => {
    const s = await setup(); expect((await s.read()).stats).toMatchObject({ members: 0, entries: 22 });
    const result = await s.app.inject({ method: 'POST', url: '/api/v2/me/music/entries', headers: { ...s.headers, 'idempotency-key': randomUUID() }, payload: { command: 'create', name: '新詞', kind: 'sub', category: '歌手', profileId: null, musicEpoch: 0, confirm: true } });
    expect(result.statusCode, result.body).toBe(200);
    expect((await s.read()).stats).toMatchObject({ members: 1, recentMembers24h: 1, entries: 23, recentEntries24h: 1 });
    s.clock('2026-11-18T08:00:00.125Z');
    expect((await s.read()).stats).toMatchObject({ members: 1, recentMembers24h: 0, recentEntries24h: 0 });
  });
  it('removes erased creation provenance and counts while rebuilding with a new ID and leaving bot work unchanged', async () => {
    const s = await setup(), first = await s.save(null), id = first.json().id;
    const tables = ['bot_outbox', 'bot_settings', 'bot_settings_history', 'bot_runtime', 'events', 'attendees', 'finance_entries'];
    const snapshot = () => tables.map(t => s.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()), before = snapshot();
    const erased = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: s.headers, payload: { target: 'music', profileId: id, profileRevision: 1, requestId: randomUUID(), secret: 'e'.repeat(64), confirm: true } });
    expect(erased.statusCode, erased.body).toBe(200); expect((await s.read()).stats).toMatchObject({ members: 0, recentMembers24h: 0 });
    expect(s.db.prepare('SELECT * FROM music_profile_creation').all()).toEqual([]);
    const second = await s.save(null, 0, 1); expect(second.statusCode, second.body).toBe(200); expect(second.json().id).not.toBe(id);
    expect((await s.read()).stats).toMatchObject({ members: 1, recentMembers24h: 1 });
    expect(snapshot()).toEqual(before);
  });
  it('returns public aggregates without identifiers or write side effects and never substitutes import/modification times', async () => {
    const s = await setup(); s.legacy(undefined, 0); s.legacy(0, 1);
    s.db.prepare("INSERT INTO music_profiles VALUES('unknown',NULL,2,?,NULL)").run(stamp);
    s.db.prepare("UPDATE music_profile_creation SET created_at=NULL WHERE profile_id='unknown'").run();
    const before = s.db.prepare('SELECT total_changes() n').get();
    const response = await s.app.inject({ url: '/api/v2/music/catalog' });
    expect(response.statusCode).toBe(200); expect(response.json().stats).toMatchObject({ members: 3, recentMembers24h: 0, recentEntries24h: 0 });
    expect(response.body).not.toMatch(/PRIVATE|10001|legacy-|alice|bob|created_at|fields_json|profile_id|token|contact|pin/);
    expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(before);
  });
});
