import legacyCasefold from './legacy-casefold.json';
// Python's str.split()/re \s includes C0 separators and U+0085, but not BOM.
export const musicWhitespace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
export const musicText = (value: string) => value.replace(musicWhitespace, ' ').replace(/^ +| +$/g, '');
export const pythonCasefold = (value: string) => Array.from(value, char => (legacyCasefold as Record<string, string>)[char] ?? char.toLowerCase()).join('');
/** Same NFKC, zero-width removal, whitespace removal and casefold as legacy name_key. */
export function musicNameKey(value: string) {
  const normalized = value.normalize('NFKC').replace(/[\u200b-\u200f\ufeff\u00ad]/g, '').replace(musicWhitespace, '');
  return Array.from(normalized, char => (legacyCasefold as Record<string, string>)[char] ?? char.toLowerCase()).join('');
}
/** Entry keys keep one separating space; member names remove all whitespace. */
export function musicEntryKey(value: string) {
  return pythonCasefold(musicText(value.normalize('NFKC').replace(/[\u200b-\u200f\ufeff\u00ad]/g, '')));
}
