import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';
import { testPNG } from './payment-fixture';

const origin = 'https://rebuild.example', stamp = '2026-11-17T00:00:00+00:00';
const rescueKey = 'synthetic-payment-rescue-' + 'x'.repeat(32);
// Independent expectations: being an administrator/cohost never gives access
// to another account's library or another publisher's frozen source.
const actors = [
  { id: 'alice', member: true }, { id: 'bob', member: true },
  { id: 'cohost', member: true }, { id: 'admin', member: true },
  { id: 'outsider', member: true }, { id: 'rescue', member: false },
  { id: 'visitor', member: false }, { id: 'anonymous', member: false },
] as const;
type Actor = typeof actors[number];
type State = 'listen' | 'invite';
const actor = (id: string) => actors.find(a => a.id === id)!;
const images = [testPNG([12, 23, 34]), testPNG([45, 56, 67])];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(archived = false) {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-payment-authority-')); cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const db = openDatabase(join(root, 'owned.sqlite3')); cleanup.push(async () => { db.close(); }); fixture(db);
  for (const a of actors.filter(a => a.member && !['alice', 'bob'].includes(a.id))) {
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(a.id, hash('payment-' + a.id), a.id, stamp);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('payment-' + a.id), a.id, stamp);
  }
  db.exec("INSERT INTO user_admin_roles VALUES('admin',1,1,'before')");
  for (const state of ['listen', 'invite']) {
    db.prepare("INSERT INTO event_roles VALUES(?,?,'cohost','[\"schedule\",\"roster\",\"attendance\",\"settlement\"]',?)").run(state + '-cohost', state, stamp);
    for (const version of [1, 2]) {
      const who = version === 1 ? 'alice' : 'bob';
      db.prepare(`INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields)
        VALUES(?,?,100,1,'',?,?,?,?,'published','[]')`).run(state, version, images[version - 1], stamp, who, who);
    }
  }
  const app = createApp({ db, origin, now: () => new Date(stamp), adminCredentialHash: () => hash(rescueKey) });
  cleanup.push(async () => { await app.close(); }); await app.ready();
  const headers = new Map<string, Record<string, string>>();
  for (const a of actors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const token = a.member ? (['alice', 'bob'].includes(a.id) ? 'fixture-' + a.id : 'payment-' + a.id) : '';
    const r = await app.inject({ url: '/api/v2/session', headers: { cookie: token ? 'kanban_session=' + token : '' } }); expect(r.statusCode, r.body).toBe(200);
    const session = r.json(), h = { cookie: token ? 'kanban_session=' + token : String(r.headers['set-cookie']).split(';')[0]!, origin,
      'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
    if (a.id === 'rescue') {
      const login = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key: rescueKey, confirm: true } });
      expect(login.statusCode, login.body).toBe(200); h.cookie += '; ' + String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ url: '/api/v2/admin/session', headers: h })).json()).toMatchObject({ authMethod: 'credential', currentUserId: null });
    }
    headers.set(a.id, h);
  }
  const read = (path: string, a: Actor, extra: Record<string, string> = {}) => app.inject({ url: path, headers: { ...headers.get(a.id)!, ...extra } });
  const write = (path: string, payload: object, a: Actor, key = randomUUID(), extra: Record<string, string> = {}, method: 'POST' | 'DELETE' = 'POST') =>
    app.inject({ method, url: path, headers: { ...headers.get(a.id)!, 'idempotency-key': key, ...extra }, payload });
  const codes = new Map<string, { id: string; url: string }>();
  for (const [index, who] of ['alice', 'bob'].entries()) {
    const r = await write('/api/v2/me/payment-codes', { kind: 'wechat', name: who, image: images[index]!.toString('base64'), confirm: true }, actor(who));
    expect(r.statusCode, r.body).toBe(200); codes.set(who, r.json());
  }
  if (archived) expect((await write('/api/v2/me/payment-codes/' + codes.get('alice')!.id, { confirm: true }, actor('alice'), randomUUID(), {}, 'DELETE')).statusCode).toBe(200);
  return { root, db, app, headers, read, write, codes };
}
function snapshot(db: DB, root: string) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  const files: { path: string; sha256: string }[] = [];
  function walk(path: string) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(path, entry.name); if (entry.isDirectory()) walk(next); else files.push({ path: next.slice(root.length), sha256: createHash('sha256').update(readFileSync(next)).digest('hex') });
    }
  }
  walk(join(root, 'images'));
  return { tables: Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()])), images: files };
}
const source = (state: State, version: number) => ({ kind: 'alipay', name: '原版另存 ' + version, confirm: true, source: { event_id: state, version, kind: 'other' } });

describe('private payment library across identities', () => {
  for (const a of actors) for (const status of ['active', 'archived']) it(a.id + ' / ' + status + ': library reads and archives require the actual account', async () => {
    const s = await setup(status === 'archived'), code = s.codes.get('alice')!, before = snapshot(s.db, s.root);
    const list = await s.read('/api/v2/me/payment-codes', a); expect(list.statusCode, list.body).toBe(a.member ? 200 : 401);
    if (list.statusCode === 200) expect(list.json().codes.map((c: { id: string }) => c.id)).toEqual(a.id === 'alice' && status === 'active' ? [code.id] : a.id === 'bob' ? [s.codes.get('bob')!.id] : []);
    const image = await s.read(code.url, a); expect(image.statusCode, image.body).toBe(!a.member ? 401 : a.id === 'alice' && status === 'active' ? 200 : 404);
    if (image.statusCode === 200) { expect(image.rawPayload).toEqual(images[0]); expect(image.headers['vary']).toContain('X-Account-Scope'); }
    expect(snapshot(s.db, s.root)).toEqual(before);
    if (a.id !== 'alice' || status === 'archived') {
      const r = await s.write('/api/v2/me/payment-codes/' + code.id, { confirm: true }, a, randomUUID(), {}, 'DELETE');
      expect(r.statusCode, r.body).toBe(a.member ? 404 : 401); expect(r.json().code).not.toBe('INVALID_INPUT'); expect(snapshot(s.db, s.root)).toEqual(before);
    }
  });
});

describe('frozen payment source belongs to its original publisher', () => {
  for (const a of actors) for (const state of ['listen', 'invite'] as const) for (const version of [1, 2]) it(a.id + ' / ' + state + ' / v' + version + ': frozen import authority differs from current activity access', async () => {
    const s = await setup(), before = snapshot(s.db, s.root), owns = a.id === (version === 1 ? 'alice' : 'bob');
    const assets = await s.read('/api/v2/activities/' + state + '/settlement/history/' + version + '/assets', a);
    expect(assets.statusCode, assets.body).toBe(state === 'listen' || a.id === 'alice' ? 200 : 404);
    if (assets.statusCode === 200) expect(assets.json().can_save).toBe(owns); expect(snapshot(s.db, s.root)).toEqual(before);
    const payload = source(state, version), key = randomUUID(), r = await s.write('/api/v2/me/payment-codes', payload, a, key);
    expect(r.statusCode, r.body).toBe(!a.member ? 401 : owns ? 200 : 403);
    if (r.statusCode !== 200) { expect(r.json().code).not.toBe('INVALID_INPUT'); expect(snapshot(s.db, s.root)).toEqual(before); return; }
    expect((await s.read(r.json().url, a)).rawPayload).toEqual(images[version - 1]);
    const others = (rows: Record<string, unknown>) => Object.fromEntries(Object.entries(rows).filter(([table]) => !['user_payment_codes', 'request_results', 'image_assets'].includes(table)));
    expect(others(snapshot(s.db, s.root).tables)).toEqual(others(before.tables)); expect(snapshot(s.db, s.root).images).toEqual(before.images);
    const saved = snapshot(s.db, s.root); expect((await s.write('/api/v2/me/payment-codes', payload, a, key)).json()).toEqual(r.json()); expect(snapshot(s.db, s.root)).toEqual(saved);
    s.db.prepare("UPDATE events SET status='deleted' WHERE id=?").run(state); const removed = snapshot(s.db, s.root);
    expect((await s.write('/api/v2/me/payment-codes', payload, a, key)).statusCode).toBe(403);
    expect((await s.read(r.json().url, a)).rawPayload).toEqual(images[version - 1]); expect(snapshot(s.db, s.root)).toEqual(removed);
  });
});

describe('payment operation receipts remain account scoped', () => {
  for (const who of ['alice', 'bob']) it(who + ' can archive once but another account cannot replay the archive receipt', async () => {
    const s = await setup(), a = actor(who), other = actor(who === 'alice' ? 'bob' : 'alice'), code = s.codes.get(who)!, key = randomUUID(), path = '/api/v2/me/payment-codes/' + code.id;
    expect((await s.write(path, { confirm: true }, a, key, {}, 'DELETE')).json()).toEqual({ ok: true }); const before = snapshot(s.db, s.root);
    expect((await s.write(path, { confirm: true }, a, key, {}, 'DELETE')).json()).toEqual({ ok: true });
    expect((await s.write(path, { confirm: true }, other, key, {}, 'DELETE')).statusCode).toBe(404);
    expect((await s.read(code.url, a)).statusCode).toBe(404); expect(snapshot(s.db, s.root)).toEqual(before);
    s.db.prepare('DELETE FROM browser_sessions WHERE user_id=?').run(who); const revoked = snapshot(s.db, s.root);
    expect((await s.write(path, { confirm: true }, a, key, {}, 'DELETE')).statusCode).toBe(401); expect(snapshot(s.db, s.root)).toEqual(revoked);
  });
  const boundaryCases = [
    { name: 'missing scope', patch: { 'x-account-scope': '' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'another account scope', patch: { 'x-account-scope': 'other' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'missing origin', patch: { origin: '' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'foreign origin', patch: { origin: 'https://outside.example' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'wrong CSRF', patch: { 'x-csrf-token': '0'.repeat(64) }, status: 403, code: 'CSRF_REJECTED' },
  ] as const;
  for (const who of ['alice', 'bob']) for (const boundary of boundaryCases) it(who + ' rejects ' + boundary.name + ' before source import or archive', async () => {
    const s = await setup(), a = actor(who), before = snapshot(s.db, s.root);
    for (const [path, payload, method] of [
      ['/api/v2/me/payment-codes', source('listen', who === 'alice' ? 1 : 2), 'POST'],
      ['/api/v2/me/payment-codes/' + s.codes.get(who)!.id, { confirm: true }, 'DELETE'],
    ] as const) {
      const r = await s.write(path, payload, a, randomUUID(), boundary.patch, method); expect(r.statusCode, r.body).toBe(boundary.status);
      expect(r.json().code).toBe(boundary.code); expect(snapshot(s.db, s.root)).toEqual(before);
    }
  });
});
