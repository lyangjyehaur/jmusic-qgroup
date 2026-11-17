import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { createApp, hash } from './app';
import { sharedRecords } from './privacy';
const origin = 'https://rebuild.example';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); nicknameFixture(db);
  const app = createApp({ db, origin, now: () => new Date('2026-11-17T08:00:00.123Z') }); await app.ready();
  cleanups.push(async () => { await app.close(); db.close(); });
  async function account(user: string) {
    const cookie = 'kanban_session=fixture-' + user; const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    const headers = { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
    const profile = (await app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'sub-2', level: 4 }] } })).json();
    return { headers, viewer, profile, input: { profileId: profile.id, musicEpoch: 0, revision: 0, name: user === 'alice' ? '小青' : '小白', note: '', gender: '', genderPublic: false } };
  }
  const alice = await account('alice'); const bob = await account('bob');
  const save = (input: object = alice.input, headers = alice.headers, key = randomUUID()) => app.inject({ method: 'PUT', url: '/api/v2/me/music/fields', headers: { ...headers, 'idempotency-key': key }, payload: input });
  const get = (headers = alice.headers) => app.inject({ url: '/api/v2/me/music/fields', headers });
  const card = (headers = bob.headers) => app.inject({ url: '/api/v2/music/profiles/' + alice.profile.id, headers });
  return { db, app, alice, bob, save, get, card };
}
describe('independent music fields', () => {
  it('normalizes a separate music name, private note and public gender, preserves activity identity and the Python bot view', async () => {
    const s = await setup(); const tables = ['users','attendees','events','roster_parties','finance_entries','settlements','bot_outbox','bot_settings','browser_sessions','external_identities','qq_accounts','account_audit','music_selections'];
    const before = tables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-fields-bot-')); const path = join(folder, 'synthetic.sqlite3');
    try {
      await s.db.backup(path); const probe = () => JSON.parse(execFileSync('python3', ['tools/rebuild/probe-auth-bot.py', path], { encoding: 'utf8' })); const oldBot = probe();
      const response = await s.save({ ...s.alice.input, name: '  成分\n稱呼 ', note: ' 私人\n  留言 ', gender: ' FEMALE ', genderPublic: true });
      expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ profileId: s.alice.profile.id, revision: 1, name: '成分 稱呼', note: '私人 留言', noteAt: 1794902400.123, gender: 'female', genderPublic: true });
      expect((await s.card()).json()).toMatchObject({ name: '成分 稱呼', gender: 'female', note: '' }); expect((await s.card()).body).not.toMatch(/私人|genderPublic|noteAt|revision/);
      expect(tables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
      await s.db.backup(path); expect(probe()).toEqual(oldBot);
      expect(s.db.prepare('SELECT revision FROM music_profiles WHERE id=?').get(s.alice.profile.id)).toEqual({ revision: 2 });
      const second = await s.save({ ...s.alice.input, revision: 1, name: '成分 稱呼', gender: '自訂', genderPublic: false }); expect(second.json()).toMatchObject({ note: '', noteAt: 0, gender: '自訂', genderPublic: false });
      expect((await s.card()).json().gender).toBe(''); expect((await s.card(s.alice.headers)).json().gender).toBe('自訂');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('preserves imported oversized fields verbatim on unrelated edits and enforces codepoint limits only on changed fields', async () => {
    const s = await setup(); const old = { name: '舊'.repeat(20), note: '原'.repeat(150), gender: '非公開'.repeat(5) };
    s.db.prepare('UPDATE music_profile_fields SET name=?,note=?,note_at=12.25,gender=?,gender_public=1 WHERE profile_id=?').run(old.name, old.note, old.gender, s.alice.profile.id);
    expect((await s.get()).json()).toMatchObject({ ...old, noteAt: 12.25 });
    expect((await s.save({ ...s.alice.input, ...old, genderPublic: false })).json()).toMatchObject({ ...old, noteAt: 12.25, revision: 1, genderPublic: false });
    const input = { ...s.alice.input, ...old, revision: 1, genderPublic: false };
    for (const change of [{ name: '🟢'.repeat(17) }, { name: '\u200b\ufeff' }, { name: 'bad\u0001' }, { note: '🟢'.repeat(141) }, { gender: '<bad>' }, { gender: '🟢'.repeat(13) }]) expect((await s.save({ ...input, ...change })).statusCode).toBe(400);
    expect((await s.get()).json()).toMatchObject({ ...old, revision: 1 });
    const valid = await s.save({ ...input, name: '🟢'.repeat(16), note: '🟢'.repeat(140), gender: '🟢'.repeat(12), genderPublic: true }); expect(valid.statusCode, valid.body).toBe(200);
    const clear = await s.save({ ...input, name: '🟢'.repeat(16), note: '🟢'.repeat(140), revision: 2, gender: '', genderPublic: true }); expect(clear.json()).toMatchObject({ gender: '', genderPublic: false });
  });
  it('reserves live Unicode-equivalent names and serializes concurrent name and revision collisions', async () => {
    const s = await setup(); expect((await s.save({ ...s.alice.input, name: 'Ｓtraße' })).statusCode).toBe(200);
    expect((await s.save({ ...s.bob.input, name: 'stras\u200bse' }, s.bob.headers)).json().code).toBe('MUSIC_NAME_IN_USE');
    const results = await Promise.all([s.save({ ...s.alice.input, revision: 1, name: '共同稱呼' }), s.save({ ...s.bob.input, name: ' 共 同 稱 呼 ' }, s.bob.headers)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200,409]);
    const { noteAt: _noteAt, ...current } = (await s.get()).json();
    const competing = await Promise.all([s.save({ ...s.alice.input, ...current, musicEpoch: 0, note: '甲' }), s.save({ ...s.alice.input, ...current, musicEpoch: 0, note: '乙' })]);
    expect(competing.map(r => r.statusCode).sort()).toEqual([200,409]);
  });
  it('acknowledges exact retries without reverting newer fields and does not manufacture history for no-op saves', async () => {
    const s = await setup(); const key = randomUUID(); const input = { ...s.alice.input, note: '第一份' };
    const first = await s.save(input, s.alice.headers, key); expect(first.statusCode).toBe(200);
    const second = await s.save({ ...input, revision: 1, note: '第二份' }); expect(second.json().revision).toBe(2);
    expect((await s.save(input, s.alice.headers, key)).json()).toEqual(first.json()); expect((await s.get()).json().note).toBe('第二份');
    expect((await s.save({ ...input, note: '不同' }, s.alice.headers, key)).json().code).toBe('REQUEST_CONFLICT'); expect((await s.save(input)).json().code).toBe('MUSIC_FIELDS_CHANGED');
    expect((await s.save({ ...input, revision: 2, note: '第二份' })).json().revision).toBe(2);
    expect(s.db.prepare('SELECT count(*) n FROM music_field_history').get()).toEqual({ n: 2 });
    expect(() => s.db.exec('DELETE FROM music_field_history')).toThrow('append-only'); expect(() => s.db.exec("UPDATE music_field_history SET after_json='{}'")).toThrow('append-only');
  });
  it('rolls back canonical fields, selection revision, history and receipts when any transactional write fails', async () => {
    const s = await setup(); const tables = ['music_profile_fields','music_profiles','music_field_history','music_profile_receipts','request_results'];
    const before = tables.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    for (const target of ['music_field_history','request_results','music_profile_receipts']) {
      s.db.exec(`CREATE TRIGGER fail_fields BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END`);
      const response = await s.save({ ...s.alice.input, note: '不可部分保存' }); expect(response.statusCode).toBe(500); expect(response.body).not.toContain('synthetic private');
      expect(tables.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before); s.db.exec('DROP TRIGGER fail_fields');
    }
  });
  it('keeps canonical edits authoritative over legacy source and account nickname, including administrator search', async () => {
    const s = await setup(); s.db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(s.alice.profile.id, '10001', '舊來源', 1, '', '10001', '{"note":"原私人留言","gender":"male","genderPublic":true}', '[]', 'oauth');
    expect((await s.save({ ...s.alice.input, name: '獨立成分', note: '不可公開的新留言', gender: 'female' })).statusCode).toBe(200);
    s.db.prepare("UPDATE users SET nickname='另一帳號稱呼' WHERE id='alice'").run();
    expect((await s.get()).json().name).toBe('獨立成分'); expect((await s.card()).json()).toMatchObject({ name: '獨立成分', gender: '' });
    s.db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'before')").run(); const admin = (await s.app.inject({ url: '/api/v2/admin/session', headers: s.alice.headers })).json();
    const found = await s.app.inject({ method: 'POST', url: '/api/v2/admin/music/search', headers: { ...s.alice.headers, 'x-admin-csrf': admin.adminCsrf }, payload: { search: '獨立成分' } });
    expect(found.statusCode, found.body).toBe(200); expect(found.json().profiles).toMatchObject([{ name: '獨立成分' }]); expect(found.body).not.toMatch(/留言|note|female|gender/);
    expect(s.db.prepare('SELECT name,fields_json FROM music_legacy_profiles').get()).toMatchObject({ name: '舊來源', fields_json: expect.stringContaining('原私人留言') });
  });
  it('requires current member, scope, origin and CSRF even for successful retries, and rejects foreign or stale profile epochs', async () => {
    const s = await setup();
    for (const [override, status] of [[{ cookie: '' },401],[{ origin: 'https://evil.example' },403],[{ 'x-account-scope': 'wrong' },409],[{ 'x-csrf-token': 'wrong' },403]] as const) expect((await s.save(s.alice.input, { ...s.alice.headers, ...override })).statusCode).toBe(status);
    expect((await s.get({ ...s.alice.headers, 'x-account-scope': 'wrong' })).statusCode).toBe(409); expect((await s.get({ ...s.alice.headers, cookie: '' })).statusCode).toBe(401);
    for (const patch of [{ profileId: s.bob.profile.id }, { musicEpoch: 1 }]) expect((await s.save({ ...s.alice.input, ...patch })).json().code).toBe('PROFILE_ERASED');
    const key = randomUUID(); expect((await s.save({ ...s.alice.input, note: '私人' }, s.alice.headers, key)).statusCode).toBe(200);
    s.db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(hash('fixture-alice')); expect((await s.save({ ...s.alice.input, note: '私人' }, s.alice.headers, key)).statusCode).toBe(401);
  });
  it('erases field history and linked private receipts and rejects old drafts after recreation', async () => {
    const s = await setup(); const key = randomUUID(); const input = { ...s.alice.input, note: '刪除私人留言', gender: '私密性別' }; expect((await s.save(input, s.alice.headers, key)).statusCode).toBe(200);
    const profile = (await s.app.inject({ url: '/api/v2/me/music', headers: s.alice.headers })).json();
    const erase = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: s.alice.headers, payload: { target: 'music', profileId: profile.id, profileRevision: profile.revision, requestId: randomUUID(), secret: 'a'.repeat(64), confirm: true } }); expect(erase.statusCode).toBe(200);
    for (const table of ['music_profile_fields','music_field_history']) expect(s.db.prepare('SELECT * FROM ' + table + ' WHERE profile_id=?').all(profile.id)).toEqual([]);
    expect((await s.save(input, s.alice.headers, key)).statusCode).toBe(410); expect(JSON.stringify(s.db.prepare('SELECT response_json FROM request_results WHERE request_key=?').get(key))).not.toMatch(/留言|gender/);
    const rebuilt = await s.app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...s.alice.headers, 'idempotency-key': randomUUID() }, payload: { profileId: null, revision: 0, musicEpoch: 1, selections: profile.selections } }); expect(rebuilt.statusCode).toBe(200);
    expect((await s.get()).json()).toMatchObject({ name: '小青', note: '', gender: '', revision: 0 }); expect((await s.save(input)).json().code).toBe('PROFILE_ERASED');
  });
  it('retains independent fields on account-only closure and lists field history for shared-data review', async () => {
    const s = await setup(); expect((await s.save({ ...s.alice.input, note: '保留成分' })).statusCode).toBe(200);
    expect(sharedRecords(s.db, 'alice')).toMatchObject({ music_field_history: 1 });
    s.db.exec("UPDATE events SET lifecycle='ended' WHERE owner_id='alice'");
    const profile = (await s.app.inject({ url: '/api/v2/me/music', headers: s.alice.headers })).json();
    const erase = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: s.alice.headers, payload: { target: 'account', profileId: profile.id, profileRevision: profile.revision, requestId: randomUUID(), secret: 'b'.repeat(64), confirm: true } }); expect(erase.json().status).toBe('shared_review');
    expect(s.db.prepare('SELECT note FROM music_profile_fields WHERE profile_id=?').get(profile.id)).toEqual({ note: '保留成分' });
    expect(s.db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profile.id)).toEqual({ user_id: null });
  });
});
