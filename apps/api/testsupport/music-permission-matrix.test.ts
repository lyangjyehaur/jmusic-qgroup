import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';
import { matchId, musicMatchingFixture } from './music-matching-fixture';
import { invalidateMusicOwnership } from '../src/music-ownership';

const origin = 'https://rebuild.example', stamp = '2026-11-17T00:00:00+00:00';
const rescueKey = 'synthetic-music-rescue-' + 'x'.repeat(32);
const target = matchId(1), targetNote = 'OWNER_PRIVATE_NOTE', targetGender = 'OWNER_GENDER';
// The expected disclosure rules are declared here, independently of runtime guards.
// Bob has the target as his first regular match; unrelated and empty profiles do not.
const actors = [
  { id: 'alice', member: true, profile: true, note: true },
  { id: 'bob', member: true, profile: true, note: true },
  { id: 'unrelated', member: true, profile: true, note: false },
  { id: 'admin', member: true, profile: true, note: false },
  { id: 'admin-empty', member: true, profile: false, note: false },
  { id: 'rescue', member: false, profile: false, note: false },
  { id: 'visitor', member: false, profile: false, note: false },
  { id: 'anonymous', member: false, profile: false, note: false },
] as const;
type Actor = typeof actors[number];
type State = 'private' | 'public' | 'unlinked' | 'erased';
type Command = 'fields' | 'contact' | 'selections';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function snapshot(db: DB) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(names.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]));
}
async function setup(state: State = 'private') {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-music-permissions-'));
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const db = openDatabase(join(root, 'owned.sqlite3')); cleanup.push(async () => { db.close(); });
  fixture(db); musicMatchingFixture(db);
  for (const a of actors.filter(a => a.member && !['alice', 'bob'].includes(a.id))) {
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(a.id, hash('music-' + a.id), a.id, stamp);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('music-' + a.id), a.id, stamp);
  }
  for (const [n, who] of [[31, 'unrelated'], [32, 'admin']] as const) {
    db.prepare('INSERT INTO music_profiles VALUES(?,?,1,?,NULL)').run(matchId(n), who, stamp);
    db.prepare("INSERT INTO music_profile_fields VALUES(?,?,'',0,'',0,0,?)").run(matchId(n), who, stamp);
    if (who === 'unrelated') for (const [position, entry] of ['sub-14', 'sub-15'].entries()) db.prepare('INSERT INTO music_selections VALUES(?,?,3,?)').run(matchId(n), entry, position);
  }
  for (const id of ['admin', 'admin-empty']) db.prepare('INSERT INTO user_admin_roles VALUES(?,1,1,?)').run(id, stamp);
  db.prepare('UPDATE music_profile_fields SET name=?,note=?,gender=?,gender_public=? WHERE profile_id=?').run('OWNER_NAME', targetNote, targetGender, Number(state === 'public'), target);
  db.prepare("INSERT INTO music_profile_contacts VALUES(?,'120002','self_reported',0,?)").run(target, stamp);
  db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(target, '120001', 'STALE_NAME', 1, 'PRIVATE_PIN_HASH', 'STALE_CONTACT', '{"note":"LEGACY_PRIVATE_NOTE","gender":"LEGACY_GENDER"}', '[]', 'prelinked');
  if (state === 'unlinked' || state === 'erased') {
    db.prepare('UPDATE music_profiles SET user_id=NULL,erased_at=? WHERE id=?').run(state === 'erased' ? stamp : null, target);
    db.prepare('INSERT INTO music_profiles VALUES(?,?,1,?,NULL)').run(matchId(33), 'alice', stamp);
    db.prepare("INSERT INTO music_profile_fields VALUES(?,'NEW_OWNER_PROFILE','',0,'',0,0,?)").run(matchId(33), stamp);
  }
  const app = createApp({ db, origin, now: () => new Date(stamp), botEnabledDefault: false, adminCredentialHash: () => hash(rescueKey) });
  cleanup.push(async () => { await app.close(); }); await app.ready();
  const headers = new Map<string, Record<string, string>>();
  for (const a of actors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const token = a.member ? (['alice', 'bob'].includes(a.id) ? 'fixture-' + a.id : 'music-' + a.id) : '';
    const r = await app.inject({ url: '/api/v2/session', headers: { cookie: token ? 'kanban_session=' + token : '' } });
    expect(r.statusCode, r.body).toBe(200);
    const session = r.json(), h = { cookie: token ? 'kanban_session=' + token : String(r.headers['set-cookie']).split(';')[0]!, origin, 'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
    if (a.id === 'rescue') {
      const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key: rescueKey, confirm: true } });
      expect(login.statusCode, login.body).toBe(200); h.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ url: '/api/v2/admin/session', headers: h })).json()).toMatchObject({ authMethod: 'credential', currentUserId: null });
    }
    headers.set(a.id, h);
  }
  const read = (url: string, a: Actor, patch: Record<string, string> = {}) => app.inject({ url, headers: { ...headers.get(a.id)!, ...patch } });
  const write = (url: string, payload: object, a: Actor, key = randomUUID(), patch: Record<string, string> = {}, method: 'POST' | 'PUT' = 'PUT') =>
    app.inject({ method, url, payload, headers: { ...headers.get(a.id)!, 'idempotency-key': key, ...patch } });
  return { app, db, headers, read, write };
}
const actor = (id: string) => actors.find(a => a.id === id)!;
const command = (kind: Command) => kind === 'fields' ? {
  url: '/api/v2/me/music/fields', payload: { profileId: target, musicEpoch: 0, revision: 0, name: 'OWNER_NAME', note: 'OWNER_NEW_NOTE', gender: targetGender, genderPublic: false },
} : kind === 'contact' ? {
  url: '/api/v2/me/music/contact', payload: { profileId: target, musicEpoch: 0, revision: 0, contactQQ: '120003' },
} : {
  url: '/api/v2/me/music', payload: { profileId: target, musicEpoch: 0, revision: 1, selections: [{ entryId: 'sub-2', level: 4 }] },
};

describe('music identity and private disclosure across states', () => {
  for (const a of actors) for (const state of ['private', 'public', 'unlinked', 'erased'] as const) it(a.id + ' / ' + state + ': cards, aliases, comparison and selectors keep their own disclosure rules', async () => {
    const s = await setup(state), before = snapshot(s.db), qualified = a.member && a.profile;
    const owns = a.id === 'alice' && ['private', 'public'].includes(state);
    const expectedStatus = !a.member ? 401 : !a.profile ? 403 : state === 'erased' ? 404 : 200;
    const note = a.note && (a.id !== 'alice' || owns) ? targetNote : '';
    const expectedCard = { id: target, name: 'OWNER_NAME', note, gender: owns || state === 'public' ? targetGender : '', contactQQ: '120002', contactSource: 'self_reported' };
    for (const [url, property] of [['/api/v2/me/music', 'id'], ['/api/v2/me/music/fields', 'profileId'], ['/api/v2/me/music/contact', 'profileId']] as const) {
      const own = await s.read(url, a);
      expect(own.statusCode, own.body).toBe(!a.member ? 401 : !a.profile && property === 'profileId' ? 404 : 200);
      if (own.statusCode === 200) {
        if (!a.profile) expect(own.json()).toBeNull();
        else expect(own.json()[property] === target).toBe(owns);
        if (!owns) expect(own.body).not.toMatch(/OWNER_PRIVATE_NOTE|OWNER_GENDER|120002/);
      }
    }
    const card = await s.read('/api/v2/music/profiles/' + target, a);
    expect(card.statusCode, card.body).toBe(expectedStatus);
    if (card.statusCode === 200) {
      expect(card.json()).toMatchObject(expectedCard);
      expect(card.json().selections.map((v: { entryId: string }) => v.entryId)).toEqual(['main-0', 'main-1', 'sub-0', 'sub-1', 'sub-2', 'sub-3']);
      expect(card.body).not.toMatch(/PRIVATE_PIN_HASH|LEGACY_PRIVATE_NOTE|LEGACY_GENDER|STALE_|user_id|token|revision|noteAt|genderPublic/);
    }
    for (const query of [target, '120001', '120002']) {
      const lookup = await s.write('/api/v2/music/profiles/lookup', { query }, a, randomUUID(), {}, 'POST');
      expect(lookup.statusCode, lookup.body).toBe(expectedStatus);
      if (lookup.statusCode === 200) expect(lookup.json()).toEqual(card.json());
    }
    for (const comparison of [await s.read('/api/v2/music/profiles/' + target + '/comparison', a), await s.write('/api/v2/music/compare', { query: '120001' }, a, randomUUID(), {}, 'POST')]) {
      expect(comparison.statusCode, comparison.body).toBe(owns ? 400 : expectedStatus);
      if (comparison.statusCode === 200) expect(comparison.json().other).toEqual(expectedCard);
      if (owns) expect(comparison.json().code).toBe('COMPARE_SELF');
    }
    const selectors = await s.read('/api/v2/music/entries/sub-2/members', a);
    expect(selectors.statusCode, selectors.body).toBe(!a.member ? 401 : !a.profile ? 403 : 200);
    if (qualified) {
      expect(selectors.json().members.some((v: { id: string }) => v.id === target)).toBe(state !== 'erased');
      expect(selectors.body).not.toMatch(/OWNER_PRIVATE_NOTE|OWNER_GENDER|note|gender|PRIVATE_PIN_HASH|LEGACY_|STALE_|user_id/);
    }
    const share = await s.read('/api/v2/me/music/share', a); expect(share.statusCode, share.body).toBe(a.member ? 200 : 401);
    expect(share.body).not.toMatch(/OWNER_PRIVATE_NOTE|OWNER_GENDER|note|gender|PRIVATE_PIN_HASH|LEGACY_|STALE_|user_id/);
    if (share.statusCode === 200) expect(share.json().profileId === target).toBe(owns);
    expect(snapshot(s.db)).toEqual(before);
  });
});

describe('music authoring remains owned by the current account', () => {
  for (const a of actors) for (const kind of ['fields', 'contact', 'selections'] as const) it(a.id + ' / ' + kind + ': cannot submit another profile or reuse its receipt', async () => {
    const s = await setup(), c = command(kind), key = randomUUID(), before = snapshot(s.db);
    const r = await s.write(c.url, c.payload, a, key);
    const status = !a.member ? 401 : a.id === 'alice' ? 200 : !a.profile && kind !== 'selections' ? 404 : 409;
    expect(r.statusCode, r.body).toBe(status);
    if (status !== 200) { expect(r.json().code).not.toBe('INVALID_INPUT'); expect(snapshot(s.db)).toEqual(before); return; }
    const allowed = new Set(['music_profiles', 'music_profile_fields', 'music_profile_contacts', 'music_legacy_profiles', 'music_selections', 'music_field_history', 'music_contact_history', 'music_profile_audit', 'request_results', 'music_profile_receipts']);
    const unchanged = (rows: Record<string, unknown>) => Object.fromEntries(Object.entries(rows).filter(([name]) => !allowed.has(name)));
    expect(unchanged(snapshot(s.db))).toEqual(unchanged(before));
    const saved = snapshot(s.db); expect((await s.write(c.url, c.payload, a, key)).json()).toEqual(r.json());
    for (const other of actors.filter(other => other.id !== 'alice')) {
      const retry = await s.write(c.url, c.payload, other, key);
      expect(retry.statusCode, retry.body).toBe(!other.member ? 401 : !other.profile && kind !== 'selections' ? 404 : 409);
      expect(retry.body).not.toMatch(/OWNER_NEW_NOTE|120003/);
    }
    expect(snapshot(s.db)).toEqual(saved);
  });
});

describe('music permissions are revalidated for reads and saved commands', () => {
  const boundaries = [
    { name: 'missing scope', patch: { 'x-account-scope': '' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'other scope', patch: { 'x-account-scope': 'other' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'missing origin', patch: { origin: '' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'foreign origin', patch: { origin: 'https://outside.example' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'wrong CSRF', patch: { 'x-csrf-token': '0'.repeat(64) }, status: 403, code: 'CSRF_REJECTED' },
  ] as const;
  for (const kind of ['fields', 'contact', 'selections'] as const) for (const boundary of boundaries) it(kind + ' / ' + boundary.name + ': rejects even a previously successful command', async () => {
    const s = await setup(), c = command(kind), a = actor('alice'), key = randomUUID();
    expect((await s.write(c.url, c.payload, a, key)).statusCode).toBe(200); const before = snapshot(s.db);
    for (const requestKey of [key, randomUUID()]) {
      const r = await s.write(c.url, c.payload, a, requestKey, boundary.patch);
      expect(r.statusCode, r.body).toBe(boundary.status); expect(r.json().code).toBe(boundary.code);
    }
    const lookup = await s.write('/api/v2/music/profiles/lookup', { query: target }, a, randomUUID(), boundary.patch, 'POST');
    expect(lookup.statusCode, lookup.body).toBe(boundary.status); expect(lookup.json().code).toBe(boundary.code);
    if (boundary.status === 409) for (const url of [c.url, '/api/v2/music/profiles/' + target, '/api/v2/me/music/share']) expect((await s.read(url, a, boundary.patch)).statusCode).toBe(409);
    expect(snapshot(s.db)).toEqual(before);
  });
  for (const kind of ['fields', 'contact', 'selections'] as const) for (const change of ['device-revoked', 'reassigned', 'ABA-relinked'] as const) it(kind + ' / ' + change + ': saved results cannot restore former authority', async () => {
    const s = await setup(), c = command(kind), a = actor('alice'), key = randomUUID();
    expect((await s.write(c.url, c.payload, a, key)).statusCode).toBe(200);
    if (change === 'device-revoked') s.db.prepare("DELETE FROM browser_sessions WHERE user_id='alice'").run();
    else s.db.transaction(() => {
      s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(target);
      invalidateMusicOwnership(s.db, target, ['alice']);
      if (change === 'ABA-relinked') s.db.prepare("UPDATE music_profiles SET user_id='alice' WHERE id=?").run(target);
    }).immediate();
    const before = snapshot(s.db), r = await s.write(c.url, c.payload, a, key);
    expect(r.statusCode, r.body).toBe(change === 'device-revoked' ? 401 : 410);
    expect(r.body).not.toMatch(/OWNER_NEW_NOTE|120003/); expect(snapshot(s.db)).toEqual(before);
    if (change !== 'device-revoked') {
      const stale = await s.write(c.url, c.payload, a);
      expect(stale.statusCode, stale.body).toBe(change === 'reassigned' && kind !== 'selections' ? 404 : 409);
      expect(snapshot(s.db)).toEqual(before);
    }
  });
});
