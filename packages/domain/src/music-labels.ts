import { Converter } from 'opencc-js/t2cn';
import { musicEntryKey, musicText } from './music-text';

export type MusicNames = { zhHant: string; zhHans: string; english: string; reading: string; romaji: string; aliases: readonly string[] };
export const emptyMusicNames = (): MusicNames => ({ zhHant:'', zhHans:'', english:'', reading:'', romaji:'', aliases:[] });
const toHans = Converter({ from:'tw', to:'cn' });
export const musicChineseKey = (text:string) => musicEntryKey(toHans(text));
export function musicTranslation(entry:{name:string;names?:MusicNames;translations?:{zhHant:string;zhHans:string}}, script:'zh-Hans'|'zh-Hant') {
  if (!entry.names) return '';
  const names=entry.names, text=script==='zh-Hans'?names.zhHans || entry.translations?.zhHans || '':names.zhHant || entry.translations?.zhHant || '';
  return musicEntryKey(text)===musicEntryKey(entry.name)?'':text;
}
export function musicNameValues(names:MusicNames) {
  return [names.zhHant,names.zhHans,names.english,names.reading,names.romaji,...names.aliases].filter(value=>!!musicText(value));
}
export function musicNameAliases(name:string,names:MusicNames) {
  const seen=new Set([musicEntryKey(name)]);
  return musicNameValues(names).flatMap(value=>{const text=musicText(value),key=musicEntryKey(text);if(!key||seen.has(key))return [];seen.add(key);return [text];});
}
