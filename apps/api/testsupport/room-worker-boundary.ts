import { Worker } from 'node:worker_threads';
import { vi } from 'vitest';

/** Observe an actual completed CPU job, before the API receives its result.
 * No synthetic result, timer race, or runtime test hook is involved. */
export function atRoomWorkerResult(sourceVersion: string, beforeResult: () => void) {
  const original = Worker.prototype.emit;
  let calls = 0;
  const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { ok?: boolean; result?: { sourceVersion?: string } } | undefined;
    if (event === 'message' && message?.ok === true && message.result?.sourceVersion === sourceVersion) {
      calls++;
      beforeResult();
    }
    return original.call(this, event, ...args);
  });
  return { get calls() { return calls; }, restore: () => spy.mockRestore() };
}
