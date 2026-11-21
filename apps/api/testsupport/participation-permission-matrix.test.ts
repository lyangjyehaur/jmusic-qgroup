import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';

const origin = 'https://rebuild.example', stamp = '2026-11-17T00:00:00+00:00';
const states = ['listen', 'invite'] as const;
type State = typeof states[number];
// Declared test expectations; no production permission helper supplies them.
const actors = [
  { id: 'alice', member: true, access: true, roster: true, manager: false, scopes: [] },
  { id: 'manager', member: true, access: true, roster: false, manager: true, scopes: [] },
  { id: 'participant', member: true, access: false, roster: false, manager: false, scopes: [] },
  { id: 'roster', member: true, access: true, roster: true, manager: false, scopes: ['roster'] },
  { id: 'schedule', member: true, access: true, roster: false, manager: false, scopes: ['schedule'] },
  { id: 'attendance', member: true, access: true, roster: false, manager: false, scopes: ['attendance'] },
  { id: 'settlement', member: true, access: true, roster: false, manager: false, scopes: ['settlement'] },
  { id: 'combined', member: true, access: true, roster: true, manager: false, scopes: ['roster', 'attendance'] },
  { id: 'viewer', member: true, access: true, roster: false, manager: false, scopes: [] },
  { id: 'admin', member: true, access: false, roster: false, manager: false, scopes: [] },
  { id: 'invited-admin', member: true, access: true, roster: false, manager: false, scopes: [] },
  { id: 'outsider', member: true, access: false, roster: false, manager: false, scopes: [] },
  { id: 'visitor', member: false, access: false, roster: false, manager: false, scopes: [] },
  { id: 'anonymous', member: false, access: false, roster: false, manager: false, scopes: [] },
] as const;
type Actor = typeof actors[number];
const actor = (id: string) => actors.find(a => a.id === id)!;
const personId = (state: State, kind: string) => hash(state + ':person:' + kind).slice(0, 16);
const claimId = (state: State, kind: string) => hash(state + ':claim:' + kind).slice(0, 16);
const token = (state: State, kind: string) => hash(state + ':token:' + kind).slice(0, 32);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); cleanup.push(async () => { db.close(); }); fixture(db);
  for (const a of actors.filter(a => a.member && a.id !== 'alice')) {
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(a.id, hash('participation-' + a.id), a.id, stamp);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('participation-' + a.id), a.id, stamp);
  }
  for (const state of states) {
    for (const a of actors.filter(a => a.member && a.id !== 'alice')) {
      if (a.access) db.prepare('INSERT INTO event_access VALUES(?,?,?)').run(state, a.id, stamp);
      if (a.scopes.length) db.prepare('INSERT INTO event_roles VALUES(?,?,?,?,?)').run(state + '-' + a.id, state, a.id, JSON.stringify(a.scopes), stamp);
    }
    for (const kind of ['guest', 'second', 'linked', 'invited']) {
      const invited = kind === 'invited';
      db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,invitation_token,created_at,updated_at,accepted_conditions_version,confirmation_state)
        VALUES(?,?,'manager',?,?,?, ?,?,?,?,1,'accepted')`).run(personId(state, kind), state, kind === 'linked' ? 'participant' : null,
          kind, kind === 'linked' || invited ? 'self' : 'manager', invited ? 'invited' : 'confirmed', invited ? token(state, kind) : null, stamp, stamp);
    }
    for (const [kind, requester, status] of [['guest', null, 'invited'], ['second', 'viewer', 'requested']] as const) {
      db.prepare(`INSERT INTO attendee_claims(id,event_id,attendee_id,token,issuer_id,requester_id,status,expires_at,created_at)
        VALUES(?,?,?,?,'manager',?,?, '2099-12-01T00:00:00+00:00',?)`).run(claimId(state, kind), state, personId(state, kind), token(state, 'claim-' + kind), requester, status, stamp);
    }
  }
  db.exec("INSERT INTO user_admin_roles VALUES('admin',1,1,'before'),('invited-admin',1,1,'before')");
  const app = createApp({ db, origin, now: () => new Date(stamp) }); cleanup.push(async () => { await app.close(); }); await app.ready();
  const headers = new Map<string, Record<string, string>>();
  for (const a of actors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const cookie = a.member ? 'kanban_session=' + (a.id === 'alice' ? 'fixture-alice' : 'participation-' + a.id) : '';
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie } }); expect(response.statusCode, response.body).toBe(200);
    const session = response.json(); headers.set(a.id, { cookie: cookie || String(response.headers['set-cookie']).split(';')[0]!, origin,
      'x-account-scope': session.scope, 'x-csrf-token': session.csrf });
  }
  const read = (state: State, suffix: string, a: Actor) => app.inject({ url: '/api/v2/activities/' + state + '/' + suffix, headers: headers.get(a.id)! });
  const write = (state: State, suffix: string, payload: object, a: Actor, key = randomUUID()) => app.inject({ method: 'POST',
    url: '/api/v2/activities/' + state + '/' + suffix, headers: { ...headers.get(a.id)!, 'idempotency-key': key }, payload });
  const revision = (state: State) => (db.prepare('SELECT revision FROM events WHERE id=?').get(state) as { revision: number }).revision;
  const receipt = (key: string, a: Actor) => app.inject({ url: '/api/v2/activities/registration-results/' + key, headers: headers.get(a.id)! });
  return { db, app, headers, read, write, revision, receipt };
}
function snapshot(db: DB) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]));
}
const change = (action: string, revision = 0) => ({ revision, action, name: '核對同行', note: '核對備註', payerKind: 'manager', reason: '核對報名', confirm: true });
const decision = (value: string, revision = 0) => ({ revision, decision: value, reason: '本人核對', confirmPerson: true, confirm: true });
const accept = (revision = 0) => ({ revision, conditionsVersion: 1, acceptConditions: true, acceptWaiting: true, confirm: true });

describe('participation authority and private projections', () => {
  for (const a of actors) for (const state of states) it(a.id + ' / ' + state + ': registration, invitations and claims use their own authority', async () => {
    const s = await setup(), before = snapshot(s.db), access = state === 'listen' || a.access, manages = a.roster || a.manager;
    const expected = !a.member ? 401 : !access ? 404 : 200;
    for (const suffix of ['registration', 'invitations', 'claims']) {
      const response = await s.read(state, suffix, a); expect(response.statusCode, suffix + ': ' + response.body).toBe(expected);
      if (response.statusCode !== 200) continue;
      const data = response.json();
      if (suffix === 'registration') {
        expect(data.people.map((p: { id: string }) => p.id).sort()).toEqual(manages ? ['guest', 'second', 'linked', 'invited'].map(k => personId(state, k)).sort() : []);
        expect(data.people.every((p: { managedByMe: boolean }) => p.managedByMe === a.manager)).toBe(true);
        expect(data.selfRegistered).toBe(a.id === 'participant');
      }
      if (suffix === 'invitations') {
        expect(data.canIssue).toBe(a.roster); expect(data.people.map((p: { id: string }) => p.id)).toEqual(manages ? [personId(state, 'invited')] : []);
      }
      if (suffix === 'claims') {
        expect(data.people.map((p: { id: string }) => p.id).sort()).toEqual(manages ? ['guest', 'second'].map(k => personId(state, k)).sort() : []);
        expect(data.claims.map((c: { id: string }) => c.id).sort()).toEqual(manages ? ['guest', 'second'].map(k => claimId(state, k)).sort() : a.id === 'viewer' ? [claimId(state, 'second')] : []);
        for (const c of data.claims) {
          expect(c.token).toBe(manages && c.id === claimId(state, 'guest') ? token(state, 'claim-guest') : null);
          expect(c.canDecide).toBe(manages && c.id === claimId(state, 'second')); expect(c.canRevoke).toBe(manages);
        }
      }
    }
    expect(snapshot(s.db)).toEqual(before);
    const commands = [
      ...['edit', 'confirm', 'split', 'withdraw', 'approve', 'reject'].map(action => ({ suffix: 'attendees/' + personId(state, 'guest') + '/registration',
        allowed: action === 'approve' || action === 'reject' ? a.roster : manages, payload: change(action) })),
      { suffix: 'invitations', allowed: a.roster, payload: { revision: 0, people: [{ isSelf: false, name: '新同行', note: '', payerKind: 'self' }], reason: '補報名', confirm: true } },
      { suffix: 'claims', allowed: manages, payload: { revision: 0, attendeeId: personId(state, 'guest'), reason: '本人核對', confirm: true } },
      ...['approve', 'reject', 'revoke'].map(value => ({ suffix: 'claims/' + claimId(state, 'second'), allowed: manages, payload: decision(value) })),
    ];
    for (const command of commands.filter(c => !c.allowed || !access)) {
      const response = await s.write(state, command.suffix, command.payload, a);
      expect(response.statusCode, command.suffix + ': ' + response.body).toBe(!a.member ? 401 : !access ? 404 : 403);
      expect(response.json().code).not.toBe('INVALID_INPUT'); expect(snapshot(s.db), command.suffix).toEqual(before);
    }
  });
});

describe('per-person commands and revoked receipt authority', () => {
  for (const id of ['alice', 'roster', 'manager']) for (const action of ['edit', 'confirm', 'split', 'withdraw', 'approve', 'reject']) {
    if (id === 'manager' && ['approve', 'reject'].includes(action)) continue;
    it(id + ' can ' + action + ' an eligible managed registration', async () => {
      const s = await setup(), person = personId('listen', 'guest');
      if (action === 'confirm') s.db.prepare("UPDATE attendees SET status='tentative' WHERE id=?").run(person);
      if (action === 'split') {
        s.db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES('together','listen','manager','together',?)").run(stamp);
        s.db.prepare("UPDATE attendees SET status='waiting',party_id='together' WHERE id=?").run(person);
      }
      if (['approve', 'reject'].includes(action)) s.db.prepare('UPDATE attendees SET withdrawal_requested=1 WHERE id=?').run(person);
      const key = randomUUID(), payload = change(action), response = await s.write('listen', 'attendees/' + person + '/registration', payload, actor(id), key);
      expect(response.statusCode, response.body).toBe(200);
      const row = s.db.prepare('SELECT status,manager_id,user_id,withdrawal_requested FROM attendees WHERE id=?').get(person);
      expect(row).toEqual({ status: ['withdraw', 'approve'].includes(action) ? 'withdrawn' : 'confirmed', manager_id: 'manager', user_id: null, withdrawal_requested: 0 });
      const before = snapshot(s.db);
      expect((await s.write('listen', 'attendees/' + person + '/registration', payload, actor(id), key)).json()).toEqual(response.json());
      expect((await s.receipt(key, actor(id))).json()).toEqual({ state: 'completed', result: response.json() }); expect(snapshot(s.db)).toEqual(before);
    });
  }
  for (const action of ['approve', 'reject']) it('reauthorizes ' + action + ' receipts even if the actor remains the actual manager', async () => {
    const s = await setup(), person = personId('listen', 'guest'), key = randomUUID(), payload = change(action), a = actor('manager');
    s.db.prepare("INSERT INTO event_roles VALUES('borrowed-roster','listen','manager','[\"roster\"]',?)").run(stamp);
    s.db.prepare('UPDATE attendees SET withdrawal_requested=1 WHERE id=?').run(person);
    expect((await s.write('listen', 'attendees/' + person + '/registration', payload, a, key)).statusCode).toBe(200);
    s.db.exec("DELETE FROM event_roles WHERE id='borrowed-roster'"); const before = snapshot(s.db);
    expect((await s.write('listen', 'attendees/' + person + '/registration', payload, a, key)).statusCode).toBe(403);
    expect((await s.receipt(key, a)).statusCode).toBe(403); expect(snapshot(s.db)).toEqual(before);
  });
  it('rejects an old edit and its receipt after the actual manager changes', async () => {
    const s = await setup(), person = personId('listen', 'guest'), key = randomUUID(), a = actor('manager'), payload = change('edit');
    expect((await s.write('listen', 'attendees/' + person + '/registration', payload, a, key)).statusCode).toBe(200);
    s.db.prepare("UPDATE attendees SET manager_id='outsider' WHERE id=?").run(person); const before = snapshot(s.db);
    expect((await s.write('listen', 'attendees/' + person + '/registration', payload, a, key)).statusCode).toBe(403);
    expect((await s.receipt(key, a)).statusCode).toBe(403); expect(snapshot(s.db)).toEqual(before);
  });
});

describe('invitation and claim token protocols', () => {
  for (const id of ['anonymous', 'visitor', 'outsider']) it(id + ' gets only the finite token preview without private activity access', async () => {
    const s = await setup(), a = actor(id), before = snapshot(s.db);
    for (const [suffix, fields] of [
      ['invitations/' + token('invite', 'invited'), ['id', 'title', 'name', 'revision', 'conditionsVersion', 'arrangement', 'status', 'blocker']],
      ['claims/preview/' + token('invite', 'claim-guest'), ['state', 'id', 'title', 'name', 'status', 'payerName', 'payerKind', 'revision', 'expiresAt', 'claimStatus', 'requestedByMe', 'duplicate', 'isManager']],
    ] as const) {
      const response = await s.read('invite', suffix, a); expect(response.statusCode, response.body).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual([...fields].sort());
    }
    expect((await s.read('invite', 'registration', a)).statusCode).toBe(a.member ? 404 : 401);
    expect(snapshot(s.db)).toEqual(before);
  });
  for (const mode of ['manager', 'access']) it('reauthorizes invitation acceptance after changing ' + mode, async () => {
    const s = await setup(), a = actor('outsider'), key = randomUUID(), payload = accept(), suffix = 'invitations/' + token('invite', 'invited') + '/accept';
    const first = await s.write('invite', suffix, payload, a, key); expect(first.statusCode, first.body).toBe(200);
    expect((await s.read('invite', 'registration', a)).statusCode).toBe(200);
    const accepted = snapshot(s.db); expect((await s.write('invite', suffix, payload, a, key)).json()).toEqual(first.json()); expect(snapshot(s.db)).toEqual(accepted);
    if (mode === 'manager') s.db.prepare("UPDATE attendees SET manager_id='manager' WHERE id=?").run(personId('invite', 'invited'));
    else s.db.exec("DELETE FROM event_access WHERE event_id='invite' AND user_id='outsider'");
    const before = snapshot(s.db), response = await s.write('invite', suffix, payload, a, key);
    expect(response.statusCode, response.body).toBe(mode === 'manager' ? 403 : 404); expect(snapshot(s.db)).toEqual(before);
  });
  it('preserves minimal approval recovery after management transfer while forbidding a new decision', async () => {
    const s = await setup(), requester = actor('outsider'), manager = actor('manager'), target = claimId('invite', 'guest');
    const requested = await s.write('invite', 'claims/preview/' + token('invite', 'claim-guest') + '/request',
      { revision: 0, confirmIdentity: true, keepPayment: true, confirm: true }, requester);
    expect(requested.statusCode, requested.body).toBe(200); expect((await s.read('invite', 'registration', requester)).statusCode).toBe(404);
    const key = randomUUID(), payload = decision('approve', s.revision('invite')), first = await s.write('invite', 'claims/' + target, payload, manager, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(s.db.prepare('SELECT manager_id,user_id,payer_kind FROM attendees WHERE id=?').get(personId('invite', 'guest'))).toEqual({ manager_id: 'outsider', user_id: 'outsider', payer_kind: 'manager' });
    expect(s.db.prepare('SELECT payer_id,payer_user_id,claimant_owns FROM attendee_payment_origins WHERE attendee_id=?').get(personId('invite', 'guest'))).toEqual({ payer_id: 'account:' + hash('invite:manager').slice(0, 16), payer_user_id: 'manager', claimant_owns: 0 });
    expect((await s.read('invite', 'registration', requester)).statusCode).toBe(200);
    const before = snapshot(s.db), repeated = await s.write('invite', 'claims/' + target, payload, manager, key);
    expect(repeated.json()).toEqual(first.json()); expect(Object.keys(repeated.json()).sort()).toEqual(['id', 'revision', 'claimId'].sort());
    expect((await s.write('invite', 'claims/' + target, decision('approve', s.revision('invite')), manager)).statusCode).toBe(403);
    expect(snapshot(s.db)).toEqual(before);
    s.db.exec("DELETE FROM event_access WHERE event_id='invite' AND user_id='manager'"); const revoked = snapshot(s.db);
    expect((await s.write('invite', 'claims/' + target, payload, manager, key)).statusCode).toBe(404); expect(snapshot(s.db)).toEqual(revoked);
  });
  it('invalidates the claim token when its issuer is no longer a manager or roster cohost', async () => {
    const s = await setup(), a = actor('outsider'); s.db.prepare("UPDATE attendees SET manager_id='viewer' WHERE id=?").run(personId('invite', 'guest'));
    const before = snapshot(s.db), suffix = 'claims/preview/' + token('invite', 'claim-guest');
    for (const response of [await s.read('invite', suffix, a), await s.write('invite', suffix + '/request', { revision: 0, confirmIdentity: true, keepPayment: true, confirm: true }, a)]) {
      expect(response.statusCode, response.body).toBe(409); expect(response.json().code).toBe('CLAIM_ISSUER_CHANGED');
    }
    expect(snapshot(s.db)).toEqual(before);
  });
});
