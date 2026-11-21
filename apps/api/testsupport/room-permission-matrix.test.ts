import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';
import { atRoomWorkerResult } from './room-worker-boundary';

const origin = 'https://rebuild.example', stamp = '2026-11-17T00:00:00+00:00';
const rescueKey = 'synthetic-room-rescue-' + 'x'.repeat(32);
// Viewing a private activity and holding a draft duty are separate grants.
// Account/rescue administration gives neither grant and never creates music.
const actors = [
  { id: 'alice', member: true, profile: true, private: true, draft: true },
  { id: 'bob', member: true, profile: true, private: false, draft: false },
  { id: 'roster', member: true, profile: true, private: true, draft: true },
  { id: 'schedule', member: true, profile: true, private: true, draft: true },
  { id: 'access', member: true, profile: true, private: true, draft: false },
  { id: 'outsider', member: true, profile: true, private: false, draft: false },
  { id: 'admin', member: true, profile: true, private: false, draft: false },
  { id: 'admin-empty', member: true, profile: false, private: false, draft: false },
  { id: 'rescue', member: false, profile: false, private: false, draft: false },
  { id: 'visitor', member: false, profile: false, private: false, draft: false },
  { id: 'anonymous', member: false, profile: false, private: false, draft: false },
] as const;
type Actor = typeof actors[number];
type State = 'free' | 'listen' | 'invite' | 'draft' | 'deleted';
type Command = 'analyze' | 'split' | 'recalc';
const actor = (id: string) => actors.find(a => a.id === id)!;
const profileId = (id: string) => 'm_' + (actors.findIndex(a => a.id === id) + 1).toString(16).padStart(24, '0');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function snapshot(db: DB) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(names.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]));
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-room-authority-')); cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const db = openDatabase(join(root, 'owned.sqlite3')); cleanup.push(async () => { db.close(); }); fixture(db);
  for (const a of actors.filter(a => a.member)) {
    if (!['alice', 'bob'].includes(a.id)) {
      db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(a.id, hash('room-' + a.id), a.id, stamp);
      db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('room-' + a.id), a.id, stamp);
    }
    if (a.profile) {
      const id = profileId(a.id); db.prepare('INSERT INTO music_profiles VALUES(?,?,1,?,NULL)').run(id, a.id, stamp);
      db.prepare('INSERT INTO music_profile_fields VALUES(?,?,?,1,?,0,0,?)').run(id, 'Music ' + a.id, 'PRIVATE_NOTE_' + a.id, 'PRIVATE_GENDER_' + a.id, stamp);
      db.prepare("INSERT INTO music_profile_contacts VALUES(?,?,'self_reported',0,?)").run(id, String(120000 + actors.findIndex(actor => actor.id === a.id)), stamp);
      for (const [position, entry] of ['main-0', 'sub-2'].entries()) db.prepare('INSERT INTO music_selections VALUES(?,?,4,?)').run(id, entry, position);
    }
  }
  for (const id of ['admin', 'admin-empty']) db.prepare('INSERT INTO user_admin_roles VALUES(?,1,1,?)').run(id, stamp);
  for (const state of ['listen', 'invite', 'draft', 'deleted']) {
    db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,'alice','individual',?)").run(state + '-party', state, stamp);
    for (const [who, status] of [['alice', 'confirmed'], ['bob', 'waiting'], ['guest', 'tentative']] as const) {
      db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,created_at,updated_at)
        VALUES(?,?,'alice',?,?,?,'PRIVATE_ATTENDEE_NOTE',?,?,?,?)`).run(state + '-' + who, state, who === 'guest' ? null : who, state + '-party', 'person-' + who, who === 'guest' ? 'manager' : 'self', status, stamp, stamp);
    }
    for (const duty of ['roster', 'schedule']) db.prepare('INSERT INTO event_roles VALUES(?,?,?,?,?)').run(state + '-' + duty, state, duty, JSON.stringify([duty]), stamp);
  }
  for (const who of ['roster', 'schedule', 'access']) db.prepare("INSERT INTO event_access VALUES('invite',?,?)").run(who, stamp);
  const app = createApp({ db, origin, now: () => new Date(stamp), botEnabledDefault: false, adminCredentialHash: () => hash(rescueKey) });
  cleanup.push(async () => { await app.close(); }); await app.ready();
  const headers = new Map<string, Record<string, string>>();
  for (const a of actors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const token = a.member ? (['alice', 'bob'].includes(a.id) ? 'fixture-' + a.id : 'room-' + a.id) : '';
    const r = await app.inject({ url: '/api/v2/session', headers: { cookie: token ? 'kanban_session=' + token : '' } }); expect(r.statusCode, r.body).toBe(200);
    const session = r.json(), h = { cookie: token ? 'kanban_session=' + token : String(r.headers['set-cookie']).split(';')[0]!, origin, 'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
    if (a.id === 'rescue') {
      const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key: rescueKey, confirm: true } });
      expect(login.statusCode, login.body).toBe(200); h.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ url: '/api/v2/admin/session', headers: h })).json()).toMatchObject({ authMethod: 'credential', currentUserId: null });
    }
    headers.set(a.id, h);
  }
  const query = (state: State) => state === 'free' ? '' : '?eventId=' + state;
  const read = (state: State, a: Actor, patch: Record<string, string> = {}) => app.inject({ url: '/api/v2/music/rooms/source' + query(state), headers: { ...headers.get(a.id)!, ...patch } });
  const calculate = (state: State, payload: object, a: Actor, patch: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/v2/music/rooms/calculate' + query(state), payload, headers: { ...headers.get(a.id)!, 'idempotency-key': randomUUID(), ...patch } });
  return { app, db, headers, read, calculate };
}
function command(kind: Command, state: State, sourceVersion: string) {
  const selected = state === 'free' ? [profileId('alice'), profileId('bob')] : [state + '-alice', state + '-bob'];
  return kind === 'analyze' ? { command: kind, sourceVersion, selected } : kind === 'split' ? { command: kind, sourceVersion, selected, config: { mode: 'rooms', value: 2 }, sameGender: true } : {
    command: kind, sourceVersion, selected,
    rooms: [{ id: '00000000-0000-4000-8000-000000000001', capacity: 3, members: [...selected, ...(state === 'free' ? [] : [state + '-guest'])] }],
  };
}
const sensitive = /PRIVATE_|gender|contact|note|token|user_id|credential/;

describe('free and activity room authorization matrix', () => {
  for (const a of actors) for (const state of ['free', 'listen', 'invite', 'draft', 'deleted'] as const) it(a.id + ' / ' + state + ': source and all CPU commands use current music and activity authority', async () => {
    const s = await setup(), before = snapshot(s.db), status = !a.member ? 401 : !a.profile ? 403 : state === 'deleted' || state === 'invite' && !a.private || state === 'draft' && !a.draft ? 404 : 200;
    const source = await s.read(state, a); expect(source.statusCode, source.body).toBe(status); expect(source.body).not.toMatch(sensitive);
    if (status !== 200) expect(source.json().code).toBe(status === 401 ? 'LOGIN_REQUIRED' : status === 403 ? 'MUSIC_PROFILE_REQUIRED' : 'NOT_FOUND');
    else {
      expect(source.json().eventId).toBe(state === 'free' ? null : state);
      expect(source.json().canAdopt).toBe(a.id === 'alice' && ['listen', 'invite'].includes(state));
      expect(source.json().members.filter((m: { isMe: boolean }) => m.isMe).map((m: { id: string }) => m.id)).toEqual(state === 'free' ? [profileId(a.id)] : ['alice', 'bob'].includes(a.id) ? [state + '-' + a.id] : []);
      if (state !== 'free') expect(source.json().members.map((m: { id: string; profileId: string | null; status: string }) => [m.id, m.profileId, m.status])).toEqual([
        [state + '-alice', profileId('alice'), 'confirmed'], [state + '-bob', profileId('bob'), 'waiting'], [state + '-guest', null, 'tentative'],
      ]);
    }
    for (const kind of ['analyze', 'split', 'recalc'] as const) {
      const payload = command(kind, state, status === 200 ? source.json().sourceVersion : '0'.repeat(64)), result = await s.calculate(state, payload, a);
      expect(result.statusCode, result.body).toBe(status); expect(result.body).not.toMatch(sensitive);
      if (status !== 200) expect(result.json().code).toBe(source.json().code);
      else {
        expect(result.json().sourceVersion).toBe(source.json().sourceVersion); expect(result.json().selected).toEqual(payload.selected);
        if (kind === 'analyze') expect(result.json().analysis.members.map((m: { id: string }) => m.id).sort()).toEqual([...payload.selected].sort());
        else expect(result.json().rooms.flatMap((room: { members: string[] }) => room.members).sort()).toEqual([...payload.selected, ...(kind === 'recalc' && state !== 'free' ? [state + '-guest'] : [])].sort());
      }
      expect(snapshot(s.db)).toEqual(before);
    }
    if (status === 200 && a.id !== 'alice') {
      const owner = await s.read(state, actor('alice')); expect(owner.statusCode).toBe(200); expect(owner.json().sourceVersion).not.toBe(source.json().sourceVersion);
      const foreign = await s.calculate(state, command('analyze', state, owner.json().sourceVersion), a); expect(foreign.statusCode).toBe(409); expect(foreign.json().code).toBe('ROOM_SOURCE_CHANGED'); expect(snapshot(s.db)).toEqual(before);
    }
  });
});

describe('room command credential boundaries', () => {
  const boundaries = [
    { name: 'missing scope', patch: { 'x-account-scope': '' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'foreign scope', patch: { 'x-account-scope': 'other' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'missing origin', patch: { origin: '' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'foreign origin', patch: { origin: 'https://outside.example' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'wrong CSRF', patch: { 'x-csrf-token': '0'.repeat(64) }, status: 403, code: 'CSRF_REJECTED' },
  ] as const;
  for (const kind of ['analyze', 'split', 'recalc'] as const) for (const boundary of boundaries) it(kind + ' / ' + boundary.name + ': rejects a valid saved calculation before starting work', async () => {
    const s = await setup(), a = actor('alice'), source = (await s.read('free', a)).json(), before = snapshot(s.db), observer = atRoomWorkerResult(source.sourceVersion, () => {});
    try {
      const response = await s.calculate('free', command(kind, 'free', source.sourceVersion), a, boundary.patch);
      expect(response.statusCode, response.body).toBe(boundary.status); expect(response.json().code).toBe(boundary.code); expect(observer.calls).toBe(0);
      if (boundary.status === 409) expect((await s.read('free', a, boundary.patch)).statusCode).toBe(409);
      expect(snapshot(s.db)).toEqual(before);
    } finally { observer.restore(); }
  });
});

describe('room authority after real CPU work', () => {
  const cases = [
    { name: 'device revoked', who: 'alice', state: 'free', status: 401, code: 'LOGIN_REQUIRED', mutate: (db: DB) => db.prepare("DELETE FROM browser_sessions WHERE user_id='alice'").run() },
    { name: 'private access revoked', who: 'access', state: 'invite', status: 404, code: 'NOT_FOUND', mutate: (db: DB) => db.prepare("DELETE FROM event_access WHERE event_id='invite' AND user_id='access'").run() },
    { name: 'draft duty revoked', who: 'schedule', state: 'draft', status: 404, code: 'NOT_FOUND', mutate: (db: DB) => db.prepare("DELETE FROM event_roles WHERE event_id='draft' AND user_id='schedule'").run() },
    { name: 'private owner changed', who: 'alice', state: 'invite', status: 404, code: 'NOT_FOUND', mutate: (db: DB) => db.prepare("UPDATE events SET owner_id='bob' WHERE id='invite'").run() },
    { name: 'own music reassigned', who: 'alice', state: 'free', status: 403, code: 'MUSIC_PROFILE_REQUIRED', mutate: (db: DB) => db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(profileId('alice')) },
    { name: 'selected music erased', who: 'alice', state: 'free', status: 409, code: 'ROOM_SOURCE_CHANGED', mutate: (db: DB) => db.prepare('UPDATE music_profiles SET user_id=NULL,erased_at=? WHERE id=?').run(stamp, profileId('bob')) },
    { name: 'visible source changed', who: 'alice', state: 'free', status: 409, code: 'ROOM_SOURCE_CHANGED', mutate: (db: DB) => db.prepare("UPDATE music_profile_fields SET name='Changed music' WHERE profile_id=?").run(profileId('bob')) },
    { name: 'activity deleted', who: 'roster', state: 'invite', status: 404, code: 'NOT_FOUND', mutate: (db: DB) => db.prepare("UPDATE events SET status='deleted' WHERE id='invite'").run() },
    { name: 'private fields changed', who: 'alice', state: 'free', status: 200, code: null, mutate: (db: DB) => db.prepare("UPDATE music_profile_fields SET gender='PRIVATE_GENDER_CHANGED',note='PRIVATE_NOTE_CHANGED' WHERE profile_id=?").run(profileId('bob')) },
    { name: 'unrelated administration revoked', who: 'admin', state: 'listen', status: 200, code: null, mutate: (db: DB) => db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='admin'").run() },
  ] as const;
  for (const c of cases) it(c.name + ': observes a real completed worker then rechecks the applicable authority', async () => {
    const s = await setup(), a = actor(c.who), source = await s.read(c.state, a); expect(source.statusCode, source.body).toBe(200);
    let after: ReturnType<typeof snapshot> | undefined;
    const observer = atRoomWorkerResult(source.json().sourceVersion, () => { c.mutate(s.db); after = snapshot(s.db); });
    try {
      const response = await s.calculate(c.state, command('analyze', c.state, source.json().sourceVersion), a);
      expect(observer.calls).toBe(1); expect(after).toBeDefined(); expect(response.statusCode, response.body).toBe(c.status);
      if (c.code) expect(response.json().code).toBe(c.code); else expect(response.json().sourceVersion).toBe(source.json().sourceVersion);
      expect(response.body).not.toMatch(sensitive); expect(snapshot(s.db)).toEqual(after);
    } finally { observer.restore(); }
  });
});
