import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { PRIVACY_VERSION, type Viewer } from '@qgroup/contracts';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';

const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example';
const payload = { nickname: '新稱呼', confirm: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION, returnTo: '/activities/listen?invite=synthetic#roster' };
async function setup() {
  const db = openDatabase(':memory:'); fixture(db);
  db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'before')").run();
  const app = createApp({ db, origin }); await app.ready();
  resources.push(async () => { await app.close(); db.close(); });
  async function read(cookie = '') {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie } });
    return { cookie: String(response.headers['set-cookie'] ?? cookie).split(';')[0]!, viewer: response.json<Viewer>() };
  }
  const admin = await read('kanban_session=fixture-alice'); const guest = await read();
  const post = (browser: typeof guest, url: string, data: object, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/v2' + url, headers: { cookie: browser.cookie, origin, 'x-account-scope': browser.viewer.scope, 'x-csrf-token': browser.viewer.csrf, ...extra }, payload: data });
  const settings = (browser = admin) => app.inject({ url: '/api/v2/admin/registration', headers: { cookie: browser.cookie, 'x-account-scope': browser.viewer.scope } });
  async function change(enabled: boolean) {
    const before = (await settings()).json();
    return post(admin, '/admin/registration', { enabled, revision: before.revision, confirm: true }, { 'x-admin-csrf': before.adminCsrf });
  }
  return { db, app, read, admin, guest, post, settings, change };
}
describe('name registration and account administrator settings', () => {
  it('defaults closed and rejects forged settings, roles and privacy flags', async () => {
    const s = await setup(); expect(s.guest.viewer).toMatchObject({ nameRegistrationEnabled: false });
    expect((await s.post(s.guest, '/auth/register-name', payload)).statusCode).toBe(403);
    expect((await s.settings(s.guest)).statusCode).toBe(401);
    const member = await s.read('kanban_session=fixture-bob');
    expect((await s.settings(member)).statusCode).toBe(403);
    expect((await s.post(member, '/admin/registration', { enabled: true, revision: 0, confirm: true })).statusCode).toBe(403);
    expect((await s.post(s.admin, '/admin/registration', { enabled: true, revision: 0, confirm: true }, { 'x-admin-csrf': 'forged' })).statusCode).toBe(403);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    expect(s.db.prepare('SELECT allow_name_registration FROM site_settings').get()).toEqual({ allow_name_registration: 0 });
  });
  it('checks consent, codepoint limits, strict input, origin and CSRF before writing anything', async () => {
    const s = await setup(); await s.change(true);
    for (const invalid of [{ acceptPrivacy: false }, { confirm: false }, { privacyVersion: 'old' }, { nickname: '😀'.repeat(25) }, { is_admin: true }, { nickname: 'a\nb' }]) {
      expect((await s.post(s.guest, '/auth/register-name', { ...payload, ...invalid })).statusCode).toBe(400);
    }
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
  });
  it('rejects stale scope, cross-site and missing CSRF registration and unsafe returns', async () => {
    const s = await setup(); await s.change(true);
    for (const extra of [{ origin: 'https://evil.example' }, { 'x-csrf-token': '' }, { 'x-account-scope': 'stale' }] as Record<string, string>[]) expect((await s.post(s.guest, '/auth/register-name', payload, extra)).statusCode).toBeGreaterThanOrEqual(400);
    for (const returnTo of ['//evil.example', '/%2f%2fevil.example', '/auth/qq/callback']) expect((await s.post(s.guest, '/auth/register-name', { ...payload, returnTo })).statusCode).toBe(400);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
  });
  it('creates exactly one independent account, rotates the visitor, preserves return and records consent atomically', async () => {
    const s = await setup(); await s.change(true);
    s.db.prepare("INSERT INTO login_attempts(id,token_hash,provider,app_id,mode,status,expires_at,created_at) VALUES('synthetic',?,'qq','test','login','pending','2999','before')").run(hash(s.guest.cookie.split('=')[1]!));
    const result = await s.post(s.guest, '/auth/register-name', { ...payload, nickname: '  ' + '😀'.repeat(24) + '  ' });
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ newAccount: true, returnTo: payload.returnTo });
    expect(String(result.headers['set-cookie'])).toContain('HttpOnly'); expect(String(result.headers['set-cookie'])).toContain('Secure');
    const member = await s.read(String(result.headers['set-cookie']).split(';')[0]);
    expect(member.viewer).toMatchObject({ authenticated: true, nickname: '😀'.repeat(24), administrator: false, privacyAccepted: true, qq: { bound: false } });
    expect(member.viewer.scope).not.toBe(s.guest.viewer.scope);
    expect(s.db.prepare('SELECT count(*) n FROM privacy_consents WHERE version=?').get(PRIVACY_VERSION)).toEqual({ n: 1 });
    expect(s.db.prepare("SELECT count(*) n FROM account_audit WHERE action='name_registered'").get()).toEqual({ n: 1 });
    expect(s.db.prepare('SELECT count(*) n FROM browser_accounts').get()).toEqual({ n: 1 });
    expect(s.db.prepare('SELECT status FROM login_attempts').get()).toEqual({ status: 'failed' });
    expect((await s.post(s.guest, '/auth/register-name', payload)).statusCode).toBe(401);
    expect((await s.post(member, '/auth/register-name', payload)).statusCode).toBe(409);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 3 });
    await s.change(false);
    expect((await s.read(member.cookie)).viewer).toMatchObject({ authenticated: true, nameRegistrationEnabled: false });
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('never uses nicknames to find or merge an existing account and serializes competing registration', async () => {
    const s = await setup(); await s.change(true);
    const otherGuest = await s.read();
    const results = await Promise.all([s.post(s.guest, '/auth/register-name', { ...payload, nickname: '小青' }), s.post(s.guest, '/auth/register-name', { ...payload, nickname: '小青' })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 401]);
    expect((await s.post(otherGuest, '/auth/register-name', { ...payload, nickname: '小青' })).statusCode).toBe(200);
    expect(s.db.prepare("SELECT count(*) n FROM users WHERE nickname='小青'").get()).toEqual({ n: 3 });
  });
  it('checks current switch and role revision, rejects stale setting pages and audits only actual changes', async () => {
    const s = await setup(); const initial = (await s.settings()).json();
    const command = (revision: number, extra: Record<string, string> = {}) => s.post(s.admin, '/admin/registration', { enabled: true, revision, confirm: true }, { 'x-admin-csrf': initial.adminCsrf, ...extra });
    expect((await command(0, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await command(0, { 'x-csrf-token': '' })).statusCode).toBe(403);
    expect((await command(0)).json()).toMatchObject({ enabled: true, revision: 1 });
    expect((await command(0)).statusCode).toBe(409);
    expect((await command(1)).json()).toMatchObject({ enabled: true, revision: 1 });
    expect(s.db.prepare('SELECT count(*) n FROM admin_audit').get()).toEqual({ n: 1 });
    s.db.prepare("UPDATE user_admin_roles SET revision=2 WHERE user_id='alice'").run();
    expect((await command(1)).statusCode).toBe(403);
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0 WHERE user_id='alice'").run();
    expect((await s.settings()).statusCode).toBe(403); expect((await command(1)).statusCode).toBe(403);
    s.db.prepare("UPDATE browser_sessions SET user_id='bob' WHERE token_hash=?").run(hash('fixture-alice'));
    expect((await command(1)).statusCode).toBe(409);
  });
  it('rolls back settings and registration if their append-only audit cannot be written', async () => {
    const s = await setup();
    s.db.exec("CREATE TRIGGER reject_settings BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect((await s.change(true)).statusCode).toBe(500);
    expect((await s.settings()).json()).toMatchObject({ enabled: false, revision: 0 });
    s.db.exec('DROP TRIGGER reject_settings'); await s.change(true);
    s.db.exec("CREATE TRIGGER reject_registration BEFORE INSERT ON account_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const failed = await s.post(s.guest, '/auth/register-name', payload);
    expect(failed.statusCode).toBe(500); expect(failed.headers['set-cookie']).toBeUndefined();
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    expect(s.db.prepare('SELECT count(*) n FROM privacy_consents').get()).toEqual({ n: 0 });
    expect((await s.read(s.guest.cookie)).viewer.authenticated).toBe(false);
  });
  it('rechecks a newly closed setting and rate limits repeated creation attempts', async () => {
    const s = await setup(); await s.change(true);
    expect((await s.read(s.guest.cookie)).viewer.nameRegistrationEnabled).toBe(true);
    await s.change(false);
    for (let i = 0; i < 6; i++) expect((await s.post(s.guest, '/auth/register-name', payload)).statusCode).toBe(403);
    expect((await s.post(s.guest, '/auth/register-name', payload)).statusCode).toBe(429);
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
  });
  it('enforces the existing QQ and device limits as well as the global limit after plugin registration', async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) expect((await s.post(s.guest, '/auth/qq/start', {})).statusCode).toBe(503);
    const qqLimit = await s.post(s.guest, '/auth/qq/start', {});
    expect(qqLimit.statusCode).toBe(429); expect(qqLimit.headers['x-ratelimit-limit']).toBe('12');
    for (let i = 0; i < 6; i++) expect((await s.post(s.admin, '/me/devices/link', { confirm: true, authorizeOwnDevice: true })).statusCode).toBe(200);
    expect((await s.post(s.admin, '/me/devices/link', { confirm: true, authorizeOwnDevice: true })).statusCode).toBe(429);
    for (let i = 0; i < 180; i++) expect((await s.app.inject({ url: '/api/v2/health', remoteAddress: '192.0.2.200' })).statusCode).toBe(200);
    expect((await s.app.inject({ url: '/api/v2/health', remoteAddress: '192.0.2.200' })).statusCode).toBe(429);
  });
});
