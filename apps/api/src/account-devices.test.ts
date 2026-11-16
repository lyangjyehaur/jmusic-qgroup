import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import type { Viewer } from '@qgroup/contracts';
import { createApp, accountScope, hash } from './app';
import { fixture } from '../testsupport/fixture';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db);
  let clock = new Date('2026-11-17T08:00:00.000Z'); const origin = 'https://rebuild.example';
  const app = createApp({ db, origin, now: () => clock }); await app.ready();
  close.push(async () => { await app.close(); db.close(); });
  async function browser(token = '') {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie: token ? 'kanban_session=' + token : '' } });
    return { cookie: String(response.headers['set-cookie'] ?? 'kanban_session=' + token).split(';')[0]!, viewer: response.json<Viewer>() };
  }
  type Browser = Awaited<ReturnType<typeof browser>>;
  const headers = (b: Browser) => ({ cookie: b.cookie, origin, 'x-account-scope': b.viewer.scope, 'x-csrf-token': b.viewer.csrf });
  const get = (b: Browser, path: string, override = {}) => app.inject({ url: '/api/v2' + path, headers: { ...headers(b), ...override } });
  const post = (b: Browser, path: string, payload: object, override = {}) => app.inject({ method: 'POST', url: '/api/v2' + path, payload, headers: { ...headers(b), ...override } });
  const issue = async (b: Browser) => { const response = await post(b, '/me/devices/link', { confirm: true, authorizeOwnDevice: true }); expect(response.statusCode).toBe(200); return response.json<{ token: string; expiresAt: string }>(); };
  const view = (b: Browser, token: string) => post(b, '/device-links/view', { token });
  const accept = (b: Browser, token: string) => post(b, '/device-links/accept', { token, confirm: true, acceptAccess: true });
  const devices = async (b: Browser) => (await get(b, '/me/devices')).json<{ devices: { id: string; current: boolean; createdAt: string }[] }>().devices;
  const revoke = (b: Browser, deviceId: string) => post(b, '/me/devices/revoke', { deviceId, confirm: true });
  const alice = await browser('fixture-alice'); const bob = await browser('fixture-bob');
  return { app, db, browser, alice, bob, headers, get, post, issue, view, accept, devices, revoke, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
describe('explicit device access grants and account history', () => {
  it('issues a 10 minute hashed one-time link, reads without consuming, and grants without changing either account', async () => {
    const s = await setup(); const users = s.db.prepare('SELECT * FROM users ORDER BY id').all();
    const link = await s.issue(s.alice);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{32}$/); expect(link.expiresAt).toBe('2026-11-17T08:10:00.000Z');
    const row = s.db.prepare('SELECT token,status FROM device_links').get(); expect(row).toEqual({ token: 'sha256:' + hash(link.token), status: 'pending' });
    const guest = await s.browser();
    expect((await s.view(guest, link.token)).json()).toEqual({ status: 'pending', nickname: '小青', expiresAt: link.expiresAt, alreadyAuthorized: false });
    expect(s.db.prepare('SELECT status FROM device_links').get()).toEqual({ status: 'pending' });
    const accepted = await s.accept(s.bob, link.token); expect(accepted.statusCode).toBe(200); expect(accepted.headers['set-cookie']).toBeUndefined();
    expect((await s.browser('fixture-bob')).viewer).toEqual(s.bob.viewer);
    expect((await s.get(s.bob, '/me/accounts')).json().accounts).toHaveLength(2);
    expect((await s.view(s.bob, link.token)).json()).toMatchObject({ status: 'accepted', alreadyAuthorized: true });
    expect((await s.view(guest, link.token)).statusCode).toBe(404);
    expect((await s.accept(s.bob, link.token)).statusCode).toBe(404);
    expect(s.db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(users);
    expect(s.db.prepare("SELECT count(*) n FROM account_audit WHERE action='device_link_accepted'").get()).toEqual({ n: 1 });
    const audit = JSON.stringify(s.db.prepare('SELECT * FROM account_audit').all());
    expect(audit).not.toContain(link.token); expect(audit).not.toContain(hash('fixture-bob'));
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('requires explicit consent, current member scope, Origin and CSRF for all mutations', async () => {
    const s = await setup(); const guest = await s.browser(); const link = await s.issue(s.alice);
    expect((await s.post(s.alice, '/me/devices/link', { confirm: false, authorizeOwnDevice: true })).statusCode).toBe(400);
    expect((await s.post(s.alice, '/me/devices/link', { confirm: true, authorizeOwnDevice: false })).statusCode).toBe(400);
    expect((await s.post(s.bob, '/device-links/accept', { token: link.token, confirm: true, acceptAccess: false })).statusCode).toBe(400);
    expect((await s.accept(guest, link.token)).statusCode).toBe(401);
    expect((await s.post(guest, '/me/devices/link', { confirm: true, authorizeOwnDevice: true })).statusCode).toBe(401);
    for (const path of ['/me/devices', '/me/account-history']) {
      expect((await s.get(guest, path)).statusCode).toBe(401);
      expect((await s.get(s.alice, path, { 'x-account-scope': accountScope('bob') })).statusCode).toBe(409);
    }
    for (const [path, payload] of [['/device-links/view', { token: link.token }], ['/device-links/accept', { token: link.token, confirm: true, acceptAccess: true }], ['/me/devices/link', { confirm: true, authorizeOwnDevice: true }], ['/me/devices/revoke-link', { confirm: true }], ['/me/devices/revoke', { deviceId: '0'.repeat(64), confirm: true }]] as const) {
      for (const [override, code] of [[{ origin: 'https://evil.example' }, 403], [{ 'x-csrf-token': '0'.repeat(64) }, 403], [{ 'x-account-scope': 'stale' }, 409]] as const) expect((await s.post(s.bob, path, payload, override)).statusCode).toBe(code);
    }
    expect(s.db.prepare("SELECT count(*) n FROM device_links WHERE status='used'").get()).toEqual({ n: 0 });
  });
  it('rejects malformed, expired, revoked and superseded links and does not consume a link already authorized on this device', async () => {
    const s = await setup(); const first = await s.issue(s.alice); const next = await s.issue(s.alice);
    expect((await s.accept(s.bob, first.token)).statusCode).toBe(404);
    expect((await s.view(s.alice, next.token)).json().alreadyAuthorized).toBe(true);
    expect((await s.accept(s.alice, next.token)).json().code).toBe('ALREADY_AUTHORIZED');
    expect(s.db.prepare("SELECT status FROM device_links WHERE token=?").get('sha256:' + hash(next.token))).toEqual({ status: 'pending' });
    for (const token of ['x', 'x'.repeat(33), 'sha256:' + hash(next.token), '../bad', 'A'.repeat(31) + '\n']) expect((await s.view(s.bob, token)).statusCode).toBe(400);
    expect((await s.view(s.bob, 'x'.repeat(32))).statusCode).toBe(404);
    s.advance(600000); expect((await s.accept(s.bob, next.token)).statusCode).toBe(404);
    const active = await s.issue(s.alice);
    expect((await s.post(s.alice, '/me/devices/revoke-link', { confirm: true })).statusCode).toBe(200);
    expect((await s.accept(s.bob, active.token)).statusCode).toBe(404);
  });
  it('accepts a still-valid legacy plaintext link without rewriting it or treating digests as bearer tokens', async () => {
    const s = await setup(); const token = 'L'.repeat(32);
    s.db.prepare("INSERT INTO device_links VALUES('legacy',?,'alice','pending','2026-11-17T08:10:00+00:00','before',NULL)").run(token);
    expect((await s.accept(s.bob, token)).statusCode).toBe(200);
    expect(s.db.prepare('SELECT token,status FROM device_links').get()).toEqual({ token, status: 'used' });
    expect((await s.accept(s.bob, 'sha256:' + hash(token))).statusCode).toBe(400);
  });
  it('lets exactly one concurrent device consume a link and keeps its receipt private to that session', async () => {
    const s = await setup();
    s.db.prepare("INSERT INTO browser_sessions VALUES(?,'bob','before')").run(hash('other-bob'));
    const other = await s.browser('other-bob'); const link = await s.issue(s.alice);
    const responses = await Promise.all([s.accept(s.bob, link.token), s.accept(other, link.token)]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 404]);
    const receipt = await Promise.all([s.view(s.bob, link.token), s.view(other, link.token)]);
    expect(receipt.map(r => r.statusCode).sort()).toEqual([200, 404]);
    expect(s.db.prepare("SELECT count(*) n FROM browser_accounts WHERE user_id='alice'").get()).toEqual({ n: 1 });
  });
  it('lists only the current account devices with legacy opaque IDs and refuses current or foreign revocation', async () => {
    const s = await setup(); const device = (await s.devices(s.alice))[0]!;
    expect(device).toEqual({ id: hash('alice' + hash('fixture-alice')), current: true, createdAt: '2026-11-17T00:00:00+00:00' });
    expect((await s.revoke(s.alice, device.id)).json().code).toBe('CURRENT_DEVICE');
    const other = (await s.devices(s.bob))[0]!;
    expect((await s.revoke(s.alice, other.id)).statusCode).toBe(404);
    const body = (await s.get(s.alice, '/me/devices')).body;
    expect(body).not.toContain(hash('fixture-alice')); expect(body).not.toContain('token_hash');
  });
  it('revokes only this account on a device currently using a different account and preserves its pending authorization', async () => {
    const s = await setup(); const link = await s.issue(s.alice); await s.accept(s.bob, link.token);
    s.db.prepare(`INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at)
      VALUES('other-intent',?,'bob','qq','12345','bind','verified','2099','before')`).run(hash('fixture-bob'));
    const remote = (await s.devices(s.alice)).find(d => !d.current)!;
    expect((await s.revoke(s.alice, remote.id)).statusCode).toBe(200);
    expect((await s.browser('fixture-bob')).viewer).toEqual(s.bob.viewer);
    expect((await s.get(s.bob, '/me/accounts')).json().accounts).toEqual([{ scope: accountScope('bob'), nickname: '小白', current: true }]);
    expect((await s.post(s.bob, '/me/accounts/switch', { scope: accountScope('alice'), confirm: true })).statusCode).toBe(403);
    expect(s.db.prepare('SELECT status FROM login_attempts').get()).toEqual({ status: 'verified' });
    expect((await s.revoke(s.alice, remote.id)).statusCode).toBe(404);
  });
  it('returns a revoked active session to a valid alternate, rejects old scope reads/writes and invalidates in-flight QQ', async () => {
    const s = await setup(); const link = await s.issue(s.alice); await s.accept(s.bob, link.token);
    await s.post(s.bob, '/me/accounts/switch', { scope: accountScope('alice'), confirm: true });
    const active = await s.browser('fixture-bob');
    s.db.prepare(`INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at)
      VALUES('in-flight',?,'alice','qq','12345','bind','exchanging','2099','before')`).run(hash('fixture-bob'));
    const pending = await s.issue(s.alice);
    const remote = (await s.devices(s.alice)).find(d => !d.current)!; await s.revoke(s.alice, remote.id);
    expect((await s.browser('fixture-bob')).viewer.scope).toBe(accountScope('bob'));
    expect((await s.get(active, '/me/music')).statusCode).toBe(409);
    expect((await s.post(active, '/me/devices/link', { confirm: true, authorizeOwnDevice: true })).statusCode).toBe(409);
    expect(s.db.prepare('SELECT status FROM login_attempts').get()).toEqual({ status: 'failed' });
    expect((await s.view(s.bob, pending.token)).statusCode).toBe(404);
    expect((await s.get(s.alice, '/me/music')).statusCode).toBe(200);
  });
  it('ends a remote session with no valid alternate, excluding erased grants from fallback', async () => {
    const s = await setup();
    s.db.prepare("INSERT INTO browser_sessions VALUES(?,'alice','before')").run(hash('alice-remote'));
    s.db.prepare('INSERT INTO browser_accounts VALUES(?,?,?)').run(hash('alice-remote'), 'bob', 'before');
    s.db.prepare("INSERT INTO privacy_requests VALUES('erased','bob','pending','now','now','')").run();
    const remote = (await s.devices(s.alice)).find(d => !d.current)!;
    expect((await s.revoke(s.alice, remote.id)).statusCode).toBe(200);
    expect((await s.browser('alice-remote')).viewer.authenticated).toBe(false);
    expect(s.db.prepare('SELECT * FROM browser_accounts WHERE token_hash=?').all(hash('alice-remote'))).toEqual([]);
  });
  it('rejects links owned by erased accounts and cannot regrant access after deletion', async () => {
    const s = await setup(); const link = await s.issue(s.alice);
    s.db.prepare("INSERT INTO privacy_requests VALUES('erased','alice','pending','now','now','')").run();
    expect((await s.view(s.bob, link.token)).statusCode).toBe(404);
    expect((await s.accept(s.bob, link.token)).statusCode).toBe(404);
    expect((await s.get(s.alice, '/me/devices')).statusCode).toBe(401);
  });
  it('rolls back link replacement, acceptance, fallback, pending intents and revocation when audit fails', async () => {
    const s = await setup(); const first = await s.issue(s.alice);
    s.db.exec("CREATE TRIGGER reject_device_audit BEFORE INSERT ON account_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect((await s.post(s.alice, '/me/devices/link', { confirm: true, authorizeOwnDevice: true })).statusCode).toBe(500);
    expect((await s.view(s.bob, first.token)).statusCode).toBe(200);
    expect((await s.accept(s.bob, first.token)).statusCode).toBe(500);
    expect(s.db.prepare('SELECT * FROM browser_accounts').all()).toEqual([]);
    s.db.exec('DROP TRIGGER reject_device_audit'); await s.accept(s.bob, first.token);
    await s.post(s.bob, '/me/accounts/switch', { scope: accountScope('alice'), confirm: true });
    const pending = await s.issue(s.alice); const remote = (await s.devices(s.alice)).find(d => !d.current)!;
    s.db.exec("CREATE TRIGGER reject_device_audit BEFORE INSERT ON account_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const before = ['browser_sessions', 'browser_accounts', 'device_links'].map(t => s.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all());
    const failed = await s.revoke(s.alice, remote.id); expect(failed.statusCode).toBe(500); expect(failed.body).not.toContain('synthetic');
    expect(['browser_sessions', 'browser_accounts', 'device_links'].map(t => s.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all())).toEqual(before);
    expect((await s.view(s.bob, pending.token)).statusCode).toBe(409); // Bob's old page is stale, not newly authorized.
    expect(() => s.db.prepare('DELETE FROM account_audit').run()).toThrow('append-only');
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('paginates only the current account history and never returns audit details or another account events', async () => {
    const s = await setup();
    for (let i = 0; i < 30; i++) s.db.prepare('INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES(?,?,?,?)').run('alice', 'device_link_issued', '{"secret":"sensitive-token"}', '2026-11-17T08:00:00Z');
    s.db.prepare("INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES('bob','bob-only','{}','before')").run();
    const first = await s.get(s.alice, '/me/account-history');
    expect(first.json().history).toHaveLength(25); expect(first.json().nextCursor).toBe(6);
    expect(first.headers['cache-control']).toBe('no-store'); expect(first.body).not.toMatch(/sensitive-token|details|bob-only/);
    const second = await s.get(s.alice, '/me/account-history?before=6');
    expect(second.json().history).toHaveLength(5); expect(second.json().nextCursor).toBeNull();
    expect((await s.get(s.bob, '/me/account-history')).json().history).toHaveLength(1);
    for (const query of ['before=-1', 'before=1.5', 'before=9007199254740992', 'other=1']) expect((await s.get(s.alice, '/me/account-history?' + query)).statusCode).toBe(400);
  });
});
