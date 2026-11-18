import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { PRIVACY_VERSION } from '@qgroup/contracts';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example';
async function setup(path = ':memory:') {
  const db = openDatabase(path); fixture(db);
  db.prepare("INSERT INTO privacy_consents VALUES('bob','2026-11-10','original-time')").run();
  const app = createApp({ db, origin, now: () => new Date('2026-11-18T02:00:00.000Z'), qq: {
    clientId: '12345', authorize: state => 'https://example.test/?state=' + state,
    exchange: async () => ({ subject: 'B'.repeat(32), nickname: 'QQ bob', avatarUrl: '', unionId: '' }),
  } });
  await app.ready(); cleanup.push(async () => { await app.close(); db.close(); });
  const session = async (user = 'bob') => (await app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-' + user } })).json();
  const headers = async (user = 'bob') => { const viewer = await session(user); return { cookie: 'kanban_session=fixture-' + user, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf }; };
  const body = { acceptPrivacy: true, privacyVersion: PRIVACY_VERSION };
  const post = async (payload = body, key: string = randomUUID(), extra = {}, user = 'bob') => app.inject({ method: 'POST', url: '/api/v2/me/privacy/consent', headers: { ...await headers(user), 'idempotency-key': key, ...extra }, payload });
  const get = async (suffix = '', user = 'bob') => app.inject({ url: '/api/v2/me/privacy/consent' + suffix, headers: await headers(user) });
  return { db, app, session, headers, body, post, get };
}
describe('explicit unified policy consent independent of legacy policy', () => {
  it('reads without inferring consent and preserves the exact old policy row through acceptance and retries', async () => {
    const s = await setup(), original = s.db.prepare('SELECT * FROM privacy_consents').all(), key = randomUUID();
    expect(await s.session()).toMatchObject({ authenticated: true, privacyVersion: PRIVACY_VERSION, privacyAccepted: false });
    expect((await s.get()).json()).toEqual({ version: PRIVACY_VERSION, accepted: false, acceptedAt: null });
    expect((await s.get('/receipts/' + key)).statusCode).toBe(404);
    expect(s.db.prepare('SELECT * FROM unified_privacy_consents').all()).toEqual([]);
    const first = await s.post(s.body, key); expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ requestKey: key, version: PRIVACY_VERSION, acceptedAt: '2026-11-18T02:00:00.000Z' });
    expect((await s.post(s.body, key)).json()).toEqual(first.json());
    expect((await s.get('/receipts/' + key)).json()).toEqual(first.json());
    expect((await s.post(s.body)).json().acceptedAt).toBe(first.json().acceptedAt);
    expect(s.db.prepare('SELECT * FROM unified_privacy_consents').all()).toHaveLength(1);
    expect(() => s.db.prepare("UPDATE unified_privacy_consents SET accepted_at='changed'").run()).toThrow('immutable');
    s.db.prepare('INSERT OR REPLACE INTO unified_privacy_consents VALUES(?,?,?,?)').run('bob', PRIVACY_VERSION, 'changed', 'qq');
    expect((await s.get()).json().acceptedAt).toBe(first.json().acceptedAt);
    expect(() => s.db.prepare('INSERT OR REPLACE INTO unified_privacy_receipts VALUES(?,?,?,?)').run('bob', key, PRIVACY_VERSION, 'changed')).toThrow('already exists');
    expect(s.db.prepare('SELECT * FROM privacy_consents').all()).toEqual(original);
    expect(await s.session()).toMatchObject({ privacyAccepted: true });
  });
  it('requires member scope, Origin, CSRF, exact confirmation, version and operation key without recording refusals', async () => {
    const s = await setup();
    for (const extra of [{ origin: 'https://evil.example' }, { 'x-csrf-token': 'wrong' }, { 'x-account-scope': 'wrong' }]) expect((await s.post(s.body, randomUUID(), extra)).statusCode).toBeGreaterThanOrEqual(400);
    for (const payload of [{ ...s.body, acceptPrivacy: false }, { ...s.body, privacyVersion: '2026-11-10' }, { ...s.body, unknown: true }]) expect((await s.post(payload)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await s.post(s.body, 'invalid')).statusCode).toBe(400);
    const visitor = await s.app.inject('/api/v2/session'), view = visitor.json();
    expect((await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/consent', payload: s.body, headers: { cookie: String(visitor.headers['set-cookie']).split(';')[0]!, origin, 'x-account-scope': view.scope, 'x-csrf-token': view.csrf, 'idempotency-key': randomUUID() } })).statusCode).toBe(401);
    for (const table of ['unified_privacy_consents', 'unified_privacy_receipts']) expect(s.db.prepare('SELECT * FROM ' + table).all()).toEqual([]);
  });
  it('never exposes or reassigns a receipt to a different authorized account', async () => {
    const s = await setup(), key = randomUUID(); await s.post(s.body, key);
    expect((await s.get('/receipts/' + key, 'alice')).statusCode).toBe(404);
    expect((await s.post({ ...s.body, privacyVersion: 'changed' }, key)).statusCode).toBe(409);
    expect(await s.session('alice')).toMatchObject({ privacyAccepted: false });
    expect(s.db.prepare('SELECT * FROM unified_privacy_consents').all()).toHaveLength(1);
  });
  it('retains receipts for an actually accepted historical version without acknowledging the current version', async () => {
    const s = await setup(), key = randomUUID(), body = { acceptPrivacy: true, privacyVersion: 'historical-unified' };
    s.db.prepare('INSERT INTO unified_privacy_consents VALUES(?,?,?,?)').run('bob', body.privacyVersion, 'historical-time', 'explicit');
    s.db.prepare('INSERT INTO unified_privacy_receipts VALUES(?,?,?,?)').run('bob', key, body.privacyVersion, hash('v2:privacy-consent:' + JSON.stringify(body)));
    expect((await s.post(body, key)).json()).toEqual({ requestKey: key, version: body.privacyVersion, acceptedAt: 'historical-time' });
    expect((await s.get('/receipts/' + key)).json().version).toBe(body.privacyVersion);
    expect((await s.post(body)).statusCode).toBe(409);
    expect(await s.session()).toMatchObject({ privacyAccepted: false });
  });
  it('rolls consent back atomically when storing the receipt fails', async () => {
    const s = await setup();
    s.db.exec("CREATE TRIGGER synthetic_consent_failure BEFORE INSERT ON unified_privacy_receipts BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
    expect((await s.post()).statusCode).toBe(500);
    expect(s.db.prepare('SELECT * FROM unified_privacy_consents').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM privacy_consents').all()).toHaveLength(1);
  });
  it('requires new explicit QQ login consent even when the current member has accepted, and rejects stale bind versions', async () => {
    const s = await setup(); await s.post();
    const headers = await s.headers(), body = { mode: 'login', confirm: true, acceptPrivacy: false, privacyVersion: PRIVACY_VERSION };
    expect((await s.app.inject({ method: 'POST', url: '/api/v2/auth/qq/start', headers, payload: body })).statusCode).toBe(400);
    expect((await s.app.inject({ method: 'POST', url: '/api/v2/auth/qq/start', headers, payload: { ...body, mode: 'bind', privacyVersion: 'old' } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: 'POST', url: '/api/v2/auth/qq/start', headers, payload: { ...body, mode: 'bind' } })).statusCode).toBe(200);
    expect(await s.session('alice')).toMatchObject({ privacyAccepted: false });
    expect(s.db.prepare('SELECT * FROM privacy_consents').all()).toHaveLength(1);
  });
  it.each(['typescript', 'python'])('removes new consent and receipts during %s account closure while preserving unrelated bot work', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'qgroup-consent-erasure-')); cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
    const s = await setup(join(root, 'synthetic.db')); await s.post();
    const tables = ['events', 'bot_settings', 'bot_outbox'], before = tables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    if (kind === 'typescript') {
      const result = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: await s.headers(), payload: { target: 'account', confirm: true, requestId: randomUUID(), secret: 'ab'.repeat(32), profileId: null, profileRevision: 0 } });
      expect(result.statusCode, result.body).toBe(200);
    } else execFileSync('python3', ['-c', "import sqlite3,sys; from qgroup_core import privacy; db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row; db.execute('PRAGMA foreign_keys=ON'); privacy.erase(db,'bob','synthetic-erase','now'); db.commit()", s.db.name]);
    for (const table of ['unified_privacy_consents', 'unified_privacy_receipts', 'privacy_consents']) expect(s.db.prepare('SELECT * FROM ' + table).all()).toEqual([]);
    expect(tables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
    expect(() => s.db.prepare('INSERT INTO unified_privacy_consents VALUES(?,?,?,?)').run('bob', PRIVACY_VERSION, 'now', 'explicit')).toThrow('Account is closed');
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
});
