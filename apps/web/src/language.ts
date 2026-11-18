/** Only the build plugin supplies pairs of static system literals. No converter runs here. */
export function displayText(hans: string, hant: string) {
  return typeof document !== 'undefined' && document.documentElement.lang === 'zh-Hans' ? hans : hant;
}
/** Explicit display boundary; the build rejects nonliteral arguments. */
export function uiText(value: string) { return value; }
const errors = new WeakMap<Error, readonly [string, string]>();
/** Keep the original instance, message, class and machine checks unchanged. */
export function withErrorText<T extends Error>(error: T, hans: string, hant: string): T {
  errors.set(error, [hans, hant]);return error;
}
export function errorText(error: { message: string }): string {
  const pair = error instanceof Error ? errors.get(error) : undefined;
  return pair ? displayText(pair[0], pair[1]) : error.message;
}
