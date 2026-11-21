import { afterEach, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createCircleJobs } from './music-circle-jobs';
import { runCircleTask, type CircleTask } from './music-circle-task';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0)) await close(); });
function jobs() { const value = createCircleJobs(); cleanup.push(() => value.close()); return value; }
const task: CircleTask = { minLink: 40, entries: [{ id: 'e', name: '詞', kind: 'sub', count: 0 }], members: [
  { id: 'one', name: '一', selections: [{ entryId: 'e', level: 3 }] }, { id: 'two', name: '二', selections: [{ entryId: 'e', level: 3 }] },
] };
it('admits two real workers, rejects overflow, and releases capacity after the threads stop', async () => {
  const pool = jobs(), first = pool.run(task), second = pool.run(task);
  expect(() => pool.run(task)).toThrowError(expect.objectContaining({ code: 'CIRCLE_BUSY' }));
  expect(await first).toEqual(runCircleTask(task)); expect(await second).toEqual(runCircleTask(task));
  expect(await pool.run(task)).toEqual(runCircleTask(task));
});
it('cancels a running worker without freeing its capacity before termination or returning late results', async () => {
  const pool = jobs(), controller = new AbortController(), first = pool.run(task, controller.signal), rejected = expect(first).rejects.toMatchObject({ code: 'CIRCLE_CANCELLED' }), second = pool.run(task);
  controller.abort(); expect(() => pool.run(task)).toThrowError(expect.objectContaining({ code: 'CIRCLE_BUSY' }));
  await rejected; await second; expect(await pool.run(task)).toEqual(runCircleTask(task));
  await expect(pool.run(task, controller.signal)).rejects.toMatchObject({ code: 'CIRCLE_CANCELLED' });
});
it('terminates expired jobs, ignores their late completion, and permits a fresh analysis', async () => {
  const pool = jobs(); vi.useFakeTimers();
  const pending = pool.run(task), rejected = expect(pending).rejects.toMatchObject({ code: 'CIRCLE_TIMEOUT' });
  vi.advanceTimersByTime(5000); await rejected; vi.useRealTimers();
  expect(await pool.run(task)).toEqual(runCircleTask(task));
});
it('closes pending analyses and rejects new work after shutdown', async () => {
  const pool = jobs(), first = expect(pool.run(task)).rejects.toMatchObject({ code: 'CIRCLE_CANCELLED' }), second = expect(pool.run(task)).rejects.toMatchObject({ code: 'CIRCLE_CANCELLED' });
  await pool.close(); await first; await second;
  expect(() => pool.run(task)).toThrowError(expect.objectContaining({ code: 'CIRCLE_BUSY' }));
});
it('contains a worker validation failure and keeps the next valid analysis usable', async () => {
  const pool = jobs(); await expect(pool.run({ ...task, minLink: 0 })).rejects.toMatchObject({ code: 'CIRCLE_FAILED' });
  expect(await pool.run(task)).toEqual(runCircleTask(task));
});
it('rejects a worker with inherited environment while the managed worker excludes parent credentials', async () => {
  const worker = new Worker(new URL('./music-circle-worker.mjs', import.meta.url), { workerData: task, env: { CIRCLE_SYNTHETIC_SECRET: 'synthetic-private' }, execArgv: [] });
  try {
    const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(result).toEqual({ ok: false });
  } finally { await worker.terminate(); }
  vi.stubEnv('REBUILD_QQ_APP_KEY', 'synthetic-parent-credential');
  expect(await jobs().run(task)).toEqual(runCircleTask(task));
});
it('keeps the parent event loop responsive while preserving the complete thousand-member result', async () => {
  const entries = Array.from({ length: 2000 }, (_, i) => ({ id: 'e' + i, name: '詞' + i, kind: i < 200 ? 'main' as const : 'sub' as const, count: 0 }));
  let seed = 42; const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const members = Array.from({ length: 1000 }, (_, i) => ({ id: 'm' + i, name: '人' + i,
    selections: [...new Set(Array.from({ length: 20 }, () => Math.floor(random() * entries.length)))].map(n => ({ entryId: 'e' + n, level: 3 })) }));
  const input = { entries, members, minLink: 40 }; let beats = 0;
  const timer = setInterval(() => { beats++; }, 10);
  let result;
  try { result = await jobs().run(input); } finally { clearInterval(timer); }
  expect(beats).toBeGreaterThan(5); expect(result).toEqual(runCircleTask(input));
  expect(result.membersWithSelection).toBe(1000); expect(result.clusters.length).toBe(80); expect(result.singles).toBe(779);
});
