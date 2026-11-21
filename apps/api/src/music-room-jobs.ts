import { withApiError } from './error-display';
import { Worker } from 'node:worker_threads';
import { DomainError } from '@qgroup/domain';
import { RoomLabResult } from '@qgroup/contracts';
import type { RoomTask } from './music-room-task';
import { createMusicComputeBudget, type MusicComputeBudget } from './music-compute-budget';
/** Bounded CPU work, no database handles, credentials, or network clients. */
export function createRoomJobs(budget: MusicComputeBudget = createMusicComputeBudget()) {
  const workers = new Map<Worker, (error: Error) => void>();
  let closed = false;
  const busy = () => withApiError(new DomainError('ROOM_BUSY', '分房試算忙碌中，請稍後重試', 503));
  const stopped = () => withApiError(new DomainError('ROOM_FAILED', '分房計算已停止，請重試', 503));
  const failed = () => withApiError(new DomainError('ROOM_FAILED', '分房計算失敗，請重試', 503));
  const available = () => { if (closed || !budget.available()) throw busy(); };
  return {
    available,
    run(task: RoomTask, signal?: AbortSignal) {
      available();
      if (signal?.aborted) return Promise.reject(stopped());
      const release = budget.acquire();
      if (!release) throw busy();
      return new Promise<ReturnType<typeof RoomLabResult.parse>>((resolve, reject) => {
        let worker: Worker;
        try { worker = new Worker(new URL('./music-room-worker.mjs', import.meta.url), {
          workerData: task, env: {}, execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: 64,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 2,
          },
        }); } catch { release(); reject(failed()); return; }
        let finished = false;
        const finish = (error?: Error, value?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          void worker.terminate().then(() => {
            workers.delete(worker);
            release();
            if (error) reject(error);
            else {
              const result = RoomLabResult.safeParse(value);
              if (result.success) resolve(result.data);
              else reject(withApiError(new DomainError('ROOM_FAILED', '分房計算失敗，請重試', 503)));
            }
          }, () => { reject(failed()); });
        };
        const abort = () => finish(stopped());
        const timer = setTimeout(
          () => finish(withApiError(new DomainError('ROOM_TIMEOUT', '分房計算逾時，請減少人數後重試', 503))),
          5000,
        );
        workers.set(worker, error => finish(error));
        signal?.addEventListener('abort', abort, { once: true });
        worker.once('message', (message: { ok?: boolean; result?: unknown }) =>
          message.ok
            ? finish(undefined, message.result)
            : finish(withApiError(new DomainError('ROOM_FAILED', '分房計算失敗，請核對人數與容量後重試', 400))),
        );
        worker.once('error', () => finish(withApiError(new DomainError('ROOM_FAILED', '分房計算失敗，請重試', 503))));
        worker.once('exit', () => {
          workers.delete(worker); release();
          if (!finished) finish(withApiError(new DomainError('ROOM_FAILED', '分房計算已停止，請重試', 503)));
        });
      });
    },
    async close() {
      closed = true;
      const pending = [...workers];
      for (const [, stop] of pending) stop(stopped());
      await Promise.all(pending.map(([worker]) => worker.terminate()));
    },
  };
}
