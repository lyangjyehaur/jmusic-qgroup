/** Cancellation bounds waiting even when an injected operation ignores its signal. */
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
}
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
export async function within<T>(
  milliseconds: number,
  parent: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  checkAbort(parent);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('Operation timed out', 'TimeoutError')), milliseconds);
  const signal = AbortSignal.any([parent, timeout.signal]);
  try {
    return await abortable(
      Promise.resolve().then(() => {
        checkAbort(signal);
        return work(signal);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
export async function delay(milliseconds: number, signal: AbortSignal) {
  checkAbort(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
