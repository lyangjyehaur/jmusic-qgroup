import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { erasureJournal, type ErasureIntent, type ErasureJournal, type StoredIntent } from './erasure-journal';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example'; const stamp = '2026-11-17T08:00:00.000Z';
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'qgroup-privacy-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
async function setup(options: { path?: string; journal?: ErasureJournal; seed?: (db: DB) => void } = {}) {
  const db = openDatabase(options.path ?? ':memory:'); fixture(db); options.seed?.(db);
  const app = createApp({ db, origin, now: () => new Date(stamp), ...(options.journal ? { erasureJournal: options.journal } : {}) }); await app.ready();
  cleanup.push(async () => { await app.close(); db.close(); });
  async function headers(account = 'bob') {
    const cookie = 'kanban_session=fixture-' + account;
    const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  }
  const auth = await headers();
  const get = (url: string, extra = {}) => app.inject({ url: '/api/v2' + url, headers: { ...auth, ...extra } });
  const post = (url: string, payload: object, extra = {}, remoteAddress = '127.0.0.1') => app.inject({ remoteAddress, method: 'POST', url: '/api/v2' + url, headers: { ...auth, ...extra }, payload });
  const body = { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'main-0', level: 3 }] };
  const saveKey = randomUUID();
  const save = (payload: object = body, key = saveKey) => app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...auth, 'idempotency-key': key }, payload });
  async function input(target: 'music' | 'account' | 'both' = 'music') {
    const profile = (await get('/me/music')).json();
    return { requestId: randomUUID(), secret: 'ab'.repeat(32), target, confirm: true, profileId: profile?.id ?? null, profileRevision: profile?.revision ?? 0 };
  }
  return { db, app, auth, headers, post, get, save, body, saveKey, input };
}
describe('separate account and music erasure with durable recovery', () => {
  it('erases music and old receipts, keeps account/bot/history, rejects stale drafts and recreates with a fresh ID', async () => {
    const s = await setup({ seed: nicknameFixture }); const first = (await s.save()).json();
    const frozenTables = ['users', 'events', 'attendees', 'finance_entries', 'settlements', 'bot_outbox', 'bot_settings'];
    const frozen = frozenTables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    expect(() => s.db.prepare('DELETE FROM music_profile_audit').run()).toThrow('append-only');
    const input = await s.input();
    const result = await s.post('/me/privacy/erase', input); expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ requestId: input.requestId, target: 'music', status: 'completed' });
    expect(frozenTables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(frozen);
    expect((await s.get('/me/music')).json()).toBeNull();
    expect((await s.get('/session')).json()).toMatchObject({ authenticated: true, musicEpoch: 1 });
    expect(s.db.prepare('SELECT * FROM music_selections').all()).toEqual([]); expect(s.db.prepare('SELECT * FROM music_profile_audit').all()).toEqual([]);
    expect(s.db.prepare('SELECT id,user_id,erased_at FROM music_profiles').get()).toEqual({ id: first.id, user_id: null, erased_at: stamp });
    expect((await s.save()).statusCode).toBe(410); expect((await s.save()).body).not.toContain('main-0');
    expect((await s.save({ ...s.body }, randomUUID())).json().code).toBe('PROFILE_ERASED');
    const next = await s.save({ ...s.body, musicEpoch: 1 }, randomUUID()); expect(next.statusCode).toBe(200); expect(next.json().id).not.toBe(first.id);
    const stale = await s.save({ ...s.body, profileId: first.id, revision: 1, musicEpoch: 1 }, randomUUID()); expect(stale.statusCode).toBe(409);
    expect((await s.post('/me/privacy/erase', input)).json()).toEqual(result.json());
    expect((await s.get('/me/music')).json().id).toBe(next.json().id); // Old deletion receipt never deletes a later profile.
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('closes only the account, detaches music, revokes identities/roles/devices, preserves shared records and returns a minimal secret-protected receipt', async () => {
    const s = await setup({ seed: nicknameFixture }); const first = (await s.save()).json();
    s.db.prepare("INSERT INTO external_identities VALUES('qq','synthetic','private-subject','bob','私人 QQ 名','before')").run();
    s.db.prepare("INSERT INTO external_unionids VALUES('qq','synthetic','private-subject','private-union','before')").run();
    s.db.prepare("INSERT INTO user_admin_roles VALUES('bob',1,7,'before')").run();
    s.db.prepare("INSERT INTO browser_sessions VALUES(?,'bob','before')").run(hash('other-device'));
    const frozenTables = ['events', 'attendees', 'finance_entries', 'settlements', 'event_audit', 'bot_outbox'];
    const before = frozenTables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    const musicBefore = s.db.prepare('SELECT * FROM music_profile_audit').all();
    const input = await s.input('account'); const response = await s.post('/me/privacy/erase', input);
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe('shared_review');
    expect(response.body).not.toMatch(/bob|private-|小白|main-0|secret|shared_records/);
    expect(frozenTables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
    expect(s.db.prepare('SELECT * FROM music_profile_audit').all()).toEqual(musicBefore);
    expect(s.db.prepare('SELECT id,user_id,erased_at FROM music_profiles').get()).toEqual({ id: first.id, user_id: null, erased_at: null });
    for (const table of ['external_identities', 'external_unionids', 'browser_sessions', 'browser_accounts', 'request_results']) expect(s.db.prepare('SELECT * FROM ' + table).all().filter((r: unknown) => JSON.stringify(r).includes('bob'))).toEqual([]);
    expect(s.db.prepare("SELECT is_admin,revision FROM user_admin_roles WHERE user_id='bob'").get()).toEqual({ is_admin: 0, revision: 8 });
    expect(s.db.prepare("SELECT actor_ref,after_value FROM admin_role_history WHERE user_id='bob'").get()).toEqual({ actor_ref: 'account_closure', after_value: 0 });
    expect((await s.save()).statusCode).toBe(401); expect((await s.get('/me/music')).statusCode).toBe(401);
    const proof = { requestId: input.requestId, secret: input.secret };
    expect((await s.post('/privacy/receipt', proof, { cookie: '' })).json()).toEqual(response.json());
    expect((await s.post('/privacy/receipt', { ...proof, secret: 'cd'.repeat(32) })).statusCode).toBe(404);
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('can close a clean account as completed or explicitly erase account and music together', async () => {
    const clean = await setup(); const close = await clean.post('/me/privacy/erase', await clean.input('account')); expect(close.json().status).toBe('completed');
    const both = await setup(); await both.save(); const erased = await both.post('/me/privacy/erase', await both.input('both'));
    expect(erased.statusCode).toBe(200); expect(erased.json().status).toBe('completed');
    expect(both.db.prepare('SELECT * FROM music_profile_audit').all()).toEqual([]);
    expect(both.db.prepare('SELECT user_id,erased_at FROM music_profiles').get()).toEqual({ user_id: null, erased_at: stamp });
  });
  it('removes private payment images after commit while preserving shared references and avoiding symlink traversal', async () => {
    const dir = temporary(); const path = join(dir, 'state.sqlite3');
    const privateDigest = 'a1'.repeat(32); const sharedDigest = 'b2'.repeat(32);
    const s = await setup({ path, seed(db) {
      for (const digest of [privateDigest, sharedDigest]) {
        const folder = join(dir, 'images', digest.slice(0, 2)); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, digest + '.png'), 'synthetic image');
        db.prepare("INSERT INTO image_assets VALUES(?,15,'image/png','before')").run(digest);
      }
      db.prepare("INSERT INTO user_payment_codes VALUES('private','bob','wechat','private',?,'before',NULL)").run(privateDigest);
      db.prepare("INSERT INTO user_payment_codes VALUES('shared-owner','bob','wechat','shared',?,'before',NULL)").run(sharedDigest);
      db.prepare("INSERT INTO user_payment_codes VALUES('shared-other','alice','wechat','shared',?,'before',NULL)").run(sharedDigest);
      const outside = join(dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'cc'.repeat(32) + '.png'), 'untouched'); symlinkSync(outside, join(dir, 'images', 'cc'));
    } });
    const input = await s.input('account'); expect((await s.post('/me/privacy/erase', input)).statusCode).toBe(200);
    expect(existsSync(join(dir, 'images', 'a1', privateDigest + '.png'))).toBe(false);
    expect(readFileSync(join(dir, 'images', 'b2', sharedDigest + '.png'), 'utf8')).toBe('synthetic image');
    expect(readFileSync(join(dir, 'outside', 'cc'.repeat(32) + '.png'), 'utf8')).toBe('untouched');
    expect(s.db.prepare('SELECT digest FROM image_assets').all()).toEqual([{ digest: sharedDigest }]);
  });
  it('removes ballots, increments only live vote revisions and keeps immutable poll history/outbox', async () => {
    const s = await setup();
    for (const status of ['open', 'closed', 'decided']) {
      s.db.prepare(`INSERT INTO time_polls(id,owner_id,title,category,location,description,timezone,duration_hours,capacity,minimum_participants,fee_policy,deadline,status,created_at)
        VALUES(?,'alice','投票','聚會','測試','','Asia/Taipei',2,0,0,'','2099-01-01',?,'before')`).run(status, status);
      s.db.prepare("INSERT INTO time_poll_options VALUES(?,?,0,'2099-01-01')").run('option-' + status, status);
      s.db.prepare("INSERT INTO time_poll_ballots VALUES(?,'bob','before')").run(status);
      s.db.prepare("INSERT INTO time_poll_votes VALUES(?,'bob',?,'yes')").run(status, 'option-' + status);
    }
    expect((await s.post('/me/privacy/erase', await s.input('account'))).statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM time_poll_votes').all()).toEqual([]); expect(s.db.prepare('SELECT * FROM time_poll_ballots').all()).toEqual([]);
    expect(s.db.prepare('SELECT status,vote_revision FROM time_polls ORDER BY status').all()).toEqual([{ status: 'closed', vote_revision: 1 }, { status: 'decided', vote_revision: 0 }, { status: 'open', vote_revision: 1 }]);
  });
  it('validates consent, origin, scope, profile CAS, and active work before writing any durable intent', async () => {
    const entries: StoredIntent[] = []; const s = await setup({ journal: { read: () => entries, append: entry => { entries.push(entry); } } });
    await s.save(); const input = await s.input();
    let ip = 10;
    for (const patch of [{ confirm: false }, { profileRevision: 0 }, { profileId: 'other-profile' }, { target: 'unknown' }, { userId: 'alice' }]) expect((await s.post('/me/privacy/erase', { ...input, ...patch }, {}, '127.0.0.' + ip++)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await s.post('/me/privacy/erase', input, { origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await s.post('/me/privacy/erase', input, { 'x-account-scope': 'wrong' })).statusCode).toBe(409);
    const alice = await s.headers('alice');
    expect((await s.post('/me/privacy/erase', { ...input, target: 'account', profileId: null, profileRevision: 0 }, alice)).json().code).toBe('ACTIVE_EVENTS');
    s.db.prepare("INSERT INTO time_polls(id,owner_id,title,category,location,timezone,deadline,duration_hours,description,capacity,minimum_participants,fee_policy,status,created_at) VALUES('owned','bob','投票','聚會','測試','Asia/Taipei','2099-01-01',2,'合成投票',0,0,'','closed','before')").run();
    expect((await s.post('/me/privacy/erase', { ...input, target: 'account' })).json().code).toBe('ACTIVE_POLLS');
    expect(entries).toEqual([]); expect((await s.get('/session')).json().authenticated).toBe(true);
  });
  it('replays a durable intent after transactional failure before any next request; persistent failure blocks reads', async () => {
    const s = await setup(); await s.save(); const input = await s.input('both');
    s.db.exec("CREATE TRIGGER reject_closure BEFORE INSERT ON privacy_requests BEGIN SELECT RAISE(ABORT,'synthetic closure failure'); END");
    expect((await s.post('/me/privacy/erase', input)).statusCode).toBe(500);
    expect(s.db.prepare('SELECT * FROM music_selections').all()).toHaveLength(1); // Both erasures rolled back together.
    expect(s.db.prepare('SELECT * FROM music_account_epochs').all()).toEqual([]);
    expect((await s.get('/session')).statusCode).toBe(503); expect((await s.get('/health')).statusCode).toBe(503);
    s.db.exec('DROP TRIGGER reject_closure');
    expect((await s.get('/session')).json().authenticated).toBe(false);
    expect((await s.post('/privacy/receipt', { requestId: input.requestId, secret: input.secret })).json().status).toBe('completed');
    expect(s.db.prepare('SELECT * FROM music_selections').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM music_account_epochs').all()).toEqual([{ user_id: 'bob', epoch: 1 }]);
  });
  it('fails closed when journal durability is uncertain without applying the database erasure', async () => {
    const s = await setup({ journal: { read: () => [], append: () => { throw new Error('synthetic fsync failure'); } } });
    const result = await s.post('/me/privacy/erase', await s.input('account')); expect(result.statusCode).toBe(500); expect(result.body).not.toContain('fsync');
    expect(s.db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({ nickname: '小白' });
    expect((await s.get('/session')).statusCode).toBe(503);
  });
  it('limits repeated erasure attempts without accepting an invalid intent', async () => {
    const entries: StoredIntent[] = []; const s = await setup({ journal: { read: () => entries, append: entry => { entries.push(entry); } } });
    const input = { ...await s.input('account'), confirm: false };
    for (let attempt = 0; attempt < 6; attempt++) expect((await s.post('/me/privacy/erase', input)).statusCode).toBe(400);
    expect((await s.post('/me/privacy/erase', input)).statusCode).toBe(429); expect(entries).toEqual([]);
  });
  it('retains the independent fsynced ledger across database restore, replays idempotently and refuses corrupt startup', async () => {
    const dir = temporary(); const path = join(dir, 'state.sqlite3'); const s = await setup({ path }); await s.save();
    const backup = join(dir, 'before.sqlite3'); await s.db.backup(backup);
    const input = await s.input('both'); expect((await s.post('/me/privacy/erase', input)).statusCode).toBe(200);
    const ledger = join(dir, 'state.erasures.jsonl'); const contents = readFileSync(ledger, 'utf8');
    expect(statSync(ledger).mode & 0o777).toBe(0o600); expect(contents).not.toMatch(/小白|main-0|fixture-bob/); expect(contents).not.toContain(input.secret);
    const restoredPath = join(dir, 'restored.sqlite3'); copyFileSync(backup, restoredPath); copyFileSync(ledger, join(dir, 'restored.erasures.jsonl'));
    const restored = openDatabase(restoredPath); cleanup.push(() => { restored.close(); });
    for (let run = 0; run < 2; run++) {
      const app = createApp({ db: restored, origin }); await app.ready();
      expect((await app.inject({ url: '/api/v2/me/music', headers: s.auth })).statusCode).toBe(401);
      expect(restored.prepare('SELECT * FROM music_profile_audit').all()).toEqual([]); expect(restored.pragma('foreign_key_check')).toEqual([]);
      expect(restored.prepare('SELECT epoch FROM music_account_epochs').get()).toEqual({ epoch: 1 }); await app.close();
    }
    const conflicting = { ...JSON.parse(contents), signature: hash('different-intent') };
    writeFileSync(join(dir, 'restored.erasures.jsonl'), contents + JSON.stringify(conflicting) + '\n');
    expect(() => createApp({ db: restored, origin })).toThrow('Conflicting erasure journal intent');
    writeFileSync(join(dir, 'restored.erasures.jsonl'), contents.trimEnd());
    expect(() => createApp({ db: restored, origin })).toThrow('Incomplete erasure journal line');
    writeFileSync(join(dir, 'restored.erasures.jsonl'), contents + '{partial');
    expect(() => createApp({ db: restored, origin })).toThrow();
  });
  it('accepts legacy account-only deletion entries without erasing music or duplicating review/role history', async () => {
    const dir = temporary(); const path = join(dir, 'legacy.sqlite3'); const s = await setup({ path }); const first = (await s.save()).json();
    writeFileSync(join(dir, 'legacy.erasures.jsonl'), JSON.stringify({ user_id: 'bob', request_id: 'legacy-request', created_at: stamp }) + '\n');
    const next = createApp({ db: s.db, origin }); await next.ready();
    expect((await next.inject({ url: '/api/v2/me/music', headers: s.auth })).statusCode).toBe(401);
    expect(s.db.prepare('SELECT id,user_id,erased_at FROM music_profiles').get()).toEqual({ id: first.id, user_id: null, erased_at: null });
    expect(s.db.prepare('SELECT * FROM music_profile_audit').all()).toHaveLength(1);
    expect(s.db.prepare('SELECT id,status FROM privacy_requests').get()).toEqual({ id: 'legacy-request', status: 'shared_review' }); await next.close();
  });
  it('matches the original Python closure on frozen shared/bot/session/identity data', async () => {
    const dir = temporary(); const path = join(dir, 'new.sqlite3'); const s = await setup({ path, seed: nicknameFixture });
    s.db.prepare("INSERT INTO user_admin_roles VALUES('bob',1,4,'before')").run();
    s.db.prepare("INSERT INTO external_identities VALUES('qq','synthetic','private-subject','bob','private-name','before')").run();
    s.db.prepare("INSERT INTO external_unionids VALUES('qq','synthetic','private-subject','private-union','before')").run();
    const old = join(dir, 'old.sqlite3'); await s.db.backup(old);
    const input = await s.input('account'); const result = await s.post('/me/privacy/erase', input); expect(result.statusCode).toBe(200);
    execFileSync('python3', ['-c', `import sqlite3,sys\nfrom qgroup_core import privacy\ndb=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')\nprivacy.now=lambda:sys.argv[3]\nwith db: privacy.erase(db,'bob',sys.argv[2],sys.argv[3])\ndb.close()`, old, input.requestId, stamp]);
    const baseline = openDatabase(old); cleanup.push(() => { baseline.close(); });
    const tables = ['events', 'attendees', 'event_audit', 'finance_entries', 'settlements', 'bot_outbox', 'bot_settings', 'external_identities', 'external_unionids', 'browser_sessions', 'browser_accounts', 'privacy_requests', 'user_admin_roles', 'admin_role_history', 'time_polls', 'time_poll_ballots', 'time_poll_votes'];
    for (const table of tables) expect(s.db.prepare('SELECT * FROM ' + table).all(), table).toEqual(baseline.prepare('SELECT * FROM ' + table).all());
    expect(s.db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual(baseline.prepare("SELECT nickname FROM users WHERE id='bob'").get());
  });
  it('records only validated internal IDs and rejects symbolic ledger paths', async () => {
    const dir = temporary(); const path = join(dir, 'safe.sqlite3'); const s = await setup({ path });
    const entry: ErasureIntent = { version: 1, kind: 'account', userId: 'bob', profileId: null, requestId: randomUUID(), createdAt: stamp, secretHash: hash('secret'), signature: hash('signature') };
    const journal = erasureJournal(s.db); journal.append(entry); expect(journal.read()).toEqual([entry]);
    expect(() => journal.append({ ...entry, createdAt: 'invalid' })).toThrow();
    expect(() => journal.append({ ...entry, kind: 'music', profileId: null })).toThrow();
    const ledger = join(dir, 'safe.erasures.jsonl'); const protectedFile = join(dir, 'protected'); writeFileSync(protectedFile, 'untouched');
    unlinkSync(ledger); symlinkSync(protectedFile, ledger); expect(() => journal.append(entry)).toThrow(); expect(() => journal.read()).toThrow(); expect(readFileSync(protectedFile, 'utf8')).toBe('untouched');
  });
});
