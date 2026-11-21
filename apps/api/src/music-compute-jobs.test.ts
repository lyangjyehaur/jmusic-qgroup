import { afterEach, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createMusicComputeBudget } from './music-compute-budget';
import { createCircleJobs } from './music-circle-jobs';
import { createRoomJobs } from './music-room-jobs';
import { runCircleTask, type CircleTask } from './music-circle-task';
import { runRoomTask, type RoomTask } from './music-room-task';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0)) await close(); });
const circle: CircleTask = { minLink: 40, entries: [{ id: 'e', name: '詞', kind: 'sub', count: 0 }], members: [
  { id: 'a', name: '一', selections: [{ entryId: 'e', level: 3 }] },
  { id: 'b', name: '二', selections: [{ entryId: 'e', level: 3 }] },
] };
const room: RoomTask = { input: { command: 'analyze', sourceVersion: 'a'.repeat(64), selected: ['a', 'b'] },
  members: circle.members, entries: circle.entries };
function pools() {
  const budget = createMusicComputeBudget(), circles = createCircleJobs(budget), rooms = createRoomJobs(budget);
  cleanup.push(async () => { await Promise.all([circles.close(), rooms.close()]); });
  return { circles, rooms };
}
for (const kind of ['circles', 'rooms'] as const) it(kind + ': two jobs exhaust the other feature budget until real workers stop', async () => {
  const { circles, rooms } = pools();
  const first = kind === 'circles' ? circles.run(circle) : rooms.run(room);
  const second = kind === 'circles' ? circles.run(circle) : rooms.run(room);
  expect(() => circles.run(circle)).toThrowError(expect.objectContaining({ code: 'CIRCLE_BUSY' }));
  expect(() => rooms.run(room)).toThrowError(expect.objectContaining({ code: 'ROOM_BUSY' }));
  await Promise.all([first, second]);
  expect(await circles.run(circle)).toEqual(runCircleTask(circle));
  expect(await rooms.run(room)).toEqual(runRoomTask(room));
});
it('reserves a mixed pair, cancels rooms before reusing their slot, and preserves the circle result', async () => {
  const { circles, rooms } = pools(), controller = new AbortController();
  const pending = rooms.run(room, controller.signal), rejected = expect(pending).rejects.toMatchObject({ code: 'ROOM_FAILED' });
  const result = circles.run(circle);
  controller.abort();
  expect(() => circles.run(circle)).toThrowError(expect.objectContaining({ code: 'CIRCLE_BUSY' }));
  await rejected;
  expect(await rooms.run(room)).toEqual(runRoomTask(room));
  expect(await result).toEqual(runCircleTask(circle));
  await expect(rooms.run(room, controller.signal)).rejects.toMatchObject({ code: 'ROOM_FAILED' });
});
it('terminates both features on shutdown and keeps another API budget independent', async () => {
  const { circles, rooms } = pools(), independent = pools();
  const a = expect(circles.run(circle)).rejects.toMatchObject({ code: 'CIRCLE_CANCELLED' });
  const b = expect(rooms.run(room)).rejects.toMatchObject({ code: 'ROOM_FAILED' });
  await Promise.all([circles.close(), rooms.close()]); await a; await b;
  expect(() => circles.run(circle)).toThrowError(expect.objectContaining({ code: 'CIRCLE_BUSY' }));
  expect(() => rooms.run(room)).toThrowError(expect.objectContaining({ code: 'ROOM_BUSY' }));
  expect(await independent.rooms.run(room)).toEqual(runRoomTask(room));
});
it('returns capacity after room timeout and validation failure for the other feature', async () => {
  const { circles, rooms } = pools(); vi.useFakeTimers();
  const rejected = expect(rooms.run(room)).rejects.toMatchObject({ code: 'ROOM_TIMEOUT' });
  vi.advanceTimersByTime(5000); await rejected; vi.useRealTimers();
  await expect(rooms.run({ ...room, input: { ...room.input, sourceVersion: 'invalid' } })).rejects.toMatchObject({ code: 'ROOM_FAILED' });
  expect(await circles.run(circle)).toEqual(runCircleTask(circle));
});
it('rejects inherited worker environment and keeps managed rooms independent of parent credentials', async () => {
  const worker = new Worker(new URL('./music-room-worker.mjs', import.meta.url), { workerData: room, env: { SYNTHETIC_ROOM_SECRET: 'private-fixture' }, execArgv: [] });
  try {
    const response = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(response).toEqual({ ok: false });
  } finally { await worker.terminate(); }
  vi.stubEnv('REBUILD_QQ_APP_KEY', 'synthetic-parent-only');
  expect(await pools().rooms.run(room)).toEqual(runRoomTask(room));
});
