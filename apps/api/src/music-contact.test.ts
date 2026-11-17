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

const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example';
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); nicknameFixture(db);
  const app = createApp({ db, origin }); await app.ready(); resources.push(async () => { await app.close(); db.close(); });
  async function account(user: string) {
    const cookie = 'kanban_session=fixture-' + user; const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    const headers = { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
    const profile = (await app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'sub-2', level: 4 }] } })).json();
    return { headers, viewer, profile, input: { profileId: profile.id, musicEpoch: 0, revision: 0, contactQQ: '123456' } };
  }
  const alice = await account('alice'); const bob = await account('bob');
  const save = (input: object = alice.input, headers = alice.headers, key = randomUUID()) => app.inject({ method: 'PUT', url: '/api/v2/me/music/contact', headers: { ...headers, 'idempotency-key': key }, payload: input });
  const lookup = (query: string, headers = bob.headers) => app.inject({ method: 'POST', url: '/api/v2/music/profiles/lookup', headers, payload: { query } });
  return { db, app, alice, bob, save, lookup };
}
describe('music contacts and member lookup', () => {
  it('normalizes and clears self-reported contacts without changing stable identity, selections, QQ binding or bot work', async () => {
    const { db, app, alice, save, lookup } = await setup();
    const tables = ['events','attendees','finance_entries','settlements','bot_outbox','bot_settings','browser_sessions','external_identities','qq_accounts','account_audit'];
    const before = tables.map(table => db.prepare('SELECT * FROM ' + table).all());
    const first = await save({ ...alice.input, contactQQ: ' 123456 ' }); expect(first.statusCode).toBe(200); expect(first.json()).toEqual({ profileId: alice.profile.id, revision: 1, contactQQ: '123456', source: 'self_reported' });
    expect((await lookup('123456')).json()).toEqual({ id: alice.profile.id, name: '小青', gender: '', note: '', contactQQ: '123456', contactSource: 'self_reported', selections: [{ entryId: 'sub-2', level: 4, name: 'Aimer', kind: 'sub' }] });
    expect((await save({ ...alice.input, revision: 1, contactQQ: '' })).json()).toMatchObject({ contactQQ: '', revision: 2 });
    expect((await lookup('123456')).statusCode).toBe(404); expect((await lookup(alice.profile.id)).json().id).toBe(alice.profile.id);
    const profile = (await app.inject({ url: '/api/v2/me/music', headers: alice.headers })).json(); expect(profile).toMatchObject({ id: alice.profile.id, revision: 3, selections: alice.profile.selections });
    expect(tables.map(table => db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
    expect(db.prepare('SELECT count(*) n FROM music_contact_history').get()).toEqual({ n: 2 });
    expect(() => db.prepare('DELETE FROM music_contact_history').run()).toThrow('append-only');
  });
  it('replays one exact operation, detects changed contents and old revisions, and rolls back when the audit fails', async () => {
    const { db, alice, save } = await setup(); const key = randomUUID();
    db.exec("CREATE TRIGGER fail_contact BEFORE INSERT ON music_contact_history BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END");
    const failed = await save(alice.input, alice.headers, key); expect(failed.statusCode).toBe(500); expect(failed.body).not.toContain('synthetic'); expect(db.prepare('SELECT * FROM music_profile_contacts').all()).toEqual([]);
    expect(db.prepare('SELECT revision FROM music_profiles WHERE id=?').get(alice.profile.id)).toEqual({ revision: 1 });
    expect(db.prepare('SELECT 1 FROM request_results WHERE request_key=?').get(key)).toBeUndefined(); db.exec('DROP TRIGGER fail_contact');
    const first = await save(alice.input, alice.headers, key); expect((await save(alice.input, alice.headers, key)).json()).toEqual(first.json());
    expect((await save({ ...alice.input, contactQQ: '654321' }, alice.headers, key)).json().code).toBe('REQUEST_CONFLICT');
    expect((await save({ ...alice.input, contactQQ: '654321' })).json().code).toBe('CONTACT_CHANGED');
    expect(db.prepare('SELECT count(*) n FROM music_contact_history').get()).toEqual({ n: 1 });
    expect((await save({ ...alice.input, revision: 1 })).json().revision).toBe(1); expect(db.prepare('SELECT count(*) n FROM music_contact_history').get()).toEqual({ n: 1 });
  });
  it('rejects duplicate reservations, orphan legacy contacts and invalid input without transferring ownership', async () => {
    const { db, alice, bob, save } = await setup(); expect((await save()).statusCode).toBe(200);
    expect((await save({ ...bob.input, contactQQ: '123456' }, bob.headers)).json().code).toBe('CONTACT_IN_USE');
    db.prepare("INSERT INTO music_legacy_identity VALUES('profile_contacts',0,?)").run(JSON.stringify({ qq: 'missing-profile', number: '778899', updated: 1 }));
    expect((await save({ ...bob.input, contactQQ: '778899' }, bob.headers)).json().code).toBe('CONTACT_IN_USE');
    for (const contactQQ of ['01234','123','1'.repeat(13),'１２３４','12 34','1e10']) expect((await save({ ...bob.input, contactQQ }, bob.headers)).statusCode).toBe(400);
    expect((await save({ ...bob.input, profileId: alice.profile.id }, bob.headers)).json().code).toBe('PROFILE_ERASED');
    expect(db.prepare('SELECT id,user_id FROM music_profiles ORDER BY user_id').all()).toEqual([{ id: alice.profile.id, user_id: 'alice' }, { id: bob.profile.id, user_id: 'bob' }]);
    expect(db.prepare('SELECT * FROM music_legacy_identity').all()).toHaveLength(1);
  });
  it('serializes competing contact revisions and competing unique numbers with exactly one winner', async () => {
    const { alice, bob, save } = await setup();
    const revisions = await Promise.all([save(alice.input), save({ ...alice.input, contactQQ: '654321' })]); expect(revisions.map(row => row.statusCode).sort()).toEqual([200,409]);
    const current = revisions.find(row => row.statusCode === 200)!.json();
    const numbers = await Promise.all([save({ ...alice.input, revision: 1, contactQQ: '998877' }), save({ ...bob.input, contactQQ: '998877' }, bob.headers)]); expect(numbers.map(row => row.statusCode).sort()).toEqual([200,409]);
    expect(current.revision).toBe(1);
  });
  it('keeps legacy numeric aliases read-only, uses current native contacts and never exposes migrated private fields', async () => {
    const { db, app, alice, bob, save, lookup } = await setup();
    // Model imported profiles, rather than attaching source data over authoritative native fields.
    db.prepare('DELETE FROM music_profile_fields WHERE profile_id IN (?,?)').run(alice.profile.id, bob.profile.id);
    db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(alice.profile.id, '10001', '舊成分稱呼', 1, 'private-pin-hash', '10001', '{"note":"private","gender":"female","genderPublic":false}', '[]', 'oauth');
    db.prepare("INSERT INTO music_profile_contacts VALUES(?,'10001','legacy',0,'before')").run(alice.profile.id);
    expect((await save({ ...alice.input, contactQQ: '' })).json().code).toBe('LEGACY_CONTACT_FIXED');
    expect((await save({ ...bob.input, contactQQ: '10001' }, bob.headers)).json().code).toBe('CONTACT_IN_USE');
    const response = await lookup('10001'); expect(response.json()).toMatchObject({ id: alice.profile.id, name: '舊成分稱呼', gender: '', contactSource: 'legacy' }); expect(response.body).not.toMatch(/pin|hash|private|female|boardUserId|alice|consent|ownership/);
    expect((await app.inject({ url: '/api/v2/music/profiles/' + alice.profile.id, headers: bob.headers })).json()).toEqual(response.json());
    expect((await app.inject({ url: '/api/v2/me/music/contact', headers: alice.headers })).json()).toMatchObject({ source: 'legacy', revision: 0 });
    const native = 'm_' + 'a'.repeat(24); db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(bob.profile.id, native, '獨立名稱', 1, 'never-public', '', '{}', '[]', 'prelinked');
    expect((await save({ ...bob.input, contactQQ: '998866' }, bob.headers)).statusCode).toBe(200);
    expect((await lookup(native)).json()).toMatchObject({ id: bob.profile.id, name: '獨立名稱', contactQQ: '998866', contactSource: 'self_reported' });
    expect(db.prepare('SELECT contact_qq FROM music_legacy_profiles WHERE profile_id=?').get(bob.profile.id)).toEqual({ contact_qq: '998866' });
  });
  it('requires a scoped member, exact origin and valid CSRF, and rejects successful replay after device revocation', async () => {
    const { app, db, alice, bob, save, lookup } = await setup();
    for (const [override, status] of [[{ cookie: '' },401],[{ origin: 'https://evil.example' },403],[{ 'x-account-scope': 'wrong' },409],[{ 'x-csrf-token': 'a'.repeat(64) },403]] as const) {
      expect((await save(alice.input, { ...alice.headers, ...override })).statusCode).toBe(status);
      expect((await lookup(alice.profile.id, { ...alice.headers, ...override })).statusCode).toBe(status);
    }
    expect((await app.inject('/api/v2/music/profiles/' + alice.profile.id)).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v2/me/music/contact', headers: { ...alice.headers, 'x-account-scope': 'wrong' } })).statusCode).toBe(409);
    const key = randomUUID(); expect((await save(alice.input, alice.headers, key)).statusCode).toBe(200); db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(hash('fixture-alice'));
    expect((await save(alice.input, alice.headers, key)).statusCode).toBe(401);
    db.prepare("UPDATE music_profiles SET user_id=NULL WHERE user_id='bob'").run();
    expect((await lookup(alice.profile.id, bob.headers)).json().code).toBe('MUSIC_PROFILE_REQUIRED');
    expect((await app.inject({ url: '/api/v2/music/profiles/' + alice.profile.id, headers: bob.headers })).statusCode).toBe(403);
  });
  it('erases contacts and history, redacts old operation results and prevents stale writes from reviving an erased profile', async () => {
    const { db, app, alice, bob, save, lookup } = await setup(); const key = randomUUID(); expect((await save(bob.input, bob.headers, key)).statusCode).toBe(200);
    const profile = (await app.inject({ url: '/api/v2/me/music', headers: bob.headers })).json();
    const erased = await app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: bob.headers, payload: { target: 'music', profileId: profile.id, profileRevision: profile.revision, requestId: randomUUID(), secret: 'a'.repeat(64), confirm: true } }); expect(erased.statusCode).toBe(200);
    expect(db.prepare('SELECT * FROM music_profile_contacts').all()).toEqual([]); expect(db.prepare('SELECT * FROM music_contact_history').all()).toEqual([]);
    expect((await save(bob.input, bob.headers, key)).statusCode).toBe(410); expect((await lookup(profile.id, alice.headers)).statusCode).toBe(404);
    const rebuilt = (await app.inject({ method: 'PUT', url: '/api/v2/me/music', headers: { ...bob.headers, 'idempotency-key': randomUUID() }, payload: { profileId: null, revision: 0, musicEpoch: 1, selections: profile.selections } })).json(); expect(rebuilt.id).not.toBe(profile.id);
    expect((await save(bob.input, bob.headers)).json().code).toBe('PROFILE_ERASED'); expect((await app.inject({ url: '/api/v2/me/music/contact', headers: bob.headers })).json()).toMatchObject({ profileId: rebuilt.id, contactQQ: '', revision: 0 });
  });
  it('account-only closure retains independent contacts and honestly flags retained contact history', async () => {
    const { db, app, bob, save } = await setup(); expect((await save(bob.input, bob.headers)).statusCode).toBe(200);
    const profile = (await app.inject({ url: '/api/v2/me/music', headers: bob.headers })).json();
    const response = await app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: bob.headers, payload: { target: 'account', profileId: profile.id, profileRevision: profile.revision, requestId: randomUUID(), secret: 'b'.repeat(64), confirm: true } });
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe('shared_review');
    expect(db.prepare('SELECT contact_qq FROM music_profile_contacts WHERE profile_id=?').get(profile.id)).toEqual({ contact_qq: '123456' }); expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(profile.id)).toEqual({ user_id: null });
    expect(db.prepare('SELECT actor_id FROM music_contact_history').get()).toEqual({ actor_id: 'bob' });
  });
  it('matches the original Python normalization, duplicate checks, fixed legacy aliases and clear semantics', async () => {
    const { db, app, alice, bob, save } = await setup();
    db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(alice.profile.id, '10001', 'legacy', 1, '', '10001', '{}', '[]', 'oauth');
    db.prepare("INSERT INTO music_profile_contacts VALUES(?,'10001','legacy',0,'before')").run(alice.profile.id);
    const native = 'm_' + 'a'.repeat(24);
    const changes = [[native,' 234567 '],[native,''],[native,'10001'],['10001','99999'],[native,'01234'],[native,'1234'],[native,'']] as const;
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-contact-diff-'));
    let expected: { status: number; contact: string }[];
    try {
      expected = JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site.identity_store import Store,Rejected
from music_site import contacts
native='m_'+'a'*24
data={'members':{'10001':{'qq':'10001'},native:{'qq':native}}}
store=Store(sys.argv[1]);result=[]
for mid,value in json.loads(sys.argv[2]):
    status=200
    try: contacts.save(data,store,mid,value)
    except Rejected as exc: status=exc.status
    result.append(dict(status=status,contact=contacts.number(data,mid)))
print(json.dumps(result))`, join(folder, 'identity.sqlite3'), JSON.stringify(changes)], { encoding: 'utf8' }));
    } finally { rmSync(folder, { recursive: true, force: true }); }
    for (const [index, [key, value]] of changes.entries()) {
      const account = key === '10001' ? alice : bob;
      const current = (await app.inject({ url: '/api/v2/me/music/contact', headers: account.headers })).json();
      const result = await save({ ...account.input, revision: current.revision, contactQQ: value }, account.headers);
      const after = (await app.inject({ url: '/api/v2/me/music/contact', headers: account.headers })).json();
      expect({ status: result.statusCode, contact: after.contactQQ }).toEqual(expected[index]);
    }
  });
});
