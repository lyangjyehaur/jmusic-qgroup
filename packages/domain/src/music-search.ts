import dictionary from './music-search-data.json';
import { musicEntryKey } from './music-text';
import { musicChineseKey, musicNameValues, type MusicNames } from './music-labels';
import { musicKanaKey, musicKanaRomaji, musicLatinKey } from './music-kana';

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
export type MusicSearchEntry = { id:string; name:string; aliases?:readonly string[]; names?:MusicNames };
export function createMusicSearchRank(entries:readonly MusicSearchEntry[]) {
  const index=new Map(entries.map(entry=>[entry.id,[entry.name,...(entry.aliases??[]),...(entry.names?musicNameValues(entry.names):[])].map((text,position)=>({
    ...musicSearchKeys(text), position, chinese:musicChineseKey(text), kana:musicEntryKey(musicKanaKey(text)),
    latin: /[\u3040-\u30ff]/.test(text)?musicLatinKey(musicKanaRomaji(text)):/^[\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}]+$/u.test(text)?musicLatinKey(text):'',
  }))]));
  return (id:string,query:string)=>{
    const key=musicEntryKey(query);if(!key)return 0;
    const chinese=musicChineseKey(query),kana=musicEntryKey(musicKanaKey(query)),latin=/^[\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}]+$/u.test(query)?musicLatinKey(query):'';
    let best=Infinity;
    for(const value of index.get(id)??[]) {
      if(value.name===key||value.chinese===chinese||value.kana===kana)best=Math.min(best,value.position===0?0:1);
      else if(value.name.startsWith(key)||value.chinese.startsWith(chinese)||value.kana.startsWith(kana))best=Math.min(best,2);
      else if(value.name.includes(key)||value.chinese.includes(chinese)||value.kana.includes(kana))best=Math.min(best,3);
      else if(value.initials.startsWith(key)||value.pinyin.includes(key)||(latin&&value.latin.includes(latin)))best=Math.min(best,4);
    }
    return best;
  };
}
export function createMusicSearch(entries:readonly MusicSearchEntry[]) {
  const rank=createMusicSearchRank(entries);return (id:string,query:string)=>Number.isFinite(rank(id,query));
}
export const matchesMusicSearch=(entry:MusicSearchEntry,query:string)=>createMusicSearch([entry])(entry.id,query);
