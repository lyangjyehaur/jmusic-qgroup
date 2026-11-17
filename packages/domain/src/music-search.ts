import dictionary from './music-search-data.json';
import { musicEntryKey } from './music-text';

const full = /* @__PURE__ */ dictionary.full.split(' ');
const kanaRows: readonly (readonly [number, number, string])[] = [
  [0x3041, 0x304a, 'A'], [0x304b, 0x3054, 'K'], [0x3055, 0x305e, 'S'],
  [0x305f, 0x3069, 'T'], [0x306a, 0x306e, 'N'], [0x306f, 0x307d, 'H'],
  [0x307e, 0x3082, 'M'], [0x3083, 0x308a, 'Y'], [0x3089, 0x308d, 'R'],
  [0x308e, 0x3096, 'W'],
];
function initial(char: string) {
  if (/^[a-z]$/i.test(char)) return char;
  let code = char.codePointAt(0)!;
  if (code >= 0x30a1 && code <= 0x30fa) code -= 0x60;
  // Keep the source's B initial for ヴ / ゔ, including its row grouping for voiced kana.
  if (code === 0x3094) return 'B';
  for (const [start, end, letter] of kanaRows) if (code >= start && code <= end) return letter;
  return dictionary.initials[char.codePointAt(0)! - dictionary.base]?.trim() ?? '';
}
export function musicSearchKeys(text: string) {
  const name = musicEntryKey(text);
  const initials = Array.from(name, initial).join('').toLowerCase();
  const pinyin = Array.from(name, char => {
    const code = char.codePointAt(0)!;
    return code >= dictionary.base && code < 0xa000 ? full[code - dictionary.base] ?? '' : char;
  }).join('');
  return { name, initials, pinyin };
}
export function createMusicSearch(entries: readonly { id: string; name: string; aliases?: readonly string[] }[]) {
  const index = new Map(entries.map(entry => [entry.id, [entry.name, ...(entry.aliases ?? [])].map(musicSearchKeys)]));
  return (id: string, query: string) => {
    const key = musicEntryKey(query);
    return !key || !!index.get(id)?.some(value =>
      value.name.includes(key) || value.initials.startsWith(key) || value.pinyin.includes(key),
    );
  };
}
export const matchesMusicSearch = (entry: { id: string; name: string; aliases?: readonly string[] }, query: string) =>
  createMusicSearch([entry])(entry.id, query);
