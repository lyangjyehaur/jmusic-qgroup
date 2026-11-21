import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';

const origin = 'https://rebuild.example', stamp = '2026-11-17T00:00:00+00:00', rescueKey = 'synthetic-poll-rescue-' + 'x'.repeat(32);
// Expectations are declared here, independently of the runtime permission helpers.
const actors = [
  { id: 'alice', member: true, owner: true },
  { id: 'bob', member: true, owner: false },
  { id: 'cohost', member: true, owner: false },
  { id: 'admin', member: true, owner: false },
  { id: 'outsider', member: true, owner: false },
  { id: 'rescue', member: false, owner: false },
  { id: 'visitor', member: false, owner: false },
  { id: 'anonymous', member: false, owner: false },
] as const;
const states = ['open', 'closed', 'expired', 'finalized', 'cancelled', 'deleted'] as const;
type State = typeof states[number];
type Actor = typeof actors[number];
const actor = (id: string) => actors.find(a => a.id === id)!;
const id = (state: State) => 'permission-poll-' + state;
const optionId = (state: State, position: number) => id(state) + '-' + position;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); cleanup.push(async () => { db.close(); }); fixture(db);
  for (const a of actors.filter(a => a.member && !['alice', 'bob'].includes(a.id))) {
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(a.id, hash('poll-' + a.id), a.id, stamp);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('poll-' + a.id), a.id, stamp);
  }
  db.exec("INSERT INTO user_admin_roles VALUES('admin',1,1,'before')");
  db.prepare("INSERT INTO event_roles VALUES('all-cohost','listen','cohost','[\"schedule\",\"roster\",\"attendance\",\"settlement\"]',?)").run(stamp);
  for (const state of states) {
    const counts = Object.fromEntries([0, 1].map(n => [optionId(state, n), { yes: 1, maybe: 0, no: 0 }]));
    db.prepare(`INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,time_mode,duration_hours,capacity,minimum_participants,fee_policy,deadline,created_at,status,revision,vote_revision,result_json,respondent_count,bot_enabled)
      VALUES(?,'alice',?,'约K','台北','','Asia/Taipei','exact',3,8,1,'依實際分攤',?,?,?,1,1,?,?,0)`).run(id(state), '權限核對 ' + state,
        state === 'expired' ? '2020-01-01T00:00:00+00:00' : '2099-12-10T00:00:00+00:00', stamp, state === 'expired' ? 'open' : state,
        state === 'finalized' ? JSON.stringify(counts) : null, state === 'finalized' ? 1 : null);
    db.prepare("INSERT INTO time_poll_ballots VALUES(?,'bob',?)").run(id(state), stamp);
    for (const n of [0, 1]) {
      db.prepare('INSERT INTO time_poll_options VALUES(?,?,?,?)').run(optionId(state, n), id(state), n, '2099-12-' + (11 + n) + 'T00:00:00+00:00');
      db.prepare("INSERT INTO time_poll_votes VALUES(?,'bob',?,'yes')").run(id(state), optionId(state, n));
    }
    db.prepare("INSERT INTO time_poll_history(poll_id,actor_id,action,details_json,created_at) VALUES(?,'alice','created',?,?)").run(id(state), JSON.stringify({ reason: '發起者核對紀錄' }), stamp);
  }
  const app = createApp({ db, origin, now: () => new Date(stamp), adminCredentialHash: () => hash(rescueKey) });
  cleanup.push(async () => { await app.close(); }); await app.ready();
  const headers = new Map<string, Record<string, string>>();
  for (const a of actors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const token = a.member ? (['alice', 'bob'].includes(a.id) ? 'fixture-' + a.id : 'poll-' + a.id) : '';
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie: token ? 'kanban_session=' + token : '' } });
    expect(response.statusCode, response.body).toBe(200); const session = response.json();
    const h = { cookie: token ? 'kanban_session=' + token : String(response.headers['set-cookie']).split(';')[0]!, origin,
      'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
    if (a.id === 'rescue') {
      const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key: rescueKey, confirm: true } });
      expect(login.statusCode, login.body).toBe(200); h.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ url: '/api/v2/admin/session', headers: h })).json()).toMatchObject({ authMethod: 'credential', currentUserId: null });
    }
    headers.set(a.id, h);
  }
  const read = (path: string, a: Actor) => app.inject({ url: '/api/v2/time-polls' + path, headers: headers.get(a.id)! });
  const write = (path: string, payload: object, a: Actor, key = randomUUID()) => app.inject({ method: 'POST', url: '/api/v2/time-polls' + path,
    headers: { ...headers.get(a.id)!, 'idempotency-key': key }, payload });
  return { db, app, headers, read, write };
}
function snapshot(db: DB) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]));
}
function vote(state: State) { return { revision: 1, choices: [0, 1].map(n => ({ option_id: optionId(state, n), choice: 'no' })) }; }
const actions = ['close', 'extend', 'cancel', 'remove', 'bot_sync', 'bot_retry', 'finalize'] as const;
function command(action: typeof actions[number], state: State = 'open') {
  const base = { revision: 1, reason: '發起者核對', confirm: true, action };
  if (action === 'extend') return { ...base, deadline: '2099-12-10T12:00:00+00:00' };
  if (action === 'bot_sync') return { ...base, bot_enabled: false };
  if (action === 'bot_retry') return { ...base, outbox_id: 1 };
  if (action === 'finalize') return { ...base, base_vote_revision: 1, option_id: optionId(state, 0), accept_terms: true, registration_deadline: '2099-12-10T12:00:00+00:00' };
  return base;
}

describe('time poll identities, projections and state authority', () => {
  for (const a of actors) for (const state of states) it(a.id + ' / ' + state + ': public ballots and owner management remain distinct', async () => {
    const s = await setup(), before = snapshot(s.db), status = state === 'expired' ? 'closed' : state;
    const response = await s.read('/' + id(state), a);
    expect(response.statusCode, response.body).toBe(a.id === 'anonymous' ? 401 : state === 'deleted' ? 404 : 200);
    const check = (p: Record<string, unknown>) => {
      expect(p).toMatchObject({ status, is_owner: a.owner, can_manage: a.owner && ['open', 'closed'].includes(status),
        can_remove: a.owner && state !== 'deleted', can_vote: a.member && state === 'open', has_voted: a.id === 'bob', respondent_count: 1 });
      expect(p.my_choices).toEqual(a.id === 'bob' ? Object.fromEntries([0, 1].map(n => [optionId(state, n), 'yes'])) : {});
      for (const field of ['respondents', 'history', 'bot_enabled', 'bot_feature_enabled', 'bot_notice_enabled', 'bot_delivery'])
        expect(Object.hasOwn(p, field), field).toBe(a.owner);
      if (a.owner) expect(p.respondents).toEqual([{ name: '小白', updated_at: stamp, choices: Object.fromEntries([0, 1].map(n => [optionId(state, n), 'yes'])) }]);
      for (const field of ['owner_id', 'result_json', 'user_id']) expect(p).not.toHaveProperty(field);
    };
    if (response.statusCode === 200) check(response.json());
    const managed = await s.read('/' + id(state) + '/manage', a);
    expect(managed.statusCode, managed.body).toBe(!a.member ? 401 : !a.owner ? 403 : 200);
    if (managed.statusCode === 200) check(managed.json());
    for (const period of ['active', 'history']) {
      const list = await s.read('?period=' + period, a); expect(list.statusCode).toBe(a.id === 'anonymous' ? 401 : 200);
      if (list.statusCode === 200) expect(list.json().polls.map((p: { id: string }) => p.id).sort()).toEqual(
        (period === 'active' ? ['open', 'closed', 'expired'] as const : ['finalized', 'cancelled'] as const).map(id).sort());
    }
    expect(snapshot(s.db)).toEqual(before);
    for (const action of actions) {
      const forbiddenState = state === 'deleted' || (['finalized', 'cancelled'].includes(state) && action !== 'remove');
      if (a.owner && !forbiddenState && action !== 'bot_retry') continue;
      const r = await s.write('/' + id(state) + '/manage', command(action, state), a);
      expect(r.statusCode, action + ': ' + r.body).toBe(!a.member ? 401 : !a.owner ? 403 : state === 'deleted' ? 404 : 409);
      expect(r.json().code).not.toBe('INVALID_INPUT'); expect(snapshot(s.db), action).toEqual(before);
    }
    if (!a.member || state !== 'open') {
      const r = await s.write('/' + id(state) + '/votes', vote(state), a);
      expect(r.statusCode, r.body).toBe(!a.member ? 401 : state === 'deleted' ? 404 : 409);
      expect(r.json().code).not.toBe('INVALID_INPUT'); expect(snapshot(s.db)).toEqual(before);
    }
  });
});

describe('time poll authorized commands and receipt recovery', () => {
  for (const a of actors.filter(a => a.member)) it(a.id + ' can change only their own ballot and recover its original receipt', async () => {
    const s = await setup(), key = randomUUID(), payload = vote('open');
    const otherVotes = s.db.prepare('SELECT * FROM time_poll_votes WHERE user_id!=? ORDER BY rowid').all(a.id);
    const r = await s.write('/' + id('open') + '/votes', payload, a, key); expect(r.statusCode, r.body).toBe(200);
    expect(s.db.prepare('SELECT * FROM time_poll_votes WHERE user_id!=? ORDER BY rowid').all(a.id)).toEqual(otherVotes);
    expect(s.db.prepare('SELECT option_id,choice FROM time_poll_votes WHERE poll_id=? AND user_id=? ORDER BY option_id').all(id('open'), a.id))
      .toEqual([0, 1].map(n => ({ option_id: optionId('open', n), choice: 'no' })));
    const before = snapshot(s.db); expect((await s.write('/' + id('open') + '/votes', payload, a, key)).json()).toEqual(r.json()); expect(snapshot(s.db)).toEqual(before);
    const changed = { ...payload, choices: payload.choices.map(c => ({ ...c, choice: 'yes' })) };
    expect((await s.write('/' + id('open') + '/votes', changed, a, key)).statusCode).toBe(409); expect(snapshot(s.db)).toEqual(before);
  });
  for (const action of actions.filter(a => a !== 'bot_retry')) {
    it('owner can ' + action + ' once and recover the original minimal result', async () => {
      const s = await setup(), a = actor('alice'), key = randomUUID(), payload = command(action);
      const r = await s.write('/' + id('open') + '/manage', payload, a, key); expect(r.statusCode, r.body).toBe(200);
      expect(Object.keys(r.json()).sort()).toEqual(['id', 'revision', 'vote_revision', 'event_id', 'removed'].sort());
      expect(s.db.prepare('SELECT revision,status FROM time_polls WHERE id=?').get(id('open'))).toEqual({ revision: 2,
        status: action === 'close' ? 'closed' : action === 'cancel' ? 'cancelled' : action === 'remove' ? 'deleted' : action === 'finalize' ? 'finalized' : 'open' });
      const before = snapshot(s.db); expect((await s.write('/' + id('open') + '/manage', payload, a, key)).json()).toEqual(r.json()); expect(snapshot(s.db)).toEqual(before);
    });
    it('reauthorizes ' + action + ' replay and management reads after ownership transfer', async () => {
      const s = await setup(), oldOwner = actor('alice'), key = randomUUID(), payload = command(action);
      expect((await s.write('/' + id('open') + '/manage', payload, oldOwner, key)).statusCode).toBe(200);
      s.db.prepare("UPDATE time_polls SET owner_id='bob' WHERE id=?").run(id('open')); const before = snapshot(s.db);
      expect((await s.write('/' + id('open') + '/manage', payload, oldOwner, key)).statusCode).toBe(403);
      expect((await s.read('/' + id('open') + '/manage', oldOwner)).statusCode).toBe(403);
      expect((await s.read('/' + id('open') + '/manage', actor('bob'))).statusCode).toBe(200); expect(snapshot(s.db)).toEqual(before);
    });
  }
});
