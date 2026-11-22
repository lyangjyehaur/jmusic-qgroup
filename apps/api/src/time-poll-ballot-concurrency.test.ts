import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db);
  const origin = 'https://rebuild.example';
  const app = createApp({ db, origin, now: () => new Date('2026-11-17T00:00:00Z'), pairedBackupScheduling: false });
  await app.ready(); cleanup.push(async () => { await app.close(); db.close(); });
  async function browser(user: string) {
    const cookie = 'kanban_session=fixture-' + user;
    const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  }
  const alice = await browser('alice'), bob = await browser('bob');
  const post = (path: string, payload: object, headers = bob, key = randomUUID()) => app.inject({
    method: 'POST', url: '/api/v2/time-polls' + path, payload, headers: { ...headers, 'idempotency-key': key },
  });
  const created = await post('', {
    title: '合成填答競態', category: '其他', location: '合成地點', timezone: 'Asia/Taipei', capacity: 2,
    deadline: '2026-11-19T00:00:00Z', time_mode: 'exact', duration_hours: 2,
    options: [{ starts_at: '2026-11-20T10:00:00Z' }, { starts_at: '2026-11-21T10:00:00Z' }],
  }, alice);
  expect(created.statusCode).toBe(200); const id = created.json().id;
  const read = async (headers = bob) => (await app.inject({ url: '/api/v2/time-polls/' + id, headers })).json();
  const payload = (poll: Awaited<ReturnType<typeof read>>, choice = 'yes') => ({
    revision: poll.revision, ballot_token: poll.ballot_token,
    choices: poll.options.map((o: { id: string }) => ({ option_id: o.id, choice })),
  });
  return { db, app, alice, bob, id, post, read, payload };
}
describe('per-person time-poll ballot concurrency', () => {
  it('rejects another page old ballot without replacing newer answers or changing any row', async () => {
    const s = await setup(), original = await s.read(), old = s.payload(original);
    expect((await s.post('/' + s.id + '/votes', s.payload(original, 'no'))).statusCode).toBe(200);
    const before = s.db.serialize(), rejected = await s.post('/' + s.id + '/votes', old);
    expect(rejected.statusCode).toBe(409); expect(rejected.json().code).toBe('POLL_BALLOT_CHANGED');
    expect(s.db.serialize()).toEqual(before);
    expect(Object.values((await s.read()).my_choices)).toEqual(['no', 'no']);
  });
  it('lets different people submit their own original ballots without invalidating each other', async () => {
    const s = await setup(), bob = await s.read(), alice = await s.read(s.alice);
    expect((await s.post('/' + s.id + '/votes', s.payload(alice, 'no'), s.alice)).statusCode).toBe(200);
    expect((await s.post('/' + s.id + '/votes', s.payload(bob))).statusCode).toBe(200);
    expect(Object.values((await s.read(s.alice)).my_choices)).toEqual(['no', 'no']);
    expect(Object.values((await s.read()).my_choices)).toEqual(['yes', 'yes']);
  });
  it('returns the exact original receipt after a newer ballot without replaying its old choices', async () => {
    const s = await setup(), old = s.payload(await s.read()), key = randomUUID();
    const first = await s.post('/' + s.id + '/votes', old, s.bob, key); expect(first.statusCode).toBe(200);
    expect((await s.post('/' + s.id + '/votes', s.payload(await s.read(), 'no'))).statusCode).toBe(200);
    const before = s.db.serialize(), replay = await s.post('/' + s.id + '/votes', old, s.bob, key);
    expect(replay.body).toBe(first.body); expect(s.db.serialize()).toEqual(before);
  });
  it('requires an explicit fresh review for an uncommitted old native payload without a ballot token', async () => {
    const s = await setup(), { ballot_token: _token, ...old } = s.payload(await s.read());
    const before = s.db.serialize(), rejected = await s.post('/' + s.id + '/votes', old);
    expect(rejected.statusCode).toBe(409); expect(rejected.json().code).toBe('POLL_BALLOT_CHANGED');
    expect(s.db.serialize()).toEqual(before);
  });
  it('rejects an old form even when answers change away and back within the same second', async () => {
    const s = await setup();
    expect((await s.post('/' + s.id + '/votes', s.payload(await s.read(), 'no'))).statusCode).toBe(200);
    const original = await s.read();
    expect((await s.post('/' + s.id + '/votes', s.payload(original, 'yes'))).statusCode).toBe(200);
    expect((await s.post('/' + s.id + '/votes', s.payload(await s.read(), 'no'))).statusCode).toBe(200);
    const before = s.db.serialize(), rejected = await s.post('/' + s.id + '/votes', s.payload(original, 'yes'));
    expect(rejected.statusCode).toBe(409); expect(s.db.serialize()).toEqual(before);
    expect(Object.values((await s.read()).my_choices)).toEqual(['no', 'no']);
  });
  it('recovers a committed pre-token native receipt exactly after new answers and checks current login first', async () => {
    const s = await setup(), { ballot_token: _token, ...old } = s.payload(await s.read()), key = randomUUID();
    // A receipt created by the earlier native protocol, using its exact signature.
    const body = JSON.stringify({ id: s.id, revision: 1, vote_revision: 1, event_id: null, removed: false });
    const path = '/api/v2/time-polls/' + s.id + '/votes';
    s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('bob', key,
      'time-poll:' + hash('POST:' + path + ':' + JSON.stringify(old)), body, 200, 'before');
    s.db.prepare('INSERT INTO time_poll_ballots VALUES(?,?,?)').run(s.id, 'bob', 'before');
    for (const choice of old.choices) s.db.prepare('INSERT INTO time_poll_votes VALUES(?,?,?,?)').run(s.id, 'bob', choice.option_id, choice.choice);
    s.db.prepare('UPDATE time_polls SET vote_revision=1 WHERE id=?').run(s.id);
    expect((await s.post('/' + s.id + '/votes', s.payload(await s.read(), 'no'))).statusCode).toBe(200);
    const before = s.db.serialize(), replay = await s.post('/' + s.id + '/votes', old, s.bob, key);
    expect(replay.statusCode).toBe(200); expect(replay.body).toBe(body); expect(s.db.serialize()).toEqual(before);
    s.db.prepare('DELETE FROM browser_sessions WHERE user_id=?').run('bob');
    const revoked = s.db.serialize();
    expect((await s.post('/' + s.id + '/votes', old, s.bob, key)).statusCode).toBeGreaterThanOrEqual(400);
    expect(s.db.serialize()).toEqual(revoked);
  });

  it('does not expose ballot tokens to visitors and rejects malformed tokens without writing', async () => {
    const s = await setup(), session = await s.app.inject({ url: '/api/v2/session' });
    const visitor = { cookie: String(session.headers['set-cookie']).split(';')[0]!, 'x-account-scope': session.json().scope };
    const view = await s.app.inject({ url: '/api/v2/time-polls/' + s.id, headers: visitor });
    expect(view.statusCode).toBe(200); expect(view.json()).not.toHaveProperty('ballot_token');
    const before = s.db.serialize();
    for (const ballot_token of ['forged', 'A'.repeat(64), null])
      expect((await s.post('/' + s.id + '/votes', { ...s.payload(await s.read()), ballot_token })).statusCode).toBe(400);
    expect(s.db.serialize()).toEqual(before);
  });

});
