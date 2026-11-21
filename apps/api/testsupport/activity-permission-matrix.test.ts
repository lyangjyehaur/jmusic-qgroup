import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';

const origin = 'https://rebuild.example';
const stamp = '2026-11-17T00:00:00+00:00';
const rescueKey = 'synthetic-permission-matrix-' + 'x'.repeat(32);
const states = ['listen', 'invite', 'draft', 'deleted'] as const;
type State = typeof states[number];
type Headers = Record<string, string>;

// Expected authority is declared here, independently of the production guards.
// Invitation access and draft access are separate; neither administration nor
// managing a person grants them automatically.
const actors = [
  { id: 'alice', member: true, private: true, draft: true, scopes: ['owner', 'schedule', 'roster', 'attendance', 'settlement'], admin: false },
  { id: 'schedule', member: true, private: true, draft: true, scopes: ['schedule'], admin: false },
  { id: 'roster', member: true, private: true, draft: true, scopes: ['roster'], admin: false },
  { id: 'attendance', member: true, private: true, draft: true, scopes: ['attendance'], admin: false },
  { id: 'settlement', member: true, private: true, draft: true, scopes: ['settlement'], admin: false },
  { id: 'combined', member: true, private: true, draft: true, scopes: ['roster', 'attendance'], admin: false },
  { id: 'manager', member: true, private: true, draft: false, scopes: [], admin: false },
  { id: 'invitee', member: true, private: true, draft: false, scopes: [], admin: false },
  { id: 'attendee', member: true, private: false, draft: false, scopes: [], admin: false },
  { id: 'outsider', member: true, private: false, draft: false, scopes: [], admin: false },
  { id: 'admin', member: true, private: false, draft: false, scopes: [], admin: true },
  { id: 'invited-admin', member: true, private: true, draft: false, scopes: [], admin: true },
  { id: 'rescue', member: false, private: false, draft: false, scopes: [], admin: false },
  { id: 'visitor', member: false, private: false, draft: false, scopes: [], admin: false },
  { id: 'anonymous', member: false, private: false, draft: false, scopes: [], admin: false },
] as const;
type Actor = typeof actors[number];
const has = (actor: Actor, scope: string) => (actor.scopes as readonly string[]).includes(scope);
const accessible = (actor: Actor, state: State) => state === 'listen' || (state === 'invite' && actor.private) || (state === 'draft' && actor.draft);
const actorById = (id: string) => actors.find(actor => actor.id === id)!;
const invitationToken = (state: State) => 'p' + hash(state).slice(0, 31);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const db = openDatabase(':memory:');
  cleanup.push(async () => { db.close(); });
  fixture(db);
  for (const actor of actors.filter(actor => actor.member && actor.id !== 'alice')) {
    const token = 'matrix-' + actor.id;
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(actor.id, hash(token), actor.id, stamp);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash(token), actor.id, stamp);
  }
  for (const state of states) {
    for (const actor of actors.filter(actor => actor.member && actor.id !== 'alice')) {
      if (actor.scopes.length) db.prepare('INSERT INTO event_roles VALUES(?,?,?,?,?)').run(state + '-' + actor.id, state, actor.id, JSON.stringify(actor.scopes), stamp);
      if (actor.private) db.prepare('INSERT INTO event_access VALUES(?,?,?)').run(state, actor.id, stamp);
    }
    for (const [suffix, userId, name] of [['person', 'attendee', '本人'], ['guest', null, '同行']] as const) {
      db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,name,note,payer_kind,status,created_at,updated_at,accepted_conditions_version,confirmation_state)
        VALUES(?,?,'manager',?,?,'公開備註','manager','confirmed',?,?,1,'accepted')`).run(state + '-' + suffix, state, userId, name, stamp, stamp);
    }
    db.prepare(`INSERT INTO management_invitations(id,event_id,token,kind,target_name,permissions_json,status,initiator_id,created_at,expires_at)
      VALUES(?,?,?,'cohost','專屬交接對象','["schedule"]','pending','alice',?,'2099-12-01T00:00:00+00:00')`).run('pending-' + state, state, invitationToken(state), stamp);
  }
  db.exec("INSERT INTO user_admin_roles VALUES('admin',1,1,'before'),('invited-admin',1,1,'before')");
  const app = createApp({ db, origin, now: () => new Date(stamp), adminCredentialHash: () => hash(rescueKey) });
  cleanup.push(async () => { await app.close(); });
  await app.ready();
  const headers = new Map<string, Headers>();
  for (const actor of actors) {
    if (actor.id === 'anonymous') { headers.set(actor.id, {}); continue; }
    const token = actor.member ? (actor.id === 'alice' ? 'fixture-alice' : 'matrix-' + actor.id) : '';
    const session = await app.inject({ url: '/api/v2/session', headers: { cookie: token ? 'kanban_session=' + token : '' } });
    expect(session.statusCode, session.body).toBe(200);
    const viewer = session.json();
    const h = { cookie: token ? 'kanban_session=' + token : String(session.headers['set-cookie']).split(';')[0]!, origin,
      'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
    if (actor.id === 'rescue') {
      const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key: rescueKey, confirm: true } });
      expect(login.statusCode, login.body).toBe(200);
      h.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ url: '/api/v2/admin/session', headers: h })).json()).toMatchObject({ authMethod: 'credential', currentUserId: null });
    }
    headers.set(actor.id, h);
  }
  const read = (state: State, suffix: string, actor: Actor) => app.inject({ url: '/api/v2/activities/' + state + '/' + suffix, headers: headers.get(actor.id)! });
  const write = (state: State, suffix: string, payload: object, actor: Actor, key = randomUUID(), method: 'POST' | 'PUT' = 'POST') =>
    app.inject({ method, url: '/api/v2/activities/' + state + '/' + suffix, headers: { ...headers.get(actor.id)!, 'idempotency-key': key }, payload });
  return { db, app, headers, read, write };
}

function snapshot(db: DB) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]));
}
function values() {
  return { title: '核對活動', category: '其他', location: '台北 · 河岸小屋', startsAt: '2099-12-12T06:00:00+00:00',
    deadline: '2099-12-11T06:00:00+00:00', capacity: 12, description: '帶一首最近喜歡的歌來分享。\n聽歌、聊天，認識新的同好。',
    durationHours: 3, withdrawalDeadline: null, visibility: 'public', timezone: 'Asia/Taipei', minimumParticipants: 0,
    feePolicy: '', botEnabled: false, joinOwner: true };
}
const consent = { revision: 0, conditionsVersion: 1, decision: 'accepted', reason: '' };
const observe = { revision: 0, attendance: 'present', note: '核對到場', arrivedAt: null, leftAt: null, reason: '核對', confirm: true };
const onsite = { revision: 0, conditionsVersion: 1, people: [{ isSelf: false, name: '現場同行', note: '', payerKind: 'manager' }],
  reason: '現場補錄', acceptConditions: true, allowOverCapacity: false, overrideWaitlist: false, confirm: true };

describe('independent activity role and state matrix', () => {
  for (const actor of actors) for (const state of states) it(actor.id + ' / ' + state + ': access, projections and denied commands preserve all stored data', async () => {
    const s = await setup(), before = snapshot(s.db), access = accessible(actor, state);
    const readStatus = (memberOnly: boolean) => memberOnly && !actor.member ? 401 : access ? 200 : 404;
    for (const suffix of ['roster', 'conditions', 'finance']) {
      const response = await s.read(state, suffix, actor);
      expect(response.statusCode, suffix + ': ' + response.body).toBe(readStatus(false));
      if (response.statusCode === 200) {
        const data = response.json();
        if (suffix === 'roster') {
          expect(data.participants.every((person: { managedByMe: boolean }) => person.managedByMe === (actor.id === 'manager'))).toBe(true);
          expect(data.participants.filter((person: { isMe: boolean }) => person.isMe)).toHaveLength(actor.id === 'attendee' ? 1 : 0);
        }
        if (suffix === 'conditions') expect(data.people.map((person: { id: string }) => person.id).sort()).toEqual(actor.id === 'manager' ? [state + '-guest', state + '-person'] : []);
        if (suffix === 'finance') expect(data.summary.can_manage).toBe(has(actor, 'settlement'));
      }
    }
    for (const suffix of ['arrangements', 'attendance', 'lifecycle', 'delegation', 'draft']) {
      let expected = readStatus(true);
      if (expected === 200 && suffix === 'arrangements' && state === 'draft') expected = 409;
      if (expected === 200 && suffix === 'attendance' && !has(actor, 'attendance')) expected = 403;
      if (expected === 200 && suffix === 'draft' && state !== 'draft') expected = actor.scopes.length ? 409 : 404;
      if (state === 'deleted' && suffix === 'lifecycle' && actor.id === 'alice') expected = 200;
      const response = await s.read(state, suffix, actor);
      expect(response.statusCode, suffix + ': ' + response.body).toBe(expected);
      if (response.statusCode === 200) {
        const data = response.json();
        if (suffix === 'arrangements') expect(data).toMatchObject({ isOwner: actor.id === 'alice', assisted: actor.admin, canEdit: has(actor, 'schedule') || actor.admin });
        if (suffix === 'attendance') expect(data).toMatchObject({ canObserve: false, canAdd: false });
        if (suffix === 'draft') expect(data).toMatchObject({ isOwner: actor.id === 'alice', canEdit: has(actor, 'schedule') });
        if (suffix === 'lifecycle') expect(data.actions.map((action: { action: string }) => action.action)).toEqual(has(actor, 'owner')
          ? ['pause', 'resume', 'formation', 'start', 'finish', 'cancel', 'archive', 'unarchive', 'remove']
          : has(actor, 'schedule') ? ['pause', 'resume', 'start', 'finish'] : []);
        if (suffix === 'delegation') {
          expect(data.invitations).toHaveLength(actor.id === 'alice' ? 1 : 0);
          expect(data.targets).toHaveLength(actor.id === 'alice' ? 1 : 0);
          if (actor.id !== 'alice') expect(response.body).not.toContain(invitationToken(state));
        }
      }
    }
    expect(snapshot(s.db)).toEqual(before);

    // Bodies are valid. Only commands for which the declared actor lacks
    // authority are attempted here; a schema error is never a passing denial.
    const commands = [
      { suffix: 'arrangements', method: 'PUT' as const, allowed: has(actor, 'schedule') || actor.admin,
        payload: { revision: 0, values: { ...values(), visibility: state === 'invite' ? 'invitation' : 'public' }, reason: '核對安排' } },
      { suffix: 'lifecycle', method: 'POST' as const, allowed: has(actor, 'schedule'), payload: { revision: 0, action: 'pause', confirm: true } },
      { suffix: 'attendance/' + state + '-person', method: 'POST' as const, allowed: has(actor, 'attendance'), payload: observe },
      { suffix: 'onsite', method: 'POST' as const, allowed: has(actor, 'attendance') && has(actor, 'roster'), payload: onsite },
      { suffix: 'attendees/' + state + '-person/conditions', method: 'POST' as const, allowed: actor.id === 'manager', payload: consent },
      { suffix: 'invitations', method: 'POST' as const, allowed: has(actor, 'roster'), payload: { revision: 0, people: onsite.people, reason: '補報名', confirm: true } },
      { suffix: 'finance', method: 'POST' as const, allowed: has(actor, 'settlement'), payload: { revision: 0, operation: { command: 'close' }, preview_token: 'a'.repeat(64), confirm: true } },
      { suffix: 'delegation/invitations', method: 'POST' as const, allowed: actor.id === 'alice',
        payload: { revision: 0, kind: 'cohost', targetName: '交接對象', permissions: ['schedule'], reason: '交接', confirm: true } },
    ];
    for (const command of commands.filter(command => !command.allowed || !access)) {
      const response = await s.write(state, command.suffix, command.payload, actor, randomUUID(), command.method);
      const expected = !actor.member ? 401 : !access ? 404 : 403;
      expect(response.statusCode, command.suffix + ': ' + response.body).toBe(expected);
      expect(response.json().code).not.toBe('INVALID_INPUT');
      expect(snapshot(s.db), command.suffix).toEqual(before);
    }
  });
});

describe('activity permission changes and receipt replay', () => {
  for (const mode of ['role', 'access'] as const) it('reauthorizes schedule writes and receipt reads after revoking ' + mode, async () => {
    const s = await setup(), actor = actorById('schedule'), key = randomUUID();
    const payload = { revision: 0, values: { ...values(), visibility: 'invitation' }, reason: '核對安排' };
    const first = await s.write('invite', 'arrangements', payload, actor, key, 'PUT');
    expect(first.statusCode, first.body).toBe(200);
    const accepted = snapshot(s.db);
    expect((await s.write('invite', 'arrangements', payload, actor, key, 'PUT')).json()).toEqual(first.json());
    expect(snapshot(s.db)).toEqual(accepted);
    s.db.prepare(mode === 'role' ? "DELETE FROM event_roles WHERE event_id='invite' AND user_id='schedule'" : "DELETE FROM event_access WHERE event_id='invite' AND user_id='schedule'").run();
    const revoked = snapshot(s.db);
    const repeated = await s.write('invite', 'arrangements', payload, actor, key, 'PUT');
    const recovered = await s.app.inject({ url: '/api/v2/activities/management-results/' + key, headers: s.headers.get(actor.id)! });
    for (const response of [repeated, recovered]) expect(response.statusCode, response.body).toBe(mode === 'role' ? 403 : 404);
    expect(snapshot(s.db)).toEqual(revoked);
  });

  it('does not let a stored role grant invitation access or access alone reveal a draft', async () => {
    const s = await setup(), actor = actorById('schedule');
    s.db.prepare("DELETE FROM event_access WHERE event_id='invite' AND user_id='schedule'").run();
    const before = snapshot(s.db);
    for (const suffix of ['roster', 'arrangements', 'attendance', 'finance', 'delegation']) expect((await s.read('invite', suffix, actor)).statusCode).toBe(404);
    for (const suffix of ['roster', 'conditions', 'draft', 'finance']) expect((await s.read('draft', suffix, actorById('invitee'))).statusCode).toBe(404);
    expect(snapshot(s.db)).toEqual(before);
  });

  it('checks the current person manager before consent replay, including owner and administrator attempts', async () => {
    const s = await setup(), manager = actorById('manager'), key = randomUUID();
    const first = await s.write('listen', 'attendees/listen-person/conditions', consent, manager, key);
    expect(first.statusCode, first.body).toBe(200);
    expect((await s.write('listen', 'attendees/listen-person/conditions', consent, manager, key)).json()).toEqual(first.json());
    s.db.prepare("UPDATE attendees SET manager_id='outsider' WHERE id='listen-person'").run();
    const before = snapshot(s.db);
    for (const actor of [manager, actorById('alice'), actorById('roster'), actorById('admin')]) {
      const response = await s.write('listen', 'attendees/listen-person/conditions', consent, actor, key);
      expect(response.statusCode, response.body).toBe(403);
    }
    expect((await s.app.inject({ url: '/api/v2/activities/management-results/' + key, headers: s.headers.get(manager.id)! })).statusCode).toBe(403);
    expect(snapshot(s.db)).toEqual(before);
  });

  it('revokes owner command and recovery authority after ownership changes', async () => {
    const s = await setup(), actor = actorById('alice'), key = randomUUID(), payload = { revision: 0, action: 'cancel', reason: '取消核對', confirm: true };
    const first = await s.write('listen', 'lifecycle', payload, actor, key);
    expect(first.statusCode, first.body).toBe(200);
    s.db.prepare("UPDATE events SET owner_id='outsider' WHERE id='listen'").run();
    const before = snapshot(s.db);
    expect((await s.write('listen', 'lifecycle', payload, actor, key)).statusCode).toBe(403);
    expect((await s.app.inject({ url: '/api/v2/activities/lifecycle-results/' + key, headers: s.headers.get(actor.id)! })).statusCode).toBe(403);
    expect(snapshot(s.db)).toEqual(before);
  });

  it('blocks attendance replay after revocation and requires both scopes for onsite additions', async () => {
    const s = await setup(), actor = actorById('combined'), key = randomUUID();
    s.db.exec("UPDATE events SET lifecycle='ongoing',actual_started_at='2026-11-16T23:00:00+00:00' WHERE id='listen'");
    const first = await s.write('listen', 'attendance/listen-person', observe, actor, key);
    expect(first.statusCode, first.body).toBe(200);
    const accepted = snapshot(s.db);
    expect((await s.write('listen', 'attendance/listen-person', observe, actor, key)).json()).toEqual(first.json());
    expect(snapshot(s.db)).toEqual(accepted);
    s.db.prepare("UPDATE event_roles SET permissions_json='[\"roster\"]' WHERE event_id='listen' AND user_id='combined'").run();
    const before = snapshot(s.db);
    expect((await s.write('listen', 'attendance/listen-person', observe, actor, key)).statusCode).toBe(403);
    for (const id of ['attendance', 'roster', 'combined', 'admin']) expect((await s.write('listen', 'onsite', { ...onsite, revision: first.json().revision }, actorById(id))).statusCode).toBe(403);
    expect(snapshot(s.db)).toEqual(before);
  });
});

describe('authorized activity commands and state locks', () => {
  for (const id of ['alice', 'schedule', 'admin', 'invited-admin']) for (const state of ['listen', 'invite'] as const) {
    if (state === 'invite' && id === 'admin') continue;
    it(id + ' edits ' + state + ' arrangements with the current authority', async () => {
      const s = await setup(), actor = actorById(id), key = randomUUID();
      const payload = { revision: 0, values: { ...values(), visibility: state === 'invite' ? 'invitation' : 'public' }, reason: '核對安排' };
      const first = await s.write(state, 'arrangements', payload, actor, key, 'PUT');
      expect(first.statusCode, first.body).toBe(200);
      expect(s.db.prepare('SELECT title,owner_id FROM events WHERE id=?').get(state)).toEqual({ title: '核對活動', owner_id: 'alice' });
      const before = snapshot(s.db);
      expect((await s.write(state, 'arrangements', payload, actor, key, 'PUT')).json()).toEqual(first.json());
      expect(snapshot(s.db)).toEqual(before);
    });
  }
  for (const id of ['alice', 'schedule']) it(id + ' can edit a draft and pause published registration', async () => {
    const s = await setup(), actor = actorById(id);
    const draft = await s.write('draft', 'draft', { revision: 0, values: values(), reason: '核對草稿' }, actor, randomUUID(), 'PUT');
    expect(draft.statusCode, draft.body).toBe(200);
    const pause = await s.write('listen', 'lifecycle', { revision: 0, action: 'pause', confirm: true }, actor);
    expect(pause.statusCode, pause.body).toBe(200);
    expect(s.db.prepare("SELECT lifecycle,registration_open FROM events WHERE id='listen'").get()).toEqual({ lifecycle: 'scheduled', registration_open: 0 });
    expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual([]);
  });
  for (const id of ['alice', 'roster', 'combined']) it(id + ' can issue a registration invitation', async () => {
    const s = await setup();
    const response = await s.write('listen', 'invitations', { revision: 0, people: onsite.people, reason: '補報名', confirm: true }, actorById(id));
    expect(response.statusCode, response.body).toBe(200);
    expect(s.db.prepare("SELECT manager_id,name,status FROM attendees WHERE event_id='listen' AND status='invited'").all()).toEqual([{ manager_id: id, name: '現場同行', status: 'invited' }]);
    expect(s.db.prepare('SELECT * FROM finance_entries').all()).toEqual([]);
  });
  for (const id of ['alice', 'attendance', 'combined']) it(id + ' can observe attendance after the activity starts', async () => {
    const s = await setup();
    s.db.exec("UPDATE events SET lifecycle='ongoing',actual_started_at='2026-11-16T23:00:00+00:00' WHERE id='listen'");
    const actor = actorById(id), context = await s.read('listen', 'attendance', actor);
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json()).toMatchObject({ canObserve: true, canAdd: id !== 'attendance' });
    const response = await s.write('listen', 'attendance/listen-person', observe, actor);
    expect(response.statusCode, response.body).toBe(200);
    expect(s.db.prepare("SELECT attendance,status,manager_id FROM attendees WHERE id='listen-person'").get()).toEqual({ attendance: 'present', status: 'confirmed', manager_id: 'manager' });
  });
  for (const id of ['alice', 'combined']) it(id + ' can add an onsite person with both required scopes', async () => {
    const s = await setup();
    s.db.exec("UPDATE events SET lifecycle='ongoing',actual_started_at='2026-11-16T23:00:00+00:00' WHERE id='listen'");
    const response = await s.write('listen', 'onsite', onsite, actorById(id));
    expect(response.statusCode, response.body).toBe(200);
    expect(s.db.prepare("SELECT manager_id,attendance,confirmation_state FROM attendees WHERE event_id='listen' AND name='現場同行'").get()).toEqual({ manager_id: id, attendance: 'present', confirmation_state: 'accepted' });
    expect(s.db.prepare('SELECT * FROM finance_entries').all()).toEqual([]);
  });
  for (const mode of ['role', 'access'] as const) it('reauthorizes accepted finance writes after revoking ' + mode, async () => {
    const s = await setup(), actor = actorById('settlement'), key = randomUUID();
    const context = await s.read('invite', 'finance', actor);
    expect(context.statusCode, context.body).toBe(200);
    const payload = { revision: 0, operation: { command: 'record', id: 'a'.repeat(16), transaction: { kind: 'deposit', amount: '10.00',
      occurred_at: stamp, note: '', reason: '訂金核對', funding: 'payer', payer_id: context.json().default_custodian_id,
      merchant: '測試店家', method: 'cash', custom_parties: [] } } };
    const preview = await s.write('invite', 'finance/preview', payload, actor);
    expect(preview.statusCode, preview.body).toBe(200);
    const command = { ...payload, preview_token: preview.json().preview_token, confirm: true };
    const first = await s.write('invite', 'finance', command, actor, key);
    expect(first.statusCode, first.body).toBe(200);
    const accepted = snapshot(s.db);
    expect((await s.write('invite', 'finance', command, actor, key)).json()).toEqual(first.json());
    expect(snapshot(s.db)).toEqual(accepted);
    s.db.prepare(mode === 'role' ? "DELETE FROM event_roles WHERE event_id='invite' AND user_id='settlement'" : "DELETE FROM event_access WHERE event_id='invite' AND user_id='settlement'").run();
    const before = snapshot(s.db), repeated = await s.write('invite', 'finance', command, actor, key);
    expect(repeated.statusCode, repeated.body).toBe(mode === 'role' ? 403 : 404);
    expect(snapshot(s.db)).toEqual(before);
  });
  for (const id of ['alice', 'schedule', 'admin']) for (const lock of ['archived', 'settled'] as const) it(id + ' cannot rewrite ' + lock + ' arrangements', async () => {
    const s = await setup(), actor = actorById(id);
    if (lock === 'archived') s.db.prepare("UPDATE events SET archived_at=? WHERE id='listen'").run(stamp);
    else s.db.prepare("INSERT INTO settlements(event_id,total_cents,headcount,note,updated_at) VALUES('listen',1000,2,'核對',?)").run(stamp);
    const before = snapshot(s.db), read = await s.read('listen', 'arrangements', actor);
    expect(read.statusCode, read.body).toBe(200); expect(read.json().canEdit).toBe(false);
    const response = await s.write('listen', 'arrangements', { revision: 0, values: values(), reason: '核對安排' }, actor, randomUUID(), 'PUT');
    expect(response.statusCode, response.body).toBe(lock === 'archived' && id === 'admin' ? 403 : 409);
    expect(snapshot(s.db)).toEqual(before);
  });
  it('requires unarchiving before attendance changes and disallows onsite additions after settlement', async () => {
    const s = await setup(), actor = actorById('combined');
    s.db.prepare("UPDATE events SET lifecycle='ended',actual_started_at=?,actual_ended_at=?,archived_at=? WHERE id='listen'").run(stamp, stamp, stamp);
    let before = snapshot(s.db);
    const read = await s.read('listen', 'attendance', actor);
    expect(read.statusCode, read.body).toBe(200); expect(read.json()).toMatchObject({ canObserve: false, canAdd: false });
    expect((await s.write('listen', 'attendance/listen-person', observe, actor)).statusCode).toBe(409);
    expect((await s.write('listen', 'onsite', onsite, actor)).statusCode).toBe(409);
    expect(snapshot(s.db)).toEqual(before);
    s.db.exec("UPDATE events SET archived_at=NULL WHERE id='listen'; INSERT INTO settlements(event_id,total_cents,headcount,note,updated_at) VALUES('listen',1000,2,'核對','before')");
    before = snapshot(s.db);
    expect((await s.read('listen', 'attendance', actor)).json()).toMatchObject({ canObserve: true, canAdd: false });
    expect((await s.write('listen', 'onsite', onsite, actor)).statusCode).toBe(409);
    expect(snapshot(s.db)).toEqual(before);
  });
});
