import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
const cleanups: (() => Promise<void>)[] = []; afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example'; const key = 'synthetic-admin-rescue-' + 'x'.repeat(32); const stamp = '2026-11-17T08:00:00.000Z';
async function setup(path = ':memory:') {
  const db = openDatabase(path); fixture(db); db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'before')").run();
  let clock = new Date(stamp); let credential = hash(key);
  const app = createApp({ db, origin, now: () => clock, adminCredentialHash: () => credential }); await app.ready();
  cleanups.push(async () => { await app.close(); db.close(); });
  async function browser(account = '') {
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie: account ? 'kanban_session=fixture-' + account : '' } });
    const cookie = account ? 'kanban_session=fixture-' + account : String(response.headers['set-cookie']).split(';')[0]!;
    const viewer = response.json(); return { cookie, viewer };
  }
  type Browser = Awaited<ReturnType<typeof browser>>;
  const get = (b: Browser, path: string) => app.inject({ url: '/api/v2' + path, headers: { cookie: b.cookie, 'x-account-scope': b.viewer.scope } });
  const post = (b: Browser, path: string, payload: object, extra: Record<string, string> = {}, remoteAddress = '127.0.0.1') => app.inject({ method: 'POST', url: '/api/v2' + path, remoteAddress, payload, headers: { cookie: b.cookie, origin, 'x-account-scope': b.viewer.scope, 'x-csrf-token': b.viewer.csrf, ...extra } });
  async function command(b: Browser, path: string, payload: object, requestKey = randomUUID(), extra: Record<string, string> = {}) {
    const access = (await get(b, '/admin/session')).json(); return post(b, path, payload, { 'x-admin-csrf': access.adminCsrf, 'idempotency-key': requestKey, ...extra });
  }
  const alice = await browser('alice'); const bob = await browser('bob'); const guest = await browser();
  async function rescue(b = guest) {
    const response = await post(b, '/admin/login', { key, confirm: true }); expect(response.statusCode).toBe(200);
    b.cookie += '; ' + String(response.headers['set-cookie']).split(';')[0]; return b;
  }
  return { app, db, alice, bob, guest, browser, get, post, command, rescue, rotate: (value: string) => { credential = value; }, tick: (value: string) => { clock = new Date(value); } };
}
describe('administrator authority, directory, roles and private metadata', () => {
  it('uses account roles without a rescue key and prevents anonymous/member/forged/stale writes', async () => {
    const s = await setup(); s.rotate('');
    expect((await s.get(s.alice, '/admin/session')).json()).toMatchObject({ authMethod: 'account', currentUserId: 'alice', rescueEnabled: false });
    expect((await s.get(s.guest, '/admin/users')).statusCode).toBe(401); expect((await s.get(s.bob, '/admin/users')).statusCode).toBe(403);
    const data = { isAdmin: true, revision: 0, confirm: true };
    for (const extra of [{ 'x-admin-csrf': 'forged' }, { origin: 'https://evil.test' }, { 'x-account-scope': 'stale' }, { 'x-csrf-token': 'wrong' }] as Record<string, string>[]) expect((await s.command(s.alice, '/admin/users/bob/role', data, randomUUID(), extra)).statusCode).toBeGreaterThanOrEqual(400);
    expect(s.db.prepare("SELECT * FROM user_admin_roles WHERE user_id='bob'").get()).toBeUndefined();
  });
  it('creates independent one-hour HttpOnly rescue sessions, binds to browser scope, rotates and expires immediately', async () => {
    const s = await setup(); const beforeUsers = s.db.prepare('SELECT count(*) n FROM users').get(); const response = await s.post(s.guest, '/admin/login', { key, confirm: true });
    expect(response.statusCode).toBe(200); expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly/); expect(String(response.headers['set-cookie'])).toMatch(/Secure/); expect(String(response.headers['set-cookie'])).toMatch(/Max-Age=3600/);
    s.guest.cookie += '; ' + String(response.headers['set-cookie']).split(';')[0];
    const access = (await s.get(s.guest, '/admin/session')).json(); expect(access).toMatchObject({ authMethod: 'credential', currentUserId: null });
    expect(s.db.prepare('SELECT count(*) n FROM users').get()).toEqual(beforeUsers); expect((await s.get(s.guest, '/session')).json().authenticated).toBe(false);
    expect((await s.post(s.guest, '/admin/registration', { enabled: true, revision: 0, confirm: true }, { 'x-admin-csrf': access.adminCsrf })).statusCode).toBe(200);
    const other = await s.browser(); other.cookie += '; ' + s.guest.cookie.split('; ')[1];
    expect((await s.command(other, '/admin/users/bob/role', { isAdmin: true, revision: 0, confirm: true }, randomUUID(), { 'x-admin-csrf': access.adminCsrf })).statusCode).toBe(403);
    s.rotate(hash(key + '-rotated')); expect((await s.get(s.guest, '/admin/users')).statusCode).toBe(401);
    s.rotate(hash(key)); s.tick('2026-11-17T09:00:00.000Z'); expect((await s.get(s.guest, '/admin/session')).statusCode).toBe(401);
  });
  it('limits credential guesses and rejects missing confirmation before creating any rescue session', async () => {
    const s = await setup();
    for (let attempt = 0; attempt < 6; attempt++) expect((await s.post(s.guest, '/admin/login', { key: key + '-wrong', confirm: true })).statusCode).toBe(401);
    expect((await s.post(s.guest, '/admin/login', { key, confirm: true })).statusCode).toBe(429);
    expect((await s.post(s.guest, '/admin/login', { key }, {}, '127.0.0.2')).statusCode).toBe(400);
    expect(s.db.prepare('SELECT * FROM admin_sessions').all()).toEqual([]);
  });
  it('grants/revokes with immutable history, rechecks every device, rejects ABA CSRF and never replays under a newer grant', async () => {
    const s = await setup(); const rescue = await s.rescue(); const old = (await s.get(s.alice, '/admin/session')).json();
    const input = { isAdmin: true, revision: 0, confirm: true }; const requestKey = randomUUID();
    expect((await s.command(s.alice, '/admin/users/bob/role', input, requestKey)).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/users/bob/role', input, requestKey)).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/users/bob/role', { ...input, isAdmin: false }, requestKey)).statusCode).toBe(409);
    expect((await s.get(s.bob, '/admin/session')).json().authMethod).toBe('account');
    expect((await s.command(s.bob, '/admin/users/bob/role', { isAdmin: false, revision: 1, confirm: true })).json().code).toBe('SELF_REVOCATION');
    expect((await s.command(rescue, '/admin/users/alice/role', { isAdmin: false, revision: 1, confirm: true })).statusCode).toBe(200);
    expect((await s.get(s.alice, '/admin/users')).statusCode).toBe(403);
    expect((await s.command(rescue, '/admin/users/alice/role', { isAdmin: true, revision: 2, confirm: true })).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/users/bob/role', { isAdmin: false, revision: 1, confirm: true }, randomUUID(), { 'x-admin-csrf': old.adminCsrf })).statusCode).toBe(403);
    expect((await s.command(s.alice, '/admin/users/bob/role', input, requestKey)).statusCode).toBe(409); // New grant cannot find old grant's receipt.
    expect(s.db.prepare("SELECT * FROM admin_role_history WHERE user_id='bob'").all()).toHaveLength(1);
    expect(() => s.db.exec('DELETE FROM admin_role_history')).toThrow('append-only');
  });
  it('rolls back role/history/receipt together, rejects closed targets and validates strict booleans/revisions', async () => {
    const s = await setup(); const data = { isAdmin: true, revision: 0, confirm: true };
    for (const patch of [{ isAdmin: 'true' }, { revision: true }, { revision: -1 }, { role: 'admin' }, { confirm: false }]) expect((await s.command(s.alice, '/admin/users/bob/role', { ...data, ...patch })).statusCode).toBe(400);
    s.db.exec("CREATE TRIGGER fail_admin_history BEFORE INSERT ON admin_role_history BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END");
    expect((await s.command(s.alice, '/admin/users/bob/role', data)).statusCode).toBe(500);
    expect(s.db.prepare("SELECT * FROM user_admin_roles WHERE user_id='bob'").get()).toBeUndefined(); expect(s.db.prepare('SELECT * FROM auth_requests').all()).toEqual([]);
    s.db.exec('DROP TRIGGER fail_admin_history'); s.db.prepare("INSERT INTO privacy_requests VALUES('closed','bob','shared_review','before','before','')").run();
    expect((await s.command(s.alice, '/admin/users/bob/role', data)).statusCode).toBe(404);
    expect((await s.get(s.alice, '/admin/users')).json().total).toBe(1);
  });
  it('searches literal names, IDs, external names and metadata; paginates and filters exact provider-bound UnionID without leaking credentials', async () => {
    const s = await setup();
    s.db.prepare("INSERT INTO external_identities VALUES('qq','app-a','same-subject','alice','第三方甲','before')").run();
    s.db.prepare("INSERT INTO external_identities VALUES('qq','app-b','same-subject','bob','第三方乙','before')").run();
    s.db.prepare("INSERT INTO external_unionids VALUES('qq','app-a','same-subject','private-union','before')").run();
    for (let i = 0; i < 23; i++) s.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('extra-' + i, 'unusable-' + i, '分頁會員 ' + i, 'before');
    const first = (await s.get(s.alice, '/admin/users')).json(); const second = (await s.get(s.alice, '/admin/users?offset=20')).json();
    expect(first.total).toBe(25); expect(first.users).toHaveLength(20); expect(second.users).toHaveLength(5);
    expect(new Set([...first.users, ...second.users].map((row: { id: string }) => row.id)).size).toBe(25);
    for (const [filter, expected] of [['bound', 'alice'], ['missing', 'bob']]) {
      const result = await s.get(s.alice, '/admin/users?unionid=' + filter); expect(result.json().users.map((u: { id: string }) => u.id)).toEqual([expected]);
      expect(result.body).not.toMatch(/same-subject|private-union|app-a|token_hash|credential_hash/);
    }
    expect((await s.get(s.alice, '/admin/users?unionid=unbound')).json().total).toBe(23);
    for (const search of ['alice', '第三方甲', '小青']) expect((await s.get(s.alice, '/admin/users?search=' + encodeURIComponent(search))).json().users.map((u: { id: string }) => u.id)).toEqual(['alice']);
    expect((await s.get(s.alice, '/admin/users?search=%25')).json().total).toBe(0);
    for (const query of ['offset=-1', 'offset=nope', 'unionid=invalid', 'search=' + 'a'.repeat(101)]) expect((await s.get(s.alice, '/admin/users?' + query)).statusCode).toBe(400);
  });
  it('keeps metadata separate from identity/roles, detects version/unique QQ conflicts, permits clearing and only stores minimal retry acknowledgements', async () => {
    const s = await setup(); const data = { note: '  後台 <script>\n第二行  ', manualQQ: ' 123456789 ', revision: 0, confirm: true }; const id = randomUUID();
    expect((await s.command(s.alice, '/admin/users/bob/metadata', data, id)).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/users/bob/metadata', data, id)).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/users/bob/role', { isAdmin: true, revision: 0, confirm: true })).statusCode).toBe(200);
    const row = (await s.get(s.alice, '/admin/users/bob')).json(); expect(row).toMatchObject({ note: data.note.trim(), manualQQ: '123456789', metadataRevision: 1, revision: 1 });
    expect((await s.get(s.alice, '/admin/users?search=123456789')).json().total).toBe(1);
    expect((await s.command(s.alice, '/admin/users/alice/metadata', { ...data, revision: 0 })).json().code).toBe('MANUAL_QQ_CONFLICT');
    expect((await s.command(s.alice, '/admin/users/bob/metadata', data)).json().code).toBe('METADATA_CHANGED');
    expect((await s.command(s.alice, '/admin/users/bob/metadata', { note: '', manualQQ: '', revision: 1, confirm: true })).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/users/bob/metadata', data, id)).statusCode).toBe(200); expect((await s.get(s.alice, '/admin/users/bob')).json().note).toBe('');
    for (const patch of [{ note: null }, { note: '字'.repeat(1001) }, { manualQQ: '１２３４５' }, { manualQQ: '012345' }, { manualQQ: 12345 }, { manualQQ: '1234' }, { revision: true }]) expect((await s.command(s.alice, '/admin/users/bob/metadata', { ...data, ...patch })).statusCode).toBe(400);
    expect(s.db.prepare('SELECT * FROM external_identities').all()).toEqual([]);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM auth_requests').all())).not.toContain('第二行');
    expect((await s.get(s.bob, '/session')).body).not.toMatch(/manualQQ|metadataRevision|第二行/);
  });
  it('logs out credential authority without changing member login, but account-admin logout revokes this device grants and both admin methods', async () => {
    const s = await setup(); await s.rescue(s.bob); const memberBefore = (await s.get(s.bob, '/session')).json();
    expect((await s.command(s.bob, '/admin/logout', { confirm: true })).json()).toEqual({ logoutAccount: false });
    expect((await s.get(s.bob, '/session')).json().scope).toBe(memberBefore.scope); expect((await s.get(s.bob, '/admin/session')).statusCode).toBe(401);
    await s.rescue(s.alice); s.db.prepare("INSERT INTO browser_accounts VALUES(?,'bob','before')").run(hash('fixture-alice'));
    expect((await s.get(s.alice, '/admin/session')).json().authMethod).toBe('account');
    expect((await s.command(s.alice, '/admin/logout', { confirm: true })).json()).toEqual({ logoutAccount: true });
    expect((await s.get(s.alice, '/admin/session')).statusCode).toBe(401); expect(s.db.prepare('SELECT * FROM browser_accounts').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM admin_sessions').all()).toEqual([]);
  });
  it('paginates immutable role history without exposing actor credentials and rejects stale account scopes', async () => {
    const s = await setup();
    const insert = s.db.prepare('INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at) VALUES(?,?,?,?,?,?)');
    for (let i = 1; i <= 53; i++) insert.run('bob', i === 53 ? 'credential:private-digest' : i === 52 ? 'account:alice' : 'account_closure', 0, 1, i, stamp);
    const first = await s.get(s.alice, '/admin/users/bob/role-history'); const page = first.json();
    expect(page.history).toHaveLength(50); expect(page.history.slice(0, 3).map((row: { actor: string }) => row.actor)).toEqual(['救援憑證', '小青', '帳號關閉']);
    expect(first.body).not.toMatch(/private-digest|account:alice|actor_ref/);
    const second = (await s.get(s.alice, '/admin/users/bob/role-history?before=' + page.nextCursor)).json();
    expect(second.history).toHaveLength(3); expect(second.nextCursor).toBeNull(); expect(new Set([...page.history, ...second.history].map((row: { id: number }) => row.id)).size).toBe(53);
    s.db.prepare("UPDATE browser_sessions SET user_id='bob' WHERE token_hash=?").run(hash('fixture-alice'));
    expect((await s.get(s.alice, '/admin/session')).statusCode).toBe(409);
    expect((await s.get(s.alice, '/admin/users/bob/role-history')).statusCode).toBe(409);
  });
  it('protects privacy review, validates explicit notes/confirmation and completes only requests without retained records', async () => {
    const s = await setup();
    expect((await s.get(s.guest, '/admin/privacy')).statusCode).toBe(401); expect((await s.get(s.bob, '/admin/privacy')).statusCode).toBe(403);
    s.db.prepare("INSERT INTO users VALUES('clean','unusable-clean','已注销用户','before')").run();
    s.db.prepare("INSERT INTO privacy_requests VALUES('clean-request','clean','shared_review','before','before','')").run();
    const before = (await s.get(s.alice, '/admin/privacy/clean-request')).json(); const input = { note: ' 已核對保留範圍 ', revision: before.revision, confirm: true };
    for (const patch of [{ note: '' }, { note: '字'.repeat(1001) }, { status: 'completed' }, { confirm: false }, { revision: 'wrong' }]) expect((await s.command(s.alice, '/admin/privacy/clean-request/review', { ...input, ...patch })).statusCode).toBe(400);
    expect((await s.command(s.alice, '/admin/privacy/clean-request/review', input, randomUUID(), { 'x-admin-csrf': 'forged' })).statusCode).toBe(403);
    const key = randomUUID(); expect((await s.command(s.alice, '/admin/privacy/clean-request/review', input, key)).statusCode).toBe(200);
    const result = (await s.get(s.alice, '/admin/privacy/clean-request')).json(); expect(result).toMatchObject({ note: input.note.trim(), status: 'completed', sharedRecords: {} }); expect(result.revision).not.toBe(before.revision);
    expect((await s.command(s.alice, '/admin/privacy/clean-request/review', input, key)).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/privacy/clean-request/review', { ...input, note: '其他說明' }, key)).statusCode).toBe(409);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM auth_requests').all())).not.toContain('已核對保留範圍');
  });
  it('computes actual shared privacy status, detects live-reference/other-admin changes and cannot claim deletion by writing a note', async () => {
    const s = await setup(); nicknameFixture(s.db); s.db.prepare("INSERT INTO privacy_requests VALUES('bob-request','bob','completed','before','before','原說明')").run();
    const before = (await s.get(s.alice, '/admin/privacy/bob-request')).json(); expect(before.status).toBe('shared_review'); expect(Object.keys(before.sharedRecords).length).toBeGreaterThan(0);
    const input = { note: '仍保留共享資料，等待審核', revision: before.revision, confirm: true }; const key = randomUUID();
    s.db.prepare("INSERT INTO account_audit(user_id,action,details_json,created_at) VALUES('bob','synthetic','{}','before')").run();
    expect((await s.command(s.alice, '/admin/privacy/bob-request/review', input, key)).json().code).toBe('PRIVACY_REVIEW_CHANGED'); expect(s.db.prepare('SELECT * FROM auth_requests').all()).toEqual([]);
    const current = (await s.get(s.alice, '/admin/privacy/bob-request')).json();
    expect((await s.command(s.alice, '/admin/privacy/bob-request/review', { ...input, revision: current.revision }, key)).statusCode).toBe(200);
    expect((await s.get(s.alice, '/admin/privacy/bob-request')).json()).toMatchObject({ note: input.note, status: 'shared_review', sharedRecords: { account_audit: 1 } });
    expect((await s.command(s.alice, '/admin/privacy/bob-request/review', { ...input, revision: current.revision })).statusCode).toBe(409);
    expect(s.db.prepare('SELECT count(*) n FROM account_audit').get()).toEqual({ n: 1 }); expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('keeps a request under review when its only retained reference is a bot delivery recipient', async () => {
    const s = await setup(); s.db.prepare("INSERT INTO privacy_requests VALUES('bob-request','bob','completed','before','before','')").run();
    s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,recipient_user_id,created_at) VALUES('listen','synthetic','privacy-check','private','synthetic-target','{}','sent','bob','before')").run();
    const before = (await s.get(s.alice, '/admin/privacy/bob-request')).json(); expect(before).toMatchObject({ status: 'shared_review', sharedRecords: { bot_outbox: 1 } });
    const original = s.db.prepare('SELECT * FROM bot_outbox').all();
    expect((await s.command(s.alice, '/admin/privacy/bob-request/review', { note: '待核對私人投遞紀錄', revision: before.revision, confirm: true })).statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(original); expect((await s.get(s.alice, '/admin/privacy/bob-request')).json().status).toBe('shared_review');
  });
  it('rolls privacy review and its minimal receipt back together, checks current authority before receipt replay', async () => {
    const s = await setup(); s.db.prepare("INSERT INTO privacy_requests VALUES('bob-request','bob','shared_review','before','before','')").run();
    const before = (await s.get(s.alice, '/admin/privacy/bob-request')).json(); const input = { note: '原操作的說明', revision: before.revision, confirm: true }; const key = randomUUID();
    s.db.exec("CREATE TRIGGER fail_admin_receipt BEFORE INSERT ON auth_requests BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    expect((await s.command(s.alice, '/admin/privacy/bob-request/review', input, key)).statusCode).toBe(500);
    expect((await s.get(s.alice, '/admin/privacy/bob-request')).json()).toEqual(before);
    s.db.exec('DROP TRIGGER fail_admin_receipt'); expect((await s.command(s.alice, '/admin/privacy/bob-request/review', input, key)).statusCode).toBe(200);
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run();
    expect((await s.post(s.alice, '/admin/privacy/bob-request/review', input, { 'x-admin-csrf': 'old', 'idempotency-key': key })).statusCode).toBe(403);
  });
  it('paginates all privacy requests without truncating the original hundred-entry queue or disclosing identity fields', async () => {
    const s = await setup();
    for (let i = 0; i < 101; i++) {
      s.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('closed-' + i, 'unusable-' + i, '已注销用户', 'before');
      s.db.prepare('INSERT INTO privacy_requests VALUES(?,?,?,?,?,?)').run('request-' + String(i).padStart(3, '0'), 'closed-' + i, 'completed', 'before', 'before', '');
    }
    const first = await s.get(s.alice, '/admin/privacy'); expect(first.json()).toMatchObject({ total: 101, limit: 20, offset: 0 }); expect(first.json().requests).toHaveLength(20);
    expect((await s.get(s.alice, '/admin/privacy?offset=100')).json().requests).toHaveLength(1); expect(first.body).not.toMatch(/token_hash|credential|subject|unusable-/);
    for (const path of ['/admin/privacy?offset=-1', '/admin/privacy?offset=nope', '/admin/privacy?extra=1']) expect((await s.get(s.alice, path)).statusCode).toBe(400);
    expect((await s.get(s.alice, '/admin/privacy/missing')).statusCode).toBe(404);
  });
  it('matches original Python privacy-review outcomes and leaves shared history, bot and finance unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-privacy-review-diff-')); const s = await setup(join(dir, 'new.sqlite3')); nicknameFixture(s.db);
    s.db.prepare("INSERT INTO privacy_requests VALUES('bob-request','bob','shared_review','before','before','')").run(); const old = join(dir, 'old.sqlite3'); await s.db.backup(old);
    const tables = ['events', 'attendees', 'event_audit', 'finance_entries', 'settlement_history', 'bot_outbox', 'bot_settings', 'users']; const unchanged = tables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    const before = (await s.get(s.alice, '/admin/privacy/bob-request')).json();
    expect((await s.command(s.alice, '/admin/privacy/bob-request/review', { note: '核對共享紀錄', revision: before.revision, confirm: true })).statusCode).toBe(200);
    execFileSync('python3', ['-c', `import sqlite3,sys
from qgroup_core import privacy
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
privacy.now=lambda:sys.argv[2]
with db: privacy.review(db,dict(request_id='bob-request',note='核對共享紀錄'))
db.close()`, old, stamp]);
    const baseline = openDatabase(old); try { expect(s.db.prepare('SELECT * FROM privacy_requests').all()).toEqual(baseline.prepare('SELECT * FROM privacy_requests').all()); } finally { baseline.close(); }
    expect(tables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(unchanged);
    cleanups.unshift(async () => { rmSync(dir, { recursive: true, force: true }); });
  });
  it('matches original role/metadata writes and preserves bot settings/outbox, finance and identity data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-admin-diff-')); const path = join(dir, 'new.sqlite3');
    const s = await setup(path); nicknameFixture(s.db); const old = join(dir, 'old.sqlite3'); await s.db.backup(old);
    const before = ['bot_settings', 'bot_outbox', 'finance_entries', 'attendees', 'settlements'].map(table => s.db.prepare('SELECT * FROM ' + table).all());
    const metadata = { note: '人工核對\n保留原文', manualQQ: '123456789', revision: 0, confirm: true };
    expect((await s.command(s.alice, '/admin/users/bob/role', { isAdmin: true, revision: 0, confirm: true })).statusCode).toBe(200);
    expect((await s.command(s.alice, '/admin/users/bob/metadata', metadata)).statusCode).toBe(200);
    execFileSync('python3', ['-c', `import sqlite3,sys\nfrom qgroup_core import admin\ndb=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')\nadmin.now=lambda:sys.argv[2]\naccess=dict(user_id='alice',digest='unused')\nwith db:\n admin.set_role(db,access,dict(user_id='bob',is_admin=True,base_revision=0))\n admin.set_metadata(db,access,dict(user_id='bob',note='人工核對\\n保留原文',manual_qq='123456789',base_revision=0))\ndb.close()`, old, stamp]);
    const baseline = openDatabase(old);
    try { for (const table of ['user_admin_roles', 'admin_role_history', 'admin_user_metadata', 'external_identities', 'external_unionids']) expect(s.db.prepare('SELECT * FROM ' + table).all(), table).toEqual(baseline.prepare('SELECT * FROM ' + table).all()); }
    finally { baseline.close(); }
    expect(['bot_settings', 'bot_outbox', 'finance_entries', 'attendees', 'settlements'].map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
    cleanups.unshift(async () => { rmSync(dir, { recursive: true, force: true }); });
  });
});
