import { afterEach, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '@qgroup/database';
import { RoomLabCommand, RoomLabSource } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { musicCircleFixture } from '../testsupport/music-circle-fixture';
import { createApp } from './app';
import * as roomJobs from './music-room-jobs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); musicCircleFixture(db);
  const app = createApp({ db, origin: 'https://rebuild.example' }); await app.ready();
  cleanup.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice';
  const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, origin: 'https://rebuild.example', 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  const response = await app.inject({ url: '/api/v2/music/rooms/source', headers });
  expect(response.statusCode, response.body).toBe(200);
  const source = RoomLabSource.parse(response.json());
  const payload = RoomLabCommand.parse({ command: 'analyze', selected: source.members.slice(0, 2).map(member => member.id), sourceVersion: source.sourceVersion });
  return { db, app, headers, payload };
}
function snapshot(db: ReturnType<typeof openDatabase>) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '"').all()]);
}
/** Hold actual worker completion events at the parent boundary. Results and
 * exits come from native threads; no fake result or runtime hook is installed. */
function holdResults(count: number) {
  const original = Worker.prototype.emit, held = new Set<Worker>();
  const events: [Worker, string | symbol, unknown[]][] = [];
  let seen!: () => void;
  const started = new Promise<void>(resolve => { seen = resolve; });
  const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { ok?: boolean; result?: { sourceVersion?: string; membersWithSelection?: number } } | undefined;
    if (event === 'message' && message?.ok && (message.result?.sourceVersion || message.result?.membersWithSelection)) held.add(this);
    if (held.has(this) && (event === 'message' || event === 'exit')) {
      events.push([this, event, args]);
      if (held.size >= count) seen();
      return true;
    }
    return original.call(this, event, ...args);
  });
  const release = () => { spy.mockRestore(); for (const [worker, event, args] of events.splice(0)) original.call(worker, event, ...args); };
  cleanup.push(async () => { release(); });
  return { started, release };
}
for (const kind of ['circles', 'rooms'] as const) it(kind + ': API saturation rejects both features, preserves auth checks and data, and leaves health available', async () => {
  const s = await setup(), before = snapshot(s.db), gate = holdResults(2);
  const request = () => kind === 'circles'
    ? s.app.inject({ url: '/api/v2/music/circles', headers: s.headers })
    : s.app.inject({ method: 'POST', url: '/api/v2/music/rooms/calculate', headers: s.headers, payload: s.payload });
  const first = request(), second = request(); await gate.started;
  const reads = vi.spyOn(s.db, 'prepare');
  expect((await s.app.inject({ url: '/api/v2/music/circles', headers: s.headers })).json()).toMatchObject({ code: 'CIRCLE_BUSY' });
  expect((await s.app.inject({ method: 'POST', url: '/api/v2/music/rooms/calculate', headers: s.headers, payload: s.payload })).json()).toMatchObject({ code: 'ROOM_BUSY' });
  expect((await s.app.inject('/api/v2/music/circles')).statusCode).toBe(401);
  expect((await s.app.inject({ method: 'POST', url: '/api/v2/music/rooms/calculate', payload: s.payload })).statusCode).toBe(401);
  expect((await s.app.inject('/api/v2/health')).statusCode).toBe(200);
  expect(reads.mock.calls.map(([sql]) => sql).some(sql => /FROM music_entries|FROM music_selections/.test(sql))).toBe(false);
  reads.mockRestore();
  gate.release();
  expect((await first).statusCode).toBe(200); expect((await second).statusCode).toBe(200);
  expect((await s.app.inject({ method: 'POST', url: '/api/v2/music/rooms/calculate', headers: s.headers, payload: s.payload })).statusCode).toBe(200);
  expect((await s.app.inject({ url: '/api/v2/music/circles', headers: s.headers })).statusCode).toBe(200);
  expect(snapshot(s.db)).toEqual(before);
});
it('actual HTTP room disconnect aborts the native worker, then permits both features without writes', async () => {
  const original = roomJobs.createRoomJobs;
  let stopped!: () => void;
  const aborted = new Promise<void>(resolve => { stopped = resolve; });
  vi.spyOn(roomJobs, 'createRoomJobs').mockImplementation(budget => {
    const pool = original(budget);
    return { ...pool, run: (task, signal) => {
      signal?.addEventListener('abort', stopped, { once: true });
      return pool.run(task, signal);
    } };
  });
  const s = await setup(), before = snapshot(s.db), gate = holdResults(1);
  const url = await s.app.listen({ host: '127.0.0.1', port: 0 }), controller = new AbortController();
  const pending = fetch(url + '/api/v2/music/rooms/calculate', { method: 'POST', headers: { ...s.headers, 'content-type': 'application/json' },
    body: JSON.stringify(s.payload), signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await gate.started; controller.abort(); await rejected; await aborted; gate.release();
  expect((await fetch(url + '/api/v2/health')).status).toBe(200);
  expect((await s.app.inject({ method: 'POST', url: '/api/v2/music/rooms/calculate', headers: s.headers, payload: s.payload })).statusCode).toBe(200);
  expect((await s.app.inject({ url: '/api/v2/music/circles', headers: s.headers })).statusCode).toBe(200);
  expect(snapshot(s.db)).toEqual(before);
});
