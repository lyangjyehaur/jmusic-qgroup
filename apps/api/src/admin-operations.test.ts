import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { OperationReceipt } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp, hash } from './app';

const origin = 'https://rebuild.example', rescueKey = 'synthetic-admin-rescue-' + 'x'.repeat(32);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db);
  db.exec("INSERT INTO user_admin_roles VALUES('alice',1,1,'before'),('bob',1,1,'before')");
  let time = '2026-11-18T08:00:00Z', credential = hash(rescueKey);
  const app = createApp({ db, origin, now: () => new Date(time), adminCredentialHash: () => credential });
  await app.ready(); cleanup.push(async () => { await app.close(); db.close(); });
  async function browser(token = 'fixture-alice') {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie: token ? 'kanban_session=' + token : '' } });
    const viewer = response.json();
    return { cookie: token ? 'kanban_session=' + token : String(response.headers['set-cookie']).split(';')[0]!,
      'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf, origin };
  }
  const alice = await browser(), bob = await browser('fixture-bob');
  const access = async (headers = alice) => (await app.inject({ url: '/api/v2/admin/session', headers })).json();
  const check = async (key: string, headers = alice, scope?: string) => app.inject({ url: '/api/v2/admin/operations/' + key,
    headers: { ...headers, 'x-admin-scope': scope ?? (await access(headers)).scope } });
  async function save(key = randomUUID(), headers = alice) {
    const policy = (await app.inject({ url: '/api/v2/admin/bot', headers })).json();
    const result = await app.inject({ method: 'POST', url: '/api/v2/admin/bot', headers: {
      ...headers, 'x-admin-csrf': (await access(headers)).adminCsrf, 'idempotency-key': key,
    }, payload: { command: 'save', revision: policy.revision, config: { ...policy.config, min_interval_seconds: 61 }, confirm: true } });
    expect(result.statusCode, result.body).toBe(200); return key;
  }
  async function rescue(headers: typeof alice) {
    const response = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers, payload: { key: rescueKey, confirm: true } });
    expect(response.statusCode, response.body).toBe(200);
    return { ...headers, cookie: headers.cookie + '; ' + String(response.headers['set-cookie']).split(';')[0] };
  }
  return { db, app, alice, bob, browser, access, check, save, rescue, tick: (value: string) => { time = value; }, rotate: () => { credential = hash('rotated'); } };
}

describe('minimal administrator operation receipts', () => {
  it('finds an accepted admin command in its original authority without exposing the stored response or changing business and bot data', async () => {
    const s = await setup(), key = await s.save();
    const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const snapshot = () => tables.map(name => s.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all());
    const before = snapshot();
    const result = await s.check(key);
    expect(result.statusCode).toBe(200); expect(OperationReceipt.parse(result.json())).toEqual({ committed: true });
    expect(result.body).toBe('{"committed":true}'); expect(result.headers['cache-control']).toBe('no-store'); expect(result.headers.vary).toBe('Cookie');
    expect((await s.check(randomUUID())).json()).toEqual({ committed: false });
    expect(snapshot()).toEqual(before);
  });
  it('keeps member, other administrator and browser credential receipts in separate namespaces even when UUIDs collide', async () => {
    const s = await setup(), adminKey = await s.save(), memberKey = randomUUID();
    s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('alice', memberKey, 'PRIVATE_SIGNATURE', '{"private":"PRIVATE_RESPONSE"}', 200, 'before');
    s.db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?,?)').run(hash('fixture-alice'), memberKey, 'PRIVATE_SIGNATURE', '{"private":"PRIVATE_RESPONSE"}', 'before');
    expect((await s.check(memberKey)).json()).toEqual({ committed: false });
    expect((await s.check(adminKey, s.bob)).json()).toEqual({ committed: false });
    const memberResult = await s.app.inject({ url: '/api/v2/me/operations/' + adminKey, headers: s.alice });
    expect(memberResult.json()).toEqual({ committed: false });
    s.db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('second-alice-device'), 'alice', 'before');
    const second = await s.browser('second-alice-device'), oldScope = (await s.access()).scope;
    expect((await s.check(adminKey, second)).json()).toEqual({ committed: false });
    expect((await s.check(adminKey, second, oldScope)).statusCode).toBe(409);
  });
  it('rejects absent and changed member scopes and validates UUIDs, authority scopes and unexpected query parameters', async () => {
    const s = await setup(), key = await s.save(), url = '/api/v2/admin/operations/' + key;
    expect((await s.app.inject({ url })).statusCode).toBe(401);
    expect((await s.app.inject({ url, headers: { cookie: s.alice.cookie } })).statusCode).toBe(409);
    expect((await s.app.inject({ url, headers: { ...s.alice, 'x-account-scope': s.bob['x-account-scope'] } })).statusCode).toBe(409);
    expect((await s.app.inject({ url, headers: s.alice })).statusCode).toBe(400);
    for (const value of ['short', 'A'.repeat(64), 'https://evil.example']) expect((await s.check(key, s.alice, value)).statusCode).toBe(400);
    expect((await s.check(key, s.alice, '0'.repeat(64))).json()).toMatchObject({ code: 'ADMIN_CHANGED' });
    expect((await s.check('not-a-uuid')).statusCode).toBe(400);
    const access = await s.access();
    expect((await s.app.inject({ url: url + '?token_hash=PRIVATE', headers: { ...s.alice, 'x-admin-scope': access.scope } })).statusCode).toBe(400);
  });
  it('rechecks role removal and regrant before receipt lookup, without treating an earlier scope as current authority', async () => {
    const s = await setup(), key = await s.save(), original = (await s.access()).scope;
    s.db.exec("UPDATE user_admin_roles SET is_admin=0,revision=2 WHERE user_id='alice'");
    expect((await s.check(key, s.alice, original)).statusCode).toBe(403);
    s.db.exec("UPDATE user_admin_roles SET is_admin=1,revision=3 WHERE user_id='alice'");
    expect((await s.check(key, s.alice, original)).statusCode).toBe(409);
    expect((await s.check(key)).json()).toEqual({ committed: false });
  });
  it('supports visitor rescue authority and isolates renewed rescue sessions without returning old command content', async () => {
    const s = await setup(), guest = await s.browser(''), first = await s.rescue(guest), key = await s.save(randomUUID(), first), original = (await s.access(first)).scope;
    expect((await s.check(key, first)).json()).toEqual({ committed: true });
    const second = await s.rescue(guest);
    expect((await s.check(key, second, original)).statusCode).toBe(409);
    expect((await s.check(key, second)).json()).toEqual({ committed: false });
    expect((await s.check(key, guest, original)).statusCode).toBe(401);
  });
  for (const mode of ['expired', 'rotated', 'logout'] as const) it('rejects an existing receipt after rescue authority is ' + mode, async () => {
    const s = await setup(), guest = await s.browser(''), first = await s.rescue(guest), key = await s.save(randomUUID(), first), access = await s.access(first);
    if (mode === 'expired') s.tick('2026-11-18T09:00:01Z');
    else if (mode === 'rotated') s.rotate();
    else expect((await s.app.inject({ method: 'POST', url: '/api/v2/admin/logout', headers: { ...first, 'x-admin-csrf': access.adminCsrf }, payload: { confirm: true } })).statusCode).toBe(200);
    expect((await s.check(key, first, access.scope)).statusCode).toBe(401);
  });
});
