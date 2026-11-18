/** Only the build plugin supplies pairs of static system literals. No converter runs here. */
export function displayText(hans: string, hant: string) {
  return typeof document !== 'undefined' && document.documentElement.lang === 'zh-Hans' ? hans : hant;
}
/** Explicit display boundary; the build rejects nonliteral arguments. */
export function uiText(value: string) { return value; }
