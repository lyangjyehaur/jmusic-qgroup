import { Worker } from 'node:worker_threads';
import { DomainError } from '@qgroup/domain';
import { RoomLabResult } from '@qgroup/contracts';
import type { RoomTask } from './music-room-task';
/** Bounded CPU work, no database handles, credentials, or network clients. */
export function createRoomJobs() {
  const workers = new Set<Worker>();
  let closed = false;
  return {
    run(task: RoomTask) {
      if (closed || workers.size >= 2) throw new DomainError('ROOM_BUSY', '分房試算忙碌中，請稍後重試', 503);
      return new Promise<ReturnType<typeof RoomLabResult.parse>>((resolve, reject) => {
        const worker = new Worker(new URL('./music-room-worker.mjs', import.meta.url), {
          workerData: task,
          resourceLimits: {
            maxOldGenerationSizeMb: 64,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 2,
          },
        });
        workers.add(worker);
        let finished = false;
        const finish = (error?: Error, value?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          void worker.terminate().finally(() => {
            workers.delete(worker);
            if (error) reject(error);
            else {
              const result = RoomLabResult.safeParse(value);
              if (result.success) resolve(result.data);
              else reject(new DomainError('ROOM_FAILED', '分房計算失敗，請重試', 503));
            }
          });
        };
        const timer = setTimeout(
          () => finish(new DomainError('ROOM_TIMEOUT', '分房計算逾時，請減少人數後重試', 503)),
          5000,
        );
        worker.once('message', (message: { ok?: boolean; result?: unknown }) =>
          message.ok
            ? finish(undefined, message.result)
            : finish(new DomainError('ROOM_FAILED', '分房計算失敗，請核對人數與容量後重試', 400)),
        );
        worker.once('error', () => finish(new DomainError('ROOM_FAILED', '分房計算失敗，請重試', 503)));
        worker.once('exit', () => {
          if (!finished) finish(new DomainError('ROOM_FAILED', '分房計算已停止，請重試', 503));
        });
      });
    },
    async close() {
      closed = true;
      await Promise.all([...workers].map((worker) => worker.terminate()));
    },
  };
}
