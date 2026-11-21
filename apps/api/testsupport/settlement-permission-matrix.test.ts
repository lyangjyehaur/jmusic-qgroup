import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';
import { testPNG } from './payment-fixture';

const origin = 'https://rebuild.example', stamp = '2026-11-17T00:00:00+00:00';
const rescueKey = 'synthetic-settlement-rescue-' + 'x'.repeat(32);
const states = ['listen', 'invite', 'draft', 'deleted'] as const;
type State = typeof states[number];
// Independently declared expectations: activity access, settlement duty and
// immutable publisher identity are distinct, including for administrators.
const actors = [
  { id: 'alice', member: true, owner: true, private: true, draft: true, settlement: true, scopes: [] },
  { id: 'settlement', member: true, owner: false, private: true, draft: true, settlement: true, scopes: ['settlement'] },
  { id: 'combined', member: true, owner: false, private: true, draft: true, settlement: true, scopes: ['roster', 'settlement'] },
  { id: 'schedule', member: true, owner: false, private: true, draft: true, settlement: false, scopes: ['schedule'] },
  { id: 'roster', member: true, owner: false, private: true, draft: true, settlement: false, scopes: ['roster'] },
  { id: 'attendance', member: true, owner: false, private: true, draft: true, settlement: false, scopes: ['attendance'] },
  { id: 'manager', member: true, owner: false, private: true, draft: false, settlement: false, scopes: [] },
  { id: 'participant', member: true, owner: false, private: false, draft: false, settlement: false, scopes: [] },
  { id: 'viewer', member: true, owner: false, private: true, draft: false, settlement: false, scopes: [] },
  { id: 'admin', member: true, owner: false, private: false, draft: false, settlement: false, scopes: [] },
  { id: 'invited-admin', member: true, owner: false, private: true, draft: false, settlement: false, scopes: [] },
  { id: 'outsider', member: true, owner: false, private: false, draft: false, settlement: false, scopes: [] },
  { id: 'rescue', member: false, owner: false, private: false, draft: false, settlement: false, scopes: [] },
  { id: 'visitor', member: false, owner: false, private: false, draft: false, settlement: false, scopes: [] },
  { id: 'anonymous', member: false, owner: false, private: false, draft: false, settlement: false, scopes: [] },
] as const;
type Actor = typeof actors[number];
const actor = (id: string) => actors.find(a => a.id === id)!;
const accessible = (state: State, a: Actor) => state === 'listen' || (state === 'invite' && a.private) || (state === 'draft' && a.draft);
const personId = (state: State, kind: string) => hash(state + ':settlement-person:' + kind).slice(0, 16);
const payerId = (state: State, user: string) => 'account:' + hash(state + ':' + user).slice(0, 16);
const itemId = '1111111111111111', roomId = '2222222222222222';
const images = [testPNG([11, 22, 33]), testPNG([44, 55, 66])];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(withHistory = true) {
  const db = openDatabase(':memory:'); cleanup.push(async () => { db.close(); }); fixture(db);
  for (const a of actors.filter(a => a.member && a.id !== 'alice')) {
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(a.id, hash('settlement-' + a.id), a.id, stamp);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('settlement-' + a.id), a.id, stamp);
  }
  db.exec("INSERT INTO user_admin_roles VALUES('admin',1,1,'before'),('invited-admin',1,1,'before')");
  for (const state of states) {
    if (state === 'listen' || state === 'invite') db.prepare("UPDATE events SET lifecycle='ended' WHERE id=?").run(state);
    for (const a of actors.filter(a => a.member && !a.owner)) {
      if (a.private) db.prepare('INSERT INTO event_access VALUES(?,?,?)').run(state, a.id, stamp);
      if (a.scopes.length) db.prepare('INSERT INTO event_roles VALUES(?,?,?,?,?)').run(state + '-' + a.id, state, a.id, JSON.stringify(a.scopes), stamp);
    }
    for (const kind of ['guest', 'claimed']) {
      db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,accepted_conditions_version,confirmation_state,created_at,updated_at)
        VALUES(?,?,?,?,?,'manager','confirmed',1,'accepted',?,?)`).run(personId(state, kind), state, kind === 'claimed' ? 'outsider' : 'manager',
          kind === 'claimed' ? 'participant' : null, kind, stamp, stamp);
    }
    db.prepare('INSERT INTO attendee_payment_origins VALUES(?,?,?,0,?)').run(personId(state, 'claimed'), payerId(state, 'manager'), 'manager', 'manager');
    for (const version of withHistory ? [1, 2] : []) {
      const publisher = version === 1 ? 'alice' : 'settlement';
      db.prepare(`INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields)
        VALUES(?,?,?,2,?,?,?, ?,?,'updated','[]')`).run(state, version, version * 1000, '原帳單 ' + version, images[version - 1], stamp, publisher, publisher);
      if (version === 1) {
        // A retained detailed version owns its receipt; the newer legacy bill
        // keeps a separate QR. Neither image depends on the current roster.
        db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run(state, version, JSON.stringify({ people: [], items: [], payers: [],
          total_cents: 1000, note: '原帳單 1', reason: '', qr_digest: null, payment_codes: [], rounding_rule: '逐人核對',
          input: { people: [], items: [], custom_payers: [] }, journal_seq: '0', balances: [], group_notice: false, changes: [] }));
        db.prepare('INSERT INTO settlement_receipts(event_id,version,item_id,image) VALUES(?,?,?,?)').run(state, version, itemId, images[version - 1]);
      }
    }
  }
  const app = createApp({ db, origin, now: () => new Date(stamp), adminCredentialHash: () => hash(rescueKey) });
  cleanup.push(async () => { await app.close(); }); await app.ready();
  const headers = new Map<string, Record<string, string>>();
  for (const a of actors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const cookie = a.member ? 'kanban_session=' + (a.id === 'alice' ? 'fixture-alice' : 'settlement-' + a.id) : '';
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie } }); expect(response.statusCode, response.body).toBe(200);
    const session = response.json(), h = { cookie: cookie || String(response.headers['set-cookie']).split(';')[0]!, origin,
      'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
    if (a.id === 'rescue') {
      const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key: rescueKey, confirm: true } });
      expect(login.statusCode, login.body).toBe(200); h.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ url: '/api/v2/admin/session', headers: h })).json()).toMatchObject({ authMethod: 'credential', currentUserId: null });
    }
    headers.set(a.id, h);
  }
  const read = (state: State, suffix: string, a: Actor, legacy = false) => app.inject({
    url: (legacy ? '/api/events/' : '/api/v2/activities/') + state + '/' + suffix, headers: headers.get(a.id)! });
  const write = (state: State, suffix: string, payload: object, a: Actor, key = randomUUID()) => app.inject({ method: 'POST',
    url: '/api/v2/activities/' + state + '/' + suffix, headers: { ...headers.get(a.id)!, 'idempotency-key': key }, payload });
  const revision = (state: State) => (db.prepare('SELECT revision FROM events WHERE id=?').get(state) as { revision: number }).revision;
  return { db, app, headers, read, write, revision };
}
function snapshot(db: DB) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]));
}
function input(state: State, revision = 0, base_version = 2) {
  return { revision, base_version, reviewed_roster: true, convert_legacy: true,
    people: ['guest', 'claimed'].map(kind => ({ id: personId(state, kind), reason: '核對原付款責任' })),
    items: [{ id: itemId, name: '消費', amount: '10.00' }] };
}
const rooms = (state: State, revision = 0) => ({ revision, confirm: true, reason: '核對包間', rooms: [{
  id: roomId, name: '核對包間', payer_id: payerId(state, 'manager'), person_ids: ['guest', 'claimed'].map(k => personId(state, k)),
}] });

describe('settlement authority, immutable assets and public history', () => {
  for (const a of actors) for (const state of states) it(a.id + ' / ' + state + ': bill access, publishing and room ownership are independent', async () => {
    const s = await setup(), before = snapshot(s.db), access = accessible(state, a);
    for (const suffix of ['settlement', 'settlement/history', 'settlement/history/1', 'settlement/asset-versions', 'settlement/history/1/assets', 'settlement/history/2/assets']) {
      const r = await s.read(state, suffix, a); expect(r.statusCode, suffix + ': ' + r.body).toBe(access ? 200 : 404);
      if (r.statusCode !== 200) continue;
      if (suffix === 'settlement') expect(r.json()).toMatchObject({ can_manage: a.settlement, bill: { version: 2, mode: 'legacy', total_amount: '20.00' } });
      if (suffix === 'settlement/history') expect(r.json().revisions.map((b: { version: number }) => b.version)).toEqual([2, 1]);
      if (suffix === 'settlement/history/1') expect(r.json()).toMatchObject({ version: 1, mode: 'detailed', total_amount: '10.00', publisher_key: payerId(state, 'alice') });
      if (suffix.endsWith('/assets')) {
        const version = suffix.includes('/1/') ? 1 : 2;
        expect(r.json().can_save).toBe(a.id === (version === 1 ? 'alice' : 'settlement'));
        expect(r.json().codes).toHaveLength(1); expect(r.json().receipts).toHaveLength(version === 1 ? 1 : 0);
      }
    }
    for (const version of [1, 2]) for (const suffix of ['settlement/history/' + version + '/payment-code', ...(version === 1 ? ['settlement/history/1/receipts/' + itemId] : [])]) {
      for (const legacy of [false, true]) {
        const r = await s.read(state, suffix, a, legacy); expect(r.statusCode, suffix).toBe(access ? 200 : 404);
        if (r.statusCode === 200) { expect(r.rawPayload).toEqual(images[version - 1]); expect(r.headers['content-type']).toContain('image/png'); }
      }
    }
    for (const suffix of ['settlement/context', 'rooms']) {
      const r = await s.read(state, suffix, a); expect(r.statusCode, suffix + ': ' + r.body).toBe(!a.member ? 401 : !access ? 404 : !a.settlement ? 403 : 200);
      if (r.statusCode !== 200) continue;
      const p = r.json(); expect(p.people.map((p: { id: string }) => p.id).sort()).toEqual(['guest', 'claimed'].map(k => personId(state, k)).sort());
      expect(p.people.every((p: { payer_id: string }) => p.payer_id === payerId(state, 'manager'))).toBe(true);
      if (suffix === 'rooms') expect(p).toMatchObject({ can_manage: false });
      else expect(p).toMatchObject({ can_manage: true, is_owner: a.owner, collector: { id: payerId(state, a.id) } });
    }
    expect(snapshot(s.db)).toEqual(before);
    const data = input(state), commands = [
      { suffix: 'settlement/preview', allowed: a.settlement && state !== 'draft', payload: data },
      { suffix: 'settlement', allowed: a.settlement && state !== 'draft', payload: { ...data, confirm: true, preview_token: '0'.repeat(64) } },
      { suffix: 'rooms', allowed: false, payload: rooms(state) },
    ];
    for (const command of commands.filter(c => !c.allowed || !access)) {
      const r = await s.write(state, command.suffix, command.payload, a);
      const permission = command.suffix === 'rooms' ? a.owner : a.settlement;
      expect(r.statusCode, command.suffix + ': ' + r.body).toBe(!a.member ? 401 : !access ? 404 : !permission ? 403 : 409);
      expect(r.json().code).not.toBe('INVALID_INPUT'); expect(snapshot(s.db), command.suffix).toEqual(before);
    }
  });
});

describe('settlement and rooms reauthorize completed operations', () => {
  async function publish(s: Awaited<ReturnType<typeof setup>>, state: State, a: Actor) {
    const data = input(state, s.revision(state), 0), before = snapshot(s.db);
    const preview = await s.write(state, 'settlement/preview', data, a); expect(preview.statusCode, preview.body).toBe(200); expect(snapshot(s.db)).toEqual(before);
    const payload = { ...data, preview_token: preview.json().preview_token, confirm: true }, key = randomUUID();
    const result = await s.write(state, 'settlement', payload, a, key); expect(result.statusCode, result.body).toBe(200);
    return { payload, key, result, preview };
  }
  for (const who of ['alice', 'settlement']) for (const state of ['listen', 'invite'] as const) it(who + ' publishes ' + state + ' once while retaining original payer responsibility', async () => {
    const s = await setup(false), a = actor(who), p = await publish(s, state, a), bill = (await s.read(state, 'settlement', a)).json().bill;
    expect(bill.detail.people.map((p: { payments: { payer_id: string; amount_cents: number }[] }) => p.payments)).toEqual(
      [0, 1].map(() => [expect.objectContaining({ payer_id: payerId(state, 'manager'), amount_cents: 500 })]));
    expect(s.db.prepare('SELECT manager_id,user_id FROM attendees WHERE id=?').get(personId(state, 'claimed'))).toEqual({ manager_id: 'outsider', user_id: 'participant' });
    expect(s.db.prepare('SELECT payer_id,payer_user_id,claimant_owns FROM attendee_payment_origins WHERE attendee_id=?').get(personId(state, 'claimed')))
      .toEqual({ payer_id: payerId(state, 'manager'), payer_user_id: 'manager', claimant_owns: 0 });
    const before = snapshot(s.db); expect((await s.write(state, 'settlement', p.payload, a, p.key)).json()).toEqual(p.result.json()); expect(snapshot(s.db)).toEqual(before);
    expect((await s.read(state, 'settlement/history/1/assets', a)).json().can_save).toBe(true);
  });
  for (const [state, mode] of [['listen', 'role'], ['invite', 'role'], ['invite', 'access']] as const) it('blocks settlement replay after revoking ' + state + ' ' + mode, async () => {
    const s = await setup(false), a = actor('settlement'), p = await publish(s, state, a);
    if (mode === 'role') s.db.prepare('DELETE FROM event_roles WHERE event_id=? AND user_id=?').run(state, a.id);
    else s.db.prepare('DELETE FROM event_access WHERE event_id=? AND user_id=?').run(state, a.id);
    const before = snapshot(s.db), expected = mode === 'role' ? 403 : 404;
    expect((await s.write(state, 'settlement', p.payload, a, p.key)).statusCode).toBe(expected);
    expect((await s.write(state, 'settlement/preview', input(state, s.revision(state), 1), a)).statusCode).toBe(expected);
    expect((await s.read(state, 'settlement/context', a)).statusCode).toBe(expected);
    const assets = await s.read(state, 'settlement/history/1/assets', a);
    expect(assets.statusCode).toBe(mode === 'role' ? 200 : 404); if (mode === 'role') expect(assets.json().can_save).toBe(true);
    expect(snapshot(s.db)).toEqual(before);
  });
  it('revokes former owner settlement replay after ownership transfer', async () => {
    const s = await setup(false), a = actor('alice'), p = await publish(s, 'listen', a);
    s.db.prepare("UPDATE events SET owner_id='outsider' WHERE id='listen'").run(); const before = snapshot(s.db);
    expect((await s.write('listen', 'settlement', p.payload, a, p.key)).statusCode).toBe(403);
    expect((await s.read('listen', 'settlement/context', a)).statusCode).toBe(403);
    expect((await s.read('listen', 'settlement/history/1/assets', a)).json().can_save).toBe(true); expect(snapshot(s.db)).toEqual(before);
  });
  for (const state of ['listen', 'invite'] as const) it('owner room planning on ' + state + ' is distinct from settlement duty and reauthorizes replay', async () => {
    const s = await setup(false), a = actor('alice');
    const payload = rooms(state), key = randomUUID(), r = await s.write(state, 'rooms', payload, a, key); expect(r.statusCode, r.body).toBe(200);
    const before = snapshot(s.db); expect((await s.write(state, 'rooms', payload, a, key)).json()).toEqual(r.json()); expect(snapshot(s.db)).toEqual(before);
    const helper = actor('settlement'), view = await s.read(state, 'rooms', helper); expect(view.statusCode).toBe(200); expect(view.json().can_manage).toBe(false);
    expect((await s.write(state, 'rooms', rooms(state, s.revision(state)), helper)).statusCode).toBe(403); expect(snapshot(s.db)).toEqual(before);
    s.db.prepare("UPDATE events SET owner_id='outsider' WHERE id=?").run(state);
    s.db.prepare('INSERT OR IGNORE INTO event_access VALUES(?,?,?)').run(state, a.id, stamp); const moved = snapshot(s.db);
    expect((await s.write(state, 'rooms', payload, a, key)).statusCode).toBe(403); expect(snapshot(s.db)).toEqual(moved);
  });
  for (const lock of ['archived', 'cancelled', 'draft', 'settled']) it('blocks fresh owner room changes when ' + lock, async () => {
    const s = await setup(lock === 'settled'), a = actor('alice');
    if (lock === 'archived') s.db.prepare("UPDATE events SET archived_at=? WHERE id='listen'").run(stamp);
    if (lock === 'cancelled' || lock === 'draft') s.db.prepare("UPDATE events SET lifecycle=? WHERE id='listen'").run(lock);
    const before = snapshot(s.db), view = await s.read('listen', 'rooms', a); expect(view.statusCode).toBe(200); expect(view.json().can_manage).toBe(false);
    expect((await s.write('listen', 'rooms', rooms('listen'), a)).statusCode).toBe(409); expect(snapshot(s.db)).toEqual(before);
  });
});
