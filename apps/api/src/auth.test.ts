import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { PRIVACY_VERSION, type Viewer } from '@qgroup/contracts';
import { createApp, accountScope, hash } from './app';
import { safeReturnTo } from './auth';
import { fixture } from '../testsupport/fixture';
import type { QQIdentityValue } from './qq-provider';

const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example';
const subject = 'A'.repeat(32);
const profile: QQIdentityValue = { subject, nickname: 'QQ 測試稱呼', avatarUrl: 'http://q1.qlogo.cn/avatar', unionId: 'union-original' };
async function setup(exchange = vi.fn(async (_code: string): Promise<QQIdentityValue> => profile), clientId = '12345') {
  const db = openDatabase(':memory:'); fixture(db);
  let clock = new Date('2026-11-17T08:00:00.000Z');
  const app = createApp({ db, origin, now: () => clock, qq: { clientId, authorize: state => 'https://graph.qq.com/authorize?state=' + state, exchange } });
  await app.ready(); resources.push(async () => { await app.close(); db.close(); });
  const read = async (cookie = '') => {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie } });
    return { cookie: String(response.headers['set-cookie'] ?? cookie).split(';')[0]!, viewer: response.json<Viewer>() };
  };
  const write = (browser: Awaited<ReturnType<typeof read>>, url: string, payload: object, override: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/v2' + url, headers: { cookie: browser.cookie, origin, 'x-account-scope': browser.viewer.scope, 'x-csrf-token': browser.viewer.csrf, ...override }, payload });
  const start = async (browser: Awaited<ReturnType<typeof read>>, mode = 'login', returnTo = '/me/music?from=%2Factivities%2Flisten#edit') => {
    const response = await write(browser, '/auth/qq/start', { mode, confirm: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION, returnTo });
    expect(response.statusCode).toBe(200);
    return new URL(response.json().authorizeUrl).searchParams.get('state')!;
  };
  const callback = (browser: Awaited<ReturnType<typeof read>>, state: string, code = 'code') => app.inject({ url: '/auth/qq/callback?' + new URLSearchParams({ state, code }), headers: { cookie: browser.cookie } });
  const status = async (browser: Awaited<ReturnType<typeof read>>) => (await app.inject({ url: '/api/v2/auth/qq/status', headers: { cookie: browser.cookie, 'x-account-scope': browser.viewer.scope } })).json();
  const verify = async (browser: Awaited<ReturnType<typeof read>>, mode = 'login') => { const state = await start(browser, mode); await callback(browser, state); return status(browser); };
  const finish = async (browser: Awaited<ReturnType<typeof read>>, attemptId: string) => write(browser, '/auth/qq/finish', { attemptId, confirm: true });
  return { db, app, exchange, read, write, start, callback, status, verify, finish, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
describe('shared account and explicit QQ authorization', () => {
  it('creates only a stable HttpOnly visitor session and checks consent, scope, origin, CSRF and explicit confirmation', async () => {
    const s = await setup(); const guest = await s.read();
    expect(guest.viewer).toMatchObject({ authenticated: false, privacyAccepted: false, qqEnabled: true });
    expect((await s.read(guest.cookie)).cookie).toBe(guest.cookie);
    expect(s.db.prepare('SELECT count(*) n FROM visitor_sessions').get()).toEqual({ n: 1 });
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    const body = { mode: 'login', confirm: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION };
    for (const [change, code] of [[{ origin: 'https://evil.example' }, 403], [{ 'x-csrf-token': 'a'.repeat(64) }, 403], [{ 'x-account-scope': accountScope('alice') }, 409]] as const) expect((await s.write(guest, '/auth/qq/start', body, change)).statusCode).toBe(code);
    for (const patch of [{ confirm: false }, { acceptPrivacy: false }, { privacyVersion: 'outdated' }]) expect((await s.write(guest, '/auth/qq/start', { ...body, ...patch })).statusCode).toBe(400);
    expect((await s.write(guest, '/auth/qq/start', { ...body, mode: 'bind' })).statusCode).toBe(401);
    expect(s.db.prepare('SELECT count(*) n FROM login_attempts').get()).toEqual({ n: 0 });
  });
  it('verifies without creating an account, then explicitly creates and rotates the cookie atomically', async () => {
    const s = await setup(); const guest = await s.read(); const state = await s.start(guest);
    const redirect = await s.callback(guest, state);
    expect(redirect.statusCode).toBe(303); expect(redirect.headers.location).toBe('/auth/confirm');
    expect(redirect.headers['cache-control']).toBe('no-store'); expect(redirect.headers['referrer-policy']).toBe('no-referrer');
    const verified = await s.status(guest);
    expect(verified).toMatchObject({ status: 'verified', existingAccount: false, conflict: false, qqNickname: profile.nickname });
    expect(JSON.stringify(verified)).not.toMatch(/openid|union_id|access_token|AAAAAAAA/);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    expect(s.db.prepare('SELECT count(*) n FROM external_identities').get()).toEqual({ n: 0 });
    expect((await s.write(guest, '/auth/qq/finish', { attemptId: verified.attemptId, confirm: false })).statusCode).toBe(400);
    const result = await s.finish(guest, verified.attemptId);
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ newAccount: true, switched: true, returnTo: '/me/music?from=%2Factivities%2Flisten#edit' });
    expect(result.headers['set-cookie']).toContain('HttpOnly'); expect(result.headers['set-cookie']).toContain('Secure');
    const member = await s.read(String(result.headers['set-cookie']).split(';')[0]);
    expect(member.viewer).toMatchObject({ authenticated: true, privacyAccepted: true, nickname: profile.nickname, qq: { bound: true, unionidBound: true, needsReauth: false } });
    expect(member.cookie).not.toBe(guest.cookie);
    expect(s.db.prepare('SELECT count(*) n FROM visitor_sessions').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) n FROM account_audit').get()).toEqual({ n: 1 });
    expect((await s.finish(guest, verified.attemptId)).statusCode).toBe(401);
    expect((await s.finish(member, verified.attemptId)).statusCode).toBe(409);
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('binds to the existing ID without replacing its nickname and preserves independent grants and UnionID', async () => {
    const s = await setup(); const alice = await s.read('kanban_session=fixture-alice');
    s.db.prepare('INSERT INTO browser_accounts VALUES(?,?,?)').run(hash('fixture-alice'), 'bob', 'before');
    const before = s.db.prepare('SELECT * FROM users ORDER BY id').all();
    const verified = await s.verify(alice, 'bind');
    const response = await s.finish(alice, verified.attemptId); expect(response.statusCode).toBe(200);
    const member = await s.read(String(response.headers['set-cookie']).split(';')[0]);
    expect(member.viewer).toMatchObject({ authenticated: true, nickname: '小青', scope: accountScope('alice') });
    expect(s.db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(before);
    expect(s.db.prepare('SELECT user_id FROM browser_sessions WHERE token_hash=?').get(hash('fixture-alice'))).toBeUndefined();
    const list = await s.app.inject({ url: '/api/v2/me/accounts', headers: { cookie: member.cookie, 'x-account-scope': member.viewer.scope } });
    expect(list.json().accounts).toHaveLength(2);
    s.exchange.mockResolvedValue({ ...profile, nickname: '新 QQ 名稱', unionId: 'changed-union' });
    const reauth = await s.verify(member, 'bind');
    expect((await s.finish(member, reauth.attemptId)).statusCode).toBe(200);
    expect(s.db.prepare('SELECT union_id FROM external_unionids').get()).toEqual({ union_id: 'union-original' });
    expect(s.db.prepare('SELECT nickname FROM users WHERE id=?').get('alice')).toEqual({ nickname: '小青' });
  });
  it('never merges accounts by nickname or UnionID, and isolates equal OpenIDs by client ID', async () => {
    const s = await setup(); const alice = await s.read('kanban_session=fixture-alice');
    s.db.prepare("INSERT INTO external_identities VALUES('qq','another-client',?,'bob','same','before')").run(subject);
    s.db.prepare("INSERT INTO external_unionids VALUES('qq','another-client',?,'union-original','before')").run(subject);
    s.exchange.mockResolvedValue({ ...profile, nickname: '小青' });
    const verified = await s.verify(alice); expect(verified.existingAccount).toBe(false);
    const response = await s.finish(alice, verified.attemptId); expect(response.json().newAccount).toBe(true);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 3 });
    const current = await s.read(String(response.headers['set-cookie']).split(';')[0]);
    expect(current.viewer.scope).not.toBe(alice.viewer.scope);
    const again = await s.verify(current);
    expect(again.existingAccount).toBe(true); expect((await s.finish(current, again.attemptId)).json().newAccount).toBe(false);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 3 });
  });
  it('rejects both directions of binding conflict without overwriting identities', async () => {
    const s = await setup(); const alice = await s.read('kanban_session=fixture-alice');
    s.db.prepare("INSERT INTO external_identities VALUES('qq','12345',?,'bob','other','before')").run(subject);
    const verified = await s.verify(alice, 'bind'); expect(verified.conflict).toBe(true);
    expect((await s.finish(alice, verified.attemptId)).json().code).toBe('QQ_CONFLICT');
    s.db.prepare('DELETE FROM external_identities').run();
    s.db.prepare("INSERT INTO external_identities VALUES('qq','12345',?,'alice','original','before')").run('B'.repeat(32));
    const second = await s.verify(alice, 'bind'); expect(second.conflict).toBe(true);
    expect((await s.finish(alice, second.attemptId)).json().code).toBe('QQ_CONFLICT');
    expect(s.db.prepare('SELECT subject,user_id FROM external_identities').get()).toEqual({ subject: 'B'.repeat(32), user_id: 'alice' });
  });
  it('rejects wrong-device state, state replay, expiry, superseded authorization and cancellation', async () => {
    const s = await setup(); const guest = await s.read(); const other = await s.read();
    const state = await s.start(guest);
    expect((await s.callback(other, state)).headers.location).toContain('status=invalid'); expect(s.exchange).not.toHaveBeenCalled();
    await s.callback(guest, state); await s.callback(guest, state); expect(s.exchange).toHaveBeenCalledTimes(1);
    const newer = await s.start(guest); await s.callback(guest, state); expect(s.exchange).toHaveBeenCalledTimes(1);
    s.advance(600001); await s.callback(guest, newer); expect((await s.status(guest)).status).toBe('expired');
    const active = await s.start(guest); const cancel = await s.write(guest, '/auth/qq/cancel', { confirm: true });
    expect(cancel.json().returnTo).toContain('/me/music'); await s.callback(guest, active); expect(s.exchange).toHaveBeenCalledTimes(1);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    expect((await s.read(guest.cookie)).viewer.authenticated).toBe(false);
  });
  it('does not revive an authorization when a newer attempt or a session revocation arrives during exchange', async () => {
    let release!: (value: QQIdentityValue) => void;
    const s = await setup(vi.fn(() => new Promise<QQIdentityValue>(resolve => { release = resolve; })));
    const alice = await s.read('kanban_session=fixture-alice'); const state = await s.start(alice, 'bind');
    const pending = s.callback(alice, state); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const newer = await s.start(alice, 'bind'); release(profile); await pending;
    expect((await s.status(alice)).status).toBe('pending');
    const next = s.callback(alice, newer); await vi.waitFor(() => expect(s.exchange).toHaveBeenCalledTimes(2));
    s.db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(hash('fixture-alice'));
    release(profile); await next;
    expect(s.db.prepare("SELECT count(*) n FROM login_attempts WHERE status='verified'").get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) n FROM external_identities').get()).toEqual({ n: 0 });
  });
  it('rolls back identity, consent, grants, rotation and audit together and sends no new cookie on failure', async () => {
    const s = await setup(); const guest = await s.read(); const verified = await s.verify(guest);
    s.db.exec("CREATE TRIGGER reject_auth_audit BEFORE INSERT ON account_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const failed = await s.finish(guest, verified.attemptId); expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('synthetic'); expect(failed.headers['set-cookie']).toBeUndefined();
    for (const table of ['external_identities', 'external_profiles', 'external_unionids', 'privacy_consents', 'browser_accounts']) expect(s.db.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    expect((await s.status(guest)).status).toBe('verified');
    s.db.exec('DROP TRIGGER reject_auth_audit'); expect((await s.finish(guest, verified.attemptId)).statusCode).toBe(200);
  });
  it('switches only authorized accounts, rejects stale private reads/writes and excludes erased grants', async () => {
    const s = await setup(); const alice = await s.read('kanban_session=fixture-alice');
    expect((await s.write(alice, '/me/accounts/switch', { scope: accountScope('bob'), confirm: true })).statusCode).toBe(403);
    s.db.prepare('INSERT INTO browser_accounts VALUES(?,?,?)').run(hash('fixture-alice'), 'bob', 'before');
    const attempt = await s.start(alice, 'bind');
    expect((await s.write(alice, '/me/accounts/switch', { scope: accountScope('bob'), confirm: true })).statusCode).toBe(200);
    expect((await s.app.inject({ url: '/api/v2/me/music', headers: { cookie: alice.cookie, 'x-account-scope': alice.viewer.scope } })).statusCode).toBe(409);
    expect((await s.write(alice, '/auth/logout', { confirm: true })).statusCode).toBe(409);
    await s.callback(alice, attempt); expect(s.exchange).not.toHaveBeenCalled();
    const bob = await s.read(alice.cookie); expect(bob.viewer.scope).toBe(accountScope('bob'));
    s.db.prepare("INSERT INTO privacy_requests VALUES('erase','alice','pending','now','now','')").run();
    const accounts = await s.app.inject({ url: '/api/v2/me/accounts', headers: { cookie: bob.cookie, 'x-account-scope': bob.viewer.scope } });
    expect(accounts.json().accounts).toHaveLength(1);
    expect((await s.write(bob, '/me/accounts/switch', { scope: accountScope('alice'), confirm: true })).statusCode).toBe(403);
  });
  it('revokes all current device grants and attempts on logout while leaving another device signed in', async () => {
    const s = await setup(); const alice = await s.read('kanban_session=fixture-alice');
    s.db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash('other-device'), 'alice', 'before');
    s.db.prepare('INSERT INTO browser_accounts VALUES(?,?,?)').run(hash('fixture-alice'), 'bob', 'before');
    await s.start(alice);
    const response = await s.write(alice, '/auth/logout', { confirm: true }); expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect((await s.read('kanban_session=other-device')).viewer.authenticated).toBe(true);
    for (const table of ['browser_sessions', 'browser_accounts', 'login_attempts']) expect(s.db.prepare('SELECT count(*) n FROM ' + table + ' WHERE token_hash=?').get(hash('fixture-alice'))).toEqual({ n: 0 });
  });
  it('handles provider failures, erased target accounts and consent changes without creating identities', async () => {
    const s = await setup(); const guest = await s.read();
    s.exchange.mockRejectedValueOnce(new Error('secret-upstream-error'));
    await s.verify(guest); expect((await s.status(guest)).status).toBe('failed');
    const verified = await s.verify(guest);
    s.db.prepare("UPDATE login_attempts SET privacy_version='outdated' WHERE id=?").run(verified.attemptId);
    expect((await s.finish(guest, verified.attemptId)).statusCode).toBe(409);
    s.db.prepare("INSERT INTO external_identities VALUES('qq','12345',?,'bob','closed','before')").run(subject);
    s.db.prepare("INSERT INTO privacy_requests VALUES('erase','bob','pending','now','now','')").run();
    const closed = await s.verify(guest); expect((await s.finish(guest, closed.attemptId)).json().code).toBe('ACCOUNT_CLOSED');
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
  });
});
describe('task return paths', () => {
  it('preserves local activity, poll, invite query and hash contexts and rejects external or encoded auth loops', () => {
    for (const value of ['/activities/listen?invite=abc&action=join#roster', '/polls/poll-1?vote=yes', '/me/music?from=%2Factivities%2Flisten', '/']) expect(safeReturnTo(value)).toBe(value);
    for (const value of ['https://evil.example/', '//evil.example', '/\\evil.example', '/%2fevil.example', '/%5cevil.example', '/%0aevil', '/auth/confirm', '/api/v2/session', '/login?again=1', '/%61uth/confirm', '/safe/../login', '/%2561uth/confirm', '/bad%ZZ']) expect(() => safeReturnTo(value)).toThrow();
  });
});
