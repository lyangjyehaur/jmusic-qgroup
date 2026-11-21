import { Worker } from 'node:worker_threads';
import { MusicCircles } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import type { CircleTask } from './music-circle-task';

/** Each API process admits at most two jobs. Workers receive only the circle
 * projection, with no DB handle, credentials or transport client. */
export function createCircleJobs() {
  const running = new Map<Worker, (error: Error) => void>();
  let closed = false;
  const busy = () => withApiError(new DomainError('CIRCLE_BUSY', '同好圈子分析忙碌中，請稍後重試', 503));
  const failed = () => withApiError(new DomainError('CIRCLE_FAILED', '同好圈子分析失敗，請重試', 503));
  const cancelled = () => withApiError(new DomainError('CIRCLE_CANCELLED', '同好圈子分析已停止，請重新讀取', 503));
  const available = () => { if (closed || running.size >= 2) throw busy(); };
  return {
    available,
    run(task: CircleTask, signal?: AbortSignal) {
      available();
      if (signal?.aborted) return Promise.reject(cancelled());
      return new Promise<ReturnType<typeof MusicCircles.parse>>((resolve, reject) => {
        const worker = new Worker(new URL('./music-circle-worker.mjs', import.meta.url), {
          workerData: task, env: {}, execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
        });
        let finished = false;
        const finish = (error?: Error, value?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          // Keep the capacity reservation until the thread has actually stopped.
          void worker.terminate().then(() => {
            running.delete(worker);
            if (error) reject(error);
            else {
              const result = MusicCircles.safeParse(value);
              if (result.success) resolve(result.data);
              else reject(failed());
            }
          }, () => { running.delete(worker); reject(failed()); });
        };
        const abort = () => finish(cancelled());
        const timer = setTimeout(() => finish(withApiError(new DomainError('CIRCLE_TIMEOUT', '同好圈子分析逾時，請稍後重試', 503))), 5000);
        running.set(worker, error => finish(error));
        signal?.addEventListener('abort', abort, { once: true });
        worker.once('message', (message: { ok?: boolean; result?: unknown }) => message.ok ? finish(undefined, message.result) : finish(failed()));
        worker.once('error', () => finish(failed()));
        worker.once('exit', () => { if (!finished) finish(failed()); });
      });
    },
    async close() {
      closed = true;
      const workers = [...running];
      for (const [, stop] of workers) stop(cancelled());
      await Promise.all(workers.map(([worker]) => worker.terminate()));
    },
  };
}
