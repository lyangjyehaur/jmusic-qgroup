import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { circleId, musicCircleFixture } from '../testsupport/music-circle-fixture';
import * as jobs from './music-circle-jobs';
import { runCircleTask } from './music-circle-task';
import { createApp } from './app';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup() {
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { seen = resolve; });
  const pending = vi.fn(async (task: Parameters<typeof runCircleTask>[0]) => { seen(); await gate; return runCircleTask(task); });
  vi.spyOn(jobs, 'createCircleJobs').mockReturnValue({ available: () => {}, run: pending, close: async () => { release(); } });
  const db = openDatabase(':memory:'); fixture(db); musicCircleFixture(db);
  const app = createApp({ db, origin: 'https://rebuild.example' }); await app.ready(); cleanup.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, 'x-account-scope': viewer.scope };
  return { db, app, started, release, pending, headers };
}
function snapshot(db: ReturnType<typeof openDatabase>) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '"').all()]);
}
for (const [change, status] of [['selection', 409], ['name', 409], ['entry', 409], ['target erasure', 409], ['qualification', 403], ['device', 401], ['account', 409]] as const) it(change + ': rejects an analysis whose source or authority changed during computation', async () => {
  const s = await setup(), result = s.app.inject({ url: '/api/v2/music/circles', headers: s.headers });
  await s.started;
  if (change === 'selection') s.db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(circleId(3));
  if (change === 'name') s.db.prepare("UPDATE music_profile_fields SET name='晚到稱呼' WHERE profile_id=?").run(circleId(3));
  if (change === 'entry') s.db.prepare("UPDATE music_entries SET name='晚到詞條' WHERE id=(SELECT entry_id FROM music_selections LIMIT 1)").run();
  if (change === 'target erasure') s.db.prepare("UPDATE music_profiles SET erased_at='erased',user_id=NULL WHERE id=?").run(circleId(3));
  if (change === 'qualification') s.db.prepare("UPDATE music_profiles SET user_id=NULL WHERE user_id='alice'").run();
  const token = createHash('sha256').update('fixture-alice').digest('hex');
  if (change === 'device') s.db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(token);
  if (change === 'account') s.db.prepare("UPDATE browser_sessions SET user_id='bob' WHERE token_hash=?").run(token);
  const after = snapshot(s.db); s.release(); const response = await result;
  expect(response.statusCode, response.body).toBe(status); expect(response.body).not.toContain('鏈首');
  expect(response.body).not.toContain('晚到稱呼'); expect(snapshot(s.db)).toEqual(after);
});
it('serves health while analysis waits and sends only the existing public circle projection to the worker', async () => {
  const s = await setup(), before = snapshot(s.db), result = s.app.inject({ url: '/api/v2/music/circles', headers: s.headers });
  await s.started;
  expect((await s.app.inject('/api/v2/health')).statusCode).toBe(200);
  const task = s.pending.mock.calls[0]![0];
  expect(Object.keys(task).sort()).toEqual(['entries', 'members', 'minLink']);
  expect(JSON.stringify(task)).not.toMatch(/998877|私人留言|性別|note|gender|contact|qq|pin|token|scope|user_id|sourceFields/);
  s.release(); expect((await result).statusCode).toBe(200); expect(snapshot(s.db)).toEqual(before);
});
it('cancels pending work when the actual HTTP client disconnects and leaves the API usable', async () => {
  let seen!: () => void, stopped!: () => void;
  const started = new Promise<void>(resolve => { seen = resolve; }), aborted = new Promise<void>(resolve => { stopped = resolve; });
  vi.spyOn(jobs, 'createCircleJobs').mockReturnValue({ available: () => {}, close: async () => {}, run: async (_task, signal) => {
    seen(); await new Promise<void>(resolve => { signal!.addEventListener('abort', () => { stopped(); resolve(); }, { once: true }); });
    throw new Error('synthetic cancelled work');
  } });
  const db = openDatabase(':memory:'); fixture(db); musicCircleFixture(db);
  const app = createApp({ db, origin: 'https://rebuild.example' }); await app.ready(); cleanup.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const url = await app.listen({ host: '127.0.0.1', port: 0 }), before = snapshot(db), controller = new AbortController();
  const result = fetch(url + '/api/v2/music/circles', { headers: { cookie, 'x-account-scope': viewer.scope }, signal: controller.signal });
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await started; controller.abort(); await rejected; await aborted;
  expect((await fetch(url + '/api/v2/health')).status).toBe(200); expect(snapshot(db)).toEqual(before);
});
